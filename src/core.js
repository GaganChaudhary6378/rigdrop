import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { access, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const MAX_FILE = 512 * 1024;
const MAX_BUNDLE = 2 * 1024 * 1024;
const deniedNames = /^(\.env(?:\..*)?|auth\.json|credentials(?:\.json)?|cookies?|id_(?:rsa|ed25519)(?:\.pub)?)$/i;
const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bgh[opsu]_[A-Za-z0-9_]{30,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:sk|rk)-(?:live|test)-[A-Za-z0-9]{20,}\b/
];

export const sha256 = value => createHash("sha256").update(value).digest("hex");
const exists = async path => access(path).then(() => true, () => false);
const safeRelative = path => {
  if (!path || isAbsolute(path) || path.split(/[\\/]/).includes("..")) throw new Error(`Unsafe path: ${path}`);
  return path;
};
const runGit = async (cwd, ...args) => (await exec("git", ["-C", cwd, ...args], { encoding: "utf8" })).stdout.trim();

async function gitSource(path) {
  try {
    const root = await runGit(path, "rev-parse", "--show-toplevel");
    const repository = await runGit(path, "remote", "get-url", "origin");
    if (!/^(?:https:\/\/github\.com\/|git@github\.com:)/.test(repository)) return null;
    if (await runGit(root, "status", "--porcelain", "--", path)) return null;
    const commit = await runGit(path, "rev-parse", "HEAD");
    return {
      kind: "git",
      repository: repository.replace(/^git@github\.com:/, "https://github.com/").replace(/\.git$/, ""),
      commit,
      path: relative(root, path).split(sep).join("/") || "."
    };
  } catch {
    return null;
  }
}

async function embeddedSource(root) {
  const files = [];
  const layout = (await lstat(root)).isFile() ? "file" : "directory";
  async function walk(path, prefix = "") {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error(`Refusing symlink: ${path}`);
    if (stat.isFile()) {
      if (deniedNames.test(basename(path))) throw new Error(`Refusing sensitive file: ${path}`);
      if (stat.size > MAX_FILE) throw new Error(`File exceeds ${MAX_FILE} bytes: ${path}`);
      const content = await readFile(path);
      const text = content.toString("utf8");
      if (secretPatterns.some(pattern => pattern.test(text))) throw new Error(`Possible secret found in: ${path}`);
      files.push({ path: safeRelative(prefix || basename(path)), content: content.toString("base64"), sha256: sha256(content) });
      return;
    }
    if (!stat.isDirectory()) throw new Error(`Unsupported file type: ${path}`);
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if ([".git", "node_modules", "dist", "coverage"].includes(entry.name) || deniedNames.test(entry.name)) continue;
      await walk(join(path, entry.name), prefix ? `${prefix}/${entry.name}` : entry.name);
    }
  }
  await walk(root);
  return { kind: "embedded", layout, files };
}

function cleanMcp(value, requiredSecrets, key = "") {
  if (Array.isArray(value)) return value.map(item => cleanMcp(item, requiredSecrets, key));
  if (!value || typeof value !== "object") return value;
  const clean = {};
  for (const [name, child] of Object.entries(value)) {
    if (name === "env" && child && typeof child === "object") {
      clean.env = {};
      for (const envName of Object.keys(child)) {
        requiredSecrets.add(envName);
        clean.env[envName] = `\${${envName}}`;
      }
    } else if (/token|secret|password|authorization|cookie|api.?key/i.test(name)) {
      const envName = `${key}_${name}`.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "").toUpperCase();
      requiredSecrets.add(envName);
      clean[name] = `\${${envName}}`;
    } else clean[name] = cleanMcp(child, requiredSecrets, `${key}_${name}`);
  }
  return clean;
}

