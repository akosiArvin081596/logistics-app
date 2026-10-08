#!/usr/bin/env node
/**
 * The payout basis routes and the acceptance that records a signed lease,
 * through the shipped handlers.
 *
 * Every route below is lifted out of server.js as written and run against an
 * in-memory SQLite built from server.js's own DDL (investor_payout_basis,
 * investor_payouts and its migrations, audit_trail, users, investor_config,
 * investor_onboarding_documents), with server.js's own helpers (the basis view,
 * the acceptance's recorder, logAudit / auditText) and the real
 * lib/investor-payout-basis.js and lib/investor-payment-terms.js. Only mail,
 * sockets, the vehicle writer, the name-clash lookup and the period-lock
 * helpers (read from a period_locks table built from server.js's DDL; the
 * refusal helpers record what they were asked) are stubbed.
 *
 * WHAT IS ASSERTED
 *   §1 source pins: the three routes are Super Admin only, the PUT is
 *      same-origin (refuseCrossOrigin) and synchronous and audits inside its
 *      transaction; the acceptance records the basis inside its transaction;
 *      the flag has the ships-off shape and is only carried into the payout
 *      math, whose two builders read the basis through payoutBasisContext()
 *      alone and settle through the one shared function
 *   §2 GET: the settings; an investor with no rows (the Split %, its own
 *      override); 404s
 *   §3 PUT validation: 400 INVALID_BASIS with `field` = the request key, 400
 *      LEASE_AMOUNT_WHOLE_DOLLARS; nothing written, nothing audited
 *   §4 PUT writes: the row, the GET shape back, later rows removed, an upsert,
 *      the audit line old → new, a no-op PUT writes nothing, an investor record
 *      with no account is 404
 *   §5 409 BASIS_MONTH_CLOSED with earliestEditableMonth: a paid, a processing
 *      and a finalized month close their month and every earlier one; an owed
 *      one does not; §5b a closed month (period_locks) closes it too for an
 *      owner with no row there, the refusal is recorded, and an unreadable lock
 *      table is 409 PERIOD_LOCK_UNREADABLE with nothing written
 *   §6 the acceptance: a whole-dollar lease is recorded (current Houston month,
 *      signed_terms, the application, the actor) and audited; cents, the
 *      standard contract and an unreadable snapshot record nothing; a failing
 *      basis write rolls the whole acceptance back; the existing-account
 *      branch records nothing and its message names the lease
 *   §7 GET /api/investors: each row's current-month lease, or null; §7b the
 *      load report's CSV prints the lease wording, not a per-load share, in a
 *      lease month (flag on), and every month's shares with the flag off but a
 *      month settled as a lease, which keeps the lease wording
 *   §8 MUTANTS: the BASIS_MONTH_CLOSED guard removed; the flag carried as
 *      always on; the closed-month bound dropped; the frozen split months
 *      dropped from the context
 *   §9 the payout context: with the flag on, the months finalized as the split
 *      (no payoutBasis in the frozen breakdown) stay the split under a lease
 *      row recorded before them; a month finalized as a lease stays the lease,
 *      flag on or off, and the context carries the figures it froze; with the
 *      flag off no month is listed as settled as the split; §9b the context hands over every
 *      truck the owner has with its status, so a Maintenance-only month is
 *      covered (paid under downtime "paid") and an Inactive-only one is not
 *   §10 the ledger (the shipped reconcileInvestorPayouts() and finalizePeriods()):
 *      a read after a month closed creates no row in it and records each closed
 *      month with activity once (late_item_closed_month); the month-end close
 *      freezes a lease month with the lease in its snapshot, so later reads
 *      answer as the first (no split, no carried loss); a split investor closed
 *      by it stays the split with its carry, flag on or off; a lease investor
 *      closed with the flag off stays the split.
 *      MUTANT: the reconcile without its closed-month guard
 *   §11 a month settled as a lease stays exactly as it settled (the same
 *      ledger, the month-end close): after the close, the downtime setting
 *      switched either way, the truck retired, set Inactive or put in service
 *      later, the retirement or prorate setting switched, and the flag turned off
 *      leave every closed month's row, the totals and the portal's months exactly
 *      as they settled, while the open month follows each change; a split
 *      investor keeps the live recompute beside its frozen amounts (the drift
 *      disclosure), flag on or off, under any lease settings; a snapshot holding
 *      a figure that cannot be read reads as its settled amount and is reported
 *      once. MUTANT: the months settled as a lease left out of the context
 *
 * Pure: no server, no app.db, no network, no mail.
 * Run: node scripts/test-payout-basis-routes.js    # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const BASIS_PATH = path.join(ROOT, "lib", "investor-payout-basis.js");
const BASIS_SRC = fs.readFileSync(BASIS_PATH, "utf8");

let pass = 0;
const failures = [];
const ok = (cond, msg) => { if (cond) pass++; else { failures.push(msg); console.error(`  ✗ ${msg}`); } };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
function die(msg) { console.error(`FAILED: ${msg}`); process.exit(1); }
const section = (t) => console.log(`\n${t}`);

let Database;
try {
	Database = require("better-sqlite3");
} catch (e) {
	die(`a server dependency did not load (${e.message}); run npm ci under the .nvmrc Node`);
}
const investorPaymentTerms = require(path.join(ROOT, "lib", "investor-payment-terms.js"));
const investorPayoutBasis = require(BASIS_PATH);
const leasePayoutText = require(path.join(ROOT, "lib", "lease-payout-text.js"));

// ── lifting ─────────────────────────────────────────────────────────────────
const count = (needle, src = SRC) => src.split(needle).length - 1;
function liftFunction(name) {
	const needles = [`\nfunction ${name}(`, `\nasync function ${name}(`];
	const hits = needles.reduce((n, x) => n + count(x), 0);
	if (hits !== 1) die(`expected exactly 1 definition of ${name}() in server.js, found ${hits}`);
	const needle = needles.find((x) => SRC.includes(x));
	const a = SRC.indexOf(needle) + 1;
	return SRC.slice(a, SRC.indexOf("\n}\n", a) + 2);
}
function liftRoute(head) {
	const needle = `\n${head}`;
	if (count(needle) !== 1) die(`expected exactly 1 registration ${JSON.stringify(head)}, found ${count(needle)}`);
	const a = SRC.indexOf(needle) + 1;
	return SRC.slice(a, SRC.indexOf("\n});", a) + "\n});".length);
}
function liftConst(name) {
	const needle = `\nconst ${name} = `;
	if (count(needle) !== 1) die(`expected exactly 1 const ${name}, found ${count(needle)}`);
	const a = SRC.indexOf(needle) + 1;
	return SRC.slice(a, SRC.indexOf(";\n", a) + 1);
}
function tableDdl(table) {
	const m = SRC.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\t\\)`));
	if (!m) die(`could not locate CREATE TABLE ${table}`);
	return `CREATE TABLE ${table} (${m[1]}\n)`;
}
const alters = (table) => SRC.match(new RegExp(`ALTER TABLE ${table} ADD COLUMN [^"]*`, "g")) || [];
const stripComments = (s) => s.split("\n").filter((l) => !/^\s*\/\//.test(l)).map((l) => l.replace(/\s\/\/ .*$/, "")).join("\n");

const HEADS = {
	settings: 'app.get("/api/investor-payout-settings", requireRole("Super Admin"), (req, res) => {',
	getBasis: 'app.get("/api/investors/:id/payout-basis", requireRole("Super Admin"), (req, res) => {',
	putBasis: 'app.put("/api/investors/:id/payout-basis", requireRole("Super Admin"), refuseCrossOrigin, (req, res) => {',
	investors: 'app.get("/api/investors", requireRole("Super Admin"), (req, res) => {',
	accept: 'app.put("/api/investor-applications/:id/status", requireRole("Super Admin"), async (req, res) => {',
};
const ROUTES = Object.fromEntries(Object.entries(HEADS).map(([k, h]) => [k, liftRoute(h)]));
const FUNCTIONS = [
	"logAudit", "scrubPurgeMarker", "auditText", "escapeHtml", "inviteIdParam", "resolveInvestorSplitPct",
	"earliestEditableBasisMonth", "signedPaymentTermsOf", "recordSignedPayoutBasis", "unrecordedLeaseNote",
	"payoutBasisRowView", "buildPayoutBasisView", "payoutBasisContext",
].map(liftFunction).join("\n");
const FLAG_CONSTS = [liftConst("INVESTOR_LEASE_PAYOUTS_ENABLED"), liftConst("INVESTOR_LEASE_SETTINGS"), liftConst("LEASE_SNAPSHOT_WARNED")].join("\n");

const DDL = [
	tableDdl("users"), ...alters("users"),
	tableDdl("audit_trail"),
	// The migrated shape (the CREATE is the pre-owner one; a migration rebuilds it).
	"CREATE TABLE investor_config (owner_id INTEGER DEFAULT 0, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(owner_id, key))",
	tableDdl("investor_onboarding_documents"), ...alters("investor_onboarding_documents"),
	tableDdl("investor_payouts"), ...alters("investor_payouts"),
	tableDdl("investor_payout_basis"),
	tableDdl("period_locks"),
	`CREATE TABLE investor_applications (
		id INTEGER PRIMARY KEY AUTOINCREMENT, legal_name TEXT NOT NULL, dba TEXT DEFAULT '', entity_type TEXT DEFAULT '',
		address TEXT DEFAULT '', contact_person TEXT DEFAULT '', contact_title TEXT DEFAULT '', phone TEXT DEFAULT '',
		email TEXT DEFAULT '', ein_ssn TEXT DEFAULT '', tax_classification TEXT DEFAULT '', vehicles_json TEXT DEFAULT '[]',
		status TEXT DEFAULT 'New', deleted_at TEXT DEFAULT NULL)`,
	`CREATE TABLE investors (
		id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER UNIQUE, full_name TEXT NOT NULL DEFAULT '',
		carrier_name TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'Active', notes TEXT NOT NULL DEFAULT '',
		application_id INTEGER DEFAULT 0, entity_type TEXT DEFAULT '', address TEXT DEFAULT '', phone TEXT DEFAULT '',
		email TEXT DEFAULT '', ein_ssn TEXT DEFAULT '', tax_classification TEXT DEFAULT '', contact_person TEXT DEFAULT '',
		contact_title TEXT DEFAULT '', profile_picture_url TEXT DEFAULT '', created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`,
	"CREATE TABLE trucks (id INTEGER PRIMARY KEY AUTOINCREMENT, unit_number TEXT, owner_id INTEGER DEFAULT 0, status TEXT DEFAULT 'Active', in_service_date TEXT DEFAULT '', created_at TEXT DEFAULT '', retired_at TEXT DEFAULT '')",
];

// ── the harness ─────────────────────────────────────────────────────────────
const CURRENT_MONTH = "2026-09";
const SUPER = { id: 1, username: "super_admin", role: "Super Admin" };
const noop = (req, res, next) => next && next();

// `db`: another server's database, so a restart with other settings or the flag
// switched reads exactly what the first one wrote.
function buildServer({ flag = false, env = {}, basisModule = investorPayoutBasis, routes = {}, vehicles = null, locksReadable = true, functions = FUNCTIONS, db: shared = null } = {}) {
	const db = shared || new Database(":memory:");
	if (!shared) {
		for (const sql of DDL) {
			try { db.exec(sql); } catch (e) { if (!/duplicate column name/.test(e.message)) throw e; }
		}
		db.prepare("INSERT INTO users (id, username, password_hash, role, driver_name, email) VALUES (1, 'super_admin', 'x', 'Super Admin', '', 'ops@example.test')").run();
		db.prepare("INSERT INTO investor_config (owner_id, key, value) VALUES (0, 'investor_split_pct', '50')").run();
	}
	const calls = { notify: [], mail: [], warnings: [], refusals: [] };
	const handlers = {};
	const reg = (verb) => (p, ...h) => { handlers[`${verb} ${p}`] = h[h.length - 1]; };
	const deps = {
		app: { get: reg("GET"), put: reg("PUT"), post: reg("POST") },
		db, crypto,
		requireRole: () => noop, refuseCrossOrigin: noop,
		investorPaymentTerms, investorPayoutBasis: basisModule,
		currentMonthKeyCT: () => CURRENT_MONTH,
		notifyChange: (d) => calls.notify.push(d),
		sendEmail: (to, subject) => { calls.mail.push({ to, subject }); return Promise.resolve(true); },
		bcrypt: { hash: async () => "hashed" },
		registerApplicationVehicles: vehicles || (() => ({ created: 0, existing: 0, heldByOther: 0, failed: 0 })),
		findDriverNameClash: () => null,
		// The lock on the new account's company name is scripts/test-investor-accept-guards.js's
		// subject (§10); here it judges nothing.
		getJobTrackingCached: async () => ({ headers: [], data: [] }),
		investorCompanyLockBlockers: () => null,
		periodLocksReadable: () => locksReadable,
		lockedPeriodsDesc: () => db.prepare("SELECT period FROM period_locks WHERE status = 'locked' ORDER BY period DESC").all().map((r) => r.period),
		periodLockUnreadableResponse: (req, res, what, audit) => {
			calls.refusals.push({ code: "PERIOD_LOCK_UNREADABLE", action: audit && audit.action, entityId: audit && audit.entityId });
			return res.status(409).json({ error: `The period lock table could not be read. ${what} is held until that is fixed.`, code: "PERIOD_LOCK_UNREADABLE" });
		},
		logAuditRefusal: (req, action, entity, entityId, details, code) => calls.refusals.push({ code, action, entity, entityId, details }),
		process: { env: { INVESTOR_LEASE_PAYOUTS_ENABLED: flag ? "true" : "", ...env } },
		console: { warn: (m) => calls.warnings.push(m), error() {}, log() {} },
	};
	const body = [FLAG_CONSTS, functions, ...Object.values({ ...ROUTES, ...routes }), "return { payoutBasisContext };"].join("\n");
	const api = new Function(...Object.keys(deps), `"use strict";\n${body}`)(...Object.values(deps));
	async function call(verb, p, { body: reqBody = {}, params = {}, user = SUPER } = {}) {
		const h = handlers[`${verb} ${p}`];
		if (!h) throw new Error(`no handler for ${verb} ${p}`);
		const out = { status: 200, body: undefined, headers: {} };
		const res = {
			status(c) { out.status = c; return res; },
			json(b) { out.body = JSON.parse(JSON.stringify(b)); return res; },
			setHeader(k, v) { out.headers[k.toLowerCase()] = v; },
		};
		await h({ body: reqBody, params, query: {}, session: user ? { user } : {} }, res);
		return out;
	}
	return { db, calls, call, ...api };
}

function addInvestor(db, { userId, name, applicationId = 0, splitPct = null }) {
	if (userId) db.prepare("INSERT INTO users (id, username, password_hash, role, driver_name, email) VALUES (?, ?, 'x', 'Investor', '', '')").run(userId, `inv${userId}`);
	const id = Number(db.prepare("INSERT INTO investors (user_id, full_name, carrier_name, application_id) VALUES (?, ?, ?, ?)").run(userId || null, name, name, applicationId).lastInsertRowid);
	if (splitPct !== null) db.prepare("INSERT INTO investor_config (owner_id, key, value) VALUES (?, 'investor_split_pct', ?)").run(userId, String(splitPct));
	return id;
}
const basisRows = (db, ownerId) => db.prepare("SELECT effective_month, basis_type, lease_amount_cents, source, application_id, note, created_by, updated_by FROM investor_payout_basis WHERE owner_id = ? ORDER BY effective_month").all(ownerId);
const audits = (db, action) => db.prepare("SELECT * FROM audit_trail WHERE action = ? ORDER BY id").all(action);
const put = (srv, id, body) => srv.call("PUT", "/api/investors/:id/payout-basis", { params: { id: String(id) }, body });
const get = (srv, id) => srv.call("GET", "/api/investors/:id/payout-basis", { params: { id: String(id) } });
const ISO_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
// Owner 49: a signed lease row from June, June finalized as the split (flag off
// then), July finalized with no snapshot, August finalized as a lease, September
// open. Settles June to September through the real function and the context.
function frozenCase(srv) {
	srv.db.prepare("INSERT INTO trucks (unit_number, owner_id, in_service_date) VALUES ('T9', 49, '2026-01-01')").run();
	srv.db.prepare("INSERT INTO investor_payout_basis (owner_id, effective_month, basis_type, lease_amount_cents, source, created_by, created_at) VALUES (49, '2026-06', 'lease', 200000, 'signed_terms', 'x', '2026-06-01T00:00:00Z')").run();
	const pay = srv.db.prepare("INSERT INTO investor_payouts (owner_id, period, amount, due_date, status, finalized_at, finalized_breakdown) VALUES (49, ?, ?, '2026-01-01', 'owed', ?, ?)");
	pay.run("2026-06", 4500, "2026-07-08T00:00:00Z", JSON.stringify({ netProfit: 9000, splitPct: 50, monthShare: 4500 }));
	pay.run("2026-07", 0, "2026-08-08T00:00:00Z", "");
	pay.run("2026-08", 2000, "2026-09-08T00:00:00Z", JSON.stringify({ netProfit: 9000, splitPct: null, monthShare: 2000,
		payoutBasis: { type: "lease", leaseAmount: 2000, paidAmount: 2000, coveredDays: 31, daysInMonth: 31, reason: null } }));
	const months = ["2026-06", "2026-07", "2026-08", "2026-09"].map((month) => ({ month, netProfit: month === "2026-07" ? -1000 : 9000, zeroActivity: false }));
	return investorPayoutBasis.settleInvestorMonths(months, { splitFraction: 0.5, basis: srv.payoutBasisContext(49) });
}

// §10's ledger: the shipped reconcileInvestorPayouts() and finalizePeriods() with
// their helpers, on the harness's database and payoutBasisContext(). The monthly
// builder is computeInvestorMonthlyEarnings()'s last step (the months, the idle
// rule, settleInvestorMonths() with the context, the entries it returns) over the
// fixture below: §1 pins that the real builder reads the basis and settles that way.
// Split 50%. May profit; June idle; July a loss (a $3,000 service payment); August
// a profit that absorbs July's loss as the split; September open.
const LEDGER_CURRENT = "2026-09";
const LEDGER_CLOSED = ["2026-05", "2026-06", "2026-07", "2026-08"];
const LEDGER_FIXTURE = [
	{ month: "2026-05", revenue: 8000, driverPay: 1000, fixedCosts: 2000, tripExpenses: 0, maintFundCost: 0 },
	{ month: "2026-06", revenue: 0, driverPay: 0, fixedCosts: 2000, tripExpenses: 0, maintFundCost: 0 },
	{ month: "2026-07", revenue: 1000, driverPay: 500, fixedCosts: 2000, tripExpenses: 0, maintFundCost: 3000 },
	{ month: "2026-08", revenue: 9000, driverPay: 1000, fixedCosts: 2000, tripExpenses: 0, maintFundCost: 0 },
	{ month: "2026-09", revenue: 3000, driverPay: 500, fixedCosts: 2000, tripExpenses: 0, maintFundCost: 0 },
];
const ledgerIdle = (f) => investorPayoutBasis.isZeroActivityMonth({ ...f, complianceCost: 0, driverCount: 0 });
const ledgerNet = (f) => f.revenue - f.driverPay - (ledgerIdle(f) ? 0 : f.fixedCosts) - f.tripExpenses - f.maintFundCost;
const LEDGER_CTX = { sessionUser: SUPER, carrierDB: { headers: ["Driver", "Carrier"], data: [] }, globalConfig: { investor_split_pct: "50" } };
const resolveSplit = new Function(`${liftFunction("resolveInvestorSplitPct")}\nreturn resolveInvestorSplitPct;`)();
const LEDGER_NAMES = ["lastFridayOfFollowingMonth", "periodLabel", "computeLossCarryForward", "payoutRowBreakdown", "frozenPayoutBreakdown", "resolveInvestorSplitPct", "logAudit", "noteLateItemInClosedMonth", "reconcileInvestorPayouts", "finalizePeriods"];
function ledgerWorld(srv, { reconcile = (s) => s, fixture = LEDGER_FIXTURE } = {}) {
	const src = LEDGER_NAMES.map((n) => (n === "reconcileInvestorPayouts" ? reconcile(liftFunction(n)) : liftFunction(n))).join("\n");
	const locked = (p) => !!srv.db.prepare("SELECT 1 FROM period_locks WHERE period = ? AND status = 'locked'").get(p);
	const deps = {
		db: srv.db, investorPayoutBasis,
		computeInvestorMonthlyEarnings: async ({ investorOwnerId, config }) => {
			const months = fixture.map((f) => ({ month: f.month, netProfit: ledgerNet(f), zeroActivity: ledgerIdle(f) }));
			const settled = investorPayoutBasis.settleInvestorMonths(months, { splitFraction: resolveSplit(config) / 100, basis: srv.payoutBasisContext(investorOwnerId) });
			const monthlyEarnings = fixture.map((f) => {
				const exact = { revenue: f.revenue, driverPay: f.driverPay, fixedCosts: ledgerIdle(f) ? 0 : f.fixedCosts, tripExpenses: f.tripExpenses, maintFundCost: f.maintFundCost, complianceCost: 0, netProfit: ledgerNet(f) };
				return {
					month: f.month, ...exact, exact,
					investorEarnings: settled[f.month].investorEarnings,
					...(settled[f.month].payoutBasis ? { payoutBasis: settled[f.month].payoutBasis } : {}),
					isCurrentMonth: f.month === LEDGER_CURRENT,
				};
			});
			return { monthlyEarnings, currentMonthKey: LEDGER_CURRENT, detail: null };
		},
		isLocked: locked, periodWriteLocked: locked, currentMonthKeyCT: () => LEDGER_CURRENT,
		recordPayoutChange: () => {}, getInvestorDriverSet: () => new Set(), findCol: (h, re) => (h || []).find((x) => re.test(x)) || null,
		settlementGraceDays: () => 7, periodPhase: () => "", graceEndsAt: () => "",
		isPlausibleLockPeriod: (p) => investorPayoutBasis.isMonthKey(p),
		getJobTrackingCached: async () => ({}), getCarrierDBFromSQLite: () => LEDGER_CTX.carrierDB,
		listSettlableInvestors: () => [],
		// The close's own mechanics (the fingerprint, an unreadable lock table) are
		// test-closed-month-no-write.js's; here the lock table always reads.
		periodLocksReadable: () => true, closingFingerprint: () => "",
		payoutRules: () => ({ datedAttribution: false, datedRates: false, futureReceipts: false, frozenCarry: false }),
		// Financials' frozen line items are test-financials-ledger-parity.js's.
		closingLedgerItems: async () => new Map(), writeLedgerFreeze: () => {},
		financialsSettings: () => require("../lib/financials-report").DEFAULT_SETTINGS,
		insertDispatchNotification: { run() {} },
		console: { warn() {}, log() {}, error() {} },
	};
	const fns = new Function(...Object.keys(deps), `"use strict";\n${src}\nreturn { reconcileInvestorPayouts, finalizePeriods };`)(...Object.values(deps));
	return { db: srv.db, fns };
}

function addApplication(db, { name, email, terms }) {
	const appId = Number(db.prepare("INSERT INTO investor_applications (legal_name, email) VALUES (?, ?)").run(name, email).lastInsertRowid);
	const snapshot = terms === undefined ? null
		: (typeof terms === "string" ? terms : investorPaymentTerms.snapshotJson(terms, { inviteId: 7, termsRevision: 1, capturedAt: "2026-09-01T12:00:00.000Z" }));
	for (const key of ["master_agreement", "vehicle_lease", "w9"]) {
		db.prepare("INSERT INTO investor_onboarding_documents (application_id, doc_key, doc_name, signed, payment_terms_json) VALUES (?, ?, ?, 1, ?)")
			.run(appId, key, key, key === "w9" ? null : snapshot);
	}
	return appId;
}
const accept = (srv, appId) => srv.call("PUT", "/api/investor-applications/:id/status", { params: { id: String(appId) }, body: { status: "Accepted" } });
const LEASE_2000 = { type: "lease", leaseAmountCents: 200000, details: "" };

(async () => {
	// ── §1 source pins ──────────────────────────────────────────────────────
	section("§1 source pins");
	{
		ok(/requireRole\("Super Admin"\), \(req, res\)/.test(HEADS.settings) && /requireRole\("Super Admin"\), \(req, res\)/.test(HEADS.getBasis),
			"§1 the two GETs are Super Admin only");
		ok(/requireRole\("Super Admin"\), refuseCrossOrigin, \(req, res\)/.test(HEADS.putBasis), "§1 the PUT is Super Admin only and same-origin (refuseCrossOrigin)");
		ok(!/\bawait\b/.test(ROUTES.putBasis) && !/\basync\b/.test(ROUTES.putBasis), "§1 the PUT is synchronous: no await between its checks and its write");
		const tx = ROUTES.putBasis.slice(ROUTES.putBasis.indexOf("db.transaction("), ROUTES.putBasis.indexOf("})();"));
		ok(/logAudit\(req, "update_payout_basis", "investor", investor\.id,/.test(tx), "§1 the PUT audits update_payout_basis inside its transaction");
		ok(ROUTES.putBasis.indexOf("readBasisInput(") < ROUTES.putBasis.indexOf("db.transaction("), "§1 the PUT checks the body before it writes");
		const acceptTxAt = ROUTES.accept.indexOf("const { userId, vehicleCounts, payoutBasis } = db.transaction(");
		const acceptTx = ROUTES.accept.slice(acceptTxAt, ROUTES.accept.indexOf("})();", acceptTxAt));
		ok(acceptTxAt > 0 && /recordSignedPayoutBasis\(req, \{ applicationId: appId, ownerId: userId, investorId \}\)/.test(acceptTx),
			"§1 the acceptance records the basis inside its transaction");
		ok(/^const INVESTOR_LEASE_PAYOUTS_ENABLED = \/\^\(true\|1\|yes\|on\)\$\/i\.test\(String\(process\.env\.INVESTOR_LEASE_PAYOUTS_ENABLED \?\? ""\)\.trim\(\)\);$/.test(liftConst("INVESTOR_LEASE_PAYOUTS_ENABLED")),
			"§1 the flag has the ships-off shape");
		const ctx = liftFunction("payoutBasisContext");
		ok(/enabled: INVESTOR_LEASE_PAYOUTS_ENABLED,/.test(ctx) && !/if \(!INVESTOR_LEASE_PAYOUTS_ENABLED/.test(ctx),
			"§1 payoutBasisContext() carries the flag; the one gate is the module's");
		// The payout ledger is computeInvestorMonthlyEarnings() with the facts it
		// gathers (gatherLedgerScopeFacts()) and the month math it runs
		// (lib/financials-calc.js, which takes the idle-month predicate as a fact).
		const sliceFn = (head) => { const at = SRC.indexOf(head); return stripComments(SRC.slice(at, SRC.indexOf("\n}\n", at))); };
		const cime = sliceFn("\nasync function computeInvestorMonthlyEarnings(") + "\n" + sliceFn("\nasync function gatherLedgerScopeFacts(");
		const calcSrc = stripComments(fs.readFileSync(path.join(__dirname, "..", "lib", "financials-calc.js"), "utf8"));
		ok(/isZeroActivityMonth: investorPayoutBasis\.isZeroActivityMonth,/.test(cime) && /const isZeroActivity = isZeroActivityMonth\(\{/.test(calcSrc),
			"§1 the ledger judges an idle month with the shared isZeroActivityMonth() (handed to lib/financials-calc.js)");
		ok(!/investor_payout_basis|Math\.round\(netProfit \* /.test(calcSrc), "§1 lib/financials-calc.js reads no basis and applies no split");
		const investorRoute = stripComments(liftRoute('app.get("/api/investor", requireRole("Super Admin", "Investor"), async (req, res) => {'));
		for (const [label, src] of [["computeInvestorMonthlyEarnings()", cime], ["GET /api/investor", investorRoute]]) {
			ok(/payoutBasisContext\(investorOwnerId\)/.test(src) && !/investor_payout_basis/.test(src), `§1 ${label} reads the basis through payoutBasisContext() alone`);
			ok(/investorPayoutBasis\.settleInvestorMonths\(months, /.test(src) && /investorPayoutBasis\.firstPayoutMonth\(/.test(src) && /investorPayoutBasis\.isZeroActivityMonth\b/.test(src),
				`§1 ${label} settles, starts its months and judges an idle month with the shared functions`);
			ok(!/Math\.round\(netProfit \* /.test(src), `§1 ${label} applies no split of its own`);
		}
		const consoleRows = stripComments(liftRoute('app.get("/api/payouts", requireRole("Super Admin"), async (req, res) => {'));
		ok(/effectiveAmount: p\.effectiveAmount,\s*monthEarnings: p\.monthEarnings,\s*lossCarriedIn: p\.lossCarriedIn,\s*lossDeferred: p\.lossDeferred,/.test(consoleRows)
			&& /\.\.\.\(p\.payoutBasis \? \{ payoutBasis: p\.payoutBasis \} : \{\}\),/.test(consoleRows),
		"§1 GET /api/payouts rows carry the investor rows' carry figures, and payoutBasis on a lease month only");
		const loadReport = stripComments(liftRoute('app.get("/api/investor/load-report", requireRole("Super Admin", "Investor"), async (req, res) => {'));
		ok(/payoutBasisContext\(investorOwnerId\)/.test(loadReport) && /LEASE_TEXT\.PER_LOAD_SHARE/.test(loadReport), "§1 the load report prints the lease wording in a lease month");
	}

	// ── §2 GET ─────────────────────────────────────────────────────────────────
	section("§2 GET: the settings, and an investor with no rows");
	{
		const srv = buildServer({ env: { INVESTOR_LEASE_DOWNTIME: "paid", INVESTOR_LEASE_PRORATE: "weekly" } });
		const s = await srv.call("GET", "/api/investor-payout-settings");
		eq(s.body, { enabled: false, settings: { downtime: "paid", prorate: "daily", retirement: "stop" } }, "§2 the settings: the flag, each value, an invalid one at its default");
		eq(srv.calls.warnings.length, 1, "§2 …with one warning at boot for the invalid value");
		const on = buildServer({ flag: true });
		eq((await on.call("GET", "/api/investor-payout-settings")).body.enabled, true, "§2 enabled follows the flag");
		const id = addInvestor(srv.db, { userId: 45, name: "Nora None", splitPct: 40 });
		const view = await get(srv, id);
		eq(view.body, {
			investorId: id, ownerId: 45, enabled: false, settings: { downtime: "paid", prorate: "daily", retirement: "stop" },
			current: { type: "split", splitPct: 40, effectiveMonth: null, source: "default" },
			schedule: [], signedTerms: null, earliestEditableMonth: null, history: [],
		}, "§2 no rows: the investor's own Split %, the default source, nothing signed");
		eq(view.headers["cache-control"], "no-store", "§2 no-store");
		eq((await get(srv, 999)).body.code, "INVESTOR_NOT_FOUND", "§2 an unknown investor is 404 INVESTOR_NOT_FOUND");
		eq((await get(srv, "12abc")).status, 404, "§2 an id that is not a number is 404");
		const noAccount = addInvestor(srv.db, { userId: null, name: "Paper Record" });
		const paper = (await get(srv, noAccount)).body;
		eq([paper.ownerId, paper.schedule, paper.earliestEditableMonth], [null, [], null], "§2 a record with no account: no owner, no schedule");
	}

	// ── §3 PUT validation ────────────────────────────────────────────────────────
	section("§3 PUT validation: nothing written, nothing audited");
	{
		const srv = buildServer();
		const id = addInvestor(srv.db, { userId: 45, name: "Val Idate" });
		const cases = [
			[{ type: "rent", leaseAmount: 2000, effectiveMonth: "2026-10" }, 400, "INVALID_BASIS", "type"],
			[{ type: "lease", effectiveMonth: "2026-10" }, 400, "INVALID_BASIS", "leaseAmount"],
			[{ type: "lease", leaseAmount: 2000.5, effectiveMonth: "2026-10" }, 400, "LEASE_AMOUNT_WHOLE_DOLLARS", "leaseAmount"],
			[{ type: "lease", leaseAmount: "1999.99", effectiveMonth: "2026-10" }, 400, "LEASE_AMOUNT_WHOLE_DOLLARS", "leaseAmount"],
			[{ type: "lease", leaseAmount: 100001, effectiveMonth: "2026-10" }, 400, "INVALID_BASIS", "leaseAmount"],
			[{ type: "lease", leaseAmount: 2000, effectiveMonth: "October" }, 400, "INVALID_BASIS", "effectiveMonth"],
			[{ type: "lease", leaseAmount: 2000, effectiveMonth: "2027-10" }, 400, "INVALID_BASIS", "effectiveMonth"],
			[{ type: "split", effectiveMonth: "2026-10", note: "n".repeat(301) }, 400, "INVALID_BASIS", "note"],
		];
		for (const [body, status, code, field] of cases) {
			const r = await put(srv, id, body);
			eq([r.status, r.body.code, r.body.field], [status, code, field], `§3 ${JSON.stringify(body).slice(0, 60)} → ${status} ${code} (${field})`);
			ok(typeof r.body.error === "string" && r.body.error.includes(field), `§3 …and the message names ${field}`);
		}
		eq(basisRows(srv.db, 45), [], "§3 no row was written");
		eq(audits(srv.db, "update_payout_basis").length, 0, "§3 nothing was audited");
		eq(srv.calls.notify, [], "§3 nothing was announced");
	}

	// ── §4 PUT writes ────────────────────────────────────────────────────────────
	section("§4 PUT writes");
	{
		const srv = buildServer();
		const id = addInvestor(srv.db, { userId: 45, name: "Lena Lease" });
		const first = await put(srv, id, { type: "lease", leaseAmount: 2000, effectiveMonth: "2026-09", note: " as agreed " });
		eq(first.status, 200, "§4 a lease from the current month: 200");
		eq(first.body.current, { type: "lease", leaseAmount: 2000, effectiveMonth: "2026-09", source: "admin" }, "§4 …answers with the GET shape: the current lease");
		const row = srv.db.prepare("SELECT * FROM investor_payout_basis WHERE owner_id = 45").get();
		eq([row.basis_type, row.lease_amount_cents, row.source, row.application_id, row.note, row.created_by, row.updated_by],
			["lease", 200000, "admin", null, "as agreed", "super_admin", null], "§4 the row: cents, admin, no application, the cleaned note, the actor");
		ok(ISO_Z.test(row.created_at) && ISO_Z.test(first.body.schedule[0].createdAt), "§4 created_at is an ISO-8601 Z string, stored and served");
		eq(srv.calls.notify, ["investors", "investor"], "§4 the admin table and the portal are told");
		await put(srv, id, { type: "split", effectiveMonth: "2026-11" });
		await put(srv, id, { type: "lease", leaseAmount: 2500, effectiveMonth: "2027-01" });
		eq(basisRows(srv.db, 45).map((r) => [r.effective_month, r.basis_type, r.lease_amount_cents]), [["2026-09", "lease", 200000], ["2026-11", "split", null], ["2027-01", "lease", 250000]],
			"§4 a schedule of three rows");
		const upsert = await put(srv, id, { type: "lease", leaseAmount: 1800, effectiveMonth: "2026-11" });
		eq(basisRows(srv.db, 45).map((r) => [r.effective_month, r.basis_type, r.lease_amount_cents, r.updated_by]), [["2026-09", "lease", 200000, null], ["2026-11", "lease", 180000, "super_admin"]],
			"§4 a PUT at 2026-11 updates that row and removes the later one");
		eq(upsert.body.schedule.map((s) => s.effectiveMonth), ["2026-09", "2026-11"], "§4 …and answers with that schedule");
		const lines = audits(srv.db, "update_payout_basis");
		eq(lines.length, 4, "§4 every change is audited");
		ok(lines[3].details.includes("from 2027-01 lease $2,500 (admin)") && lines[3].details.includes("→") && lines[3].details.includes("from 2026-11 lease $1,800 (admin)")
			&& lines[3].entity === "investor" && lines[3].entity_id === String(id), "§4 the audit line: old → new, on the investor");
		eq(upsert.body.history.length, 4, "§4 the GET shape carries the history");
		eq(Object.keys(upsert.body.history[0]), ["at", "actor", "action", "detail"], "§4 …as { at, actor, action, detail }");
		const before = srv.calls.notify.length;
		const same = await put(srv, id, { type: "lease", leaseAmount: 1800, effectiveMonth: "2026-11" });
		eq([same.status, audits(srv.db, "update_payout_basis").length, srv.calls.notify.length], [200, 4, before], "§4 a PUT that changes nothing writes, audits and announces nothing");
		const paper = addInvestor(srv.db, { userId: null, name: "Paper Only" });
		eq((await put(srv, paper, { type: "lease", leaseAmount: 2000, effectiveMonth: "2026-10" })).body.code, "INVESTOR_NOT_FOUND", "§4 a record with no account: 404 INVESTOR_NOT_FOUND");
		eq((await put(srv, 999, { type: "lease", leaseAmount: 2000, effectiveMonth: "2026-10" })).status, 404, "§4 an unknown investor: 404");
		const future = await get(srv, id);
		ok(future.body.current.effectiveMonth === "2026-09", "§4 a later row does not govern the current month");
	}

	// ── §5 BASIS_MONTH_CLOSED ───────────────────────────────────────────────────
	section("§5 409 BASIS_MONTH_CLOSED");
	const closedCase = async (srv) => {
		const id = addInvestor(srv.db, { userId: 45, name: "Sett Led" });
		const pay = srv.db.prepare("INSERT INTO investor_payouts (owner_id, period, amount, due_date, status, finalized_at) VALUES (45, ?, 100, '2026-01-01', ?, ?)");
		pay.run("2026-05", "paid", "");
		pay.run("2026-06", "processing", "");
		pay.run("2026-07", "owed", "2026-08-08T00:00:00.000Z");
		pay.run("2026-08", "owed", "");
		return { id, r: await put(srv, id, { type: "lease", leaseAmount: 2000, effectiveMonth: "2026-07" }) };
	};
	{
		const srv = buildServer();
		const { id, r } = await closedCase(srv);
		eq([r.status, r.body.code, r.body.field, r.body.earliestEditableMonth], [409, "BASIS_MONTH_CLOSED", "effectiveMonth", "2026-08"],
			"§5 a finalized July closes July: 409 with earliestEditableMonth 2026-08");
		eq(basisRows(srv.db, 45), [], "§5 …and nothing is written");
		eq((await put(srv, id, { type: "lease", leaseAmount: 2000, effectiveMonth: "2026-05" })).body.code, "BASIS_MONTH_CLOSED", "§5 an earlier month is closed too");
		eq((await put(srv, id, { type: "lease", leaseAmount: 2000, effectiveMonth: "2026-08" })).status, 200, "§5 August, owed and not finalized, is open");
		eq((await get(srv, id)).body.earliestEditableMonth, "2026-08", "§5 the GET names the same month");
		srv.db.prepare("UPDATE investor_payouts SET status = 'paid' WHERE owner_id = 45 AND period = '2026-08'").run();
		eq((await get(srv, id)).body.earliestEditableMonth, "2026-09", "§5 paying August moves it on");
		const other = addInvestor(srv.db, { userId: 46, name: "Other Owner" });
		eq((await get(srv, other)).body.earliestEditableMonth, null, "§5 another owner's settled months close nothing here");
	}

	// ── §5b the month close ─────────────────────────────────────────────────────
	section("§5b the month close bounds it too");
	const lockedCase = async (srv) => {
		const id = addInvestor(srv.db, { userId: 47, name: "No Rows Yet" });
		const lock = srv.db.prepare("INSERT INTO period_locks (period, status, finalized_at) VALUES (?, 'locked', '2026-09-08T00:00:00Z')");
		lock.run("2026-07");
		lock.run("2026-08");
		return { id, r: await put(srv, id, { type: "lease", leaseAmount: 2000, effectiveMonth: "2026-08" }) };
	};
	{
		const srv = buildServer();
		const { id, r } = await lockedCase(srv);
		eq([r.status, r.body.code, r.body.field, r.body.earliestEditableMonth], [409, "BASIS_MONTH_CLOSED", "effectiveMonth", "2026-09"],
			"§5b no payout row at all, August closed: a lease from August is 409, earliest September");
		ok(/settled or closed/.test(r.body.error || ""), "§5b …the message says settled or closed");
		eq(basisRows(srv.db, 47), [], "§5b …nothing is written");
		eq(srv.calls.refusals.map((x) => [x.action, x.entity, x.entityId, x.code]), [["update_payout_basis_blocked", "investor", String(id), "BASIS_MONTH_CLOSED"]],
			"§5b …and the refusal is recorded under update_payout_basis_blocked");
		eq((await get(srv, id)).body.earliestEditableMonth, "2026-09", "§5b the GET names the same month");
		eq((await put(srv, id, { type: "lease", leaseAmount: 2000, effectiveMonth: "2026-09" })).status, 200, "§5b September, open: 200");
		srv.db.prepare("UPDATE period_locks SET status = 'reopened' WHERE period = '2026-08'").run();
		eq((await get(srv, id)).body.earliestEditableMonth, "2026-08", "§5b August reopened: open again (a reopened row is no lock)");
	}
	{
		const srv = buildServer({ locksReadable: false });
		const id = addInvestor(srv.db, { userId: 48, name: "Lock Unknown" });
		const r = await put(srv, id, { type: "lease", leaseAmount: 2000, effectiveMonth: "2026-10" });
		eq([r.status, r.body.code], [409, "PERIOD_LOCK_UNREADABLE"], "§5b an unreadable lock table: 409 PERIOD_LOCK_UNREADABLE, even for a future month");
		eq(basisRows(srv.db, 48), [], "§5b …nothing is written");
		eq(srv.calls.refusals.map((x) => [x.action, x.code]), [["update_payout_basis_blocked", "PERIOD_LOCK_UNREADABLE"]], "§5b …and the refusal is recorded");
		eq((await get(srv, id)).body.earliestEditableMonth, CURRENT_MONTH, "§5b the GET names no month before the current one");
	}

	// ── §6 the acceptance ───────────────────────────────────────────────────────
	section("§6 the acceptance records a signed whole-dollar lease");
	{
		const srv = buildServer();
		const appId = addApplication(srv.db, { name: "Lease Hauling LLC", email: "lease@example.test", terms: LEASE_2000 });
		const r = await accept(srv, appId);
		eq([r.status, r.body.accountCreated], [200, true], "§6 accepted");
		const ownerId = r.body.credentials.userId;
		eq(r.body.payoutBasis, { recorded: true, type: "lease", leaseAmount: 2000, effectiveMonth: CURRENT_MONTH }, "§6 the response says what was recorded");
		eq(basisRows(srv.db, ownerId), [{ effective_month: CURRENT_MONTH, basis_type: "lease", lease_amount_cents: 200000, source: "signed_terms", application_id: appId, note: "", created_by: "super_admin", updated_by: null }],
			"§6 one row: the current Houston month, signed_terms, the application, the actor");
		const investorId = srv.db.prepare("SELECT id FROM investors WHERE user_id = ?").get(ownerId).id;
		const recorded = audits(srv.db, "record_payout_basis");
		ok(recorded.length === 1 && recorded[0].entity_id === String(investorId) && recorded[0].details.includes("$2,000"), "§6 audited on the new investor record");
		const view = (await get(srv, investorId)).body;
		eq([view.current.source, view.signedTerms, view.history[0].action], ["signed_terms", { type: "lease", leaseAmount: 2000 }, "record_payout_basis"], "§6 the GET shows it, what was signed, and the history");

		const cents = addApplication(srv.db, { name: "Cents Hauling LLC", email: "cents@example.test", terms: { type: "lease", leaseAmountCents: 200050, details: "" } });
		const rc = await accept(srv, cents);
		eq([rc.status, rc.body.payoutBasis], [200, { recorded: false, reason: "LEASE_AMOUNT_WHOLE_DOLLARS" }], "§6 a lease signed with cents: accepted, nothing recorded, and why");
		eq(basisRows(srv.db, rc.body.credentials.userId), [], "§6 …no row");
		ok(audits(srv.db, "record_payout_basis_skipped").some((a) => a.details.includes("$2,000.50") && a.details.includes("LEASE_AMOUNT_WHOLE_DOLLARS")), "§6 …and the audit line says why");
		eq((await get(srv, srv.db.prepare("SELECT id FROM investors WHERE user_id = ?").get(rc.body.credentials.userId).id)).body.signedTerms, { type: "lease", leaseAmount: 2000.5 },
			"§6 …while the signed terms still read, cents and all");

		const std = addApplication(srv.db, { name: "Standard Hauling LLC", email: "std@example.test" });
		const rs = await accept(srv, std);
		ok(rs.status === 200 && !("payoutBasis" in rs.body) && basisRows(srv.db, rs.body.credentials.userId).length === 0, "§6 the standard contract: no row, no payoutBasis key");
		const splitTerms = addApplication(srv.db, { name: "Split Terms LLC", email: "split@example.test", terms: { type: "split", leaseAmountCents: null, details: "Reviewed yearly." } });
		const rsp = await accept(srv, splitTerms);
		ok(rsp.status === 200 && !("payoutBasis" in rsp.body) && basisRows(srv.db, rsp.body.credentials.userId).length === 0, "§6 a split with additional terms: no row");
		const broken = addApplication(srv.db, { name: "Broken Terms LLC", email: "broken@example.test", terms: '{"v":1,"type":"lease"}' });
		const rb = await accept(srv, broken);
		eq([rb.status, rb.body.payoutBasis], [200, { recorded: false, reason: "PAYMENT_TERMS_SNAPSHOT_INVALID" }], "§6 an unreadable snapshot: accepted, nothing recorded, and why");

		// Atomic: a basis write that fails rolls the account, the record and the
		// status back with it. The next account's id is known, so a row already
		// holding its month makes the INSERT fail inside the transaction.
		const nextUserId = srv.db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'users'").get().seq + 1;
		srv.db.prepare("INSERT INTO investor_payout_basis (owner_id, effective_month, basis_type, source, created_by, created_at) VALUES (?, ?, 'split', 'admin', 'x', '2026-09-01T00:00:00Z')").run(nextUserId, CURRENT_MONTH);
		const doomed = addApplication(srv.db, { name: "Doomed Hauling LLC", email: "doomed@example.test", terms: LEASE_2000 });
		const users = srv.db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
		const rd = await accept(srv, doomed);
		eq([rd.status, srv.db.prepare("SELECT COUNT(*) AS n FROM users").get().n, srv.db.prepare("SELECT status FROM investor_applications WHERE id = ?").get(doomed).status,
			srv.db.prepare("SELECT COUNT(*) AS n FROM investors WHERE application_id = ?").get(doomed).n], [500, users, "New", 0],
		"§6 a failing basis write rolls the whole acceptance back");

		const repeat = addApplication(srv.db, { name: "Repeat Hauling LLC", email: "lease@example.test", terms: LEASE_2000 });
		const rr = await accept(srv, repeat);
		ok(rr.status === 200 && rr.body.accountCreated === false && /fixed monthly lease of \$2,000; no payout basis was recorded/.test(rr.body.message),
			"§6 an application for an existing account: its message names the lease, in whole dollars");
		eq(basisRows(srv.db, rr.body.existingUserId).length, 1, "§6 …and records nothing more for that account");
		const repeatCents = addApplication(srv.db, { name: "Repeat Cents LLC", email: "lease@example.test", terms: { type: "lease", leaseAmountCents: 200050, details: "" } });
		const rrc = await accept(srv, repeatCents);
		ok(rrc.status === 200 && /fixed monthly lease of \$2,000\.50; no payout basis was recorded/.test(rrc.body.message),
			"§6 …a lease signed with cents keeps its cents");
	}

	// ── §7 GET /api/investors ─────────────────────────────────────────────────
	section("§7 GET /api/investors: the current month's lease, or null");
	{
		const srv = buildServer();
		const a = addInvestor(srv.db, { userId: 45, name: "A Lease" });
		const b = addInvestor(srv.db, { userId: 46, name: "B Split" });
		const c = addInvestor(srv.db, { userId: 47, name: "C Future" });
		addInvestor(srv.db, { userId: null, name: "D Paper" });
		await put(srv, a, { type: "lease", leaseAmount: 2000, effectiveMonth: "2026-08" });
		await put(srv, b, { type: "lease", leaseAmount: 900, effectiveMonth: "2026-06" });
		await put(srv, b, { type: "split", effectiveMonth: "2026-09" });
		await put(srv, c, { type: "lease", leaseAmount: 3000, effectiveMonth: "2026-12" });
		const list = (await srv.call("GET", "/api/investors")).body.investors;
		eq(list.map((i) => [i.fullName, i.payoutBasis]), [
			["A Lease", { type: "lease", leaseAmount: 2000, effectiveMonth: "2026-08" }],
			["B Split", null], ["C Future", null], ["D Paper", null],
		], "§7 lease, split, a lease not yet in force, and no account");
	}

	// ── §7b the load report ──────────────────────────────────────────────────
	section("§7b the load report: no per-load share in a lease month");
	{
		const { csvRows } = require(path.join(ROOT, "lib", "csv.js"));
		const helpers = ["resolvePreviewUser", "findCol", "pickAddressColumn", "moneySheetDate", "periodLabel", "resolveInvestorSplitPct",
			"investorJobRowTest", "driverNameForTotals", "isBuiltInPropertyName", "normalizeDriverName"].map(liftFunction).join("\n");
		const route = liftRoute('app.get("/api/investor/load-report", requireRole("Super Admin", "Investor"), async (req, res) => {');
		const HEADERS = ["Load ID", "Driver", "Job Status", "  Payment  ", "Assigned Date", "Truck", "Owner ID"];
		const ROWS = [
			{ "Load ID": "801", Driver: "Driver A", "Job Status": "Delivered", "  Payment  ": "3000", "Assigned Date": "2026-08-05", Truck: "T1", "Owner ID": "45" },
			{ "Load ID": "802", Driver: "Driver A", "Job Status": "Delivered", "  Payment  ": "1000", "Assigned Date": "2026-08-20", Truck: "T1", "Owner ID": "45" },
			{ "Load ID": "901", Driver: "Driver A", "Job Status": "Delivered", "  Payment  ": "4000", "Assigned Date": "2026-09-04", Truck: "T1", "Owner ID": "45" },
		];
		const csvFor = async (enabled, settledLeaseMonths = {}) => {
			const db = new Database(":memory:");
			db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, role TEXT)");
			db.exec("CREATE TABLE investor_config (owner_id INTEGER DEFAULT 0, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(owner_id, key))");
			db.exec("CREATE TABLE investors (id INTEGER PRIMARY KEY, user_id INTEGER, full_name TEXT)");
			db.prepare("INSERT INTO users (id, username, role) VALUES (45, 'inv45', 'Investor')").run();
			let handler = null;
			const deps = {
				app: { get: (p, ...h) => { handler = h[h.length - 1]; } }, requireRole: () => noop, db, csvRows,
				RFC2822_MONTHS: ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"],
				getJobTrackingCached: async () => ({ headers: HEADERS, data: ROWS }), excludeDroppedLoads: (d) => d,
				getCarrierDBFromSQLite: () => ({ headers: ["Driver", "Carrier"], data: [] }), getInvestorDriverSet: () => new Set(["driver a"]),
				logAudit: () => {}, resolveCityState: (r, kind) => kind, getWeekRange: () => { throw new Error("monthly only"); },
				investorPayoutBasis, leasePayoutText,
				payoutBasisContext: (ownerId) => ({ enabled, rows: [{ effective_month: "2026-09", basis_type: "lease", lease_amount_cents: 200000 }], trucks: [{ in_service_date: "2026-01-01" }], settings: investorPayoutBasis.DEFAULT_SETTINGS, settledLeaseMonths, ownerId }),
			};
			new Function(...Object.keys(deps), `${helpers}\n${route}`)(...Object.values(deps));
			const out = {};
			await handler({ query: { format: "csv", net: "2026-08:1000,2026-09:2000" }, session: { user: { id: 45, username: "inv45", role: "Investor" } } },
				{ setHeader() {}, status() { return this; }, json(b) { out.json = b; }, send(b) { out.csv = String(b); } });
			// lib/csv.js quotes every cell and ends lines with CRLF.
			const cells = (line) => [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1].replace(/""/g, "\""));
			return out.csv.trim().split("\r\n").slice(1).map(cells).map((c) => [c[3], c[c.length - 1]]);
		};
		const L10 = leasePayoutText.LEASE_TEXT.PER_LOAD_SHARE;
		eq(L10, "Paid as a fixed monthly lease, so there is no per-load share.", "§7b the per-load wording (L10), verbatim");
		eq(await csvFor(true), [["901", L10], ["802", "250"], ["801", "750"]], "§7b flag on: the lease month prints the lease wording, the split month its shares");
		eq(await csvFor(false), [["901", "2000"], ["802", "250"], ["801", "750"]], "§7b flag off: every month's shares, as before");
		const settledAugust = { "2026-08": { type: "lease", leaseAmount: 2000, paidAmount: 2000, coveredDays: 31, daysInMonth: 31, reason: null } };
		eq(await csvFor(false, settledAugust), [["901", "2000"], ["802", L10], ["801", L10]], "§7b flag off: a month settled as a lease still prints the lease wording; the open month its shares");
	}

	// ── §8 mutants ────────────────────────────────────────────────────────────
	section("§8 mutants — each must be caught");
	{
		const loadModule = (src) => { const m = { exports: {} }; new Function("module", "exports", src)(m, m.exports); return m.exports; };
		const guard = "if (earliestEditableMonth && effectiveMonth < earliestEditableMonth) {";
		if (count(guard, BASIS_SRC) !== 1) die("the BASIS_MONTH_CLOSED guard moved");
		const noGuard = loadModule(BASIS_SRC.replace(guard, "if (false) {"));
		const { r } = await closedCase(buildServer({ basisModule: noGuard }));
		ok(r.status !== 409, "§8 MUTANT the BASIS_MONTH_CLOSED guard removed: a closed month is written (caught)");
		const { r: control } = await closedCase(buildServer());
		ok(control.status === 409, "§8 control: the shipped guard refuses it");

		// The flag: the context must carry it, and the settle must honour it.
		const settles = (srv) => {
			srv.db.prepare("INSERT INTO trucks (unit_number, owner_id, in_service_date) VALUES ('T1', 45, '2026-01-01')").run();
			srv.db.prepare("INSERT INTO investor_payout_basis (owner_id, effective_month, basis_type, lease_amount_cents, source, created_by, created_at) VALUES (45, '2026-01', 'lease', 200000, 'admin', 'x', '2026-01-01T00:00:00Z')").run();
			const out = investorPayoutBasis.settleInvestorMonths([{ month: "2026-02", netProfit: 9000, zeroActivity: false }], { splitFraction: 0.5, basis: srv.payoutBasisContext(45) });
			return out["2026-02"].investorEarnings;
		};
		eq([settles(buildServer({ flag: false })), settles(buildServer({ flag: true }))], [4500, 2000], "§8 control: flag off pays the split, flag on the lease");
		const openSrc = liftFunction("payoutBasisContext").replace("enabled: INVESTOR_LEASE_PAYOUTS_ENABLED,", "enabled: true,");
		if (openSrc === liftFunction("payoutBasisContext")) die("the flag mutant did not apply");
		const opened = new Function("db", "INVESTOR_LEASE_SETTINGS", "INVESTOR_LEASE_PAYOUTS_ENABLED", "investorPayoutBasis", `${openSrc}\nreturn payoutBasisContext;`);
		const srvOff = buildServer({ flag: false });
		srvOff.payoutBasisContext = opened(srvOff.db, investorPayoutBasis.DEFAULT_SETTINGS, false, investorPayoutBasis);
		ok(settles(srvOff) !== 4500, "§8 MUTANT the flag carried as always on: the lease pays with the flag off (caught)");

		// The closed-month bound: without it a lease is dated into a closed month.
		const closedAnchor = 'const closed = lockedPeriodsDesc().find((p) => investorPayoutBasis.isMonthKey(p)) || "";';
		if (count(closedAnchor) !== 1) die("the closed-month bound moved");
		const { r: unbound } = await lockedCase(buildServer({ functions: FUNCTIONS.replace(closedAnchor, 'const closed = "";') }));
		ok(unbound.status === 200, "§8 MUTANT the closed-month bound dropped: a lease from a closed month is written (caught)");

		// The frozen split months: without them a lease row relabels a month
		// finalized as the split.
		const frozenAnchor = "settledSplitMonths: INVESTOR_LEASE_PAYOUTS_ENABLED";
		if (count(frozenAnchor) !== 1) die("the frozen split months moved");
		const noFrozen = buildServer({ flag: true, functions: FUNCTIONS.replace(frozenAnchor, "settledSplitMonths: false && INVESTOR_LEASE_PAYOUTS_ENABLED") });
		ok(frozenCase(noFrozen)["2026-06"].payoutBasis !== null, "§8 MUTANT the frozen split months dropped: June, finalized as the split, reads as the lease (caught)");
	}

	// ── §9 a month finalized as the split stays the split ───────────────────────
	section("§9 the payout context: a settled month keeps the basis it was settled under");
	{
		const on = buildServer({ flag: true });
		const settled = frozenCase(on);
		const view = (m) => [settled[m].investorEarnings, settled[m].payoutBasis ? "lease" : "split"];
		eq(["2026-06", "2026-07", "2026-08", "2026-09"].map(view), [[4500, "split"], [-500, "split"], [2000, "lease"], [2000, "lease"]],
			"§9 flag on: June (finalized as the split) and July (finalized with no snapshot) stay the split under a lease row from June; August (finalized as a lease) and September (open) are the lease");
		eq([settled["2026-07"].deferred, settled["2026-09"].carriedIn], [500, 0], "§9 …July's loss is still carried as it was settled, and no lease month absorbs it");
		const ctx = on.payoutBasisContext(49);
		eq(ctx.settledSplitMonths, ["2026-06", "2026-07"], "§9 the context lists the months finalized as the split");
		eq(ctx.settledLeaseMonths, { "2026-08": { type: "lease", leaseAmount: 2000, paidAmount: 2000, coveredDays: 31, daysInMonth: 31, reason: null } },
			"§9 …and each month finalized as a lease, with the figures it froze");
		eq([investorPayoutBasis.leaseBasisForMonth(ctx, "2026-06"), investorPayoutBasis.leaseBasisForMonth(ctx, "2026-08")],
			[null, { leaseAmount: 2000, effectiveMonth: "2026-06" }], "§9 leaseBasisForMonth (the load report's month test) agrees");
		const off = buildServer({ flag: false });
		const offSettled = frozenCase(off);
		eq(off.payoutBasisContext(49).settledSplitMonths, [], "§9 flag off: no month is listed as settled as the split");
		eq(["2026-06", "2026-07", "2026-08", "2026-09"].map((m) => [offSettled[m].investorEarnings, offSettled[m].payoutBasis ? "lease" : "split"]),
			[[4500, "split"], [-500, "split"], [2000, "lease"], [4500, "split"]],
			"§9 flag off: August, finalized as a lease, still reads as the lease it settled as; every other month is the split");
	}

	// ── §9b the trucks a lease counts: every status but Inactive ────────────────
	section("§9b the payout context's trucks: a Maintenance truck covers, an Inactive one does not");
	{
		const srv = buildServer({ flag: true, env: { INVESTOR_LEASE_DOWNTIME: "paid" } });
		const truck = srv.db.prepare("INSERT INTO trucks (unit_number, owner_id, status, in_service_date) VALUES (?, ?, ?, '2026-01-01')");
		const leaseRow = srv.db.prepare("INSERT INTO investor_payout_basis (owner_id, effective_month, basis_type, lease_amount_cents, source, created_by, created_at) VALUES (?, '2026-09', 'lease', 200000, 'admin', 'x', '2026-09-01T00:00:00Z')");
		truck.run("M1", 52, "Maintenance");
		truck.run("I1", 53, "Inactive");
		leaseRow.run(52);
		leaseRow.run(53);
		const idleSeptember = (ownerId) => investorPayoutBasis.settleInvestorMonths([{ month: "2026-09", netProfit: 0, zeroActivity: true }],
			{ splitFraction: 0.5, basis: srv.payoutBasisContext(ownerId) })["2026-09"].payoutBasis;
		eq(srv.payoutBasisContext(52).trucks.map((t) => t.status), ["Maintenance"], "§9b the context carries each truck's status");
		eq(idleSeptember(52), { type: "lease", leaseAmount: 2000, paidAmount: 2000, coveredDays: 30, daysInMonth: 30, reason: null },
			"§9b downtime \"paid\": a month whose only truck is in Maintenance pays the lease");
		eq(idleSeptember(53), { type: "lease", leaseAmount: 2000, paidAmount: 0, coveredDays: 0, daysInMonth: 30, reason: "not_in_service" },
			"§9b a month whose only truck is Inactive: not_in_service");
	}

	// ── §10 a closed month gains no row; the close freezes each month's basis ────
	section("§10 the ledger: a closed month gains no row on a later read; the close freezes each month's basis");
	{
		const view = (w, owner) => w.fns.reconcileInvestorPayouts(owner, LEDGER_CTX);
		const stored = (w, owner) => w.db.prepare("SELECT period, finalized_at, finalized_amount, finalized_breakdown FROM investor_payouts WHERE owner_id = ? ORDER BY period").all(owner);
		const closedRows = (w, owner) => stored(w, owner).filter((r) => LEDGER_CLOSED.includes(r.period));
		const lateAudits = (srv) => srv.db.prepare("SELECT entity_id FROM audit_trail WHERE action = 'late_item_closed_month' ORDER BY id").all().map((r) => r.entity_id);
		const leaseOwner = (srv, owner) => {
			srv.db.prepare("INSERT INTO trucks (unit_number, owner_id, in_service_date) VALUES (?, ?, '2026-01-01')").run(`L${owner}`, owner);
			srv.db.prepare("INSERT INTO investor_payout_basis (owner_id, effective_month, basis_type, lease_amount_cents, source, created_by, created_at) VALUES (?, '2026-05', 'lease', 200000, 'admin', 'x', '2026-05-01T00:00:00Z')").run(owner);
		};
		const lockAll = (srv) => { for (const p of LEDGER_CLOSED) srv.db.prepare("INSERT INTO period_locks (period, status, finalized_at) VALUES (?, 'locked', '2026-09-08T00:00:00Z')").run(p); };
		const row = (v, p) => v.payouts.find((x) => x.period === p);

		// Flag on, a lease from May, every month through August closed before
		// anybody opened this investor's payouts: the months stay as settled (no
		// row), and each one with activity is recorded once for review.
		const on = buildServer({ flag: true });
		leaseOwner(on, 60);
		lockAll(on);
		const A = ledgerWorld(on);
		const first = await view(A, 60);
		eq(closedRows(A, 60), [], "§10 a read after the close creates no row in any closed month");
		eq(lateAudits(on), ["60:2026-05", "60:2026-07", "60:2026-08"],
			"§10 …each closed month with activity is recorded for review (late_item_closed_month); the idle June has nothing to record");
		const second = await view(A, 60);
		eq(second, first, "§10 the second read answers exactly as the first");
		eq(lateAudits(on).length, 3, "§10 …and records nothing new");

		// The month-end close: the same months, their rows created while open and
		// then frozen by finalizePeriods().
		const closeSrv = buildServer({ flag: true });
		leaseOwner(closeSrv, 60);
		const B = ledgerWorld(closeSrv);
		await view(B, 60);
		ok(stored(B, 60).every((r) => !r.finalized_at), "§10 control: read while open, the rows are not finalized");
		await B.fns.finalizePeriods(LEDGER_CLOSED, "qa");
		const closedB = await view(B, 60);
		eq(LEDGER_CLOSED.map((p) => [p, !!row(closedB, p).finalizedAt, row(closedB, p).amount, row(closedB, p).payoutBasis && row(closedB, p).payoutBasis.reason]),
			[["2026-05", true, 2000, null], ["2026-06", true, 0, "downtime"], ["2026-07", true, 2000, null], ["2026-08", true, 2000, null]],
			"§10 the close freezes each month as the lease (the idle June pays nothing under downtime \"unpaid\")");
		const snaps = closedRows(B, 60).map((r) => ({ period: r.period, b: JSON.parse(r.finalized_breakdown || "null") }));
		ok(snaps.every((x) => x.b && x.b.payoutBasis && x.b.payoutBasis.type === "lease" && x.b.splitPct === null && x.b.lossCarriedIn === 0 && x.b.lossDeferred === 0),
			"§10 …and each row's frozen breakdown is the lease: payoutBasis, splitPct null, nothing carried in or deferred");
		eq(snaps.find((x) => x.period === "2026-07").b, {
			revenue: 1000, driverPay: 500, fixedCosts: 2000, tripExpenses: 0, maintFundCost: 3000, complianceCost: 0, netProfit: -4500,
			splitPct: null, monthShare: 2000, payoutBasis: { type: "lease", leaseAmount: 2000, paidAmount: 2000, coveredDays: 31, daysInMonth: 31, reason: null },
			lossCarriedIn: 0, lossDeferred: 0,
		}, "§10 July (a loss month) is frozen whole: the P&L, the lease it paid, no carry");
		eq(closeSrv.payoutBasisContext(60).settledSplitMonths, [], "§10 …so the context lists no month as settled as the split");
		const again = await view(B, 60);
		eq(again, closedB, "§10 a later read answers exactly as the first after the close (no month re-read as the split)");
		eq(again.totals.carriedLossOutstanding, 0, "§10 …and no loss is carried");
		const portal = investorPayoutBasis.settleInvestorMonths(LEDGER_FIXTURE.map((f) => ({ month: f.month, netProfit: ledgerNet(f), zeroActivity: ledgerIdle(f) })),
			{ splitFraction: 0.5, basis: closeSrv.payoutBasisContext(60) });
		eq(LEDGER_CLOSED.map((p) => [portal[p].investorEarnings, portal[p].deferred]), [[2000, 0], [0, 0], [2000, 0], [2000, 0]],
			"§10 the portal's months (the same settle, the same context) are the lease too");

		// A split investor closed by the month-end close: the split, with its carry,
		// on every later read, and the same answer with the flag off.
		const closeSplit = async (flag) => {
			const srv = buildServer({ flag });
			srv.db.prepare("INSERT INTO trucks (unit_number, owner_id, in_service_date) VALUES ('S61', 61, '2026-01-01')").run();
			const w = ledgerWorld(srv);
			await view(w, 61);
			await w.fns.finalizePeriods(LEDGER_CLOSED, "qa");
			return { srv, w, v: await view(w, 61) };
		};
		const split = await closeSplit(true);
		eq(LEDGER_CLOSED.map((p) => [row(split.v, p).amount, row(split.v, p).lossDeferred, row(split.v, p).lossCarriedIn, "payoutBasis" in row(split.v, p)]),
			[[2500, 0, 0, false], [0, 0, 0, false], [0, 2250, 0, false], [750, 0, 2250, false]], "§10 a split investor: settled as the split, the July loss carried into August");
		eq(split.srv.payoutBasisContext(61).settledSplitMonths, LEDGER_CLOSED, "§10 …and read as settled as the split");
		eq(await view(split.w, 61), split.v, "§10 …the second read answers exactly as the first");
		const unstamped = (v) => JSON.parse(JSON.stringify(v), (k, x) => (k === "finalizedAt" ? undefined : x));
		eq(unstamped((await closeSplit(false)).v), unstamped(split.v), "§10 …and the same answer as with the flag off (the stamp times aside)");

		// A lease investor closed while the flag was off is settled as the split,
		// and stays the split once the flag is on.
		const off = buildServer({ flag: false });
		leaseOwner(off, 62);
		const O = ledgerWorld(off);
		await view(O, 62);
		await O.fns.finalizePeriods(LEDGER_CLOSED, "qa");
		ok(closedRows(O, 62).every((r) => { const b = JSON.parse(r.finalized_breakdown || "null"); return b && !b.payoutBasis && b.splitPct === 50; }),
			"§10 flag off: a lease investor's close freezes the split it paid (no lease basis in the snapshot)");
		const onCtx = new Function("db", "INVESTOR_LEASE_SETTINGS", "INVESTOR_LEASE_PAYOUTS_ENABLED", "investorPayoutBasis", `${liftFunction("payoutBasisContext")}\nreturn payoutBasisContext;`)(off.db, investorPayoutBasis.DEFAULT_SETTINGS, true, investorPayoutBasis);
		eq(onCtx(62).settledSplitMonths, LEDGER_CLOSED, "§10 …and once the flag is on those months stay the split");

		// MUTANT: the reconcile without its closed-month guard creates the rows.
		const anchor = "if (periodLocksReadable()) noteLateItemInClosedMonth(ownerId, m, amount);";
		if (count(anchor) !== 1 || count("if (periodWriteLocked(m.month)) {") !== 1) die("the reconcile's closed-month guard moved");
		const bug = buildServer({ flag: true });
		leaseOwner(bug, 60);
		lockAll(bug);
		await view(ledgerWorld(bug, { reconcile: (src) => src.replace("if (periodWriteLocked(m.month)) {", "if (false && periodWriteLocked(m.month)) {") }), 60);
		ok(closedRows({ db: bug.db }, 60).length > 0, "§10 MUTANT the reconcile without its closed-month guard creates closed-month rows (caught)");
	}

	// ── §11 a month settled as a lease stays exactly as it settled ───────────────
	section("§11 a closed lease month keeps what it settled at, whatever the settings, the trucks or the flag say now");
	{
		const OWNER = 70;
		const view = (w) => w.fns.reconcileInvestorPayouts(OWNER, LEDGER_CTX);
		// September, the open month, idle: the downtime setting decides it.
		const IDLE_OPEN = LEDGER_FIXTURE.map((f) => (f.month === LEDGER_CURRENT ? { ...f, revenue: 0, driverPay: 0 } : f));
		const portalOf = (srv, fixture, owner = OWNER) => investorPayoutBasis.settleInvestorMonths(
			fixture.map((f) => ({ month: f.month, netProfit: ledgerNet(f), zeroActivity: ledgerIdle(f) })),
			{ splitFraction: resolveSplit({ investor_split_pct: "50" }) / 100, basis: srv.payoutBasisContext(owner) });
		const read = async (srv, fixture) => ({ ledger: await view(ledgerWorld(srv, { fixture })), portal: portalOf(srv, fixture) });
		// Everything a closed month publishes: its ledger row (every field), the ledger
		// totals and the portal's month.
		const closedOf = (r) => ({
			rows: r.ledger.payouts.filter((p) => LEDGER_CLOSED.includes(p.period)),
			totals: r.ledger.totals,
			portal: LEDGER_CLOSED.map((p) => r.portal[p]),
		});
		const brief = (r) => LEDGER_CLOSED.map((p) => {
			const row = r.ledger.payouts.find((x) => x.period === p);
			return [p, row.amount, row.monthEarnings, row.recomputedAmount, row.payoutBasis ? `lease ${row.payoutBasis.paidAmount} ${row.payoutBasis.reason}` : "split"];
		});
		const open = (r) => {
			const c = r.ledger.currentMonth;
			return [c.amountInProgress, c.payoutBasis ? `lease ${c.payoutBasis.reason}` : "split", r.portal[LEDGER_CURRENT].payable];
		};
		// A $2,000 lease from May, its truck in service all year; May to August read
		// while open, then closed by the month-end close under the settings `env`.
		const closeUnder = async (env, fixture) => {
			const srv = buildServer({ flag: true, env });
			srv.db.prepare("INSERT INTO trucks (unit_number, owner_id, in_service_date) VALUES ('L70', ?, '2026-01-01')").run(OWNER);
			srv.db.prepare("INSERT INTO investor_payout_basis (owner_id, effective_month, basis_type, lease_amount_cents, source, created_by, created_at) VALUES (?, '2026-05', 'lease', 200000, 'admin', 'x', '2026-05-01T00:00:00Z')").run(OWNER);
			const w = ledgerWorld(srv, { fixture });
			await view(w);
			await w.fns.finalizePeriods(LEDGER_CLOSED, "qa");
			const r = await read(srv, fixture);
			return { srv, r, closed: closedOf(r) };
		};
		// The same database, read by the server restarted with `flag` and `env`.
		const restart = (base, { flag = true, env = {} } = {}) => buildServer({ flag, env, db: base.srv.db });
		const truck = (base, set) => base.srv.db.prepare(`UPDATE trucks SET ${set} WHERE owner_id = ?`).run(OWNER);

		// (a) closed under downtime "unpaid", read under "paid".
		const unpaid = await closeUnder({ INVESTOR_LEASE_DOWNTIME: "unpaid" }, IDLE_OPEN);
		eq(brief(unpaid.r), [["2026-05", 2000, 2000, 2000, "lease 2000 null"], ["2026-06", 0, 0, 0, "lease 0 downtime"], ["2026-07", 2000, 2000, 2000, "lease 2000 null"], ["2026-08", 2000, 2000, 2000, "lease 2000 null"]],
			"§11 closed under downtime \"unpaid\": the idle June settles at $0 (downtime), the others at the lease");
		eq(open(unpaid.r), [0, "lease downtime", 0], "§11 …and the idle open September pays nothing yet");
		const toPaid = await read(restart(unpaid, { env: { INVESTOR_LEASE_DOWNTIME: "paid" } }), IDLE_OPEN);
		eq(brief(toPaid)[1], ["2026-06", 0, 0, 0, "lease 0 downtime"], "§11 downtime switched to \"paid\": June still settled at $0 for downtime (its earnings, recompute and basis, not re-explained as $2,000)");
		eq(closedOf(toPaid), unpaid.closed, "§11 …every closed month's row, the totals and the portal's months exactly as they settled");
		eq(open(toPaid), [2000, "lease null", 2000], "§11 …while the open September follows the setting: the lease");

		// (b) closed under "paid", read under "unpaid".
		const paid = await closeUnder({ INVESTOR_LEASE_DOWNTIME: "paid" }, IDLE_OPEN);
		eq(brief(paid.r)[1], ["2026-06", 2000, 2000, 2000, "lease 2000 null"], "§11 closed under downtime \"paid\": the idle June settles at the lease");
		const toUnpaid = await read(restart(paid, { env: { INVESTOR_LEASE_DOWNTIME: "unpaid" } }), IDLE_OPEN);
		eq(closedOf(toUnpaid), paid.closed, "§11 downtime switched to \"unpaid\": every closed month exactly as it settled (June still $2,000)");
		eq(open(toUnpaid), [0, "lease downtime", 0], "§11 …while the open September follows the setting: nothing for downtime");

		// (c) the truck changed after the close (September active, so it pays the lease).
		const base = await closeUnder({}, LEDGER_FIXTURE);
		eq(open(base.r), [2000, "lease null", 2000], "§11 control: the open September pays the lease");
		const changes = [
			["retired on 2026-06-15", "retired_at = '2026-06-15'", [0, "lease not_in_service", 0]],
			["set Inactive", "retired_at = '', status = 'Inactive'", [0, "lease not_in_service", 0]],
			["in service from 2026-09-11", "status = 'Active', in_service_date = '2026-09-11'", [1333, "lease prorated", 1333]],
			["retired on 2026-09-20 under retirement \"continue\"", "in_service_date = '2026-01-01', retired_at = '2026-09-20'", null],
		];
		for (const [what, set, want] of changes) {
			truck(base, set);
			const r = await read(want ? base.srv : restart(base, { env: { INVESTOR_LEASE_RETIREMENT: "continue" } }), LEDGER_FIXTURE);
			eq(closedOf(r), base.closed, `§11 the truck ${what}: every closed month exactly as it settled`);
			eq(open(r), want || [2000, "lease null", 2000], `§11 …while the open September follows the truck`);
		}
		truck(base, "retired_at = ''");

		// (d) the flag switched off after the close.
		const off = await read(restart(base, { flag: false }), LEDGER_FIXTURE);
		eq(closedOf(off), base.closed, "§11 the flag switched off: every closed lease month still reads as the lease it settled as");
		eq(open(off), [250, "split", 250], "§11 …while the open September is the split (half of its $500)");
		truck(base, "status = 'Inactive', in_service_date = '2026-08-20'");
		const all = await read(restart(base, { flag: false, env: { INVESTOR_LEASE_DOWNTIME: "paid", INVESTOR_LEASE_PRORATE: "none" } }), LEDGER_FIXTURE);
		eq(closedOf(all), base.closed, "§11 the flag off, every setting switched and the truck Inactive from a later day: the closed months unchanged");
		truck(base, "status = 'Active', in_service_date = '2026-01-01'");

		// (e) a split investor keeps today's behaviour: the live recompute beside the
		// frozen amount (the drift disclosure), flag on or off, whatever the settings.
		const splitSrv = buildServer({ flag: true });
		splitSrv.db.prepare("INSERT INTO trucks (unit_number, owner_id, in_service_date) VALUES ('S71', 71, '2026-01-01')").run();
		const splitView = (srv) => ledgerWorld(srv).fns.reconcileInvestorPayouts(71, LEDGER_CTX);
		const S = ledgerWorld(splitSrv);
		await S.fns.reconcileInvestorPayouts(71, LEDGER_CTX);
		await S.fns.finalizePeriods(LEDGER_CLOSED, "qa");
		splitSrv.db.prepare("INSERT INTO investor_config (owner_id, key, value) VALUES (71, 'investor_split_pct', '60')").run();
		const s1 = await splitView(splitSrv);
		const splitBrief = LEDGER_CLOSED.map((p) => { const x = s1.payouts.find((y) => y.period === p); return [p, x.amount, x.monthEarnings, x.recomputedAmount, x.breakdown.splitPct, "payoutBasis" in x]; });
		eq(splitBrief, [["2026-05", 2500, 3000, 3000, 60, false], ["2026-06", 0, 0, 0, 60, false], ["2026-07", 0, -2700, 0, 60, false], ["2026-08", 750, 3600, 900, 60, false]],
			"§11 a split investor whose Split % changed after the close: the frozen amounts beside the live recompute, as before");
		eq(await splitView(buildServer({ flag: false, db: splitSrv.db })), s1, "§11 …the same answer with the flag off");
		eq(await splitView(buildServer({ flag: true, env: { INVESTOR_LEASE_DOWNTIME: "paid", INVESTOR_LEASE_RETIREMENT: "continue" }, db: splitSrv.db })), s1, "§11 …and under other lease settings");

		// (f) a frozen lease snapshot holding a figure that cannot be read: the month
		// reads as its settled amount, never as a live re-explanation, and says so once.
		const bad = await closeUnder({}, LEDGER_FIXTURE);
		const july = JSON.parse(bad.srv.db.prepare("SELECT finalized_breakdown AS b FROM investor_payouts WHERE owner_id = ? AND period = '2026-07'").get(OWNER).b);
		bad.srv.db.prepare("UPDATE investor_payouts SET finalized_breakdown = ? WHERE owner_id = ? AND period = '2026-07'")
			.run(JSON.stringify({ ...july, payoutBasis: { ...july.payoutBasis, paidAmount: "2000", reason: "unknown" } }), OWNER);
		truck(bad, "status = 'Inactive'");
		const later = restart(bad, { env: { INVESTOR_LEASE_DOWNTIME: "paid" } });
		const r1 = await read(later, LEDGER_FIXTURE);
		eq(closedOf(r1), bad.closed, "§11 July's snapshot with an unreadable paid amount and reason: it reads as its settled $2,000, not as the Inactive truck's $0");
		eq(closedOf(await read(later, LEDGER_FIXTURE)), bad.closed, "§11 …on every read");
		eq(later.calls.warnings.filter((w) => w.startsWith(`[payout-basis] owner ${OWNER} 2026-07:`)).length, 1, "§11 …and it is reported once, not on every read");

		// MUTANT: the context without the months settled as a lease.
		const anchor = "settledLeaseMonths[r.period] = frozen.payoutBasis;";
		if (count(anchor) !== 1) die("the settled lease months moved");
		const noSettled = buildServer({ flag: true, env: { INVESTOR_LEASE_DOWNTIME: "paid" }, db: unpaid.srv.db, functions: FUNCTIONS.replace(anchor, "void frozen;") });
		ok(JSON.stringify(brief(await read(noSettled, IDLE_OPEN))) !== JSON.stringify(brief(unpaid.r)),
			"§11 MUTANT the months settled as a lease left out of the context: June, closed at $0 for downtime, is re-explained under \"paid\" (caught)");
	}

	console.log(`\n${failures.length ? "FAIL" : "PASS"} — ${pass} assertions passed, ${failures.length} failed`);
	if (failures.length) process.exit(1);
})().catch((e) => {
	console.error("FAIL  runner crashed:", e);
	process.exit(1);
});
