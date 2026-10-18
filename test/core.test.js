import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import { bundleReview, install, omitBundleFiles, rollback, scan, share, validate } from "../src/core.js";
import { bundleUrls, renderBundlePage, renderInstructions } from "../src/hosted.js";

const exec = promisify(execFile);

test("scan replaces MCP values and installs embedded skills", async () => {
  const sender = await mkdtemp(join(tmpdir(), "agent-setup-sender-"));
  const receiver = await mkdtemp(join(tmpdir(), "agent-setup-receiver-"));
  await mkdir(join(sender, ".agents/skills/demo"), { recursive: true });
  await writeFile(join(sender, ".agents/skills/demo/SKILL.md"), "# Demo\n");
  await writeFile(join(sender, ".claude.json"), JSON.stringify({ mcpServers: { demo: { command: "demo", env: { API_TOKEN: "do-not-copy" } } } }));

  const bundle = await scan({ home: sender });
  assert.deepEqual(bundle.requiredSecrets, []);
  assert.equal(JSON.stringify(bundle).includes("do-not-copy"), false);
  assert.deepEqual(bundle.items.find(item => item.kind === "mcp").config, { demo: { command: "demo" } });
  assert.equal(bundle.items[0].source.files[0].encoding, "gzip-base64");
  assert.equal(gunzipSync(Buffer.from(bundle.items[0].source.files[0].content, "base64")).toString("utf8"), "# Demo\n");
  validate(bundle);

  const journal = await install(bundle, { home: receiver });
  assert.equal(await readFile(join(receiver, ".agents/skills/demo/SKILL.md"), "utf8"), "# Demo\n");
  assert.doesNotMatch(await readFile(join(receiver, ".claude.json"), "utf8"), /API_TOKEN|do-not-copy/);
  await rollback(journal.id, receiver);
  await assert.rejects(readFile(join(receiver, ".agents/skills/demo/SKILL.md")));
});

test("scan rejects an embedded private key", async () => {
  const sender = await mkdtemp(join(tmpdir(), "agent-setup-secret-"));
  await mkdir(join(sender, ".codex/skills/demo"), { recursive: true });
  await writeFile(join(sender, ".codex/skills/demo/SKILL.md"), "-----BEGIN PRIVATE KEY-----\nsecret");
  await assert.rejects(scan({ home: sender }), /Possible secret/);
});

test("scan excludes sensitive filenames", async () => {
  const sender = await mkdtemp(join(tmpdir(), "rigdrop-sensitive-filename-"));
  await mkdir(join(sender, ".codex/skills/demo"), { recursive: true });
  await writeFile(join(sender, ".codex/skills/demo/SKILL.md"), "# Demo\n");
  await writeFile(join(sender, ".codex/skills/demo/service.pem"), "not a real key\n");
  const bundle = await scan({ home: sender });
  assert.deepEqual(bundle.items[0].source.skipped, [{ path: "service.pem", reason: "sensitive filename" }]);
});

test("review can remove selected files before publishing", async () => {
  const sender = await mkdtemp(join(tmpdir(), "rigdrop-review-"));
  await mkdir(join(sender, ".agents/skills/demo"), { recursive: true });
  await writeFile(join(sender, ".agents/skills/demo/SKILL.md"), "# Demo\n");
  await writeFile(join(sender, ".agents/skills/demo/reference.md"), "# Reference\n");
  const bundle = await scan({ home: sender });
  const review = bundleReview(bundle);
  const edited = omitBundleFiles(bundle, [review.files.find(file => file.path.endsWith("reference.md")).path]);
  assert.equal(bundleReview(edited).files.length, 1);
  assert.equal(bundleReview(edited).skipped.at(-1).reason, "removed during review");
});

test("review uses the destination itself for rule files and omits empty rules", async () => {
  const sender = await mkdtemp(join(tmpdir(), "rigdrop-rules-review-"));
  await mkdir(join(sender, ".claude"), { recursive: true });
  await mkdir(join(sender, ".codex"), { recursive: true });
  await writeFile(join(sender, ".claude/CLAUDE.md"), "# Rules\n");
  await writeFile(join(sender, ".codex/AGENTS.md"), "");
  const bundle = await scan({ home: sender });
  assert.deepEqual(bundleReview(bundle).files.map(file => file.path), [".claude/CLAUDE.md"]);
});

test("scan allows the documented AWS example key", async () => {
  const sender = await mkdtemp(join(tmpdir(), "rigdrop-example-key-"));
  await mkdir(join(sender, ".codex/skills/demo"), { recursive: true });
  await writeFile(join(sender, ".codex/skills/demo/SKILL.md"), "Example: AKIAIOSFODNN7EXAMPLE\n");
  const bundle = await scan({ home: sender });
  assert.equal(bundle.items.length, 1);
});

