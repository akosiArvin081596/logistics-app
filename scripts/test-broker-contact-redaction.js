#!/usr/bin/env node
// Broker contact data, by VALUE, in every response a non-Super-Admin can get
// (the owner's rule, 2026-09-26 and 2026-10-15: Dispatchers, Drivers, Investors
// and signed-out callers get no broker emails or phones in any API response,
// whatever column holds them; a Super Admin's responses are unchanged).
//
// Written before the fix (in scripts/pending/, outside `npm run check`), it
// failed on main for every response listed in the plan as leaking; the fix moved
// it here beside test-broker-column-redaction.js. The value rules themselves
// (patterns, the row's own contact, the writer rules) are unit-tested by
// scripts/test-broker-contact-lib.js; this file runs the routes that use them.
//
// WHAT main DID. sanitizeBrokerColumns() blanked the columns whose HEADER reads
// as broker contact (BROKER_WITHHELD_RE: "Broker Contact Name", "Phone Number",
// "Email"). A broker email or phone stored under any other header was served as
// stored: Job Tracking's "Contract ID" holds the broker's email on a block of
// 2025 rows, and "Details" / "Pickup Info" are free text that can hold either.
// Now sanitizeBrokerColumns() also redacts every value (lib/broker-contact.js,
// redactLoadValues()), behind the kill switch BROKER_CONTACT_VALUE_REDACTION_ENABLED
// (default on).
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
//       and POST /api/loads/from-ratecon: the broker contact of the load it
//       creates comes from the extract the server holds, never from the client
//   §2  Writers: a non-Super-Admin save that sends a cell back as now served
//       (blank, or with "[contact withheld]" in place of the contact) keeps the
//       stored value; a Super Admin's save of a legacy row is not refused; a
//       non-Super-Admin save that changes a contact cell is refused (409
//       CONTACT_CELL_READ_ONLY); an email or phone typed into Contract ID is
//       refused for every role (400 CONTACT_NOT_ALLOWED)
//   §3  Driver: GET /api/driver/:driverName
//   §4  Investor: GET /api/investor/load-report (no free-text column today; a guard)
//   §5  Signed out: GET /api/public/track/:loadId (a fixed field list; a guard)
//   Super Admin: every route above, every planted value of the rows it serves
//   "Still served": what is not contact data reaches every role (over-redaction)
//
// ON main before the fix (503367d): the 13 leak checks (§1, §3), the 2 writer
// checks with no baseline to fall back on (§2), and the checks added with the
// fix for the create (§1), CONTACT_CELL_READ_ONLY and CONTACT_NOT_ALLOWED (§2)
// failed. §4, §5, every Super Admin check and every "still served" check passed
// on main and must keep passing.
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
//     that sends it back as served keeps the stored value, and one that changes
//     it is refused, 409 CONTACT_CELL_READ_ONLY (§2);
//   - the rate-con extract answers a non-Super-Admin with every field redacted
//     (not a field list), the broker's name included; the server keeps the
//     original for the create that follows, and the create ignores the broker
//     fields a non-Super-Admin sends;
//   - an email or phone typed into Contract ID is refused, 400
//     CONTACT_NOT_ALLOWED, judged only on a cell whose value changed (§2).
//
//   node scripts/test-broker-contact-redaction.js     # exits 1 on any failure

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
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
// Every top-level declaration of server.js, indexed ONCE. A lifted route asks
// the scope about every free name it touches (JSON, String and the other
// globals included), so scanning the whole source per question is what once
// made this runner take minutes on CI. Each answer below is also memoized.
const TOP_FUNCTION_STARTS = new Map(); // name -> [index of each `function name(` / `async function name(` line]
for (const m of SRC.matchAll(/\n(?:async )?function ([A-Za-z_$][\w$]*)\(/g)) {
	const starts = TOP_FUNCTION_STARTS.get(m[1]) || [];
	starts.push(m.index + 1);
	TOP_FUNCTION_STARTS.set(m[1], starts);
}
const TOP_CONST_STARTS = new Map(); // name -> index of its first `const name = ` line
for (const m of SRC.matchAll(/^const ([A-Za-z_$][\w$]*) = /gm)) {
	if (!TOP_CONST_STARTS.has(m[1])) TOP_CONST_STARTS.set(m[1], m.index);
}
const FUNCTION_SRC = new Map();
const CONST_SRC = new Map();
// A top-level function (column-0 `function name(` / `async function name(`) up to
// its column-0 closing brace, or null.
function topLevelFunction(name) {
	if (FUNCTION_SRC.has(name)) return FUNCTION_SRC.get(name);
	const starts = TOP_FUNCTION_STARTS.get(name) || [];
	if (starts.length > 1) throw new Error(`${starts.length} top-level definitions of ${name}()`);
	let out = null;
	if (starts.length === 1) {
		const end = SRC.indexOf("\n}\n", starts[0]);
		out = SRC.slice(starts[0], end + 3);
	}
	FUNCTION_SRC.set(name, out);
	return out;
}
// A top-level `const name = <expr>;`, or null: one line, or a literal that
// closes at column 0 ("];", "};", "]);" ...).
function topLevelConst(name) {
	if (CONST_SRC.has(name)) return CONST_SRC.get(name);
	let out = null;
	if (TOP_CONST_STARTS.has(name)) {
		const lineStart = TOP_CONST_STARTS.get(name);
		const lineEnd = SRC.indexOf("\n", lineStart);
		const line = SRC.slice(lineStart, lineEnd < 0 ? SRC.length : lineEnd);
		const start = lineStart + `const ${name} = `.length;
		const one = /^(.+);[ \t]*$/.exec(line.slice(`const ${name} = `.length));
		if (one) {
			out = one[1];
		} else {
			const close = /\n([\]})]+);[ \t]*\n/g;
			close.lastIndex = start;
			const m = close.exec(SRC);
			out = m ? SRC.slice(start, m.index + 1 + m[1].length) : null;
		}
	}
	CONST_SRC.set(name, out);
	return out;
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
// from `stubs`, and returns a runner: (req) => { code, body, headers }. `require`
// loads the shipped lib/ modules (and node's own) unless a section stubs it, so a
// top-level `const x = require("./lib/...")` the route reads resolves as shipped.
// A stub given as SHIPPED is dropped, so that name resolves to server.js's own
// top-level definition (a section overriding a shared stub list).
const SHIPPED = Symbol("the shipped definition");
function lift(head, stubs) {
	const src = extractRoute(head);
	let handler = null;
	const register = (...args) => { handler = args[args.length - 1]; };
	const kept = Object.fromEntries(Object.entries(stubs).filter(([, v]) => v !== SHIPPED));
	const scope = makeScope({ app: { get: register, put: register, post: register }, require: realRequire, ...kept });
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
	return makeScope({ require: realRequire, ...stubs })[name];
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
// server.js destructures these from lib/eta-on-time.js (`const { … } = require(…)`),
// a form the scope's top-level lookup does not read: the shipped exports themselves.
const ETA_ON_TIME = (({ etaOnTime, etaVerdict, DROPOFF_APPOINTMENT_COL_RE }) => ({ etaOnTime, etaVerdict, DROPOFF_APPOINTMENT_COL_RE }))(
	require(path.join(ROOT, "lib", "eta-on-time")));

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
function liftLoadPut(rows, errors, overrides = {}) {
	const sheet = fakeSheets(rows);
	const run = lift('app.put("/api/load/:loadId", requireRole("Super Admin", "Dispatcher"), async (req, res) => {', {
		requireRole: () => null, getSheets: sheet.getSheets, SPREADSHEET_ID: "sheet-under-test",
		normalizeLoadId, changedGuardedCells: () => [], guardedColumnReason: () => "", validateOwnerIdCell: () => null,
		sheetRowUpdateBlocker: () => null, buildSheetUpdateAudit: (o) => o, sheetAuditWithCode: (d) => d,
		logAudit: () => {}, logAuditRefusal: () => {}, jtCacheInvalidate: () => {}, notifyChange: () => {},
		console: quietConsole(errors),
		...overrides,
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
		db: emptyDb(DIRECTORY), normalizeLoadId, console: quietConsole(errors), require: realRequire, ...ETA_ON_TIME,
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

// POST /api/loads/from-ratecon after the extract, with the fields as the review
// modal sends them back: the redacted copy, plus broker fields the client typed.
// The load it creates carries the rate con's own broker contact, taken from the
// extract the server holds for that PDF, never what a non-Super-Admin sent;
// with no extract held, the broker cells are left blank and a warning says so.
// Every sheet is a fake; the PDF archive's file writes are stubbed.
function fakeTabs(tabs) {
	const tabOf = (range) => String(range || "").split("!")[0].replace(/^'|'$/g, "");
	const colIndex = (letters) => [...letters].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
	const values = {
		get: async ({ range }) => ({ data: { values: (tabs[tabOf(range)] || []).map((r) => r.slice()) } }),
		append: async ({ range, requestBody }) => {
			const rows = tabs[tabOf(range)];
			rows.push(requestBody.values[0].slice());
			return { data: { updates: { updatedRange: `${tabOf(range)}!A${rows.length}:Z${rows.length}` } } };
		},
		update: async ({ range, requestBody }) => {
			const m = /!A(\d+)$/.exec(range);
			tabs[tabOf(range)][Number(m[1]) - 1] = requestBody.values[0].slice();
			return { data: {} };
		},
		batchUpdate: async ({ requestBody }) => {
			for (const d of requestBody.data || []) {
				const m = /!([A-Z]+)(\d+)$/.exec(d.range);
				const r = tabs[tabOf(d.range)][Number(m[2]) - 1];
				r[colIndex(m[1])] = d.values[0][0];
			}
			return { data: {} };
		},
	};
	return { getSheets: async () => ({ spreadsheets: { values } }) };
}
section("§1 POST /api/loads/from-ratecon (the broker contact it writes)", async () => {
	const errors = [];
	const extracted = {
		"Load Number": "80000016", "Broker Name": "Pat Agent", "Broker Phone": "(555) 010-0142",
		"Broker Email": "agent.one@example.invalid", "Documents Email": "billing.desk@example.invalid", Rate: "$1,800.00",
		"Pickup Address": "100 Main St, Dallas, TX 75201", "Drop-off Address": "200 Oak Ave, Tulsa, OK 74103 Tel 555-010-0157",
		"Pickup Company Information": "Example DC", "P/U Reference Number": "41000021",
		"Pickup Appointment Time": "01/20/2030 08:00", "Delivery Appointment Time": "01/21/2030 14:00",
		"Pickup Notes/Instructions": "Call 1-555-010-0151 one hour out", Details: "Dry van",
	};
	// Both routes load the shipped lib/ modules through the one `require`, so they
	// share the server's one rate-con stash as the server's routes do.
	const common = { requireRole: () => null, rateConLimiter: null, console: quietConsole(errors) };
	let geminiAnswer = extracted;
	const extractWith = (more = {}) => lift('app.post("/api/loads/ratecon/extract", requireRole("Super Admin", "Dispatcher"), rateConLimiter, async (req, res) => {', {
		...common, GEMINI_API_KEY: "test-key", runRateConGemini: async () => ({ ...geminiAnswer }), rateConNormalizeOptions: () => ({}),
		rateconNormalize: require(path.join(ROOT, "lib", "ratecon-normalize")), rateconLoad: require(path.join(ROOT, "lib", "ratecon-load")),
		...more,
	});
	const extract = extractWith();
	// `rec` collects the dispatch notice the create stores and emits.
	const create = (tabs, rec = { stored: [], emitted: [] }, more = {}) => lift('app.post("/api/loads/from-ratecon", requireRole("Super Admin", "Dispatcher"), rateConLimiter, async (req, res) => {', {
		...common, getSheets: fakeTabs(tabs).getSheets, SPREADSHEET_ID: "sheet-under-test",
		rateconLoad: require(path.join(ROOT, "lib", "ratecon-load")),
		getDeletedLoadIds: () => new Set(), GOOGLE_MAPS_API_KEY: "", geocodeAddress: async () => null, appDay: () => "2030-01-19",
		validateOwnerIdCell: () => null, jtCacheInvalidate: () => {}, notifyChange: () => {}, logAudit: () => {},
		DATA_DIR: path.join(ROOT, "no-such-dir"), fs: { existsSync: () => true, mkdirSync() {}, writeFileSync() {} },
		db: emptyDb(), RATECON_DRIVE_FOLDER_ID: "",
		insertDispatchNotification: { run: (...args) => { rec.stored.push(args); return { lastInsertRowid: 1 }; } }, io: fakeIo(rec.emitted),
		...more,
	});
	const newTabs = () => ({
		"Job Tracking": [HEADERS.slice()],
		"Payments Table": [[" Job ID", "Contract ID", "Payment Amount"]],
		"Job Details": [["Load ID", "Rate Per Mile", "Distance", "Details", "Payment"]],
	});
	const pdfBase64 = Buffer.from("%PDF-1.4 the rate con under test").toString("base64");
	const served = await extract({ body: { pdfBase64 }, session: session("Dispatcher") });
	// The modal sends every field back as shown (null as ""), and the broker
	// fields a client can type in whatever the screen shows.
	const asShown = Object.fromEntries(Object.entries((served.body || {}).fields || {}).map(([k, v]) => [k, v == null ? "" : v]));
	const typed = { ...asShown, "Broker Name": "Typed Name", "Broker Phone": "555-010-0188", "Broker Email": "typed@example.invalid" };
	const cell = (tabs, h) => (tabs["Job Tracking"][1] || [])[HEADERS.indexOf(h)];
	const brokerCells = (tabs) => ["Broker Contact Name", "Phone Number", "Email"].map((h) => cell(tabs, h));

	const tabs = newTabs();
	const rec = { stored: [], emitted: [] };
	const made = await create(tabs, rec)({ body: { fields: typed, pdfBase64, fileName: "rc.pdf" }, session: session("Dispatcher") });
	check("rate-con create, Dispatcher: 200 with no error logged", [served.code, made.code, errors], [200, 200, []]);
	check("rate-con create, Dispatcher: the load's broker cells hold the rate con's own contact, not what the client sent",
		[brokerCells(tabs), (tabs["Payments Table"][1] || [])[1]], [["Pat Agent", "(555) 010-0142", "agent.one@example.invalid"], "Pat Agent"]);
	check("rate-con create, Dispatcher: no broker email or phone anywhere in the answer", contactIn(made.body), []);
	// The "New Load" notice names the route, whose address can hold a phone: per
	// role, as the re-issue notice (Super Admins in full, the rest of the room not).
	const newLoadMeta = (() => { try { return JSON.parse((rec.stored[0] || [])[3]); } catch { return {}; } })();
	check("rate-con create: the New Load notice goes in full to Super Admins and without the phone to the rest of the dispatch room, never to the whole room",
		[missingFrom(toSuperAdmins(rec.emitted, "dispatch-notification"), ["555-010-0157"]),
			toDispatchers(rec.emitted, "dispatch-notification").length, contactIn(toDispatchers(rec.emitted, "dispatch-notification")),
			toWholeRoom(rec.emitted, "dispatch-notification").length],
		[[], 1, [], 0]);
	check("rate-con create: the New Load notice is stored in full with a copy for every other role",
		[missingFrom((rec.stored[0] || [])[2], ["555-010-0157"]), contactIn(newLoadMeta.redactedBody), typeof newLoadMeta.redactedBody],
		[[], [], "string"]);

	// A non-broker field the server puts back from its copy (it was sent as
	// served, with "[contact withheld]" in it) that the sheet would read as a
	// formula: the person cannot see the value to fix it, so it is written blank
	// with a warning naming the field, instead of refusing the load.
	geminiAnswer = { ...extracted, "Load Number": "80000021", Details: "+1 555-010-0142 call before arrival" };
	const plusPdf = Buffer.from("%PDF-1.4 a formula-shaped detail").toString("base64");
	const plusServed = await extract({ body: { pdfBase64: plusPdf }, session: session("Dispatcher") });
	const plusTabs = newTabs();
	const plus = await create(plusTabs)({
		body: { fields: Object.fromEntries(Object.entries((plusServed.body || {}).fields || {}).map(([k, v]) => [k, v == null ? "" : v])), pdfBase64: plusPdf },
		session: session("Dispatcher"),
	});
	check("rate-con create, Dispatcher, a put-back field the sheet would read as a formula: 200, that cell blank, a warning naming it",
		[plus.code, cell(plusTabs, "Details"), ((plus.body || {}).warnings || []).some((w) => /left blank/i.test(w) && w.includes("Details"))],
		[200, "", true]);
	geminiAnswer = extracted;

	// The kill switch governs free-text redaction only: off, a non-Super-Admin's
	// extract still answers the broker fields null, and the create still takes them
	// from the extract the server holds.
	{
		const off = { BROKER_CONTACT_VALUE_REDACTION_ENABLED: false };
		geminiAnswer = { ...extracted, "Load Number": "80000022" };
		const offPdf = Buffer.from("%PDF-1.4 with the switch off").toString("base64");
		const offServed = await extractWith(off)({ body: { pdfBase64: offPdf }, session: session("Dispatcher") });
		const f = (offServed.body || {}).fields || {};
		check("rate-con extract, value redaction switched off, Dispatcher: the broker fields still null, the billing inbox too",
			[f["Broker Name"], f["Broker Phone"], f["Broker Email"], f["Documents Email"]], [null, null, null, null]);
		const offTabs = newTabs();
		const offShown = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v == null ? "" : v]));
		const offMade = await create(offTabs, undefined, off)({
			body: { fields: { ...offShown, "Broker Email": "typed@example.invalid" }, pdfBase64: offPdf }, session: session("Dispatcher"),
		});
		check("rate-con create, value redaction switched off, Dispatcher: the broker cells still come from the extract",
			[offMade.code, brokerCells(offTabs)], [200, ["Pat Agent", "(555) 010-0142", "agent.one@example.invalid"]]);
		geminiAnswer = extracted;
	}

	const missTabs = newTabs();
	const missed = await create(missTabs)({
		body: { fields: { ...typed, "Load Number": "80000017" }, pdfBase64: Buffer.from("%PDF-1.4 never extracted").toString("base64") },
		session: session("Dispatcher"),
	});
	check("rate-con create, Dispatcher, no extract held for the PDF: 200, the broker cells blank, a warning says so",
		[missed.code, brokerCells(missTabs), ((missed.body || {}).warnings || []).some((w) => /broker/i.test(w))],
		[200, ["", "", ""], true]);

	// A broker phone the sheet would store as a formula ("+52 ..."): the person
	// cannot see it to fix it, so the load is created with that cell blank and a
	// warning, instead of being refused over a field they cannot see.
	geminiAnswer = { ...extracted, "Load Number": "80000019", "Broker Phone": "+52 55 1234 5678" };
	const intlPdf = Buffer.from("%PDF-1.4 an international broker").toString("base64");
	const intlServed = await extract({ body: { pdfBase64: intlPdf }, session: session("Dispatcher") });
	const intlTabs = newTabs();
	const intl = await create(intlTabs)({
		body: { fields: Object.fromEntries(Object.entries((intlServed.body || {}).fields || {}).map(([k, v]) => [k, v == null ? "" : v])), pdfBase64: intlPdf },
		session: session("Dispatcher"),
	});
	check("rate-con create, Dispatcher, a held broker phone the sheet would read as a formula: 200, that cell blank, the rest kept, a warning",
		[intl.code, brokerCells(intlTabs), ((intl.body || {}).warnings || []).some((w) => /left blank/i.test(w) && w.includes("Broker Phone"))],
		[200, ["Pat Agent", "", "agent.one@example.invalid"], true]);
	geminiAnswer = extracted;

	const adminTabs = newTabs();
	const adminTyped = { ...extracted, "Load Number": "80000018", "Broker Email": "typed@example.invalid" };
	const admin = await create(adminTabs)({ body: { fields: adminTyped, pdfBase64 }, session: session("Super Admin") });
	check("rate-con create, Super Admin: the fields are written as sent, as before",
		[admin.code, brokerCells(adminTabs)], [200, ["Pat Agent", "(555) 010-0142", "typed@example.invalid"]]);
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
	// A notice stored since the fix: the full body, and the copy for other roles.
	db.prepare("INSERT INTO dispatch_notifications (type, title, body, metadata) VALUES (?, ?, ?, ?)").run(
		"new-load", "New Load 80000016", "Dallas, TX 75201 → Tulsa, OK 74103 Tel 555-010-0157",
		JSON.stringify({ loadId: "80000016", redactedBody: "Dallas, TX 75201 → Tulsa, OK 74103 Tel [contact withheld]" }));
	const disp2 = await run({ session: session("Dispatcher") });
	const admin2 = await run({ session: session("Super Admin") });
	const newest = (r) => (((r.body || {}).notifications || [])[0] || {});
	check("dispatch notices, a notice stored with its copy: a Dispatcher gets the copy, a Super Admin the full body, neither the copy in the metadata",
		[newest(disp2).body, contactIn(disp2.body), newest(admin2).body, /redactedBody/.test(JSON.stringify([disp2.body, admin2.body]))],
		["Dallas, TX 75201 → Tulsa, OK 74103 Tel [contact withheld]", [], "Dallas, TX 75201 → Tulsa, OK 74103 Tel 555-010-0157", false]);
});

// A socket.io stand-in that records every emit with its room and the room it
// excludes (`io.to(room).except(other).emit(...)`).
// The Super Admin room is the one the dispatch room is sent "except".
const SA_ROOM = (/io\.to\("dispatch"\)\.except\("([^"]+)"\)/.exec(SRC) || [])[1] || "(no Super Admin room in server.js)";
function fakeIo(emitted) {
	const emitter = (room, except) => ({
		emit: (event, payload) => emitted.push({ room, except, event, payload }),
		except: (other) => emitter(room, other),
	});
	return { to: (room) => emitter(room, null) };
}
// What the dispatch room's other roles (Dispatchers) get, and what Super Admins get.
const toDispatchers = (emitted, event) => emitted.filter((e) => e.event === event && e.room === "dispatch" && e.except === SA_ROOM).map((e) => e.payload);
const toSuperAdmins = (emitted, event) => emitted.filter((e) => e.event === event && e.room === SA_ROOM).map((e) => e.payload);
const toWholeRoom = (emitted, event) => emitted.filter((e) => e.event === event && e.room === "dispatch" && !e.except).map((e) => e.payload);

// The re-issue notice as the alert SENDS it: the row it stores and what it
// emits. Super Admins and Dispatchers share the dispatch room, so it is sent per
// role: the Super Admin room gets the values in full (as before), the rest of the
// room a copy with broker contact withheld, made before any value is cut to 100
// characters. The row stores the full body and that copy (metadata.redactedBody),
// which GET /api/dispatch-notifications serves to every role but Super Admin.
section("§1 the re-issue notice as sent (sendReissueAlert)", async () => {
	const errors = [];
	const stored = [];
	const emitted = [];
	const send = liftFunction("sendReissueAlert", {
		db: emptyDb(),
		insertDispatchNotification: { run: (...args) => { stored.push(args); return { lastInsertRowid: 1 }; } },
		io: fakeIo(emitted),
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
	const dispatchPayloads = toDispatchers(emitted, "dispatch-notification");
	const adminPayloads = toSuperAdmins(emitted, "dispatch-notification");
	check("re-issue notice: stored once, sent once to Super Admins and once to the rest of the dispatch room, never to the whole room, no error logged",
		[out && out.notified, stored.length, adminPayloads.length, dispatchPayloads.length, toWholeRoom(emitted, "dispatch-notification").length, errors],
		[true, 1, 1, 1, 0, []]);
	check("re-issue notice, as emitted to the dispatch room's other roles: no broker email or phone", contactIn(dispatchPayloads), []);
	check("re-issue notice, as emitted to Super Admins: the values in full, as before",
		missingFrom(adminPayloads, ["555-010-0142", "agent.three+loads@mail.example.invalid", "(555)010-0155"]), []);
	const storedMeta = (() => { try { return JSON.parse((stored[0] || [])[3]); } catch { return {}; } })();
	check("re-issue notice, as stored: the body in full, and a copy with broker contact withheld for every other role",
		[missingFrom((stored[0] || [])[2], ["555-010-0142", "agent.three+loads@mail.example.invalid"]), contactIn(storedMeta.redactedBody),
			typeof storedMeta.redactedBody], [[], [], "string"]);
	check("re-issue notice: still sent: the load in the title, both columns and the rest of the text",
		[String((dispatchPayloads[0] || {}).title || "").includes("80000011"),
			keptIn(dispatchPayloads, ["Details", "Pickup Info", "41000017", "Reefer 34F"])],
		[true, ["Details", "Pickup Info", "41000017", "Reefer 34F"]]);
	// A value longer than the 100-character cut: its phone sits past the cut, so a
	// copy made after cutting could split it; the copy is made before.
	const long = [];
	const sendLong = liftFunction("sendReissueAlert", {
		db: emptyDb(),
		insertDispatchNotification: { run: (...args) => { long.push(args); return { lastInsertRowid: 2 }; } },
		io: fakeIo([]), ADMIN_NOTIFY_EMAIL: "", sendEmail: async () => true, console: quietConsole(errors),
	});
	await sendLong({
		key: "80000012", label: "80000012", reason: "the load is delivered",
		rows: [{ column: "Details", stored: "Dock 4", sent: `${"Dry van, keep sealed. ".repeat(4)}call 555-010-0143`, kind: "changed", email: false, inApp: true }],
		claimedAt: "2030-01-15T12:00:00.000Z", now: new Date("2030-01-15T12:00:00.000Z"),
	});
	const longMeta = (() => { try { return JSON.parse((long[0] || [])[3]); } catch { return {}; } })();
	check("re-issue notice: a phone past the 100-character cut is withheld whole in the copy, never split",
		[contactIn(longMeta.redactedBody), /555-010-01…|010-014…/.test(String(longMeta.redactedBody))], [[], false]);
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
function liftDataPut(rows, errors, overrides = {}) {
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
		...overrides,
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

// A cell holding contact data is read-only for a non-Super-Admin: a save that
// sends anything but the stored or the served copy is refused, so an edit is
// never dropped without a word, and nothing is written.
section("§2 a non-Super-Admin save that changes a contact cell: 409 CONTACT_CELL_READ_ONLY", async () => {
	const errors = [];
	// Each refusal is on the audit trail (a repeated one says someone is testing
	// what a withheld cell holds), through logAuditRefusal() with its code.
	const refusals = [];
	const recordRefusal = { logAuditRefusal: (req, action, entity, id, details, code) => refusals.push({ action, code, details: String(details) }) };
	{
		const rows = SHEET_ROWS();
		const { run, sheet } = liftDataPut(rows, errors, recordRefusal);
		const values = cells({ ...LEGACY_SERVED, Details: "Rate agreed with the broker. 42,000 lb", "Trailer Number": "TR-9" });
		const r = await run({ params: { rowIndex: "2" }, query: { sheet: "Job Tracking" }, body: { values, baseline: cells(LEGACY_SERVED) }, session: session("Dispatcher") });
		check("row save, Dispatcher, Details changed: 409 CONTACT_CELL_READ_ONLY naming the column, nothing written",
			[r.code, (r.body || {}).code, (r.body || {}).field, sheet.writes.length, rows[1][HEADERS.indexOf("Details")]],
			[409, "CONTACT_CELL_READ_ONLY", "Details", 0, LEGACY.Details]);
	}
	{
		const rows = SHEET_ROWS();
		const { run, sheet } = liftLoadPut(rows, errors, recordRefusal);
		const r = await run({ params: { loadId: "80000011" }, body: { "Contract ID": "29284990" }, session: session("Dispatcher") });
		check("load save, Dispatcher, Contract ID (holding a broker email) changed: 409 CONTACT_CELL_READ_ONLY, nothing written",
			[r.code, (r.body || {}).code, (r.body || {}).field, sheet.writes.length, rows[1][0]],
			[409, "CONTACT_CELL_READ_ONLY", "Contract ID", 0, LEGACY["Contract ID"]]);
	}
	check("contact cell refusals: both audited through logAuditRefusal() with their code, naming the column",
		refusals.map((a) => [a.action, a.code, /Details|Contract ID/.test(a.details)]),
		[["update_sheet_row_blocked", "CONTACT_CELL_READ_ONLY", true], ["update_sheet_row_blocked", "CONTACT_CELL_READ_ONLY", true]]);
	{
		const rows = SHEET_ROWS();
		const { run } = liftLoadPut(rows, errors);
		const r = await run({ params: { loadId: "80000011" }, body: { Details: "Rate agreed with the broker. 42,000 lb" }, session: session("Super Admin") });
		check("load save, Super Admin, the same Details edit: 200 and written", [r.code, rows[1][HEADERS.indexOf("Details")]], [200, "Rate agreed with the broker. 42,000 lb"]);
	}
	check("contact cell saves: no error logged", errors, []);
});

// An email or a formatted phone typed into Contract ID is refused for every
// role, judged only on a cell whose value changed (a stored legacy email resent
// unchanged is pinned in the section above).
section("§2 an email or phone typed into Contract ID: 400 CONTACT_NOT_ALLOWED", async () => {
	const errors = [];
	{
		const rows = SHEET_ROWS();
		const { run, sheet } = liftLoadPut(rows, errors);
		const r = await run({ params: { loadId: "80000013" }, body: { "Contract ID": "new.agent@example.invalid" }, session: session("Super Admin") });
		check("load save, Super Admin, an email typed into Contract ID: 400 CONTACT_NOT_ALLOWED naming the column, nothing written",
			[r.code, (r.body || {}).code, (r.body || {}).field, sheet.writes.length, rows[3][0]],
			[400, "CONTACT_NOT_ALLOWED", "Contract ID", 0, UNASSIGNED["Contract ID"]]);
	}
	{
		const rows = SHEET_ROWS();
		const { run, sheet } = liftDataPut(rows, errors);
		const values = cells({ ...UNASSIGNED, "Contract ID": "(555) 010-0188" });
		const r = await run({ params: { rowIndex: "4" }, query: { sheet: "Job Tracking" }, body: { values, baseline: cells(UNASSIGNED) }, session: session("Dispatcher") });
		check("row save, Dispatcher, a phone typed into Contract ID: 400 CONTACT_NOT_ALLOWED, nothing written",
			[r.code, (r.body || {}).code, (r.body || {}).field, sheet.writes.length], [400, "CONTACT_NOT_ALLOWED", "Contract ID", 0]);
	}
	{
		const rows = SHEET_ROWS();
		const { run } = liftLoadPut(rows, errors);
		const r = await run({ params: { loadId: "80000013" }, body: { "Contract ID": "29284991" }, session: session("Dispatcher") });
		check("load save, Dispatcher, a reference number in Contract ID: 200 and written", [r.code, rows[3][0]], [200, "29284991"]);
	}
	check("Contract ID saves: no error logged", errors, []);
});

// A period refusal names the date cells it cannot read, quoting them; a cell
// holding broker contact is quoted to a non-Super-Admin with it withheld. The
// period guard here is the shipped one, with the lock table readable.
section("§2 a period refusal (PERIOD_UNRESOLVED) quotes no broker contact to a non-Super-Admin", async () => {
	const errors = [];
	const shipped = { changedGuardedCells: SHIPPED, guardedColumnReason: SHIPPED, sheetRowUpdateBlocker: SHIPPED, periodLocksReadable: () => true };
	const appt = "Call 555-010-0142 for appt";
	const runAs = async (role) => {
		const rows = SHEET_ROWS();
		rows[4][HEADERS.indexOf("Pickup Appointment")] = appt;
		const { run, sheet } = liftLoadPut(rows, errors, shipped);
		const r = await run({ params: { loadId: "80000015" }, body: { "  Payment  ": "$2,000.00" }, session: session(role) });
		return { r, writes: sheet.writes.length };
	};
	const disp = await runAs("Dispatcher");
	const admin = await runAs("Super Admin");
	check("period refusal: both roles 409 PERIOD_UNRESOLVED, nothing written, no error logged",
		[disp.r.code, (disp.r.body || {}).code, disp.writes, admin.r.code, (admin.r.body || {}).code, admin.writes, errors],
		[409, "PERIOD_UNRESOLVED", 0, 409, "PERIOD_UNRESOLVED", 0, []]);
	check("period refusal, Dispatcher: no broker email or phone in it; it still names the cell",
		[contactIn(disp.r.body), /Pickup Appointment/.test(JSON.stringify((disp.r.body || {}).unreadable || []))], [[], true]);
	check("period refusal, Super Admin: the cell quoted as stored", missingFrom(admin.r.body, [appt]), []);
});

// ========================================================= §7 Stored addresses
// load_coordinates holds each load's addresses as written when it was created
// (the rate-con create writes the rate con's own), so an address can carry a
// phone. Every route that serves them redacts them for every role but Super Admin.
section("§7 addresses from load_coordinates: geocode, haul, mileage detail", async () => {
	const errors = [];
	const coords = {
		load_id: "80000015", origin_lat: 32.78, origin_lng: -96.8, dest_lat: 30.27, dest_lng: -97.74, distance_miles: 195,
		pickup_address: "100 Main St, Dallas, TX 75201", dropoff_address: "300 Pine Rd, Austin, TX 78701 Tel 555-010-0157",
	};
	const driverSession = session("Driver", { driverName: DRIVER, driver_name: DRIVER });
	const geo = lift('app.get("/api/geocode/load/:loadId", requireAuth, async (req, res) => {', {
		requireAuth: () => null, loadBelongsToDriver: async () => true, db: emptyDb([[/FROM load_coordinates/i, [coords]]]), console: quietConsole(errors),
	});
	const haul = lift('app.get("/api/loads/:loadId/haul", requireAuth, haulLimiter, async (req, res) => {', {
		requireAuth: () => null, haulLimiter: null, loadBelongsToDriver: async () => true, getLoadCoordsFull: () => ({ ...coords }),
		getRoute: async () => null, getJobTrackingCached: async () => jtCache(),
		measureLoadEldMiles: () => ({ driven: null, truckUnit: "", vid: null }), buildHaulTruckResolver: () => null, buildEldDeviceResolver: () => null,
		console: quietConsole(errors),
	});
	const mileage = lift('app.get("/api/analytics/mileage/detail",', {
		requireRole: () => null, mileageAnalyticsLimiter: null,
		db: emptyDb([
			[/FROM eld_miles_daily/i, [{ local_day: "2030-01-09", driver_name: DRIVER, driver_key: "test driver", miles: 100, basis: "eld", samples: 10,
				rejected_deltas: 0, dropped_miles: 0, max_gap_ms: 0, first_ms: 0, last_ms: 0, vid: "v1" }]],
			[/FROM trucks/i, []],
			[/FROM load_status_history/i, [{ day: "2030-01-09", load_id: "80000015", new_status: "Delivered", changed_at: "2030-01-09T15:00:00Z",
				actor: DRIVER, pickup_address: coords.pickup_address, dropoff_address: coords.dropoff_address }]],
		]),
		buildEldDeviceResolver: () => ({ truckForVehicleOnDay: () => null }),
		console: quietConsole(errors),
	});
	const geoReq = (s) => ({ params: { loadId: "80000015" }, session: s });
	const mileReq = (s) => ({ query: { from: "2030-01-09", to: "2030-01-09", driver: "test driver" }, session: s });
	const answers = {
		geoDisp: await geo(geoReq(session("Dispatcher"))), geoDriver: await geo(geoReq(driverSession)), geoAdmin: await geo(geoReq(session("Super Admin"))),
		haulDisp: await haul(geoReq(session("Dispatcher"))), haulDriver: await haul(geoReq(driverSession)), haulAdmin: await haul(geoReq(session("Super Admin"))),
		mileDisp: await mileage(mileReq(session("Dispatcher"))), mileAdmin: await mileage(mileReq(session("Super Admin"))),
	};
	check("stored addresses: every answer 200, no error logged",
		[Object.values(answers).map((a) => a.code), errors], [Object.values(answers).map(() => 200), []]);
	check("stored addresses: the mileage detail lists the load (the checks below are not vacuous)",
		JSON.stringify(answers.mileAdmin.body || {}).includes("80000015"), true);
	for (const [label, key] of [["geocode, Dispatcher", "geoDisp"], ["geocode, Driver", "geoDriver"], ["haul, Dispatcher", "haulDisp"],
		["haul, Driver", "haulDriver"], ["mileage detail, Dispatcher", "mileDisp"]]) {
		check(`stored addresses, ${label}: no broker email or phone; the street still served`,
			[contactIn(answers[key].body), keptIn(answers[key].body, ["300 Pine Rd", "100 Main St"])], [[], ["300 Pine Rd", "100 Main St"]]);
	}
	check("stored addresses, Super Admin: geocode, haul and mileage detail serve the address as stored",
		[missingFrom(answers.geoAdmin.body, coords.dropoff_address), missingFrom(answers.haulAdmin.body, coords.dropoff_address),
			missingFrom(answers.mileAdmin.body, coords.dropoff_address)], [[], [], []]);
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
		require: realRequire, console: quietConsole(errors), ...ETA_ON_TIME,
	});
	const out = [await run({ params: { loadId: "80000011" } }), await run({ params: { loadId: "80000015" } })];
	check("public tracker: 200 for both loads with no error logged", out.map((o) => o.code).concat(errors), [200, 200]);
	check("public tracker: both loads are found (the check below is not vacuous)", out.map((o) => (o.body || {}).loadId), ["80000011", "80000015"]);
	check("public tracker, signed out: no broker email or phone anywhere in either answer", contactIn(out.map((o) => o.body)), []);
});

// ============================================ §8 Load IDs holding broker contact
// (2026-10-21, the Dispatcher raw Load ID plan, PR 1.) A Load ID can hold broker
// contact itself: a phone inside it, an email, or the row's own broker phone as
// bare digits. The row's Load ID cell has been served redacted since #525, but
// the ID reached Dispatchers raw everywhere else: Fleet chips and queues, the
// tracking map, live notices and events, expenses, messages, IFTA, mileage and
// fuel analytics, the ROW_MOVED refusal and the rate-con create's answer. For a
// non-Super-Admin no answer, error or live event may hold the raw ID text or a
// phone part of it (its digits); a Super Admin's are unchanged. Each check here
// failed on main (beside the Super Admin and "still served" pins).
//
// The made-up rows: H1 a phone inside the ID (In Transit), H2 the row's own broker
// phone as bare digits (Assigned), H3 a second ID that reads the same as H1 once
// withheld (Dispatched), H4 an email for an ID (another driver, Completed), H5 a
// phone inside an ID whose shown text no other row has, N1 a normal load.
const HD = "Hidden Driver";
const HROW = (o) => ({
	Driver: HD, "Pickup Address": "100 Main St, Dallas, TX 75201", "Drop-off Address": "200 Oak Ave, Tulsa, OK 74103",
	"Pickup Appointment": "1/14/2030 08:00", "Drop-off Appointment": "1/15/2030 09:00", "Assigned Date": "2030-01-14",
	Truck: "92", "Owner ID": "5", "  Payment  ": "$1,000.00", Details: "Dry van", ...o,
});
const N1 = HROW({ "Load ID": "80000031", "Job Status": "Assigned" });
const H1 = HROW({ "Load ID": "QA-555-010-0161", "Job Status": "In Transit", "Phone Number": "555-010-0170", Email: "agent.h1@example.invalid", "Broker Contact Name": "Kim Agent" });
const H2 = HROW({ "Load ID": "5550100163", "Job Status": "Assigned", "Phone Number": "555-010-0163" });
const H4 = HROW({ "Load ID": "agent.h4@example.invalid", Driver: "Other Driver", "Job Status": "Completed" });
const H5 = HROW({ "Load ID": "ZZ-555-010-0165", Driver: "Other Driver", "Job Status": "Completed" });
const H3 = HROW({ "Load ID": "QA-555-010-0162", "Job Status": "Dispatched" });
// Sheet order: N1 row 2, H1 row 3, H2 row 4, H4 row 5, H5 row 6, H3 row 7 (the
// driver's last active row, so the tracking map names it).
const HFIX = [N1, H1, H2, H4, H5, H3];
const HSHEET = () => [HEADERS.slice(), ...HFIX.map(cells)];
const HJT = { headers: HEADERS.slice(), data: HFIX.map((o, i) => rowObject(o, i + 2)) };
const hjt = () => HJT;
const bcLib = require(path.join(ROOT, "lib", "broker-contact"));
const HIDX = typeof bcLib.buildShownLoadIdIndex === "function"
	? bcLib.buildShownLoadIdIndex(HEADERS, HJT.data, { withheldRe: /broker|phone|e-?mail|contact|\bfax\b|mobile|\bcell\b/i })
	: null;
// Every hidden ID, as text (any letter case) and as the digits of its phone part.
const HIDDEN = ["qa-555-010-0161", "5550100161", "qa-555-010-0162", "5550100162", "5550100163", "agent.h4@example.invalid",
	"zz-555-010-0165", "5550100165"];
function hiddenIn(body, list = HIDDEN) {
	const text = typeof body === "string" ? body : JSON.stringify(body == null ? null : body);
	const low = text.toLowerCase();
	const digits = text.replace(/[^0-9]/g, "");
	return list.filter((p) => (/^\d+$/.test(p) ? digits.includes(p) : low.includes(p)));
}
const SHOWN_H1 = `QA-${WITHHELD_TEXT}`;
const sanitizeForTest = liftFunction("sanitizeBrokerColumns", {});
const servedRow = (o) => sanitizeForTest(HEADERS, [rowObject(o)])[0];

section("§8 GET /api/dashboard: Fleet chips and queues", async () => {
	const errors = [];
	const Database = require("better-sqlite3");
	const db = new Database(":memory:");
	db.exec(`CREATE TABLE trucks (id INTEGER PRIMARY KEY, unit_number TEXT, assigned_driver TEXT DEFAULT '');
		CREATE TABLE ratecon_load_aliases (alias TEXT PRIMARY KEY, load_id TEXT NOT NULL, source TEXT DEFAULT '', drive_file_id TEXT DEFAULT '', created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
		CREATE TABLE load_invoice_drafts (id INTEGER PRIMARY KEY AUTOINCREMENT, load_id TEXT NOT NULL, invoice_id TEXT, recipient TEXT, order_number TEXT, overrides_json TEXT DEFAULT '');`);
	const stubs = (more = {}) => ({
		requireRole: () => null, getJobTrackingCached: async () => hjt(), getDeletedLoadIds: () => new Set(), normalizeLoadId,
		getCarrierDBFromSQLite: () => ({ headers: ["Driver", "Truck", "Status"], data: [{ Driver: HD, Truck: "92", Status: "active" }] }),
		appDay: () => "2030-01-15", db, findTruckForDriver: () => null, require: realRequire, console: quietConsole(errors), ...more,
	});
	const head = 'app.get("/api/dashboard", requireRole("Super Admin", "Dispatcher"), async (req, res) => {';
	const disp = await lift(head, stubs())({ session: session("Dispatcher") });
	const admin = await lift(head, stubs())({ session: session("Super Admin") });
	const fleetOf = (r) => (((r.body || {}).fleet || []).find((f) => f.Driver === HD) || {});
	check("dashboard (Load IDs): both roles 200, no error logged", [disp.code, admin.code, errors], [200, 200, []]);
	check("dashboard (Load IDs), Super Admin: the chips name every ID as stored",
		[fleetOf(admin).CurrentLoad, (fleetOf(admin).QueuedLoadIds || []).slice().sort()],
		["QA-555-010-0161", ["5550100163", "80000031", "QA-555-010-0162"]]);
	check("dashboard (Load IDs), Dispatcher: no hidden ID anywhere in the answer (fleet, driverQueues, rows)", hiddenIn(disp.body), []);
	check("dashboard (Load IDs), Dispatcher: the chips read as shown, a normal ID as stored",
		[fleetOf(disp).CurrentLoad, (fleetOf(disp).QueuedLoadIds || []).slice().sort()],
		[SHOWN_H1, ["80000031", WITHHELD_TEXT, SHOWN_H1].sort()]);
	const queue = ((disp.body || {}).driverQueues || {})["hidden driver"] || [];
	check("dashboard (Load IDs), Dispatcher: driverQueues names the same three as the chips", queue.map((q) => q.load_id).sort(), ["80000031", WITHHELD_TEXT, SHOWN_H1].sort());
	// The kill switch off: the column-only rule, so the IDs are served as stored.
	const off = await lift(head, stubs({ BROKER_CONTACT_VALUE_REDACTION_ENABLED: false }))({ session: session("Dispatcher") });
	check("dashboard (Load IDs), value redaction switched off, Dispatcher: the chips as stored", fleetOf(off).CurrentLoad, "QA-555-010-0161");
});

section("§8 GET /api/locations/latest: the tracking map's load", async () => {
	const errors = [];
	const run = (role) => lift('app.get("/api/locations/latest", requireRole("Super Admin", "Dispatcher"), async (req, res) => {', {
		requireRole: () => null, getSheets: fakeSheets(HSHEET()).getSheets, SPREADSHEET_ID: "sheet-under-test",
		db: emptyDb([[/FROM drivers_directory/i, [{ id: 1, driver_name: HD }]]]), normalizeLoadId, console: quietConsole(errors),
		require: realRequire, currentShownLoadIdIndex: () => HIDX, ...ETA_ON_TIME,
	})({ session: session(role) });
	const disp = await run("Dispatcher");
	const admin = await run("Super Admin");
	const loadOf = (r) => ((((r.body || {}).locations || [])[0]) || {}).loadId;
	check("locations (Load IDs): both roles 200, no error logged", [disp.code, admin.code, errors], [200, 200, []]);
	check("locations (Load IDs), Super Admin: the driver's load as stored", loadOf(admin), "QA-555-010-0162");
	check("locations (Load IDs), Dispatcher: the load as shown; no hidden ID anywhere", [loadOf(disp), hiddenIn(disp.body)], [`QA-${WITHHELD_TEXT}`, []]);
});

section("§8 GET /api/expenses/all, GET /api/messages: stored load ids", async () => {
	const errors = [];
	const expenseRows = [
		{ id: 1, driver: HD, load_id: "5550100163", type: "Fuel", amount: 10, date: "2030-01-14", status: "Approved", receipt_details: "" },
		{ id: 2, driver: HD, load_id: "QA-555-010-0161", type: "Tolls", amount: 5, date: "2030-01-14", status: "Approved", receipt_details: "" },
		{ id: 3, driver: HD, load_id: "80000031", type: "Tolls", amount: 5, date: "2030-01-14", status: "Approved", receipt_details: "" },
	];
	const expenses = (role) => lift('app.get("/api/expenses/all", requireRole("Super Admin", "Dispatcher"), (req, res) => {', {
		requireRole: () => null, db: emptyDb([[/FROM expenses/i, expenseRows]]), currentShownLoadIdIndex: () => HIDX,
		console: quietConsole(errors), require: realRequire,
	})({ session: session(role) });
	const disp = await expenses("Dispatcher");
	const admin = await expenses("Super Admin");
	const ids = (r) => ((r.body || {}).expenses || []).map((e) => e.load_id);
	check("expenses (Load IDs): both roles 200, no error logged", [disp.code, admin.code, errors], [200, 200, []]);
	check("expenses (Load IDs), Super Admin: each load id as stored", ids(admin), ["5550100163", "QA-555-010-0161", "80000031"]);
	check("expenses (Load IDs), Dispatcher: the bare-digit own-phone ID withheld too (the index, not the patterns)",
		[ids(disp), hiddenIn(disp.body)], [[WITHHELD_TEXT, SHOWN_H1, "80000031"], []]);

	const messageRows = [
		{ id: 1, timestamp: "2030-01-14T10:00:00Z", from: HD, to: "Dispatch", message: "at the dock", loadId: "5550100163", read: 0, driver: HD, lastTimestamp: "2030-01-14T10:00:00Z", unread: 1 },
		{ id: 2, timestamp: "2030-01-14T11:00:00Z", from: "Dispatch", to: HD, message: "ok", loadId: "QA-555-010-0162", read: 1, driver: HD, lastTimestamp: "2030-01-14T11:00:00Z", unread: 0 },
	];
	const msgDb = emptyDb([[/FROM messages/i, messageRows]]);
	const list = (role) => lift('app.get("/api/messages", requireRole("Super Admin", "Dispatcher"), (req, res) => {', {
		requireRole: () => null, db: msgDb, currentShownLoadIdIndex: () => HIDX, console: quietConsole(errors),
	})({ session: session(role) });
	const thread = (role) => lift('app.get("/api/messages/:driverName", requireRole("Super Admin", "Dispatcher"), (req, res) => {', {
		requireRole: () => null, db: msgDb, currentShownLoadIdIndex: () => HIDX, console: quietConsole(errors),
	})({ params: { driverName: HD }, session: session(role) });
	const dl = await list("Dispatcher"), al = await list("Super Admin"), dt = await thread("Dispatcher"), at = await thread("Super Admin");
	check("messages (Load IDs): every answer 200, no error logged", [dl.code, al.code, dt.code, at.code, errors], [200, 200, 200, 200, []]);
	check("messages (Load IDs), Super Admin: the load ids as stored", [hiddenIn(al.body).sort(), hiddenIn(at.body).sort()],
		[["5550100162", "5550100163", "qa-555-010-0162"], ["5550100162", "5550100163", "qa-555-010-0162"]]);
	check("messages (Load IDs), Dispatcher: no hidden ID in the conversation list or the thread", [hiddenIn(dl.body), hiddenIn(dt.body)], [[], []]);
});

section("§8 IFTA state detail, mileage detail, fuel analytics", async () => {
	const errors = [];
	// Mileage detail: a fuel receipt and a status change on hidden loads.
	const mileage = (role) => lift('app.get("/api/analytics/mileage/detail",', {
		requireRole: () => null, mileageAnalyticsLimiter: null, currentShownLoadIdIndex: () => HIDX,
		db: emptyDb([
			[/FROM eld_miles_daily/i, [{ local_day: "2030-01-14", driver_name: HD, driver_key: "hidden driver", miles: 100, basis: "eld", samples: 10,
				rejected_deltas: 0, dropped_miles: 0, max_gap_ms: 0, first_ms: 0, last_ms: 0, vid: "v1" }]],
			[/SELECT id, unit_number FROM trucks/i, [{ id: 1, unit_number: "92" }]],
			[/LOWER\(type\) = 'fuel'/i, [{ date: "2030-01-14", truck_unit: "92", amount: 80, gallons: 20, vendor: "Fuel Stop", odometer: 1000, load_id: "5550100163", driver: HD }]],
			[/FROM load_status_history/i, [{ day: "2030-01-14", load_id: "QA-555-010-0161", new_status: "In Transit", changed_at: "2030-01-14T15:00:00Z",
				actor: HD, pickup_address: "100 Main St, Dallas, TX 75201", dropoff_address: "200 Oak Ave, Tulsa, OK 74103" }]],
		]),
		buildEldDeviceResolver: () => ({ truckForVehicleOnDay: () => 1 }),
		console: quietConsole(errors),
	})({ query: { from: "2030-01-14", to: "2030-01-14", driver: "hidden driver" }, session: session(role) });
	const md = await mileage("Dispatcher"), ma = await mileage("Super Admin");
	check("mileage detail (Load IDs): both 200, no error logged", [md.code, ma.code, errors], [200, 200, []]);
	check("mileage detail (Load IDs), Super Admin: the fuel and the load entry name their loads as stored",
		hiddenIn(ma.body).sort(), ["5550100161", "5550100163", "qa-555-010-0161"]);
	check("mileage detail (Load IDs), Dispatcher: no hidden ID", hiddenIn(md.body), []);

	// Fuel analytics: the recent fills list.
	const fuelRows = [{ id: 7, driver: HD, amount: 80, gallons: 20, odometer: 1000, truck_unit: "92", date: "2030-01-14", load_id: "5550100163", type: "Fuel", status: "Approved" }];
	const fuel = (role) => lift('app.get("/api/expenses/fuel-analytics", requireRole("Super Admin", "Dispatcher"), fuelAnalyticsLimiter, (req, res) => {', {
		requireRole: () => null, fuelAnalyticsLimiter: null, currentShownLoadIdIndex: () => HIDX,
		db: emptyDb([[/LOWER\(type\) = 'fuel'/i, fuelRows]]), console: quietConsole(errors), require: realRequire,
		// A one-line const with a trailing comment, which this runner's const reader can't lift.
		FUEL_DUPLICATE_MAX_GROUPS: 200,
	})({ query: {}, session: session(role) });
	const fd = await fuel("Dispatcher"), fa = await fuel("Super Admin");
	const fills = (r) => ((r.body || {}).recentFills || []).map((f) => f.loadId);
	check("fuel analytics (Load IDs): both 200, no error logged", [fd.code, fa.code, errors], [200, 200, []]);
	check("fuel analytics (Load IDs): Super Admin as stored, Dispatcher withheld", [fills(fa), fills(fd), hiddenIn(fd.body)], [["5550100163"], [WITHHELD_TEXT], []]);

	// IFTA state detail: the loads matched to each day (from the Job Tracking cache).
	const t0 = Date.parse("2030-01-14T15:00:00Z");
	const ifta = (role) => lift('app.get("/api/compliance/ifta/state-detail", requireRole("Super Admin", "Dispatcher"), async (req, res) => {', {
		requireRole: () => null, getJobTrackingCached: async () => hjt(), getDeletedLoadIds: () => new Set(), normalizeLoadId,
		appDay: () => "2030-01-15", getStateFromCoords: () => "TX",
		db: emptyDb([
			[/FROM trucks WHERE id/i, [{ id: 1, unit_number: "92", routemate_vehicle_id: "v1" }]],
			[/FROM routemate_telemetry/i, [{ latitude: 32.78, longitude: -96.8, location_date_ms: t0 }, { latitude: 32.80, longitude: -96.8, location_date_ms: t0 + 600000 }]],
			[/FROM truck_assignments/i, [{ driver_name: HD, start_date: "2030-01-01", end_date: "2030-12-31" }]],
		]),
		console: quietConsole(errors), require: realRequire,
	})({ query: { truck_id: "1", state: "TX", start: "2030-01-14T00:00:00Z", end: "2030-01-14T23:59:59Z" }, session: session(role) });
	const idd = await ifta("Dispatcher"), ida = await ifta("Super Admin");
	const dayIds = (r) => ((((r.body || {}).days || [])[0]) || {}).loadIds || [];
	check("IFTA state detail (Load IDs): both 200, no error logged", [idd.code, ida.code, errors], [200, 200, []]);
	check("IFTA state detail (Load IDs), Super Admin: the day's loads as stored (the check below is not vacuous)",
		hiddenIn(dayIds(ida)).length > 0, true);
	check("IFTA state detail (Load IDs), Dispatcher: no hidden ID; the normal load still named",
		[hiddenIn(idd.body), dayIds(idd).includes("80000031")], [[], true]);
});

section("§8 PUT /api/data/:rowIndex: ROW_MOVED and a hidden Load ID", async () => {
	const errors = [];
	const refusals = [];
	const rowOf = (o) => HFIX.indexOf(o) + 2;
	const save = async (o, role, { baseline, edit = { "Trailer Number": "TR-7" }, rowIndex = rowOf(o) } = {}) => {
		const rows = HSHEET();
		const { run, sheet } = liftDataPut(rows, errors, { logAuditRefusal: () => refusals.push(1) });
		const base = baseline || (role === "Super Admin" ? rowObject(o) : servedRow(o));
		const r = await run({ params: { rowIndex: String(rowIndex) }, query: { sheet: "Job Tracking" },
			body: { values: cells({ ...base, ...edit }), baseline: cells(base) }, session: session(role) });
		return { r, rows, writes: sheet.writes.length };
	};
	const unique = await save(H5, "Dispatcher");
	check("row save, Dispatcher, a partly withheld Load ID no other row reads the same: 200, the edit written, the ID kept as stored",
		[unique.r.code, unique.rows[rowOf(H5) - 1][HEADERS.indexOf("Trailer Number")], unique.rows[rowOf(H5) - 1][HEADERS.indexOf("Load ID")]],
		[200, "TR-7", "ZZ-555-010-0165"]);
	const shared = await save(H1, "Dispatcher");
	check("row save, Dispatcher, a withheld Load ID another row reads the same: 409 ROW_MOVED naming no hidden ID, nothing written",
		[shared.r.code, (shared.r.body || {}).code, hiddenIn(shared.r.body), shared.writes], [409, "ROW_MOVED", [], 0]);
	const allContact = await save(H4, "Dispatcher");
	check("row save, Dispatcher, a Load ID that is only contact: 409 ROW_MOVED naming no hidden ID, nothing written",
		[allContact.r.code, (allContact.r.body || {}).code, hiddenIn(allContact.r.body), allContact.writes], [409, "ROW_MOVED", [], 0]);
	const probe = await save(N1, "Dispatcher", { rowIndex: rowOf(H2) });
	check("row save, Dispatcher, a row number probed with another load's baseline: 409 ROW_MOVED, the row's hidden ID not named",
		[probe.r.code, (probe.r.body || {}).code, hiddenIn(probe.r.body)], [409, "ROW_MOVED", []]);
	const normal = await save(N1, "Dispatcher");
	check("row save, Dispatcher, a normal load: 200, as before", [normal.r.code, normal.writes], [200, 1]);
	const adminProbe = await save(N1, "Super Admin", { rowIndex: rowOf(H2) });
	check("row save, Super Admin, the same probe: 409 ROW_MOVED naming the row's Load ID as stored, as before",
		[adminProbe.r.code, (adminProbe.r.body || {}).foundLoadId], [409, "5550100163"]);
	const adminSave = await save(H1, "Super Admin");
	check("row save, Super Admin, a hidden-ID row opened as stored: 200, as before", adminSave.r.code, 200);
	check("row saves (Load IDs): no error logged", errors, []);
});

section("§8 a Load ID typed with contact in it: 400 CONTACT_NOT_ALLOWED", async () => {
	const errors = [];
	for (const role of ["Dispatcher", "Super Admin"]) {
		const rows = HSHEET();
		const { run, sheet } = liftDataPut(rows, errors);
		const base = role === "Super Admin" ? rowObject(N1) : servedRow(N1);
		const r = await run({ params: { rowIndex: "2" }, query: { sheet: "Job Tracking" },
			body: { values: cells({ ...base, "Load ID": "555-010-0168" }), baseline: cells(base) }, session: session(role) });
		check(`row save, ${role}, a phone typed into Load ID: 400 CONTACT_NOT_ALLOWED naming Load ID, nothing written`,
			[r.code, (r.body || {}).code, (r.body || {}).field, sheet.writes.length], [400, "CONTACT_NOT_ALLOWED", "Load ID", 0]);
		const loadRows = HSHEET();
		const { run: runLoad, sheet: loadSheet } = liftLoadPut(loadRows, errors);
		const l = await runLoad({ params: { loadId: "80000031" }, body: { "Load ID": "new.agent@example.invalid" }, session: session(role) });
		check(`load save, ${role}, an email typed into Load ID: 400 CONTACT_NOT_ALLOWED naming Load ID, nothing written`,
			[l.code, (l.body || {}).code, (l.body || {}).field, loadSheet.writes.length], [400, "CONTACT_NOT_ALLOWED", "Load ID", 0]);
	}
	check("typed Load IDs: no error logged", errors, []);
});

section("§8 POST /api/loads/from-ratecon: a rate con whose load number holds a phone", async () => {
	const errors = [];
	const common = { requireRole: () => null, rateConLimiter: null, console: quietConsole(errors) };
	let answer = null;
	const extract = lift('app.post("/api/loads/ratecon/extract", requireRole("Super Admin", "Dispatcher"), rateConLimiter, async (req, res) => {', {
		...common, GEMINI_API_KEY: "test-key", runRateConGemini: async () => ({ ...answer }), rateConNormalizeOptions: () => ({}),
		rateconNormalize: require(path.join(ROOT, "lib", "ratecon-normalize")), rateconLoad: require(path.join(ROOT, "lib", "ratecon-load")),
	});
	const create = (tabs, rec, more = {}) => lift('app.post("/api/loads/from-ratecon", requireRole("Super Admin", "Dispatcher"), rateConLimiter, async (req, res) => {', {
		...common, getSheets: fakeTabs(tabs).getSheets, SPREADSHEET_ID: "sheet-under-test", rateconLoad: require(path.join(ROOT, "lib", "ratecon-load")),
		getDeletedLoadIds: () => new Set(), GOOGLE_MAPS_API_KEY: "", geocodeAddress: async () => null, appDay: () => "2030-01-19",
		validateOwnerIdCell: () => null, jtCacheInvalidate: () => {}, notifyChange: () => {}, logAudit: () => {},
		// The archive write fails, so a warning names the load.
		DATA_DIR: path.join(ROOT, "no-such-dir"), fs: { existsSync: () => true, mkdirSync() {}, writeFileSync() { throw new Error("disk full"); } },
		db: emptyDb(), RATECON_DRIVE_FOLDER_ID: "", currentShownLoadIdIndex: () => HIDX,
		insertDispatchNotification: { run: (...args) => { rec.stored.push(args); return { lastInsertRowid: 1 }; } }, io: fakeIo(rec.emitted),
		...more,
	});
	const newTabs = (extraRow) => ({
		"Job Tracking": [HEADERS.slice(), ...(extraRow ? [extraRow] : [])],
		"Payments Table": [[" Job ID", "Contract ID", "Payment Amount"]],
		"Job Details": [["Load ID", "Rate Per Mile", "Distance", "Details", "Payment"]],
	});
	const rc = (n) => ({
		"Load Number": n, "Broker Name": "Pat Agent", "Broker Phone": "(555) 010-0142", "Broker Email": "agent.one@example.invalid", Rate: "$1,800.00",
		"Pickup Address": "100 Main St, Dallas, TX 75201", "Drop-off Address": "200 Oak Ave, Tulsa, OK 74103",
		"Pickup Appointment Time": "01/20/2030 08:00", "Delivery Appointment Time": "01/21/2030 14:00", Details: "Dry van",
	});
	const asShown = (r) => Object.fromEntries(Object.entries((r.body || {}).fields || {}).map(([k, v]) => [k, v == null ? "" : v]));
	const pdf = (s) => Buffer.from(`%PDF-1.4 ${s}`).toString("base64");
	const HID_RC = ["qa-555-010-0167", "5550100167"];

	// The rate con's own load number, sent back as served: the load is created
	// under it; the answer, its warnings and the live notice name it as shown.
	answer = rc("QA-555-010-0167");
	const p1 = pdf("hidden load number");
	const served = await extract({ body: { pdfBase64: p1 }, session: session("Dispatcher") });
	const tabs = newTabs();
	const rec = { stored: [], emitted: [] };
	const made = await create(tabs, rec)({ body: { fields: asShown(served), pdfBase64: p1, fileName: "rc.pdf" }, session: session("Dispatcher") });
	check("rate-con create (Load IDs), Dispatcher: 200, the load stored under the rate con's own number",
		[served.code, made.code, (tabs["Job Tracking"][1] || [])[HEADERS.indexOf("Load ID")]], [200, 200, "QA-555-010-0167"]);
	check("rate-con create (Load IDs), Dispatcher: the answer and its warnings name the load as shown (the warning is not vacuous)",
		[hiddenIn(made.body, HID_RC), (made.body || {}).loadId, ((made.body || {}).warnings || []).some((w) => w.includes(`QA-${WITHHELD_TEXT}`))],
		[[], `QA-${WITHHELD_TEXT}`, true]);
	check("rate-con create (Load IDs): the New Load notice: Super Admins as stored, the rest of the room as shown (title and metadata), stored in full",
		[hiddenIn(toSuperAdmins(rec.emitted, "dispatch-notification"), HID_RC).length > 0, hiddenIn(toDispatchers(rec.emitted, "dispatch-notification"), HID_RC),
			toDispatchers(rec.emitted, "dispatch-notification").length, toWholeRoom(rec.emitted, "dispatch-notification").length, (rec.stored[0] || [])[1]],
		[true, [], 1, 0, "New Load QA-555-010-0167"]);

	// The two 409s: already being created, and already on the sheet.
	answer = rc("QA-555-010-0167");
	const inflight = await create(newTabs(), { stored: [], emitted: [] }, { rateConCreateInFlight: new Set(["qa-555-010-0167"]) })({
		body: { fields: asShown(served), pdfBase64: p1 }, session: session("Dispatcher") });
	check("rate-con create (Load IDs), Dispatcher, already being created: 409 naming the load as shown",
		[inflight.code, (inflight.body || {}).code, hiddenIn(inflight.body, HID_RC)], [409, "DUPLICATE_LOAD", []]);
	const dupRow = cells(HROW({ "Load ID": "QA-555-010-0167", "Job Status": "Assigned" }));
	const dup = await create(newTabs(dupRow), { stored: [], emitted: [] })({ body: { fields: asShown(served), pdfBase64: p1 }, session: session("Dispatcher") });
	check("rate-con create (Load IDs), Dispatcher, already on the sheet: 409 naming the load as shown",
		[dup.code, (dup.body || {}).code, hiddenIn(dup.body, HID_RC)], [409, "DUPLICATE_LOAD", []]);
	const dupAdmin = await create(newTabs(dupRow), { stored: [], emitted: [] })({ body: { fields: rc("QA-555-010-0167"), pdfBase64: p1 }, session: session("Super Admin") });
	check("rate-con create (Load IDs), Super Admin, already on the sheet: 409 naming the load as stored, as before",
		[dupAdmin.code, hiddenIn(dupAdmin.body, HID_RC).length > 0], [409, true]);

	// A load number the person typed (it differs from the extract) holding a
	// phone or an email: refused for every role; the rate con's own goes through.
	for (const role of ["Dispatcher", "Super Admin"]) {
		answer = rc("80000041");
		const p = pdf(`typed ${role}`);
		const s = await extract({ body: { pdfBase64: p }, session: session(role) });
		const typedTabs = newTabs();
		const typed = await create(typedTabs, { stored: [], emitted: [] })({ body: { fields: { ...asShown(s), "Load Number": "555-010-0168" }, pdfBase64: p }, session: session(role) });
		check(`rate-con create, ${role}, a typed load number holding a phone: 400 CONTACT_NOT_ALLOWED, nothing written`,
			[typed.code, (typed.body || {}).code, typedTabs["Job Tracking"].length], [400, "CONTACT_NOT_ALLOWED", 1]);
	}
	answer = rc("QA-555-010-0169");
	const p3 = pdf("admin own number");
	const sa = await extract({ body: { pdfBase64: p3 }, session: session("Super Admin") });
	const saTabs = newTabs();
	const saMade = await create(saTabs, { stored: [], emitted: [] })({ body: { fields: asShown(sa), pdfBase64: p3 }, session: session("Super Admin") });
	check("rate-con create, Super Admin, the rate con's own phone-shaped number: 200, created, the answer as stored",
		[saMade.code, (saMade.body || {}).loadId], [200, "QA-555-010-0169"]);
	check("rate-con create (Load IDs): no error logged but the archive write this section fails on purpose",
		errors.filter((e) => !/local rate-con archive failed: disk full/.test(e)), []);
});

section("§8 live notices and events: per role, every hidden ID swapped", async () => {
	const errors = [];
	// Every dispatch-room notice and load event goes through the per-role helpers:
	// none is sent to the whole dispatch room as one payload any more.
	const code = SRC.replace(/\/\/.*$/gm, "");
	const direct = [...code.matchAll(/io\.to\("dispatch"\)\.emit\("([^"]+)"/g)].map((m) => m[1]);
	check("live: no notice or load event is sent to the whole dispatch room in one payload",
		direct.filter((e) => ["dispatch-notification", "pod-uploaded", "status-updated", "load-accepted", "load-declined", "geofence-trigger", "location-update"].includes(e)), []);

	const emitted = [];
	const helpers = { io: fakeIo(emitted), currentShownLoadIdIndex: () => HIDX, console: quietConsole(errors) };
	const notice = liftFunction("emitDispatchNotice", helpers);
	notice({ type: "status-updated", title: `${HD}: In Transit`, body: "Load 5550100163" });
	notice({ type: "invoices-autogen", title: "Weekly invoices", body: "1 generated · UNDATED completed loads NOT billed (5550100163 (Hidden Driver))" });
	const event = liftFunction("emitLoadEventToDispatch", helpers);
	event("status-updated", { loadId: "5550100163", driverName: HD, newStatus: "In Transit" });
	event("pod-uploaded", { loadId: "QA-555-010-0161", driverName: HD, driveUrl: "https://drive.example.invalid/f", docType: "POD" }, { dropForStaff: ["driveUrl"] });
	const staff = emitted.filter((e) => e.room === "dispatch" && e.except === SA_ROOM);
	const admins = emitted.filter((e) => e.room === SA_ROOM);
	check("live helpers: each sent once to Super Admins and once to the rest of the room, never the whole room",
		[admins.length, staff.length, emitted.filter((e) => e.room === "dispatch" && !e.except).length], [4, 4, 0]);
	check("live helpers, Super Admins: every ID as stored", hiddenIn(admins.map((e) => e.payload)).sort(), ["5550100161", "5550100163", "qa-555-010-0161"]);
	check("live helpers, the rest of the room: no hidden ID (one named only in a notice body too); the event's loadId as shown; no Drive link",
		[hiddenIn(staff.map((e) => e.payload)), staff[2] && staff[2].payload.loadId, staff[3] && "driveUrl" in staff[3].payload],
		[[], WITHHELD_TEXT, false]);

	// The re-issue notice's title and metadata name the load.
	const stored = [];
	const sent = [];
	const send = liftFunction("sendReissueAlert", {
		db: emptyDb(), insertDispatchNotification: { run: (...args) => { stored.push(args); return { lastInsertRowid: 1 }; } },
		io: fakeIo(sent), ADMIN_NOTIFY_EMAIL: "", sendEmail: async () => true, console: quietConsole(errors), currentShownLoadIdIndex: () => HIDX,
	});
	await send({ key: "5550100163", label: "5550100163", reason: "the load is delivered",
		rows: [{ column: "Details", stored: "Dry van", sent: "Dry van, sealed", kind: "changed", email: false, inApp: true }],
		claimedAt: "2030-01-15T12:00:00.000Z", now: new Date("2030-01-15T12:00:00.000Z") });
	check("re-issue notice (Load IDs): Super Admins and the stored row as stored; the rest of the room with title and metadata as shown",
		[hiddenIn(toSuperAdmins(sent, "dispatch-notification")).length > 0, hiddenIn(stored).length > 0, hiddenIn(toDispatchers(sent, "dispatch-notification")),
			(toDispatchers(sent, "dispatch-notification")[0] || {}).title],
		[true, true, [], `Load ${WITHHELD_TEXT}: re-issued rate con changed fields`]);

	// GET /api/dispatch-notifications: an ID named only in a body, and in metadata.
	const Database = require("better-sqlite3");
	const db = new Database(":memory:");
	db.exec(/CREATE TABLE IF NOT EXISTS dispatch_notifications \([\s\S]*?\n\t\)/.exec(SRC)[0]);
	const ins = db.prepare("INSERT INTO dispatch_notifications (type, title, body, metadata) VALUES (?, ?, ?, ?)");
	ins.run("status-updated", `${HD}: In Transit`, "Load 5550100163", JSON.stringify({ loadId: "5550100163", driverName: HD }));
	ins.run("invoices-autogen", "Weekly invoices", "UNDATED completed loads NOT billed (5550100163 (Hidden Driver))", JSON.stringify({ submitted: 1 }));
	const get = (role) => lift('app.get("/api/dispatch-notifications", requireRole("Super Admin", "Dispatcher"), (req, res) => {', {
		requireRole: () => null, db, console: quietConsole(errors), currentShownLoadIdIndex: () => HIDX,
	})({ session: session(role) });
	const gd = await get("Dispatcher"), ga = await get("Super Admin");
	check("stored notices (Load IDs): Super Admin as stored, a Dispatcher with every hidden ID swapped",
		[gd.code, ga.code, hiddenIn(ga.body).length > 0, hiddenIn(gd.body)], [200, 200, true, []]);

	// The n8n webhook: a load not yet in the cache. The cache is read fresh after
	// n8n is answered; a failed read leaves the ID out of the Dispatchers' copy.
	const prev = process.env.N8N_WEBHOOK_SECRET;
	process.env.N8N_WEBHOOK_SECRET = "test-secret";
	try {
		const fresh = { headers: HEADERS.slice(), data: [...HJT.data, rowObject(HROW({ "Load ID": "5550100166", "Phone Number": "555-010-0166", "Job Status": "Unassigned" }), 8)] };
		for (const [label, reader, want] of [
			["read fresh", async () => fresh, `New Load ${WITHHELD_TEXT}`],
			["the fresh read fails", async () => { throw new Error("sheets down"); }, "New Load"],
		]) {
			const out = [];
			const hook = lift('app.post("/api/webhook/new-load", (req, res) => {', {
				insertDispatchNotification: { run: () => ({ lastInsertRowid: 1 }) }, io: fakeIo(out), jtCacheInvalidate: () => {},
				getJobTrackingCached: reader, console: quietConsole([]),
			});
			const r = await hook({ headers: { "x-webhook-secret": "test-secret" }, body: { load_id: "5550100166", driver: HD } });
			for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
			const disp = toDispatchers(out, "dispatch-notification");
			check(`webhook new load (${label}): n8n answered; Super Admins get the ID, the rest of the room "${want}"`,
				[r.code, hiddenIn(toSuperAdmins(out, "dispatch-notification"), ["5550100166"]).length > 0, disp.length, (disp[0] || {}).title, hiddenIn(disp, ["5550100166"])],
				[200, true, 1, want, []]);
		}
	} finally {
		if (prev === undefined) delete process.env.N8N_WEBHOOK_SECRET; else process.env.N8N_WEBHOOK_SECRET = prev;
	}
	check("live notices (Load IDs): no error logged", errors, []);
});

// ================================================ §9 a Driver's own Load ID (D1)
// (2026-10-21, Revision 4 of the plan, Arvin's D1.) A Driver sees his OWN load's
// Load ID exactly as stored (he gives it at check-in), never another driver's,
// and every other cell of his rows stays as before (broker columns blank,
// contact withheld, the Documents cell where n8n copies the Load ID included).
// "Own" is the row's Driver cell against the session's driver name, server-side.
// Before this, the Load ID cell was served withheld, so his accepted badge,
// queue position and receipt window keyed on a text no record holds, and his
// receipts and POD uploads named a load the ownership check could not find.
const H6 = HROW({ "Load ID": "QA-555-010-0164", "Job Status": "Completed", "Completion Date": "1/12/2030" });
const D_FIX = [N1, { ...H1, Documents: H1["Load ID"], Details: "Dry van; call 555-010-0170 at the gate" }, H2, H4, H5, H3, H6];
const DJT = { headers: HEADERS.slice(), data: D_FIX.map((o, i) => rowObject(o, i + 2)) };
const OTHERS_HIDDEN = ["agent.h4@example.invalid", "zz-555-010-0165", "5550100165"];
// SQLite for the driver page, answering by parameter: his accepted load, and a
// delivery yesterday for the completed hidden load (by its stored id only).
const driverPageDb = () => ({
	prepare: (sql) => {
		const rows = (...params) => {
			if (/FROM load_responses/i.test(sql)) return [{ load_id: "5550100163", driver_name: "hidden driver", responded_at: "2030-01-14 10:00:00", id: 1 }];
			if (/FROM load_status_history/i.test(sql)) {
				return params.includes("qa-555-010-0164")
					? [{ load_id: "qa-555-010-0164", old_status: "In Transit", new_status: "Delivered", changed_at: new Date(Date.now() - 86400000).toISOString() }]
					: [];
			}
			return [];
		};
		return { all: (...p) => rows(...p), get: (...p) => rows(...p)[0], run: () => ({ changes: 0, lastInsertRowid: 0 }), pluck() { return this; }, raw() { return this; } };
	},
	exec: () => {},
	transaction: (fn) => fn,
});

section("§9 GET /api/driver/:driverName: the driver's own Load IDs (T1, T2, T5)", async () => {
	const errors = [];
	const page = (sess, name = HD) => lift('app.get("/api/driver/:driverName", requireRole("Super Admin", "Driver"), async (req, res) => {', {
		requireRole: () => null, getJobTrackingCached: async () => DJT, getDeletedLoadIds: () => new Set(), normalizeLoadId,
		db: driverPageDb(), require: realRequire, console: quietConsole(errors), currentShownLoadIdIndex: () => HIDX,
	})({ params: { driverName: name }, session: sess });
	const hd = session("Driver", { driverName: HD, driver_name: HD });
	const driver = await page(hd);
	const admin = await page(session("Super Admin"));
	const other = await page(hd, "Other Driver");
	const loads = (r) => ((r.body || {}).loads || []);
	const byId = (r, id) => loads(r).find((l) => l["Load ID"] === id) || {};
	check("driver page (D1): 200 for the driver and a Super Admin, 403 for another driver's page, no error logged",
		[driver.code, admin.code, other.code, errors], [200, 200, 403, []]);
	check("driver page (D1), T1: each of his loads names its Load ID exactly as stored",
		loads(driver).map((l) => l["Load ID"]).sort(), ["5550100163", "80000031", "QA-555-010-0161", "QA-555-010-0162", "QA-555-010-0164"]);
	check("driver page (D1), T1: no load lists its Load ID among the withheld cells",
		loads(driver).filter((l) => (l._withheldCells || []).includes("Load ID")).map((l) => l["Load ID"]), []);
	const h1 = byId(driver, "QA-555-010-0161");
	check("driver page (D1), T1: every other cell as before: the Documents cell (the Load ID n8n copies there) and Details withheld, broker columns blank",
		[h1.Documents, h1.Details, h1["Phone Number"], h1.Email, h1["Broker Contact Name"]],
		[`QA-${WITHHELD_TEXT}`, `Dry van; call ${WITHHELD_TEXT} at the gate`, "", "", ""]);
	check("driver page (D1), T1: the accepted badge, the queue position and the receipt window key on the stored ID",
		[byId(driver, "5550100163")._accepted, typeof byId(driver, "5550100163")._queuePosition, typeof byId(driver, "QA-555-010-0162")._queuePosition,
			(byId(driver, "QA-555-010-0164")._expenseWindow || {}).state],
		[true, "number", "number", "open"]);
	check("driver page (D1), T2: no other driver's withheld ID anywhere in his answer", hiddenIn(driver.body, OTHERS_HIDDEN), []);
	check("driver page (D1), T5: a Super Admin's answer as before: every ID and the Documents cell as stored, no withheld cells",
		[loads(admin).map((l) => l["Load ID"]).sort(), byId(admin, "QA-555-010-0161").Documents, loads(admin).some((l) => "_withheldCells" in l)],
		[["5550100163", "80000031", "QA-555-010-0161", "QA-555-010-0162", "QA-555-010-0164"], "QA-555-010-0161", false]);
});

section("§9 the ownership check takes the ID the driver is served (T3)", async () => {
	const owns = liftFunction("loadBelongsToDriver", { getJobTrackingCached: async () => DJT, getDeletedLoadIds: () => new Set(), console: quietConsole([]) });
	check("ownership (D1), T3: his own hidden-ID load as now served passes; as served before (withheld) it did not; another driver's load does not",
		[await owns("QA-555-010-0161", HD), await owns("5550100163", HD), await owns(`QA-${WITHHELD_TEXT}`, HD), await owns("ZZ-555-010-0165", HD)],
		[true, true, false, false]);
	check("ownership (D1), T4: the driver page is still for Super Admin and Driver only (the route the runner lifts by that registration)",
		SRC.includes('\napp.get("/api/driver/:driverName", requireRole("Super Admin", "Driver"), async (req, res) => {'), true);
});

// T6: what the driver then does on his withheld-ID load, through the shipped
// routes, naming it as he is now served it (as stored): accept it, update its
// status, upload a POD (the event carries its Drive link), file a receipt and
// send a message. Every copy the rest of the dispatch room gets (live events and
// notices), and what a Dispatcher then reads (GET /api/expenses/all, GET
// /api/messages), names the load as shown; Super Admins get it as stored. The
// load is H2: its ID is the row's own broker phone as bare digits, so only the
// index withholds it (the patterns alone would not).
const DSHEET = () => [HEADERS.slice(), ...D_FIX.map(cells)];
const DIDX = typeof bcLib.buildShownLoadIdIndex === "function"
	? bcLib.buildShownLoadIdIndex(HEADERS, DJT.data, { withheldRe: /broker|phone|e-?mail|contact|\bfax\b|mobile|\bcell\b/i })
	: null;
const H2_ROW = D_FIX.indexOf(H2) + 2;
section("§9 T6: the driver's own writes on his withheld-ID load reach the rest of the room as shown", async () => {
	const errors = [];
	const emitted = [];
	const stored = [];
	const Database = require("better-sqlite3");
	const db = new Database(":memory:");
	// server.js's own tables, as its CREATE TABLE and ALTER TABLE statements make them.
	const TABLES = ["messages", "expenses", "documents", "load_responses", "trucks", "truck_assignments", "period_locks", "users", "drivers_directory"];
	for (const t of TABLES) {
		const ddl = new RegExp(`CREATE TABLE IF NOT EXISTS ${t} \\([\\s\\S]*?\\n\\t\\)`).exec(SRC);
		if (!ddl) throw new Error(`${t} CREATE TABLE not found in server.js`);
		db.exec(ddl[0]);
	}
	for (const m of SRC.matchAll(new RegExp(`ALTER TABLE (${TABLES.join("|")}) ADD COLUMN ([^"\`;]+)`, "g"))) {
		try { db.exec(`ALTER TABLE ${m[1]} ADD COLUMN ${m[2]}`); } catch { /* already there */ }
	}
	const hd = session("Driver", { driverName: HD, driver_name: HD, username: "hidden.driver" });
	const common = {
		requireRole: () => null, requireAuth: null, driverWriteLimiter: null, db, normalizeLoadId,
		getJobTrackingCached: async () => DJT, getDeletedLoadIds: () => new Set(), currentShownLoadIdIndex: () => DIDX,
		// The accept writes one status cell with values.update().
		getSheets: async () => {
			const api = await fakeSheets(DSHEET()).getSheets();
			api.spreadsheets.values.update = async () => ({ data: {} });
			return api;
		},
		SPREADSHEET_ID: "sheet-under-test",
		insertDispatchNotification: { run: (...a) => { stored.push(a); return { lastInsertRowid: stored.length }; } },
		insertNotification: { run: () => ({ lastInsertRowid: 1 }) },
		io: fakeIo(emitted), jtCacheInvalidate: () => {}, notifyChange: () => {}, logAudit: () => {}, recordStatusChange: () => {},
		dispatchWriteBlocker: () => null, resolveLoadBinding: () => null, require: realRequire, console: quietConsole(errors),
	};
	// Accept, then a status update.
	const respond = await lift('app.post("/api/driver/respond", requireRole("Super Admin", "Dispatcher", "Driver"), driverWriteLimiter, async (req, res) => {', common)(
		{ body: { loadId: "5550100163", rowIndex: H2_ROW, response: "accepted" }, session: hd });
	const status = await lift('app.put("/api/driver/status", requireRole("Super Admin", "Dispatcher", "Driver"), driverWriteLimiter, async (req, res) => {', common)(
		{ body: { loadId: "5550100163", rowIndex: H2_ROW, newStatus: "Heading to Shipper" }, session: hd });
	// A POD.
	const pdf = `data:application/pdf;base64,${Buffer.from("%PDF-1.4 a POD").toString("base64")}`;
	const pod = await lift('app.post("/api/documents/upload", requireRole("Super Admin", "Dispatcher", "Driver"), driverWriteLimiter, async (req, res) => {', {
		...common, fs: { existsSync: () => true, mkdirSync() {}, writeFileSync() {} }, DATA_DIR: path.join(ROOT, "no-such-dir"),
		setImmediate: () => {}, queueReceiptOcr: () => {},
	})({ body: { loadId: "5550100163", rowIndex: H2_ROW, docType: "POD", photoData: pdf, fileType: "document", fileName: "pod.pdf" }, session: hd });
	// A message about the load.
	const sent = await lift('app.post("/api/messages", requireAuth, driverWriteLimiter, (req, res) => {', common)(
		{ body: { from: HD, to: "Dispatch", message: "at the dock", loadId: "5550100163" }, session: hd });
	// A receipt on it (its 7-day window has its own runner).
	const receipt = await lift('app.post("/api/expenses", requireAuth, driverWriteLimiter, async (req, res) => {', {
		...common, geocodeAddress: async () => null, sentIfDriverExpenseWindowClosed: async () => false,
		// server.js destructures these from lib/expense-analytics.js: the shipped exports.
		...(({ EXPENSE_TYPES, normalizeVendor, normalizeVendorDetailed }) => ({ EXPENSE_TYPES, normalizeVendor, normalizeVendorDetailed }))(
			require(path.join(ROOT, "lib", "expense-analytics"))),
	})({ body: { driver: HD, loadId: "5550100163", type: "Toll", amount: 12, date: "2030-01-14", description: "Toll road" }, session: hd });
	check("T6: accept, status, POD, message and receipt answer 200, no error logged",
		[respond.code, status.code, pod.code, sent.code, receipt.code, errors], [200, 200, 200, 200, 200, []]);
	const events = ["load-accepted", "status-updated", "pod-uploaded", "new-message", "dispatch-notification"];
	const forStaff = events.flatMap((e) => toDispatchers(emitted, e));
	const forAdmins = events.flatMap((e) => toSuperAdmins(emitted, e));
	check("T6: each event and notice went to the rest of the dispatch room (the checks below are not vacuous)",
		events.map((e) => toDispatchers(emitted, e).length > 0), events.map(() => true));
	check("T6: nothing went to the whole dispatch room in one payload",
		events.map((e) => toWholeRoom(emitted, e).length), events.map(() => 0));
	check("T6: the rest of the dispatch room: no copy names the load as stored, and the POD's link is not in it",
		[hiddenIn(forStaff, ["5550100163"]), forStaff.some((p) => p && "driveUrl" in p)], [[], false]);
	check("T6: Super Admins: every event names the load as stored, the POD's with its link",
		[events.slice(0, 4).every((e) => hiddenIn(toSuperAdmins(emitted, e), ["5550100163"]).length > 0),
			toSuperAdmins(emitted, "pod-uploaded").some((p) => p && p.driveUrl)], [true, true]);
	check("T6: the notices are stored as before (in full)", hiddenIn(stored, ["5550100163"]).length > 0, true);
	// What a Dispatcher then reads.
	const read = (head, req) => lift(head, { requireRole: () => null, db, currentShownLoadIdIndex: () => DIDX, console: quietConsole(errors), require: realRequire })(req);
	const exp = await read('app.get("/api/expenses/all", requireRole("Super Admin", "Dispatcher"), (req, res) => {', { session: session("Dispatcher") });
	const msgs = await read('app.get("/api/messages", requireRole("Super Admin", "Dispatcher"), (req, res) => {', { session: session("Dispatcher") });
	const thread = await read('app.get("/api/messages/:driverName", requireRole("Super Admin", "Dispatcher"), (req, res) => {',
		{ params: { driverName: HD }, query: { loadId: WITHHELD_TEXT }, session: session("Dispatcher") });
	const adminExp = await read('app.get("/api/expenses/all", requireRole("Super Admin", "Dispatcher"), (req, res) => {', { session: session("Super Admin") });
	check("T6: a Dispatcher's reads: the receipt and the message list it (not vacuous), the thread opens by the shown text, none names the load as stored",
		[exp.code, ((exp.body || {}).expenses || []).length, ((msgs.body || {}).conversations || []).length, ((thread.body || {}).messages || []).length,
			hiddenIn([exp.body, msgs.body, thread.body], ["5550100163"])],
		[200, 1, 1, 1, []]);
	check("T6: a Super Admin's receipt list names the load as stored", hiddenIn(adminExp.body, ["5550100163"]).length > 0, true);
});

// ====================================================== §10 review Lows (PR 549)
// L1: the latest index is the newest read's, whatever order the reads finish in
// (a read that started before an invalidation never becomes the latest), and a
// route uses its own read's index (through liveJobTrackingView()), not the latest.
section("§10 L1: the latest index and a route's own read", async () => {
	const { closure } = require(path.join(ROOT, "scripts", "lib", "server-lift"));
	const provided = ["getSheets", "SPREADSHEET_ID", "getDeletedLoadIds", "require", "console"];
	const roots = ["getJobTrackingCached", "jtCacheInvalidate", "currentShownLoadIdIndex", "routeShownLoadIdIndex", "liveJobTrackingView"];
	const lifted = closure(SRC, { roots, provided });
	const reads = [];
	const getSheets = async () => ({ spreadsheets: { values: { get: () => new Promise((resolve) => reads.push(resolve)) } } });
	const api = new Function(...provided, `"use strict";\n${lifted.text}\nreturn { ${roots.join(", ")} };`)(
		getSheets, "sheet-under-test", () => new Set(), realRequire, quietConsole([]));
	const tick = () => new Promise((resolve) => setImmediate(resolve));
	const sheetOf = (rows) => ({ data: { values: [HEADERS.slice(), ...rows.map(cells)] } });
	const older = api.getJobTrackingCached();
	await tick();
	api.jtCacheInvalidate();
	const newer = api.getJobTrackingCached();
	await tick();
	// The newer read (H2: the row's own phone as its ID) finishes first, the older
	// one (a normal load only) after it.
	reads[1](sheetOf([H2]));
	const b = await newer;
	reads[0](sheetOf([N1]));
	const a = await older;
	const latest = api.currentShownLoadIdIndex();
	check("L1: an older read finishing after a newer one leaves the newer read's index as the latest",
		[reads.length, !!latest && !!latest.byKey.get("5550100163") && latest.byKey.get("5550100163").hidden, !!latest && latest.byKey.has("80000031")],
		[2, true, false]);
	const ownA = api.routeShownLoadIdIndex(api.liveJobTrackingView(a));
	check("L1: a route uses its own read's index (through liveJobTrackingView()), not the latest",
		[ownA !== latest, !!ownA && ownA.byKey.has("80000031"), api.routeShownLoadIdIndex(api.liveJobTrackingView(b)) === latest], [true, true, true]);
});

// L5: a notice's copy hands the index's own list over (its compiled pattern is
// reused), and a list with a load not read yet only when there is one.
section("§10 L5: the index's list is passed as is", async () => {
	const got = [];
	const staff = liftFunction("staffDispatchNotice", { brokerContact: { redactDispatchNotice: (n, opts) => { got.push(opts.hidden); return n; } } });
	const extra = [{ raw: "5550100166", shown: WITHHELD_TEXT }];
	staff({ title: "t" }, { index: HIDX });
	staff({ title: "t" }, { index: HIDX, extraHidden: extra });
	check("L5: no extra list: the index's own list; with one: both",
		[got[0] === (HIDX && HIDX.hidden), got[1] !== (HIDX && HIDX.hidden), (got[1] || []).length === ((HIDX && HIDX.hidden.length) || 0) + 1], [true, true, true]);
});

// L4: the rate con's own Load Number is told from a typed one by a copy that
// outlives the extract's (30 minutes, 200 entries): a Super Admin creating the
// load from a rate con whose number holds a phone, after the extract's copy is
// gone, is not refused.
section("§10 L4: the rate con's own number after the extract's copy is gone", async () => {
	const errors = [];
	const common = { requireRole: () => null, rateConLimiter: null, console: quietConsole(errors) };
	const answer = {
		"Load Number": "QA-555-010-0172", "Broker Name": "Pat Agent", "Broker Phone": "(555) 010-0142", "Broker Email": "agent.one@example.invalid",
		Rate: "$1,800.00", "Pickup Address": "100 Main St, Dallas, TX 75201", "Drop-off Address": "200 Oak Ave, Tulsa, OK 74103",
		"Pickup Appointment Time": "01/20/2030 08:00", "Delivery Appointment Time": "01/21/2030 14:00", Details: "Dry van",
	};
	const extract = lift('app.post("/api/loads/ratecon/extract", requireRole("Super Admin", "Dispatcher"), rateConLimiter, async (req, res) => {', {
		...common, GEMINI_API_KEY: "test-key", runRateConGemini: async () => ({ ...answer }), rateConNormalizeOptions: () => ({}),
		rateconNormalize: require(path.join(ROOT, "lib", "ratecon-normalize")), rateconLoad: require(path.join(ROOT, "lib", "ratecon-load")),
	});
	const tabs = { "Job Tracking": [HEADERS.slice()], "Payments Table": [[" Job ID", "Contract ID", "Payment Amount"]], "Job Details": [["Load ID", "Rate Per Mile", "Distance", "Details", "Payment"]] };
	const create = lift('app.post("/api/loads/from-ratecon", requireRole("Super Admin", "Dispatcher"), rateConLimiter, async (req, res) => {', {
		...common, getSheets: fakeTabs(tabs).getSheets, SPREADSHEET_ID: "sheet-under-test", rateconLoad: require(path.join(ROOT, "lib", "ratecon-load")),
		getDeletedLoadIds: () => new Set(), GOOGLE_MAPS_API_KEY: "", geocodeAddress: async () => null, appDay: () => "2030-01-19",
		validateOwnerIdCell: () => null, jtCacheInvalidate: () => {}, notifyChange: () => {}, logAudit: () => {},
		DATA_DIR: path.join(ROOT, "no-such-dir"), fs: { existsSync: () => true, mkdirSync() {}, writeFileSync() {} },
		db: emptyDb(), RATECON_DRIVE_FOLDER_ID: "", currentShownLoadIdIndex: () => null,
		insertDispatchNotification: { run: () => ({ lastInsertRowid: 1 }) }, io: fakeIo([]),
	});
	const pdfBase64 = Buffer.from("%PDF-1.4 the extract's copy expires").toString("base64");
	const served = await extract({ body: { pdfBase64 }, session: session("Super Admin") });
	// 200 other extracts since: the extract's own copy of this one is gone.
	for (let i = 0; i < 205; i++) bcLib.rateConStash.put(`evicting-${i}`, {});
	const gone = bcLib.rateConStash.get(bcLib.rateConStashKey(pdfBase64));
	const made = await create({ body: { fields: (served.body || {}).fields || {}, pdfBase64 }, session: session("Super Admin") });
	check("L4: the extract's copy is gone (the check below is not vacuous)", [served.code, gone], [200, null]);
	check("L4: a Super Admin's create with the rate con's own phone-shaped number: 200, created under it",
		[made.code, (made.body || {}).loadId, (tabs["Job Tracking"][1] || [])[HEADERS.indexOf("Load ID")]], [200, "QA-555-010-0172", "QA-555-010-0172"]);
	check("L4: no error logged", errors, []);
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
