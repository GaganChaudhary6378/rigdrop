import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { access, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { gunzipSync, gzipSync } from "node:zlib";

const exec = promisify(execFile);
const MAX_FILE = 256 * 1024;
export const MAX_BUNDLE_BYTES = 4 * 1024 * 1024;
const portableExtensions = new Set([".md", ".txt", ".json", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".sh", ".bash", ".zsh", ".fish", ".ps1", ".rb", ".go", ".rs", ".java", ".kt", ".swift", ".sql", ".html", ".css", ".xml", ".csv"]);
const portableNames = new Set(["agents", "claude", "readme", "license", "notice", "changelog", "dockerfile", "makefile"]);
const deniedNames = /^(\.env(?:\..*)?|auth\.json|credentials(?:\.json)?|cookies?|id_(?:rsa|ed25519)(?:\.pub)?|.+\.(?:pem|key|p12|pfx))$/i;
const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bgh[opsu]_[A-Za-z0-9_]{30,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:sk|rk)-(?:live|test)-[A-Za-z0-9]{20,}\b/
];
const knownSecretExamples = new Set(["AKIAIOSFODNN7EXAMPLE"]);

export const sha256 = value => createHash("sha256").update(value).digest("hex");
const exists = async path => access(path).then(() => true, () => false);
const safeRelative = path => {
  if (!path || isAbsolute(path) || path.split(/[\\/]/).includes("..")) throw new Error(`Unsafe path: ${path}`);
  return path;
};
const containsSecret = text => secretPatterns.some(pattern =>
  [...text.matchAll(new RegExp(pattern.source, "g"))].some(match => !knownSecretExamples.has(match[0]))
);
const isPortableTextOrScript = (path, content) => {
  if (content.includes(0) || content.toString("utf8").includes("\uFFFD")) return false;
  const name = basename(path).toLowerCase();
  return portableExtensions.has(extname(name)) || portableNames.has(name) || content.subarray(0, 2).toString("utf8") === "#!";
};
const decodeEmbeddedFile = file => {
  if (file.encoding && file.encoding !== "gzip-base64") throw new Error(`Unsupported file encoding: ${file.path}`);
  const encoded = Buffer.from(file.content, "base64");
  const content = file.encoding === "gzip-base64" ? gunzipSync(encoded) : encoded;
  if (content.length > MAX_FILE) throw new Error(`Embedded file exceeds ${MAX_FILE} bytes: ${file.path}`);
  return content;
};
const embeddedFilePath = (item, file) => item.source?.layout === "file" ? item.destination : `${item.destination}/${file.path}`.replace(/\/+/g, "/");
const runGit = async (cwd, ...args) => (await exec("git", ["-C", cwd, ...args], { encoding: "utf8" })).stdout.trim();

