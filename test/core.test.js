import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { gunzipSync, gzipSync } from "node:zlib";
import worker from "../worker/index.js";
import { currentSession, login, LOGIN_PORT, securePasscode } from "../src/auth.js";
import { bundleDigest, bundleReview, excludeFromBundle, install, omitBundleFiles, reviewBundle, rollback, scan, sha256, share, validate } from "../src/core.js";
import { commandText } from "../src/sources.js";
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
    assert.equal(received.access, "public");
    assert.equal(received.bundle.items[0].name, "demo");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Worker stores private bundles in D1 and requires their passcode", async () => {
  const sender = await mkdtemp(join(tmpdir(), "rigdrop-private-worker-"));
  await mkdir(join(sender, ".agents/skills/demo"), { recursive: true });
  await writeFile(join(sender, ".agents/skills/demo/SKILL.md"), "# Demo\n");
  const bundle = await scan({ home: sender });
  let row;
  const env = {
    PASSCODE_SECRET: "a-long-random-test-secret",
    SUPABASE_URL: "https://db.example",
    SUPABASE_PUBLISHABLE_KEY: "pub",
    ASSETS: { fetch: () => new Response("Not found", { status: 404 }) },
    BUNDLES: { prepare: query => ({ bind: (...args) => ({
      first: async () => query.startsWith("SELECT count") ? { count: 0 } : query.startsWith("SELECT slug") ? row : { ok: 1 },
      run: async () => {
        if (query.startsWith("INSERT")) row = { slug: args[0], title: args[1], manifest: args[2], checksum: args[3], review: args[4], owner_id: args[5], access: args[6], passcode_digest: args[7] };
        return { meta: { changes: 1 } };
      }
    }) }) }
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ id: "user-1" });
  try {
    const create = await worker.fetch(new Request("https://example.com/api/bundles", { method: "POST", headers: { Authorization: "Bearer token", "Content-Type": "application/json" }, body: JSON.stringify({ bundle, access: "private", passcode: "correct horse battery" }) }), env);
    assert.equal(create.status, 201);
    const { manifest } = await create.json();
    assert.equal((await worker.fetch(new Request(manifest), env)).status, 401);
    const download = await worker.fetch(new Request(manifest, { headers: { "X-RigDrop-Passcode": "correct horse battery" } }), env);
    assert.equal(download.status, 200);
    assert.equal((await download.json()).metadata.id, bundle.metadata.id);
    assert.doesNotMatch(row.passcode_digest, /correct horse battery/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("server review blocks unsafe content and lists items to check", async () => {
  const sender = await mkdtemp(join(tmpdir(), "rigdrop-server-review-"));
  await mkdir(join(sender, ".agents/skills/demo"), { recursive: true });
  await writeFile(join(sender, ".agents/skills/demo/SKILL.md"), "# Demo\n");
  await writeFile(join(sender, ".agents/skills/demo/run.sh"), "#!/bin/sh\necho hi\n");
  await writeFile(join(sender, ".claude.json"), JSON.stringify({ mcpServers: { demo: { command: "npx demo" } } }));
  const bundle = await scan({ home: sender });
  const passed = reviewBundle(bundle);
  assert.equal(passed.status, "passed");
  assert.ok(passed.warnings.some(warning => warning.includes("`npx demo`")));
  assert.ok(passed.warnings.some(warning => warning.endsWith("run.sh")));

  const reseal = next => {
    const { integrity, ...body } = next;
    return { ...next, integrity: { sha256: sha256(JSON.stringify(body)) } };
  };
  const tampered = structuredClone(bundle);
  const file = tampered.items[0].source.files[0];
  const secret = Buffer.from("-----BEGIN PRIVATE KEY-----\nsecret");
  Object.assign(file, { content: gzipSync(secret).toString("base64"), sha256: sha256(secret) });
  tampered.items.find(item => item.kind === "mcp").config = { "x]\n[evil": { command: "sh" } };
  tampered.items.push({ ...tampered.items[0], id: "moved", destination: ".ssh/demo" });
  const rejected = reviewBundle(reseal(tampered));
  assert.equal(rejected.status, "rejected");
  assert.ok(rejected.blockers.some(blocker => blocker.includes("possible secret")));
  assert.ok(rejected.blockers.some(blocker => blocker.includes("invalid MCP server name")));
  assert.ok(rejected.blockers.some(blocker => blocker.includes("unexpected destination .ssh/demo")));
});

test("login uses a PKCE loopback callback and refreshes the stored session", { skip: process.versions.node.startsWith("24.") && "Node 24 asserts while closing this loopback-server test" }, async () => {
  const home = await mkdtemp(join(tmpdir(), "rigdrop-login-"));
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ url: request.url, body: body && JSON.parse(body) });
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/api/auth-config") return response.end(JSON.stringify({ supabaseUrl: origin, publishableKey: "sb_publishable_test" }));
    const refresh = request.url.includes("refresh_token");
    response.end(JSON.stringify({ access_token: refresh ? "access-2" : "access-1", refresh_token: "refresh", expires_in: refresh ? 3600 : 0, user: { email: "a@example.com" } }));
  });
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    let authorizeUrl;
    const session = await login({
      registry: origin,
      home,
      log: () => {},
      open: url => {
        authorizeUrl = new URL(url);
        fetch(`${authorizeUrl.searchParams.get("redirect_to")}?code=auth-code`);
      }
    });
    assert.equal(authorizeUrl.searchParams.get("provider"), "google");
    assert.equal(authorizeUrl.searchParams.get("redirect_to"), `http://127.0.0.1:${LOGIN_PORT}/callback`);
    const exchange = requests.find(request => request.url.includes("grant_type=pkce"));
    assert.equal(exchange.body.auth_code, "auth-code");
    assert.equal(createHash("sha256").update(exchange.body.code_verifier).digest("base64url"), authorizeUrl.searchParams.get("code_challenge"));
    assert.equal(session.email, "a@example.com");
    assert.equal((await stat(join(home, ".rigdrop/session.json"))).mode & 0o777, 0o600);

    const refreshed = await currentSession({ home });
    assert.equal(refreshed.accessToken, "access-2");
    await assert.rejects(currentSession({ home, registry: "https://other.example" }), /login --registry/);
  } finally {
    server.close();
  }
});

