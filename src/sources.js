// Finds how skills and plugins were installed, so a bundle can carry one install
// source instead of copies of every file it installed.
import { execFile } from "node:child_process";
import { access, lstat, readFile, readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const runGit = async (cwd, ...args) => (await exec("git", ["-C", cwd, ...args], { encoding: "utf8" })).stdout.trim();
const toPosix = path => path.split(sep).join("/");
const readJson = async path => JSON.parse(await readFile(path, "utf8").catch(() => "null"));
const exists = async path => access(path).then(() => true, () => false);
const cloneRoot = /^\.(?:claude|codex|agents)\/skills\/[^/]+$/;

export function isWithin(path, root) {
  const pathFromRoot = relative(root, path);
  return pathFromRoot === "" || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !isAbsolute(pathFromRoot));
}

export async function gitSource(path) {
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
      path: toPosix(relative(root, await realpath(path))) || "."
    };
  } catch {
    return null;
  }
}

const localNotes = (agent, local) => [...local].map(([marketplace, names]) =>
  ({ note: `${agent} marketplace ${marketplace} is local, so its plugins are not shared: ${names.join(", ")}` }));

const sourceItem = (id, name, agent, destination, source) => ({ id, name, kind: "source", agent, scope: "user", destination, source });

function grouped(groups, key, repository, name) {
  if (!groups.has(key)) groups.set(key, { repository, names: [] });
  groups.get(key).names.push(name);
}

// Claude Code: `claude plugin install NAME@MARKETPLACE` records.
async function claudeMarketplaces(home) {
  const installed = await readJson(join(home, ".claude/plugins/installed_plugins.json"));
  const known = await readJson(join(home, ".claude/plugins/known_marketplaces.json")) || {};
  const groups = new Map();
  const local = new Map();
  for (const [id, installs] of Object.entries(installed?.plugins || {})) {
    if (!Array.isArray(installs) || !installs.some(entry => entry.scope === "user")) continue;
    const [plugin, marketplace] = id.split("@");
    const source = known[marketplace]?.source;
    const repository = source?.source === "github" ? source.repo : source?.source === "git" ? source.url : null;
    if (!repository) {
      local.set(marketplace, [...local.get(marketplace) || [], plugin]);
      continue;
    }
    grouped(groups, marketplace, repository, plugin);
  }
  return [...groups].map(([marketplace, { repository, names }]) => sourceItem(`claude-plugins-${marketplace}`, marketplace, "claude-code", ".claude/plugins", {
    kind: "claude-marketplace", marketplace, repository, plugins: names.sort()
  })).concat(localNotes("Claude", local));
}

