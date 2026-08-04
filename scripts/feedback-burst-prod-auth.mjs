#!/usr/bin/env node

/**
 * Mint and rotate a production Clerk session JWT that carries `azp` for
 * `authorizedParties` (WEB_ORIGIN). Backend API `/sessions/{id}/tokens` JWTs
 * omit `azp` and the production API rejects them with 401 — the Frontend API
 * path below is the one that works for a long `pnpm feedback:burst` run.
 *
 * Secrets never print: CLERK secret from a file, JWT written atomically to
 * TOKEN_FILE, logs carry lengths and session ids only.
 *
 * Typical production rehearsal:
 *
 *   # once, after tunnels + ~/.jts-burst-env exist
 *   CLERK_SECRET_FILE=~/.jts-clerk-secret \
 *   TOKEN_FILE=~/.jts-burst-token \
 *   SESSION_FILE=~/.jts-burst-session-id \
 *   COOKIE_FILE=~/.jts-burst-fapi-cookie \
 *   node scripts/feedback-burst-prod-auth.mjs --mint
 *
 *   # keep rotating in a dedicated terminal for the whole rehearsal
 *   CLERK_SECRET_FILE=~/.jts-clerk-secret \
 *   TOKEN_FILE=~/.jts-burst-token \
 *   SESSION_FILE=~/.jts-burst-session-id \
 *   COOKIE_FILE=~/.jts-burst-fapi-cookie \
 *   INTERVAL_MS=15000 \
 *   node scripts/feedback-burst-prod-auth.mjs
 *
 *   # after the run
 *   … node scripts/feedback-burst-prod-auth.mjs --revoke
 */

import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";

const BAPI = "https://api.clerk.com/v1";
const FAPI = "https://clerk.example.com/v1";
const ORIGIN = "https://slopform.example.com";

const args = new Set(process.argv.slice(2));
const mintOnly = args.has("--mint");
const revokeOnly = args.has("--revoke");
const help = args.has("--help") || args.has("-h");

if (help) {
  printUsage();
  process.exit(0);
}

const secretFile = requiredEnv("CLERK_SECRET_FILE");
const tokenFile = requiredEnv("TOKEN_FILE");
const sessionFile = requiredEnv("SESSION_FILE");
const cookieFile = requiredEnv("COOKIE_FILE");
const intervalMs = Number(process.env.INTERVAL_MS ?? 15_000);
const preferredUserPrefix = process.env.CLERK_USER_ID_PREFIX ?? "user_";

const secret = readFileSync(secretFile, "utf8").trim();
if (!secret) {
  fail("CLERK_SECRET_FILE is empty");
}

if (revokeOnly) {
  await revokeEphemeralSessions();
  process.exit(0);
}

if (mintOnly) {
  await mint();
  process.exit(0);
}

if (!existsSync(sessionFile) || !existsSync(cookieFile)) {
  fail(
    "SESSION_FILE and COOKIE_FILE are required for refresh; run --mint first",
  );
}

let failures = 0;
while (true) {
  try {
    await rotate();
    failures = 0;
  } catch (error) {
    failures += 1;
    console.error(
      `rotate failed (${failures}): ${error instanceof Error ? error.message : String(error)}`,
    );
    if (failures >= 10) {
      fail("giving up after 10 consecutive failures");
    }
  }
  await sleep(intervalMs);
}

async function mint() {
  const users = await bapi("/users?limit=10");
  const userList = Array.isArray(users) ? users : (users?.data ?? []);
  if (userList.length === 0) {
    fail("no Clerk users in this instance");
  }
  const preferred =
    userList.find((user) => String(user.id).startsWith(preferredUserPrefix)) ??
    userList[0];

  const ticket = await bapi("/sign_in_tokens", {
    method: "POST",
    body: JSON.stringify({
      user_id: preferred.id,
      expires_in_seconds: 300,
    }),
  });
  if (!ticket?.token) {
    fail("sign_in_tokens response had no token");
  }

  let cookie = "";
  const clientRes = await fetch(`${FAPI}/client`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  cookie = mergeCookies(cookie, clientRes);
  if (!clientRes.ok) {
    fail(`FAPI /client -> ${clientRes.status}`);
  }

  const signInRes = await fetch(`${FAPI}/client/sign_ins`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie,
    },
    body: new URLSearchParams({
      strategy: "ticket",
      ticket: ticket.token,
    }).toString(),
  });
  cookie = mergeCookies(cookie, signInRes);
  const signInBody = await signInRes.json().catch(() => null);
  const sessionId = signInBody?.response?.created_session_id;
  if (!signInRes.ok || !sessionId) {
    fail(
      `FAPI sign_ins -> ${signInRes.status} ${JSON.stringify(signInBody)?.slice(0, 200)}`,
    );
  }

  const touchRes = await fetch(`${FAPI}/client/sessions/${sessionId}/touch`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie,
      Origin: ORIGIN,
      Referer: `${ORIGIN}/`,
    },
    body: "",
  });
  cookie = mergeCookies(cookie, touchRes);

  writeFileSync(sessionFile, sessionId, { mode: 0o600 });
  writeFileSync(cookieFile, cookie, { mode: 0o600 });
  const jwt = await fetchSessionJwt(sessionId, cookie);
  await assertAuthorized(jwt);
  writeTokenAtomically(jwt);
  console.error(
    `minted session ${sessionId} (user ${String(preferred.id).slice(0, 16)}…, jwt length ${jwt.length})`,
  );
}