test("private publishing collects its passcode through a local password form", async () => {
  let promptUrl;
  const result = securePasscode({ open: url => { promptUrl = url; }, log: () => {} });
  while (!promptUrl) await new Promise(resolve => setTimeout(resolve, 1));
  const page = await fetch(promptUrl);
  assert.match(await page.text(), /type="password"/);
  const submitted = await fetch(promptUrl, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "passcode=private-passcode" });
  assert.equal(submitted.status, 200);
  assert.equal(await result, "private-passcode");
});


async function sourceHome() {
  const home = await mkdtemp(join(tmpdir(), "rigdrop-sources-"));
  await mkdir(join(home, ".claude/plugins"), { recursive: true });
  await writeFile(join(home, ".claude/plugins/installed_plugins.json"), JSON.stringify({ version: 2, plugins: {
    "caveman@caveman": [{ scope: "user" }],
    "frontend-design@official": [{ scope: "user" }],
    "vercel@official": [{ scope: "user" }],
    "local-only@dev": [{ scope: "user" }],
    "project-only@caveman": [{ scope: "project" }]
  } }));
  await writeFile(join(home, ".claude/plugins/known_marketplaces.json"), JSON.stringify({
    caveman: { source: { source: "github", repo: "JuliusBrussee/caveman" } },
    official: { source: { source: "git", url: "https://github.com/anthropics/claude-plugins-official.git" } },
    dev: { source: { source: "directory", path: "/tmp/dev" } }
  }));
  await mkdir(join(home, ".codex"), { recursive: true });
  await writeFile(join(home, ".codex/config.toml"), [
    "[marketplaces.ponytail]", 'source_type = "git"', 'source = "https://github.com/DietrichGebert/ponytail.git"',
    "[marketplaces.bundled]", 'source_type = "local"', 'source = "/tmp/bundled"',
    '[plugins."ponytail@ponytail"]', "enabled = true",
    '[plugins."vercel@openai-curated"]', "enabled = true",
    '[plugins."chrome@bundled"]', "enabled = true",
    '[plugins."off@ponytail"]', "enabled = false"
  ].join("\n"));
  for (const name of ["deploy-to-vercel", "web-design-guidelines"]) {
    await mkdir(join(home, ".agents/skills", name), { recursive: true });
    await writeFile(join(home, ".agents/skills", name, "SKILL.md"), `# ${name}\n`);
  }
  await writeFile(join(home, ".agents/.skill-lock.json"), JSON.stringify({ version: 3, skills: {
    "deploy-to-vercel": { source: "vercel-labs/agent-skills", sourceType: "github" },
    "web-design-guidelines": { source: "vercel-labs/agent-skills", sourceType: "github" },
    removed: { source: "vercel-labs/agent-skills", sourceType: "github" }
  } }));

  const tool = join(home, ".claude/skills/tool");
  await mkdir(join(tool, "review"), { recursive: true });
  await writeFile(join(tool, "review/SKILL.md"), "# Review\n");
  await writeFile(join(tool, "setup"), "#!/bin/sh\n");
  for (const args of [["init", "--quiet"], ["config", "user.name", "Test"], ["config", "user.email", "t@example.com"], ["add", "."], ["commit", "--quiet", "-m", "init"], ["remote", "add", "origin", "https://github.com/example/tool.git"]]) await exec("git", ["-C", tool, ...args]);
  await mkdir(join(home, ".claude/skills/review"), { recursive: true });
  await symlink(join(tool, "review/SKILL.md"), join(home, ".claude/skills/review/SKILL.md"));
  await mkdir(join(home, ".codex/skills"), { recursive: true });
  await symlink(join(tool, "review"), join(home, ".codex/skills/tool-review"));
  await mkdir(join(home, ".claude/skills/own"), { recursive: true });
  await writeFile(join(home, ".claude/skills/own/SKILL.md"), "# Own\n");
  return { home, tool };
}