test("scan skips oversized embedded files and records the omission", async () => {
  const sender = await mkdtemp(join(tmpdir(), "rigdrop-large-file-"));
  await mkdir(join(sender, ".codex/skills/demo"), { recursive: true });
  await writeFile(join(sender, ".codex/skills/demo/SKILL.md"), "# Demo\n");
  await writeFile(join(sender, ".codex/skills/demo/asset.bin"), Buffer.alloc(257 * 1024));
  const bundle = await scan({ home: sender });
  assert.deepEqual(bundle.items[0].source.skipped, [{ path: "asset.bin", reason: "exceeds 262144 bytes" }]);
  assert.equal(bundle.items[0].source.files.length, 1);
});

test("scan captures portable scripts but omits work assets and build output", async () => {
  const sender = await mkdtemp(join(tmpdir(), "rigdrop-portable-files-"));
  const skill = join(sender, ".agents/skills/demo");
  await mkdir(join(skill, "node_modules/package"), { recursive: true });
  await mkdir(join(skill, "dist"), { recursive: true });
  await writeFile(join(skill, "SKILL.md"), "# Demo\n");
  await writeFile(join(skill, "run"), "#!/bin/sh\necho demo\n");
  await writeFile(join(skill, "presentation.pptx"), Buffer.from([0, 1, 2]));
  await writeFile(join(skill, "node_modules/package/index.js"), "throw new Error()\n");
  await writeFile(join(skill, "dist/bundle.js"), "throw new Error()\n");
  const bundle = await scan({ home: sender });
  const source = bundle.items[0].source;
  assert.deepEqual(source.files.map(file => file.path).sort(), ["SKILL.md", "run"]);
  assert.deepEqual(source.skipped, [{ path: "presentation.pptx", reason: "not a portable text or script file" }]);
});

test("scan ignores Claude plugin cache and synced directories", async () => {
  const sender = await mkdtemp(join(tmpdir(), "rigdrop-plugin-cache-"));
  await mkdir(join(sender, ".claude/plugins/cache/plugin"), { recursive: true });
  await mkdir(join(sender, ".claude/plugins/synced/plugin"), { recursive: true });
  await writeFile(join(sender, ".claude/plugins/cache/plugin/SKILL.md"), "-----BEGIN PRIVATE KEY-----\n");
  await writeFile(join(sender, ".claude/plugins/synced/plugin/SKILL.md"), "# Portable plugin\n");
  const bundle = await scan({ home: sender });
  assert.equal(bundle.items.length, 0);
});

test("scan ignores synced work folders and Codex plugin caches", async () => {
  const sender = await mkdtemp(join(tmpdir(), "rigdrop-excluded-folders-"));
  await mkdir(join(sender, ".claude/skills/synced/work"), { recursive: true });
  await mkdir(join(sender, ".codex/plugins/cache/plugin"), { recursive: true });
  await mkdir(join(sender, ".agents/skills/demo"), { recursive: true });
  await writeFile(join(sender, ".claude/skills/synced/work/SKILL.md"), "# Work\n");
  await writeFile(join(sender, ".codex/plugins/cache/plugin/SKILL.md"), "# Cache\n");
  await writeFile(join(sender, ".agents/skills/demo/SKILL.md"), "# Demo\n");
  const bundle = await scan({ home: sender });
  assert.deepEqual(bundle.items.map(item => item.name), ["demo"]);
});

test("scan keeps a clean GitHub skill as a pinned reference despite .DS_Store", async () => {
  const sender = await mkdtemp(join(tmpdir(), "rigdrop-git-skill-"));
  const skill = join(sender, ".claude/skills/demo");
  await mkdir(skill, { recursive: true });
  await exec("git", ["-C", skill, "init", "--quiet"]);
  await exec("git", ["-C", skill, "config", "user.name", "Test User"]);
  await exec("git", ["-C", skill, "config", "user.email", "test@example.com"]);
  await writeFile(join(skill, "SKILL.md"), "# Demo\n");
  await exec("git", ["-C", skill, "add", "SKILL.md"]);
  await exec("git", ["-C", skill, "commit", "--quiet", "-m", "Initial"]);
  await exec("git", ["-C", skill, "remote", "add", "origin", "https://github.com/example/demo.git"]);
  await writeFile(join(skill, ".DS_Store"), "noise");

  const bundle = await scan({ home: sender });
  assert.equal(bundle.items[0].source.kind, "git");
  assert.equal(bundle.items[0].source.repository, "https://github.com/example/demo");
});

test("scan follows symlinks that stay inside an agent directory", async () => {
  const sender = await mkdtemp(join(tmpdir(), "rigdrop-internal-link-"));
  await mkdir(join(sender, ".claude/skills/gstack"), { recursive: true });
  await mkdir(join(sender, ".claude/skills/_gstack-command"), { recursive: true });
  await writeFile(join(sender, ".claude/skills/gstack/SKILL.md"), "# Gstack\n");
  await symlink("../gstack/SKILL.md", join(sender, ".claude/skills/_gstack-command/SKILL.md"));

  const bundle = await scan({ home: sender });
  const command = bundle.items.find(item => item.name === "_gstack-command");
  assert.equal(command.source.files[0].path, "SKILL.md");
  assert.equal(gunzipSync(Buffer.from(command.source.files[0].content, "base64")).toString("utf8"), "# Gstack\n");
});

