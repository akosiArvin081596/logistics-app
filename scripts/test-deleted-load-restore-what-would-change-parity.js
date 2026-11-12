#!/usr/bin/env node
// scripts/test-deleted-load-restore-what-would-change-parity.js: §5 of the report's tests. What
// scripts/deleted-load-restore-what-would-change.js predicts is what the app itself does, on the same made-up
// world (scripts/lib/deleted-load-restore-report-world.js), each time on a writable copy in a temp folder.
//
//   §5a the module itself (lib/deleted-load-restore.js), created with the flag on and mounted as server.js
//       mounts it, with server.js's own helpers lifted from this checkout and Job Tracking read the server's
//       way: a Super Admin's hiddenLoads() answers the report's banner lines (records, rows, new and own rows,
//       Create it as new, months, evidence) and stores exactly the notices the report predicted; a second
//       read stores none; the report run on that copy then predicts none and counts them stored
//   §5b the restore route itself (POST /api/admin/deleted-loads/:id/restore), for every delete in both modes
//       with a made-up reason, each on a fresh copy: the status, the code, the months and the deletes left
//       are the report's, a restore removes its one record, and a refusal changes nothing
//   §5c the after-check's world: only the deletes not told yet are told, and the new delete's presses
//
// Made-up data only, in a fresh temp folder. No server, no port, no network.
//   node scripts/test-deleted-load-restore-what-would-change-parity.js      # exits 1 on any failure
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SCRIPT = path.join(ROOT, "scripts", "deleted-load-restore-what-would-change.js");
const Database = require(path.join(ROOT, "node_modules", "better-sqlite3"));
const WORLD = require("./lib/deleted-load-restore-report-world");
const lib = require("../lib/deleted-load-restore");
const { keepEveryRow } = require("../lib/job-tracking-every-row");

let pass = 0;
const failures = [];
const canon = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x)
	? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
function eq(actual, expected, label) {
	const a = canon(actual);
	const e = canon(expected);
	if (a === e) { pass++; return; }
	failures.push(`${label}\n      expected ${e}\n      actual   ${a}`);
}
function ok(cond, label) {
	if (cond) { pass++; return; }
	failures.push(label);
}
async function section(title, fn) {
	console.log(title);
	try {
		await fn();
	} catch (err) {
		failures.push(`${title}\n      threw: ${String(err && err.message).split("\n")[0]}`);
	}
}

let report = null;
let loadError = null;
try { report = require(SCRIPT); } catch (err) { loadError = err; }
ok(report, `scripts/deleted-load-restore-what-would-change.js loads${loadError ? ` (${String(loadError.message).split("\n")[0]})` : ""}`);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "logisx-dlr-parity-"));
const NOW = Date.now();
const base = WORLD.buildWorld({ dir: path.join(TMP, "base"), now: NOW });
const after = WORLD.buildWorld({ dir: path.join(TMP, "after"), now: NOW, variant: "after" });
const argsFor = (w, file = w.dbFile) => ["--dry-run", `--db=${file}`, `--values-json=${w.valuesFile}`, `--env-file=${w.flagsFile}`, "--json"];
const predict = (w, file) => report.run(argsFor(w, file), { env: {} });

const SA = { id: 1, role: "Super Admin", username: "made-up-admin-a1" };
const REASON = "Made-up reason for the parity runner";
const QUIET = { log() {}, info() {}, warn() {}, error() {} };

// A writable copy of a world's database, in a folder of its own.
let copies = 0;
function copyOf(w) {
	const dir = path.join(TMP, `copy-${++copies}`);
	fs.mkdirSync(dir);
	const file = path.join(dir, "app.db");
	fs.copyFileSync(w.dbFile, file);
	return fs.realpathSync(file);
}

