import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_REGISTRY = process.env.AGENT_SETUP_REGISTRY_URL || "https://agent-setup-link.vercel.app";
// Fixed so the Supabase redirect allow list can name it exactly.
export const LOGIN_PORT = 53682;
const LOGIN_TIMEOUT = 5 * 60 * 1000;
const trimSlash = url => url.replace(/\/$/, "");
const sessionPath = home => join(home, ".rigdrop", "session.json");

function openBrowser(url) {
  const [command, args] = process.platform === "darwin" ? ["open", [url]]
    : process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
      : ["xdg-open", [url]];
  execFile(command, args, () => {});
}

async function authConfig(registry) {
  const response = await fetch(`${registry}/api/auth-config`);
  if (!response.ok) throw new Error(`Registry sign-in is unavailable (${response.status})`);
  const config = await response.json();
  if (!/^https:\/\//.test(config.supabaseUrl || "") && !/^http:\/\/127\.0\.0\.1/.test(config.supabaseUrl || "")) throw new Error("Registry returned an invalid sign-in configuration");
  return config;
}

async function tokenRequest(config, grant, body) {
  const response = await fetch(`${config.supabaseUrl}/auth/v1/token?grant_type=${grant}`, {
    method: "POST",
    headers: { apikey: config.publishableKey, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error_description || data.msg || `Sign-in failed (${response.status})`);
  return data;
}

async function saveSession(home, registry, config, tokens, email) {
  const session = {
    registry,
    supabaseUrl: config.supabaseUrl,
    publishableKey: config.publishableKey,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: tokens.expires_at || Math.floor(Date.now() / 1000) + tokens.expires_in,
    email: tokens.user?.email || email
  };
  const path = sessionPath(home);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return session;
}

function waitForCode(redirect, url, open, log) {
  return new Promise((resolveCode, reject) => {
    let timer;
    const server = createServer((request, response) => {
      const callback = new URL(request.url, redirect);
      if (callback.pathname !== "/callback") return response.writeHead(404).end();
      const code = callback.searchParams.get("code");
      response.writeHead(code ? 200 : 400, { "Content-Type": "text/html; charset=utf-8", Connection: "close" })
        .end(`<!doctype html><title>RigDrop</title><p>RigDrop sign-in ${code ? "is complete" : "failed"}. Return to the terminal.</p>`);
      clearTimeout(timer);
      server.close();
      if (code) resolveCode(code);
      else reject(new Error(callback.searchParams.get("error_description") || "Sign-in was cancelled"));
    });
    timer = setTimeout(() => {
      server.close();
      reject(new Error("Sign-in timed out"));
    }, LOGIN_TIMEOUT);
    server.on("error", error => {
      clearTimeout(timer);
      reject(error.code === "EADDRINUSE" ? new Error(`Port ${LOGIN_PORT} is in use. Close the program that uses it, then try again.`) : error);
    });
    server.listen(LOGIN_PORT, "127.0.0.1", () => {
      log(`Opening the browser for Google sign-in. If it does not open, visit:\n${url}`);
      open(url);
    });
  });
}

export async function login({ registry = DEFAULT_REGISTRY, home = homedir(), open = openBrowser, log = console.log } = {}) {
  registry = trimSlash(registry);
  const config = await authConfig(registry);
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const redirect = `http://127.0.0.1:${LOGIN_PORT}/callback`;
  const url = `${config.supabaseUrl}/auth/v1/authorize?${new URLSearchParams({ provider: "google", redirect_to: redirect, code_challenge: challenge, code_challenge_method: "s256" })}`;
  const code = await waitForCode(redirect, url, open, log);
  return saveSession(home, registry, config, await tokenRequest(config, "pkce", { auth_code: code, code_verifier: verifier }));
}

export async function readSession(home = homedir()) {
  try {
    return JSON.parse(await readFile(sessionPath(home), "utf8"));
  } catch {
    return null;
  }
}

// Returns a session with an access token valid for at least one more minute.
export async function currentSession({ registry, home = homedir() } = {}) {
  const session = await readSession(home);
  if (!session) throw new Error("Run rigdrop login first");
  if (registry && trimSlash(registry) !== session.registry) throw new Error(`Run rigdrop login --registry ${registry} first`);
  if (session.expiresAt - 60 > Date.now() / 1000) return session;
  try {
    return await saveSession(home, session.registry, session, await tokenRequest(session, "refresh_token", { refresh_token: session.refreshToken }), session.email);
  } catch {
    throw new Error("Session expired. Run rigdrop login again");
  }
}

export async function logout({ home = homedir() } = {}) {
  const session = await readSession(home);
  if (!session) return false;
  await fetch(`${session.supabaseUrl}/auth/v1/logout`, {
    method: "POST",
    headers: { apikey: session.publishableKey, Authorization: `Bearer ${session.accessToken}` }
  }).catch(() => {});
  await rm(sessionPath(home), { force: true });
  return true;
}
