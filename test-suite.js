const http = require("http");
const fs = require("fs");
const path = require("path");
// Used ONLY by the period_locks fault block (137-139), which boots its own
// throwaway server: net to claim a free port from the OS, os for a scratch
// directory, spawn to run server.js. Nothing else in this file starts a process.
const net = require("net");
const os = require("os");
const { spawn } = require("child_process");

// Target port. Defaults to 3000 (local dev), but MUST be overridable: on the
// VPS 3000 is PRODUCTION and this suite writes (it logs an expense in test 46).
// Run against staging with TEST_PORT=3003.
const PORT = Number(process.env.TEST_PORT) || 3000;

// lib/broker-invoice.js is pure (no network, no DB), so tests 82-90 exercise it
// directly — the only assertions here that need neither a server nor fixture
// data. Required defensively: the module is loaded at suite start, and a hard
// require() failure would take out all 90+ HTTP tests over a rename.
let brokerInvoice = null;
try {
	brokerInvoice = require("./lib/broker-invoice");
} catch {
	brokerInvoice = null;
}

// lib/linxup-push.js is likewise pure (Linxup Push-API message-shape mapping,
// no network/DB), so the Linxup unit assertions (92-99) exercise it directly —
// the highest-value coverage in this file since they need no server. Loaded
// defensively for the same reason as broker-invoice: a rename must not take out
// the HTTP suite; the unit block skips wholesale if it fails to load.
let linxupPush = null;
try {
	linxupPush = require("./lib/linxup-push");
} catch {
	linxupPush = null;
}

// lib/csv.js is the pure escaper the CSV exports share. Tests 135-136 exercise
// it directly, because the formula-injection guard is the one property of the
// completed-loads export that seeded data cannot be relied on to reach: test 127
// (the end-to-end check) honestly SKIPS when no exported cell happens to begin
// with a dangerous character, and a security guard that is only tested when the
// data feels like it is not tested at all. Loaded defensively like the two above.
let csvLib = null;
try {
	csvLib = require("./lib/csv");
} catch {
	csvLib = null;
}

// The app's own SQLite driver. Tests 137-139 need it to seed and then BREAK a
// throwaway database out-of-band — the fault they reproduce is a schema fault,
// and there is no HTTP surface that can inflict one. Loaded defensively like the
// three above: this is a native module, and a failed rebuild after a Node upgrade
// must skip one block rather than take out the whole suite.
let sqliteDriver = null;
try {
	sqliteDriver = require("better-sqlite3");
} catch {
	sqliteDriver = null;
}

// Optional directory of REAL rate-con PDFs (they contain broker pricing, so
// they are deliberately NOT committed). Point at a local folder to run the
// fixture-backed extraction tests 91-92; unset, they skip.
//   RATECON_FIXTURE_DIR=/path/to/ratecons node test-suite.js
const RATECON_FIXTURE_DIR = process.env.RATECON_FIXTURE_DIR || "";

// Tests that CREATE a load in the Job Tracking sheet. Off by default — this
// suite is meant to be safe to run against a shared staging environment, and a
// half-cleaned test load in a dispatch board is worse than a missing test.
//   RUN_WRITE_TESTS=1 node test-suite.js
const RUN_WRITE_TESTS = process.env.RUN_WRITE_TESTS === "1";

// A minimal but structurally valid PDF, base64 — a few hundred bytes.
//
// Module scope because TWO unrelated guards need a real PDF, and they must not
// drift apart:
//   - /api/loads/ratecon/extract checks the "JVBERi" prefix of the base64 STRING
//     before decoding, to keep a non-PDF from reaching (and billing) Gemini.
//     Tests 63/64/71/73 ride its accept-path; test 66 is the matching refusal.
//   - /api/chat/attachment DECODES and requires the bytes to start with "%PDF-"
//     (verifyInlineServedBytes, added by PR #189), because /uploads serves .pdf
//     inline. Tests 24 / 24b.
// "JVBERi0xLjQK" decodes to "%PDF-1.4\n", so this one fixture satisfies both.
const tinyPdfB64 =
  "JVBERi0xLjQKMSAwIG9iajw8L1R5cGUvQ2F0YWxvZy9QYWdlcyAyIDAgUj4+ZW5kb2JqCjIgMCBvYmo8PC9UeXBlL1BhZ2VzL0tpZHNbMyAwIFJdL0NvdW50IDE+PmVuZG9iagozIDAgb2JqPDwvVHlwZS9QYWdlL1BhcmVudCAyIDAgUi9NZWRpYUJveFswIDAgMjAwIDIwMF0+PmVuZG9iagp0cmFpbGVyPDwvUm9vdCAxIDAgUj4+CiUlRU9GCg==";

// Accounts the suite logs in with. No seed script in this repo creates
// "admin"/"max.range.inv.llc." — they only exist in whichever local DB the
// suite was first written against, which makes the whole harness unrunnable
// anywhere else. Defaults preserve the original local behaviour; override to
// run against staging.
const ADMIN_USER = process.env.TEST_ADMIN_USER || "admin";
const ADMIN_PASS = process.env.TEST_ADMIN_PASS || "Password123!";
const INVESTOR_USER = process.env.TEST_INVESTOR_USER || "max.range.inv.llc.";
const INVESTOR_PASS = process.env.TEST_INVESTOR_PASS || "Password123!";

