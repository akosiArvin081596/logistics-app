#!/usr/bin/env node
// Broker contact data, by VALUE, in every response a non-Super-Admin can get
// (the owner's rule, 2026-09-26 and 2026-10-15: Dispatchers, Drivers, Investors
// and signed-out callers get no broker emails or phones in any API response,
// whatever column holds them; a Super Admin's responses are unchanged).
//
// PENDING: this runner lives in scripts/pending/ so `npm run check` (which runs
// scripts/test-*.js only) does not run it while the fix is planned. It FAILS on
// main for every response listed in the plan as leaking, and passes for Super
// Admin. The fix moves it to scripts/ beside test-broker-column-redaction.js.
//
// WHAT main DOES. sanitizeBrokerColumns() blanks the columns whose HEADER reads
// as broker contact (BROKER_WITHHELD_RE: "Broker Contact Name", "Phone Number",
// "Email"). A broker email or phone stored under any other header is served as
// stored: Job Tracking's "Contract ID" holds the broker's email on a block of
// 2025 rows, and "Details" / "Pickup Info" are free text that can hold either.
//
// WHAT EACH SECTION RUNS. Every route is lifted whole out of server.js and run
// with only its I/O stubbed (sheet reads, SQLite, Gemini, sockets). Any other
// identifier the route touches is the shipped top-level function or constant,
// extracted from server.js on first use (see makeScope()), so a helper the fix
// adds is picked up without editing this file, as long as it is a top-level
// `function` or `const` in server.js, or a lib/ module.
//
// THE FIXTURE IS MADE UP: example.invalid addresses and 555-01xx numbers. No
// real person's data is in this file. One row (PATTERNS) carries the shapes a
// detector has to catch: +1 / 1- prefixes, spaces only, en-dashes, mixed
// separators, "(555)010-...", an extension, the row's own broker phone as bare
// digits, emails with a +tag, a subdomain, capitals, "mailto:" and <angle
// brackets>, a phone in an address (and so in the derived `_` fields), and an
// email under a column with a blank header.
//
// Sections:
//   §1  Dispatcher: GET /api/dashboard, GET /api/load/:loadId, PUT /api/load/:loadId
//       (its answer), GET /api/locations/latest, POST /api/loads/ratecon/extract,
//       GET /api/dispatch-notifications, and the re-issue notice as SENT to the
//       dispatch room (stored row and socket payload, sendReissueAlert())
//   §2  Writers: a non-Super-Admin save that sends a cell back as now served
//       (blank, or with "[contact withheld]" in place of the contact) keeps the
//       stored value; a Super Admin's save of a legacy row is not refused
//   §3  Driver: GET /api/driver/:driverName
//   §4  Investor: GET /api/investor/load-report (no free-text column today; a guard)
//   §5  Signed out: GET /api/public/track/:loadId (a fixed field list; a guard)
//   Super Admin: every route above, every planted value of the rows it serves
//   "Still served": what is not contact data reaches every role (over-redaction)
//
// ON main (c998301): 39 passed, 15 failed. The 15 are 13 leak checks (§1, §3)
// and the 2 writer checks with no baseline to fall back on (§2). §4, §5, every Super Admin check and every "still served" check
// pass on main and must keep passing.
//
// DECISIONS THESE CHECKS ASSUME (the plan's recommendations; change the check,
// not the fixture, if the user picks otherwise):
//   - every email and every formatted phone in a non-Super-Admin text field is
//     withheld, whichever field holds it, derived `_` fields and blank-header
//     columns included; the row's own broker phone, email and agent name are
//     withheld wherever they appear (that catches a bare-digit phone); other
//     bare digit runs (load, BOL and reference numbers) never are;
//   - contact inside text becomes "[contact withheld]", a cell that is only
//     contact becomes blank (Q2);
//   - a cell that holds contact data is read-only for a non-Super-Admin: a save
//     that sends it back as served keeps the stored value (§2);
//   - the rate-con extract answers a non-Super-Admin with every field redacted
//     (not a field list), the broker's name included; the server keeps the
//     original for the create that follows.
//
//   node scripts/pending/test-broker-contact-redaction.js     # exits 1 on any failure

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const SRC = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const { normalizeLoadId } = require(path.join(ROOT, "lib", "ratecon-load"));

let pass = 0, fail = 0;
const failures = [];
function check(name, actual, expected) {
	const a = JSON.stringify(actual), e = JSON.stringify(expected);
	if (a === e) { pass++; return true; }
	fail++; failures.push(name);
	console.log(`  FAIL  ${name}\n          expected ${e}\n          actual   ${a}`.slice(0, 1200));
	return false;
}

