#!/usr/bin/env node
// The Triumph submit job as server.js wires it: the <triumph-wiring> block, lifted from
// server.js's text and run with the job, the ledger and the transport as shipped, over an
// in-memory database. Only the outside world is made up.
//
//   §1 off (nothing set): no timer, startsJob() never asked, no table of its own, the
//      driver's Delivered starts nothing, and the start-up line says off
//   §2 on, a dry run with no connection settings: one timer behind startsJob(), one warning
//      naming the missing settings and never a value, the deny list's warning, its tables
//   §3 a replica: off whatever its settings say, and no transport at all
//   §4 live, the settings set: a transport, no warning; its notices are Super Admin only
//   §5 the status route: the driver's Delivered reaches the job once, after the sheet write
//   §6 a load's documents for its batch: the kinds that go, either spelling of the ID, no
//      deleted row
//
// Made-up loads and settings only (LD-TEST-*).
//   node scripts/test-triumph-wiring.js      # exits 1 on any failure
"use strict";

const path = require("path");
const { createRequire } = require("module");

const ROOT = path.join(__dirname, "..");
const SRC = require("./lib/server-source").serverSource();
const START = "// <triumph-wiring>";
const END = "// </triumph-wiring>";
if (SRC.split(START).length !== 2 || SRC.split(END).length !== 2 || SRC.indexOf(END) < SRC.indexOf(START)) {
	console.log("FAIL  server.js has no single <triumph-wiring> block: the submit job isn't wired");
	process.exit(1);
}
const BLOCK = SRC.slice(SRC.indexOf(START), SRC.indexOf(END) + END.length);
const Database = require(path.join(ROOT, "node_modules", "better-sqlite3"));
const factoring = require(path.join(ROOT, "lib", "factoring-store.js"));
const { liftRoute } = require(path.join(__dirname, "lib", "server-lift.js"));
const serverRequire = createRequire(path.join(ROOT, "server.js"));

let pass = 0;
const failures = [];
function eq(actual, expected, label) {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) { pass++; return; }
	failures.push(`${label}\n      expected ${e}\n      actual   ${a}`);
}
const ok = (cond, label) => eq(Boolean(cond), true, label);
const section = (t) => console.log(`\n${t}`);

const DENY_SETTING = require(path.join(ROOT, "lib", "driver-instructions-runtime.js")).DENY_LIST_SETTING;
const CONNECTION = {
	TRIUMPH_HOST: "made-up.example.test",
	TRIUMPH_USER: "made-up-user",
	TRIUMPH_KEY_FILE: "/made-up/not-a-real-key-file",
	TRIUMPH_HOST_FINGERPRINT: `SHA256:${"A".repeat(43)}`,
	TRIUMPH_HOST_KEY_TYPE: "ED25519",
	TRIUMPH_SUBMIT_DIR: "/made-up/submit",
};
const schema = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'index') ORDER BY name").all().map((r) => r.name);

// The block, run once with this environment. Every name it reads from server.js is provided.
function wire(env, { replica = null } = {}) {
	const db = new Database(":memory:");
	db.exec("CREATE TABLE documents (id INTEGER PRIMARY KEY, load_id TEXT, type TEXT, file_name TEXT, drive_file_id TEXT DEFAULT '', drive_url TEXT DEFAULT '', uploaded_at TEXT, deleted_at TEXT)");
	db.exec("CREATE TABLE load_invoice_drafts (id INTEGER PRIMARY KEY, load_id TEXT, invoice_id TEXT, via TEXT)");
	db.exec("CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT)");
	factoring.ensureSchema(db);
	const w = { db, logs: [], warns: [], starts: [], intervals: [], timeouts: [], notices: [], sockets: [], fetched: [] };
	w.schemaBefore = schema(db);
	const quiet = { log: (m) => w.logs.push(String(m)), warn: (m) => w.warns.push(String(m)), error: () => {}, info: () => {} };
	const scope = {
		db,
		process: { env },
		REPLICA: replica,
		require: serverRequire,
		console: quiet,
		path,
		startsJob: (name) => { w.starts.push(name); return !replica; },
		setInterval: (fn, ms) => { w.intervals.push(ms); return 0; },
		setTimeout: (fn, ms) => { w.timeouts.push(ms); return 0; },
		setImmediate: () => {},
		getJobTrackingCached: async () => ({ headers: [], data: [] }),
		integrityClosedMonthsOf: () => [],
		sheetDayKey: () => "",
		DATA_DIR: "/made-up/data",
		brokerInvoiceDraft: { prepare: async () => ({ ok: false }), render: async () => ({}), record: () => ({ recorded: false }) },
		nextInvoiceNumber: () => "11122026-1",
		logAudit: () => {},
		insertDispatchNotification: { run: (type, title, body) => w.notices.push({ type, title, body }) },
		io: { to: (room) => ({ emit: (event, payload) => w.sockets.push({ room, event, type: payload && payload.type }) }) },
		fetchDocumentBytes: async (doc) => { w.fetched.push(doc.id); return Buffer.from(`made-up bytes ${doc.id}`); },
	};
	const names = Object.keys(scope);
	const out = new Function(...names, `${BLOCK}\nreturn { triumph, triumphTransport, triumphDriverStart, TRIUMPH_NOTICE_TYPE, triumphLoadDocuments };`)(...names.map((n) => scope[n]));
	return Object.assign(w, out);
}