test("scan follows links between known agent directories", async () => {
  const sender = await mkdtemp(join(tmpdir(), "rigdrop-agent-link-"));
  await mkdir(join(sender, ".claude/skills/gstack"), { recursive: true });
  await mkdir(join(sender, ".codex/skills/gstack"), { recursive: true });
  await writeFile(join(sender, ".claude/skills/gstack/ETHOS.md"), "# Ethos\n");
  await symlink(join(sender, ".claude/skills/gstack/ETHOS.md"), join(sender, ".codex/skills/gstack/ETHOS.md"));

  const bundle = await scan({ home: sender });
  const codexSkill = bundle.items.find(item => item.agent === "codex");
  assert.equal(gunzipSync(Buffer.from(codexSkill.source.files[0].content, "base64")).toString("utf8"), "# Ethos\n");
});

test("scan rejects symlinks that resolve outside an agent directory", async () => {
  const sender = await mkdtemp(join(tmpdir(), "rigdrop-external-link-"));
  const external = await mkdtemp(join(tmpdir(), "rigdrop-external-target-"));
  await mkdir(join(sender, ".claude/skills/demo"), { recursive: true });
  await writeFile(join(external, "SKILL.md"), "# External\n");
  await symlink(join(external, "SKILL.md"), join(sender, ".claude/skills/demo/SKILL.md"));
  await assert.rejects(scan({ home: sender }), /symlink outside allowed directory/);
});

test("validate rejects tampering", async () => {
  const sender = await mkdtemp(join(tmpdir(), "agent-setup-validate-"));
  await mkdir(join(sender, ".agents/skills/demo"), { recursive: true });
  await writeFile(join(sender, ".agents/skills/demo/SKILL.md"), "safe");
  const bundle = await scan({ home: sender });
  bundle.items[0].destination = "../escape";
  assert.throws(() => validate(bundle), /integrity check failed/);
});

test("force install backs up and restores user and project files", async () => {
  const sender = await mkdtemp(join(tmpdir(), "agent-setup-scopes-"));
  const senderProject = join(sender, "project");
  const receiver = await mkdtemp(join(tmpdir(), "agent-setup-scopes-receiver-"));
  const receiverProject = join(receiver, "project");
  await mkdir(join(sender, ".codex"), { recursive: true });
  await mkdir(senderProject, { recursive: true });
  await mkdir(join(receiver, ".codex"), { recursive: true });
  await mkdir(receiverProject, { recursive: true });
  await writeFile(join(sender, ".codex/AGENTS.md"), "new user rules");
  await writeFile(join(senderProject, "AGENTS.md"), "new project rules");
  await writeFile(join(receiver, ".codex/AGENTS.md"), "old user rules");
  await writeFile(join(receiverProject, "AGENTS.md"), "old project rules");

  const bundle = await scan({ home: sender, project: senderProject });
  const journal = await install(bundle, { home: receiver, project: receiverProject, force: true });
  assert.equal(await readFile(join(receiver, ".codex/AGENTS.md"), "utf8"), "new user rules");
  assert.equal(await readFile(join(receiverProject, "AGENTS.md"), "utf8"), "new project rules");
  await rollback(journal.id, receiver, receiverProject);
  assert.equal(await readFile(join(receiver, ".codex/AGENTS.md"), "utf8"), "old user rules");
  assert.equal(await readFile(join(receiverProject, "AGENTS.md"), "utf8"), "old project rules");
});

test("hosted formats expose stable agent-readable links", () => {
  const row = {
    slug: "a".repeat(32),
    title: "Demo <setup>",
    checksum: "b".repeat(64),
    manifest: { items: [{ kind: "skill", name: "Demo", agent: "shared" }], requiredSecrets: [] }
  };
  const urls = bundleUrls("https://example.com/", row.slug);
  assert.equal(urls.manifest, `https://example.com/s/${row.slug}/manifest.json`);
  assert.match(renderInstructions(row, "https://example.com"), /rigdrop install/);
  assert.match(renderBundlePage(row, "https://example.com"), /Demo &lt;setup&gt;/);
});

test("share scans and publishes a temporary bundle", async () => {
  const sender = await mkdtemp(join(tmpdir(), "rigdrop-share-"));
  await mkdir(join(sender, ".agents/skills/demo"), { recursive: true });
  await writeFile(join(sender, ".agents/skills/demo/SKILL.md"), "# Demo\n");
  const originalFetch = globalThis.fetch;
  let received;
  globalThis.fetch = async (_url, options) => {
    received = JSON.parse(options.body);
    return { ok: true, json: async () => ({ page: "https://example.com/s/share123" }) };
  };
  try {
    const result = await share({ home: sender, registry: "https://example.com", token: "test-token" });
    assert.equal(result.page, "https://example.com/s/share123");
    assert.equal(received.items[0].name, "demo");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