// ------------------------------------------------------------------ extraction
// A route registration, from its line to the first column-0 "});".
function extractRoute(head) {
	const needle = `\n${head}`;
	const hits = SRC.split(needle).length - 1;
	if (hits !== 1) throw new Error(`expected exactly 1 registration ${JSON.stringify(head)}, found ${hits}`);
	const start = SRC.indexOf(needle) + 1;
	const end = SRC.indexOf("\n});", start);
	if (end < 0) throw new Error(`no column-0 "});" after ${head}`);
	return SRC.slice(start, end + "\n});".length);
}
// A top-level function (column-0 `function name(` / `async function name(`) up to
// its column-0 closing brace, or null.
function topLevelFunction(name) {
	for (const kw of ["function", "async function"]) {
		const needle = `\n${kw} ${name}(`;
		const hits = SRC.split(needle).length - 1;
		if (hits > 1) throw new Error(`${hits} top-level definitions of ${name}()`);
		if (hits === 1) {
			const start = SRC.indexOf(needle) + 1;
			const end = SRC.indexOf("\n}\n", start);
			return SRC.slice(start, end + 3);
		}
	}
	return null;
}
// A top-level `const name = <expr>;`, or null: one line, or a literal that
// closes at column 0 ("];", "};", "]);" ...).
function topLevelConst(name) {
	const esc = name.replace(/\$/g, "\\$");
	const one = new RegExp(`^const ${esc} = (.+);[ \\t]*$`, "m").exec(SRC);
	if (one) return one[1];
	const head = new RegExp(`^const ${esc} = `, "m").exec(SRC);
	if (!head) return null;
	const start = head.index + head[0].length;
	const close = /\n([\]})]+);[ \t]*\n/g;
	close.lastIndex = start;
	const m = close.exec(SRC);
	return m ? SRC.slice(start, m.index + 1 + m[1].length) : null;
}

// THE SCOPE. A lifted route runs inside `with (scope)`: a name the stubs give
// is the stub; a top-level function or const of server.js is that shipped code,
// compiled in this same scope (so its own free names resolve the same way); a
// JS global stays the global. Anything else throws "unstubbed", so a route that
// starts touching new I/O fails loudly here instead of reaching it.
function makeScope(stubs) {
	const cache = Object.create(null);
	let proxy = null;
	const resolveTop = (key) => {
		if (key in cache) return { found: true, value: cache[key] };
		const fn = topLevelFunction(key);
		if (fn) {
			cache[key] = new Function("__scope", `with (__scope) { ${fn}\n return ${key}; }`)(proxy);
			return { found: true, value: cache[key] };
		}
		const expr = topLevelConst(key);
		if (expr != null) {
			cache[key] = new Function("__scope", `with (__scope) { return (${expr}); }`)(proxy);
			return { found: true, value: cache[key] };
		}
		return { found: false };
	};
	proxy = new Proxy(Object.create(null), {
		has(_, key) {
			if (typeof key !== "string" || key === "__scope") return false;
			if (Object.prototype.hasOwnProperty.call(stubs, key) || key in cache) return true;
			if (topLevelFunction(key) || topLevelConst(key) != null) return true;
			return !(key in globalThis);
		},
		get(_, key) {
			if (key === Symbol.unscopables) return undefined;
			if (Object.prototype.hasOwnProperty.call(stubs, key)) return stubs[key];
			const top = resolveTop(key);
			if (top.found) return top.value;
			if (key in globalThis) return globalThis[key];
			throw new ReferenceError(`unstubbed in the lifted route: ${String(key)}`);
		},
		set(_, key, value) { cache[key] = value; return true; },
	});
	return proxy;
}
// Lifts the route registered by `head`, runs its registration in a scope built
// from `stubs`, and returns a runner: (req) => { code, body, headers }.
function lift(head, stubs) {
	const src = extractRoute(head);
	let handler = null;
	const register = (...args) => { handler = args[args.length - 1]; };
	const scope = makeScope({ app: { get: register, put: register, post: register }, ...stubs });
	new Function("__scope", `with (__scope) { ${src} }`)(scope);
	if (typeof handler !== "function") throw new Error(`no handler registered by ${head}`);
	return async (req) => {
		const out = { code: 200, body: null, headers: {} };
		const res = {
			status(c) { out.code = c; return this; },
			json(b) { out.body = b; return this; },
			send(b) { out.body = b; return this; },
			setHeader(k, v) { out.headers[k] = v; },
			set(k, v) { out.headers[k] = v; return this; },
			on() {},
		};
		await handler({ query: {}, params: {}, body: {}, headers: {}, ...req }, res);
		return out;
	};
}
// A top-level function of server.js, compiled in a scope built from `stubs`.
function liftFunction(name, stubs) {
	if (!topLevelFunction(name)) throw new Error(`no top-level function ${name}() in server.js`);
	return makeScope(stubs)[name];
}
const session = (role, extra = {}) => ({ user: { id: role === "Super Admin" ? 1 : 2, role, username: role === "Super Admin" ? "super_admin" : "u2", ...extra } });