function parseCodexMcp(text) {
  const servers = {};
  let current;
  let env = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    const section = line.match(/^\[mcp_servers\.([^.\]]+)(?:\.(env))?\]$/);
    if (section) {
      current = section[1];
      env = Boolean(section[2]);
      servers[current] ||= {};
      if (env) servers[current].env ||= {};
      continue;
    }
    if (!current || !line || line.startsWith("[")) {
      if (line.startsWith("[")) current = undefined;
      continue;
    }
    const pair = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (!pair) continue;
    let value;
    try { value = JSON.parse(pair[2]); } catch { value = pair[2].replace(/^['"]|['"]$/g, ""); }
    (env ? servers[current].env : servers[current])[pair[1]] = value;
  }
  return servers;
}

async function addFilesystemItems(items, path, kind, agent, destinationBase, scope = "user") {
  if (!await exists(path)) return;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const sourcePath = join(path, entry.name);
    items.push({
      id: `${agent}-${kind}-${entry.name}`,
      name: entry.name,
      kind,
      agent,
      scope,
      destination: `${destinationBase}/${entry.name}`,
      source: await gitSource(sourcePath) || await embeddedSource(sourcePath)
    });
  }
}

async function addRule(items, path, agent, destination, scope = "user") {
  if (!await exists(path)) return;
  items.push({ id: `${agent}-rules-${basename(path)}`, name: basename(path), kind: "rules", agent, scope, destination, source: await gitSource(path) || await embeddedSource(path) });
}

export async function scan({ home = homedir(), project, title = "Shared agent setup" } = {}) {
  const items = [];
  const requiredSecrets = new Set();
  await addFilesystemItems(items, join(home, ".claude/skills"), "skill", "claude-code", ".claude/skills");
  await addFilesystemItems(items, join(home, ".claude/plugins"), "plugin", "claude-code", ".claude/plugins");
  await addFilesystemItems(items, join(home, ".codex/skills"), "skill", "codex", ".codex/skills");
  await addFilesystemItems(items, join(home, ".codex/plugins"), "plugin", "codex", ".codex/plugins");
  await addFilesystemItems(items, join(home, ".agents/skills"), "skill", "shared", ".agents/skills");
  await addRule(items, join(home, ".claude/CLAUDE.md"), "claude-code", ".claude/CLAUDE.md");
  await addRule(items, join(home, ".codex/AGENTS.md"), "codex", ".codex/AGENTS.md");

  const claudeConfig = join(home, ".claude.json");
  if (await exists(claudeConfig)) {
    const parsed = JSON.parse(await readFile(claudeConfig, "utf8"));
    if (parsed.mcpServers && Object.keys(parsed.mcpServers).length) {
      items.push({ id: "claude-code-mcp", name: "Claude MCP servers", kind: "mcp", agent: "claude-code", scope: "user", destination: ".claude.json", config: cleanMcp(parsed.mcpServers, requiredSecrets, "CLAUDE_MCP") });
    }
  }
  const codexConfig = join(home, ".codex/config.toml");
  if (await exists(codexConfig)) {
    const servers = parseCodexMcp(await readFile(codexConfig, "utf8"));
    if (Object.keys(servers).length) {
      items.push({ id: "codex-mcp", name: "Codex MCP servers", kind: "mcp", agent: "codex", scope: "user", destination: ".codex/config.toml", config: cleanMcp(servers, requiredSecrets, "CODEX_MCP") });
    }
  }
  if (project) {
    const root = resolve(project);
    await addFilesystemItems(items, join(root, ".claude/skills"), "skill", "claude-code", ".claude/skills", "project");
    await addFilesystemItems(items, join(root, ".codex/skills"), "skill", "codex", ".codex/skills", "project");
    await addFilesystemItems(items, join(root, ".agents/skills"), "skill", "shared", ".agents/skills", "project");
    await addRule(items, join(root, "CLAUDE.md"), "claude-code", "CLAUDE.md", "project");
    await addRule(items, join(root, "AGENTS.md"), "shared", "AGENTS.md", "project");
    const mcp = join(root, ".mcp.json");
    if (await exists(mcp)) {
      const parsed = JSON.parse(await readFile(mcp, "utf8"));
      items.push({ id: "project-mcp", name: "Project MCP servers", kind: "mcp", agent: "shared", scope: "project", destination: ".mcp.json", config: cleanMcp(parsed.mcpServers || parsed, requiredSecrets, "PROJECT_MCP") });
    }
  }
  const bundle = { formatVersion: 1, metadata: { id: randomUUID(), title, createdAt: new Date().toISOString() }, requiredSecrets: [...requiredSecrets].sort(), items };
  if (Buffer.byteLength(JSON.stringify(bundle)) > MAX_BUNDLE) throw new Error(`Bundle exceeds ${MAX_BUNDLE} bytes`);
  bundle.integrity = { sha256: sha256(JSON.stringify(bundle)) };
  return bundle;
}