async function gitSource(path) {
  try {
    const root = await runGit(path, "rev-parse", "--show-toplevel");
    const repository = await runGit(path, "remote", "get-url", "origin");
    if (!/^(?:https:\/\/github\.com\/|git@github\.com:)/.test(repository)) return null;
    const changes = (await runGit(root, "status", "--porcelain", "--", path))
      .split("\n")
      .filter(line => line && basename(line.slice(3)) !== ".DS_Store");
    if (changes.length) return null;
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

function isWithin(path, root) {
  const pathFromRoot = relative(root, path);
  return pathFromRoot === "" || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !isAbsolute(pathFromRoot));
}

async function embeddedSource(root, allowedRoots = [dirname(root)]) {
  const files = [];
  const skipped = [];
  const layout = (await lstat(root)).isFile() ? "file" : "directory";
  const resolvedAllowedRoots = (await Promise.all(allowedRoots.map(async allowedRoot =>
    await exists(allowedRoot) ? realpath(allowedRoot) : null
  ))).filter(Boolean);
  async function walk(path, prefix = "", ancestry = new Set()) {
    let current = path;
    let entry = await lstat(current);
    if (entry.isSymbolicLink()) {
      current = await realpath(current);
      if (!resolvedAllowedRoots.some(allowedRoot => isWithin(current, allowedRoot))) throw new Error(`Refusing symlink outside allowed directory: ${path}`);
      entry = await stat(current);
    }
    if (entry.isFile()) {
      if (deniedNames.test(basename(path))) {
        skipped.push({ path: safeRelative(prefix || basename(path)), reason: "sensitive filename" });
        return;
      }
      if (entry.size === 0) {
        skipped.push({ path: safeRelative(prefix || basename(path)), reason: "empty file" });
        return;
      }
      if (entry.size > MAX_FILE) {
        skipped.push({ path: safeRelative(prefix || basename(path)), reason: `exceeds ${MAX_FILE} bytes` });
        return;
      }
      const content = await readFile(current);
      if (!isPortableTextOrScript(path, content)) {
        skipped.push({ path: safeRelative(prefix || basename(path)), reason: "not a portable text or script file" });
        return;
      }
      const text = content.toString("utf8");
      if (containsSecret(text)) throw new Error(`Possible secret found in: ${path}`);
      files.push({ path: safeRelative(prefix || basename(path)), content: gzipSync(content).toString("base64"), encoding: "gzip-base64", sha256: sha256(content) });
      return;
    }
    if (!entry.isDirectory()) throw new Error(`Unsupported file type: ${path}`);
    const canonical = await realpath(current);
    if (ancestry.has(canonical)) throw new Error(`Refusing symlink cycle: ${path}`);
    const nextAncestry = new Set(ancestry).add(canonical);
    for (const child of await readdir(current, { withFileTypes: true })) {
      if ([".git", "node_modules", "dist", "coverage", "build", ".next", ".cache"].includes(child.name)) continue;
      await walk(join(current, child.name), prefix ? `${prefix}/${child.name}` : child.name, nextAncestry);
    }
  }
  await walk(root);
  return { kind: "embedded", layout, files, skipped };
}

function commandOnlyMcp(servers) {
  const clean = {};
  for (const [name, server] of Object.entries(servers || {})) {
    if (typeof server?.command === "string" && server.command.trim() && !containsSecret(server.command)) clean[name] = { command: server.command.trim() };
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

async function addFilesystemItems(items, path, kind, agent, destinationBase, scope = "user", excluded = [], allowedRoots) {
  if (!await exists(path)) return;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || excluded.includes(entry.name)) continue;
    const sourcePath = join(path, entry.name);
    const source = await gitSource(sourcePath) || await embeddedSource(sourcePath, allowedRoots);
    if (source.kind === "embedded" && !source.files.length) continue;
    items.push({
      id: `${agent}-${kind}-${entry.name}`,
      name: entry.name,
      kind,
      agent,
      scope,
      destination: `${destinationBase}/${entry.name}`,
      source
    });
  }
}

async function addRule(items, path, agent, destination, scope = "user", allowedRoots) {
  if (!await exists(path)) return;
  const source = await gitSource(path) || await embeddedSource(path, allowedRoots);
  if (source.kind === "embedded" && !source.files.length) return;
  items.push({ id: `${agent}-rules-${basename(path)}`, name: basename(path), kind: "rules", agent, scope, destination, source });
}

export async function scan({ home = homedir(), project, title = "Shared agent setup" } = {}) {
  const items = [];
  const requiredSecrets = new Set();
  const userAgentRoots = [join(home, ".claude"), join(home, ".codex"), join(home, ".agents")];
  await addFilesystemItems(items, join(home, ".claude/skills"), "skill", "claude-code", ".claude/skills", "user", ["synced", ".trash"], userAgentRoots);
  await addFilesystemItems(items, join(home, ".claude/plugins"), "plugin", "claude-code", ".claude/plugins", "user", ["cache", "data", "marketplaces", "store", "synced"], userAgentRoots);
  await addFilesystemItems(items, join(home, ".codex/skills"), "skill", "codex", ".codex/skills", "user", [], userAgentRoots);
  await addFilesystemItems(items, join(home, ".codex/plugins"), "plugin", "codex", ".codex/plugins", "user", ["cache", "data", "store", "marketplaces", "synced", ".marketplace-plugin-source-staging", ".remote-plugin-install-staging"], userAgentRoots);
  await addFilesystemItems(items, join(home, ".agents/skills"), "skill", "shared", ".agents/skills", "user", [], userAgentRoots);
  await addRule(items, join(home, ".claude/CLAUDE.md"), "claude-code", ".claude/CLAUDE.md", "user", userAgentRoots);
  await addRule(items, join(home, ".codex/AGENTS.md"), "codex", ".codex/AGENTS.md", "user", userAgentRoots);

  const claudeConfig = join(home, ".claude.json");
  if (await exists(claudeConfig)) {
    const parsed = JSON.parse(await readFile(claudeConfig, "utf8"));
    if (parsed.mcpServers && Object.keys(parsed.mcpServers).length) {
      const servers = commandOnlyMcp(parsed.mcpServers);
      if (Object.keys(servers).length) items.push({ id: "claude-code-mcp", name: "Claude MCP servers", kind: "mcp", agent: "claude-code", scope: "user", destination: ".claude.json", config: servers });
    }
  }
  const codexConfig = join(home, ".codex/config.toml");
  if (await exists(codexConfig)) {
    const servers = parseCodexMcp(await readFile(codexConfig, "utf8"));
    if (Object.keys(servers).length) {
      const safeServers = commandOnlyMcp(servers);
      if (Object.keys(safeServers).length) items.push({ id: "codex-mcp", name: "Codex MCP servers", kind: "mcp", agent: "codex", scope: "user", destination: ".codex/config.toml", config: safeServers });
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
      const servers = commandOnlyMcp(parsed.mcpServers || parsed);
      if (Object.keys(servers).length) items.push({ id: "project-mcp", name: "Project MCP servers", kind: "mcp", agent: "shared", scope: "project", destination: ".mcp.json", config: servers });
    }
  }
  const gitGstack = items.find(item => item.name === "gstack" && item.source?.kind === "git");
  if (gitGstack) for (const item of items) if (item !== gitGstack && item.name === "gstack" && item.source?.kind === "embedded") item.source = structuredClone(gitGstack.source);
  const bundle = { formatVersion: 1, metadata: { id: randomUUID(), title, createdAt: new Date().toISOString() }, requiredSecrets: [...requiredSecrets].sort(), items };
  ensureBundleFits(bundle);
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
      if (sha256(decodeEmbeddedFile(file)) !== file.sha256) throw new Error(`Checksum failed: ${item.id}/${file.path}`);
    }
    if (item.source?.kind === "embedded" && item.source.skipped && !item.source.skipped.every(file => typeof file.reason === "string" && safeRelative(file.path))) throw new Error(`Invalid skipped file: ${item.id}`);
    if (item.source?.kind === "git" && !/^[0-9a-f]{40}$/i.test(item.source.commit)) throw new Error(`Unpinned Git source: ${item.id}`);
  }
  return bundle;
}