// The module on a writable copy, created and mounted as server.js does it ("RESTORING A DELETED LOAD"): the
// helpers lifted from server.js, Job Tracking read as getJobTrackingCached() reads it (parse, keep every row,
// de-duplicate), each notice stored as the server's notifySuperAdmins stores it.
function appOn(file, w) {
	const db = new Database(file);
	const { helpers, sheet } = report.liftHelpers({ root: ROOT, dbPath: file, db, envFile: w.flagsFile, readonly: false });
	const jt = sheet.parseSheet({ values: w.values });
	keepEveryRow(jt, jt.data);
	jt.data = sheet.deduplicateLoads(jt.data, jt.headers);
	const routes = {};
	const app = { get: (p, ...chain) => { routes[`GET ${p}`] = chain; }, post: (p, ...chain) => { routes[`POST ${p}`] = chain; } };
	const inst = lib.create({ db, enabled: true, auditText: helpers.auditText, log: QUIET });
	inst.mount(app, {
		requireRole: () => (req, res, next) => next(),
		refuseCrossSite: (req, res, next) => next(),
		periodLocksReadable: helpers.periodLocksReadable,
		getJobTrackingCached: async () => jt,
		jobTrackingMonthCols: helpers.jobTrackingMonthCols,
		tripDayLockCover: helpers.tripDayLockCover,
		loadRowPeriods: helpers.loadRowPeriods,
		lockedAmong: helpers.lockedAmong,
		periodLabel: helpers.periodLabel,
		notifyChange() {},
		jtCacheInvalidate() {},
		pickAddressColumn: helpers.pickAddressColumn,
		excludeDroppedLoads: helpers.excludeDroppedLoads,
		notifySuperAdmins: (notice) => db.prepare("INSERT INTO dispatch_notifications (type, title, body, metadata) VALUES (?, ?, ?, ?)")
			.run(notice.type, notice.title, notice.body, JSON.stringify(notice.metadata || {})),
	});
	return { db, inst, jt, routes };
}

const asSuperAdmin = () => ({ session: { user: { ...SA } } });
// The banner lines' fields the report predicts.
const lines = (list) => (list || []).map((x) => ({
	record: x.tombstoneId, loadId: x.loadId, sheetRow: x.sheetRow, rows: x.rows, newRows: x.newRows, ownRows: x.ownRows,
	canRestore: x.canRestore, canCreateNew: x.canCreateNew, months: x.months, evidence: x.evidence,
})).sort((a, b) => a.record - b.record);
const noticeRows = (db) => db.prepare("SELECT id, metadata FROM dispatch_notifications WHERE type = ? ORDER BY id").all(lib.NOTICE_TYPE)
	.map((r) => ({ id: r.id, ...JSON.parse(r.metadata || "{}") }));
const keysOf = (list) => list.map((x) => `${x.kind}:${x.tombstoneId}`).sort();
const FP = ["SELECT * FROM deleted_loads ORDER BY id", "SELECT * FROM audit_trail ORDER BY id", "SELECT * FROM dispatch_notifications ORDER BY id"];
const fingerprint = (db) => JSON.stringify(FP.map((sql) => db.prepare(sql).all()));

