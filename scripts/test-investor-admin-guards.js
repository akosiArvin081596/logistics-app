#!/usr/bin/env node
/**
 * The admin investor-record routes validate, refuse collisions and audit; and
 * a Super Admin's portal preview of someone who is not an investor is a 404.
 *
 * §1–§4 POST / PUT / DELETE /api/investors (Super Admin):
 *   - 400 INVALID_FIELD (`field`): a missing or over-120-character name (after
 *     control and format characters are cleaned out), a status other than
 *     Active / Inactive, notes over 2000 characters, a text field that is not
 *     text, a userId that is not an id.
 *   - 409 CARRIER_NAME_TAKEN when another record holds the carrier name
 *     (trimmed, case-insensitive; on PUT only when it changes), 409
 *     INVESTOR_USER_TAKEN when the user is linked to another record.
 *   - 404 { error: "Investor not found", code: "INVESTOR_NOT_FOUND" } for an id
 *     that is not on file (PUT and DELETE).
 *   - audit rows create_investor / update_investor (changed fields, before →
 *     after, the tax id by name only) / delete_investor.
 *   - every handler answers a failure with JSON, and DELETE is still a hard
 *     delete of the record alone.
 * §5 resolvePreviewUser(): a Super Admin's as_user_id that is not an Investor
 *    user sets targetMissing (no such user, another role, not a positive
 *    integer); with no as_user_id, or for any other role, nothing changes.
 * §6 every route that calls it answers targetMissing with 404
 *    INVESTOR_NOT_FOUND before anything else (source), and one of them run end
 *    to end: GET /api/investor/payouts/:period/history.
 * §7 MUTANTS: the carrier check dropped, the targetMissing answer dropped.
 *
 * Every route and helper is lifted out of server.js and run against an
 * in-memory SQLite built from server.js's own DDL. Pure: no server, no app.db.
 *
 * Run: node scripts/test-investor-admin-guards.js    # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");

let pass = 0;
const failures = [];
const ok = (cond, msg) => { if (cond) pass++; else failures.push(msg); };
function die(msg) { console.error(`FAILED: ${msg}`); process.exit(1); }
function section(title) { console.log(`\n${title}`); }

let Database;
try {
	Database = require("better-sqlite3");
} catch (e) {
	die(`a server dependency did not load (${e.message}); run npm ci under the .nvmrc Node`);
}
const piiMask = require(path.join(ROOT, "lib", "pii-mask"));

// ── lift the shipped code ───────────────────────────────────────────────────
function liftFunction(name) {
	const needle = `\nfunction ${name}(`;
	const hits = SRC.split(needle).length - 1;
	if (hits !== 1) die(`expected exactly 1 definition of ${name}() in server.js, found ${hits}`);
	const a = SRC.indexOf(needle) + 1;
	const end = SRC.indexOf("\n}\n", a);
	if (end < 0) die(`no column-0 "}" after ${name}()`);
	return SRC.slice(a, end + 2);
}
function liftRoute(head) {
	const needle = `\n${head}`;
	const hits = SRC.split(needle).length - 1;
	if (hits !== 1) die(`expected exactly 1 registration ${JSON.stringify(head)}, found ${hits}`);
	const a = SRC.indexOf(needle) + 1;
	const end = SRC.indexOf("\n});", a);
	if (end < 0) die(`no column-0 "});" after ${head}`);
	return SRC.slice(a, end + "\n});".length);
}
function liftConst(head, close = null) {
	const needle = `\n${head}`;
	const hits = SRC.split(needle).length - 1;
	if (hits !== 1) die(`expected exactly 1 statement starting ${JSON.stringify(head)}, found ${hits}`);
	const a = SRC.indexOf(needle) + 1;
	const end = close ? SRC.indexOf(close, a) : SRC.indexOf(";\n", a);
	if (end < 0) die(`no end found after ${head}`);
	return SRC.slice(a, end + (close ? close.length : 1));
}
const code = (s) => s.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");

const ROUTES = {
	post: liftRoute('app.post("/api/investors", requireRole("Super Admin"), (req, res) => {'),
	put: liftRoute('app.put("/api/investors/:id", requireRole("Super Admin"), (req, res) => {'),
	del: liftRoute('app.delete("/api/investors/:id", requireRole("Super Admin"), (req, res) => {'),
	history: liftRoute('app.get("/api/investor/payouts/:period/history", requireRole("Super Admin", "Investor"), (req, res) => {'),
};
const PIECES = [
	liftConst("const INVESTOR_RECORD_TEXT_FIELDS = [", "\n];"),
	liftConst("const INVESTOR_RECORD_STATUSES = "),
	liftFunction("readInvestorRecordBody"),
	liftFunction("investorCarrierHolder"),
	liftFunction("investorRecordConflict"),
	liftFunction("investorRecordId"),
	liftConst("const EVIDENCE_TEXT_STRIP = "),
	liftFunction("sanitizeEvidenceText"),
	liftFunction("sanitizeInvoiceNotes"),
	liftFunction("logAudit"),
	liftFunction("scrubPurgeMarker"),
	liftFunction("auditText"),
	liftFunction("resolvePreviewUser"),
].join("\n");
function buildModule(db, pieces = PIECES) {
	return new Function("db", `"use strict";\n${pieces}\nreturn { INVESTOR_RECORD_TEXT_FIELDS, readInvestorRecordBody, investorCarrierHolder, investorRecordConflict, investorRecordId, logAudit, auditText, resolvePreviewUser };`)(db);
}

// ── fixtures ────────────────────────────────────────────────────────────────
function ddl() {
	const inv = SRC.match(/CREATE TABLE IF NOT EXISTS investors \(([\s\S]*?)\n\t\)/);
	const users = SRC.match(/CREATE TABLE IF NOT EXISTS users \(([\s\S]*?)\n\t\)/);
	const audit = SRC.match(/CREATE TABLE IF NOT EXISTS audit_trail \(([\s\S]*?)\n\t\)/);
	if (!inv || !users || !audit) die("could not locate the investors / users / audit_trail DDL");
	const alters = [...SRC.matchAll(/ALTER TABLE investors ADD COLUMN [^"]*/g)].map((m) => m[0]).filter((a) => !/carrier_name/.test(a));
	const unique = SRC.match(/CREATE UNIQUE INDEX IF NOT EXISTS idx_inv_carrier ON investors\(carrier_name\)/);
	if (!unique) die("could not locate the investors.carrier_name UNIQUE index");
	return [`CREATE TABLE investors (${inv[1]}\n)`, ...alters, unique[0], `CREATE TABLE users (${users[1]}\n)`, `CREATE TABLE audit_trail (${audit[1]}\n)`,
		"CREATE TABLE investor_payout_history (id INTEGER PRIMARY KEY AUTOINCREMENT, payout_id INTEGER, owner_id INTEGER, period TEXT, kind TEXT, old_amount REAL, new_amount REAL, delta REAL, detail TEXT, breakdown TEXT, actor TEXT, changed_at TEXT)"];
}
const SUPER = { id: 1, username: "super_admin", role: "Super Admin" };
const INV_A = { id: 2, username: "inv_a", role: "Investor" };
function makeWorld() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "investor-admin-"));
	const db = new Database(":memory:");
	for (const sql of ddl()) db.exec(sql);
	const user = db.prepare("INSERT INTO users (id, username, password_hash, role, driver_name) VALUES (?, ?, 'x', ?, '')");
	user.run(1, "super_admin", "Super Admin");
	user.run(2, "inv_a", "Investor");
	user.run(3, "inv_b", "Investor");
	user.run(4, "kevin", "Dispatcher");
	db.prepare("INSERT INTO investors (user_id, full_name, carrier_name, status, notes, ein_ssn) VALUES (2, 'Investor A', 'Investor A', 'Active', 'first', '12-3456789')").run();
	db.prepare("INSERT INTO investor_payout_history (owner_id, period, kind, old_amount, new_amount, delta, changed_at) VALUES (2, '2026-08', 'refresh', 0, 100, 100, '2026-09-01T00:00:00Z')").run();
	return { root, db };
}
function mountRoute(routeSrc, env) {
	let handler = null;
	const grab = (p, ...fns) => { handler = fns[fns.length - 1]; };
	const all = { app: { get: grab, post: grab, put: grab, delete: grab }, requireRole: () => (req, res, next) => next(), ...env };
	const names = Object.keys(all);
	new Function(...names, routeSrc)(...names.map((k) => all[k]));
	if (typeof handler !== "function") die("a lifted route did not register a handler");
	return (req) => {
		const out = { status: 200, body: null };
		const res = { status(c) { out.status = c; return this; }, json(b) { out.body = b; return this; } };
		const e = console.error;
		console.error = () => {};
		try { handler({ params: {}, query: {}, body: {}, ...req }, res); } finally { console.error = e; }
		return out;
	};
}
function mount(w, routes = ROUTES, pieces = PIECES) {
	const m = buildModule(w.db, pieces);
	const events = [];
	const env = { db: w.db, ...m, piiMask, fs, path, __dirname: w.root, notifyChange: (d) => events.push(d) };
	const r = Object.fromEntries(Object.entries(routes).map(([k, src]) => [k, mountRoute(src, env)]));
	return {
		m, events,
		post: (body) => r.post({ session: { user: SUPER }, body }),
		put: (id, body) => r.put({ session: { user: SUPER }, params: { id: String(id) }, body }),
		del: (id) => r.del({ session: { user: SUPER }, params: { id: String(id) } }),
		history: (user, query) => r.history({ session: { user }, params: { period: "2026-08" }, query }),
	};
}
const auditsOf = (w, action) => w.db.prepare("SELECT * FROM audit_trail WHERE action = ? ORDER BY id").all(action);
const recordOf = (w, id) => w.db.prepare("SELECT * FROM investors WHERE id = ?").get(id);