// ------------------------------------------------------------------ the fixture
// Production's Job Tracking header row, in its current order (names only), plus
// one column with a blank header at the end.
const HEADERS = [
	"Contract ID", "Load ID", "Details", "Trailer Number", "Driver", "Pickup Info",
	"Pickup Appointment", "Pickup Address", "Drop-off Info", "Drop-off Appointment",
	"Drop-off Address", "Job Status", "Phase of Progress", "Carrier Stage", "  Payment  ",
	"Broker Contact Name", "Phone Number", "Email", "Location Link", "Documents",
	"Assigned Date", "Status Update Date", "Completion Date", "Truck", "Owner ID", "output", "",
];
const DRIVER = "Test Driver";
const WITHHELD_TEXT = "[contact withheld]";
// A completed 2025-style row: the broker's email in Contract ID (as on the
// legacy block), broker contact inside Details, a facility phone in Pickup Info.
const LEGACY = {
	"Contract ID": "agent.one@example.invalid", "Load ID": "80000011",
	Details: "Rate agreed with agent.one@example.invalid; call 555-010-0142 before arrival. 42,000 lb",
	Driver: DRIVER, "Pickup Info": "Example DC - REF/PU#: 41000017 (555) 010-0199",
	"Pickup Appointment": "1/10/2030 08:00", "Pickup Address": "100 Main St, Dallas, TX 75201",
	"Drop-off Info": "Sample Receiver - DEL#: 2700011", "Drop-off Appointment": "1/11/2030 14:00",
	"Drop-off Address": "200 Oak Ave, Tulsa, OK 74103", "Job Status": "Completed",
	"  Payment  ": "$1,800.00", "Broker Contact Name": "Pat Agent", "Phone Number": "555-010-0142",
	Email: "agent.one@example.invalid", Documents: "BOL123456", "Assigned Date": "2030-01-10",
	"Status Update Date": "1/12/2030 10:00:00", "Completion Date": "1/12/2030", Truck: "91", "Owner ID": "5",
};
// An active load with a phone in Details.
const ACTIVE = {
	"Load ID": "80000012", Details: "Dock 4. Receiver line 555.010.0177. Dry van", Driver: DRIVER,
	"Pickup Info": "Example DC - PU#: 41000020", "Pickup Appointment": "1/14/2030 08:00",
	"Pickup Address": "100 Main St, Dallas, TX 75201", "Drop-off Appointment": "1/15/2030 09:00",
	"Drop-off Address": "200 Oak Ave, Tulsa, OK 74103", "Job Status": "In Transit", "  Payment  ": "$2,100.00",
	"Broker Contact Name": "Lee Agent", "Phone Number": "555-010-0143", Email: "agent.two@example.invalid",
	"Assigned Date": "2030-01-14", Truck: "91", "Owner ID": "5",
};
// An unassigned load whose Contract ID is a plain reference number (kept).
const UNASSIGNED = {
	"Contract ID": "29284990", "Load ID": "80000013", Details: "Dry van 53', 38,500 lb",
	"Pickup Info": "Sample DC - REF/PU#: 41000018", "Pickup Address": "100 Main St, Dallas, TX 75201",
	"Drop-off Address": "200 Oak Ave, Tulsa, OK 74103", "Job Status": "Unassigned", "  Payment  ": "$1,500.00",
	"Assigned Date": "2030-01-15", "Owner ID": "0",
};
// The shapes a detector has to catch (see the header).
const PATTERNS = {
	"Load ID": "80000015", Driver: DRIVER, "Job Status": "Completed", "Owner ID": "5", Truck: "91",
	Details: "Cell +1 555 010 0150; office 1-555-010-0151; alt 555 010 0152; fax 555–010–0153; " +
		"desk 555.010-0154; main (555)010-0155 ext. 12; own 5550100156. Reefer 34F",
	"Pickup Info": "Example DC - REF/PU#: 41000019 - Agent.Three+loads@Mail.Example.invalid",
	"Drop-off Info": "Sample Receiver - DEL#: 2700012 - mailto:agent.four@example.invalid",
	"Pickup Address": "100 Main St, Dallas, TX 75201",
	"Drop-off Address": "300 Pine Rd, Austin, TX 78701 Tel 555-010-0157",
	"  Payment  ": "$1,950.00", "Broker Contact Name": "Sam Agent", "Phone Number": "555-010-0156",
	Email: "agent.three+loads@mail.example.invalid", "Assigned Date": "2030-01-08", "Completion Date": "1/9/2030",
	"": "<agent.five@sub.example.invalid>",
};
const cells = (o) => HEADERS.map((h) => (o[h] == null ? "" : String(o[h])));
const rowObject = (o, rowIndex) => {
	const r = {};
	HEADERS.forEach((h) => { r[h] = o[h] == null ? "" : String(o[h]); });
	if (rowIndex) r._rowIndex = rowIndex;
	return r;
};
const FIXTURE = [LEGACY, ACTIVE, UNASSIGNED, PATTERNS];
const SHEET_ROWS = () => [HEADERS.slice(), ...FIXTURE.map(cells)];
const jtCache = () => ({ headers: HEADERS.slice(), data: FIXTURE.map((o, i) => rowObject(o, i + 2)) });

// Every broker contact value planted above: emails (compared without regard to
// case) and phones as their ten digits (compared with every separator, prefix
// and extension removed, so "+1 555 010 0150" and "555-010-0150" both count).
const PLANTED = [
	"agent.one@example.invalid", "agent.two@example.invalid", "agent.three+loads@mail.example.invalid",
	"agent.four@example.invalid", "agent.five@sub.example.invalid", "billing.desk@example.invalid",
	"5550100142", "5550100143", "5550100177", "5550100199",
	"5550100150", "5550100151", "5550100152", "5550100153", "5550100154", "5550100155", "5550100156", "5550100157",
];
// The planted values found anywhere in a value (a response body, or a fixture).
function contactIn(body) {
	const text = typeof body === "string" ? body : JSON.stringify(body == null ? null : body);
	const low = text.toLowerCase();
	const digits = text.replace(/[^0-9]/g, "");
	return PLANTED.filter((p) => (/^\d+$/.test(p) ? digits.includes(p) : low.includes(p)));
}
// What a Super Admin must still get: every planted value of `source` that the
// body lacks (empty = nothing missing).
const missingFrom = (body, source) => {
	const got = new Set(contactIn(body));
	return contactIn(source).filter((p) => !got.has(p));
};
// Values that are not contact data and must still reach every role.
const KEEP = ["29284990", "41000017", "41000018", "41000019", "2700012", "42,000 lb", "Dock 4", "Reefer 34F", "80000011", "80000015"];
const keptIn = (body, list = KEEP) => {
	const text = JSON.stringify(body == null ? null : body);
	return list.filter((k) => text.includes(k));
};
const agentNamesIn = (body) => ["Pat Agent", "Lee Agent", "Sam Agent"].filter((n) => JSON.stringify(body == null ? null : body).includes(n));