function tomlSections(text) {
  const sections = {};
  let current;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    const header = line.match(/^\[(.+)\]$/);
    if (header) {
      current = sections[header[1]] = {};
      continue;
    }
    const pair = current && line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (!pair) continue;
    try { current[pair[1]] = JSON.parse(pair[2]); } catch { current[pair[1]] = pair[2].replace(/^['"]|['"]$/g, ""); }
  }
  return sections;
}

// Codex: `[plugins."NAME@MARKETPLACE"]` and `[marketplaces.NAME]` in config.toml.
async function codexMarketplaces(home) {
  const text = await readFile(join(home, ".codex/config.toml"), "utf8").catch(() => "");
  const sections = tomlSections(text);
  const groups = new Map();
  const local = new Map();
  for (const [header, values] of Object.entries(sections)) {
    const match = header.match(/^plugins\."([^"@]+)@([^"]+)"$/);
    if (!match || values.enabled === false) continue;
    const [, plugin, marketplace] = match;
    const market = sections[`marketplaces.${marketplace}`] || sections[`marketplaces."${marketplace}"`];
    if (market && market.source_type !== "git") {
      local.set(marketplace, [...local.get(marketplace) || [], plugin]);
      continue;
    }
    // No marketplace section means a marketplace built into Codex, such as openai-curated.
    grouped(groups, marketplace, market?.source || null, plugin);
  }
  return [...groups].map(([marketplace, { repository, names }]) => sourceItem(`codex-plugins-${marketplace}`, marketplace, "codex", ".codex/plugins", {
    kind: "codex-marketplace", marketplace, repository, plugins: names.sort()
  })).concat(localNotes("Codex", local));
}

// `npx skills add OWNER/REPO` records in ~/.agents/.skill-lock.json.
async function skillsCliSources(home) {
  const lock = await readJson(join(home, ".agents/.skill-lock.json"));
  const groups = new Map();
  for (const [name, skill] of Object.entries(lock?.skills || {})) {
    const path = join(home, ".agents/skills", name);
    if (skill.sourceType !== "github" || !/^[\w.-]+\/[\w.-]+$/.test(skill.source || "") || !await exists(path)) continue;
    grouped(groups, skill.source, skill.source, name);
  }
  return [...groups].map(([repository, { names }]) => sourceItem(`skills-cli-${repository.replace("/", "-")}`, repository, "shared", ".agents/skills", {
    kind: "skills-cli", repository, skills: names.sort()
  }));
}

// Every file under path, when every one is a symlink; otherwise null.
async function linkLeaves(path) {
  const entry = await lstat(path);
  if (entry.isSymbolicLink()) {
    const target = await realpath(path).catch(() => null);
    return target ? [{ link: path, target }] : null;
  }
  if (!entry.isDirectory()) return basename(path) === ".DS_Store" ? [] : null;
  const leaves = [];
  for (const child of await readdir(path)) {
    const childLeaves = await linkLeaves(join(path, child));
    if (!childLeaves) return null;
    leaves.push(...childLeaves);
  }
  return leaves;
}

// Skills that are only symlinks into one clean GitHub clone, such as the gstack setup script makes.
async function linkedClones(home, coveredRealpaths) {
  const realHome = await realpath(home);
  const clones = new Map();
  const repoRoots = new Map();
  const handled = [];
  const repoOf = async target => {
    const directory = (await lstat(target)).isDirectory() ? target : dirname(target);
    if (!repoRoots.has(directory)) repoRoots.set(directory, await runGit(directory, "rev-parse", "--show-toplevel").then(realpath, () => null));
    return repoRoots.get(directory);
  };
  for (const skillsDirectory of [".claude/skills", ".codex/skills", ".agents/skills"].map(path => join(home, path))) {
    const entries = await readdir(skillsDirectory).catch(() => []);
    for (const name of entries.filter(name => !name.startsWith("."))) {
      const path = join(skillsDirectory, name);
      const links = await linkLeaves(path);
      if (!links?.length) continue;
      if (links.every(({ target }) => coveredRealpaths.some(root => isWithin(target, root)))) {
        handled.push(path);
        continue;
      }
      const roots = new Set(await Promise.all(links.map(({ target }) => repoOf(target))));
      const [root] = roots;
      if (roots.size !== 1 || !root || !isWithin(root, realHome) || !cloneRoot.test(toPosix(relative(realHome, root)))) continue;
      if (!clones.has(root)) {
        const source = await gitSource(root);
        clones.set(root, source?.path === "." ? { source, links: [] } : null);
      }
      const clone = clones.get(root);
      if (!clone) continue;
      clone.links.push(...links.map(({ link, target }) => ({ path: toPosix(relative(home, link)), target: toPosix(relative(root, target)) })));
      handled.push(path);
    }
  }
  const items = [];
  for (const [root, clone] of clones) {
    if (!clone?.links.length) continue;
    const path = toPosix(relative(realHome, root));
    handled.push(join(home, path));
    items.push(sourceItem(`git-clone-${basename(root)}`, clone.source.repository.replace("https://github.com/", ""), "shared", path, {
      kind: "git-clone",
      repository: clone.source.repository,
      commit: clone.source.commit,
      path,
      setup: await exists(join(root, "setup")),
      links: clone.links
    }));
  }
  return { items, handled };
}

export async function detectSources(home) {
  const found = [...await claudeMarketplaces(home), ...await codexMarketplaces(home), ...await skillsCliSources(home)];
  const items = found.filter(item => !item.note);
  const covered = items.filter(item => item.source.kind === "skills-cli")
    .flatMap(item => item.source.skills.map(name => join(home, ".agents/skills", name)));
  const coveredRealpaths = await Promise.all(covered.map(path => realpath(path)));
  const clones = await linkedClones(home, coveredRealpaths);
  return {
    items: [...items, ...clones.items],
    notes: found.filter(item => item.note).map(item => item.note),
    covered: new Set([...covered, ...clones.handled])
  };
}

// Commands are built here from checked fields; text from a bundle is never run.
export function sourceCommands(item) {
  const { source } = item;
  if (source.kind === "claude-marketplace") return [
    { command: "claude", args: ["plugin", "marketplace", "add", source.repository], optional: true },
    ...source.plugins.map(plugin => ({ command: "claude", args: ["plugin", "install", `${plugin}@${source.marketplace}`, "--scope", "user"] }))
  ];
  if (source.kind === "codex-marketplace") return [
    ...(source.repository ? [{ command: "codex", args: ["plugin", "marketplace", "add", source.repository], optional: true }] : []),
    ...source.plugins.map(plugin => ({ command: "codex", args: ["plugin", "add", `${plugin}@${source.marketplace}`] }))
  ];
  if (source.kind === "skills-cli") return [{ command: "npx", args: ["--yes", "skills", "add", source.repository, "-g", "-y", "--skill", ...source.skills] }];
  return [];
}

export const commandText = ({ command, args }) => [command, ...args].join(" ");

export function sourceCount(source) {
  return (source.plugins || source.skills || source.links).length;
}

const sourceName = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const sourceRepository = /^(?:[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9_.-]+|https:\/\/[A-Za-z0-9.-]+(?:\/[A-Za-z0-9_.~-]+)+)$/;
const agentSkillPath = /^\.(?:claude|codex|agents)\/skills\/[^/]+(?:\/[^/]+)*$/;

// safeRelative is passed in to keep one path rule for the whole bundle.
export function validateSource(item, safeRelative) {
  const { source } = item;
  const fail = reason => { throw new Error(`Invalid source ${item.id}: ${reason}`); };
  if (["claude-marketplace", "codex-marketplace", "skills-cli"].includes(source?.kind)) {
    const names = source.kind === "skills-cli" ? source.skills : source.plugins;
    if (!Array.isArray(names) || !names.length || !names.every(name => sourceName.test(name))) fail("names");
    if (source.kind !== "skills-cli" && !sourceName.test(source.marketplace || "")) fail("marketplace");
    const optionalRepository = source.kind === "codex-marketplace" && source.repository === null;
    if (!optionalRepository && (!sourceRepository.test(source.repository || "") || source.repository.includes(".."))) fail("repository");
    return;
  }
  if (source?.kind === "git-clone") {
    if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(source.repository) || source.repository.includes("..")) fail("repository");
    if (!/^[0-9a-f]{40}$/i.test(source.commit)) fail("commit");
    if (!cloneRoot.test(source.path) || source.path !== item.destination) fail("path");
    if (!Array.isArray(source.links) || !source.links.length) fail("links");
    for (const link of source.links) {
      if (!agentSkillPath.test(link.path) || link.path.startsWith(`${source.path}/`)) fail(`link ${link.path}`);
      safeRelative(link.path);
      safeRelative(link.target);
    }
    return;
  }
  fail("unsupported kind");
}