// ─────────────────────────────────────────────────────── §1 POST
function postSection(routes = ROUTES) {
	const r = [];
	const t = (cond, name) => r.push({ ok: !!cond, name });
	const w = makeWorld();
	const app = mount(w, routes);
	const body = { fullName: "QA-TEST-DUP", carrierName: "QA-TEST-DUP", status: "Active", notes: "QA-TEST" };
	const first = app.post(body);
	t(first.status === 200 && first.body.id, `§1 a new record: 200 with its id (got ${first.status} ${JSON.stringify(first.body)})`);
	const a = auditsOf(w, "create_investor");
	t(a.length === 1 && a[0].entity === "investor" && Number(a[0].entity_id) === Number(first.body.id) && /QA-TEST-DUP/.test(a[0].details), "§1 ...audited as create_investor");
	const second = app.post(body);
	t(second.status === 409 && second.body.code === "CARRIER_NAME_TAKEN", `§1 the same name again: 409 CARRIER_NAME_TAKEN (got ${second.status} ${JSON.stringify(second.body)})`);
	const variant = app.post({ fullName: "Someone Else", carrierName: "  qa-test-dup " });
	t(variant.status === 409 && variant.body.code === "CARRIER_NAME_TAKEN", "§1 ...in another case and spacing too");
	const byName = app.post({ fullName: "Investor A" });
	t(byName.status === 409 && byName.body.code === "CARRIER_NAME_TAKEN" && /"Investor A"/.test(byName.body.error), "§1 a name that defaults onto a held carrier name: 409 naming the record");
	t(w.db.prepare("SELECT COUNT(*) AS n FROM investors WHERE LOWER(carrier_name) = 'qa-test-dup'").get().n === 1, "§1 ...one record under that name");
	const linked = app.post({ fullName: "Second Link", userId: 2 });
	t(linked.status === 409 && linked.body.code === "INVESTOR_USER_TAKEN", `§1 a user already linked: 409 INVESTOR_USER_TAKEN (got ${linked.status} ${JSON.stringify(linked.body)})`);

	const before = w.db.prepare("SELECT COUNT(*) AS n FROM investors").get().n;
	const refuse = (label, b, field) => {
		const x = app.post(b);
		t(x.status === 400 && x.body.code === "INVALID_FIELD" && x.body.field === field, `§1 ${label}: 400 INVALID_FIELD ${field} (got ${x.status} ${JSON.stringify(x.body)})`);
	};
	refuse("no name", { notes: "x" }, "fullName");
	refuse("a blank name", { fullName: "   " }, "fullName");
	refuse("a name of control characters only", { fullName: String.fromCodePoint(0, 0x200b, 0x202e) }, "fullName");
	refuse("a 121-character name", { fullName: "n".repeat(121) }, "fullName");
	refuse("a name that is a number", { fullName: 42 }, "fullName");
	refuse("status Pending", { fullName: "Status Test", status: "Pending" }, "status");
	refuse("status in another case", { fullName: "Status Test", status: "active" }, "status");
	refuse("notes of 2001 characters", { fullName: "Notes Test", notes: "x".repeat(2001) }, "notes");
	refuse("an address that is an object", { fullName: "Obj Test", address: { street: "1" } }, "address");
	refuse("a userId that is not an id", { fullName: "Id Test", userId: "2abc" }, "userId");
	t(w.db.prepare("SELECT COUNT(*) AS n FROM investors").get().n === before, "§1 ...nothing stored for any refusal");

	const ctl = app.post({ fullName: `${"n".repeat(119)}${String.fromCodePoint(0x00ad)}m`, notes: `line one\r\nline two${String.fromCodePoint(0x202e)}`, status: "" });
	const row = ctl.body && recordOf(w, ctl.body.id);
	t(ctl.status === 200 && row && Array.from(row.full_name).length === 120 && !/[\p{Cf}]/u.test(row.full_name) && row.status === "Active",
		`§1 the length is counted after cleaning, and a blank status is Active (got ${ctl.status} ${JSON.stringify(ctl.body)} ${row && row.full_name.length})`);
	t(row && row.notes === "line one\nline two", `§1 notes keep their line break and lose the format character (got ${JSON.stringify(row && row.notes)})`);
	const max = app.post({ fullName: "Notes Max", notes: "x".repeat(2000) });
	t(max.status === 200, "§1 notes of exactly 2000 characters are accepted");
	return r;
}

