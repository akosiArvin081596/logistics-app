#!/usr/bin/env node
// Per-load miles: lib/load-miles.js, getLoadMilesIndex() and the two readers
// that use it (GET /api/investor, GET /api/financials), plus
// syncLoadRateconMiles(), which stores the rate-con's road miles it ranks.
//
// WHY THIS EXISTS. Both handlers built `milesByLoadId` from load_coordinates
// keyed by the stored load_id lowercased and looked it up by the sheet's Load
// ID cell lowercased. Every load_coordinates writer stores the NORMALISED key,
// so a Load ID cell reading "#123" found nothing and the load counted 0 miles.
// And only the cached road distance or a straight line was ever used, while the
// ELD-measured miles (load_eld_miles) and the road miles rate-con ingestion had
// already computed (Job Details' Distance) sat unread. Pinned here:
//   1. one key: "#123", "123" and " 123 " are one load, in both handlers;
//   2. precedence eld > ratecon > road > straight_line, and only a final,
//      fully observed ELD leg counts as 'eld';
//   3. the rate-con miles are READ from Job Details ("1,234 Miles"), matched by
//      lane and rate because that tab has no Load ID, and never recomputed:
//      nothing here can reach a Google Maps call;
//   4. both handlers keep the field shapes they answered with before.
//
// The handlers' miles blocks, getLoadMilesIndex() and syncLoadRateconMiles()
// are lifted verbatim from server.js and run against an in-memory SQLite.
// SERVER_JS=<path> runs them from another copy of server.js.
//
// No network, no sheet, no app.db, no server.
//
//   node scripts/test-load-miles.js      # exits 1 on any failure

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const geolib = require("geolib");
const loadMilesLib = require("../lib/load-miles");
const brokerInvoice = require("../lib/broker-invoice");

const SHIPPED = fs.readFileSync(process.env.SERVER_JS || path.join(__dirname, "..", "server.js"), "utf8");

