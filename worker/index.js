import { bundleUrls, renderInstructions } from "../src/hosted.js";

const encoder = new TextEncoder();
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const error = (message, status) => json({ error: message }, status);
const slugPattern = /^[0-9a-f]{32}$/;
const origin = request => new URL(request.url).origin;
const portableExtensions = new Set([".md", ".txt", ".json", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".sh", ".bash", ".zsh", ".fish", ".ps1", ".rb", ".go", ".rs", ".java", ".kt", ".swift", ".sql", ".html", ".css", ".xml", ".csv"]);
const sensitiveName = /^(\.env(?:\..*)?|auth\.json|credentials(?:\.json)?|cookies?|id_(?:rsa|ed25519)(?:\.pub)?|.+\.(?:pem|key|p12|pfx))$/i;
const secretPattern = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bgh[opsu]_[A-Za-z0-9_]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b|\bAKIA[0-9A-Z]{16}\b|\b(?:sk|rk)-(?:live|test)-[A-Za-z0-9]{20,}\b/;

async function digest(value) {
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

const canonicalJson = value => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)))
  : item);

async function passcodeDigest(passcode, secret) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(passcode));
  return [...new Uint8Array(signature)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(left, right) {
  if (!left || !right || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function validBundle(bundle) {
  if (bundle?.formatVersion !== 1 || !bundle.metadata?.title?.trim() || bundle.metadata.title.length > 120 || !Array.isArray(bundle.items) || !/^[0-9a-f]{64}$/i.test(bundle.integrity?.sha256 || "")) return false;
  return bundle.items.every(item => typeof item?.id === "string" && typeof item.name === "string" && typeof item.destination === "string" && !item.destination.startsWith("/") && !item.destination.split("/").includes(".."));
}

const baseName = path => path.split("/").at(-1).toLowerCase();
const extension = path => /\.[^.]+$/.exec(baseName(path))?.[0] || "";
async function embeddedContent(file) {
  if (file.encoding && file.encoding !== "gzip-base64") throw new Error("Unsupported file encoding");
  const bytes = Uint8Array.from(atob(file.content), character => character.charCodeAt(0));
  const stream = file.encoding === "gzip-base64" ? new Response(bytes).body.pipeThrough(new DecompressionStream("gzip")) : new Response(bytes).body;
  const content = new Uint8Array(await new Response(stream).arrayBuffer());
  if (content.byteLength > 256 * 1024) throw new Error("Embedded file exceeds 256 KB");
  return content;
}

// The full local validation happens before upload; this repeat check rejects malformed paths and records server review state.
async function review(bundle) {
  const blockers = [];
  if (!validBundle(bundle)) blockers.push("Invalid bundle format or destination");
  const { integrity, ...body } = bundle || {};
  if (validBundle(bundle) && await digest(canonicalJson(body)) !== integrity.sha256) blockers.push("Bundle integrity check failed");
  for (const item of bundle?.items || []) {
    if (item.kind === "mcp" && (!item.config || Object.values(item.config).some(server => Object.keys(server || {}).join() !== "command" || typeof server.command !== "string" || secretPattern.test(server.command)))) blockers.push(`${item.id}: unsafe MCP configuration`);
    for (const file of item.source?.kind === "embedded" ? item.source.files || [] : []) {
      const path = item.source.layout === "file" ? item.destination : `${item.destination}/${file.path}`;
      try {
        const content = await embeddedContent(file);
        const text = new TextDecoder("utf-8", { fatal: true }).decode(content);
        if (sensitiveName.test(baseName(path)) || !(portableExtensions.has(extension(path)) || ["agents", "claude", "readme", "license", "notice", "changelog", "dockerfile", "makefile"].includes(baseName(path)) || text.startsWith("#!")) || secretPattern.test(text)) blockers.push(`${item.id}: unsafe embedded file ${path}`);
      } catch { blockers.push(`${item.id}: unreadable embedded file ${path}`); }
    }
  }
  return { status: blockers.length ? "rejected" : "passed", checkedAt: new Date().toISOString(), blockers, warnings: [] };
}

async function userId(request, env) {
  const token = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
  if (!token || !env.SUPABASE_URL || !env.SUPABASE_PUBLISHABLE_KEY) return null;
  const response = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, { headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${token}` } });
  const user = response.ok ? await response.json() : null;
  return user?.id || null;
}

async function protectedRow(request, env, slug) {
  const row = await env.BUNDLES.prepare("SELECT slug, title, manifest, checksum, review, access, passcode_digest FROM bundles WHERE slug = ?").bind(slug).first();
  if (!row) return null;
  if (row.access === "private") {
    const supplied = request.headers.get("X-RigDrop-Passcode");
    if (!supplied || !constantTimeEqual(await passcodeDigest(supplied, env.PASSCODE_SECRET), row.passcode_digest)) return "private";
  }
  return { ...row, manifest: JSON.parse(row.manifest), review: JSON.parse(row.review) };
}

async function publish(request, env) {
  const ownerId = await userId(request, env);
  if (!ownerId) return error("Sign in first with: rigdrop login", 401);
  const body = await request.json().catch(() => ({}));
  const { bundle, access = "public", passcode } = body;
  if (!validBundle(bundle) || !["public", "private"].includes(access) || access === "private" && (typeof passcode !== "string" || passcode.length < 8) || access === "private" && !env.PASSCODE_SECRET) return error("Invalid bundle or sharing settings (private passcodes must be at least 8 characters)", 400);
  if (JSON.stringify(bundle).length > 4 * 1024 * 1024) return error("Bundle exceeds 4 MB", 413);
  const checked = await review(bundle);
  if (checked.status !== "passed") return json({ error: "Bundle failed the server review", review: checked }, 422);
  const recent = await env.BUNDLES.prepare("SELECT count(*) AS count FROM bundles WHERE owner_id = ? AND created_at > unixepoch() - 86400").bind(ownerId).first();
  if (recent.count >= 20) return error("Daily publishing limit reached (20 bundles in 24 hours)", 429);
  const slug = crypto.randomUUID().replaceAll("-", "");
  await env.BUNDLES.prepare("INSERT INTO bundles (slug, title, manifest, checksum, review, owner_id, access, passcode_digest) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(slug, bundle.metadata.title, JSON.stringify(bundle), bundle.integrity.sha256, JSON.stringify(checked), ownerId, access, access === "private" ? await passcodeDigest(passcode, env.PASSCODE_SECRET) : null).run();
  return json({ ...bundleUrls(origin(request), slug), access }, 201);
}

async function remove(request, env, slug) {
  const ownerId = await userId(request, env);
  if (!ownerId) return error("Sign in first with: rigdrop login", 401);
  const result = await env.BUNDLES.prepare("DELETE FROM bundles WHERE slug = ? AND owner_id = ?").bind(slug, ownerId).run();
  return result.meta.changes ? json({ deleted: slug }) : error("Bundle not found, or you do not own it", 404);
}

async function read(request, env, slug, format) {
  const row = await protectedRow(request, env, slug);
  if (!row) return new Response("Bundle not found", { status: 404 });
  if (row === "private") return error("This private bundle needs its passcode", 401);
  const headers = { "Cache-Control": row.access === "public" ? "public, max-age=60, s-maxage=300" : "private, no-store" };
  if (format === "json") return json(row.manifest, 200, headers);
  if (format === "review") return json(row.review, 200, headers);
  if (format === "markdown") return new Response(renderInstructions(row, origin(request)), { headers: { ...headers, "Content-Type": "text/markdown; charset=utf-8" } });
  return error("Use the RigDrop CLI to inspect or install this bundle", 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/auth-config") return env.SUPABASE_URL && env.SUPABASE_PUBLISHABLE_KEY ? json({ supabaseUrl: env.SUPABASE_URL, publishableKey: env.SUPABASE_PUBLISHABLE_KEY }, 200, { "Cache-Control": "public, max-age=300" }) : error("Sign-in is not configured", 503);
    if (url.pathname === "/api/health") return env.BUNDLES.prepare("SELECT 1").first().then(() => json({ status: "ok" }), () => json({ status: "error" }, 503));
    if (url.pathname === "/api/bundles") {
      if (request.method === "POST") return publish(request, env);
      if (request.method === "DELETE") return slugPattern.test(url.searchParams.get("id") || "") ? remove(request, env, url.searchParams.get("id")) : error("Invalid bundle ID", 400);
      return error("Method not allowed", 405);
    }
    const match = url.pathname.match(/^\/s\/([0-9a-f]{32})(?:\/(manifest\.json|review\.json|AGENT_SETUP\.md))?\/?$/i);
    if (match && request.method === "GET") return read(request, env, match[1], match[2] === "manifest.json" ? "json" : match[2] === "review.json" ? "review" : match[2] === "AGENT_SETUP.md" ? "markdown" : "html");
    return new Response("Not found", { status: 404 });
  }
};
