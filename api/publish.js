import { timingSafeEqual } from "node:crypto";
import { validate } from "../src/core.js";
import { bundleUrls } from "../src/hosted.js";

const same = (given = "", expected = "") => {
  const left = Buffer.from(given);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
};

export default async function handler(request, response) {
  if (request.method !== "POST") return response.status(405).json({ error: "Method not allowed" });
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, "") || "";
  if (!process.env.PUBLISH_TOKEN || !same(token, process.env.PUBLISH_TOKEN)) return response.status(401).json({ error: "Invalid publishing token" });
  try {
    const bundle = validate(typeof request.body === "string" ? JSON.parse(request.body) : request.body);
    if (Buffer.byteLength(JSON.stringify(bundle)) > 4 * 1024 * 1024) return response.status(413).json({ error: "Bundle exceeds 4 MB" });
    const database = await fetch(`${process.env.SUPABASE_URL}/rest/v1/bundles`, {
      method: "POST",
      headers: {
        apikey: process.env.SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_PUBLISHABLE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
        "x-agent-setup-key": process.env.PUBLISH_TOKEN
      },
      body: JSON.stringify({ title: bundle.metadata.title, manifest: bundle, checksum: bundle.integrity.sha256 })
    });
    if (!database.ok) throw new Error(`Storage rejected the bundle (${database.status})`);
    const [row] = await database.json();
    const origin = `https://${request.headers["x-forwarded-host"] || request.headers.host}`;
    return response.status(201).json(bundleUrls(origin, row.slug));
  } catch (error) {
    return response.status(400).json({ error: error.message });
  }
}
