const http = require("http");
const fs = require("fs");
const path = require("path");

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

// Accounts the suite logs in with. No seed script in this repo creates
// "admin"/"max.range.inv.llc." — they only exist in whichever local DB the
// suite was first written against, which makes the whole harness unrunnable
// anywhere else. Defaults preserve the original local behaviour; override to
// run against staging.
const ADMIN_USER = process.env.TEST_ADMIN_USER || "admin";
const ADMIN_PASS = process.env.TEST_ADMIN_PASS || "Password123!";
const INVESTOR_USER = process.env.TEST_INVESTOR_USER || "max.range.inv.llc.";
const INVESTOR_PASS = process.env.TEST_INVESTOR_PASS || "Password123!";

function req(method, path, body, cookies) {
  return new Promise((resolve, reject) => {
    const opts = { hostname: "localhost", port: PORT, path, method, headers: { "Content-Type": "application/json" } };
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
function test(name, pass) { results.push({ name, pass }); }
// Some payout guards need a specific row shape (a $0 period, a payable period)
// that seeded data may not contain. Mark those SKIP rather than passing them
// vacuously — a green run that silently never exercised the guard is how the
// regressions these tests exist for got shipped in the first place.
function skip(name, why) { results.push({ name, pass: true, skipped: why }); }

(async () => {
  console.log("=== RUNNING 102 TESTS against localhost:" + PORT + " ===\n");

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

  // 23. Bad file extension rejected
  const bf = await req("POST", "/api/chat/attachment", { fileData: "dGVzdA==", fileName: "hack.php" }, ac);
  test("23. Bad file extension rejected", bf.status === 400);

  // 24. Good file extension allowed
  const gf = await req("POST", "/api/chat/attachment", { fileData: "dGVzdA==", fileName: "doc.pdf" }, ac);
  test("24. Good file extension accepted", gf.status === 200);

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
  const ve = await req("POST", "/api/expenses",
    { driver: "test", type: "Fuel", amount: 10, date: "2026-04-11", vendor: "Pilot Travel Center #123" }, ac);
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
  //     bucket, and the two quantities that live between earnings and payable
  //     (manual adjustments, still-unabsorbed carried loss) are accounted for:
  //
  //       paid + processing + owed + accruing == earned + adjustments + carriedLoss
  //
  //     Breaking this is precisely what the client reported, twice.
  const earned53 = Number(prod47.investorNetToDate || 0);
  const accruing53 = Number(P.currentMonth?.amountInProgress || 0);
  const lhs53 = Number(T.totalPaid || 0) + Number(T.totalProcessing || 0) + Number(T.totalOwed || 0) + accruing53;
  const rhs53 = earned53 + Number(T.totalAdjustments || 0) + Number(T.carriedLossOutstanding || 0);
  test("53. Ledger reconciles: paid+processing+owed+accruing === earned+adjustments+carriedLoss",
    invSelf.status === 200 && pay.status === 200 && lhs53 === rhs53);

  // 54. The still-open month is never a settleable row — it is reported only as
  //     currentMonth.amountInProgress. This is the root cause of the original
  //     "$6,389 owed" report.
  test("54. Current in-progress month is not a payout row",
    !!P.currentMonth?.period && !rows.some(r => r.period === P.currentMonth.period));

  // 55. A $0 period cannot be settled — "paid $0" is not a settlement.
  const zeroRow = rows.find(r => Number(r.effectiveAmount) === 0 && r.status === "owed");
  if (!zeroRow) {
    skip("55. Cannot settle a $0 payout (409)", "no $0 owed row in seeded data");
  } else {
    const s55 = await req("POST", `/api/investor/payouts/${zeroRow.id}/status`, { status: "paid" }, ac);
    test("55. Cannot settle a $0 payout (409)", s55.status === 409);
  }

  // 56. A deduction cannot exceed the payout it comes off. Kept inside the
  //     pre-existing $10,000 magnitude cap, or that older guard fires first and
  //     this ceiling is never reached.
  const payableRow = rows.find(r => Number(r.effectiveAmount) > 0 && Number(r.amount) < 10000);
  if (!payableRow) {
    skip("56. Cannot over-deduct a payout (400)", "no payable row under the $10k cap in seeded data");
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
    test("58. Load report splits completed vs in-transit and grosses only completed",
      lr.status === 200 && periods.every(p =>
        typeof p.completedCount === "number" && typeof p.inTransitCount === "number" &&
        p.completedCount + p.inTransitCount === p.loadCount &&
        p.completedCount === (p.loads || []).filter(l => l.completed).length &&
        Math.round(p.grossRevenue) === Math.round((p.loads || []).filter(l => l.completed)
          .reduce((s, l) => s + (l.rate || 0), 0))));
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
  const settledRow = rows.find(r => r.status === "paid" || r.status === "processing");
  if (!settledRow) {
    skip("59. Reopening without a reason is rejected (400)", "no settled row in seeded data");
    skip("60. Reopen round-trip un-stamps and re-stamps correctly", "no settled row in seeded data");
  } else {
    const s59 = await req("POST", `/api/investor/payouts/${settledRow.id}/status`,
      { status: "owed" }, ac);
    const s59b = await req("POST", `/api/investor/payouts/${settledRow.id}/status`,
      { status: "owed", reason: "   " }, ac);
    test("59. Reopening without a reason is rejected (400)",
      s59.status === 400 && s59b.status === 400 &&
      /reason is required/i.test(s59.body?.error || ""));

    // 60. The round-trip. MUTATES, then restores — the suite is meant to run
    //     against a seeded DB (scripts/truncate-and-seed.js), and the reopen
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

  // A minimal but structurally valid PDF, base64. Its "JVBERi" magic prefix is
  // what /extract validates, so this exercises the accept-path of that check
  // while the payload stays a few hundred bytes.
  const tinyPdfB64 =
    "JVBERi0xLjQKMSAwIG9iajw8L1R5cGUvQ2F0YWxvZy9QYWdlcyAyIDAgUj4+ZW5kb2JqCjIgMCBvYmo8PC9UeXBlL1BhZ2VzL0tpZHNbMyAwIFJdL0NvdW50IDE+PmVuZG9iagozIDAgb2JqPDwvVHlwZS9QYWdlL1BhcmVudCAyIDAgUi9NZWRpYUJveFswIDAgMjAwIDIwMF0+PmVuZG9iagp0cmFpbGVyPDwvUm9vdCAxIDAgUj4+CiUlRU9GCg==";

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
      const del = await req("DELETE", "/api/data/" + b73.rowIndex + "?sheet=" + encodeURIComponent("Job Tracking"), null, ac);
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
    const merged85 = await BI.extractRateConFields(null, {
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

    // 88. Most brokers supply neither a Move # nor a PO #. The old Bison-shaped
    //     sentence always cited both, so a C.H. Robinson invoice read "...is
    //     &amp; PO #" — which looks like a bug to the person paying it. Omit
    //     the sentence entirely instead.
    const html88 = BI.buildInvoiceEmailHtml({ brokerName: "C.H. Robinson", orderNumber: "560909669" });
    test("88. Invoice email omits the driver-ID/PO sentence when both are absent",
      html88.includes("C.H. Robinson Order # 560909669") &&
      !/driver ID/i.test(html88) && !/PO\s*#/i.test(html88) && !/&amp;\s*PO/i.test(html88));

    // 89. A real C.H. Robinson PO is "SHP2607-A3BJ112". The old digits-only
    //     normalization truncated it to "2607" and cited the wrong PO on the
    //     invoice — silently, and only the broker would ever notice.
    const html89 = BI.buildInvoiceEmailHtml({ brokerName: "C.H. Robinson", orderNumber: "560909669", poNumber: "SHP2607-A3BJ112" });
    test("89. Invoice email preserves an alphanumeric PO",
      html89.includes("SHP2607-A3BJ112") && !/PO\s*#2607\b/.test(html89));
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

  // 105. Only a PAID period yields a document. Pick a real non-paid row from the
  //      ledger already fetched above; skip honestly if every row is settled.
  const unpaidRow = rows.find(r => r.status !== "paid");
  if (!unpaidRow) {
    skip("105. Statement refuses a period that is not paid (409)", "every seeded payout row is already paid");
  } else {
    const st105 = await req("GET", `/api/investor/payouts/${unpaidRow.period}/statement`, null, ic);
    test("105. Statement refuses a period that is not paid (409)",
      st105.status === 409 && /PAYOUT_NOT_PAID|not_settleable/i.test(st105.body?.code || ""));
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
  const dupVendor = "QuikTrip #90210";
  const dupDate = "2026-04-12";
  const dupBody = { driver: "test", type: "Fuel", amount: 123.45, date: dupDate, vendor: dupVendor };

  // Seed WITHOUT the flag, so re-running the suite never trips over its own row.
  const dupA = await req("POST", "/api/expenses", dupBody, ac);
  test("107. Expense POST without checkDuplicate is never blocked (driver-app path)",
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

  // Results
  console.log("");
  let p = 0, f = 0, s = 0;
  results.forEach(r => {
    if (r.skipped) { console.log("  [SKIP] " + r.name + " — " + r.skipped); s++; p++; return; }
    console.log((r.pass ? "  [PASS]" : "  [FAIL]") + " " + r.name);
    if (r.pass) p++; else f++;
  });
  console.log("\n" + p + " passed, " + f + " failed out of " + results.length + " tests"
    + (s > 0 ? " (" + s + " skipped — see above)" : ""));
  if (f > 0) process.exit(1);
})();