test("scan groups skills and plugins by install source", async () => {
  const { home } = await sourceHome();
  const bundle = await scan({ home });
  const sources = Object.fromEntries(bundle.items.filter(item => item.kind === "source").map(item => [item.id, item.source]));
  assert.deepEqual(sources["claude-plugins-caveman"].plugins, ["caveman"]);
  assert.deepEqual(sources["claude-plugins-official"].plugins, ["frontend-design", "vercel"]);
  assert.equal(sources["codex-plugins-ponytail"].repository, "https://github.com/DietrichGebert/ponytail.git");
  assert.equal(sources["codex-plugins-openai-curated"].repository, null);
  assert.deepEqual(sources["skills-cli-vercel-labs-agent-skills"].skills, ["deploy-to-vercel", "web-design-guidelines"]);
  const clone = sources["git-clone-tool"];
  assert.equal(clone.path, ".claude/skills/tool");
  assert.equal(clone.setup, true);
  assert.deepEqual(clone.links.map(link => [link.path, link.target]).sort(), [
    [".claude/skills/review/SKILL.md", "review/SKILL.md"],
    [".codex/skills/tool-review", "review"]
  ]);
  assert.ok(bundle.notes.some(note => note.includes("dev is local") && note.includes("local-only")));
  assert.ok(bundle.notes.some(note => note.includes("bundled is local") && note.includes("chrome")));
  const embedded = bundle.items.filter(item => item.kind === "skill").map(item => item.name);
  assert.deepEqual(embedded, ["own"]);
  assert.equal(reviewBundle(bundle).status, "passed");
  assert.deepEqual(excludeFromBundle(bundle, ["git-clone-tool", ".claude/skills/own/SKILL.md"]).items.map(item => item.id).filter(id => id.includes("tool") || id.includes("own")), []);
  assert.deepEqual(excludeFromBundle(bundle, ["own"]).items.filter(item => item.name === "own"), []);
  assert.throws(() => excludeFromBundle(bundle, ["missing"]), /Nothing matches/);
});

