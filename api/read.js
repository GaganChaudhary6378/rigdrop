import { renderBundlePage, renderInstructions } from "../src/hosted.js";

export default async function handler(request, response) {
  if (request.method !== "GET") return response.status(405).send("Method not allowed");
  const slug = String(request.query.id || "");
  if (!/^[0-9a-f]{32}$/.test(slug)) return response.status(400).send("Invalid bundle ID");
  const database = await fetch(`${process.env.SUPABASE_URL}/rest/v1/bundles?slug=eq.${slug}&select=slug,title,manifest,checksum,created_at`, {
    headers: { apikey: process.env.SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_PUBLISHABLE_KEY}` }
  });
  if (!database.ok) return response.status(502).send("Bundle storage is unavailable");
  const [row] = await database.json();
  if (!row) return response.status(404).send("Bundle not found");
  const origin = `https://${request.headers["x-forwarded-host"] || request.headers.host}`;
  response.setHeader("Cache-Control", "public, max-age=60, s-maxage=300");
  if (request.query.format === "json") return response.status(200).json(row.manifest);
  if (request.query.format === "markdown") {
    response.setHeader("Content-Type", "text/markdown; charset=utf-8");
    return response.status(200).send(renderInstructions(row, origin));
  }
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  return response.status(200).send(renderBundlePage(row, origin));
}
