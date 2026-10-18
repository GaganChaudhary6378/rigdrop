// Public values only: the CLI needs them to start Google sign-in through Supabase Auth.
export default function handler(_request, response) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_PUBLISHABLE_KEY) return response.status(503).json({ error: "Sign-in is not configured" });
  response.setHeader("Cache-Control", "public, max-age=300");
  return response.status(200).json({ supabaseUrl: process.env.SUPABASE_URL, publishableKey: process.env.SUPABASE_PUBLISHABLE_KEY });
}
