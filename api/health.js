export default async function handler(_request, response) {
  try {
    const database = await fetch(`${process.env.SUPABASE_URL}/rest/v1/bundles?select=slug&limit=1`, {
      headers: { apikey: process.env.SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_PUBLISHABLE_KEY}` }
    });
    if (!database.ok) throw new Error("database unavailable");
    return response.status(200).json({ status: "ok" });
  } catch {
    return response.status(503).json({ status: "error" });
  }
}