export function validate(bundle) {
  if (bundle?.formatVersion !== 1 || !Array.isArray(bundle.items) || !bundle.integrity?.sha256) throw new Error("Invalid version 1 bundle");
  if (!bundle.metadata || typeof bundle.metadata.id !== "string" || typeof bundle.metadata.title !== "string" || !bundle.metadata.title.trim() || bundle.metadata.title.length > 120) throw new Error("Invalid bundle metadata");
  if (!Array.isArray(bundle.requiredSecrets) || bundle.requiredSecrets.some(name => typeof name !== "string" || !/^[A-Z_][A-Z0-9_]*$/.test(name))) throw new Error("Invalid required secrets");
  const { integrity, ...body } = bundle;
  if (sha256(JSON.stringify(body)) !== integrity.sha256) throw new Error("Bundle integrity check failed");
  for (const item of bundle.items) {
    if (typeof item.id !== "string" || typeof item.name !== "string" || typeof item.agent !== "string" || !["skill", "plugin", "rules", "mcp"].includes(item.kind) || !["user", "project"].includes(item.scope)) throw new Error(`Invalid item: ${item.id}`);
    safeRelative(item.destination);
    if (item.kind === "mcp" ? !item.config : !item.source) throw new Error(`Missing content: ${item.id}`);
    if (item.source?.kind === "embedded") for (const file of item.source.files) {
      safeRelative(file.path);
      if (sha256(Buffer.from(file.content, "base64")) !== file.sha256) throw new Error(`Checksum failed: ${item.id}/${file.path}`);
    }
    if (item.source?.kind === "git" && !/^[0-9a-f]{40}$/i.test(item.source.commit)) throw new Error(`Unpinned Git source: ${item.id}`);
  }
  return bundle;
}

export async function loadBundle(input) {
  if (!/^https?:/.test(input)) return validate(JSON.parse(await readFile(resolve(input), "utf8")));
  let url = input;
  if (/\/s\/[0-9a-f]{32}\/?$/i.test(url)) url = `${url.replace(/\/$/, "")}/manifest.json`;
  const response = await fetch(url, { headers: { "User-Agent": "agent-setup-link" } });
  if (!response.ok) throw new Error(`Download failed: ${response.status}`);
  return validate(await response.json());
}

export function plan(bundle, home = homedir(), project = process.cwd()) {
  return bundle.items.map(item => ({ ...item, absoluteDestination: resolve(item.scope === "project" ? project : home, safeRelative(item.destination)) }));
}

async function materialize(item, destination) {
  if (item.source?.kind === "embedded") {
    if (item.source.layout === "file") {
      const [file] = item.source.files;
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, Buffer.from(file.content, "base64"));
      return;
    }
    for (const file of item.source.files) {
      const target = join(destination, safeRelative(file.path));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, Buffer.from(file.content, "base64"));
    }
    return;
  }
  if (item.source?.kind === "git") {
    const temp = await mkdtemp(join(tmpdir(), "agent-setup-"));
    try {
      await exec("git", ["clone", "--quiet", "--no-checkout", item.source.repository, temp]);
      await exec("git", ["-C", temp, "checkout", "--quiet", item.source.commit, "--", item.source.path]);
      await cp(resolve(temp, item.source.path), destination, { recursive: true });
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }
}

function codexMcp(config) {
  let out = "";
  for (const [name, server] of Object.entries(config)) {
    out += `\n[mcp_servers.${name}]\n`;
    for (const [key, value] of Object.entries(server)) if (key !== "env") out += `${key} = ${JSON.stringify(value)}\n`;
    if (server.env) {
      out += `\n[mcp_servers.${name}.env]\n`;
      for (const [key, value] of Object.entries(server.env)) out += `${key} = ${JSON.stringify(value)}\n`;
    }
  }
  return out;
}