export function bundleByteLength(bundle) {
  return Buffer.byteLength(JSON.stringify(bundle));
}

export function ensureBundleFits(bundle) {
  const bytes = bundleByteLength(bundle);
  if (bytes > MAX_BUNDLE_BYTES) throw new Error(`Bundle exceeds ${MAX_BUNDLE_BYTES} bytes`);
  return bytes;
}

export function bundleReview(bundle) {
  validate(bundle);
  const files = [];
  const skipped = [];
  const references = [];
  for (const item of bundle.items) {
    if (item.source?.kind === "embedded") {
      for (const file of item.source.files) files.push({ itemId: item.id, path: embeddedFilePath(item, file), bytes: decodeEmbeddedFile(file).length });
      for (const file of item.source.skipped || []) skipped.push({ path: embeddedFilePath(item, file), reason: file.reason });
    }
    if (item.source?.kind === "git") references.push({ path: item.destination, repository: item.source.repository, commit: item.source.commit, sourcePath: item.source.path });
  }
  return { files, skipped, references, bundleBytes: bundleByteLength(bundle) };
}

export function omitBundleFiles(bundle, selections) {
  validate(bundle);
  const selected = new Set(selections);
  const next = structuredClone(bundle);
  next.items = next.items.flatMap(item => {
    if (item.source?.kind !== "embedded") return [item];
    const removed = item.source.files.filter(file => selected.has(embeddedFilePath(item, file)));
    item.source.files = item.source.files.filter(file => !selected.has(embeddedFilePath(item, file)));
    item.source.skipped ||= [];
    item.source.skipped.push(...removed.map(file => ({ path: file.path, reason: "removed during review" })));
    return item.source.files.length ? [item] : [];
  });
  const { integrity, ...body } = next;
  next.integrity = { sha256: sha256(JSON.stringify(body)) };
  return validate(next);
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
      await writeFile(destination, decodeEmbeddedFile(file));
      return;
    }
    for (const file of item.source.files) {
      const target = join(destination, safeRelative(file.path));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, decodeEmbeddedFile(file));
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
  ensureBundleFits(bundle);
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

export async function publishBundle(bundle, { registry, token } = {}) {
  validate(bundle);
  ensureBundleFits(bundle);
  const directory = await mkdtemp(join(tmpdir(), "rigdrop-share-"));
  const bundlePath = join(directory, "bundle.json");
  try {
    await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`);
    const page = await publish(bundlePath, { registry, token });
    return page;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function share({ home = homedir(), project, title, registry, token } = {}) {
  const bundle = await scan({ home, project, title });
  return { bundle, page: await publishBundle(bundle, { registry, token }) };
}