test("validate rejects unsafe install sources", async () => {
  const { home } = await sourceHome();
  const bundle = await scan({ home });
  const reseal = change => {
    const next = structuredClone(bundle);
    change(next.items.find(item => item.kind === "source" && item.source.kind === change.kind));
    const { integrity, ...body } = next;
    return { ...next, integrity: { sha256: sha256(JSON.stringify(body)) } };
  };
  const cases = [
    Object.assign(item => { item.source.repository = "--upload-pack=touch /tmp/x"; }, { kind: "claude-marketplace" }),
    Object.assign(item => { item.source.skills.push("-g"); }, { kind: "skills-cli" }),
    Object.assign(item => { item.source.links.push({ path: ".bashrc", target: "review" }); }, { kind: "git-clone" }),
    Object.assign(item => { item.source.links[0].target = "../../.ssh/id_rsa"; }, { kind: "git-clone" }),
    Object.assign(item => { item.source.path = ".ssh/tool"; item.destination = ".ssh/tool"; }, { kind: "git-clone" })
  ];
  for (const change of cases) assert.throws(() => validate(reseal(change)), /Invalid source|Unsafe path/);
});

test("install runs source commands and recreates linked clones", async () => {
  const { home: sender, tool } = await sourceHome();
  const bundle = await scan({ home: sender });
  const receiver = await mkdtemp(join(tmpdir(), "rigdrop-source-receiver-"));
  const commands = [];
  const run = async command => {
    commands.push(commandText(command));
    if (command.command === "codex") throw Object.assign(new Error("missing"), { code: "ENOENT" });
  };
  const gitEnv = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `url.${tool}.insteadOf`, GIT_CONFIG_VALUE_0: "https://github.com/example/tool" };
  Object.assign(process.env, gitEnv);
  try {
    const journal = await install(bundle, { home: receiver, run, exclude: ["claude-plugins-caveman"] });
    assert.ok(commands.includes("claude plugin install vercel@official --scope user"));
    assert.ok(commands.includes("npx --yes skills add vercel-labs/agent-skills -g -y --skill deploy-to-vercel web-design-guidelines"));
    assert.ok(!commands.some(command => command.includes("caveman@caveman")));
    assert.ok(journal.changes.some(change => change.status === "skipped: codex not found"));
    assert.equal(await readFile(join(receiver, ".claude/skills/review/SKILL.md"), "utf8"), "# Review\n");
    assert.equal(await readFile(join(receiver, ".codex/skills/tool-review/SKILL.md"), "utf8"), "# Review\n");
    await rollback(journal.id, receiver);
    await assert.rejects(stat(join(receiver, ".claude/skills/review")));
    await assert.rejects(stat(join(receiver, ".claude/skills/tool")));
  } finally {
    for (const key of Object.keys(gitEnv)) delete process.env[key];
  }
});

test("bundle digest survives storage that reorders object keys", async () => {
  const sender = await mkdtemp(join(tmpdir(), "rigdrop-key-order-"));
  await mkdir(join(sender, ".agents/skills/demo"), { recursive: true });
  await writeFile(join(sender, ".agents/skills/demo/SKILL.md"), "# Demo\n");
  const bundle = await scan({ home: sender });
  const reorder = value => Array.isArray(value) ? value.map(reorder)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reorder(item)])) : value;
  const stored = reorder(bundle);
  assert.notEqual(JSON.stringify(stored), JSON.stringify(bundle));
  validate(stored);
  const { integrity, ...body } = bundle;
  assert.equal(integrity.sha256, bundleDigest(body));
});