// A fake Google Sheets client over `rows` (header row first): reads by range,
// and records batchUpdate writes into the rows.
function fakeSheets(rows) {
	const writes = [];
	const rowAt = (range) => {
		const m = /!(\d+):\1$/.exec(range || "");
		return m ? (rows[Number(m[1]) - 1] || []) : null;
	};
	const colIndex = (letters) => [...letters].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
	const values = {
		get: async ({ range }) => {
			if (/!1:1$/.test(range || "")) return { data: { values: [rows[0].slice()] } };
			const r = rowAt(range);
			return { data: { values: r ? [r.slice()] : rows.map((x) => x.slice()) } };
		},
		batchGet: async ({ ranges }) => ({ data: { valueRanges: ranges.map((x) => ({ values: rowAt(x) ? [rowAt(x).slice()] : rows.map((y) => y.slice()) })) } }),
		batchUpdate: async ({ requestBody }) => {
			const data = requestBody.data || [];
			for (const d of data) {
				const m = /!([A-Z]+)(\d+)$/.exec(d.range);
				if (!m) throw new Error(`fake sheet: not a single-cell range: ${d.range}`);
				const r = rows[Number(m[2]) - 1];
				const i = colIndex(m[1]);
				while (r.length <= i) r.push("");
				r[i] = d.values[0][0];
			}
			writes.push(data.map((d) => d.range));
			return { data: { totalUpdatedCells: data.length } };
		},
	};
	return { getSheets: async () => ({ spreadsheets: { values } }), writes };
}