(async () => {
	// ---------------------------------------------------------------- §1
	section("§1 off");
	{
		const w = wire({});
		eq(w.triumph.mode, "off", "§1 nothing set: off");
		eq([w.starts, w.intervals, w.timeouts], [[], [], []], "§1 FAILS ON A BLOCK THAT STARTS A TIMER WHEN OFF: no timer, and startsJob() never asked");
		eq(schema(w.db), w.schemaBefore, "§1 no table of its own (the factoring tables are made at boot whatever the settings)");
		w.db.prepare("INSERT INTO load_factoring (load_key, load_id, factored, source, set_at, updated_at) VALUES ('ld-test-0001', 'LD-TEST-0001', 1, 'script', 'x', 'x')").run();
		w.triumphDriverStart({ session: { user: { role: "Driver" } } }, { loadId: "LD-TEST-0001", oldStatus: "At Receiver", newStatus: "Delivered" }).written();
		eq(w.db.prepare("SELECT COUNT(*) AS n FROM triumph_submissions").get().n, 0, "§1 a driver's Delivered on a marked load starts nothing");
		eq(w.logs.filter((l) => l.startsWith("[triumph]")), ["[triumph] submit off; connection settings unset"], "§1 the start-up line says off");
		eq(w.warns, [], "§1 ...and no warning");
	}

	// ---------------------------------------------------------------- §2
	section("§2 a dry run with no connection settings");
	{
		const w = wire({ TRIUMPH_SUBMIT_ENABLED: "true" });
		eq(w.triumph.mode, "dry", "§2 on: a dry run");
		eq(w.starts, ["Triumph submissions"], "§2 behind startsJob()");
		eq([w.intervals, w.timeouts], [[5 * 60 * 1000], [30 * 1000]], "§2 a tick every 5 minutes, the first soon after start");
		eq(w.triumph.startTimers({ setTimeout: () => {}, setInterval: () => {} }), false, "§2 ...started once only");
		ok(/^if \(triumph\.mode !== "off" && startsJob\("Triumph submissions"\)\) triumph\.startTimers\(\{ setTimeout, setInterval \}\);$/m.test(BLOCK), "§2 the timers start only behind startsJob(), so an import or a replica runs none");
		ok(schema(w.db).includes("triumph_meta"), "§2 its own table made");
		eq(w.warns.length, 2, "§2 two warnings at start");
		ok(w.warns[0].includes("TRIUMPH_HOST") && w.warns[0].includes("TRIUMPH_KEY_FILE") && w.warns[0].includes("TRIUMPH_HOST_FINGERPRINT"), "§2 ...one naming the missing connection settings");
		ok(/deny list isn't set/.test(w.warns[1]), "§2 ...and one for the carrier deny list");
		const set = wire({ TRIUMPH_SUBMIT_ENABLED: "true", ...CONNECTION, TRIUMPH_HOST: "made up with spaces", [DENY_SETTING]: "998877665544" });
		eq(set.warns.length, 1, "§2 an invalid host: one warning");
		ok(set.warns[0].includes("TRIUMPH_HOST") && !set.warns[0].includes("made up with spaces") && !set.warns.join(" ").includes("998877665544"), "§2 ...naming it, never its value, nor the deny list's");
	}

	// ---------------------------------------------------------------- §3
	section("§3 a replica");
	{
		const w = wire({ TRIUMPH_SUBMIT_ENABLED: "true", TRIUMPH_SUBMIT_DRY_RUN: "false", TRIUMPH_LIVE_CONFIRMED_ON: "2026-11-05", ...CONNECTION }, { replica: { dataDir: "/made-up" } });
		eq([w.triumph.mode, w.starts, w.intervals, w.timeouts], ["off", [], [], []], "§3 off in a replica, whatever its settings say: no timer");
		eq(w.triumphTransport.configured, false, "§3 FAILS ON A BLOCK THAT GIVES A REPLICA A TRANSPORT: no transport");
		let code = "";
		try {
			await w.triumphTransport.openRead();
		} catch (e) {
			code = e.code;
		}
		eq(code, "TRANSPORT_REPLICA", "§3 ...asked to connect, it refuses before anything");
	}

	// ---------------------------------------------------------------- §4
	section("§4 live, the settings set");
	{
		const w = wire({ TRIUMPH_SUBMIT_ENABLED: "true", TRIUMPH_SUBMIT_DRY_RUN: "false", TRIUMPH_LIVE_CONFIRMED_ON: "2026-11-05", ...CONNECTION, [DENY_SETTING]: "998877665544" });
		eq([w.triumph.mode, w.triumphTransport.configured, w.warns], ["live", true, []], "§4 live: a transport, and no warning");
		eq(w.logs.filter((l) => l.startsWith("[triumph]")), ["[triumph] submit live; connection settings set"], "§4 the start-up line: the mode and set or unset, never a value");
		eq(w.TRIUMPH_NOTICE_TYPE, "factoring", "§4 its notices' type");
		ok(/const SUPER_ADMIN_ONLY_NOTICE_TYPES = Object\.freeze\(\[[^\]\n]*"factoring"[^\]\n]*\]\);/.test(SRC), "§4 FAILS ON THE OLD CODE: ...which only Super Admins are served");
		ok(/insertDispatchNotification\.run\(TRIUMPH_NOTICE_TYPE, title, body, "\{\}"\);\n\t\tio\.to\("super-admin"\)\.emit\("dispatch-notification"/.test(BLOCK), "§4 ...stored as that type, and sent live to the super-admin room only");
	}

	// ---------------------------------------------------------------- §5
	section("§5 the status route");
	{
		const head = SRC.split("\n").find((l) => l.startsWith('app.put("/api/driver/status",'));
		const route = head ? liftRoute(SRC, head) : "";
		const at = (needle) => route.indexOf(needle);
		ok(at("const triumphStart = triumphDriverStart(req, { loadId, oldStatus, newStatus });") > at("autoInvoiceDriverStart("), "§5 FAILS ON THE OLD CODE: the driver's Delivered reaches the job, beside the email invoice's");
		ok(at("triumphStart.written();") > at("spreadsheets.values.batchUpdate(") && at("triumphStart.written();") < at("jtCacheInvalidate();"), "§5 ...once the sheet write has landed");
		const code = SRC.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
		eq(code.split("triumphDriverStart(").length - 1, 2, "§5 one definition, one call: nothing else starts a submission by a tap");
		eq(code.split(".deliveredByDriver(").length - 1, 1, "§5 ...and only that definition reaches the job");
	}

	// ---------------------------------------------------------------- §6
	section("§6 a load's documents for its batch");
	{
		const w = wire({});
		const add = w.db.prepare("INSERT INTO documents (id, load_id, type, file_name, drive_url, uploaded_at, deleted_at) VALUES (?, ?, ?, 'f.pdf', '/uploads/f.pdf', ?, ?)");
		add.run(1, "LD-TEST-0001", "POD", "2026-11-10 10:00:00", null);
		add.run(2, "#ld-test-0001", "BOL", "2026-11-10 09:00:00", null);
		add.run(3, "LD-TEST-0001", "RATECON", "2026-11-09 09:00:00", null);
		add.run(4, "LD-TEST-0001", "Receipt", "2026-11-10 11:00:00", null);
		add.run(5, "LD-TEST-0001", "POD", "2026-11-10 12:00:00", "2026-11-11 00:00:00");
		add.run(6, "LD-TEST-0001", "Scale Ticket", "2026-11-10 13:00:00", null);
		add.run(7, "LD-TEST-0002", "POD", "2026-11-10 10:00:00", null);
		const docs = await w.triumphLoadDocuments("LD-TEST-0001");
		eq(docs.map((d) => d.id), [2, 1, 6], "§6 its BOL, POD and scale ticket, by upload order, either spelling of the ID; no rate con (the engine gives it), receipt, deleted row or other load");
		eq(w.fetched, [2, 1, 6], "§6 ...and only those files are read");
		ok(docs.every((d) => Buffer.isBuffer(d.buffer)), "§6 ...each with its bytes");
	}

	console.log(`\n${pass} passed, ${failures.length} failed`);
	for (const f of failures) console.log(`FAIL  ${f}`);
	process.exit(failures.length ? 1 : 0);
})().catch((e) => {
	console.log(`FAIL  the runner itself: ${e && e.stack}`);
	process.exit(1);
});
