#!/usr/bin/env node
/**
 * Authorization guard on the two invoice routes that serve or advance a
 * driver's own paperwork:
 *
 *     GET /api/invoices/:id/pdf
 *     PUT /api/invoices/:id/submit      (PUT, not POST)
 *
 * WHY THIS EXISTS. Both routes are "Super Admin or the owning Driver — nothing
 * else" (issue #228, which fixed a gate that named only `=== "Driver"` and so
 * let Dispatcher and Investor fall straight through). `test-suite.js` exercises
 * neither route, so until this file there was ZERO authorization coverage on
 * either one and a regression would have been completely silent.
 *
 * The guard is HAND-COPIED into both routes. That is the drift hazard this repo
 * has been bitten by repeatedly (DRIVER_RENAME_TARGETS, investorExpenseScopeSql,
 * truckMonthlyFixed), so §4 pins the two copies byte-identical.
 *
 * WHAT IS ASSERTED, and against what:
 *   §1 driverOwnsInvoice() executed for real, lifted out of server.js
 *   §2 the ROUTE CONDITION executed for real, extracted from each route body
 *   §3 the pdf/submit divergence on a soft-deleted invoice
 *   §4 the two guards are identical
 *   §5 DISCRIMINATION — defang each protective clause, require assertions to flip
 *
 * ⚠️ NOT asserted, deliberately: that the lookup uses `.all()` rather than
 * `.get()`. test-drug-test-guard.js asserts that because drug_test_file_url has
 * no unique index. Here the key is `invoices.id`, the PRIMARY KEY, so `.get()`
 * cannot silently drop a second matching row and is the correct shape. Copying
 * that assertion across would fail for a reason that is not a bug.
 *
 * Pure: no server, no app.db, no network, no fixtures.
 *
 * Run: node scripts/test-invoice-owner-guard.js
 */

const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

let failed = 0;
function ok(name, cond) {
	if (cond) console.log(`ok    ${name}`);
	else { console.log(`FAIL  ${name}`); failed++; }
}

// --- lifting ---------------------------------------------------------------
// Brace-count a `function name(` out of server.js without booting the app.
function liftFn(name) {
	const a = SRC.indexOf(`function ${name}(`);
	if (a < 0) { console.error(`FAIL  could not locate ${name} in server.js`); process.exit(1); }
	let depth = 0, seen = false;
	for (let i = SRC.indexOf("{", a); i < SRC.length; i++) {
		if (SRC[i] === "{") { depth++; seen = true; }
		else if (SRC[i] === "}") { depth--; if (seen && depth === 0) return SRC.slice(a, i + 1); }
	}
	throw new Error(`unbalanced braces in ${name}`);
}

// Paren-count a route registration out of server.js. Route bodies close over
// db/res/fs/path and cannot be lifted into `new Function`, so these are asserted
// as TEXT — but the one condition that matters is extracted and executed below.
function routeSource(verb, routePath) {
	const needle = `app.${verb}("${routePath}"`;
	const at = SRC.indexOf(needle);
	if (at < 0) { console.error(`FAIL  route not found: ${verb.toUpperCase()} ${routePath}`); process.exit(1); }
	let depth = 0;
	for (let j = SRC.indexOf("(", at); j < SRC.length; j++) {
		if (SRC[j] === "(") depth++;
		else if (SRC[j] === ")") { depth--; if (depth === 0) return SRC.slice(at, j + 1); }
	}
	throw new Error(`unbalanced parens extracting ${verb.toUpperCase()} ${routePath}`);
}

// ⚠️ driverOwnsInvoice is NOT self-contained — it calls normalizeDriverName,
// which lives ~11k lines away. Lifting it alone throws ReferenceError at CALL
// time (not build time), which would look like a broken test rather than a
// missing dependency. Both are lifted and concatenated.
const OWNS_SRC = liftFn("driverOwnsInvoice");
const NORM_SRC = liftFn("normalizeDriverName");

function buildOwns(ownsSrc = OWNS_SRC) {
	return new Function(`${NORM_SRC}\n${ownsSrc}\nreturn driverOwnsInvoice;`)();
}
const driverOwnsInvoice = buildOwns();