// ─────────────────────────────────────────────────────── §2 PUT
function putSection() {
	const r = [];
	const t = (cond, name) => r.push({ ok: !!cond, name });
	const w = makeWorld();
	const app = mount(w);
	for (const id of [99999, "abc", "0", "1.5"]) {
		const x = app.put(id, { notes: "x" });
		t(x.status === 404 && JSON.stringify(x.body) === JSON.stringify({ error: "Investor not found", code: "INVESTOR_NOT_FOUND" }),
			`§2 PUT of id ${JSON.stringify(id)}: 404 INVESTOR_NOT_FOUND (got ${x.status} ${JSON.stringify(x.body)})`);
	}
	const notes = app.put(1, { notes: "QA-TEST F4" });
	const row = recordOf(w, 1);
	t(notes.status === 200 && row.notes === "QA-TEST F4" && row.full_name === "Investor A" && row.carrier_name === "Investor A" && row.user_id === 2 && row.ein_ssn === "12-3456789",
		`§2 a notes-only PUT (F4's) changes the notes and nothing else (got ${notes.status} ${JSON.stringify(row)})`);
	let a = auditsOf(w, "update_investor");
	t(a.length === 1 && a[0].details === "notes: first → QA-TEST F4", `§2 ...audited as update_investor, before → after (got ${JSON.stringify(a)})`);
	const same = app.put(1, { fullName: "Investor A", status: "Active", notes: "QA-TEST F4" });
	t(same.status === 200 && auditsOf(w, "update_investor").length === 1, "§2 an edit that changes nothing writes no audit row");

	app.post({ fullName: "Other Holder", carrierName: "Held Name" });
	const taken = app.put(1, { carrierName: "held name" });
	t(taken.status === 409 && taken.body.code === "CARRIER_NAME_TAKEN" && recordOf(w, 1).carrier_name === "Investor A", "§2 changing to a held carrier name: 409, unchanged");
	// A pair of case-variant records stored before the check: editing one of them
	// without touching its carrier name still saves.
	w.db.prepare("INSERT INTO investors (full_name, carrier_name) VALUES ('Legacy Upper', 'LEGACY')").run();
	const legacyId = Number(w.db.prepare("INSERT INTO investors (full_name, carrier_name) VALUES ('Legacy Lower', 'legacy')").run().lastInsertRowid);
	const legacy = app.put(legacyId, { fullName: "Legacy Lower", carrierName: "legacy", notes: "kept" });
	t(legacy.status === 200 && recordOf(w, legacyId).notes === "kept", `§2 an unchanged carrier name is not re-checked (got ${legacy.status} ${JSON.stringify(legacy.body)})`);

	const blank = app.put(1, { fullName: "" });
	t(blank.status === 400 && blank.body.field === "fullName" && recordOf(w, 1).full_name === "Investor A", "§2 a sent blank name: 400 INVALID_FIELD fullName, unchanged");
	const badStatus = app.put(1, { status: "Deleted" });
	t(badStatus.status === 400 && badStatus.body.field === "status", "§2 a bad status: 400 INVALID_FIELD status");
	const BULLET = String.fromCodePoint(0x2022);
	const masked = app.put(1, { einSsn: `${BULLET.repeat(4)}6789`, contactPerson: "QA Person" });
	a = auditsOf(w, "update_investor");
	t(masked.status === 200 && recordOf(w, 1).ein_ssn === "12-3456789" && recordOf(w, 1).contact_person === "QA Person",
		"§2 a masked tax id is never saved over the real one");
	const tax = app.put(1, { einSsn: "98-7654321" });
	a = auditsOf(w, "update_investor");
	t(tax.status === 200 && a[a.length - 1].details === "ein_ssn changed" && !/98-7654321|12-3456789/.test(a.map((x) => x.details).join(" ")),
		`§2 a tax id change is audited by name only (got ${JSON.stringify(a[a.length - 1])})`);
	return r;
}

