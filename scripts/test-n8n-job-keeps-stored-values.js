#!/usr/bin/env node
/**
 * POST /api/n8n/job: a later message for a load already on file never blanks
 * a stored value, and Assigned Date is written once, never re-stamped (client,
 * 2026-10-09).
 *
 *   §1 the route, lifted from server.js and run on an in-memory
 *      sheet_job_tracking (its CREATE TABLE taken from server.js):
 *      - a later message with an empty, whitespace-only, null or missing
 *        Pickup Appointment keeps the stored one; so for every other column;
 *      - a later message's Assigned Date never replaces a stored one;
 *      - a stored blank Assigned Date is filled by a later message;
 *      - a later message's non-blank values still update (Payment, Drop-off);
 *      - a message with nothing new writes nothing;
 *      - a new load is inserted as before (blanks stored as "", status
 *        Dispatched by default);
 *      - without the webhook secret the route answers 401 and writes nothing;
 *   §2 n8nJobUpdates(): every column the route reads is in N8N_JOB_COLUMNS
 *      once, and only those;
 *   §3 POST /api/n8n/keep-stored-values (what n8n's JOB DETAILS ENTRY writes),
 *      lifted with a stand-in Job Tracking: for a load already on file, a blank
 *      value comes back as the stored one and the stored Assigned Date always
 *      comes back; non-blank values come back as sent; a load matched by a
 *      different Load ID text (as appendOrUpdate would not match it) and a new
 *      load get their values back as sent, a fallback filling only a column
 *      that would be blank; the row is the one the app reads as the load ("#X"
 *      or "x" is the same load, the last of two rows wins); a header found by
 *      its trimmed name; without the secret 401; a bad body 400; a sheet that
 *      can't be read 503 (n8n then alerts and writes nothing); its own limiter;
 *      it never writes the sheet.
 *
 * SERVER_JS=<file> runs §1 against another copy of server.js (e.g. main's, to
 * show it fails there; §3's route does not exist there). Pure: no server, no network.
 * Run: node scripts/test-n8n-job-keeps-stored-values.js  # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { closure } = require("./lib/server-lift");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(process.env.SERVER_JS || path.join(ROOT, "server.js"), "utf8");
const Database = require(path.join(ROOT, "node_modules", "better-sqlite3"));

let failures = 0;
let passes = 0;
function check(name, ok, detail) {
	if (ok) { passes++; return; }
	failures++;
	console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

const HEAD = 'app.post("/api/n8n/job", (req, res) => {';
const SECRET = "test-secret";

function world() {
	const db = new Database(":memory:");
	const table = /db\.exec\(`\s*(CREATE TABLE IF NOT EXISTS sheet_job_tracking \([\s\S]*?\n\t\))\s*`\);/.exec(SRC);
	if (!table) throw new Error("sheet_job_tracking's CREATE TABLE was not found in server.js");
	db.exec(table[1]);
	const lifted = closure(SRC, { routes: [HEAD], provided: ["db", "process", "app", "console"], denied: ["getSheets", "sheets", "sendEmail", "transporter", "io", "server"] });
	const routes = {};
	const app = { post: (p, ...h) => { routes[p] = h[h.length - 1]; } };
	const proc = { env: { N8N_WEBHOOK_SECRET: SECRET } };
	new Function("db", "process", "app", "console", `"use strict";\n${lifted.text}`)(db, proc, app, console);
	const call = (body, { secret = SECRET } = {}) => {
		const out = { status: 200, body: null };
		const res = { status(c) { out.status = c; return res; }, json(b) { out.body = b; return res; } };
		routes["/api/n8n/job"]({ headers: { "x-webhook-secret": secret }, body }, res);
		return out;
	};
	const row = (loadId) => db.prepare("SELECT * FROM sheet_job_tracking WHERE load_id = ?").get(loadId);
	return { db, call, row };
}

const FIRST = {
	load_id: "900000001", details: "Mill A -> Dock B", pickup_info: "IP REF/PU#: 1",
	pickup_appointment: "9/30/2026 06:00", pickup_address: "1 Test Rd", dropoff_info: "Consignee B",
	dropoff_appointment: "9/30/2026 00:00", dropoff_address: "2 Dock St", payment: "$1,000.00",
	broker_contact_name: "Rep", phone_number: "555-0100", email: "rep@example.test",
	assigned_date: "9/30/2026, 2:06:03 PM", documents: "900000001",
};
// The shape of a later "Booked Load #" email: no pickup, a new date, a new rate.
const LATER = { ...FIRST, pickup_appointment: "", payment: "$950.00", assigned_date: "10/4/2026, 7:45:35 AM" };

// ── §1 the route ──────────────────────────────────────────────────────────────
{
	const w = world();
	check("§1 a new load is inserted", w.call(FIRST).body.action === "inserted");
	const r = w.call(LATER);
	check("§1 a later message updates the load", r.status === 200 && r.body.action === "updated", JSON.stringify(r.body));
	const row = w.row("900000001");
	check("§1 an empty Pickup Appointment keeps the stored one", row.pickup_appointment === "9/30/2026 06:00", row.pickup_appointment);
	check("§1 a later Assigned Date never replaces the stored one", row.assigned_date === "9/30/2026, 2:06:03 PM", row.assigned_date);
	check("§1 a later non-blank Payment still updates", row._payment_ === "$950.00", row._payment_);

	for (const [name, val] of [["whitespace-only", "   "], ["null", null], ["missing", undefined], ["tab-and-newline", "\t\n"]]) {
		const body = { ...LATER, dropoff_appointment: val, pickup_address: val, email: val };
		if (val === undefined) { delete body.dropoff_appointment; delete body.pickup_address; delete body.email; }
		w.call(body);
		const x = w.row("900000001");
		check(`§1 a ${name} value keeps the stored ones`, x.dropoff_appointment === "9/30/2026 00:00" && x.pickup_address === "1 Test Rd" && x.email === "rep@example.test", JSON.stringify([x.dropoff_appointment, x.pickup_address, x.email]));
	}
	const blanks = {};
	for (const k of Object.keys(FIRST)) if (k !== "load_id") blanks[k] = "";
	w.call({ load_id: "900000001", ...blanks });
	const after = w.row("900000001");
	const kept = ["details", "pickup_info", "pickup_appointment", "pickup_address", "dropoff_info", "dropoff_appointment", "dropoff_address", "broker_contact_name", "phone_number", "email", "assigned_date", "documents"]
		.filter((c) => after[c] === "");
	check("§1 an all-blank message blanks no column", kept.length === 0 && after._payment_ === "$950.00", `blanked: ${kept.join(", ")}`);

	w.call({ ...LATER, dropoff_appointment: "10/2/2026 09:00" });
	check("§1 a later non-blank Drop-off still updates", w.row("900000001").dropoff_appointment === "10/2/2026 09:00");

	// A load first written without an Assigned Date takes the first one sent.
	w.call({ load_id: "570000001", pickup_appointment: "10/8/2026 08:00" });
	check("§1 a new load without an Assigned Date stores a blank", w.row("570000001").assigned_date === "");
	w.call({ load_id: "570000001", assigned_date: "10/9/2026, 7:00:00 AM" });
	check("§1 a stored blank Assigned Date is filled", w.row("570000001").assigned_date === "10/9/2026, 7:00:00 AM", w.row("570000001").assigned_date);
	w.call({ load_id: "570000001", assigned_date: "10/10/2026, 7:00:00 AM" });
	check("§1 and then never re-stamped", w.row("570000001").assigned_date === "10/9/2026, 7:00:00 AM", w.row("570000001").assigned_date);

	const ins = w.row("570000001");
	check("§1 a new load's blanks are stored as empty text, status Dispatched", ins.details === "" && ins._payment_ === "" && ins.job_status === "Dispatched");

	const before = JSON.stringify(w.row("900000001"));
	const none = w.call({ load_id: "900000001", pickup_appointment: "", assigned_date: "10/9/2026, 7:00:00 AM" });
	check("§1 a message with nothing new writes nothing", none.body.action === "updated" && JSON.stringify(w.row("900000001")) === before);

	const denied = w.call({ ...FIRST, load_id: "570000002" }, { secret: "wrong" });
	check("§1 without the webhook secret: 401, nothing written", denied.status === 401 && !w.row("570000002"));
}

// ── §2 the column list ────────────────────────────────────────────────────────
if (!process.env.SERVER_JS) {
	const lifted = closure(SRC, { roots: ["n8nJobUpdates"], provided: [], denied: [] });
	const { N8N_JOB_COLUMNS, n8nJobUpdates } = new Function(`${lifted.text}\nreturn { N8N_JOB_COLUMNS, n8nJobUpdates };`)();
	const route = SRC.slice(SRC.indexOf(HEAD), SRC.indexOf("\n});\n", SRC.indexOf(HEAD)));
	const destructured = /const \{([^}]*)\} = req\.body;/.exec(route)[1].split(",").map((s) => s.trim()).filter(Boolean);
	const fields = N8N_JOB_COLUMNS.map(([, f]) => f);
	check("§2 every field the route reads but load_id is in N8N_JOB_COLUMNS", destructured.filter((f) => f !== "load_id").every((f) => fields.includes(f)), destructured.join(","));
	check("§2 and nothing else", fields.every((f) => destructured.includes(f)) && new Set(fields).size === fields.length);
	check("§2 n8nJobUpdates keeps a stored Assigned Date", n8nJobUpdates({ assigned_date: "x" }, { assigned_date: "y" }).length === 0);
	check("§2 n8nJobUpdates writes a first Assigned Date", JSON.stringify(n8nJobUpdates({ assigned_date: " " }, { assigned_date: "y" })) === '[["assigned_date","y"]]');
}

// ── §3 POST /api/n8n/keep-stored-values ───────────────────────────────────────
{
	const KHEAD = 'app.post("/api/n8n/keep-stored-values", n8nKeepStoredLimiter, async (req, res) => {';
	if (!SRC.includes(KHEAD)) {
		check("§3 the route exists", false, "POST /api/n8n/keep-stored-values is not in this server.js");
	} else {
		const HEADERS = ["Contract ID", "Load ID", "Details", "Pickup Info", "Pickup Appointment", "Pickup Address", "Assigned Date", "Documents", "  Payment  "];
		const STORED = ["", "900000001", "Mill A", "IP REF/PU#: 1", "9/30/2026 06:00", "1 Test Rd", "9/30/2026, 2:06:03 PM", "BOL-77", "$1,000.00"];
		const lifted = closure(SRC, { routes: [KHEAD], provided: ["getSheets", "SPREADSHEET_ID", "n8nKeepStoredLimiter", "console", "process", "app", "require"], denied: ["sendEmail", "transporter", "io", "server"] });
		const routes = {};
		const app = { post: (p, ...h) => { routes[p] = h[h.length - 1]; } };
		let sheetValues = [HEADERS, STORED];
		let readFails = false;
		const calls = [];
		const sheets = { spreadsheets: { values: {
			get: async (q) => { calls.push(["get", q.range]); if (readFails) throw new Error("quota"); return { data: { values: sheetValues } }; },
			update: async () => { calls.push(["update"]); }, append: async () => { calls.push(["append"]); }, batchUpdate: async () => { calls.push(["batchUpdate"]); },
		}, batchUpdate: async () => { calls.push(["batchUpdate"]); } } };
		const warnings = [];
		const quiet = { ...console, error: () => {}, warn: (m) => warnings.push(m) };
		new Function("getSheets", "SPREADSHEET_ID", "n8nKeepStoredLimiter", "console", "process", "app", "require", `"use strict";\n${lifted.text}`)(
			async () => sheets, "sheet-under-test", (q, r, next) => next(), quiet, { env: { N8N_EXTRACT_SECRET: SECRET } }, app, require,
		);
		const post = async (body, { secret = SECRET } = {}) => {
			const out = { status: 200, body: null };
			const res = { status(c) { out.status = c; return res; }, json(b) { out.body = b; return res; } };
			await routes["/api/n8n/keep-stored-values"]({ headers: { "x-webhook-secret": secret }, body, ip: "" }, res);
			return out;
		};
		(async () => {
			// A later "Booked Load #" email: no pickup, a new date, a new rate, no BOL.
			const later = { "Load ID": "900000001", Details: "Mill A -> Dock B", "Pickup Info": "IP REF/PU#: 1", "Pickup Appointment": "", "Pickup Address": "  ", "Assigned Date": "10/4/2026, 7:45:35 AM", Documents: "", "  Payment  ": "$950.00" };
			const r = await post({ loadId: "900000001", values: later, fallbacks: { Documents: "900000001" } });
			check("§3 a load on file is found", r.status === 200 && r.body.found === true && r.body.rows === 1, JSON.stringify(r.body));
			const v = r.body.values || {};
			check("§3 a blank Pickup Appointment comes back as the stored one", v["Pickup Appointment"] === "9/30/2026 06:00", v["Pickup Appointment"]);
			check("§3 a whitespace-only value comes back as the stored one", v["Pickup Address"] === "1 Test Rd", v["Pickup Address"]);
			check("§3 the stored Assigned Date always comes back", v["Assigned Date"] === "9/30/2026, 2:06:03 PM", v["Assigned Date"]);
			check("§3 a stored value beats a fallback", v.Documents === "BOL-77", v.Documents);
			check("§3 non-blank values come back as sent", v.Details === "Mill A -> Dock B" && v["  Payment  "] === "$950.00" && v["Load ID"] === "900000001");
			check("§3 the kept columns are named", JSON.stringify((r.body.kept || []).sort()) === JSON.stringify(["Assigned Date", "Documents", "Pickup Address", "Pickup Appointment"]), JSON.stringify(r.body.kept));
			check("§3 every column sent comes back", Object.keys(v).join("|") === Object.keys(later).join("|"));

			sheetValues = [HEADERS, [...STORED.slice(0, 6), "", "BOL-77", "$1,000.00"]];
			const fill = await post({ loadId: "900000001", values: { "Assigned Date": "10/4/2026, 7:45:35 AM" } });
			check("§3 a stored blank Assigned Date takes the one sent", fill.body.values["Assigned Date"] === "10/4/2026, 7:45:35 AM");
			sheetValues = [HEADERS, STORED];

			const fresh = await post({ loadId: "900000002", values: { "Load ID": "900000002", "Pickup Appointment": "", Documents: "", "Assigned Date": "10/9/2026, 7:00:00 AM" }, fallbacks: { Documents: "900000002" } });
			check("§3 a new load gets its values back as sent", fresh.body.found === false && fresh.body.values["Assigned Date"] === "10/9/2026, 7:00:00 AM" && fresh.body.values["Pickup Appointment"] === "");
			check("§3 a fallback fills a column with nothing stored", fresh.body.values.Documents === "900000002");
			const sent = await post({ loadId: "900000002", values: { Documents: "BOL-1" }, fallbacks: { Documents: "900000002" } });
			check("§3 a value sent beats its fallback", sent.body.values.Documents === "BOL-1");

			for (const [name, id] of [["a leading #", "#900000001"], ["edge spaces", " 900000001 "]]) {
				const x = await post({ loadId: id, values: { "Pickup Appointment": "" } });
				check(`§3 ${name} is the same load`, x.body.found === true && x.body.values["Pickup Appointment"] === "9/30/2026 06:00", JSON.stringify(x.body));
			}
			sheetValues = [HEADERS, ["", "#900000001", "Mill A", "", "9/1/2026 00:00", "", "9/1/2026, 1:00:00 PM", "", ""], ["", "900000001", "Mill A", "", "9/30/2026 06:00", "", "9/30/2026, 2:06:03 PM", "", ""]];
			const two = await post({ loadId: "900000001", values: { "Pickup Appointment": "", "Assigned Date": "10/4/2026, 7:45:35 AM" } });
			check("§3 with two rows, the last (the one the app reads) wins", two.body.rows === 2 && two.body.values["Pickup Appointment"] === "9/30/2026 06:00" && two.body.values["Assigned Date"] === "9/30/2026, 2:06:03 PM", JSON.stringify(two.body));
			sheetValues = [HEADERS, STORED];
			const trimmed = await post({ loadId: "900000001", values: { Payment: "" } });
			check("§3 a column named without the header's spaces still finds it", trimmed.body.values.Payment === "$1,000.00", JSON.stringify(trimmed.body.values));

			const no = await post({ loadId: "900000001", values: later }, { secret: "wrong" });
			check("§3 without the secret: 401, logged once", no.status === 401 && warnings.length === 1 && /keep-stored-values: 1 unauthorized/.test(warnings[0]), JSON.stringify(warnings));
			for (const [name, body] of [["no loadId", { values: {} }], ["a bare #", { loadId: "#", values: {} }], ["values not an object", { loadId: "1", values: "x" }], ["values an array", { loadId: "1", values: [] }], ["a nested value", { loadId: "1", values: { a: { b: 1 } } }], ["fallbacks not an object", { loadId: "1", values: {}, fallbacks: "x" }], ["too many columns", { loadId: "1", values: Object.fromEntries(Array.from({ length: 61 }, (_, i) => [`c${i}`, "x"])) }], ["an over-long value", { loadId: "1", values: { a: "x".repeat(20001) } }]]) {
				const b = await post(body);
				check(`§3 refuses ${name}: 400`, b.status === 400, JSON.stringify(b.body));
			}
			readFails = true;
			const down = await post({ loadId: "900000001", values: later });
			check("§3 a sheet that can't be read: 503, so n8n alerts and writes nothing", down.status === 503 && down.body.code === "JOB_TRACKING_UNREADABLE");
			check("§3 it never writes the sheet", calls.every(([k]) => k === "get") && calls.every(([, range]) => range === "Job Tracking"), JSON.stringify(calls));
			const limiter = /const n8nKeepStoredLimiter = rateLimit\(\{[\s\S]*?\n\}\);/.exec(SRC);
			check("§3 it has its own limiter, keyed like load-distance's", limiter && /n8nDistanceAuthorized\(req\)/.test(limiter[0]) && /keep-stored-values requests/.test(limiter[0]) && !/distance requests/.test(limiter[0]));
			console.log(`test-n8n-job-keeps-stored-values: ${passes} passed, ${failures} failed`);
			process.exit(failures ? 1 : 0);
		})().catch((err) => { console.error(err); process.exit(1); });
	}
}

if (!SRC.includes('app.post("/api/n8n/keep-stored-values"')) {
	console.log(`test-n8n-job-keeps-stored-values: ${passes} passed, ${failures} failed`);
	process.exit(failures ? 1 : 0);
}