const PDF_SRC = routeSource("get", "/api/invoices/:id/pdf");
const SUBMIT_SRC = routeSource("put", "/api/invoices/:id/submit");

// Extract the live authorization condition from a route body and make it
// callable, so §2 tests what the route ACTUALLY says rather than a restatement.
const COND_RE = /if \((user\.role [^)]*?driverOwnsInvoice\(user, invoice\))\) \{/;
function conditionOf(routeSrc, label) {
	const m = routeSrc.match(COND_RE);
	if (!m) { console.error(`FAIL  could not extract auth condition from ${label}`); process.exit(1); }
	return m[1];
}
const PDF_COND = conditionOf(PDF_SRC, "pdf");
const SUBMIT_COND = conditionOf(SUBMIT_SRC, "submit");

// true => the route returns 403
function refuses(cond, user, invoice, owns = driverOwnsInvoice) {
	return new Function("user", "invoice", "driverOwnsInvoice", `return (${cond});`)(user, invoice, owns);
}

// --- fixtures --------------------------------------------------------------
const INV = { id: 7, driver: "Deshorn King", status: "Draft", deleted_at: null };
const SUPER = { role: "Super Admin", driverName: null };
const OWNER = { role: "Driver", driverName: "Deshorn King" };
const OTHER = { role: "Driver", driverName: "Shorn King" };
const DISPATCH = { role: "Dispatcher", driverName: null };
const INVESTOR = { role: "Investor", driverName: null };

// ===========================================================================
console.log("\n§1  driverOwnsInvoice()");
// ===========================================================================
ok("the owning driver matches", driverOwnsInvoice(OWNER, INV) === true);
ok("case and whitespace are folded",
	driverOwnsInvoice({ driverName: "  deshorn   KING " }, INV) === true);
ok("a different driver is refused", driverOwnsInvoice(OTHER, INV) === false);
ok('⚠️ whole-value ===, so "Shorn King" ⊄ "Deshorn King" (the substring trap)',
	driverOwnsInvoice({ driverName: "Shorn King" }, INV) === false);
ok("a blank session name is refused — the load-bearing narrowing that denies " +
	"Dispatcher/Investor without enumerating roles",
	driverOwnsInvoice({ driverName: "" }, INV) === false &&
	driverOwnsInvoice({ driverName: null }, INV) === false &&
	driverOwnsInvoice({}, INV) === false);
ok("a blank session name is refused even against a BLANK-driver invoice " +
	'(so the "" === "" fold is not an authorization bypass)',
	driverOwnsInvoice({ driverName: "" }, { driver: "" }) === false);
ok("a missing user object does not throw", driverOwnsInvoice(undefined, INV) === false);
ok("a missing invoice object does not throw", driverOwnsInvoice(OWNER, undefined) === false);

// ===========================================================================
console.log("\n§2  the route authorization condition (extracted and executed)");
// ===========================================================================
for (const [label, cond] of [["pdf", PDF_COND], ["submit", SUBMIT_COND]]) {
	ok(`${label}: Super Admin is allowed`, refuses(cond, SUPER, INV) === false);
	ok(`${label}: the owning Driver is allowed`, refuses(cond, OWNER, INV) === false);
	ok(`${label}: a different Driver is REFUSED`, refuses(cond, OTHER, INV) === true);
	ok(`${label}: Dispatcher is REFUSED (issue #228 — used to fall through)`,
		refuses(cond, DISPATCH, INV) === true);
	ok(`${label}: Investor is REFUSED (issue #228 — used to fall through)`,
		refuses(cond, INVESTOR, INV) === true);
}

// ===========================================================================
console.log("\n§3  soft-deleted invoices — the two routes deliberately diverge");
// ===========================================================================
const DELETED = { ...INV, deleted_at: "2026-09-01T00:00:00Z" };
ok("pdf: 404s a soft-deleted invoice for non-Super-Admin, but only AFTER the " +
	"403 check (so a stranger gets 403, not 404)",
	/if \(invoice\.deleted_at && user\.role !== "Super Admin"\) \{[\s\S]{0,120}?404/.test(PDF_SRC) &&
	PDF_SRC.indexOf("driverOwnsInvoice") < PDF_SRC.indexOf("invoice.deleted_at &&"));
ok("submit: folds deleted_at into a PRE-auth 404, so a stranger gets 404 here",
	/if \(!invoice \|\| invoice\.deleted_at\) return res\.status\(404\)/.test(SUBMIT_SRC));
ok("pdf still keeps a soft-deleted invoice readable by Super Admin (audit/restore)",
	refuses(PDF_COND, SUPER, DELETED) === false);
ok("the owning driver is still refused a soft-deleted invoice by both routes",
	/invoice\.deleted_at/.test(PDF_SRC) && /invoice\.deleted_at/.test(SUBMIT_SRC));

// ===========================================================================
console.log("\n§4  the two hand-copied guards must not drift");
// ===========================================================================
ok("both routes use `!== \"Super Admin\"`, never `=== \"Driver\"` (the pre-#228 gate)",
	/user\.role !== "Super Admin"/.test(PDF_SRC) && !/user\.role === "Driver"/.test(PDF_SRC) &&
	/user\.role !== "Super Admin"/.test(SUBMIT_SRC) && !/user\.role === "Driver"/.test(SUBMIT_SRC));
ok("both routes actually CALL driverOwnsInvoice (a passing helper proves " +
	"nothing if a route stops calling it)",
	/driverOwnsInvoice\(user, invoice\)/.test(PDF_SRC) &&
	/driverOwnsInvoice\(user, invoice\)/.test(SUBMIT_SRC));
ok("the extracted conditions are byte-identical between the two routes",
	PDF_COND === SUBMIT_COND);
ok("both refuse with 403", /status\(403\)/.test(PDF_SRC) && /status\(403\)/.test(SUBMIT_SRC));
ok("both sit behind requireAuth",
	/app\.get\("\/api\/invoices\/:id\/pdf", requireAuth/.test(PDF_SRC) &&
	/app\.put\("\/api\/invoices\/:id\/submit", requireAuth/.test(SUBMIT_SRC));
ok("the submit route is registered as PUT, not POST",
	SRC.includes('app.put("/api/invoices/:id/submit"') &&
	!SRC.includes('app.post("/api/invoices/:id/submit"'));

// ===========================================================================
console.log("\n§5  DISCRIMINATION — defang each clause, require the assertion to flip");
// A guard test that still passes against a defanged guard is worse than none.
// ===========================================================================
const mutantOldGate = PDF_COND.replace('user.role !== "Super Admin"', 'user.role === "Driver"');
ok("MUTANT: restoring the pre-#228 `=== \"Driver\"` gate lets Dispatcher through",
	mutantOldGate !== PDF_COND && refuses(mutantOldGate, DISPATCH, INV) === false);
ok("MUTANT: the same gate lets Investor through",
	refuses(mutantOldGate, INVESTOR, INV) === false);

const ownsNoBlankCheck = buildOwns(OWNS_SRC.replace("if (!sessionName) return false;", ""));
ok("MUTANT: dropping the blank-session-name refusal makes a nameless role own " +
	"a blank-driver invoice",
	ownsNoBlankCheck({ driverName: "" }, { driver: "" }) === true);
ok("MUTANT: and that is exactly how Dispatcher would regain access",
	refuses(PDF_COND, DISPATCH, { driver: "" }, ownsNoBlankCheck) === false);

const ownsSubstring = buildOwns(
	OWNS_SRC.replace(
		"return normalizeDriverName(invoice && invoice.driver) === sessionName;",
		"return normalizeDriverName(invoice && invoice.driver).includes(sessionName);"));
ok('MUTANT: a substring compare lets "Shorn King" own "Deshorn King"\'s invoice',
	ownsSubstring(OTHER, INV) === true);

console.log(failed ? `\n${failed} test(s) failed` : "\nall passed");
process.exit(failed ? 1 : 0);