// ─────────────────────────────────────────────────────── §3 DELETE
function deleteSection() {
	const r = [];
	const t = (cond, name) => r.push({ ok: !!cond, name });
	const w = makeWorld();
	const app = mount(w);
	const missing = app.del(99999);
	t(missing.status === 404 && JSON.stringify(missing.body) === JSON.stringify({ error: "Investor not found", code: "INVESTOR_NOT_FOUND" }),
		`§3 DELETE of a missing id: 404 { error, code } (got ${missing.status} ${JSON.stringify(missing.body)})`);
	const gone = app.del(1);
	const a = auditsOf(w, "delete_investor");
	t(gone.status === 200 && !recordOf(w, 1) && w.db.prepare("SELECT COUNT(*) AS n FROM users WHERE id = 2").get().n === 1,
		"§3 DELETE removes the record alone (a hard delete; the linked account stays)");
	t(a.length === 1 && Number(a[0].entity_id) === 1 && /Investor A/.test(a[0].details) && /user 2/.test(a[0].details), `§3 ...audited as delete_investor (got ${JSON.stringify(a)})`);
	const again = app.del(1);
	t(again.status === 404 && again.body.code === "INVESTOR_NOT_FOUND", "§3 deleting it again: 404");
	return r;
}

// ─────────────────────────────────────────────────────── §4 failures answer JSON
function failureSection() {
	const r = [];
	const t = (cond, name) => r.push({ ok: !!cond, name });
	const w = makeWorld();
	const app = mount(w);
	w.db.exec("CREATE TRIGGER boom BEFORE INSERT ON investors BEGIN SELECT RAISE(ABORT, 'simulated'); END;");
	const p = app.post({ fullName: "Boom" });
	t(p.status === 500 && p.body && typeof p.body.error === "string" && !/simulated/.test(p.body.error), `§4 a failing POST answers 500 JSON without the raw error (got ${p.status} ${JSON.stringify(p.body)})`);
	w.db.exec("CREATE TRIGGER boom_u BEFORE UPDATE ON investors BEGIN SELECT RAISE(ABORT, 'simulated'); END;");
	const u = app.put(1, { notes: "x" });
	t(u.status === 500 && u.body && typeof u.body.error === "string", "§4 a failing PUT answers 500 JSON");
	w.db.exec("CREATE TRIGGER boom_d BEFORE DELETE ON investors BEGIN SELECT RAISE(ABORT, 'simulated'); END;");
	const d = app.del(1);
	t(d.status === 500 && d.body && typeof d.body.error === "string", "§4 a failing DELETE answers 500 JSON");
	return r;
}