let pass = 0;
let fail = 0;
function check(label, actual, expected) {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) { pass++; return; }
	fail++;
	console.error(`FAIL  ${label}\n        expected ${e}\n        actual   ${a}`);
}
// A missing piece of shipped code is a failure of that section, not a crash.
function lift(re, label) {
	const all = [...SHIPPED.matchAll(re)];
	if (all.length !== 1) {
		fail++;
		console.error(`FAIL  ${label}: expected exactly one definition in server.js, found ${all.length}`);
		return null;
	}
	return all[0][0];
}
function handlerBody(path) {
	const start = SHIPPED.indexOf(`\napp.get("${path}",`);
	if (start === -1) throw new Error(`no app.get("${path}"`);
	return SHIPPED.slice(start, SHIPPED.indexOf("\n});\n", start) + 5);
}
const MAPS_CALL_RE = /getRoute\s*\(|geocodeAddress\s*\(|distancematrix|routes\.googleapis|maps\.googleapis|GOOGLE_MAPS_API_KEY|\bfetch\s*\(/i;

// ===========================================================================
// §1 lib/load-miles.js, pure
// ===========================================================================
console.log("§1 lib/load-miles.js");
{
	const k = loadMilesLib.loadMilesKey;
	check("§1.1 one key for #123, 123 and ' 123 '", [k("#123"), k("123"), k(" 123 "), k(" #ABC-9 ")], ["123", "123", "123", "abc-9"]);
	check("§1.2 ...the same rule as normalizeLoadId()", k("#540935268"), require("../lib/ratecon-load").normalizeLoadId("#540935268"));

	const p = loadMilesLib.parseMilesCell;
	check("§1.3 Distance cells as ingestion writes them",
		[p("486 Miles"), p("1,234 Miles"), p("486Miles"), p("486 mi"), p("12.5 miles"), p(486), p(" 2,401 Miles ")],
		[486, 1234, 486, 486, 12.5, 486, 2401]);
	check("§1.4 '0 Miles' (the Distance Matrix could not answer) and non-figures read as null",
		[p("0 Miles"), p("N/A"), p(""), p(null), p("Distance unavailable"), p("-5 Miles"), p("1,23 Miles"), p("9".repeat(40))],
		[null, null, null, null, null, null, null, null]);

	const c = loadMilesLib.paymentCents;
	check("§1.5 payment cells to cents", [c(" $ 2,000.00 "), c("$1,500.00"), c(1500), c("1500"), c(""), c("TBD")], [200000, 150000, 150000, 150000, null, null]);

	const lane = loadMilesLib.laneKey;
	check("§1.6 the lane exactly as calculateRatePerMile() writes Details",
		lane("4528 W Royal Ln\nIrving, TX 75063", "818 Hallmark Dr, LAREDO, TX 78045"), "irving, tx 75063 - laredo, tx 78045");
	check("§1.7 no lane without both ends", [lane("", "Laredo, TX 78045"), lane("Irving, TX 75063", "  ")], ["", ""]);

	// Job Details as the Sheets API returns it: column A's header is blank, the
	// retired `output` column sits at the end.
	const JD = {
		headers: ["", "Rate Per Mile", "Distance", "Details", "Payment", "output (retired 2026-08-09 — n8n AI Agent, do not reuse)"],
		rows: [
			["", "$2.06", "486 Miles", "Irving, TX 75063 - Laredo, TX 78045", "1000", ""],
			["", "$1.50", "1,000 Miles", "Tulsa, OK 74134 - Joplin, MO 64803", "1500", ""],
			["", "$1.40", "1,070 Miles", "Tulsa, OK 74134 - Joplin, MO 64803", "1500", ""], // same lane AND rate, different figure
			["", "$2.00", "500 Miles", "Dallas, TX 75201 - Austin, TX 78701", "1000", ""],
			["", "$2.10", "476 Miles", "Dallas, TX 75201 - Austin, TX 78701", "1000", ""],
			["", "$1.80", "200 Miles", "Dallas, TX 75201 - Austin, TX 78701", "360", ""],
			["", "$0", "0 Miles", "Distance unavailable", "900", ""],
			["", "", "", "", "", "{\"output\":{\"distance\":640}}"], // the junk rows: no Distance
		],
	};
	const loads = [
		{ key: "100", pickupAddress: "4528 W Royal Ln\nIrving, TX 75063", dropoffAddress: "818 Hallmark Dr\nLaredo, TX 78045", payment: "$1,000.00" },
		{ key: "101", pickupAddress: "Irving, TX 75063", dropoffAddress: "Laredo, TX 78045", payment: "$1,250.00" }, // rate edited
		{ key: "200", pickupAddress: "1 Main, Tulsa, OK 74134", dropoffAddress: "2 Elm, Joplin, MO 64803", payment: "1500" },
		{ key: "300", pickupAddress: "Dallas, TX 75201", dropoffAddress: "Austin, TX 78701", payment: "$360.00" },
		{ key: "301", pickupAddress: "Dallas, TX 75201", dropoffAddress: "Austin, TX 78701", payment: "$999.00" },
		{ key: "400", pickupAddress: "Nowhere, KS 66002", dropoffAddress: "Austin, TX 78701", payment: "$1,000.00" },
		{ key: "500", pickupAddress: "", dropoffAddress: "Austin, TX 78701", payment: "$1,000.00" },
		{ key: "100", pickupAddress: "x", dropoffAddress: "y", payment: "1" }, // a duplicate key is read once
	];
	const { matches, counts } = loadMilesLib.matchRateconMiles(JD, loads);
	check("§1.8 lane + rate finds the row this load's ingestion wrote", matches.get("100"), { miles: 486, match: "lane_payment" });
	check("§1.9 a rate edited since ingestion falls back to the lane, when every row on it agrees", matches.get("101"), { miles: 486, match: "lane" });
	check("§1.10 rows that disagree give no figure", matches.has("200"), false);
	check("§1.11 the rate picks one row out of a lane that disagrees", matches.get("300"), { miles: 200, match: "lane_payment" });
	check("§1.12 ...and without a matching rate, a disagreeing lane gives none", matches.has("301"), false);
	check("§1.13 no match, no lane", [matches.has("400"), matches.has("500")], [false, false]);
	check("§1.14 tallies", counts, { lane_payment: 2, lane: 1, ambiguous: 2, no_match: 1, no_lane: 1 });
	check("§1.15 a tab without Distance/Details matches nothing",
		loadMilesLib.matchRateconMiles({ headers: ["", "output"], rows: [["", "x"]] }, loads).matches.size, 0);

	// Precedence.
	const coords = (id, distance) => ({ load_id: id, origin_lat: 29.76, origin_lng: -95.37, dest_lat: 32.78, dest_lng: -96.8, distance_miles: distance });
	const straight = geolib.getDistance({ latitude: 29.76, longitude: -95.37 }, { latitude: 32.78, longitude: -96.8 }) / 1609.344;
	const index = loadMilesLib.buildLoadMilesIndex({
		eldRows: [
			{ load_id: "1", loaded_miles: 240.5, deadhead_miles: 31, loaded_basis: "eld", in_progress: 0 },
			{ load_id: "2", loaded_miles: 120, deadhead_miles: null, loaded_basis: "eld", in_progress: 1 },      // still running
			{ load_id: "3", loaded_miles: 90, deadhead_miles: null, loaded_basis: "partial", in_progress: 0 },  // dropped deltas
			{ load_id: "4", loaded_miles: null, deadhead_miles: 50, loaded_basis: "no-data", in_progress: 0 },  // never resolved
			{ load_id: "5", loaded_miles: 0, deadhead_miles: 0, loaded_basis: "eld", in_progress: 0 },
		],
		rateconRows: [{ load_id: "1", miles: 250 }, { load_id: "2", miles: 260 }, { load_id: "6", miles: 300 }],
		coordRows: [coords("1", 255), coords("2", 265), coords("3", 270), coords("4", null), coords("5", 0), coords("#7", 0), coords("7", 280)],
	});
	const pick = (id) => { const e = index.get(id); return e && [e.source, Math.round(e.miles * 10) / 10]; };
	check("§1.16 a final, fully observed ELD leg wins", index.get("1"), { miles: 240.5, loadedMiles: 240.5, deadheadMiles: 31, source: "eld" });
	check("§1.17 a running load falls through to the rate-con miles", pick("2"), ["ratecon", 260]);
	check("§1.18 a partial leg falls through to the cached road distance", pick("3"), ["road", 270]);
	check("§1.19 an unresolved leg, no road distance: straight line", pick("4"), ["straight_line", Math.round(straight * 10) / 10]);
	check("§1.20 a zero ELD leg is not a figure", pick("5"), ["straight_line", Math.round(straight * 10) / 10]);
	check("§1.21 rate-con miles alone", index.get("6"), { miles: 300, loadedMiles: 300, deadheadMiles: null, source: "ratecon" });
	check("§1.22 '#7' and '7' are one load; the better source wins", pick("7"), ["road", 280]);
	check("§1.23 source counts", loadMilesLib.milesSourceCounts(index), { eld: 1, ratecon: 2, road: 2, straight_line: 2 });
	const same = loadMilesLib.buildLoadMilesIndex({ coordRows: [coords("8", 111), coords("#8", 222)] });
	const swapped = loadMilesLib.buildLoadMilesIndex({ coordRows: [coords("#8", 222), coords("8", 111)] });
	check("§1.24 at equal rank the row stored under the normalised key wins, in either order", [same.get("8").miles, swapped.get("8").miles], [111, 111]);

	const lookup = loadMilesLib.fillMilesLookup(Object.create(null), index);
	check("§1.25 the lookup answers the key and '#'+key", [lookup["1"], lookup["#1"], lookup["6"], lookup["#6"]], [240.5, 240.5, 300, 300]);
	const clash = loadMilesLib.fillMilesLookup(Object.create(null), new Map([["#9", { miles: 5 }], ["9", { miles: 7 }]]));
	check("§1.26 an alias never overwrites a key a load is really stored under", [clash["#9"], clash["9"]], [5, 7]);
}

// ===========================================================================
// §2 GET /api/investor and GET /api/financials: their miles blocks, as shipped
// ===========================================================================
console.log("§2 the two handlers' per-load miles");
const DDL = `
	CREATE TABLE load_coordinates (load_id TEXT PRIMARY KEY, origin_lat REAL, origin_lng REAL, dest_lat REAL, dest_lng REAL,
		pickup_address TEXT NOT NULL DEFAULT '', dropoff_address TEXT NOT NULL DEFAULT '', distance_miles REAL);
	CREATE TABLE load_eld_miles (load_id TEXT PRIMARY KEY, loaded_miles REAL, deadhead_miles REAL, total_miles REAL,
		loaded_basis TEXT DEFAULT 'no-data', in_progress INTEGER DEFAULT 0);
`;
const RATECON_DDL = lift(/CREATE TABLE IF NOT EXISTS load_ratecon_miles \([\s\S]*?\n\t\)/g, "load_ratecon_miles DDL");
function seededDb() {
	const db = new Database(":memory:");
	db.exec(DDL);
	if (RATECON_DDL) db.exec(RATECON_DDL);
	const c = db.prepare("INSERT INTO load_coordinates (load_id, origin_lat, origin_lng, dest_lat, dest_lng, distance_miles) VALUES (?, ?, ?, ?, ?, ?)");
	// Every writer stores the normalised key; a Load ID cell may still read "#123".
	c.run("123", 29.76, -95.37, 32.78, -96.8, null);      // straight line only
	c.run("456", 29.76, -95.37, 32.78, -96.8, 300);       // cached road distance...
	c.run("#789", 29.76, -95.37, 32.78, -96.8, 200);      // an old raw-keyed row
	c.run("555", 29.76, -95.37, 32.78, -96.8, 250);
	const e = db.prepare("INSERT INTO load_eld_miles (load_id, loaded_miles, deadhead_miles, loaded_basis, in_progress) VALUES (?, ?, ?, ?, ?)");
	e.run("456", 310.4, 22, "eld", 0);                     // ...beaten by what the truck drove
	e.run("555", 260, null, "eld", 1);                     // still running: not a figure yet
	if (RATECON_DDL) db.prepare("INSERT INTO load_ratecon_miles (load_id, miles, match) VALUES (?, ?, ?)").run("321", 512, "lane_payment");
	return db;
}
const getLoadMilesIndexSrc = lift(/\nfunction getLoadMilesIndex\([\s\S]*?\n}\n/g, "getLoadMilesIndex");
const CELLS = ["#123", "123", "#456", "456", "321", "#321", "#789", "789", "555"];
// GET /api/financials reads its per-load miles through the report (the books'
// revenue items, keyed by loadMilesKey() into getLoadMilesIndex()), so it has no
// per-row lookup of its own.
{
	const fin = handlerBody("/api/financials");
	const report = lift(/\nasync function buildFinancialsReport\([\s\S]*?\n}\n/g, "buildFinancialsReport") || "";
	check("§2 GET /api/financials: miles come from the report, not a per-row lookup",
		[/milesByLoadId/.test(fin), /buildFinancialsReport\(/.test(fin), /getLoadMilesIndex\(\)/.test(fin)], [false, true, true]);
	check("§2 buildFinancialsReport: each load's miles from getLoadMilesIndex(), keyed by loadMilesKey()",
		[/getLoadMilesIndex\(\)/.test(report), /loadMilesLib\.loadMilesKey\(/.test(report)], [true, true]);
}
for (const [label, route] of [["GET /api/investor", "/api/investor"]]) {
	const body = handlerBody(route);
	const from = body.indexOf("// ---- Miles source:");
	const to = body.indexOf("// ---- Single-pass", from);
	const block = from === -1 || to === -1 ? "" : body.slice(from, to);
	check(`§2 ${label}: the miles block is found`, block.length > 0, true);
	// The handler's own per-row lookup, evaluated exactly as written.
	const lookups = [...body.matchAll(/const loadMiles = (milesByLoadId\[[^\]\n]+\]) \|\| 0;/g)].map((m) => m[1]);
	check(`§2 ${label}: one per-row lookup into milesByLoadId`, lookups.length, 1);
	if (!block || lookups.length !== 1) continue;
	const db = seededDb();
	let world;
	try {
		const exposed = /roadMilesCount/.test(block) ? "milesByLoadId, roadMilesCount, haversineMilesCount" : "milesByLoadId";
		world = new Function("db", "geolib", "loadMilesLib", `${getLoadMilesIndexSrc || ""}\n${block}\nreturn { ${exposed} };`)(db, geolib, loadMilesLib);
	} catch (err) {
		fail++;
		console.error(`FAIL  §2 ${label}: the miles block throws: ${err.message}`);
		continue;
	}
	const read = new Function("milesByLoadId", "lid", `return (${lookups[0]}) || 0;`);
	const miles = (cell) => Math.round(read(world.milesByLoadId, String(cell).trim()) * 10) / 10;
	const straight = Math.round(geolib.getDistance({ latitude: 29.76, longitude: -95.37 }, { latitude: 32.78, longitude: -96.8 }) / 160.9344) / 10;
	check(`§2 ${label}: "#123", "123" and " 123 " are one load`, [miles("#123"), miles("123"), miles(" 123 ")], [straight, straight, straight]);
	check(`§2 ${label}: what the truck drove beats the cached road distance`, [miles("#456"), miles("456")], [310.4, 310.4]);
	check(`§2 ${label}: the rate-con's stored road miles count for a load with no coordinates`, [miles("321"), miles("#321")], [512, 512]);
	check(`§2 ${label}: an old raw-keyed row answers both spellings`, [miles("#789"), miles("789")], [200, 200]);
	check(`§2 ${label}: a running ELD leg is not used; the road distance is`, miles("555"), 250);
	check(`§2 ${label}: milesByLoadId is still a null-prototype object`, Object.getPrototypeOf(world.milesByLoadId), null);
	if ("roadMilesCount" in world) {
		check(`§2 ${label}: milesSource counts keep their shape (measured vs straight-line)`,
			[world.roadMilesCount, world.haversineMilesCount], [4, 1]);
	}
	check(`§2 ${label}: every Load ID cell found its miles`, CELLS.filter((cell) => !(miles(cell) > 0)), []);
}

// ===========================================================================
// §3 syncLoadRateconMiles(): read Job Details, store, never call Maps
// ===========================================================================
console.log("§3 syncLoadRateconMiles()");
(async () => {
	const syncSrc = lift(/\nlet loadRateconMilesSyncRunning = [^\n]*\n/g, "sync running flag");
	const syncFn = lift(/\nasync function syncLoadRateconMiles\([\s\S]*?\n}\n/g, "syncLoadRateconMiles");
	check("§3.1 the sync never calls Google Maps", syncFn ? MAPS_CALL_RE.test(syncFn) : true, false);
	check("§3.2 getLoadMilesIndex never calls Google Maps", getLoadMilesIndexSrc ? MAPS_CALL_RE.test(getLoadMilesIndexSrc) : true, false);
	check("§3.3 lib/load-miles.js never calls Google Maps (and requires nothing impure)",
		[MAPS_CALL_RE.test(fs.readFileSync(path.join(__dirname, "..", "lib", "load-miles.js"), "utf8")),
			[...fs.readFileSync(path.join(__dirname, "..", "lib", "load-miles.js"), "utf8").matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1])],
		[false, ["geolib", "./ratecon-load"]]);
	if (!syncSrc || !syncFn || !RATECON_DDL) {
		console.log(`\n${pass} passed, ${fail} failed`);
		process.exit(1);
	}
	const findCol = lift(/\nfunction findCol\([\s\S]*?\n}\n/g, "findCol");
	const pickAddressColumn = lift(/\nfunction pickAddressColumn\([\s\S]*?\n}\n/g, "pickAddressColumn");
	const HEADERS = ["Load ID", "Pickup Company Information", "Pickup Address", "Drop-off Address", "Job Status", "  Payment  "];
	const jtRow = (id, pu, dz, status, pay) => ({ "Load ID": id, "Pickup Company Information": "REF/PU#: 1", "Pickup Address": pu, "Drop-off Address": dz, "Job Status": status, "  Payment  ": pay });
	let jtRows = [
		jtRow("#100", "4528 W Royal Ln\nIrving, TX 75063", "818 Hallmark Dr\nLaredo, TX 78045", "Delivered", "$1,000.00"),
		jtRow("200", "Dallas, TX 75201", "Austin, TX 78701", "Delivered", "$360.00"),
		jtRow("300", "Nowhere, KS 66002", "Austin, TX 78701", "Delivered", "$700.00"),
		jtRow("400", "Irving, TX 75063", "Laredo, TX 78045", "Cancelled", "$1,000.00"),
	];
	const jdValues = [
		["", "Rate Per Mile", "Distance", "Details", "Payment", "output (retired 2026-08-09 — n8n AI Agent, do not reuse)"],
		["", "$2.06", "486 Miles", "Irving, TX 75063 - Laredo, TX 78045", "1000", ""],
		["", "$1.80", "200 Miles", "Dallas, TX 75201 - Austin, TX 78701", "360", ""],
		["", "", "", "", "", "{\"output\":{}}"],
	];
	const db = new Database(":memory:");
	db.exec(RATECON_DDL);
	db.prepare("INSERT INTO load_ratecon_miles (load_id, miles, match) VALUES (?, ?, ?)").run("300", 999, "lane");   // a lane edited away
	db.prepare("INSERT INTO load_ratecon_miles (load_id, miles, match) VALUES (?, ?, ?)").run("900", 123, "lane");   // not on the sheet
	let sheetReads = [];
	let mapsCalls = 0;
	const logs = [];
	const deps = {
		db, loadMilesLib, brokerInvoice, SPREADSHEET_ID: "test-sheet",
		getJobTrackingCached: async () => ({ headers: [...HEADERS], data: jtRows.map((r) => ({ ...r })) }),
		liveJobTrackingView: (jt) => ({ ...jt, data: jt.data.filter((r) => r["Job Status"] !== "Cancelled") }),
		getSheets: async () => ({ spreadsheets: { values: { get: async ({ range }) => { sheetReads.push(range); return { data: { values: jdValues } }; } } } }),
		getRoute: () => { mapsCalls++; throw new Error("no Maps call may be made"); },
		geocodeAddress: () => { mapsCalls++; throw new Error("no Maps call may be made"); },
		fetch: () => { mapsCalls++; throw new Error("no network call may be made"); },
		console: { log: (s) => logs.push(String(s)), error: (s, e) => logs.push(`ERR ${s} ${e || ""}`) },
	};
	const names = Object.keys(deps);
	const sync = new Function(...names, `${findCol}${pickAddressColumn}${syncSrc}${syncFn}\nreturn syncLoadRateconMiles;`)(...names.map((n) => deps[n]));
	const rows = () => db.prepare("SELECT load_id, miles, match FROM load_ratecon_miles ORDER BY load_id").all().map((r) => [r.load_id, r.miles, r.match]);

	const first = await sync();
	check("§3.4 reads Job Details once (Job Tracking comes from the cache)", sheetReads, ["Job Details"]);
	check("§3.5 stores each matched load's miles under its normalised key; drops a figure whose lane moved; leaves loads off the sheet alone",
		rows(), [["100", 486, "lane_payment"], ["200", 200, "lane_payment"], ["900", 123, "lane"]]);
	check("§3.6 a cancelled load is not matched", rows().some((r) => r[0] === "400"), false);
	check("§3.7 tallies", [first.loads, first.written, first.removed, first.lane_payment, first.no_match], [3, 2, 1, 2, 1]);
	check("§3.8 no Maps call", mapsCalls, 0);
	check("§3.9 nothing went wrong", logs.filter((l) => l.startsWith("ERR")), []);

	const again = await sync();
	check("§3.10 a second run changes nothing", [again.written, again.removed, rows().length], [0, 0, 3]);

	jtRows = jtRows.map((r) => (r["Load ID"] === "200" ? { ...r, "Drop-off Address": "Waco, TX 76701" } : r));
	await sync();
	check("§3.11 a lane edited after ingestion loses the old lane's figure", rows().some((r) => r[0] === "200"), false);

	deps.getSheets = null;
	const broken = new Function(...names, `${findCol}${pickAddressColumn}${syncSrc}${syncFn}\nreturn syncLoadRateconMiles;`)(
		...names.map((n) => (n === "getSheets" ? async () => { throw new Error("Sheets is down"); } : deps[n])));
	const before = rows();
	const down = await broken();
	check("§3.12 a failed Job Details read writes nothing", [Boolean(down.error), rows()], [true, before]);

	console.log(`\n${pass} passed, ${fail} failed`);
	process.exit(fail ? 1 : 0);
})().catch((err) => {
	console.error("crashed:", err);
	process.exit(1);
});