// `port` is optional and defaults to the suite's target server. It exists for
// tests 137-139, which drive a second, throwaway server they start themselves;
// every other call site is unchanged and still hits PORT.
function req(method, path, body, cookies, port) {
  return new Promise((resolve, reject) => {
    // X-Requested-With mirrors what the SPA sends on every request: the server
    // refuses a session-gated write without it (the same-site CSRF control in
    // requireAuth/requireRole). Without this line every write test 403s.
    const opts = { hostname: "localhost", port: port || PORT, path, method, headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" } };
    if (cookies) opts.headers.Cookie = cookies;
    const r = http.request(opts, res => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => {
        const setCookie = (res.headers["set-cookie"] || []).map(c => c.split(";")[0]).join("; ");
        try { resolve({ status: res.statusCode, body: JSON.parse(d), cookies: setCookie || cookies, headers: res.headers }); }
        catch { resolve({ status: res.statusCode, body: d, cookies: setCookie || cookies, headers: res.headers }); }
      });
    });
    r.on("error", reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

const results = [];
// `detail` is optional and is printed ONLY when the assertion fails. A boolean
// is enough to know something broke and never enough to know what; for the
// arithmetic identities in particular ("the ledger does not reconcile") the
// gap, and which month opened it, is the whole diagnosis. Tests that report
// nothing are the ones people learn to skip. Build it lazily where it costs
// anything — pass a function and it is only called on failure.
function test(name, pass, detail) { results.push({ name, pass, detail }); }
// Some payout guards need a specific row shape (a $0 period, a payable period)
// that seeded data may not contain. Mark those SKIP rather than passing them
// vacuously — a green run that silently never exercised the guard is how the
// regressions these tests exist for got shipped in the first place.
function skip(name, why) { results.push({ name, pass: true, skipped: why }); }

(async () => {
  // Numbered up to 121, but many guards fan out into several test()/skip() calls,
  // so the real total is whatever `results` ends up holding — printed at the end.
  console.log("=== RUNNING TESTS against localhost:" + PORT + " ===\n");

  // 1. Server health
  const health = await req("GET", "/api/auth/setup-check");
  test("1. Server is running", health.status === 200);

  // 2. Super Admin login
  const adminLogin = await req("POST", "/api/auth/login", { username: ADMIN_USER, password: ADMIN_PASS });
  test("2. Super Admin login (" + ADMIN_USER + ")", adminLogin.status === 200 && adminLogin.body.success);
  const ac = adminLogin.cookies;
  if (!ac) { console.log("WARN: No cookies returned. Secure+SameSite blocks test cookies."); }

  // 3. Investor login
  const invLogin = await req("POST", "/api/auth/login", { username: INVESTOR_USER, password: INVESTOR_PASS });
  test("3. Investor login (" + INVESTOR_USER + ")", invLogin.status === 200 && invLogin.body.success);
  const ic = invLogin.cookies;

  // 4. Debug endpoints blocked without auth
  const d1 = await req("GET", "/api/debug/user/admin");
  test("4. Debug blocked without auth", d1.status === 401);

  // 5. Debug endpoints work for Super Admin. Look up the account we actually
  //     logged in as — hardcoding "admin" 404s anywhere that user doesn't exist.
  const d2 = await req("GET", "/api/debug/user/" + encodeURIComponent(ADMIN_USER), null, ac);
  test("5. Debug works for Super Admin", d2.status === 200);

  // 6. Webhook blocked without secret
  const w1 = await req("POST", "/api/webhook/new-load", {});
  test("6. Webhook blocked without secret", w1.status === 401);

  // 7. n8n job blocked without secret
  const n1 = await req("POST", "/api/n8n/job", { load_id: "test" });
  test("7. n8n job blocked without secret", n1.status === 401);

  // 8. Dashboard API
  const dash = await req("GET", "/api/dashboard", null, ac);
  test("8. Dashboard API loads", dash.status === 200 && dash.body.kpis);

  // 9. Investor API
  const inv = await req("GET", "/api/investor", null, ac);
  test("9. Investor API loads", inv.status === 200 && inv.body.production);

  // 10. Monthly earnings array
  test("10. monthlyEarnings array present", Array.isArray(inv.body?.production?.monthlyEarnings));

  // 11. Per-truck data
  test("11. perTruckData present", typeof inv.body?.production?.perTruckData === "object");

  // 12. Driver pay dates stripped
  const dpd = inv.body?.production?.driverPayDetails || {};
  const fd = Object.values(dpd)[0];
  test("12. driverPayDetails dates stripped", fd ? !fd.dates : true);

  // 13. Earnings to date has ONE definition. `investorEarnings` used to sit
  //     alongside it computed off a different expense basis, disagreeing by $165
  //     on live data. investorNetToDate is authoritative — the payout ledger,
  //     EarningsSection and driver pay all settle on it — so assert both that
  //     the rival is gone and that the survivor equals its own components,
  //     rather than the old vacuous typeof check.
  const p13 = inv.body?.production || {};
  const sum13 = (p13.monthlyEarnings || []).reduce((s, m) => s + (m.investorEarnings || 0), 0);
  test("13. investorNetToDate === sum(monthlyEarnings), with no rival field",
    typeof p13.investorNetToDate === "number" &&
    !("investorEarnings" in p13) &&
    Math.round(sum13) === Math.round(p13.investorNetToDate));

  // 14. paidRevenue removed
  test("14. paidRevenue removed from response", inv.body?.production?.paidRevenue === undefined);

  // 15. Trucks API
  const tr = await req("GET", "/api/trucks", null, ac);
  test("15. Trucks API loads", tr.status === 200 && Array.isArray(tr.body?.trucks));

  // 16. Users API
  const us = await req("GET", "/api/users", null, ac);
  test("16. Users API loads", us.status === 200 && Array.isArray(us.body?.users));

  // 17. Drivers directory
  const dr = await req("GET", "/api/drivers-directory", null, ac);
  test("17. Drivers directory loads", dr.status === 200);

  // 18. Invoices API
  const iv = await req("GET", "/api/invoices", null, ac);
  test("18. Invoices API loads", iv.status === 200);

  // 19. Applications API
  const ap = await req("GET", "/api/applications", null, ac);
  test("19. Applications API loads", ap.status === 200);

  // 20. Investor report PDF
  const rp = await req("GET", "/api/investor/report", null, ac);
  test("20. Investor report generates", rp.status === 200);

  // 21. Maps key accessible
  const mk = await req("GET", "/api/config/maps-key");
  test("21. Maps key endpoint works", mk.status === 200 && mk.body?.key);

  // 22. Investor blocked from expenses
  const ie = await req("POST", "/api/expenses", { driver: "test", type: "Fuel", amount: 10, date: "2026-04-11" }, ic);
  test("22. Investor blocked from expenses", ie.status === 403);

  // 23. Bad file extension rejected. The payload is irrelevant here — ".php" is
  //     refused by validateFileExt() before anything decodes the bytes — so the
  //     throwaway "dGVzdA==" ("test") is exactly right for THIS test.
  const bf = await req("POST", "/api/chat/attachment", { fileData: "dGVzdA==", fileName: "hack.php" }, ac);
  test("23. Bad file extension rejected", bf.status === 400);

  // 24. Good file extension accepted — the allow-list ADMITS a permitted type.
  //     The payload must therefore be a genuine PDF. It used to be "dGVzdA==",
  //     i.e. the four bytes "test" named doc.pdf; once PR #189 added the byte
  //     check (verifyInlineServedBytes: a .pdf must really start with "%PDF-")
  //     the server started refusing it — correctly, since that is precisely the
  //     lying-extension upload the check exists to stop. The test then failed
  //     while reading like an allow-list regression, which is the worst kind of
  //     stale fixture: it reports the wrong component. Send real PDF bytes so
  //     this asserts the extension gate and not the byte gate.
  const gf = await req("POST", "/api/chat/attachment", { fileData: tinyPdfB64, fileName: "doc.pdf" }, ac);
  test("24. Good file extension accepted", gf.status === 200);

  // 24b. The inverse, and the behaviour PR #189 actually added: an allow-listed
  //      extension whose BYTES lie. /uploads serves .pdf inline, so "not a PDF,
  //      named .pdf" is the case the byte check exists for, and nothing else in
  //      this harness covers it. Test 66 also asserts a magic-prefix refusal, but
  //      on /api/loads/ratecon/extract — a different function on a different
  //      route, inspecting the base64 STRING to protect Gemini spend and never
  //      writing to the inline-served tree. Distinct guard, so not a duplicate.
  //      Keeping 24 and 24b adjacent is the point: together they show the two
  //      gates are independent, so a future failure names the right one.
  const gfLying = await req("POST", "/api/chat/attachment", { fileData: "dGVzdA==", fileName: "doc.pdf" }, ac);
  test("24b. Good extension with non-matching bytes rejected", gfLying.status === 400);

  // 25. Canceled jobs excluded from dashboard
  const unassigned = dash.body?.unassignedJobs || [];
  const hasCanceled = unassigned.some(j => /cancel/i.test(Object.values(j).join(" ")));
  test("25. Canceled jobs excluded from unassigned", !hasCanceled);

  // 26. Public tracker rejects malformed load IDs (regex sanitization)
  const badTrack = await req("GET", "/api/public/track/" + encodeURIComponent("!@#$%bad"));
  test("26. Public tracker rejects bad load id", badTrack.status === 400);

  // 27. Public tracker returns 404 for valid-format unknown load
  const unknownTrack = await req("GET", "/api/public/track/SMOKE-DOES-NOT-EXIST-99999");
  test("27. Public tracker 404 unknown load", unknownTrack.status === 404);

  // 28. Public tracker sets noindex robots tag (prevents search engine indexing)
  const robotsHeader = (unknownTrack.headers && unknownTrack.headers["x-robots-tag"]) || "";
  test("28. Public tracker sets noindex header", /noindex/i.test(robotsHeader));

  // 29/30 need a load that actually exists in THIS environment. The suite used
  // to hardcode 554954475, a production load ID — which 404s on staging or any
  // fresh DB, failing two tests for reasons unrelated to the tracker. Take a
  // real ID from the dashboard payload already fetched in test 8 instead.
  function firstLoadId(rows) {
    if (!Array.isArray(rows)) return null;
    for (const r of rows) {
      if (!r) continue;
      const k = Object.keys(r).find(x => /load.?id|job.?id/i.test(x));
      const v = k ? String(r[k]).trim() : "";
      if (v && /^[A-Za-z0-9\-_.#]{1,40}$/.test(v)) return v;
    }
    return null;
  }
  const trackId = firstLoadId(dash.body?.activeJobs)
    || firstLoadId(dash.body?.completedJobs)
    || firstLoadId(dash.body?.unassignedJobs);

  const okTrack = trackId ? await req("GET", "/api/public/track/" + encodeURIComponent(trackId)) : null;
  const tb = (okTrack && okTrack.body) || {};

  // 29. Public tracker payload exposes pickup/delivery date-time keys
  if (!trackId) {
    skip("29. Track payload exposes pickup/delivery date-time keys", "no load in dashboard data");
  } else {
    test("29. Track payload exposes pickup/delivery date-time keys",
      okTrack.status === 200 && "scheduledPickup" in tb && "scheduledDelivery" in tb && "actualPickup" in tb && "actualDelivery" in tb);
  }

  // 30. Public tracker status timeline is an array and never leaks the per-transition actor
  if (!trackId) {
    skip("30. Track phases is array and exposes no actor", "no load in dashboard data");
  } else {
    const phases = tb.phases;
    const phasesIsArray = Array.isArray(phases);
    const phasesShaped = phasesIsArray && phases.every(p => p && "status" in p && "startedAt" in p);
    const noActorKey = phasesIsArray && phases.every(p => !p || !("actor" in p));
    const noActorString = !/actor/i.test(JSON.stringify(phases || []));
    test("30. Track phases is array and exposes no actor",
      okTrack.status === 200 && phasesIsArray && phasesShaped && noActorKey && noActorString);
  }

  // 31. ScanKit health probe — Super Admin gets the contract keys and the API key is NEVER echoed.
  //     Contract: { enabled, hasKey, baseUrl, lastScan, noCreditsSince, errorsLast24h, lastError }.
  const sk = await req("GET", "/api/scankit/health", null, ac);
  const skb = (sk && sk.body) || {};
  const skKeysPresent = sk.status === 200 &&
    typeof skb === "object" &&
    "enabled" in skb && "hasKey" in skb && "baseUrl" in skb && "errorsLast24h" in skb;
  // Defense-in-depth: no raw-key field, and no ScanKit "sk_..." secret anywhere in the payload.
  const skNoRawKey = !("apiKey" in skb) && !("key" in skb) && !/sk_[A-Za-z0-9]/.test(JSON.stringify(skb));
  test("31. ScanKit health works for Super Admin & never echoes the key", skKeysPresent && skNoRawKey);

  // 32. ScanKit health is admin-only — the Investor session (ic, created in test 3) is forbidden.
  const skInv = await req("GET", "/api/scankit/health", null, ic);
  test("32. ScanKit health blocked for non-admin (Investor)", skInv.status === 403);

  // 33. POST /api/documents/upload fast-return smoke (Super Admin; non-Driver roles skip the
  //     load-ownership check). Sends a minimal, real 1x1 baseline JPEG (verified to pass the
  //     server's isValidImageMagic guard AND pdfkit imageToPdf). A NON-"POD" docType is used so
  //     the (non-critical) Job Tracking POD-column write is skipped — keeps this smoke from
  //     mutating a real seeded sheet row. ASSUMPTION: no real seeded load is required (the SQLite
  //     documents row is keyed by loadId with no FK); QA can swap in a seeded loadId + its real
  //     rowIndex and docType:"POD" for a stricter POD-path check. Robust assertion: expect a clean
  //     200, but accept any clean 4xx JSON error too — contract is "responds fast & well-formed,
  //     never a 5xx/crash" across the fast-return refactor.
  const tinyJpeg = "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=";
  const up = await req("POST", "/api/documents/upload",
    { loadId: "SMOKE-UPLOAD-TEST", rowIndex: 2, photoData: "data:image/jpeg;base64," + tinyJpeg, docType: "Test" }, ac);
  const up2xx = up.status === 200 && up.body && typeof up.body === "object" && up.body.error === undefined;
  const upClean4xx = up.status >= 400 && up.status < 500 && up.body && typeof up.body === "object" && "error" in up.body;
  test("33. Documents upload fast-return responds 200 (or clean 4xx, never 5xx)", up2xx || upClean4xx);

  // ---- Expense Intelligence (analytics + AI + vendor normalization) ----

  // 34. Expense analytics requires auth
  const ea1 = await req("GET", "/api/expenses/analytics");
  test("34. Expense analytics blocked without auth", ea1.status === 401);

  // 35. Expense analytics is admin/dispatcher-only — Investor forbidden
  const ea2 = await req("GET", "/api/expenses/analytics", null, ic);
  test("35. Expense analytics blocked for Investor", ea2.status === 403);

  // 36. Expense analytics returns the full aggregate contract for admin:
  //     summary object + the six aggregate arrays lib/expense-analytics produces.
  const ea3 = await req("GET", "/api/expenses/analytics", null, ac);
  const eab = (ea3 && ea3.body) || {};
  const eaArrays = ["byVendor", "byState", "byMonth", "byType", "byDriver", "locations"]
    .every(k => Array.isArray(eab[k]));
  test("36. Expense analytics returns summary + aggregate arrays", ea3.status === 200 && !!eab.summary && eaArrays);

  // 37. Expense analytics validates date filters (YYYY-MM-DD only)
  const ea4 = await req("GET", "/api/expenses/analytics?from=notadate", null, ac);
  test("37. Expense analytics rejects malformed 'from' date", ea4.status === 400);

  // 38. Expense analytics accepts region (Census division) + CSV types filters
  const ea5 = await req("GET", "/api/expenses/analytics?region=Pacific&types=Fuel,Repair", null, ac);
  test("38. Expense analytics accepts region+types filters", ea5.status === 200);

  // 39. GET /api/expenses/all supports the new q/from/to/state filters and
  //     keeps the { expenses: [...] } shape.
  const exAll = await req("GET", "/api/expenses/all?q=zz&from=2026-01-01&to=2026-12-31&state=CA", null, ac);
  test("39. Expenses list supports q/from/to/state filters", exAll.status === 200 && Array.isArray(exAll.body?.expenses));

  // 40. AI expense query requires auth
  const aiq1 = await req("POST", "/api/expenses/ai/query", { question: "which gas station do we frequent the most" });
  test("40. AI expense query blocked without auth", aiq1.status === 401);

  // 41. AI expense query is admin/dispatcher-only — Investor forbidden
  const aiq2 = await req("POST", "/api/expenses/ai/query", { question: "which gas station do we frequent the most" }, ic);
  test("41. AI expense query blocked for Investor", aiq2.status === 403);

  // 42. AI expense query validates the question before touching Gemini
  const aiq3 = await req("POST", "/api/expenses/ai/query", {}, ac);
  test("42. AI expense query rejects empty body", aiq3.status === 400);

  // 43. AI expense query answers (key configured) or degrades to a clean 503
  //     (AI_NO_KEY → "AI is not configured") — never a 5xx crash.
  const aiq4 = await req("POST", "/api/expenses/ai/query", { question: "which gas station do we frequent the most" }, ac);
  test("43. AI expense query answers or 503 when unconfigured",
    aiq4.status === 503 || (aiq4.status === 200 && typeof aiq4.body?.answer === "string"));

  // 44. AI insights requires auth and is admin/dispatcher-only
  const ins1 = await req("GET", "/api/expenses/ai/insights");
  const ins2 = await req("GET", "/api/expenses/ai/insights", null, ic);
  test("44. AI insights blocked without auth (401) and for Investor (403)", ins1.status === 401 && ins2.status === 403);

  // 45. AI insights returns cards (key configured) or a clean 503 when not
  const ins3 = await req("GET", "/api/expenses/ai/insights", null, ac);
  test("45. AI insights returns array or 503 when unconfigured",
    ins3.status === 503 || (ins3.status === 200 && Array.isArray(ins3.body?.insights)));

  // 46. Vendor normalization round-trip: log an expense with a raw merchant
  //     string (same seeded driver "test" the harness already uses in test 22),
  //     then find it via the q filter with the canonical brand stamped on it.
  //
  // ⚠️ THE AMOUNT MUST BE UNIQUE PER RUN, and this test failed for five weeks
  // because it was not. It posted a hard-coded driver+amount+date, which is
  // exactly the signature POST /api/expenses dedupes on — and that check went
  // ON BY DEFAULT on 2026-08-13, five weeks after this test was written. From
  // then on the row a previous run left behind convicted the next one with a
  // 409 POSSIBLE_DUPLICATE, so it passed once against a virgin DB and never
  // again. The normalization it exists to test was never broken.
  //
  // Same fix tests 107-110 already carry ("Seed WITHOUT the flag, so re-running
  // the suite never trips over its own row"). NOT allowDuplicate:true, which
  // would write an expense_duplicate_override audit row on every run.
  const veAmount = Number((10 + (Date.now() % 900000) / 10000).toFixed(2));
  const ve = await req("POST", "/api/expenses",
    { driver: "test", type: "Fuel", amount: veAmount, date: "2026-04-11", vendor: "Pilot Travel Center #123" }, ac);
  const veList = await req("GET", "/api/expenses/all?q=pilot", null, ac);
  const veRows = (veList.body && veList.body.expenses) || [];
  const veNormalized = veRows.some(r => r && r.vendor_normalized === "PILOT FLYING J");
  test("46. Vendor normalization round-trip (Pilot → PILOT FLYING J)",
    ve.status === 200 && ve.body?.success === true && veList.status === 200 && veNormalized);

  // ==========================================================================
  // 47-58. Investor payout ledger.
  //
  // Every case here is a REGRESSION that reached a client, not a hypothetical:
  //   - the Load Reports banner said "$6,389 still owed" while the Payouts card
  //     on the same page said "Total Owed $0" (the open month was being counted
  //     as owed), and that was itself a re-break of an earlier fix
  //   - loss months were stored as NEGATIVE payout rows ("-$970 owed", with a
  //     due date and a Mark Paid button)
  //   - manual adjustments silently broke the banner's add-up property
  // The identity in 53 is the load-bearing one: it is what makes "the numbers
  // on this page reconcile" a testable property instead of a hope.
  // ==========================================================================

  // Investor-scoped: the ledger and the earnings figure must describe the SAME
  // owner, so use the Investor session rather than an admin preview.
  const invSelf = await req("GET", "/api/investor", null, ic);
  const pay = await req("GET", "/api/investor/payouts", null, ic);
  const P = pay.body || {};
  const rows = Array.isArray(P.payouts) ? P.payouts : [];
  const T = P.totals || {};

  // 47. /api/investor must NOT publish a "still owed" figure. It used to return
  //     investorStillOwed = netToDate - paid, which swept the still-open month
  //     into "owed". Owed is the payout ledger's answer, and only its.
  const prod47 = invSelf.body?.production || {};
  test("47. /api/investor publishes no rival 'still owed' figure",
    invSelf.status === 200 && !("investorStillOwed" in prod47) && !("investorPaidToDate" in prod47));

  // 48. Ledger shape, including the fields the banner needs to explain itself.
  test("48. Payout ledger returns payouts/currentMonth/totals with adjustment + carried-loss totals",
    pay.status === 200 && Array.isArray(P.payouts) && !!P.currentMonth &&
    typeof T.totalOwed === "number" && typeof T.totalProcessing === "number" &&
    typeof T.totalPaid === "number" && typeof T.totalAdjustments === "number" &&
    typeof T.carriedLossOutstanding === "number");

  // 49. Payouts are per-owner: a Super Admin previewing nobody has no single
  //     ledger to return. The banner depends on this failing cleanly (it
  //     degrades to earnings-only rather than rendering a $0 owed).
  const payNoOwner = await req("GET", "/api/investor/payouts", null, ac);
  test("49. Payouts require an owner — Super Admin without ?as_user_id gets 400",
    payNoOwner.status === 400);

  // 50. No negative payout row, ever. Losses carry forward; adjustments clamp.
  test("50. No payout row has a negative effective amount",
    rows.every(r => Number(r.effectiveAmount) >= 0));

  // 51. Row arithmetic holds: Amount + Adjustment = Adjusted total, using the
  //     adjustment that ACTUALLY landed (an over-deduction clamps at $0).
  test("51. Every row: amount + adjustmentApplied === effectiveAmount",
    rows.every(r => Math.round(r.amount || 0) + Number(r.adjustmentApplied || 0) === Number(r.effectiveAmount)));

  // 52. A month that deferred a loss pays nothing that month (the loss moves to
  //     later months instead of inverting this row).
  test("52. A loss-deferring month pays $0",
    rows.every(r => !(Number(r.lossDeferred) > 0) || Number(r.amount) === 0));

  // 53. THE reconciliation identity. Every dollar earned sits in exactly one
  //     bucket, and the quantities that live between earnings and payable
  //     (manual adjustments, still-unabsorbed carried loss, and the frozen
  //     settlements' drift) are accounted for:
  //
  //       paid + processing + owed + accruing
  //         === earned + adjustments + carriedLoss − frozenDrift
  //
  //     Breaking this is precisely what the client reported, twice.
  //
  //     WHY frozenDrift IS LEGITIMATE AND NOT A FUDGE TO GET GREEN.
  //     The two sides of this identity are not the same kind of quantity.
  //     `earned` (investorNetToDate) is a LIVE recompute of every month from
  //     current loads and expenses. The three status totals sum each row's
  //     STORED `amount`, which reconcileInvestorPayouts deliberately STOPS
  //     refreshing once a month is frozen (its guard is `status='owed' &&
  //     !finalized_at && !periodWriteLocked(period)`). That freeze is the
  //     feature, not a bug to route around: a correction landing after a month
  //     was settled must not restate a statement already published to the
  //     investor. So a bare equality between a live figure and a frozen one is
  //     guaranteed to fail the first time any calculation is corrected — and it
  //     did, on our OWN correction. The trucks.in_service_date fix lowered a
  //     settled June's fixed costs by ~$174, and at the 50% split the ledger
  //     read exactly $87 out, with the row itself perfectly correct.
  //     The API already publishes both numbers side by side on every row —
  //     `amount` (frozen, what was settled) and `recomputedAmount` (live) —
  //     precisely so the gap is DISCLOSED rather than absorbed. Summing that
  //     same disclosed gap here is what lets the identity hold against live
  //     data without weakening what it asserts.
  //
  //     WHAT IT STILL CATCHES, measured by mutating a live response: a
  //     duplicated payout row (+$7,104), a missing one (−$7,238), a corrupted
  //     adjustment or carried-loss total, and the open month vanishing from
  //     currentMonth. A month's recompute moving in EITHER direction on a
  //     frozen row nets to zero, which is the whole point.
  //
  //     WHAT IT NO LONGER CATCHES — the honest price, verified the same way:
  //       (a) somebody hand-editing a frozen row's stored `amount` (+$2,000 in
  //           the mutation) moves the LHS and the drift term by the same
  //           amount, so it cancels and passes;
  //       (b) the refresh guard breaking so an OPEN month's `amount` stops
  //           tracking its recompute — also absorbed.
  //     Both are the same concession: the identity no longer asserts
  //     `amount === recomputedAmount` for any row. That is unavoidable, and
  //     costs less than it looks, because the old form asserted it for EVERY
  //     row and therefore went red on the ordinary, correct state of a ledger
  //     with any settled month in it — a test that is already failing detects
  //     nothing either. Not re-added as a separate assertion because every row
  //     in the current fixture is frozen, so it would be vacuous here, and
  //     because `periodWriteLocked` fails CLOSED on an unreadable table, which
  //     would make a genuinely-frozen row look open and fail spuriously.
  //     Instead the failure detail prints each drifted row's status/phase: a
  //     drifted row reading `owed`/`pending` is a broken refresh guard and not
  //     a legitimate freeze, and that is visible at a glance when this breaks.
  //     Pre-existing blind spot, unchanged by this: a spurious or missing row
  //     for a $0 month contributes 0 to both sides either way.
  //
  //     THE DRIFT SET IS "the recompute moved", NOT "the status is settled".
  //     Keying on paid/processing looks equivalent and is not: the refresh
  //     guard also freezes a row that is still `owed` — a finalized-but-unpaid
  //     month, or one reopened to `owed` inside a locked period (the payout
  //     reopen does not clear finalized_at; only reopening the PERIOD does).
  //     On this fixture 17 of the 19 rows across the three investors are
  //     exactly that shape (owed + finalized) and only 2 are paid, so a
  //     status-based term would miss almost every frozen row the moment one of
  //     them drifts — it happens to balance today only because those 17 have
  //     not moved yet.
  //     Keying on the published gap covers both AND avoids re-implementing the
  //     server's lock rules in the test: a row the reconcile just refreshed has
  //     amount === recomputedAmount in this very response, so its term is
  //     identically zero and it can be summed unconditionally.
  const earned53 = Number(prod47.investorNetToDate || 0);
  const accruing53 = Number(P.currentMonth?.amountInProgress || 0);
  // A row whose period has aged out of the live earnings window publishes
  // recomputedAmount: null (e.g. the earliest load was cancelled, so the window
  // now starts later than the row). Its dollars are in the LHS but not in
  // `earned`, and with no live figure the drift term CANNOT absorb it. Reading
  // null as 0 would quietly turn that into an unexplained imbalance, so count
  // these separately and fail on them by name.
  const orphans53 = rows.filter(r => r.recomputedAmount == null);
  const drifted53 = rows
    .filter(r => r.recomputedAmount != null && r.recomputedAmount !== r.amount)
    .map(r => ({
      period: r.period, status: r.status, phase: r.phase,
      amount: Number(r.amount || 0), recomputed: Number(r.recomputedAmount),
      delta: Number(r.recomputedAmount) - Number(r.amount || 0),
    }));
  const frozenDrift53 = drifted53.reduce((s, d) => s + d.delta, 0);
  const lhs53 = Number(T.totalPaid || 0) + Number(T.totalProcessing || 0) + Number(T.totalOwed || 0) + accruing53;
  const rhs53 = earned53 + Number(T.totalAdjustments || 0) + Number(T.carriedLossOutstanding || 0) - frozenDrift53;
  test("53. Ledger reconciles: paid+processing+owed+accruing === earned+adjustments+carriedLoss−frozenDrift",
    invSelf.status === 200 && pay.status === 200 && lhs53 === rhs53 && orphans53.length === 0,
    () => {
      const L = [];
      if (invSelf.status !== 200 || pay.status !== 200)
        L.push(`GET /api/investor ${invSelf.status}, GET /api/investor/payouts ${pay.status}`);
      L.push(`LHS ${lhs53} = paid ${T.totalPaid} + processing ${T.totalProcessing} + owed ${T.totalOwed} + accruing ${accruing53}`);
      L.push(`RHS ${rhs53} = earned ${earned53} + adjustments ${T.totalAdjustments} + carriedLoss ${T.carriedLossOutstanding} − frozenDrift ${frozenDrift53}`);
      L.push(`OUT BY ${lhs53 - rhs53}`);
      if (drifted53.length) {
        L.push(`frozen rows whose recompute has moved (${drifted53.length}) — these ARE accounted for above:`);
        drifted53.forEach(d => L.push(
          `  ${d.period}  ${d.status}/${d.phase}  settled ${d.amount} vs recomputed ${d.recomputed}  (${d.delta >= 0 ? "+" : ""}${d.delta})`));
      } else {
        L.push("no frozen row has drifted, so the gap is NOT the settled-figure freeze — look at row/period coverage.");
      }
      if (orphans53.length)
        L.push(`rows with NO live recompute (period outside the earnings window) — unreconcilable, not absorbed: ${orphans53.map(r => r.period).join(", ")}`);
      return L.join("\n");
    });

  // 54. The still-open month is never a settleable row — it is reported only as
  //     currentMonth.amountInProgress. This is the root cause of the original
  //     "$6,389 owed" report.
  test("54. Current in-progress month is not a payout row",
    !!P.currentMonth?.period && !rows.some(r => r.period === P.currentMonth.period));

  // 55. A $0 period cannot be settled — "paid $0" is not a settlement.
  //     Must assert on the REASON, not just the 409: a period still inside its
  //     grace window also 409s (PERIOD_NOT_FINALIZED), which would let this pass
  //     while never exercising the $0 guard it exists for.
  const zeroRow = rows.find(r => Number(r.effectiveAmount) === 0 && r.status === "owed" && r.phase !== "pending");
  if (!zeroRow) {
    skip("55. Cannot settle a $0 payout (409)", "no finalized $0 owed row in seeded data");
  } else {
    const s55 = await req("POST", `/api/investor/payouts/${zeroRow.id}/status`, { status: "paid" }, ac);
    test("55. Cannot settle a $0 payout (409)",
      s55.status === 409 && /\$0|nothing to settle/i.test(s55.body?.error || ""));
  }

  // 56. A deduction cannot exceed the payout it comes off. Kept inside the
  //     pre-existing $10,000 magnitude cap, or that older guard fires first and
  //     this ceiling is never reached. Also skips periods still in their grace
  //     window — adjustments are refused there (the amount is still moving), so
  //     the over-deduction ceiling would never be reached.
  const payableRow = rows.find(r =>
    Number(r.effectiveAmount) > 0 && Number(r.amount) < 10000 && r.phase !== "pending");
  if (!payableRow) {
    skip("56. Cannot over-deduct a payout (400)", "no finalized payable row under the $10k cap in seeded data");
  } else {
    const over = -(Math.round(payableRow.amount) + 1);
    const s56 = await req("PUT", `/api/investor/payouts/${payableRow.id}/adjust`,
      { adjustment: over, adjustmentNote: "test-suite: must be rejected" }, ac);
    test("56. Cannot over-deduct a payout (400)",
      s56.status === 400 && /exceeds the payout/i.test(s56.body?.error || ""));
  }

  // 57. Rejected guards must not mutate. Re-read and compare the whole ledger.
  const payAfter = await req("GET", "/api/investor/payouts", null, ic);
  test("57. Rejected settle/adjust attempts leave the ledger unchanged",
    payAfter.status === 200 && JSON.stringify(payAfter.body) === JSON.stringify(P));

  // 58. Load report: gross revenue sums DELIVERED loads only, so the count
  //     shown beside it must share that basis. "12 loads / $20,623" when 3 were
  //     still in transit was the second defect in the reported screenshot.
  const lr = await req("GET", "/api/investor/load-report?period=monthly", null, ic);
  const periods = (lr.body && lr.body.periods) || [];
  if (lr.status === 200 && periods.length === 0) {
    // An investor with no loads legitimately has no periods — say so rather
    // than passing an invariant that never ran.
    skip("58. Load report splits completed vs in-transit and grosses only completed",
      "investor has no load periods");
  } else {
    // The gross check is TOLERANCED, and the tolerance is arithmetic, not slack.
    // The endpoint accumulates unrounded rates and rounds ONCE at the end
    // (`grossRevenue`), while each load publishes an already-rounded `rate`.
    // Summing the published rates is therefore round-then-sum against the
    // server's sum-then-round, and the two legitimately differ: on this fixture
    // 2026-07 reads 30,997 against 30,998 across 15 completed loads, of which
    // exactly two carry cents (published as 1,015 and 1,013) and both round up.
    // The server's figure is the MORE accurate of the two
    // — one rounding, not fifteen — so this is a defect in the old expectation,
    // not in the money. Each of the n published rates is off by at most $0.50
    // and the single final rounding by at most $0.50, so the gap is provably
    // bounded by (n + 1) / 2 dollars. Anything past that is a real leak.
    const bound58 = (p) => (Number(p.completedCount || 0) + 1) / 2;
    const doneSum58 = (p) => (p.loads || []).filter(l => l.completed).reduce((s, l) => s + (l.rate || 0), 0);
    const allSum58 = (p) => (p.loads || []).reduce((s, l) => s + (l.rate || 0), 0);
    // The bound alone would let an in-transit load smaller than the rounding
    // noise hide inside grossRevenue, so keep one EXACT, rounding-immune
    // assertion of the original defect ("12 loads / $20,623" with 3 still in
    // transit): if in-transit money exists at all, gross must be strictly under
    // the all-loads total.
    const excludesInTransit58 = (p) => allSum58(p) <= doneSum58(p) || p.grossRevenue < allSum58(p);
    const ok58 = (p) =>
      typeof p.completedCount === "number" && typeof p.inTransitCount === "number" &&
      p.completedCount + p.inTransitCount === p.loadCount &&
      p.completedCount === (p.loads || []).filter(l => l.completed).length &&
      Math.abs(Number(p.grossRevenue || 0) - doneSum58(p)) <= bound58(p) &&
      excludesInTransit58(p);
    test("58. Load report splits completed vs in-transit and grosses only completed",
      lr.status === 200 && periods.every(ok58),
      () => {
        if (lr.status !== 200) return `GET /api/investor/load-report -> ${lr.status}`;
        return periods.filter(p => !ok58(p)).map(p =>
          `${p.key}: loadCount ${p.loadCount} = completed ${p.completedCount} + inTransit ${p.inTransitCount}` +
          ` | gross ${p.grossRevenue} vs completed-rate sum ${doneSum58(p)}` +
          ` (off by ${Number(p.grossRevenue || 0) - doneSum58(p)}, rounding bound ±${bound58(p)})` +
          ` | all-loads sum ${allSum58(p)}`).join("\n");
      });
  }

  // ==========================================================================
  // 59-62. Reopening a settled payout.
  //
  // The regression: $8,703 was booked as PAID on a load that had never been
  // sent — "Mark Paid" sat one click away on every unsettled row and the
  // lifecycle only ran forward, so the money could not be un-booked. The
  // client's words: "we never paid out 12965 we only paid out 3992 ... I need
  // control to reopen and edit everything until we get it right."
  //
  // Two properties are load-bearing here: a reversal is always REASONED (money
  // never moves backwards anonymously), and it un-stamps what it undoes (a
  // paid_at must not outlive the paid status, or the row lies about itself).
  // ==========================================================================

  // 59. A reversal without a stated reason is refused. Non-mutating, so it also
  //     proves the guard fires before any write.
  // Must NOT be in a period still inside its grace window: test 60 restores the
  // original status, and a forward move on a pending period is refused (409
  // PERIOD_NOT_FINALIZED). Picking one would leave the row reopened with no way
  // to put it back — debris on a shared staging ledger.
  const settledRow = rows.find(r =>
    (r.status === "paid" || r.status === "processing") && r.phase !== "pending");
  if (!settledRow) {
    skip("59. Reopening without a reason is rejected (400)", "no settled row outside a grace window in seeded data");
    skip("60. Reopen round-trip un-stamps and re-stamps correctly", "no settled row outside a grace window in seeded data");
  } else {
    const s59 = await req("POST", `/api/investor/payouts/${settledRow.id}/status`,
      { status: "owed" }, ac);
    const s59b = await req("POST", `/api/investor/payouts/${settledRow.id}/status`,
      { status: "owed", reason: "   " }, ac);
    test("59. Reopening without a reason is rejected (400)",
      s59.status === 400 && s59b.status === 400 &&
      /reason is required/i.test(s59.body?.error || ""));

    // 60. The round-trip. MUTATES, then restores — the suite is meant to run
    //     against a prepared DB (scripts/prepare-test-fixtures.js), and the reopen
    //     trail it leaves on the row is the point of the feature, not debris.
    const back = settledRow.status === "paid" ? "processing" : "owed";
    const r60 = await req("POST", `/api/investor/payouts/${settledRow.id}/status`,
      { status: back, reason: "test-suite: reopen round-trip" }, ac);
    const after60 = await req("GET", "/api/investor/payouts", null, ic);
    const moved = (after60.body?.payouts || []).find(r => r.id === settledRow.id);
    // Restore the original status so the ledger ends where it started.
    const restore = await req("POST", `/api/investor/payouts/${settledRow.id}/status`,
      { status: settledRow.status }, ac);
    test("60. Reopen round-trip un-stamps and re-stamps correctly",
      r60.status === 200 && r60.body?.reopened === true &&
      moved?.status === back &&
      // Dropping out of 'paid' must clear paid_at — a stale stamp would leave
      // the row claiming a payment date it no longer has.
      (back !== "processing" || !moved?.paidAt) &&
      !!moved?.reopenReason && !!moved?.reopenedBy &&
      restore.status === 200 && restore.body?.reopened === false);
  }

  // 61. A transition to the status a row already holds is a no-op, not a
  //     silent re-stamp — re-clicking Mark Paid must not overwrite paid_at.
  const anyRow = rows[0];
  if (!anyRow) {
    skip("61. A no-op status transition is rejected (409)", "no payout rows in seeded data");
  } else {
    const s61 = await req("POST", `/api/investor/payouts/${anyRow.id}/status`,
      { status: anyRow.status, reason: "test-suite: no-op" }, ac);
    test("61. A no-op status transition is rejected (409)",
      s61.status === 409 && /already/i.test(s61.body?.error || ""));
  }

  // 62. Reopening rewrites settled financial history — Super Admin only. An
  //     Investor must not be able to un-book their own payout.
  if (!anyRow) {
    skip("62. Non-Super-Admin cannot reopen a payout (403)", "no payout rows in seeded data");
  } else {
    const s62 = await req("POST", `/api/investor/payouts/${anyRow.id}/status`,
      { status: "owed", reason: "test-suite: must be refused" }, ic);
    test("62. Non-Super-Admin cannot reopen a payout (403)", s62.status === 403);
  }

  // ==========================================================================
  // 63-73. Drag-and-drop rate-con ingestion.
  //
  // Today a load can only enter LogisX through a rate-con EMAIL hitting the
  // n8n pipeline. No email -> no load -> a dispatcher retypes it by hand. The
  // two new endpoints let an admin drop the PDF straight into the app:
  //   POST /api/loads/ratecon/extract    parse only, WRITES NOTHING
  //   POST /api/loads/from-ratecon       creates the load from reviewed fields
  //
  // Everything below is a REJECTION path on purpose. These endpoints create
  // loads in a live dispatch board, so the tests that matter here are the ones
  // proving the guards fire BEFORE anything is written — they need no fixture
  // and leave nothing behind. The one creating test is opt-in (73).
  // ==========================================================================

  // tinyPdfB64 (the "JVBERi" accept-path payload for /extract) is declared at
  // module scope — see the note there; tests 24/24b share it.

  // Read the Job Tracking sheet ONCE for this whole block: the row total (for
  // the "nothing was written" invariant), plus real headers/rows so the
  // duplicate + broker tests can key off data that exists in THIS environment
  // instead of a hardcoded production load ID (see the note above test 29).
  const jtUrl = "/api/data?sheet=" + encodeURIComponent("Job Tracking") + "&limit=200";
  const jtBefore = await req("GET", jtUrl, null, ac);
  const jtHeaders = (jtBefore.body && jtBefore.body.headers) || [];
  const jtRows = (jtBefore.body && jtBefore.body.data) || [];
  const jtCountBefore = jtBefore.body && jtBefore.body.total;

  // Column lookup mirroring server.js findCol(): first regex wins, in header
  // order. The sheet's money column is literally "  Payment  " (real spaces),
  // hence the trim.
  function colOf(headers, ...patterns) {
    for (const re of patterns) {
      const h = (headers || []).find((x) => re.test(String(x == null ? "" : x).trim()));
      if (h != null) return h;
    }
    return null;
  }
  const jtLoadCol = colOf(jtHeaders, /^load.?id$/i, /load.?id|job.?id/i);
  const jtEmailCol = colOf(jtHeaders, /^email$/i, /broker.*email|email/i);
  const jtStatusCol = colOf(jtHeaders, /^status$/i, /status/i);
  const jtPayCol = colOf(jtHeaders, /^payment$/i, /payment/i);
  const money = (v) => {
    const n = parseFloat(String(v == null ? "" : v).replace(/[^0-9.\-]/g, ""));
    return isFinite(n) ? n : 0;
  };
  const cell = (row, col) => (col && row ? String(row[col] == null ? "" : row[col]).trim() : "");
  // A load ID that exists right now, taken from the same deduplicated read the
  // server does — never hardcoded.
  const existingLoad = jtRows.find((r) => /^[A-Za-z0-9\-_.#]{1,40}$/.test(cell(r, jtLoadCol)));
  const existingLoadId = existingLoad ? cell(existingLoad, jtLoadCol) : null;

  // 63. Extraction is dispatch-desk tooling and burns Gemini credits — no
  //     anonymous access.
  const rx1 = await req("POST", "/api/loads/ratecon/extract", { pdfBase64: tinyPdfB64, fileName: "rc.pdf" });
  test("63. Rate-con extract blocked without auth (401)", rx1.status === 401);

  // 64. Super Admin + Dispatcher only. The Investor session (ic) stands in for
  //     "authenticated but wrong role", as in tests 32/35/41.
  const rx2 = await req("POST", "/api/loads/ratecon/extract", { pdfBase64: tinyPdfB64, fileName: "rc.pdf" }, ic);
  test("64. Rate-con extract blocked for Investor (403)", rx2.status === 403);

  // 65. No file at all must fail validation, not reach Gemini.
  const rx3 = await req("POST", "/api/loads/ratecon/extract", { fileName: "rc.pdf" }, ac);
  test("65. Rate-con extract rejects a missing pdfBase64 (400)", rx3.status === 400);

  // 66. The magic-prefix guard: base64 of "this is not a pdf". Sending a JPEG
  //     or an HTML error page to a PDF-only vision prompt costs money and
  //     returns nonsense, so it must be refused up front.
  const rx4 = await req("POST", "/api/loads/ratecon/extract",
    { pdfBase64: "dGhpcyBpcyBub3QgYSBwZGY=", fileName: "notapdf.pdf" }, ac);
  test("66. Rate-con extract rejects a non-PDF payload (400)", rx4.status === 400);

  // 67. Size cap (~15 MB per the plan). 20 MiB of base64 is ~15.7 MB decoded,
  //     over the cap but well under express's 50mb body limit, so the request
  //     reaches the handler. Accepts 413 too — if the cap is ever enforced by
  //     body-parser instead of the handler, the user-visible outcome (refused,
  //     not OOM) is the same. The wording of the error is deliberately NOT
  //     asserted. A 200 here means there is no cap at all, and fails.
  const oversized = "JVBERi" + "A".repeat(20 * 1024 * 1024);
  const rx5 = await req("POST", "/api/loads/ratecon/extract", { pdfBase64: oversized, fileName: "huge.pdf" }, ac);
  test("67. Rate-con extract rejects an oversized payload (400/413)", rx5.status === 400 || rx5.status === 413);

  // 68. from-ratecon writes to three sheet tabs + Drive — no anonymous access.
  const fr1 = await req("POST", "/api/loads/from-ratecon", { fields: { "Load Number": "SUITE-NO-AUTH" } });
  test("68. Create-from-ratecon blocked without auth (401)", fr1.status === 401);

  // 69. Investors must never be able to inject a load.
  const fr2 = await req("POST", "/api/loads/from-ratecon", { fields: { "Load Number": "SUITE-NO-ROLE" } }, ic);
  test("69. Create-from-ratecon blocked for Investor (403)", fr2.status === 403);

  // 70. A load with no Load Number is unroutable, untrackable and un-invoiceable
  //     — the n8n pipeline drops those runs, and so must this. Blank, whitespace
  //     and missing all count.
  const fr3 = await req("POST", "/api/loads/from-ratecon",
    { fields: { "Load Number": "   " }, pdfBase64: tinyPdfB64, fileName: "rc.pdf" }, ac);
  const fr3b = await req("POST", "/api/loads/from-ratecon", { fields: {} }, ac);
  test("70. Create-from-ratecon rejects a blank Load Number (400)", fr3.status === 400 && fr3b.status === 400);

  // 71. The duplicate guard. Dropping the same rate-con twice (easy: the file
  //     is in Drive AND in the dispatcher's downloads) must not create a twin
  //     load — two rows with one Load ID break dedup, the tracker and billing.
  //     Uses a load ID read from the sheet at runtime, so this exercises the
  //     409 WITHOUT creating anything. Depends on the duplicate check running
  //     before any write (plan steps 2 vs 4-6); if that order is ever inverted
  //     this test still fails, but test 72 is what proves nothing landed.
  if (!existingLoadId) {
    skip("71. Create-from-ratecon rejects a duplicate Load ID (409)", "no load in the Job Tracking sheet");
  } else {
    const fr4 = await req("POST", "/api/loads/from-ratecon",
      { fields: { "Load Number": existingLoadId }, pdfBase64: tinyPdfB64, fileName: "rc.pdf" }, ac);
    test("71. Create-from-ratecon rejects a duplicate Load ID (409)",
      fr4.status === 409 && fr4.body?.code === "DUPLICATE_LOAD");
  }

  // 72. THE invariant for this whole block: /extract is a pure parse, and every
  //     rejected create above must have bailed before touching the sheet. First
  //     fire a SUCCESSFUL extract of the valid tiny PDF — this is the read-only
  //     happy path, and the only way to prove /extract itself writes nothing
  //     (the rejections never reach the parse). It may 200 (Gemini parsed, maybe
  //     empty), 503 (Gemini unconfigured on this box) or 400 (Gemini rejected
  //     the stub PDF) — all fine; it must never 5xx-crash, and above all must
  //     not add a row. Row counts are compared to THEMSELVES (never a literal),
  //     so this is environment-independent; a concurrent ingestion into the same
  //     sheet mid-run would also trip it — worth a look either way.
  const rxOk = await req("POST", "/api/loads/ratecon/extract", { pdfBase64: tinyPdfB64, fileName: "rc.pdf" }, ac);
  const rxWellFormed = rxOk.status !== 500 && rxOk.status < 600 &&
    (rxOk.status !== 200 || (rxOk.body && typeof rxOk.body === "object" && "fields" in rxOk.body && Array.isArray(rxOk.body.warnings)));
  const jtAfter = await req("GET", jtUrl, null, ac);
  const jtCountAfter = jtAfter.body && jtAfter.body.total;
  test("72. A successful extract + the rejected creates wrote no Job Tracking row",
    rxWellFormed && jtBefore.status === 200 && jtAfter.status === 200 &&
    typeof jtCountBefore === "number" && jtCountBefore === jtCountAfter);

  // 73. WRITE TEST — creates a real load. Default SKIPPED; enable with
  //     RUN_WRITE_TESTS=1 and only ever against staging. It deletes the Job
  //     Tracking row it made, but the plan also upserts Payments Table +
  //     Job Details rows and uploads a PDF to the rate-con Drive folder:
  //     THOSE NEED MANUAL CLEANUP. Asserts the documented response contract.
  if (!RUN_WRITE_TESTS) {
    skip("73. Create-from-ratecon creates a load end to end", "write test — set RUN_WRITE_TESTS=1 (staging only)");
  } else {
    const newId = "SUITE" + Date.now();
    const fr5 = await req("POST", "/api/loads/from-ratecon", {
      fields: {
        "Load Number": newId,
        "Broker Name": "Test Broker",
        "Rate": "1500",
        "Pickup Address": "1600 Amphitheatre Pkwy, Mountain View, CA 94043",
        "Delivery Address": "1 Apple Park Way, Cupertino, CA 95014",
      },
      pdfBase64: tinyPdfB64,
      fileName: newId + ".pdf",
    }, ac);
    const b73 = fr5.body || {};
    const created = fr5.status === 200 && b73.success === true && String(b73.loadId) === newId &&
      typeof b73.rowIndex === "number" && typeof b73.distanceMiles === "number" &&
      typeof b73.ratePerMile === "number" && Array.isArray(b73.warnings);
    // Clean up the row we just appended (it is the last row, so no reindexing
    // hazard for anything else).
    let cleaned = false;
    if (typeof b73.rowIndex === "number") {
      // `reason` is REQUIRED by DELETE /api/data/:rowIndex (400
      // DELETE_REASON_REQUIRED without it) and is written to audit_trail with
      // the deleted row's contents. Without it this cleanup 400s and leaves the
      // row it just created behind, in a sheet the suite is meant to leave as it
      // found it. The row is dated in the current (open) month, so the period
      // guard passes; a suite run against a sheet whose current month has been
      // finalized will get a 409 here, and that refusal is correct.
      const del = await req("DELETE", "/api/data/" + b73.rowIndex + "?sheet=" + encodeURIComponent("Job Tracking"),
        { reason: "test-suite cleanup: removing the load test 73 just created" }, ac);
      cleaned = del.status === 200;
    }
    test("73. Create-from-ratecon creates a load end to end (and is cleaned up)", created && cleaned);
  }

  // ==========================================================================
  // 74-79. Broker-agnostic invoice drafting.
  //
  // "Draft Invoice Email" used to be Bison-only: the button was hidden unless
  // the broker email ended @bisontransport.com and the route 400'd otherwise,
  // so every other broker's invoice was assembled by hand. The gate is gone;
  // Bison is now just a branch that picks the AP inbox.
  //
  // What must NOT have been relaxed with it: delivered/completed, a POD, and
  // the new hard stop — a total we can actually stand behind.
  // ==========================================================================

  const draftPath = (id, q) => "/api/loads/" + encodeURIComponent(id) + "/draft-invoice" + (q || "");
  const aliasPath = (id, q) => "/api/loads/" + encodeURIComponent(id) + "/draft-bison-invoice" + (q || "");

  // 74. Both the new route AND the legacy alias (kept for bookmarks/n8n/cached
  //     SPA bundles) must be gated. An alias that skips auth is a back door.
  const di1 = await req("POST", draftPath("SUITE-NO-AUTH"), {});
  const di1b = await req("POST", aliasPath("SUITE-NO-AUTH"), {});
  test("74. Draft-invoice + legacy alias blocked without auth (401)", di1.status === 401 && di1b.status === 401);

  // 75. Super Admin + Dispatcher only, on both paths.
  const di2 = await req("POST", draftPath("SUITE-NO-ROLE"), {}, ic);
  const di2b = await req("POST", aliasPath("SUITE-NO-ROLE"), {}, ic);
  test("75. Draft-invoice + legacy alias blocked for Investor (403)", di2.status === 403 && di2b.status === 403);

  // 76. Unknown load -> 404, checked before any Drive/Gemini/PDF work.
  const di3 = await req("POST", draftPath("SUITE-DOES-NOT-EXIST-99999"), {}, ac);
  test("76. Draft-invoice 404s an unknown load", di3.status === 404);

  // 77. THE regression this feature exists for: a non-Bison load must never be
  //     refused for being non-Bison. Any load will do — the removed gate used
  //     to fire before the status check — so this stays cheap and side-effect
  //     free. It also pins the remaining refusal reasons: if the load IS
  //     rejected, it may only be for a surviving guard (status/POD/total/
  //     trailer), never for the brokerage.
  const nonBisonRow = jtRows.find((r) => {
    const em = cell(r, jtEmailCol).toLowerCase();
    return cell(r, jtLoadCol) && !!em && !/bisontransport\.com$/.test(em);
  });
  if (!nonBisonRow) {
    skip("77. A non-Bison load is not rejected for being non-Bison", "no non-Bison load with a broker email in the sheet");
  } else {
    const di4 = await req("POST", draftPath(cell(nonBisonRow, jtLoadCol), "?dryRun=1"), {}, ac);
    const err77 = String((di4.body && di4.body.error) || "");
    const bisonRejected = di4.status >= 400 && /bison/i.test(err77);
    const survivingGuardOnly = di4.status === 200 ||
      /deliver|complet|pod|total|trailer|unknown/i.test(err77);
    test("77. A non-Bison load is not rejected for being non-Bison", !bisonRejected && survivingGuardOnly);
  }

  // 78. The one hard stop left: with no rate-con total AND no sheet Payment,
  //     the route must 422 rather than mail a broker a $0.00 invoice. Needs a
  //     delivered load with an empty Payment cell AND a POD; when the
  //     environment has none, SKIP loudly rather than pass vacuously.
  const deliveredRows = jtRows.filter((r) => /delivered|completed|pod received/i.test(cell(r, jtStatusCol)));
  const noTotalRows = deliveredRows.filter((r) => money(cell(r, jtPayCol)) <= 0).slice(0, 2);
  let zeroResult = null;
  for (const r of noTotalRows) {
    zeroResult = await req("POST", draftPath(cell(r, jtLoadCol), "?dryRun=1"), {}, ac);
    if (zeroResult.status === 422) break;
  }
  if (!zeroResult) {
    skip("78. Refuses to draft a $0.00 invoice (422 INVOICE_TOTAL_UNKNOWN)", "no delivered load with an empty Payment cell");
  } else if (zeroResult.status === 422) {
    // The guard fired — assert its documented shape.
    test("78. Refuses to draft a $0.00 invoice (422 INVOICE_TOTAL_UNKNOWN)",
      zeroResult.body?.code === "INVOICE_TOTAL_UNKNOWN");
  } else if (zeroResult.status === 200 && zeroResult.body && zeroResult.body.dryRun) {
    // 200 on a load whose SHEET payment is empty is only legitimate when the
    // rate-con rescued the total — in which case it must be strictly positive.
    // A "$0.00"/0 total here IS a drafted zero-dollar invoice: fail, don't skip.
    test("78. Refuses to draft a $0.00 invoice (422 INVOICE_TOTAL_UNKNOWN)", money(zeroResult.body.total) > 0);
  } else {
    // 400 = a guard ahead of the total check fired (no POD / not delivered).
    // That doesn't exercise the $0 stop, so say so instead of green-washing it.
    skip("78. Refuses to draft a $0.00 invoice (422 INVOICE_TOTAL_UNKNOWN)",
      "guard not reached (HTTP " + zeroResult.status + ": " + String((zeroResult.body && zeroResult.body.error) || "").slice(0, 80) + ")");
  }

  // 79. dryRun must be genuinely free of side effects: no Gmail draft, and no
  //     invoice number consumed. Invoice numbers are a per-calendar-day counter
  //     (MMDDYYYY-N) that AP reconciles against, so a preview that burned one
  //     would leave a permanent gap. Two consecutive previews returning the
  //     SAME invoiceId is the proof. Also pins the documented echo keys the
  //     reviewer reads instead of opening the PDF.
  //     Bounded probe: a load only gets this far with a POD + a resolvable
  //     total, so try at most 3 (each does a Drive read, maybe Gemini + a
  //     Puppeteer render). TEST_DRAFT_LOAD_ID=<id> targets a known-good load.
  const forcedDraftId = process.env.TEST_DRAFT_LOAD_ID || "";
  const draftCandidates = forcedDraftId
    ? [forcedDraftId]
    : deliveredRows.map((r) => cell(r, jtLoadCol)).filter(Boolean).slice(0, 3);
  let dr1 = null, draftId = null;
  for (const id of draftCandidates) {
    const r = await req("POST", draftPath(id, "?dryRun=1"), {}, ac);
    if (r.status === 200) { dr1 = r; draftId = id; break; }
    dr1 = dr1 || r;
  }
  if (!draftId) {
    skip("79. dryRun creates no draft, burns no invoice number, echoes routing",
      draftCandidates.length
        ? "no delivered load got past the POD/total guards (last HTTP " + (dr1 && dr1.status) + ")"
        : "no delivered load in the sheet");
  } else {
    const dr2 = await req("POST", draftPath(draftId, "?dryRun=1"), {}, ac);
    const a = dr1.body || {}, b = dr2.body || {};
    const echoed = ["brokerName", "to", "subject", "orderNumber", "total", "totalSource"].every((k) => k in a);
    test("79. dryRun creates no draft, burns no invoice number, echoes routing",
      dr2.status === 200 && a.dryRun === true && a.preview === true && echoed &&
      // A dry run never reports a delivery mechanism.
      !("via" in a) && !("draftMailbox" in a) &&
      // The counter is peeked, not consumed.
      !!a.invoiceId && a.invoiceId === b.invoiceId &&
      // Routing must be one of the two known inboxes and the total non-zero.
      /@/.test(String(a.to)) && money(a.total) > 0 &&
      (a.totalSource === "ratecon" || a.totalSource === "sheet"));
  }

  // ==========================================================================
  // 80-90. lib/broker-invoice.js — pure unit assertions.
  //
  // No server, no fixtures, no network: the cheapest and most deterministic
  // coverage in this file. Everything here is a decision that puts a number or
  // an address in front of a broker, and two of them (86, 87) are the exact
  // regression that made EVERY non-Bison invoice fail with a 409.
  // ==========================================================================

  const BI = brokerInvoice;
  if (!BI) {
    for (const n of [
      "80. resolveInvoiceTo routes Bison to its own AP inbox",
      "81. resolveInvoiceTo maps a known domain and bills quickpay",
      "82. resolveInvoiceTo humanizes an unmapped domain",
      "83. resolveInvoiceTo falls back to the broker contact name",
      "84. parseMoney: blank/None/$0.00 are all 0, $550.00 is 550",
      "85. A Gemini 'None'/'$0.00' answer never shadows the sheet fallback",
      "86. scanBillingBlock yields no trailer for rate-con prose",
      "87. scanBillingBlock still reads a real Bison billing block",
      "88. Invoice email omits the driver-ID/PO sentence when both are absent",
      "89. Invoice email preserves an alphanumeric PO",
    ]) skip(n, "lib/broker-invoice.js not loadable from this checkout");
  } else {
    // 80. Bison keeps the dedicated AP inbox it has always used — byte for
    //     byte. This is the regression check on the generalization.
    const to80 = BI.resolveInvoiceTo({ brokerEmail: "ops@bisontransport.com" });
    test("80. resolveInvoiceTo routes Bison to its own AP inbox",
      to80.name === "Bison Transport" && to80.email === "QPinvoicesUSA@bisontransport.com");

    // 81. The sheet has NO brokerage column — "Broker Contact Name" holds the
    //     booking agent ("Danna Garcia"), which must never head an Invoice To
    //     block. The company is derived from the email domain instead, and
    //     everyone who isn't Bison bills quickpay.
    const to81 = BI.resolveInvoiceTo({ brokerEmail: "Danna.Garcia@chrobinson.com", brokerContactName: "Danna Garcia" });
    test("81. resolveInvoiceTo maps a known domain and bills quickpay",
      to81.name === "C.H. Robinson" && to81.email === "quickpay@megacorplogistics.com");

    // 82. An unmapped broker must still produce a presentable name rather than
    //     a blank invoice — a new broker should not need a code change.
    const to82 = BI.resolveInvoiceTo({ brokerEmail: "x@acme-freight.com" });
    test("82. resolveInvoiceTo humanizes an unmapped domain",
      to82.name === "Acme Freight" && to82.email === "quickpay@megacorplogistics.com");

    // 83. Last resort with no usable email: the agent's name beats an empty
    //     "Invoice To".
    const to83 = BI.resolveInvoiceTo({ brokerContactName: "Danna Garcia" });
    test("83. resolveInvoiceTo falls back to the broker contact name",
      to83.name === "Danna Garcia" && to83.email === "quickpay@megacorplogistics.com");

    // 84. The floor under the 422 guard. Each of these used to be a plausible
    //     route to a $0.00 invoice: an empty Payment cell, a Gemini "None", a
    //     literal "$0.00". All must read as 0 so `total > 0` refuses.
    test("84. parseMoney: blank/None/$0.00 are all 0, $550.00 is 550",
      BI.parseMoney("") === 0 && BI.parseMoney(null) === 0 && BI.parseMoney(undefined) === 0 &&
      BI.parseMoney("None") === 0 && BI.parseMoney("$0.00") === 0 &&
      BI.parseMoney("$550.00") === 550 && BI.parseMoney("1,800.00") === 1800);

    // 85. Same guard one layer up: a truthy-but-worthless Gemini total
    //     ("$0.00") must not win over the sheet's Payment column, or the route
    //     would bill $0 while believing it had a rate-con number. Also pins
    //     that "None" never becomes a trailer id (see 86).
    //     MUST pass a real Buffer. extractRateConFields only reaches the Gemini
    //     branch when Buffer.isBuffer(pdfBuffer) && pdfBuffer.length, so calling it
    //     with null — as this test did until 2026-08-04 — returned an all-empty
    //     object and Gemini never ran. Two of the three assertions below then passed
    //     because everything was empty rather than because the guard worked: the
    //     test was giving false assurance on the exact behaviour it exists to
    //     protect. A non-PDF buffer is enough — the text scan finds no "Order #"
    //     anchor, the all-or-nothing gate leaves fields empty, and Gemini runs.
    const merged85 = await BI.extractRateConFields(Buffer.from("rate con placeholder, not a real pdf"), {
      geminiExtract: async () => ({ "Order Number": "#7,007,280.", "Total Rate": "$0.00", "Trailer Number": "None" }),
    });
    test("85. A Gemini 'None'/'$0.00' answer never shadows the sheet fallback",
      merged85.totalRate === "" && merged85.trailerNumber === "" && merged85.orderNumber === "7007280");

    // 86. THE regression. The deterministic scan only understands Bison's
    //     "Billing Information" block, but its labels used to match ordinary
    //     prose on C.H. Robinson / Navisphere rate-cons — "Trailer are
    //     required" -> "are", "Trailers53' or longer" -> "s53". Because the
    //     scan beats Gemini in the merge, that garbage reached the route's
    //     trailer-mismatch check and 409'd EVERY non-Bison invoice. A trailer
    //     id always contains a digit and the block needs its Order # anchor.
    const prose86 = [
      "Customer-Specified Equipment Requirements 53' Dry Van Trailer Required",
      "Any seals applied to trailer are not to be broken prior to delivery.",
      "Trailers53' or longer are acceptable for this lane.",
    ].join("\n");
    const s86 = BI.scanBillingBlock(prose86);
    test("86. scanBillingBlock yields no trailer for rate-con prose",
      s86.trailerNumber === "" && s86.orderNumber === "");

    // 87. ...while the real thing still parses. Same helper, same run: the fix
    //     for 86 is only correct if it did not blind the Bison path.
    const s87 = BI.scanBillingBlock(
      ["Billing Information", "Order #: 7076944", "LEG #:", "PO #: 2782962",
       "Move #: 20050535", "Trailer: 118013", "Total Rate: $1,800.00"].join("\n"));
    test("87. scanBillingBlock still reads a real Bison billing block",
      s87.orderNumber === "7076944" && s87.trailerNumber === "118013" &&
      s87.moveNumber === "20050535" && BI.parseMoney(s87.totalRate) === 1800);

    // 88. UPDATED 2026-08-04. This asserted that a C.H. Robinson email still cited
    //     "Order # …". Per the client decision of 2026-07-30 (see the comment above
    //     buildInvoiceEmailHtml), the Order #/PO #/driver-ID summary is now a
    //     BISON-ONLY format: every other broker gets a plain cover note keyed on the
    //     LOAD number, with no purchase-order language at all. The old assertion was
    //     testing a spec the client had already replaced.
    //
    //     What still matters, and is what this now pins: a non-Bison email must not
    //     leak any of that Bison vocabulary — the original bug was an invoice
    //     reading "...is  &amp; PO #", which looks broken to the person paying it.
    const html88 = BI.buildInvoiceEmailHtml({ brokerName: "C.H. Robinson", orderNumber: "560909669", loadNumber: "560909669" });
    test("88. Non-Bison invoice email is a plain cover note with no Order#/PO/driver-ID language",
      html88.includes("load number 560909669") &&
      !/driver ID/i.test(html88) && !/PO\s*#/i.test(html88) && !/&amp;\s*PO/i.test(html88) &&
      !/Order\s*#/i.test(html88));

    // 89. UPDATED 2026-08-04, same reason. A real C.H. Robinson PO is
    //     "SHP2607-A3BJ112", and the old digits-only normalization truncated it to
    //     "2607" — citing the wrong PO, silently, where only the broker would
    //     notice. That regression is still worth guarding, but the PO is now
    //     rendered ONLY on the Bison path, so the guard has to live there or it
    //     tests nothing. Verified: Bison still renders it intact.
    const html89 = BI.buildInvoiceEmailHtml({ isBison: true, brokerName: "Bison Transport", orderNumber: "560909669", moveNumber: "20050535", poNumber: "SHP2607-A3BJ112" });
    test("89. Invoice email preserves an alphanumeric PO (Bison path)",
      html89.includes("SHP2607-A3BJ112") && !/PO\s*#?\s*2607\b/.test(html89));

    // 89b. The other half of the 2026-07-30 split: a PO handed to a NON-Bison
    //      broker must not resurrect the purchase-order sentence. Without this,
    //      "render the PO intact" (89) and "no PO language" (88) could both be
    //      satisfied by a build that quietly reintroduced it for everyone.
    const html89b = BI.buildInvoiceEmailHtml({ brokerName: "C.H. Robinson", orderNumber: "560909669", loadNumber: "560909669", poNumber: "SHP2607-A3BJ112" });
    test("89b. A PO on a non-Bison load does not reintroduce PO language",
      !/PO\s*#/i.test(html89b) && !html89b.includes("SHP2607-A3BJ112"));
  }

  // ==========================================================================
  // 90-91. Rate-con extraction against REAL broker PDFs.
  //
  // The synthetic strings in 86/87 encode what we believe the PDFs contain;
  // these run the same code over the actual files. They are skipped unless
  // RATECON_FIXTURE_DIR points at a folder of rate-cons — the PDFs carry
  // broker pricing and are deliberately not committed.
  // ==========================================================================

  let fixtureFiles = [];
  if (RATECON_FIXTURE_DIR) {
    try {
      fixtureFiles = fs.readdirSync(RATECON_FIXTURE_DIR).filter((f) => /\.pdf$/i.test(f));
    } catch {
      fixtureFiles = [];
    }
  }
  const bisonFixture = fixtureFiles.find((f) => /bison/i.test(f));
  const otherFixtures = fixtureFiles.filter((f) => !/bison/i.test(f));

  // 90. The Bison rate-con is the ONE layout the free deterministic scan
  //     understands, so it must keep resolving without spending a Gemini call:
  //     the order number in the filename, a digit-bearing trailer, a real total.
  if (!bisonFixture) {
    skip("90. A real Bison rate-con PDF scans without Gemini", "set RATECON_FIXTURE_DIR to a folder containing a Bison rate-con");
  } else {
    const expectOrder = (bisonFixture.match(/#?(\d{6,})/) || [])[1] || "";
    const f90 = await BI.extractRateConFields(fs.readFileSync(path.join(RATECON_FIXTURE_DIR, bisonFixture)));
    test("90. A real Bison rate-con PDF scans without Gemini",
      !!expectOrder && f90.orderNumber === expectOrder &&
      /\d/.test(String(f90.trailerNumber)) && BI.parseMoney(f90.totalRate) > 0);
  }

  // 91. Every non-Bison rate-con must yield an EMPTY trailer from the
  //     deterministic scan, so Gemini's answer survives the merge and the
  //     route's trailer-mismatch 409 never fires on prose. These files are the
  //     originals that broke it — they really do contain "Trailer Required"
  //     and "trailer are not to be broken", which the second assertion proves
  //     the scanner actually saw rather than missing the text entirely.
  if (!otherFixtures.length) {
    skip("91. Real non-Bison rate-cons yield no phantom trailer number", "set RATECON_FIXTURE_DIR to a folder containing non-Bison rate-cons");
  } else {
    let allClean = true, sawTrailerProse = false;
    for (const f of otherFixtures) {
      const buf = fs.readFileSync(path.join(RATECON_FIXTURE_DIR, f));
      const scanned = BI.scanBillingBlock(BI.extractPdfText(buf));
      if (scanned.trailerNumber !== "") allClean = false;
      if (/trailer/i.test(BI.extractPdfText(buf))) sawTrailerProse = true;
    }
    test("91. Real non-Bison rate-cons yield no phantom trailer number", allClean && sawTrailerProse);
  }

  // ==========================================================================
  // 92-102. Linxup Push API v3 — inbound GPS webhook receiver.
  //
  // Linxup is the fleet GPS provider (replacing the Routemate poller). Unlike a
  // pull API it PUSHES telemetry to POST /api/eld/linxup/webhook; the receiver
  // token-gates, maps each Position into routemate_telemetry (source:'linxup',
  // speed mph→m/s) and ships DORMANT — it writes only when LINXUP_ENABLED=true.
  //
  // 92-99 are PURE UNIT assertions on lib/linxup-push.js — no server, no
  // fixtures, deterministic — so they are the highest-value coverage here: they
  // pin the mph→m/s conversion the driver-pay travel gate depends on and the
  // message-shape mapping the live ingest reads. 100-102 are server-gated (token
  // + role) and run at integration against a booted server.
  // ==========================================================================

  const LX = linxupPush;
  if (!LX) {
    for (const n of [
      "92. detectMessageType classifies a Position message",
      "93. detectMessageType classifies a Trip message",
      "94. detectMessageType classifies a Stop message",
      "95. speedToMps converts 60 mph to ~26.82 m/s",
      "96. speedToMps converts 100 km/h to ~27.78 m/s",
      "97. speedToMps passes 10 m/s through unchanged",
      "98. normalizePosition yields the neutral telemetry keys",
      "99. vehicleIdCandidates returns [trackerId, deviceNumber, serial, vin]",
    ]) skip(n, "lib/linxup-push.js not loadable from this checkout");
  } else {
    // A Position push (real-time GPS): lat/long + speed + heading/direction, the
    // stable vehicle ids on tracker/asset, and a reverse-geocoded address.
    const positionMsg = {
      tracker: { trackerId: "T-1", deviceNumber: "D-2", deviceSerialNumber: "S-3" },
      asset: { vin: "VIN-4" },
      latitude: 40.4406, longitude: -79.9959,
      speed: 60, heading: "NE", direction: 45,
      address: { street: "5th Ave", city: "Pittsburgh", stateCode: "PA" },
      date: 1719000000000, odometer: 123456, fuelLevel: 75, engineOn: true,
    };
    const tripMsg = { startDateTime: "2026-07-25T10:00:00Z", endDateTime: "2026-07-25T12:00:00Z", distanceMiles: 120 };
    const stopMsg = { stopType: "CUSTOMER", durationMinutes: 30 };

    // 92-94. Structural classification — the Push API carries no explicit type
    // field, so the receiver detects by shape. Each fixture must land on exactly
    // one type (Position is tested first, so Trip/Stop must not carry lat/long).
    test("92. detectMessageType classifies a Position message", LX.detectMessageType(positionMsg) === "position");
    test("93. detectMessageType classifies a Trip message", LX.detectMessageType(tripMsg) === "trip");
    test("94. detectMessageType classifies a Stop message", LX.detectMessageType(stopMsg) === "stop");

    // 95-97. Speed normalization. Downstream (tracking + the driver-pay travel
    // gate, speed > 2.235 m/s) reads m/s, so the mph→m/s conversion is
    // load-bearing — a unit mistake silently mis-pays drivers.
    test("95. speedToMps converts 60 mph to ~26.82 m/s", Math.abs(LX.speedToMps(60, "mph") - 26.82) < 0.01);
    test("96. speedToMps converts 100 km/h to ~27.78 m/s", Math.abs(LX.speedToMps(100, "kmh") - 27.78) < 0.01);
    test("97. speedToMps passes 10 m/s through unchanged", LX.speedToMps(10, "mps") === 10);

    // 98. Position → the neutral telemetry shape server.js inserts into
    // routemate_telemetry. Pins the keys the ingest reads: vehicle_id (first id
    // candidate), latitude, speed (m/s), bearing (from `direction` degrees),
    // geocoded_location ("City, ST"), and location_date_ms (from `date`).
    const pos = LX.normalizePosition(positionMsg, { speedUnit: "mph" });
    test("98. normalizePosition yields the neutral telemetry keys",
      pos.vehicle_id === "T-1" &&
      pos.latitude === 40.4406 &&
      Math.abs(pos.speed - 26.8224) < 1e-6 &&
      pos.bearing === "45" &&
      pos.geocoded_location === "Pittsburgh, PA" &&
      pos.location_date_ms === 1719000000000);

    // 99. A truck links by ANY Linxup id (trucks.routemate_vehicle_id matched
    // against these), so the candidate list + its order is the contract: the
    // receiver tries them all. tracker.trackerId → deviceNumber → serial → vin.
    test("99. vehicleIdCandidates returns [trackerId, deviceNumber, serial, vin]",
      JSON.stringify(LX.vehicleIdCandidates(positionMsg)) === JSON.stringify(["T-1", "D-2", "S-3", "VIN-4"]));
  }

  // 100. The token gate is ALWAYS enforced. With no token presented the webhook
  //      returns 401 when LINXUP_WEBHOOK_TOKEN is configured, or 503 when it is
  //      unset (feature not configured) — both are correct "not authorized to
  //      ingest" outcomes. A 200 here would mean an open GPS write endpoint.
  const lw = await req("POST", "/api/eld/linxup/webhook", { latitude: 1, longitude: 1, speed: 0, heading: "N" });
  test("100. Linxup webhook rejects a push with no token (401 configured / 503 unset)",
    [401, 503].includes(lw.status));

  // 101. Health is Super Admin only: no session → 401, wrong role (Investor) →
  //      403. Mirrors the ScanKit/Routemate health gating (tests 31-32, 44).
  const lh1 = await req("GET", "/api/eld/linxup/health");
  const lh2 = await req("GET", "/api/eld/linxup/health", null, ic);
  test("101. Linxup health blocked without auth (401) and for Investor (403)",
    lh1.status === 401 && lh2.status === 403);

  // 102. Super Admin gets the health contract, stamped provider:'linxup', and it
  //      never echoes the shared secret (hasToken boolean only — assert no raw
  //      token/webhookToken field, defense-in-depth like the ScanKit test 31).
  const lh3 = await req("GET", "/api/eld/linxup/health", null, ac);
  const lhb = (lh3 && lh3.body) || {};
  test("102. Linxup health returns provider:'linxup' for Super Admin (token never echoed)",
    lh3.status === 200 && lhb.provider === "linxup" &&
    "enabled" in lhb && "hasToken" in lhb && "speedUnit" in lhb &&
    !("token" in lhb) && !("webhookToken" in lhb) && !("LINXUP_WEBHOOK_TOKEN" in lhb));

  // ==========================================================================
  // 103-106. Payout statement PDF.
  //
  // A statement asserts money moved, so the guards matter more than the layout:
  // it must be issuable ONLY for a paid period, must never cross the tenancy
  // boundary via ?as_user_id=, and a render failure must surface as JSON rather
  // than a truncated file the investor would open as a corrupt PDF.
  // ==========================================================================

  // 103. Same contract as the rest of /api/investor/*: a Super Admin has no
  //      single owner to issue for and must name one (mirrors test 49).
  const st103 = await req("GET", "/api/investor/payouts/2026-05/statement", null, ac);
  test("103. Statement requires ?as_user_id= for a Super Admin (400)",
    st103.status === 400 && /as_user_id/i.test(st103.body?.error || ""));

  // 104. Malformed period is rejected before any work is done.
  const st104 = await req("GET", "/api/investor/payouts/not-a-month/statement", null, ic);
  test("104. Statement rejects a malformed period (400)",
    st104.status === 400 && /YYYY-MM/i.test(st104.body?.error || ""));

  // 105. A statement is issued once the period is FINALIZED (or paid) — not
  //      before. The old rule was paid-only; publishing at close is the point of
  //      the grace window ("publish the final number at settlement, not after the
  //      money moves"). So the row that must be refused is one that is neither
  //      finalized nor paid.
  const noStmtRow = rows.find(r => r.status !== "paid" && r.phase !== "finalized");
  if (!noStmtRow) {
    skip("105. Statement refuses a period that is neither finalized nor paid (409)",
      "every seeded payout row is already paid or finalized");
  } else {
    const st105 = await req("GET", `/api/investor/payouts/${noStmtRow.period}/statement`, null, ic);
    test("105. Statement refuses a period that is neither finalized nor paid (409)",
      st105.status === 409 && /PERIOD_NOT_FINALIZED|PAYOUT_NOT_PAID|not_settleable/i.test(st105.body?.code || ""));
  }

  // 106. A paid period returns a real PDF (magic bytes + attachment header), and
  //      an Investor passing someone else's ?as_user_id= is still scoped to
  //      THEMSELVES — resolvePreviewUser ignores the param for non-admins, so the
  //      response must never be another owner's document.
  const paidRow = rows.find(r => r.status === "paid" && Number(r.effectiveAmount) > 0);
  if (!paidRow) {
    skip("106. Paid period returns a PDF and ignores a spoofed as_user_id", "no paid payout row in seeded data");
  } else {
    const st106 = await req("GET", `/api/investor/payouts/${paidRow.period}/statement`, null, ic);
    const ctype = (st106.headers && st106.headers["content-type"]) || "";
    const disp = (st106.headers && st106.headers["content-disposition"]) || "";
    const isPdf = st106.status === 200 && /application\/pdf/i.test(ctype) &&
      /attachment; *filename=/i.test(disp) && typeof st106.body === "string" && st106.body.startsWith("%PDF");
    // Same request with a spoofed owner must behave identically (own data), not 403/leak.
    const spoof = await req("GET", `/api/investor/payouts/${paidRow.period}/statement?as_user_id=999999`, null, ic);
    test("106. Paid period returns a PDF and ignores a spoofed as_user_id",
      isPdf && spoof.status === 200 && typeof spoof.body === "string" && spoof.body.startsWith("%PDF"));
  }

  // ==========================================================================
  // 107-110. Content-duplicate guard on POST /api/expenses.
  //
  // The byte-hash guard only catches identical FILES. It missed the real case:
  // a driver logs a receipt from his phone, then the same photo is bulk-uploaded
  // by an admin — the phone's HEIC is converted to JPEG client-side, so the two
  // never share a hash. Three such pairs reached production (2026-08-01) and
  // double-booked the P&L and the investor payout deduction.
  //
  // The guard is OPT-IN (checkDuplicate) because whether a 409 is survivable is a
  // property of the surface: the admin forms can offer "save anyway", the driver
  // app cannot (and a Super Admin can use the driver app). It is scoped to the
  // same driver so two trucks hitting one brand on one day don't collide.
  // ==========================================================================
  // The AMOUNT is made RUN-UNIQUE (2026-08-04). This block used to use a fixed
  // signature, which made it self-poisoning: test 110 posts a row for driver "test2"
  // on every run, so the NEXT run's 110 found that row and got the 409 it asserts
  // must not happen. The suite passed once on a clean database and failed forever
  // after — 41 stale rows had accumulated — and the failure read like a
  // duplicate-detection bug when the detection was correct and properly scoped to
  // one driver.
  //
  // It must be the amount, NOT the vendor. The dedupe matches on
  // `vendor_normalized`, and "QuikTrip #90210" normalises to plain "QUIKTRIP" — so
  // a unique vendor suffix is stripped before the comparison and collides anyway.
  // (Tried that first; it did not work.) Amount is compared as ROUND(amount, 2) with
  // no normalisation, so it is a real per-run axis.
  //
  // The seed comment below only ever protected 107/108 — same driver, where
  // re-finding its own row is the point. 110 is the one that needed a signature no
  // earlier run could own.
  const dupVendor = "QuikTrip #90210";
  const dupDate = "2026-04-12";
  const dupAmount = Number((100 + (Date.now() % 900000) / 10000).toFixed(2));
  const dupBody = { driver: "test", type: "Fuel", amount: dupAmount, date: dupDate, vendor: dupVendor };

  // Seed WITHOUT the flag, so re-running the suite never trips over its own row.
  const dupA = await req("POST", "/api/expenses", dupBody, ac);
  // ⚠️ RENAMED. This used to read "without checkDuplicate", but `checkDuplicate`
  // has been dead since the duplicate check went on by default (2026-08-13) — it
  // survives in server.js only inside comments, never read as a value. The test
  // passed, but for a reason its own name denied: not because the flag was
  // absent, but because the amount is unique per run. Same drift that made test
  // 46 fail outright, one row over.
  test("107. A first-time expense POST is never blocked as a duplicate (driver-app path)",
    dupA.status === 200 && dupA.body?.success === true);

  const dupB = await req("POST", "/api/expenses", { ...dupBody, checkDuplicate: true }, ac);
  test("108. Same driver/merchant/day/amount with checkDuplicate returns 409 POSSIBLE_DUPLICATE",
    dupB.status === 409 && dupB.body?.code === "POSSIBLE_DUPLICATE" && Number.isInteger(dupB.body?.existingId));

  const dupC = await req("POST", "/api/expenses", { ...dupBody, checkDuplicate: true, allowDuplicate: true }, ac);
  test("109. allowDuplicate overrides the warning (a genuine second purchase)",
    dupC.status === 200 && dupC.body?.success === true);

  const dupD = await req("POST", "/api/expenses", { ...dupBody, driver: "test2", checkDuplicate: true }, ac);
  test("110. Same merchant/day/amount for a DIFFERENT driver is not flagged",
    dupD.status === 200 && dupD.body?.success === true);

  // 111-121. Month-end close: the grace window, the lock, and the posting rule.
  //
  // Every one of these SKIPs cleanly when PERIOD_FINALIZE_ENABLED is off (the
  // state the feature ships in), because with the flag off no row ever reports a
  // phase. A green run on a dormant server is therefore honest, not vacuous.
  const per = await req("GET", "/api/periods", null, ac);
  const closeOn = per.status === 200 && per.body?.enabled === true;
  test("111. GET /api/periods reports the close calendar (Super Admin)",
    per.status === 200 && typeof per.body?.enabled === "boolean"
    && typeof per.body?.graceDays === "number" && Array.isArray(per.body?.periods));

  // 112. Phase is exhaustive and consistent with the lifecycle: no settled row is
  //      ever 'accruing', and the in-progress month is never a payout row (the
  //      property test 54 guards, restated on the new field).
  if (!closeOn) {
    skip("112. Every payout row reports a settled phase", "period close disabled on this server");
  } else {
    test("112. Every payout row reports a settled phase",
      rows.every(r => r.phase === "pending" || r.phase === "finalized")
      && rows.every(r => r.period !== P.currentMonth?.period));
  }

  // 113. A period still inside its grace window cannot be settled forward. THIS
  //      is the guard that ends the correction treadmill: without it an admin
  //      marks paid on the 1st, a receipt lands on the 4th, and the month has to
  //      be adjusted by hand.
  const pendingRow = rows.find(r => r.phase === "pending" && Number(r.effectiveAmount) > 0);
  if (!pendingRow) {
    skip("113. Cannot settle a period still in its grace window (409)",
      closeOn ? "no payable pending row right now" : "period close disabled on this server");
  } else {
    const s113 = await req("POST", `/api/investor/payouts/${pendingRow.id}/status`, { status: "paid" }, ac);
    test("113. Cannot settle a period still in its grace window (409)",
      s113.status === 409 && s113.body?.code === "PERIOD_NOT_FINALIZED");
  }

  // 114. Same period refuses a manual adjustment — its amount is still refreshed
  //      from live earnings on every read, so a manual delta would be counted
  //      twice. Closes a hole the UI has been faking client-side.
  if (!pendingRow) {
    skip("114. Cannot adjust a period still in its grace window (409)",
      closeOn ? "no payable pending row right now" : "period close disabled on this server");
  } else {
    const s114 = await req("PUT", `/api/investor/payouts/${pendingRow.id}/adjust`,
      { adjustment: -1, adjustmentNote: "test-suite: must be rejected" }, ac);
    test("114. Cannot adjust a period still in its grace window (409)",
      s114.status === 409 && s114.body?.code === "PERIOD_NOT_FINALIZED");
  }

  // 115. ...and refuses to publish a statement, for the same reason: the number
  //      is not final yet.
  if (!pendingRow) {
    skip("115. Statement refuses a period still in its grace window (409)",
      closeOn ? "no payable pending row right now" : "period close disabled on this server");
  } else {
    const s115 = await req("GET", `/api/investor/payouts/${pendingRow.period}/statement`, null, ic);
    test("115. Statement refuses a period still in its grace window (409)",
      s115.status === 409 && s115.body?.code === "PERIOD_NOT_FINALIZED");
  }

  // 116. Reopening stays EXEMPT from the window guard. A payout advanced by
  //      mistake yesterday has to be walkable back today, grace window or not —
  //      the same exemption the $0 rule already carries.
  //
  //      WRITE-GATED and one-way on purpose: this reopens a settled payout whose
  //      period is still open, and the restore would be a FORWARD move on a
  //      pending period — which the guard under test correctly refuses. So there
  //      is no way to put the row back, and it must not run unasked against a
  //      shared ledger. (Such a row can only exist as legacy data anyway: with
  //      the feature on, a pending period can never be settled in the first place.)
  const pendingSettled = rows.find(r => r.phase === "pending" && r.status !== "owed");
  if (!RUN_WRITE_TESTS) {
    skip("116. Reopen is exempt from the grace-window guard", "write tests disabled (RUN_WRITE_TESTS=1) — this one cannot be undone");
  } else if (!pendingSettled) {
    skip("116. Reopen is exempt from the grace-window guard",
      closeOn ? "no advanced row inside a grace window (expected — the guard prevents creating one)" : "period close disabled on this server");
  } else {
    const s116 = await req("POST", `/api/investor/payouts/${pendingSettled.id}/status`,
      { status: "owed", reason: "test-suite: reopen must stay possible mid-window" }, ac);
    test("116. Reopen is exempt from the grace-window guard", s116.status === 200);
  }

  // 117. A FINALIZED but UNPAID period issues a real PDF. This is the literal
  //      client ask: "let's not wait till after it's paid to publish a statement".
  const finalUnpaid = rows.find(r => r.phase === "finalized" && r.status !== "paid" && Number(r.effectiveAmount) > 0);
  if (!finalUnpaid) {
    skip("117. Finalized-but-unpaid period issues a statement PDF",
      closeOn ? "no finalized unpaid payable row in seeded data" : "period close disabled on this server");
  } else {
    const s117 = await req("GET", `/api/investor/payouts/${finalUnpaid.period}/statement`, null, ic);
    const ct = (s117.headers && s117.headers["content-type"]) || "";
    const cd = (s117.headers && s117.headers["content-disposition"]) || "";
    test("117. Finalized-but-unpaid period issues a statement PDF",
      s117.status === 200 && /application\/pdf/i.test(ct)
      && typeof s117.body === "string" && s117.body.startsWith("%PDF")
      // Filed as a FINAL statement, not a payout receipt — the two documents
      // must not collide on disk, and the second must not overwrite the first.
      && /Final_Statement/.test(cd));
  }

  // 118. Reopening a period requires a stated reason — it un-freezes figures that
  //      may already sit on a delivered statement. Mirrors test 59's property on
  //      the new period-level surface.
  const anyFinal = rows.find(r => r.phase === "finalized");
  if (!anyFinal) {
    skip("118. Reopening a period requires a reason (400)",
      closeOn ? "no finalized period in seeded data" : "period close disabled on this server");
  } else {
    const s118 = await req("POST", `/api/periods/${anyFinal.period}/reopen`, {}, ac);
    test("118. Reopening a period requires a reason (400)",
      s118.status === 400 && /reason/i.test(s118.body?.error || ""));
  }

  // 119. A month still in progress has no final figure to freeze.
  if (!closeOn) {
    skip("119. Cannot finalize a month that is still in progress (409)", "period close disabled on this server");
  } else {
    const s119 = await req("POST", `/api/periods/${P.currentMonth?.period}/finalize`, {}, ac);
    test("119. Cannot finalize a month that is still in progress (409)",
      s119.status === 409 && s119.body?.code === "PERIOD_ACCRUING");
  }

  // 120. Period routes are Super Admin only — an Investor must not be able to
  //      close or reopen the books.
  const s120a = await req("POST", `/api/periods/2026-01/reopen`, { reason: "nope" }, ic);
  const s120b = await req("GET", "/api/periods", null, ic);
  test("120. Investors cannot close, reopen, or list periods (403)",
    s120a.status === 403 && s120b.status === 403);

  // 121. THE LOAD-BEARING ONE — the lock is real, not decorative.
  //      Log a receipt dated INSIDE a finalized month and prove the month does
  //      not move, the receipt is not lost, and its true date is preserved.
  //      Every other test here proves a guard fires; this proves the feature works.
  if (!RUN_WRITE_TESTS) {
    skip("121. A receipt backdated into a finalized month cannot move it", "write tests disabled (RUN_WRITE_TESTS=1)");
  } else if (!anyFinal) {
    skip("121. A receipt backdated into a finalized month cannot move it",
      closeOn ? "no finalized period in seeded data" : "period close disabled on this server");
  } else {
    const before = (await req("GET", "/api/investor/payouts", null, ic)).body || {};
    const beforeRow = (before.payouts || []).find(r => r.period === anyFinal.period);
    const beforeCur = Number(before.currentMonth?.amountInProgress ?? 0);

    const post = await req("POST", "/api/expenses", {
      driver: "test", type: "Fuel", amount: 137.42,
      date: `${anyFinal.period}-15`,
      vendor: `test-suite closed-period ${Date.now()}`,
    }, ac);

    const after = (await req("GET", "/api/investor/payouts", null, ic)).body || {};
    const afterRow = (after.payouts || []).find(r => r.period === anyFinal.period);

    // "Not lost" is checked on the expense row itself, NOT on this investor's
    // accrual. The receipt is logged against a generic test driver who is not in
    // any particular investor's driver set, so it correctly never enters their
    // P&L — asserting their current month moved would be asserting a
    // cross-investor leak, i.e. the opposite of what should happen.
    const saved = (await req("GET", `/api/expenses/all?driver=test`, null, ac)).body;
    const savedRow = (Array.isArray(saved) ? saved : saved?.expenses || [])
      .find(e => e.id === post.body?.id);

    test("121. A receipt backdated into a finalized month cannot move it",
      post.status === 200
      // The server states where it booked it rather than moving money silently.
      && post.body?.periodClosed === true
      && post.body?.postedPeriod === after.currentMonth?.period
      && post.body?.naturalPeriod === anyFinal.period
      // THE property: the frozen figure is byte-identical.
      && Number(afterRow?.amount) === Number(beforeRow?.amount)
      && Number(afterRow?.effectiveAmount) === Number(beforeRow?.effectiveAmount)
      // ...and nothing was lost: the row persisted, keeps its true purchase date,
      // and carries the redirect that moved it into the open month.
      && !!savedRow
      && savedRow.date === `${anyFinal.period}-15`
      && savedRow.posted_period === after.currentMonth?.period);
  }

  // ==========================================================================
  // 122-134. Completed-loads CSV export — GET /api/loads/completed/export
  //
  // Contract (fixed up front; these tests were written BEFORE the route existed):
  //   Super Admin only · driver/from/to all optional · 200 => text/csv +
  //   attachment disposition · 9 fixed columns in a fixed order · CRLF row
  //   endings · every cell quoted · a value starting with = + - @ or TAB is
  //   emitted with a leading ' (spreadsheet formula-injection guard) ·
  //   malformed or inverted dates 400 · no matching rows 404 · exportLimiter.
  //
  // ⚠️ READ BEFORE DEBUGGING A FAILURE HERE. This server mounts an SPA
  // catch-all (app.get("*") -> index.html), so a route that does NOT exist yet
  // answers **200 with text/html** — not 404. Status alone is therefore a
  // worthless assertion on this endpoint: `res.status === 200` passes against a
  // route nobody has written. Every test below also checks the content-type /
  // body shape, and notRouted() turns "the feature hasn't landed" into a loud,
  // named failure instead of a baffling mismatch.
  //
  // Read-only endpoint: nothing here mutates shared state, so none of it is
  // behind RUN_WRITE_TESTS.
  // ==========================================================================
  const EXPORT_PATH = "/api/loads/completed/export";
  const EXPORT_COLS = ["Load ID", "Job Status", "Driver", "Truck", "Pickup",
    "Drop-off", "Assigned Date", "Delivery Date", "Payment"];
  // Leading chars Excel/Sheets will evaluate as a formula (tab included: it is
  // stripped on paste, promoting whatever follows it to the front of the cell).
  const CSV_DANGER = /^[=+\-@\t]/;

  // The SPA fallback answers any unrouted GET, including /api/*, with 200 HTML.
  function notRouted(r) {
    if (!r) return true;
    if (/text\/html/i.test(String((r.headers || {})["content-type"] || ""))) return true;
    return typeof r.body === "string" && /^\s*<!doctype html/i.test(r.body);
  }

  // RFC 4180 reader. Records per-cell "was it quoted?" and per-row "what
  // terminated it?", because both are contract terms here — asserting them by
  // regex over the raw text would misfire on a newline legitimately embedded
  // inside a quoted address cell.
  function parseCsv(text) {
    const rows = [], terms = [];
    let row = [], cell = "", quoted = false, inQ = false, i = 0;
    const endCell = () => { row.push({ v: cell, quoted }); cell = ""; quoted = false; };
    const endRow = t => { endCell(); rows.push(row); terms.push(t); row = []; };
    while (i < text.length) {
      const ch = text[i];
      if (inQ) {
        if (ch === '"') {
          if (text[i + 1] === '"') { cell += '"'; i += 2; continue; }
          inQ = false; i += 1; continue;
        }
        cell += ch; i += 1; continue;
      }
      if (ch === '"') { inQ = true; quoted = true; i += 1; continue; }
      if (ch === ",") { endCell(); i += 1; continue; }
      if (ch === "\r" && text[i + 1] === "\n") { endRow("\r\n"); i += 2; continue; }
      if (ch === "\n") { endRow("\n"); i += 1; continue; }
      if (ch === "\r") { endRow("\r"); i += 1; continue; }
      cell += ch; i += 1;
    }
    if (row.length || cell !== "" || quoted) endRow("EOF");
    return { rows, terms };
  }

  async function getExport(qs, cookies) {
    const r = await req("GET", EXPORT_PATH + (qs || ""), null, cookies === undefined ? ac : cookies);
    const ct = String((r.headers || {})["content-type"] || "");
    const isCsv = r.status === 200 && /text\/csv/i.test(ct) && typeof r.body === "string";
    // A leading BOM is a legitimate Excel-friendliness choice; strip it before
    // parsing so it can't fail the header assertion on its own.
    const parsed = isCsv ? parseCsv(r.body.replace(/^\uFEFF/, "")) : { rows: [], terms: [] };
    return {
      res: r, ct, isCsv, rows: parsed.rows, terms: parsed.terms,
      header: (parsed.rows[0] || []).map(c => c.v),
      data: parsed.rows.slice(1),
      col(name) { return this.header.indexOf(name); },
      cells(name) {
        const i = this.header.indexOf(name);
        return i < 0 ? [] : this.data.map(r2 => (r2[i] ? r2[i].v : ""));
      },
    };
  }
  const jsonErr = r => !!r && !!r.body && typeof r.body === "object"
    && ("error" in r.body || "code" in r.body);

  const xp = await getExport("");
  if (notRouted(xp.res)) {
    console.log("\n  NOTE: " + EXPORT_PATH + " is not routed yet — the SPA catch-all answered "
      + xp.res.status + " " + (String((xp.res.headers || {})["content-type"] || "?").split(";")[0])
      + ". Tests 122-134 FAIL (they do not skip) until the route lands — that is intended.\n");
  }

  // 122. Transport contract: a CSV file, delivered as a download. The
  //      disposition is what makes a browser save it instead of rendering it.
  const xpDisp = String((xp.res.headers || {})["content-disposition"] || "");
  test("122. No-param export returns 200 text/csv as a named attachment",
    xp.res.status === 200
    && /text\/csv/i.test(xp.ct)
    && /^\s*attachment\s*;\s*filename\s*=\s*"?[^";]+"?/i.test(xpDisp)
    && typeof xp.res.body === "string" && xp.res.body.length > 0);

  // 123. The column set is the contract — downstream spreadsheets index by
  //      position, so order matters as much as membership.
  test("123. Header row is exactly the 9 contract columns, in order",
    xp.header.length === 9 && EXPORT_COLS.every((c, i) => xp.header[i] === c));

  // 124. RFC 4180 shape: CRLF terminators, every cell quoted (header included),
  //      every row exactly 9 fields wide. A row that is not 9 wide means an
  //      unescaped comma leaked out of a cell and shifted every column after it.
  const termsOk = xp.terms.length > 0 && xp.terms.every(t => t === "\r\n" || t === "EOF");
  const quotedOk = xp.rows.length > 0 && xp.rows.every(r => r.every(c => c.quoted));
  const widthOk = xp.rows.length > 0 && xp.rows.every(r => r.length === 9);
  test("124. CRLF row endings, every cell quoted, every row 9 fields wide",
    xp.isCsv && termsOk && quotedOk && widthOk);

  // 125. ?driver= filter. The driver is taken from the live completed set
  //      rather than hardcoded — a fixed name 404s on any other database.
  const completedRows = Array.isArray(dash.body?.completedJobs) ? dash.body.completedJobs : [];
  const drvCounts = {};
  for (const r of completedRows) {
    const k = Object.keys(r || {}).find(x => /^driver$/i.test(x));
    const v = k ? String(r[k] || "").trim() : "";
    if (v) drvCounts[v] = (drvCounts[v] || 0) + 1;
  }
  const xpDriver = Object.keys(drvCounts).sort((a, b) => drvCounts[b] - drvCounts[a])[0] || null;
  if (!xpDriver) {
    skip("125. ?driver= returns that driver's rows and nobody else's",
      "no completed load in dashboard data carries a driver name");
  } else {
    const xpD = await getExport("?driver=" + encodeURIComponent(xpDriver));
    const drvCells = xpD.cells("Driver");
    // Compared on the server's own normalization (trim + lowercase + collapse
    // runs of whitespace). The filter is deliberately tolerant of the
    // double-space and casing drift in older sheet rows, so a byte-exact
    // comparison here would fail on rows the endpoint is RIGHT to include.
    // A genuinely different driver still fails this.
    const normName = s => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
    test("125. ?driver= returns that driver's rows and nobody else's (" + xpDriver + ")",
      xpD.isCsv && xpD.col("Driver") >= 0 && drvCells.length > 0
      && drvCells.every(v => normName(v) === normName(xpDriver)));
  }

  // 126. A date range narrows. Asserted as a SUBSET rather than an exact count,
  //      because the contract does not say which date column is filtered on —
  //      but whichever it is, a filtered export may never invent a load that the
  //      unfiltered one does not contain. 404 (narrowed to nothing) is a legal
  //      outcome of the range, so it counts as zero rows rather than failing.
  const xpRange = await getExport("?from=2026-01-01&to=2026-01-31");
  const allIds = new Set(xp.cells("Load ID").map(v => v.replace(/^'/, "").trim()));
  const rangeIds = xpRange.cells("Load ID").map(v => v.replace(/^'/, "").trim());
  const rangeLegal = xpRange.isCsv || xpRange.res.status === 404;
  test("126. A date range returns a subset of the unfiltered export",
    xp.isCsv && rangeLegal
    && xpRange.data.length <= xp.data.length
    && rangeIds.every(id => allIds.has(id)));

  // 127. THE LOAD-BEARING ONE — spreadsheet formula injection.
  //      A broker-supplied cell like "-45886" or "=HYPERLINK(...)" is a live
  //      formula the moment this file is opened in Excel; the guard prefixes it
  //      with an apostrophe so it renders as text. Three outcomes, no vacuous
  //      pass: a raw dangerous cell FAILS, a neutralised one PASSES, and data
  //      containing neither SKIPS with the reason stated.
  const xpCells = xp.data.reduce((a, r) => a.concat(r), []);
  const rawDanger = xpCells.filter(c => CSV_DANGER.test(c.v));
  const neutralised = xpCells.filter(c => c.v.startsWith("'") && CSV_DANGER.test(c.v.slice(1)));
  if (!xp.isCsv) {
    // Not routed, or not CSV. Must not be skipped — an unwritten guard is
    // exactly what this test exists to catch.
    test("127. Cells starting with = + - @ or TAB are neutralised with a leading '", false);
  } else if (xp.data.length === 0) {
    skip("127. Cells starting with = + - @ or TAB are neutralised with a leading '",
      "export returned a header row but no data rows to inspect");
  } else if (rawDanger.length > 0) {
    console.log("  NOTE (127): " + rawDanger.length + " unescaped cell(s), e.g. "
      + rawDanger.slice(0, 3).map(c => JSON.stringify(c.v.slice(0, 30))).join(", "));
    test("127. Cells starting with = + - @ or TAB are neutralised with a leading '", false);
  } else if (neutralised.length > 0) {
    test("127. Cells starting with = + - @ or TAB are neutralised with a leading '", true);
  } else {
    // Honest skip — and point at where a fixture could come from, since the
    // source data DOES contain such values in columns this export may not carry.
    const srcFields = [...new Set(completedRows.flatMap(r =>
      Object.entries(r || {}).filter(([, v]) => v != null && CSV_DANGER.test(String(v))).map(([k]) => k)))];
    skip("127. Cells starting with = + - @ or TAB are neutralised with a leading '",
      "no exported cell begins with = + - @ or tab, so the guard is never exercised"
      + (srcFields.length
        ? " (such values DO exist upstream in " + srcFields.join(", ")
          + " — seed one into an exported column to make this test real)"
        : " (and no completed-load field upstream contains one either)"));
  }

  // 128. Investor is forbidden. Not merely "no CSV" — an explicit 403.
  const xpInvRes = await req("GET", EXPORT_PATH, null, ic);
  test("128. Export blocked for Investor (403)",
    xpInvRes.status === 403 && !/text\/csv/i.test(String((xpInvRes.headers || {})["content-type"] || "")));

  // 129. Dispatcher is forbidden too. This suite only establishes Super Admin +
  //      Investor sessions, so the branch is opt-in via env vars, mirroring
  //      TEST_ADMIN_USER / TEST_INVESTOR_USER. Left as a stated gap otherwise —
  //      the Dispatcher path is genuinely untested without credentials.
  const DISPATCHER_USER = process.env.TEST_DISPATCHER_USER || "";
  const DISPATCHER_PASS = process.env.TEST_DISPATCHER_PASS || "";
  if (!DISPATCHER_USER || !DISPATCHER_PASS) {
    skip("129. Export blocked for Dispatcher (403)",
      "no dispatcher credentials — set TEST_DISPATCHER_USER / TEST_DISPATCHER_PASS to cover this branch");
  } else {
    const dLogin = await req("POST", "/api/auth/login", { username: DISPATCHER_USER, password: DISPATCHER_PASS });
    if (dLogin.status !== 200 || !dLogin.cookies) {
      skip("129. Export blocked for Dispatcher (403)",
        "TEST_DISPATCHER_USER login failed (" + dLogin.status + ") — branch not exercised");
    } else {
      const xpDis = await req("GET", EXPORT_PATH, null, dLogin.cookies);
      test("129. Export blocked for Dispatcher (403)", xpDis.status === 403);
    }
  }

  // 130. No session at all is 401, not 403 and not a silent SPA 200.
  const xpAnon = await req("GET", EXPORT_PATH);
  test("130. Export blocked without a session (401)",
    xpAnon.status === 401 && !/text\/csv/i.test(String((xpAnon.headers || {})["content-type"] || "")));

  // 131. Malformed dates are rejected, not coerced. "2026-8-3" is the one that
  //      matters: it is a real date a human would type, and a lenient parser
  //      accepts it while a YYYY-MM-DD contract does not.
  const badFrom = await req("GET", EXPORT_PATH + "?from=notadate", null, ac);
  const badTo = await req("GET", EXPORT_PATH + "?to=08%2F03%2F2026", null, ac);
  const badPad = await req("GET", EXPORT_PATH + "?from=2026-8-3", null, ac);
  test("131. Malformed from/to dates are rejected with 400 JSON",
    [badFrom, badTo, badPad].every(r => r.status === 400 && jsonErr(r)));

  // 132. An inverted range is rejected — AND the single-day boundary (to ===
  //      from) is not. A `to <= from` check would pass the first half of this
  //      and quietly break every one-day export.
  const invRange = await req("GET", EXPORT_PATH + "?from=2026-06-01&to=2026-05-01", null, ac);
  const sameDay = await req("GET", EXPORT_PATH + "?from=2026-06-01&to=2026-06-01", null, ac);
  test("132. 'to' before 'from' is 400, but to === from is a legal one-day range",
    invRange.status === 400 && jsonErr(invRange)
    && (sameDay.status === 200 || sameDay.status === 404));

  // 133. No matching rows is a 404 JSON, not a 200 with a lone header row —
  //      a header-only CSV looks like a successful empty export to the user.
  const noMatch = await req("GET", EXPORT_PATH + "?driver=" + encodeURIComponent("QA No Such Driver 9999"), null, ac);
  test("133. No matching rows returns 404 JSON (never a header-only 200)",
    noMatch.status === 404 && jsonErr(noMatch));

  // 134. exportLimiter is actually mounted. This server has no global limiter
  //      (an unlimited route emits no RateLimit-* headers at all), so their
  //      presence on this response is specific evidence the limiter is wired —
  //      checkable without burning the window the way a flood test would.
  const xpHdrs = xp.res.headers || {};
  test("134. exportLimiter is wired (RateLimit-* headers present)",
    "ratelimit-limit" in xpHdrs || "x-ratelimit-limit" in xpHdrs);

  // 135-136. The escaper itself, exercised directly (no server, no fixtures) —
  //          this is what makes the injection guard genuinely covered rather
  //          than dependent on whether today's sheet happens to hold a hostile
  //          value. Test 127 remains the end-to-end proof that the export
  //          actually routes its cells through this.
  if (!csvLib || typeof csvLib.csvCell !== "function" || typeof csvLib.csvRows !== "function") {
    skip("135. csvCell prefixes = + - @ TAB with ' and leaves safe values alone",
      "lib/csv.js not loadable from this checkout");
    skip("136. csvRows joins rows with CRLF and never lets a cell shift a column",
      "lib/csv.js not loadable from this checkout");
  } else {
    const { csvCell, csvRows } = csvLib;
    // Every lead character a spreadsheet evaluates must come back inert. The
    // "-45886" case is not hypothetical: that exact value sits in the seeded
    // completed-loads data today.
    const danger = ['=HYPERLINK("http://evil","click")', "+1+1", "-45886", "@SUM(A1)", "\tinjected"];
    const guarded = danger.every(v => csvCell(v) === '"\'' + v.replace(/"/g, '""') + '"');
    // ...and a benign value must NOT be mangled. Over-escaping is its own bug:
    // a Payment cell that came back as "'$ 1,800.00" would break every sum.
    const safe = ["$ 1,800.00", "Lesline Johnson", "AMES, IA 50010", "2026-08-03", ""];
    const untouched = safe.every(v => csvCell(v) === '"' + v + '"');
    const nullish = csvCell(null) === '""' && csvCell(undefined) === '""';
    test("135. csvCell prefixes = + - @ TAB with ' and leaves safe values alone",
      guarded && untouched && nullish);

    // A quote, a comma and a dangerous lead in one table: the row must stay
    // three lines and two columns wide, or every column after it shifts.
    const body = csvRows([["Load ID", "Driver"], ["7083240", 'Say "hi", now'], ["-45886", null]]);
    const lines = body.split("\r\n");
    test("136. csvRows joins rows with CRLF and never lets a cell shift a column",
      lines.length === 3
      && lines[0] === '"Load ID","Driver"'
      && lines[1] === '"7083240","Say ""hi"", now"'
      && lines[2] === '"\'-45886",""'
      && !/(^|[^\r])\n/.test(body));
  }

  // ==========================================================================
  // 137-142. period_locks UNREADABLE — all three money guards must still refuse.
  //
  // WHAT IS UNDER TEST. Three routes refuse to act on a month they cannot
  // confirm is closed, and all three are fail-CLOSED BY ACCIDENT — each one
  // reaches the right answer through a different double negative, and none of
  // them is written in a way that says so.
  //
  //   (a) POST /api/investor/payouts/:id/status  (settle)   } both gate on
  //   (b) PUT  /api/investor/payouts/:id/adjust  (adjust)   } isPending(period)
  //         isLocked(p)   answers false on ANY error, including an unreadable table
  //      -> isPending(p)  is therefore TRUE for a past month it cannot look up
  //      -> the guard fires, and settling into a possibly-closed month is refused.
  //      server.js names the exact wrong refactor: rewriting either as
  //      `periodPhase(p) === 'pending'` — periodPhase returns '' when the table
  //      cannot be read, which reads as "not pending", so the guard stops firing
  //      and the failure direction INVERTS silently.
  //
  //   (c) GET /api/investor/payouts/:period/statement — a DIFFERENT expression,
  //      `!isLocked(period) && row.status !== 'paid'`, i.e. publish only when the
  //      period is confirmed locked or the money already moved. Unreadable table
  //      -> isLocked false -> !isLocked true -> an unpaid period is refused. Also
  //      correct, also by accident. ⚠️ Its adversary is NOT periodPhase (which
  //      happens to be safe here) but the tempting "harmonize it with the other
  //      two" edit: periodWriteLocked() means "don't WRITE here" (!readable ||
  //      isLocked) while this route needs "can't confirm finalized" (!readable ||
  //      !isLocked). On an unreadable table those resolve OPPOSITE ways, so
  //      `!periodWriteLocked(period) && …` starts publishing FINAL statements
  //      during exactly the outage that should suppress them.
  //
  // A comment is not a test: until this block nothing failed if someone tidied
  // any of the three, and the failure modes are a $1,000 payout stamped paid into
  // a month whose lock state is unknown (with `success: true` on the wire), and a
  // PDF telling an investor a figure is FINAL when nothing was ever closed.
  //
  // WHY THIS BRINGS ITS OWN SERVER. Two preconditions cannot be met against the
  // server the rest of this suite targets:
  //   1. PERIOD_FINALIZE_ENABLED must be ON. isPending() returns false
  //      unconditionally while the flag is off, so on a dormant server neither
  //      guard fires and a 409 assertion would pass for the wrong reason — which
  //      is worse than no test, because it reads as coverage.
  //   2. period_locks has to be genuinely unreadable, and that is a SCHEMA
  //      fault, not a row: the table is rebuilt without its `status` column so
  //      `SELECT status FROM period_locks` throws on execution, while
  //      `CREATE TABLE IF NOT EXISTS` sees a table already there and repairs
  //      nothing. There is no HTTP surface that inflicts that, and doing it to
  //      the target's database would corrupt whichever ledger the operator is
  //      pointed at.
  // So this block boots server.js on an OS-assigned free port against a
  // throwaway SQLite file, seeds the two rows it needs, breaks the table, and
  // kills the child. It never touches the target server, its database, or its
  // rate limiters — which also means it is unaffected by the "no two runs inside
  // 15 minutes" rule the rest of the suite lives under.
  //
  // Tests 113/114/115 already cover the ORDINARY pending case (readable table,
  // month inside its grace window) against the target server, and 117 covers a
  // real statement PDF end-to-end. This block covers the one thing none of them
  // can reach: the lock table itself being unreadable.
  //
  // Opt out with SKIP_LOCK_FAULT_TEST=1. It spawns a process, and the child's
  // boot pre-warm reads the configured spreadsheet once.
  //
  // Ordering is forced, not stylistic: every healthy-table control has to run
  // BEFORE the table is broken, so the controls are 137-138 and the refusals are
  // 139-142 rather than being grouped per route.
  const lockFaultNames = [
    "137. Settle and adjust are ALLOWED while period_locks is readable (positive control)",
    "138. Statement gets PAST the lock guard while period_locks is readable (positive control)",
    "139. Settle is REFUSED when period_locks cannot be read (409 PERIOD_NOT_FINALIZED)",
    "140. Adjust is REFUSED when period_locks cannot be read (409 PERIOD_NOT_FINALIZED)",
    "141. Statement is REFUSED when period_locks cannot be read (409 PERIOD_NOT_FINALIZED)",
    "142. A PAID period still issues its statement when period_locks cannot be read",
  ];
  const lockFaultSkip = (why) => lockFaultNames
    .filter(n => !results.some(r => r.name === n))
    .forEach(n => skip(n, why));
  // The child's own explanation of why it died — the difference between "could
  // not boot" and "could not boot BECAUSE the service account key is missing" is
  // the whole value of the skip reason. server.js prints a banner of ~12 endpoint
  // lines immediately before it dies, so a naive tail returns the banner and
  // buries the cause; prefer lines that look like a diagnosis, fall back to the
  // tail only if none do.
  const tailOf = (s) => {
    const lines = String(s).split("\n").map(l => l.trim()).filter(Boolean);
    const loud = lines.filter(l => /error|fail|cannot|exit|refus|denied|ENOENT|EADDR/i.test(l));
    return (loud.length ? loud : lines).slice(-3).join(" | ").slice(0, 300);
  };

  if (process.env.SKIP_LOCK_FAULT_TEST === "1") {
    lockFaultSkip("SKIP_LOCK_FAULT_TEST=1");
  } else if (!sqliteDriver) {
    lockFaultSkip("better-sqlite3 not loadable from this checkout");
  } else if (!fs.existsSync(path.join(__dirname, "server.js"))) {
    lockFaultSkip("server.js not found beside test-suite.js");
  } else {
    let child = null, sdb = null, scratchDir = "", childLog = "", childExited = false;
    try {
      scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "logisx-lockfault-"));
      const scratchDbPath = path.join(scratchDir, "lockfault.db");

      // Let the OS name a free port rather than guessing one: the suite may well
      // be running beside a dev stack, a staging process and a sibling worktree.
      const scratchPort = await new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.on("error", reject);
        probe.listen(0, "127.0.0.1", () => {
          const p = probe.address().port;
          probe.close(() => resolve(p));
        });
      });

      child = spawn(process.execPath, [path.join(__dirname, "server.js")], {
        cwd: __dirname,
        env: {
          ...process.env,
          // The three settings this test exists for. dotenv does not override an
          // env var that is already set, so these beat anything in .env.
          DATABASE_PATH: scratchDbPath,
          PERIOD_FINALIZE_ENABLED: "true",
          PORT: String(scratchPort),
          // Its own signing key, and dev mode so the login cookie is not marked
          // Secure (a Secure cookie over plain http never comes back, and every
          // authenticated request below would 401).
          SESSION_SECRET: "test-suite-period-lock-fault",
          NODE_ENV: "development",
          // Everything that could reach the outside world or spend money, off.
          // GOOGLE_MAPS_API_KEY especially: the boot sweep geocodes every address
          // on the sheet that is missing from geocode_cache, and a brand-new
          // scratch database has an empty one — that is a billed call per address.
          GOOGLE_MAPS_API_KEY: "",
          GMAIL_USER: "",
          GMAIL_APP_PASSWORD: "",
          RATECON_RECONCILE_ENABLED: "false",
          INVOICE_AUTOGEN_ENABLED: "false",
          ROUTEMATE_ENABLED: "false",
          LINXUP_ENABLED: "false",
          FUEL_EVENTS_ENABLED: "false",
          SCANKIT_ENABLED: "false",
          MAINTENANCE_NOTICE_ENABLED: "false",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", d => { childLog += d; });
      child.stderr.on("data", d => { childLog += d; });
      child.on("exit", () => { childExited = true; });

      // server.js EXITS if it cannot reach Google Sheets, so "did not come up"
      // is a real outcome here, not a hypothetical. Poll until it answers.
      const bootDeadline = Date.now() + 60000;
      let booted = false;
      while (Date.now() < bootDeadline && !childExited) {
        try {
          const h = await req("GET", "/api/auth/setup-check", null, null, scratchPort);
          if (h.status === 200) { booted = true; break; }
        } catch { /* not listening yet */ }
        await new Promise(r => setTimeout(r, 250));
      }
      if (!booted) {
        throw new Error((childExited ? "server.js exited during boot" : "server.js did not answer in 60s")
          + " — " + tailOf(childLog));
      }

      // Fresh database, so the first-run setup route is what mints the admin —
      // no password hashing in the harness, and no dependence on the fixture
      // accounts the rest of the suite logs in with.
      const scratchUser = "lockfault_admin", scratchPass = "Password123!";
      const setup = await req("POST", "/api/auth/setup", { username: scratchUser, password: scratchPass }, null, scratchPort);
      if (setup.status !== 200) throw new Error("scratch setup returned " + setup.status);
      const scratchLogin = await req("POST", "/api/auth/login", { username: scratchUser, password: scratchPass }, null, scratchPort);
      if (scratchLogin.status !== 200 || !scratchLogin.cookies) throw new Error("scratch login returned " + scratchLogin.status);
      const sc = scratchLogin.cookies;

      // The statement route is Super-Admin-forbidden without ?as_user_id= and
      // resolvePreviewUser only accepts a real Investor's users.id, so the
      // statement half of this block needs an actual Investor account. Created
      // through the app's own route rather than by hashing a password here.
      const invUser = "lockfault_investor";
      const mkInv = await req("POST", "/api/users",
        { username: invUser, password: scratchPass, role: "Investor", fullName: "Lock Fault Investor", companyName: "Lock Fault LLC" },
        sc, scratchPort);
      if (mkInv.status !== 200) throw new Error("scratch investor create returned " + mkInv.status);
      const invLoginScratch = await req("POST", "/api/auth/login", { username: invUser, password: scratchPass }, null, scratchPort);
      if (invLoginScratch.status !== 200 || !invLoginScratch.cookies) throw new Error("scratch investor login returned " + invLoginScratch.status);
      const sci = invLoginScratch.cookies;

      // Read-WRITE, deliberately. A read-only handle on a WAL database serves
      // whatever the main file last held and silently misses everything still in
      // the -wal — which here would mean seeding rows the server never sees.
      sdb = new sqliteDriver(scratchDbPath);

      // FIXTURE REPAIR, not a workaround for this test's own convenience. On a
      // BRAND-NEW database drivers_directory.pay_daily does not exist: server.js
      // runs `ALTER TABLE drivers_directory ADD COLUMN pay_daily` ~360 lines
      // BEFORE the CREATE TABLE that makes drivers_directory, so the ALTER throws
      // "no such table", the bare catch swallows it, and the CREATE never adds the
      // column. Every real deployment has it (there the ALTER ran when the table
      // already existed), so a scratch DB without it is the ONE way this database
      // differs from production — and reconcileInvestorPayouts selects it, which
      // would 500 every statement request below for a reason that has nothing to
      // do with period locks. Adding it makes the fixture match production.
      // The app bug is real and reported separately; this line is not its fix.
      try { sdb.exec("ALTER TABLE drivers_directory ADD COLUMN pay_daily REAL DEFAULT 0"); } catch {}

      const ownerId = sdb.prepare("SELECT id FROM users WHERE LOWER(username) = LOWER(?)").get(scratchUser).id;
      const invOwnerId = sdb.prepare("SELECT id FROM users WHERE LOWER(username) = LOWER(?)").get(invUser).id;
      const stamp = new Date().toISOString();

      // A period each, because investor_payouts is UNIQUE(owner_id, period).
      // EVERY one of them is a long-past month and EVERY one is LOCKED, so on a
      // healthy table isPending() is false and isLocked() is true throughout —
      // no guard here has any reason to fire until the table breaks. That is what
      // makes the 409s below attributable to the fault and nothing else: not a $0
      // row, not a still-open window, not a bad session.
      const CONTROL_PERIOD = "2020-01", FAULT_PERIOD = "2020-02";
      const STMT_CONTROL_PERIOD = "2020-04", STMT_FAULT_PERIOD = "2020-05", STMT_PAID_PERIOD = "2020-06";
      const ALL_PERIODS = [CONTROL_PERIOD, FAULT_PERIOD, STMT_CONTROL_PERIOD, STMT_FAULT_PERIOD, STMT_PAID_PERIOD];
      const insLock = sdb.prepare("INSERT OR REPLACE INTO period_locks (period, status, finalized_at, finalized_by) VALUES (?, 'locked', ?, 'test-suite')");
      const insPayout = sdb.prepare("INSERT INTO investor_payouts (owner_id, period, amount, due_date, status) VALUES (?, ?, 1000, ?, 'owed')");
      ALL_PERIODS.forEach(p => insLock.run(p, stamp));
      const controlId = insPayout.run(ownerId, CONTROL_PERIOD, CONTROL_PERIOD + "-15").lastInsertRowid;
      const faultId = insPayout.run(ownerId, FAULT_PERIOD, FAULT_PERIOD + "-15").lastInsertRowid;

      // The statement rows are deliberately worth $0 NET (1000 with a -1000
      // correction). The route checks the lock guard FIRST and the "nets to $0"
      // rule several steps later, so a zeroed row turns "got past the lock guard"
      // into a distinct, instant, positively-identifiable answer —
      // 409 PAYOUT_NOT_SETTLEABLE — instead of a 30-second Puppeteer render that
      // cannot complete on most developer machines anyway (it is why test 106
      // fails locally today). Asserting a POSITIVE marker beats asserting the
      // absence of one, and this keeps the whole block at a couple of seconds.
      // Producing a real PDF end-to-end is test 117's job, against the real server.
      const zeroOut = sdb.prepare("UPDATE investor_payouts SET adjustment = -1000 WHERE id = ?");
      const stmtControlId = insPayout.run(invOwnerId, STMT_CONTROL_PERIOD, STMT_CONTROL_PERIOD + "-15").lastInsertRowid;
      const stmtFaultId = insPayout.run(invOwnerId, STMT_FAULT_PERIOD, STMT_FAULT_PERIOD + "-15").lastInsertRowid;
      const stmtPaidId = insPayout.run(invOwnerId, STMT_PAID_PERIOD, STMT_PAID_PERIOD + "-15").lastInsertRowid;
      [stmtControlId, stmtFaultId, stmtPaidId].forEach(id => zeroOut.run(id));
      sdb.prepare("UPDATE investor_payouts SET status = 'paid', paid_at = ?, paid_by = 'test-suite' WHERE id = ?")
        .run(stamp, stmtPaidId);

      // 137. POSITIVE CONTROL, and it is not decoration: without it, tests 138
      //      and 139 would still pass on a server where the flag was off, the
      //      seed had failed, or every payout write 409s for some unrelated
      //      reason. This pins "these rows are settleable and adjustable right
      //      now" before anything is broken.
      const cAdj = await req("PUT", `/api/investor/payouts/${controlId}/adjust`,
        { adjustment: -1, adjustmentNote: "test-suite: control, must be accepted" }, sc, scratchPort);
      const cSet = await req("POST", `/api/investor/payouts/${controlId}/status`, { status: "paid" }, sc, scratchPort);
      test(lockFaultNames[0], cAdj.status === 200 && cSet.status === 200);

      // 138. The statement route's own positive control. Same period shape as the
      //      one the fault is aimed at — past, LOCKED, unpaid — so the lock guard
      //      has nothing to fire on and the request travels past it. The proof it
      //      travelled is PAYOUT_NOT_SETTLEABLE, a check that lives several steps
      //      DOWNSTREAM of the guard and could not possibly answer if the guard
      //      had returned. Without this, test 141 would still pass on a server
      //      where every statement request 409s for an unrelated reason.
      const cStmt = await req("GET", `/api/investor/payouts/${STMT_CONTROL_PERIOD}/statement`, null, sci, scratchPort);
      test(lockFaultNames[1],
        cStmt.status === 409
        && cStmt.body?.code === "PAYOUT_NOT_SETTLEABLE");

      // THE FAULT. Rebuild period_locks without its `status` column. better-sqlite3
      // resolves columns at prepare() time and SQLite re-compiles a cached
      // statement after a schema change, so the server's cached
      // `SELECT status FROM period_locks WHERE period = ?` starts throwing on its
      // very next execution — no restart, no reconnect. Every row is re-inserted
      // so the DATA still says these periods are closed: if anything were somehow
      // able to read the table it would conclude 'finalized' and NOT refuse. A
      // refusal below can therefore only have come from the unreadable path.
      sdb.exec("DROP TABLE period_locks");
      sdb.exec("CREATE TABLE period_locks (period TEXT PRIMARY KEY, finalized_at TEXT, finalized_by TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
      const insBrokenLock = sdb.prepare("INSERT INTO period_locks (period, finalized_at, finalized_by) VALUES (?, ?, 'test-suite')");
      ALL_PERIODS.forEach(p => insBrokenLock.run(p, stamp));

      // 139. Settle must refuse — and the row must be untouched. The status code
      //      alone is not enough: `periodLockUnreadable` is only set when
      //      periodLocksReadable() comes back false, so asserting it is what
      //      proves the fault landed rather than the guard firing for some other
      //      reason. The database read afterwards is the one that matters most:
      //      under the inverted guard this row comes back 'paid'.
      const fSet = await req("POST", `/api/investor/payouts/${faultId}/status`, { status: "paid" }, sc, scratchPort);
      const afterSet = sdb.prepare("SELECT status, paid_at FROM investor_payouts WHERE id = ?").get(faultId);
      test(lockFaultNames[2],
        fSet.status === 409
        && fSet.body?.code === "PERIOD_NOT_FINALIZED"
        && fSet.body?.periodLockUnreadable === true
        && afterSet.status === "owed"
        && !afterSet.paid_at);

      // 140. Same for the adjust guard, which fails closed by the same double
      //      negative and would invert with the same refactor.
      const fAdj = await req("PUT", `/api/investor/payouts/${faultId}/adjust`,
        { adjustment: -500, adjustmentNote: "test-suite: must be rejected" }, sc, scratchPort);
      const afterAdj = sdb.prepare("SELECT adjustment FROM investor_payouts WHERE id = ?").get(faultId);
      test(lockFaultNames[3],
        fAdj.status === 409
        && fAdj.body?.code === "PERIOD_NOT_FINALIZED"
        && fAdj.body?.periodLockUnreadable === true
        && Number(afterAdj.adjustment) === 0);

      // 141. THE THIRD GUARD. Same fault, different expression, and the one whose
      //      naive "fix" is most tempting: `!periodWriteLocked(period) && …`
      //      resolves the OPPOSITE way on an unreadable table and would publish a
      //      FINAL statement for a month nobody ever closed. Note this route's
      //      409 carries no `periodLockUnreadable` flag (unlike the other two), so
      //      the discrimination comes from elsewhere: `graceEndsAt` is present
      //      only when isPending() was true, and test 138 has already proven this
      //      exact request shape sails past the guard while the table is readable.
      const fStmt = await req("GET", `/api/investor/payouts/${STMT_FAULT_PERIOD}/statement`, null, sci, scratchPort);
      test(lockFaultNames[4],
        fStmt.status === 409
        && fStmt.body?.code === "PERIOD_NOT_FINALIZED"
        && fStmt.body?.period === STMT_FAULT_PERIOD
        && !!fStmt.body?.graceEndsAt);

      // 142. ...and the refusal is TARGETED, not a blanket outage failure. The
      //      `|| paid` half of the guard is what keeps every historical paid month
      //      printable, including months that predate period_locks entirely, and
      //      it must keep working while the table is down — a PAID statement
      //      asserts that money moved, a fact that comes from paid_at and owes
      //      nothing to the lock table. This runs DURING the fault with the fault
      //      held constant, which is what rules out "everything 409s right now"
      //      as the explanation for 141. It also pins today's behaviour against a
      //      future "fix" that hardens this route into refusing everything.
      const pStmt = await req("GET", `/api/investor/payouts/${STMT_PAID_PERIOD}/statement`, null, sci, scratchPort);
      test(lockFaultNames[5],
        pStmt.body?.code !== "PERIOD_NOT_FINALIZED"
        && pStmt.body?.code === "PAYOUT_NOT_SETTLEABLE");
    } catch (e) {
      // Only the tests that never got to run are skipped — a genuine FAIL above
      // is never converted into a skip on the way out.
      lockFaultSkip("scratch server unavailable: " + (e && e.message ? e.message : e));
    } finally {
      try { if (sdb) sdb.close(); } catch {}
      if (child) {
        try { child.kill("SIGTERM"); } catch {}
        await new Promise(r => setTimeout(r, 500));
        // Targeted, by pid, and only if it is still alive. Never pkill: this
        // machine routinely has several server.js processes running.
        try { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); } catch {}
      }
      if (scratchDir) { try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch {} }
    }
  }

  // Results
  console.log("");
  // A SKIP is not a PASS. It used to be counted as one ("s++; p++"), which made the
  // headline read 67 passed when only 39 assertions had actually run — the other 28
  // were skips wearing a pass's clothes. That is the one failure mode a summary line
  // must not have: it hides a regression behind a number that looks green. Skips are
  // now reported on their own, and the pass count means only what it says.
  let p = 0, f = 0, s = 0;
  results.forEach(r => {
    if (r.skipped) { console.log("  [SKIP] " + r.name + " — " + r.skipped); s++; return; }
    console.log((r.pass ? "  [PASS]" : "  [FAIL]") + " " + r.name);
    if (r.pass) p++;
    else {
      f++;
      if (r.detail) {
        let d;
        try { d = typeof r.detail === "function" ? r.detail() : r.detail; }
        catch (e) { d = "(detail unavailable: " + e.message + ")"; }
        if (d) String(d).split("\n").forEach(line => console.log("         " + line));
      }
    }
  });
  console.log("\n" + p + " passed, " + f + " failed, " + s + " skipped"
    + "  (" + results.length + " tests total; skipped are NOT counted as passed)");
  if (f > 0) process.exit(1);
})();