// ─────────────────────────────────────────────────────── §5 resolvePreviewUser
function previewSection() {
	const r = [];
	const t = (cond, name) => r.push({ ok: !!cond, name });
	const w = makeWorld();
	const { resolvePreviewUser } = buildModule(w.db);
	const call = (user, q) => resolvePreviewUser({ session: { user }, query: q === undefined ? {} : { as_user_id: q } });
	const none = call(SUPER);
	t(!none.isPreview && !none.targetMissing && none.effectiveUserId === 1, "§5 a Super Admin with no as_user_id: unchanged (themselves, no preview)");
	t(!call(SUPER, "").targetMissing, "§5 an empty as_user_id is no as_user_id");
	const real = call(SUPER, "2");
	t(real.isPreview && real.effectiveUserId === 2 && real.effectiveUsername === "inv_a" && !real.targetMissing, "§5 an Investor's id: the preview");
	for (const bad of ["99999999", "4", "1", "abc", "0", "-2", "2abc", ["2", "3"]]) {
		const x = call(SUPER, bad);
		t(x.targetMissing === true && !x.isPreview, `§5 as_user_id ${JSON.stringify(bad)}: targetMissing (got ${JSON.stringify({ targetMissing: x.targetMissing, isPreview: x.isPreview })})`);
	}
	const inv = call(INV_A, "3");
	t(!inv.targetMissing && !inv.isPreview && inv.effectiveUserId === 2, "§5 an Investor's as_user_id is ignored, as before");
	return r;
}

