const http = require("http");

// Target port. Defaults to 3000 (local dev), but MUST be overridable: on the
// VPS 3000 is PRODUCTION and this suite writes (it logs an expense in test 46).
// Run against staging with TEST_PORT=3003.
const PORT = Number(process.env.TEST_PORT) || 3000;

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
  console.log("=== RUNNING 58 TESTS against localhost:" + PORT + " ===\n");

  // 1. Server health
  const health = await req("GET", "/api/auth/setup-check");
  test("1. Server is running", health.status === 200);

  // 2. Super Admin login
  const adminLogin = await req("POST", "/api/auth/login", { username: "admin", password: "Password123!" });
  test("2. Super Admin login", adminLogin.status === 200 && adminLogin.body.success);
  const ac = adminLogin.cookies;
  if (!ac) { console.log("WARN: No cookies returned. Secure+SameSite blocks test cookies."); }

  // 3. Investor login
  const invLogin = await req("POST", "/api/auth/login", { username: "max.range.inv.llc.", password: "Password123!" });
  test("3. Investor login", invLogin.status === 200 && invLogin.body.success);
  const ic = invLogin.cookies;

  // 4. Debug endpoints blocked without auth
  const d1 = await req("GET", "/api/debug/user/admin");
  test("4. Debug blocked without auth", d1.status === 401);

  // 5. Debug endpoints work for Super Admin
  const d2 = await req("GET", "/api/debug/user/admin", null, ac);
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

  // 13. investorEarnings field
  test("13. investorEarnings computed", typeof inv.body?.production?.investorEarnings === "number");

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

  // 29. Public tracker payload exposes pickup/delivery date-time keys
  const okTrack = await req("GET", "/api/public/track/554954475");
  const tb = (okTrack && okTrack.body) || {};
  test("29. Track payload exposes pickup/delivery date-time keys",
    okTrack.status === 200 && "scheduledPickup" in tb && "scheduledDelivery" in tb && "actualPickup" in tb && "actualDelivery" in tb);

  // 30. Public tracker status timeline is an array and never leaks the per-transition actor
  const phases = tb.phases;
  const phasesIsArray = Array.isArray(phases);
  const phasesShaped = phasesIsArray && phases.every(p => p && "status" in p && "startedAt" in p);
  const noActorKey = phasesIsArray && phases.every(p => !p || !("actor" in p));
  const noActorString = !/actor/i.test(JSON.stringify(phases || []));
  test("30. Track phases is array and exposes no actor",
    okTrack.status === 200 && phasesIsArray && phasesShaped && noActorKey && noActorString);

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
