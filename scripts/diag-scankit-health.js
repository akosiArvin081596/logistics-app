#!/usr/bin/env node
//
// diag-scankit-health.js — READ-ONLY ScanKit health probe.
//
// Logs in as a Super Admin and prints GET /api/scankit/health:
//   enabled / hasKey / baseUrl / lastScan / noCreditsSince / errorsLast24h / lastError
//
// This is a diagnostic, not a mutation. The ONLY write it performs is the auth
// login required to obtain a session cookie (same as test-suite.js); it makes
// no data writes and calls no mutating endpoint. Use it to confirm ScanKit is
// healthy and, after a credit top-up, that `noCreditsSince` has cleared.
// See docs/runbooks/scankit-billing.md.
//
// USAGE (against a RUNNING server — `npm start` or the live VPS via a tunnel):
//
//   node scripts/diag-scankit-health.js
//
// Defaults match test-suite.js: host localhost:3000, user admin / Password123!.
// Override via env when pointing at staging or using non-default creds:
//
//   DIAG_HOST=127.0.0.1 DIAG_PORT=3000 \
//   DIAG_USER=admin DIAG_PASS='your-password' \
//   node scripts/diag-scankit-health.js
//
// Exit codes:  0 = healthy   2 = reachable but degraded (no credits / disabled /
//              errors)        1 = could not reach server, login failed, or the
//              /api/scankit/health endpoint is not deployed on this server yet.

const http = require("http");

const HOST = process.env.DIAG_HOST || "localhost";
const PORT = parseInt(process.env.DIAG_PORT || "3000", 10);
const USER = process.env.DIAG_USER || "admin";
const PASS = process.env.DIAG_PASS || "Password123!";

// Mirrors test-suite.js's req() helper: JSON request, returns
// { status, body, cookies, headers }. Parses JSON when possible, else raw text.
function req(method, path, body, cookies) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: HOST,
      port: PORT,
      path,
      method,
      headers: { "Content-Type": "application/json" },
    };
    if (cookies) opts.headers.Cookie = cookies;
    const r = http.request(opts, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        const setCookie = (res.headers["set-cookie"] || []).map((c) => c.split(";")[0]).join("; ");
        try {
          resolve({ status: res.statusCode, body: JSON.parse(d), cookies: setCookie || cookies, headers: res.headers });
        } catch {
          resolve({ status: res.statusCode, body: d, cookies: setCookie || cookies, headers: res.headers });
        }
      });
    });
    r.on("error", reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

// Pretty value: null/undefined → "—", everything else stringified as-is.
function v(val) {
  if (val === null || val === undefined || val === "") return "—";
  return String(val);
}

(async () => {
  console.log(`=== ScanKit health diagnostic ===`);
  console.log(`Target: http://${HOST}:${PORT}  (user: ${USER})\n`);

  // 1. Log in (the only POST — required to authenticate the admin-only endpoint).
  let login;
  try {
    login = await req("POST", "/api/auth/login", { username: USER, password: PASS });
  } catch (err) {
    console.error(`Could not reach the server at http://${HOST}:${PORT} — is it running?`);
    console.error(`  (${err.code || err.message})`);
    process.exit(1);
  }
  if (login.status !== 200 || !(login.body && login.body.success)) {
    console.error(`Login failed (HTTP ${login.status}). Check DIAG_USER / DIAG_PASS.`);
    process.exit(1);
  }
  const cookies = login.cookies;
  if (!cookies) {
    console.error("Login returned no session cookie (Secure+SameSite may block over plain HTTP).");
    process.exit(1);
  }

  // 2. Fetch ScanKit health (READ-ONLY GET).
  const h = await req("GET", "/api/scankit/health", null, cookies);

  if (h.status === 404) {
    console.error("GET /api/scankit/health returned 404 — the endpoint is not deployed on this server yet.");
    process.exit(1);
  }
  if (h.status === 403) {
    console.error("GET /api/scankit/health returned 403 — the logged-in user is not a Super Admin.");
    process.exit(1);
  }
  if (h.status !== 200 || typeof h.body !== "object" || h.body === null) {
    console.error(`Unexpected response from /api/scankit/health: HTTP ${h.status}`);
    console.error(typeof h.body === "string" ? h.body.slice(0, 300) : JSON.stringify(h.body));
    process.exit(1);
  }

  const s = h.body;
  console.log("ScanKit health:");
  console.log(`  enabled        : ${v(s.enabled)}`);
  console.log(`  hasKey         : ${v(s.hasKey)}`);
  console.log(`  baseUrl        : ${v(s.baseUrl)}`);
  console.log(`  lastScan       : ${v(s.lastScan)}`);
  console.log(`  noCreditsSince : ${v(s.noCreditsSince)}`);
  console.log(`  errorsLast24h  : ${v(s.errorsLast24h)}`);
  console.log(`  lastError      : ${v(s.lastError)}`);

  // 3. Summarize. Degraded if disabled, keyless, out of credits, or erroring.
  const issues = [];
  if (s.enabled === false) issues.push("scanning DISABLED (SCANKIT_ENABLED=false) — endpoint returns 503; drivers attach raw photos");
  if (s.hasKey === false) issues.push("no API key configured (SCANKIT_API_KEY unset)");
  if (s.noCreditsSince) issues.push(`OUT OF CREDITS since ${s.noCreditsSince} — scans fall back to raw photos (top up: docs/runbooks/scankit-billing.md)`);
  if (Number(s.errorsLast24h) > 0) issues.push(`${s.errorsLast24h} error(s) in last 24h${s.lastError ? ` (last: ${s.lastError})` : ""}`);

  console.log("");
  if (issues.length === 0) {
    console.log("Status: HEALTHY — ScanKit enabled, keyed, and not out of credits.");
    process.exit(0);
  }
  console.log("Status: DEGRADED");
  issues.forEach((i) => console.log(`  - ${i}`));
  process.exit(2);
})();
