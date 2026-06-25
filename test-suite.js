const http = require("http");

function req(method, path, body, cookies) {
  return new Promise((resolve, reject) => {
    const opts = { hostname: "localhost", port: 3000, path, method, headers: { "Content-Type": "application/json" } };
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

(async () => {
  console.log("=== RUNNING 29 TESTS ===\n");

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

  // Results
  console.log("");
  let p = 0, f = 0;
  results.forEach(r => {
    console.log((r.pass ? "  [PASS]" : "  [FAIL]") + " " + r.name);
    if (r.pass) p++; else f++;
  });
  console.log("\n" + p + " passed, " + f + " failed out of " + results.length + " tests");
  if (f > 0) process.exit(1);
})();