// ─────────────────────────────────────────────────────── §6 the routes
function routesSection(src = SRC, routes = ROUTES) {
	const r = [];
	const t = (cond, name) => r.push({ ok: !!cond, name });
	const lines = code(src).split("\n");
	const calls = lines.map((l, i) => [l, i]).filter(([l]) => /const preview = resolvePreviewUser\(req\);/.test(l));
	const answered = calls.filter(([, i]) => /^\s*if \(preview\.targetMissing\) return res\.status\(404\)\.json\(\{ error: "Investor not found", code: "INVESTOR_NOT_FOUND" \}\);$/.test(lines[i + 1] || ""));
	t(calls.length >= 14 && answered.length === calls.length,
		`§6 every route that resolves a preview answers targetMissing with 404 on the next line (${answered.length} of ${calls.length})`);
	const w = makeWorld();
	const app = mount(w, routes);
	const missing = app.history(SUPER, { as_user_id: "99999999" });
	t(missing.status === 404 && missing.body.code === "INVESTOR_NOT_FOUND", `§6 GET /api/investor/payouts/2026-08/history?as_user_id=99999999: 404 INVESTOR_NOT_FOUND (got ${missing.status} ${JSON.stringify(missing.body)})`);
	const unscoped = app.history(SUPER, {});
	t(unscoped.status === 400, "§6 ...with no as_user_id, the Super Admin's answer is unchanged (400: name an investor)");
	const preview = app.history(SUPER, { as_user_id: "2" });
	t(preview.status === 200 && preview.body.entries.length === 1, "§6 ...a real investor's id previews their history");
	const own = app.history(INV_A, { as_user_id: "99999999" });
	t(own.status === 200 && own.body.entries.length === 1, "§6 ...and an Investor's own read ignores as_user_id");
	return r;
}

// ─────────────────────────────────────────────────────── §7 mutants
function mutantSection() {
	const r = [];
	const t = (cond, name) => r.push({ ok: !!cond, name });
	const failed = (results) => results.some((x) => !x.ok);
	const swap = (src, from, to) => { if (!src.includes(from)) die(`mutant anchor not found: ${from}`); return src.replace(from, to); };
	const noCarrier = { ...ROUTES, post: swap(ROUTES.post, "if (holder) {", "if (false) {") };
	t(failed(postSection(noCarrier)), "MUTANT POST's carrier-name check dropped: caught by §1");
	const LINE = '\t\tif (preview.targetMissing) return res.status(404).json({ error: "Investor not found", code: "INVESTOR_NOT_FOUND" });\n';
	const noAnswer = { ...ROUTES, history: swap(ROUTES.history, LINE, "") };
	t(failed(routesSection(SRC.replace(ROUTES.history, noAnswer.history), noAnswer)), "MUTANT the history route's targetMissing answer dropped: caught by §6");
	return r;
}

function record(results) {
	for (const x of results) ok(x.ok, x.name);
	console.log(`  ${results.filter((x) => x.ok).length}/${results.length} checks`);
}

section("§1 POST /api/investors");
record(postSection());
section("§2 PUT /api/investors/:id");
record(putSection());
section("§3 DELETE /api/investors/:id");
record(deleteSection());
section("§4 failures answer JSON");
record(failureSection());
section("§5 resolvePreviewUser()");
record(previewSection());
section("§6 the preview routes");
record(routesSection());
section("§7 mutants");
record(mutantSection());

if (failures.length) {
	console.error(`\nFAILURES (${failures.length}):`);
	for (const f of failures) console.error(`  ✗ ${f}`);
	console.error(`\n${pass} passed, ${failures.length} failed`);
	process.exit(1);
}
console.log(`\n✓ ${pass} assertions passed`);