// A SQLite stub: every statement reads nothing and writes nothing, except the
// statements `rows` names ([regex over the SQL, rows], first match wins). Routes
// that need real tables get a real in-memory database instead.
const emptyDb = (rows = []) => ({
	prepare: (sql) => {
		const hit = rows.find(([re]) => re.test(sql));
		const list = hit ? hit[1] : [];
		return { all: () => list.slice(), get: () => list[0], run: () => ({ changes: 0, lastInsertRowid: 0 }), pluck() { return this; }, raw() { return this; } };
	},
	exec: () => {},
	transaction: (fn) => fn,
});
const DIRECTORY = [[/FROM drivers_directory/i, [{ id: 1, driver_name: DRIVER }]]];
const quietConsole = (errors) => ({ error: (...a) => errors.push(a.join(" ")), log() {}, warn() {}, info() {} });
const realRequire = (p) => {
	if (/^\.\/lib\//.test(p)) return require(path.join(ROOT, p));
	return require(p);
};

const sections = [];
function section(name, fn) { sections.push([name, fn]); }

// ================================================================== §1 Dispatcher
section("§1 GET /api/dashboard", async () => {
	const errors = [];
	const Database = require("better-sqlite3");
	const db = new Database(":memory:");
	db.exec(`CREATE TABLE trucks (id INTEGER PRIMARY KEY, unit_number TEXT, assigned_driver TEXT DEFAULT '');
		CREATE TABLE ratecon_load_aliases (alias TEXT PRIMARY KEY, load_id TEXT NOT NULL, source TEXT DEFAULT '', drive_file_id TEXT DEFAULT '', created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
		CREATE TABLE load_invoice_drafts (id INTEGER PRIMARY KEY AUTOINCREMENT, load_id TEXT NOT NULL, invoice_id TEXT, recipient TEXT, order_number TEXT, overrides_json TEXT DEFAULT '');`);
	const run = lift('app.get("/api/dashboard", requireRole("Super Admin", "Dispatcher"), async (req, res) => {', {
		requireRole: () => null,
		getJobTrackingCached: async () => jtCache(),
		getDeletedLoadIds: () => new Set(),
		normalizeLoadId,
		getCarrierDBFromSQLite: () => ({ headers: ["Driver", "Truck", "Status"], data: [] }),
		appDay: () => "2030-01-15",
		db,
		computeDriverQueues: () => ({}),
		findTruckForDriver: () => null,
		require: realRequire,
		console: quietConsole(errors),
	});
	const disp = await run({ session: session("Dispatcher") });
	const admin = await run({ session: session("Super Admin") });
	const legacy = ((disp.body || {}).completedJobs || []).find((r) => r["Load ID"] === "80000011") || {};
	check("dashboard: both roles answer 200 with no error logged", [disp.code, admin.code, errors], [200, 200, []]);
	check("dashboard, Dispatcher: no broker email or phone anywhere in the answer", contactIn(disp.body), []);
	check("dashboard, Dispatcher: the legacy row's Contract ID (a broker email) is served blank", legacy["Contract ID"], "");
	check("dashboard, Dispatcher: still served: references, weights, a numeric Contract ID, load ids", keptIn(disp.body), KEEP);
	check("dashboard, Super Admin: every planted value of the rows is still served", missingFrom(admin.body, FIXTURE), []);
});

section("§1 GET /api/load/:loadId", async () => {
	const errors = [];
	const sheet = fakeSheets(SHEET_ROWS());
	const run = lift('app.get("/api/load/:loadId", requireRole("Super Admin", "Dispatcher"), async (req, res) => {', {
		requireRole: () => null, getSheets: sheet.getSheets, SPREADSHEET_ID: "sheet-under-test", console: quietConsole(errors),
	});
	const disp = [await run({ params: { loadId: "80000011" }, session: session("Dispatcher") }),
		await run({ params: { loadId: "80000015" }, session: session("Dispatcher") })];
	const admin = [await run({ params: { loadId: "80000011" }, session: session("Super Admin") }),
		await run({ params: { loadId: "80000015" }, session: session("Super Admin") })];
	check("load detail: both roles answer 200 for both loads", [...disp, ...admin].map((r) => r.code).concat(errors), [200, 200, 200, 200]);
	check("load detail, Dispatcher: no broker email or phone anywhere in either answer", contactIn(disp.map((r) => r.body)), []);
	check("load detail, Dispatcher: Contract ID (a broker email) is served blank", ((disp[0].body || {}).load || {})["Contract ID"], "");
	check("load detail, Dispatcher: still served: references, weights, load ids",
		keptIn(disp.map((r) => r.body), ["41000017", "41000019", "2700012", "42,000 lb", "Reefer 34F", "80000011", "80000015"]),
		["41000017", "41000019", "2700012", "42,000 lb", "Reefer 34F", "80000011", "80000015"]);
	check("load detail, Super Admin: every planted value of both rows is still served",
		missingFrom(admin.map((r) => r.body), [LEGACY, PATTERNS]), []);
});

// PUT /api/load/:loadId with its guards stubbed as scripts/test-broker-column-redaction.js
// stubs them (their own runners cover them); the broker rules are the shipped code.
function liftLoadPut(rows, errors) {
	const sheet = fakeSheets(rows);
	const run = lift('app.put("/api/load/:loadId", requireRole("Super Admin", "Dispatcher"), async (req, res) => {', {
		requireRole: () => null, getSheets: sheet.getSheets, SPREADSHEET_ID: "sheet-under-test",
		normalizeLoadId, changedGuardedCells: () => [], guardedColumnReason: () => "", validateOwnerIdCell: () => null,
		sheetRowUpdateBlocker: () => null, buildSheetUpdateAudit: (o) => o, sheetAuditWithCode: (d) => d,
		logAudit: () => {}, logAuditRefusal: () => {}, jtCacheInvalidate: () => {}, notifyChange: () => {},
		console: quietConsole(errors),
	});
	return { run, sheet };
}
section("§1 PUT /api/load/:loadId (its answer)", async () => {
	const errors = [];
	const { run } = liftLoadPut(SHEET_ROWS(), errors);
	const disp = await run({ params: { loadId: "80000015" }, body: { "Trailer Number": "TR-9" }, session: session("Dispatcher") });
	const { run: runAdmin } = liftLoadPut(SHEET_ROWS(), errors);
	const admin = await runAdmin({ params: { loadId: "80000015" }, body: { "Trailer Number": "TR-9" }, session: session("Super Admin") });
	check("load save: both roles answer 200", [disp.code, admin.code, errors], [200, 200, []]);
	check("load save, Dispatcher: no broker email or phone anywhere in the answer", contactIn(disp.body), []);
	check("load save, Dispatcher: still served: the edit and the references", keptIn(disp.body, ["TR-9", "41000019", "2700012"]), ["TR-9", "41000019", "2700012"]);
	check("load save, Super Admin: every planted value of the row is still served", missingFrom(admin.body, PATTERNS), []);
});

section("§1 GET /api/locations/latest", async () => {
	const errors = [];
	const sheet = fakeSheets(SHEET_ROWS());
	const run = lift('app.get("/api/locations/latest", requireRole("Super Admin", "Dispatcher"), async (req, res) => {', {
		requireRole: () => null, getSheets: sheet.getSheets, SPREADSHEET_ID: "sheet-under-test",
		db: emptyDb(DIRECTORY), normalizeLoadId, console: quietConsole(errors), require: realRequire,
	});
	const disp = await run({ session: session("Dispatcher") });
	const admin = await run({ session: session("Super Admin") });
	const details = (r) => ((((r.body || {}).locations || [])[0] || {}).activeLoads || []).map((l) => l.details).join(" | ");
	check("locations: both roles answer 200 with no error logged", [disp.code, admin.code, errors], [200, 200, []]);
	check("locations, Dispatcher: the driver's active load is listed (the checks below are not vacuous)",
		(((disp.body || {}).locations || [])[0] || { activeLoads: [] }).activeLoads.map((l) => l.loadId), ["80000012"]);
	check("locations, Dispatcher: no broker email or phone anywhere in the answer", contactIn(disp.body), []);
	check("locations, Dispatcher: still served: the rest of the Details text", keptIn(details(disp), ["Dock 4", "Dry van"]), ["Dock 4", "Dry van"]);
	check("locations, Super Admin: the active load's Details still carry its phone", missingFrom(admin.body, ACTIVE.Details), []);
});

section("§1 POST /api/loads/ratecon/extract", async () => {
	const errors = [];
	// What the extractor reads off a rate con: the broker's agent and contact,
	// and the billing inbox the invoices go to.
	const extracted = {
		"Load Number": "80000014", "Broker Name": "Pat Agent", "Broker Phone": "555-010-0142",
		"Broker Email": "agent.one@example.invalid", "Documents Email": "billing.desk@example.invalid", Rate: "$1,800.00",
		"Pickup Address": "100 Main St, Dallas, TX 75201", "Drop-off Address": "200 Oak Ave, Tulsa, OK 74103",
		"Pickup Appointment Time": "01/20/2030 08:00", "Delivery Appointment Time": "01/21/2030 14:00",
		"Pickup Notes/Instructions": "Call 1-555-010-0151 one hour out", "Delivery Notes/Instructions": "Questions: agent.four@example.invalid",
		Details: "Dry van",
	};
	const run = lift('app.post("/api/loads/ratecon/extract", requireRole("Super Admin", "Dispatcher"), rateConLimiter, async (req, res) => {', {
		requireRole: () => null, rateConLimiter: null, GEMINI_API_KEY: "test-key",
		runRateConGemini: async () => ({ ...extracted }),
		rateConNormalizeOptions: () => ({}),
		rateconNormalize: require(path.join(ROOT, "lib", "ratecon-normalize")),
		rateconLoad: require(path.join(ROOT, "lib", "ratecon-load")),
		console: quietConsole(errors),
	});
	const pdfBase64 = Buffer.from("%PDF-1.4 test").toString("base64");
	const disp = await run({ body: { pdfBase64 }, session: session("Dispatcher") });
	const admin = await run({ body: { pdfBase64 }, session: session("Super Admin") });
	const f = (r) => ((r.body || {}).fields || {});
	check("rate-con extract: both roles answer 200", [disp.code, admin.code], [200, 200]);
	check("rate-con extract, Dispatcher: no broker email or phone anywhere in the answer (the billing inbox included)", contactIn(disp.body), []);
	check("rate-con extract, Dispatcher: the broker's agent name is not served", agentNamesIn(disp.body), []);
	check("rate-con extract, Dispatcher: still served: load number, rate, both addresses",
		[f(disp)["Load Number"], f(disp).Rate, keptIn(disp.body, ["100 Main St", "200 Oak Ave"])],
		["80000014", "$1,800.00", ["100 Main St", "200 Oak Ave"]]);
	check("rate-con extract, Super Admin: every planted value the rate con carried is still served",
		missingFrom(admin.body, [extracted["Broker Email"], extracted["Documents Email"], extracted["Broker Phone"],
			extracted["Pickup Notes/Instructions"], extracted["Delivery Notes/Instructions"]]), []);
});

const NOTICE_TITLE = "Load 80000011: re-issued rate con changed fields";
section("§1 GET /api/dispatch-notifications", async () => {
	const errors = [];
	const Database = require("better-sqlite3");
	const db = new Database(":memory:");
	const ddl = /CREATE TABLE IF NOT EXISTS dispatch_notifications \([\s\S]*?\n\t\)/.exec(SRC);
	if (!ddl) throw new Error("dispatch_notifications CREATE TABLE not found in server.js");
	db.exec(ddl[0]);
	// A re-issue notice as the alert writes it for a changed Details cell (its
	// old and new value, "→" between them).
	db.prepare("INSERT INTO dispatch_notifications (type, title, body, metadata) VALUES (?, ?, ?, ?)").run(
		"ratecon-reissue-held", NOTICE_TITLE,
		"Details: call 555-010-0142 → email Agent.Three+loads@Mail.Example.invalid", JSON.stringify({ loadId: "80000011" }));
	const run = lift('app.get("/api/dispatch-notifications", requireRole("Super Admin", "Dispatcher"), (req, res) => {', {
		requireRole: () => null, db, console: quietConsole(errors),
	});
	const disp = await run({ session: session("Dispatcher") });
	const admin = await run({ session: session("Super Admin") });
	const first = (r) => (((r.body || {}).notifications || [])[0] || {});
	check("dispatch notices: both roles answer 200", [disp.code, admin.code, errors], [200, 200, []]);
	check("dispatch notices, Dispatcher: no broker email or phone in any notice", contactIn(disp.body), []);
	check("dispatch notices, Dispatcher: still served: the title, and the column it names",
		[first(disp).title, /^Details: /.test(first(disp).body || "")], [NOTICE_TITLE, true]);
	check("dispatch notices, Super Admin: the notice still names the values",
		missingFrom(admin.body, ["555-010-0142", "agent.three+loads@mail.example.invalid"]), []);
});

// The re-issue notice as the alert SENDS it: the row it stores and the payload
// it emits to the dispatch room (Super Admins and Dispatchers share that room,
// so what is sent there has to be fit for a Dispatcher; the email to
// ADMIN_NOTIFY_EMAIL is the Super Admin's copy with the values).
section("§1 the re-issue notice as sent (sendReissueAlert)", async () => {
	const errors = [];
	const stored = [];
	const emitted = [];
	const send = liftFunction("sendReissueAlert", {
		db: emptyDb(),
		insertDispatchNotification: { run: (...args) => { stored.push(args); return { lastInsertRowid: 1 }; } },
		io: { to: (room) => ({ emit: (event, payload) => emitted.push({ room, event, payload }) }) },
		ADMIN_NOTIFY_EMAIL: "",
		sendEmail: async () => true,
		console: quietConsole(errors),
	});
	const out = await send({
		key: "80000011", label: "80000011", reason: "the load is delivered",
		rows: [
			{ column: "Details", stored: "call 555-010-0142 before arrival", sent: "email Agent.Three+loads@Mail.Example.invalid, Reefer 34F", kind: "changed", email: false, inApp: true },
			{ column: "Pickup Info", stored: "REF/PU#: 41000017", sent: "REF/PU#: 41000017 (555)010-0155 ext. 12", kind: "changed", email: false, inApp: true },
		],
		claimedAt: "2030-01-15T12:00:00.000Z", now: new Date("2030-01-15T12:00:00.000Z"),
	});
	const dispatchPayloads = emitted.filter((e) => e.room === "dispatch").map((e) => e.payload);
	check("re-issue notice: sent in-app once, no error logged", [out && out.notified, stored.length, dispatchPayloads.length, errors], [true, 1, 1, []]);
	check("re-issue notice, as emitted to the dispatch room: no broker email or phone", contactIn(dispatchPayloads), []);
	check("re-issue notice, as stored for GET /api/dispatch-notifications: no broker email or phone", contactIn(stored), []);
	check("re-issue notice: still sent: the load in the title, both columns and the rest of the text",
		[String((dispatchPayloads[0] || {}).title || "").includes("80000011"),
			keptIn(dispatchPayloads, ["Details", "Pickup Info", "41000017", "Reefer 34F"])],
		[true, ["Details", "Pickup Info", "41000017", "Reefer 34F"]]);
});

// ==================================================================== §2 Writers
// Once a cell is served blank (or with "[contact withheld]" in place of the
// contact) to a non-Super-Admin, sending it back as served must not overwrite
// the stored value, with or without a baseline. This is the data-loss half of
// the redaction (see ONE SOURCE FOR READER AND WRITER in server.js): without it,
// the fix turns a disclosure into erased broker emails.
const LEGACY_SERVED = {
	...LEGACY, "Contract ID": "",
	Details: `Rate agreed with ${WITHHELD_TEXT}; call ${WITHHELD_TEXT} before arrival. 42,000 lb`,
	"Pickup Info": `Example DC - REF/PU#: 41000017 ${WITHHELD_TEXT}`,
	"Broker Contact Name": "", "Phone Number": "", Email: "",
};
section("§2 PUT /api/load/:loadId: a blank Contract ID sent back as served", async () => {
	const errors = [];
	const rows = SHEET_ROWS();
	const { run } = liftLoadPut(rows, errors);
	const r = await run({ params: { loadId: "80000011" }, body: { "Contract ID": "", "Trailer Number": "TR-9" }, session: session("Dispatcher") });
	check("load save, Dispatcher: 200", [r.code, errors], [200, []]);
	check("load save, Dispatcher: the stored broker email in Contract ID is kept", rows[1][0], "agent.one@example.invalid");
	check("load save, Dispatcher: the rest of the edit is written", rows[1][HEADERS.indexOf("Trailer Number")], "TR-9");
});
function liftDataPut(rows, errors) {
	const sheet = fakeSheets(rows);
	const run = lift('app.put("/api/data/:rowIndex", requireRole("Super Admin", "Dispatcher"), async (req, res) => {', {
		requireRole: () => null, getSheets: sheet.getSheets, SPREADSHEET_ID: "sheet-under-test",
		SHEET_ROW_MAX_CELLS: 20000, PERIOD_GUARDED_SHEETS: ["Job Tracking"],
		getSheetName: (req) => (req.query && req.query.sheet) || "Job Tracking",
		resolveSheetTargetForWrite: async () => ({ resolved: true, metaUnreadable: false, title: "Job Tracking", guarded: true }),
		normalizeLoadId, changedGuardedCells: () => [], guardedColumnReason: () => "", validateOwnerIdCell: () => null,
		sheetRowUpdateBlocker: () => null, buildSheetUpdateAudit: (o) => o, sheetAuditWithCode: (d) => d,
		logAudit: () => {}, logAuditRefusal: () => {}, jtCacheInvalidate: () => {}, notifyChange: () => {},
		console: quietConsole(errors),
	});
	return { run, sheet };
}
section("§2 PUT /api/data/:rowIndex: the served row sent back", async () => {
	const kept = (rows) => ["Contract ID", "Details", "Pickup Info"].map((c) => rows[1][HEADERS.indexOf(c)]);
	const stored = [LEGACY["Contract ID"], LEGACY.Details, LEGACY["Pickup Info"]];
	for (const withBaseline of [false, true]) {
		const errors = [];
		const rows = SHEET_ROWS();
		const { run } = liftDataPut(rows, errors);
		const values = cells({ ...LEGACY_SERVED, "Trailer Number": "TR-9" });
		const body = withBaseline ? { values, baseline: cells(LEGACY_SERVED) } : { values };
		const r = await run({ params: { rowIndex: "2" }, query: { sheet: "Job Tracking" }, body, session: session("Dispatcher") });
		const label = withBaseline ? "with a baseline" : "without a baseline";
		check(`row save ${label}, Dispatcher: 200`, [r.code, errors], [200, []]);
		check(`row save ${label}, Dispatcher: Contract ID, Details and Pickup Info are kept as stored`, kept(rows), stored);
		check(`row save ${label}, Dispatcher: the edit is written`, rows[1][HEADERS.indexOf("Trailer Number")], "TR-9");
	}
	// A Super Admin's Data Manager save of a legacy row sends the stored values
	// back unchanged: no refusal (decision 6 judges changed cells only).
	const errors = [];
	const rows = SHEET_ROWS();
	const { run } = liftDataPut(rows, errors);
	const r = await run({ params: { rowIndex: "2" }, query: { sheet: "Job Tracking" }, body: { values: cells({ ...LEGACY, "Trailer Number": "TR-9" }) }, session: session("Super Admin") });
	check("row save, Super Admin, a legacy row with an unrelated edit: 200, the edit written, the stored cells unchanged",
		[r.code, errors, rows[1][HEADERS.indexOf("Trailer Number")], kept(rows)], [200, [], "TR-9", stored]);
});

// ====================================================================== §3 Driver
section("§3 GET /api/driver/:driverName", async () => {
	const errors = [];
	const run = lift('app.get("/api/driver/:driverName", requireRole("Super Admin", "Driver"), async (req, res) => {', {
		requireRole: () => null,
		getJobTrackingCached: async () => jtCache(),
		getDeletedLoadIds: () => new Set(),
		normalizeLoadId,
		db: emptyDb(),
		require: realRequire,
		console: quietConsole(errors),
	});
	const driver = await run({ params: { driverName: DRIVER }, session: session("Driver", { driverName: DRIVER, driver_name: DRIVER }) });
	const admin = await run({ params: { driverName: DRIVER }, session: session("Super Admin") });
	const loads = ((driver.body || {}).loads || []);
	check("driver app: both roles answer 200 with no error logged", [driver.code, admin.code, errors], [200, 200, []]);
	check("driver app: the driver's three loads are served", loads.map((l) => l["Load ID"]).sort(), ["80000011", "80000012", "80000015"]);
	check("driver app, Driver: no broker email or phone anywhere in the answer", contactIn(driver.body), []);
	check("driver app, Driver: the legacy load's Contract ID (a broker email) is served blank",
		(loads.find((l) => l["Load ID"] === "80000011") || {})["Contract ID"], "");
	check("driver app, Driver: still served: pickup references, weights, the rest of Details",
		keptIn(driver.body, ["41000017", "41000019", "42,000 lb", "Dock 4", "Reefer 34F"]), ["41000017", "41000019", "42,000 lb", "Dock 4", "Reefer 34F"]);
	// Payment columns are stripped for a Driver only, so the Super Admin's answer
	// carries every planted value of the three rows.
	check("driver app, Super Admin: every planted value of the driver's rows is still served",
		missingFrom(admin.body, [LEGACY, ACTIVE, PATTERNS]), []);
});

// ===================================================================== §4 Investor
// No Investor route serves a free-text Job Tracking column today; this pins it.
section("§4 GET /api/investor/load-report", async () => {
	const errors = [];
	const run = lift('app.get("/api/investor/load-report", requireRole("Super Admin", "Investor"), async (req, res) => {', {
		requireRole: () => null,
		getJobTrackingCached: async () => jtCache(),
		getDeletedLoadIds: () => new Set(),
		normalizeLoadId,
		db: emptyDb(),
		getCarrierDBFromSQLite: () => ({ headers: ["Driver", "Carrier"], data: [{ Driver: DRIVER, Carrier: "Example Carrier" }] }),
		getInvestorDriverSet: () => new Set([DRIVER.toLowerCase()]),
		require: realRequire,
		console: quietConsole(errors),
	});
	// The fixture's loads carry Owner ID 5: the investor whose user id is 5.
	const inv = await run({ query: {}, session: session("Investor", { id: 5 }) });
	check("investor load report: 200 with no error logged", [inv.code, errors], [200, []]);
	check("investor load report, Investor: the investor's loads are listed (the check below is not vacuous)",
		["80000011", "80000012", "80000015"].filter((id) => JSON.stringify(inv.body || {}).includes(id)), ["80000011", "80000012", "80000015"]);
	check("investor load report, Investor: no broker email or phone anywhere in the answer", contactIn(inv.body), []);
});

// =================================================================== §5 Signed out
section("§5 GET /api/public/track/:loadId", async () => {
	const errors = [];
	const sheet = fakeSheets(SHEET_ROWS());
	const run = lift('app.get("/api/public/track/:loadId", trackPublicLimiter, async (req, res) => {', {
		trackPublicLimiter: null, getSheets: sheet.getSheets, SPREADSHEET_ID: "sheet-under-test",
		trackResponseCache: new Map(), TRACK_CACHE_TTL_MS: 30000, TRACK_CACHE_MAX: 100,
		db: emptyDb(), getRoute: async () => null, findTruckForDriverStamp: () => null,
		require: realRequire, console: quietConsole(errors),
	});
	const out = [await run({ params: { loadId: "80000011" } }), await run({ params: { loadId: "80000015" } })];
	check("public tracker: 200 for both loads with no error logged", out.map((o) => o.code).concat(errors), [200, 200]);
	check("public tracker: both loads are found (the check below is not vacuous)", out.map((o) => (o.body || {}).loadId), ["80000011", "80000015"]);
	check("public tracker, signed out: no broker email or phone anywhere in either answer", contactIn(out.map((o) => o.body)), []);
});

// ====================================================================== the run
(async () => {
	for (const [name, fn] of sections) {
		console.log(name);
		try { await fn(); } catch (e) { check(`${name} ran (${e && e.message})`, false, true); }
	}
	console.log(`\n${pass} passed, ${fail} failed`);
	if (fail) {
		console.log("\nFailures:");
		for (const f of failures) console.log(`  - ${f}`);
		process.exit(1);
	}
})();
