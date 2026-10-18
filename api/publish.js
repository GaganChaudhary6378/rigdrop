import { reviewBundle, validate } from "../src/core.js";
import { bundleUrls } from "../src/hosted.js";

const bearer = request => request.headers.authorization?.replace(/^Bearer\s+/i, "") || "";

// Supabase Auth checks the user's access token and returns the user it belongs to.
async function currentUser(token) {
  if (!token) return null;
  const response = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: process.env.SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${token}` }
  });
  return response.ok ? response.json() : null;
}

async function create(request, response) {
  const user = await currentUser(bearer(request));
  if (!user?.id) return response.status(401).json({ error: "Sign in first with: rigdrop login" });
  const bundle = validate(typeof request.body === "string" ? JSON.parse(request.body) : request.body);
  if (Buffer.byteLength(JSON.stringify(bundle)) > 4 * 1024 * 1024) return response.status(413).json({ error: "Bundle exceeds 4 MB" });
  const review = reviewBundle(bundle);
  if (review.status !== "passed") return response.status(422).json({ error: "Bundle failed the server review", review });
  // Inserts use the secret key so that every stored bundle has passed this review.
  const database = await fetch(`${process.env.SUPABASE_URL}/rest/v1/bundles?select=slug`, {
    method: "POST",
    headers: { apikey: process.env.SUPABASE_SECRET_KEY, "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify({ title: bundle.metadata.title, manifest: bundle, checksum: bundle.integrity.sha256, review, owner_id: user.id })
  });
  if (!database.ok) {
    const detail = await database.json().catch(() => ({}));
    if (/Daily publishing limit/.test(detail.message || "")) return response.status(429).json({ error: detail.message });
    throw new Error(`Storage rejected the bundle (${database.status})`);
  }
  const [row] = await database.json();
  const origin = `https://${request.headers["x-forwarded-host"] || request.headers.host}`;
  return response.status(201).json(bundleUrls(origin, row.slug));
}

async function remove(request, response) {
  const token = bearer(request);
  if (!token) return response.status(401).json({ error: "Sign in first with: rigdrop login" });
  const slug = String(request.query.id || "");
  if (!/^[0-9a-f]{32}$/.test(slug)) return response.status(400).json({ error: "Invalid bundle ID" });
  // The user's own token is forwarded, so the owner-only RLS policy decides.
  const database = await fetch(`${process.env.SUPABASE_URL}/rest/v1/bundles?slug=eq.${slug}&select=slug`, {
    method: "DELETE",
    headers: { apikey: process.env.SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${token}`, Prefer: "return=representation" }
  });
  if (database.status === 401) return response.status(401).json({ error: "Session expired. Run rigdrop login again" });
  if (!database.ok) throw new Error(`Storage rejected the deletion (${database.status})`);
  const rows = await database.json();
  if (!rows.length) return response.status(404).json({ error: "Bundle not found, or you do not own it" });
  return response.status(200).json({ deleted: slug });
}

export default async function handler(request, response) {
  try {
    if (request.method === "POST") return await create(request, response);
    if (request.method === "DELETE") return await remove(request, response);
    return response.status(405).json({ error: "Method not allowed" });
  } catch (error) {
    return response.status(400).json({ error: error.message });
  }
}
