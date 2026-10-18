import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { install, rollback, scan, share, validate } from "../src/core.js";
import { bundleUrls, renderBundlePage, renderInstructions } from "../src/hosted.js";

test("scan replaces MCP values and installs embedded skills", async () => {
  const sender = await mkdtemp(join(tmpdir(), "agent-setup-sender-"));
  const receiver = await mkdtemp(join(tmpdir(), "agent-setup-receiver-"));
  await mkdir(join(sender, ".agents/skills/demo"), { recursive: true });
  await writeFile(join(sender, ".agents/skills/demo/SKILL.md"), "# Demo\n");
  await writeFile(join(sender, ".claude.json"), JSON.stringify({ mcpServers: { demo: { command: "demo", env: { API_TOKEN: "do-not-copy" } } } }));

  const bundle = await scan({ home: sender });
  assert.deepEqual(bundle.requiredSecrets, ["API_TOKEN"]);
  assert.equal(JSON.stringify(bundle).includes("do-not-copy"), false);
  validate(bundle);

  const journal = await install(bundle, { home: receiver });
  assert.equal(await readFile(join(receiver, ".agents/skills/demo/SKILL.md"), "utf8"), "# Demo\n");
  assert.match(await readFile(join(receiver, ".claude.json"), "utf8"), /\$\{API_TOKEN\}/);
  await rollback(journal.id, receiver);
  await assert.rejects(readFile(join(receiver, ".agents/skills/demo/SKILL.md")));
});

test("scan rejects an embedded private key", async () => {
  const sender = await mkdtemp(join(tmpdir(), "agent-setup-secret-"));
  await mkdir(join(sender, ".codex/skills/demo"), { recursive: true });
  await writeFile(join(sender, ".codex/skills/demo/SKILL.md"), "-----BEGIN PRIVATE KEY-----\nsecret");
  await assert.rejects(scan({ home: sender }), /Possible secret/);
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