async function rotate() {
  let cookie = readFileSync(cookieFile, "utf8").trim();
  const sessionId = readFileSync(sessionFile, "utf8").trim();
  if (!cookie || !sessionId) {
    fail("COOKIE_FILE or SESSION_FILE is empty; re-run --mint");
  }
  const jwt = await fetchSessionJwt(sessionId, cookie, (nextCookie) => {
    cookie = nextCookie;
  });
  writeFileSync(cookieFile, cookie, { mode: 0o600 });
  await assertAuthorized(jwt);
  writeTokenAtomically(jwt);
  console.error(`rotated at ${new Date().toISOString()} (len ${jwt.length})`);
}

async function fetchSessionJwt(sessionId, cookie, onCookie) {
  const tokenRes = await fetch(`${FAPI}/client/sessions/${sessionId}/tokens`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie,
      Origin: ORIGIN,
      Referer: `${ORIGIN}/`,
    },
    body: "",
  });
  const nextCookie = mergeCookies(cookie, tokenRes);
  onCookie?.(nextCookie);
  const body = await tokenRes.json().catch(() => null);
  if (!tokenRes.ok) {
    throw new Error(
      `FAPI tokens -> ${tokenRes.status} ${JSON.stringify(body)?.slice(0, 200)}`,
    );
  }
  const jwt = body?.jwt ?? body?.response?.jwt;
  if (!jwt) {
    throw new Error("FAPI token response had no jwt");
  }
  const payload = JSON.parse(
    Buffer.from(jwt.split(".")[1], "base64url").toString(),
  );
  if (payload.azp !== ORIGIN) {
    throw new Error(
      `minted JWT missing azp=${ORIGIN} (got ${String(payload.azp)}); production will 401`,
    );
  }
  return jwt;
}

async function assertAuthorized(jwt) {
  const probe = await fetch(`${ORIGIN}/api/v1/auth/session`, {
    headers: { authorization: `Bearer ${jwt}` },
  });
  if (probe.status !== 200) {
    throw new Error(`auth/session probe -> ${probe.status}`);
  }
}

async function revokeEphemeralSessions() {
  const users = await bapi("/users?limit=10");
  const userList = Array.isArray(users) ? users : (users?.data ?? []);
  const preferred =
    userList.find((user) => String(user.id).startsWith(preferredUserPrefix)) ??
    userList[0];
  if (!preferred) {
    fail("no Clerk users to revoke");
  }

  const cutoff = Date.now() - 4 * 60 * 60 * 1000;
  const sessions = await bapi(
    `/sessions?user_id=${encodeURIComponent(preferred.id)}&status=active&limit=20`,
  );
  const list = Array.isArray(sessions) ? sessions : (sessions?.data ?? []);
  let revoked = 0;
  for (const session of list) {
    if ((session.created_at ?? 0) < cutoff) {
      continue;
    }
    const result = await bapi(`/sessions/${session.id}/revoke`, {
      method: "POST",
      body: "{}",
    });
    console.error(
      `revoked ${session.id} created ${new Date(session.created_at).toISOString()} (${result?.id ? "ok" : "done"})`,
    );
    revoked += 1;
  }
  if (existsSync(sessionFile)) {
    const pinned = readFileSync(sessionFile, "utf8").trim();
    if (pinned && !list.some((session) => session.id === pinned)) {
      await bapi(`/sessions/${pinned}/revoke`, {
        method: "POST",
        body: "{}",
      }).catch(() => undefined);
      console.error(`revoked pinned ${pinned}`);
      revoked += 1;
    }
  }
  console.error(`revoked ${revoked} session(s)`);
}

async function bapi(path, init = {}) {
  const res = await fetch(BAPI + path, {
    ...init,
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
      ...init.headers,
    },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const detail =
      body?.errors?.[0]?.message ??
      JSON.stringify(body)?.slice(0, 200) ??
      res.statusText;
    throw new Error(
      `BAPI ${init.method ?? "GET"} ${path} -> ${res.status} ${detail}`,
    );
  }
  return body;
}

function mergeCookies(existing, response) {
  const jar = new Map(
    existing
      .split("; ")
      .filter(Boolean)
      .map((chunk) => {
        const index = chunk.indexOf("=");
        return [chunk.slice(0, index), chunk.slice(index + 1)];
      }),
  );
  for (const raw of response.headers.getSetCookie?.() ?? []) {
    const part = raw.split(";")[0];
    const index = part.indexOf("=");
    jar.set(part.slice(0, index), part.slice(index + 1));
  }
  return [...jar.entries()].map(([key, value]) => `${key}=${value}`).join("; ");
}

function writeTokenAtomically(jwt) {
  const tmp = `${tokenFile}.tmp`;
  writeFileSync(tmp, jwt, { mode: 0o600 });
  renameSync(tmp, tokenFile);
}

function requiredEnv(name) {
  const value = String(process.env[name] ?? "").trim();
  if (!value) {
    fail(`${name} is required`);
  }
  return value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function printUsage() {
  console.log(`Usage:
  node scripts/feedback-burst-prod-auth.mjs --mint
  node scripts/feedback-burst-prod-auth.mjs
  node scripts/feedback-burst-prod-auth.mjs --revoke

Environment:
  CLERK_SECRET_FILE   Clerk secret key file (from production secrets)
  TOKEN_FILE          Atomic JWT destination read by CLERK_BEARER_TOKEN_FILE
  SESSION_FILE        Durable FAPI session id
  COOKIE_FILE         Durable FAPI client cookies
  INTERVAL_MS         Refresh period (default 15000)
  CLERK_USER_ID_PREFIX  Optional preferred operator user id prefix

Backend API session tokens omit azp and fail production authorizedParties.
This script mints via Clerk Frontend API ticket sign-in with Origin set to
${ORIGIN}, then rotates the same session for the duration of the burst.`);
}