// One press of a deleted load's Restore through the mounted chain, as Express runs it.
async function press(m, id, mode) {
	const chain = m.routes[`POST ${lib.RESTORE_PATH}`];
	if (!chain) throw new Error("the restore route isn't mounted");
	const req = { method: "POST", params: { id: String(id) }, query: {}, body: { mode, reason: REASON },
		headers: { "x-requested-with": "XMLHttpRequest" }, session: { user: { ...SA } } };
	const res = { statusCode: 200, body: undefined, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
	for (const mw of chain.slice(0, -1)) {
		let nexted = false;
		await mw(req, res, () => { nexted = true; });
		if (!nexted) return { status: res.statusCode, body: res.body };
	}
	let failed = null;
	await chain[chain.length - 1](req, res, (e) => { failed = e; });
	if (failed) throw failed;
	return { status: res.statusCode, body: res.body };
}

async function checkPress(w, rec, mode, label) {
	const want = mode === "restore" ? rec.restore : rec.createNew;
	const m = appOn(copyOf(w), w);
	try {
		const before = fingerprint(m.db);
		const got = await press(m, rec.id, mode);
		const said = `${got.status} ${(got.body && got.body.code) || ""}`.trim();
		if (want.code === "OK") {
			ok(got.status === 200 && got.body && got.body.ok === true && got.body.mode === mode, `${label} record ${rec.id}, ${mode}: restored, as the report predicted (got ${said})`);
			eq(got.body && got.body.restored && got.body.restored.months, want.months, `${label} record ${rec.id}, ${mode}: the months it names are the report's`);
			eq(got.body && got.body.remaining, want.remaining, `${label} record ${rec.id}, ${mode}: the deletes of the Load ID left are the report's`);
			ok(!m.db.prepare("SELECT 1 FROM deleted_loads WHERE id = ?").get(rec.id), `${label} record ${rec.id}, ${mode}: its one delete record is gone`);
		} else {
			ok(got.status === 409 && got.body && got.body.code === want.code, `${label} record ${rec.id}, ${mode}: refused ${want.code}, as the report predicted (got ${said})`);
			ok(fingerprint(m.db) === before, `${label} record ${rec.id}, ${mode}: the refusal changed nothing`);
		}
	} finally {
		m.db.close();
	}
}

(async () => {
	await section("§5a  the module itself: the banner and its notices", async () => {
		const predicted = await predict(base);
		const file = copyOf(base);
		const m = appOn(file, base);
		try {
			eq(noticeRows(m.db), [], "§5a no notice is stored before the first read");
			const answer = m.inst.hiddenLoads(asSuperAdmin(), m.jt);
			eq(lines(answer), lines(predicted.model.bannerReplica), "§5a the module's banner lines are the report's own reading of them");
			eq(lines(answer), lines(predicted.model.banner), "§5a …and the banner the report's read-only run of the module answered");
			eq(lines(answer).map((x) => x.record), predicted.out.banner.records, "§5a …on the records the report prints");
			eq(keysOf(noticeRows(m.db)), keysOf(predicted.model.predictedNotices), "§5a the first read stores exactly the notices the report predicted");
			eq(noticeRows(m.db).length, predicted.out.notices.wouldWrite.hidden + predicted.out.notices.wouldWrite.hidden_closed, "§5a …as many as it counts");
			const told = noticeRows(m.db).length;
			eq(lines(m.inst.hiddenLoads(asSuperAdmin(), m.jt)), lines(answer), "§5a a second read answers the same banner");
			eq(noticeRows(m.db).length, told, "§5a …and stores no notice");
		} finally {
			m.db.close();
		}
		const again = await predict(base, file);
		eq(again.out.notices, { wouldWrite: { hidden: 0, hidden_closed: 0 }, stored: { hidden: 11, hidden_closed: 2 } }, "§5a the report run after it predicts none, and counts them stored");
		eq(again.out.banner.records, predicted.out.banner.records, "§5a …with the same banner");
	});

	await section("§5b  the restore route itself, every delete, both modes", async () => {
		const predicted = await predict(base);
		eq(predicted.model.records.map((r) => r.id), Array.from({ length: 21 }, (_, i) => i + 1), "§5b the report judges every delete record");
		for (const rec of predicted.model.records) {
			for (const mode of ["restore", "create_new"]) await checkPress(base, rec, mode, "§5b");
		}
	});

	await section("§5c  the after-check's world", async () => {
		const predicted = await predict(after);
		const m = appOn(copyOf(after), after);
		try {
			const before = noticeRows(m.db);
			eq(keysOf(before), ["hidden:3", "hidden_closed:5"], "§5c two notices are stored already");
			const answer = m.inst.hiddenLoads(asSuperAdmin(), m.jt);
			eq(lines(answer), lines(predicted.model.bannerReplica), "§5c the banner lines are the report's");
			const fresh = noticeRows(m.db).filter((n) => !before.some((b) => b.id === n.id));
			eq(keysOf(fresh), keysOf(predicted.model.predictedNotices), "§5c only the deletes not told yet are told, as the report predicted");
		} finally {
			m.db.close();
		}
		const rec22 = predicted.model.records.find((r) => r.id === 22);
		ok(!!rec22, "§5c the new delete is judged");
		if (rec22) for (const mode of ["restore", "create_new"]) await checkPress(after, rec22, mode, "§5c");
	});

	fs.rmSync(TMP, { recursive: true, force: true });
	console.log(`\n${"=".repeat(64)}`);
	if (failures.length) {
		console.log(`FAILURES (${failures.length}):`);
		for (const f of failures) console.log(`  ✗ ${f}`);
		console.log(`\n${pass} passed, ${failures.length} failed`);
		process.exit(1);
	}
	console.log(`✓ ${pass} passed, 0 failed`);
})();