async function installMcp(item, destination) {
  if (item.agent === "codex") {
    const current = await exists(destination) ? await readFile(destination, "utf8") : "";
    await writeFile(destination, `${current.trimEnd()}\n${codexMcp(item.config)}`.trimStart());
  } else {
    const current = await exists(destination) ? JSON.parse(await readFile(destination, "utf8")) : {};
    current.mcpServers = { ...(current.mcpServers || {}), ...item.config };
    await writeFile(destination, `${JSON.stringify(current, null, 2)}\n`);
  }
}

export async function install(bundle, { home = homedir(), project = process.cwd(), force = false } = {}) {
  validate(bundle);
  const id = `${Date.now()}-${bundle.metadata.id.slice(0, 8)}`;
  const stateRoot = join(home, ".agent-setup-link");
  const backupRoot = join(stateRoot, "backups", id);
  const changes = [];
  try {
    for (const item of plan(bundle, home, project)) {
      const destination = item.absoluteDestination;
      const hadExisting = await exists(destination);
      if (hadExisting && !force) {
        changes.push({ item: item.id, destination: item.destination, status: "kept" });
        continue;
      }
      if (hadExisting) {
        const backup = join(backupRoot, item.scope, item.destination);
        await mkdir(dirname(backup), { recursive: true });
        await cp(destination, backup, { recursive: true });
      }
      const change = { item: item.id, destination: item.destination, scope: item.scope, status: "installing", hadExisting };
      changes.push(change);
      await rm(destination, { recursive: true, force: true });
      const parent = item.kind === "mcp" || item.source?.layout === "file" ? dirname(destination) : destination;
      await mkdir(parent, { recursive: true });
      if (item.kind === "mcp") await installMcp(item, destination);
      else await materialize(item, destination);
      change.status = "installed";
    }
  } catch (error) {
    await restoreChanges(changes, home, project, backupRoot);
    throw error;
  }
  const journal = { id, bundleId: bundle.metadata.id, installedAt: new Date().toISOString(), changes };
  await mkdir(join(stateRoot, "installations"), { recursive: true });
  await writeFile(join(stateRoot, "installations", `${id}.json`), `${JSON.stringify(journal, null, 2)}\n`);
  return journal;
}

async function restoreChanges(changes, home, project, backupRoot) {
  for (const change of [...changes].reverse()) {
    if (!['installed', 'installing'].includes(change.status)) continue;
    const destination = resolve(change.scope === "project" ? project : home, safeRelative(change.destination));
    await rm(destination, { recursive: true, force: true });
    if (change.hadExisting) {
      const backup = join(backupRoot, change.scope, change.destination);
      await mkdir(dirname(destination), { recursive: true });
      await cp(backup, destination, { recursive: true });
    }
  }
}

export async function rollback(id, home = homedir(), project = process.cwd()) {
  safeRelative(id);
  const stateRoot = join(home, ".agent-setup-link");
  const journalPath = join(stateRoot, "installations", `${id}.json`);
  const journal = JSON.parse(await readFile(journalPath, "utf8"));
  await restoreChanges(journal.changes, home, project, join(stateRoot, "backups", id));
  await writeFile(journalPath, `${JSON.stringify({ ...journal, rolledBackAt: new Date().toISOString() }, null, 2)}\n`);
  return journal;
}

export async function doctor(home = homedir()) {
  return Promise.all([".claude", ".codex", ".agents/skills"].map(async path => ({ path, found: await exists(join(home, path)) })));
}

export async function publish(bundlePath, { registry = process.env.AGENT_SETUP_REGISTRY_URL || "https://agent-setup-link.vercel.app", token = process.env.AGENT_SETUP_PUBLISH_TOKEN } = {}) {
  const bundle = validate(JSON.parse(await readFile(resolve(bundlePath), "utf8")));
  if (!token) throw new Error("Set AGENT_SETUP_PUBLISH_TOKEN before publishing");
  const response = await fetch(`${registry.replace(/\/$/, "")}/api/bundles`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(bundle)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Publishing failed: ${response.status}`);
  return result.page;
}
