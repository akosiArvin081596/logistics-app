// The made-up world behind scripts/test-deleted-load-restore-what-would-change.js and its parity runner: one
// delete per case scripts/deleted-load-restore-what-would-change.js sorts, each answer worked out by hand below.
// Every load, person, place, amount and reason is made up. It writes only under the folder it is given: a
// database built from every CREATE TABLE in server.js (scripts/lib/work-days-world.js schemaDb()), with the
// row_digests column #754 adds, a saved values.get of Job Tracking, and a settings file for the copy.
//
// Two variants:
//   "base"   the day before the switch-on: the flag off, no delete with recorded rows, nothing told yet;
//   "after"  the after-check: the flag on, a hidden and a hidden_closed notice stored, one audited restore
//            (record 2 is gone), and one new delete (record 22) whose recorded row has changed since.
// Creates are dated from `now`, so the report's 90-day window holds them whenever the runner runs.

"use strict";

const fs = require("fs");
const path = require("path");
const { schemaDb } = require("./work-days-world");
const restoreLib = require("../../lib/deleted-load-restore");

const DAY = 24 * 3600 * 1000;
const HEADERS = ["Load ID", "Driver", "Job Status", "Pickup Address", "Pickup Appointment", "Drop-off Address", "Drop-off Appointment",
	"Assigned Date", "Status Update Date", "Completion Date", "Payment", "Broker Contact Name"];
// What the report must never print: each is planted in the world below.
const PLANTED = [/MU-DLR-\d{4}/i, /made-up-admin/i, /made-up-dispatcher/i, /Made-up Driver/i, /Made-up (Pickup|Drop|Original)/i,
	/Made-up Broker/i, /\$\d/, /Made-up reason/i, /made-up-rc-/i, /made-up-setting-value/i];
const REASON = "Made-up reason RSN-0042";

// Job Tracking, from row 2: [row, Load ID, status, day, extra cells]. The day is the Assigned Date and both
// appointments; mid-month, so no clock's zone moves a row into another month.
const ROWS = [
	[2, "MU-DLR-0001", "Delivered", "2026-10-05"], // a live load no delete names
	[3, "MU-DLR-0102", "Cancelled", "2026-10-06"], // record 2: its only row is cancelled
	[4, "MU-DLR-0103", "Dispatched", "2026-10-12"], // record 3: a row that came after a delete that found none
	[5, "MU-DLR-0104", "In Transit", "2026-10-14"], // record 4: an older delete with no row number (P1)
	[6, "MU-DLR-0105", "Delivered", "2026-08-11"], // record 5: the same, in a closed month (1b)
	[7, "MU-DLR-0106", "Dispatched", "2026-11-07"], // record 6: its dates moved to another open month (P1)
	[8, "MU-DLR-0107", "Delivered", "2026-10-08"], // record 7: two live rows in the month it names (1c, P2)
	[9, "MU-DLR-0108", "Delivered", "2026-10-09"], // record 8: none at its stored row number (1c, P2)
	[10, "MU-DLR-0109", "Delivered", "2026-09-15"], // record 9: its own row, in a closed month
	[11, "MU-DLR-0110", "Delivered", "2026-09-07"], // record 10: moved, but into a closed month (1b)
	[12, "MU-DLR-0111", "Dispatched", "TBD"], // record 11: dates that give no month
	[13, "MU-DLR-0112", "Dispatched", "2026-11-06"], // records 12 and 13: one load deleted twice
	[14, "MU-DLR-0113", "Dispatched", "2026-10-18"], // record 14: a Dispatcher's rate con after the delete
	[15, "MU-DLR-0114", "Dispatched", "2026-11-08"], // record 15: a Super Admin's New Job after it
	[16, "MU-DLR-0115", "Dispatched", "2026-11-09"], // record 16: n8n after it, and in another month
	[17, "MU-DLR-0116", "Dispatched", "2026-10-21"], // record 17: the live copy the dedupe drops
	[18, "MU-DLR-0117", "Delivered", "2026-10-23"], // record 18: a rate con after it, outside 90 days
	[19, "MU-DLR-0118", "Delivered", "2026-10-22"], // record 19: a rate con before its delete
	[20, "MU-DLR-0119", "Delivered", "2026-08-07"], // record 20: no audit row, in a closed month (1c)
	[21, "MU-DLR-0120", "Delivered", "2026-10-24"], // record 21: an audit row that names no month (1c)
	[22, "", "Delivered", "2026-10-07"], // no Load ID
	[23, "MU-DLR-0109", "Dispatched", "2026-10-16"], // record 9: a new row in an open month
	[24, "MU-DLR-0107", "Dispatched", "2026-10-20"], // record 7: its second row (the dedupe keeps this one)
	[25, "#MU-DLR-0116", "Cancelled", "2026-10-21"], // record 17: the bottom copy, cancelled (the dedupe keeps it)
	[26, "MU-DLR-0002", "Dispatched", "2026-11-06"], // a live load no delete names
];
const AFTER_ROWS = [[27, "MU-DLR-0121", "Dispatched", "2026-11-10"]]; // record 22
// Record 22's row as its delete recorded it, before its pickup changed.
const RECORDED_ROW_22 = { "Pickup Address": "Made-up Original Yard 27, Testville, IL" };

function cellsOf([n, loadId, status, day], extra = {}) {
	const cells = {
		"Load ID": loadId, Driver: `Made-up Driver Q${n}`, "Job Status": status,
		"Pickup Address": `Made-up Pickup Yard ${n}, Testville, IL`, "Pickup Appointment": day,
		"Drop-off Address": `Made-up Drop Dock ${n}, Sampleton, IN`, "Drop-off Appointment": day,
		"Assigned Date": day, "Status Update Date": "", "Completion Date": "",
		Payment: `$${7000 + n}.${String(n).padStart(2, "0")}`, "Broker Contact Name": `Made-up Broker Agent ${n}`,
		...extra,
	};
	return cells;
}
const valuesOf = (rows) => [HEADERS, ...rows.map((r) => HEADERS.map((h) => cellsOf(r)[h]))];

const at = (stamp) => Date.parse(`${stamp.replace(" ", "T")}Z`);
const sqlStamp = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
const isoStamp = (ms) => new Date(ms).toISOString();
const months = (m) => `settlement month${m.includes(",") ? "s" : ""} ${m}`;
const deleteText = (id, row, tail) => `Soft-deleted load ${id}${row ? ` (sheet row ${row})` : ""}${tail}. Reversible: DELETE FROM deleted_loads WHERE load_id = '${id.toLowerCase()}'`;
const NO_ROW = " — no matching Job Tracking row";

// The deletes: [record, Load ID, stored row number, deleted at (ms), deleted by, delete_load audit text or null].
function deletesOf(now) {
	const ago = (days) => now - days * DAY;
	return [
		[1, "MU-DLR-0101", 0, at("2026-09-02 14:00:00"), "made-up-admin-a1", deleteText("MU-DLR-0101", 0, NO_ROW)],
		[2, "MU-DLR-0102", 3, at("2026-10-07 14:00:00"), "made-up-admin-a1", deleteText("MU-DLR-0102", 3, ` — ${months("2026-10")}`)],
		[3, "MU-DLR-0103", 0, at("2026-09-10 14:00:00"), "made-up-admin-a2", deleteText("MU-DLR-0103", 0, NO_ROW)],
		[4, "MU-DLR-0104", 0, at("2026-06-15 14:00:00"), "made-up-admin-a2", null],
		[5, "MU-DLR-0105", 0, at("2026-07-20 14:00:00"), "made-up-admin-a1", null],
		[6, "MU-DLR-0106", 7, at("2026-10-03 14:00:00"), "made-up-admin-a1", deleteText("MU-DLR-0106", 7, ` — ${months("2026-10")}`)],
		[7, "MU-DLR-0107", 8, at("2026-10-22 14:00:00"), "made-up-admin-a2", deleteText("MU-DLR-0107", 8, ` — ${months("2026-10")}`)],
		[8, "MU-DLR-0108", 77, at("2026-10-10 14:00:00"), "made-up-admin-a1", deleteText("MU-DLR-0108", 77, ` — ${months("2026-10")}`)],
		[9, "MU-DLR-0109", 10, at("2026-09-20 14:00:00"), "made-up-admin-a2", deleteText("MU-DLR-0109", 10, ` — ${months("2026-09")}`)],
		[10, "MU-DLR-0110", 11, at("2026-08-25 14:00:00"), "made-up-admin-a1", deleteText("MU-DLR-0110", 11, ` — ${months("2026-08")}`)],
		[11, "MU-DLR-0111", 0, at("2026-09-12 14:00:00"), "made-up-admin-a2", deleteText("MU-DLR-0111", 0, NO_ROW)],
		[12, "MU-DLR-0112", 0, at("2026-07-01 14:00:00"), "made-up-admin-a1", null],
		[13, "MU-DLR-0112", 13, at("2026-11-08 14:00:00"), "made-up-admin-a2", deleteText("MU-DLR-0112", 13, ` — ${months("2026-11")}`)],
		[14, "MU-DLR-0113", 14, ago(30), "made-up-admin-a1", deleteText("MU-DLR-0113", 14, ` — ${months("2026-10")}`)],
		[15, "MU-DLR-0114", 0, ago(25), "made-up-admin-a2", deleteText("MU-DLR-0114", 0, NO_ROW)],
		[16, "MU-DLR-0115", 16, ago(20), "made-up-admin-a1", deleteText("MU-DLR-0115", 16, ` — ${months("2026-10")}`)],
		[17, "MU-DLR-0116", 0, at("2026-10-23 14:00:00"), "made-up-admin-a2", deleteText("MU-DLR-0116", 0, NO_ROW)],
		[18, "MU-DLR-0117", 18, ago(140), "made-up-admin-a1", deleteText("MU-DLR-0117", 18, ` — ${months("2026-10")}`)],
		[19, "MU-DLR-0118", 19, ago(40), "made-up-admin-a2", deleteText("MU-DLR-0118", 19, ` — ${months("2026-10")}`)],
		[20, "MU-DLR-0119", 20, at("2026-07-10 14:00:00"), "made-up-admin-a1", null],
		[21, "MU-DLR-0120", 21, at("2026-09-25 14:00:00"), "made-up-admin-a2", deleteText("MU-DLR-0120", 21, "")],
	];
}

// Builds the world in `dir` and answers its files. `digests: false` leaves out the row_digests column (a
// database #754's deploy hasn't reached).
function buildWorld({ dir, now = Date.now(), variant = "base", digests = true }) {
	if (!["base", "after"].includes(variant)) throw new Error(`no world variant ${variant}`);
	const after = variant === "after";
	const ago = (days) => now - days * DAY;
	fs.mkdirSync(dir, { recursive: true });
	const db = schemaDb();
	if (digests) restoreLib.ensureSchema(db);
	const audit = db.prepare("INSERT INTO audit_trail (timestamp, user_id, username, role, action, entity, entity_id, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
	const notice = db.prepare("INSERT INTO dispatch_notifications (type, title, body, metadata, created_at) VALUES (?, ?, ?, ?, ?)");
	const tomb = db.prepare("INSERT INTO deleted_loads (id, load_id, row_index, deleted_at, deleted_by) VALUES (?, ?, ?, ?, ?)");

	for (const [id, loadId, row, ms, by, text] of deletesOf(now)) {
		if (after && id === 2) continue;
		tomb.run(id, loadId.toLowerCase(), row, sqlStamp(ms), by);
		if (text) audit.run(isoStamp(ms + 250), by === "made-up-admin-a1" ? 1 : 2, by, "Super Admin", "delete_load", "load", loadId.toLowerCase(), text);
		notice.run("load-deleted", `Deleted Load ${loadId}`, `Removed by ${by}`, JSON.stringify({ loadId, deletedBy: by, rowIndex: row }), sqlStamp(ms + 1000));
	}
	// Creates app.db records: rate cons, a New Job, an n8n email load, and a dropped rate con's own notice.
	const rateCon = (loadId, ms, user, username, role) => audit.run(isoStamp(ms), user, username, role, "create_load_ratecon", "load", loadId,
		`Created load ${loadId} from a dropped rate-con (made-up-rc-${loadId.slice(-4)}.pdf); 812 mi @ $3.17/mi; rate-con saved locally`);
	rateCon("MU-DLR-0113", ago(10), 21, "made-up-dispatcher-d1", "Dispatcher");
	notice.run("new-load", "New Load MU-DLR-0113", "Made-up Pickup Yard 14 → Made-up Drop Dock 14", JSON.stringify({ loadId: "MU-DLR-0113", rowIndex: 14, source: "ratecon-drop" }), sqlStamp(ago(10)));
	rateCon("MU-DLR-0101", ago(15), 2, "made-up-admin-a2", "Super Admin");
	audit.run(isoStamp(ago(8)), 1, "made-up-admin-a1", "Super Admin", "create_sheet_row", "sheet_row", "Job Tracking!'Job Tracking'!A15:L15", JSON.stringify({
		outcome: "created", sheet: "Job Tracking", rowIndex: null,
		changed: [{ column: "Load ID", index: 0, from: "", to: "MU-DLR-0114", why: "" }, { column: "Driver", index: 1, from: "", to: "Made-up Driver Q15", why: "" }],
	}));
	notice.run("new-load", "New Load MU-DLR-0115", "Assigned to Made-up Driver Q16", JSON.stringify({ loadId: "MU-DLR-0115", driver: "Made-up Driver Q16", source: "n8n" }), sqlStamp(ago(5)));
	rateCon("MU-DLR-0117", ago(120), 1, "made-up-admin-a1", "Super Admin");
	rateCon("MU-DLR-0118", ago(50), 21, "made-up-dispatcher-d1", "Dispatcher");

	const lock = db.prepare("INSERT INTO period_locks (period, status, finalized_at, finalized_by) VALUES (?, 'locked', ?, 'made-up-admin-a1')");
	lock.run("2026-08", "2026-09-03T00:00:00Z");
	lock.run("2026-09", "2026-10-05T00:00:00Z");

	let rows = ROWS;
	if (after) {
		rows = [...ROWS, ...AFTER_ROWS];
		// The audited restore of record 2, with its reason, and the Super Admins' notice of it.
		audit.run(isoStamp(ago(2)), 1, "made-up-admin-a1", "Super Admin", "restore_load", "load", "mu-dlr-0102",
			`Restored load mu-dlr-0102 (deleted_loads row 2, deleted 2026-10-07T14:00:00Z by made-up-admin-a1) — settlement month 2026-10. Reason: ${REASON}`);
		notice.run("deleted-load-restored", "Load mu-dlr-0102 was restored", `Restored by made-up-admin-a1. Reason: ${REASON}`,
			JSON.stringify({ kind: "restored", loadId: "mu-dlr-0102", deletedLoadIds: [2], userId: 1 }), sqlStamp(ago(2)));
		// What the first Super Admin dashboard read told: record 3 on the banner, record 5 in a closed month.
		notice.run("load-hidden-by-delete", "Load MU-DLR-0103 is hidden by an earlier delete", "Deleted by made-up-admin-a2 on 2026-09-10. Review it from the banner on the dashboard.",
			JSON.stringify({ kind: "hidden", tombstoneId: 3, deletedLoadId: "MU-DLR-0103" }), sqlStamp(ago(1)));
		notice.run("load-hidden-by-delete", "Load MU-DLR-0105 is hidden by an earlier delete, in a closed month", "Deleted by made-up-admin-a1 on 2026-07-20. Its month (August 2026) is closed, so restoring it would change a settled payout, which is a payout question.",
			JSON.stringify({ kind: "hidden_closed", tombstoneId: 5, deletedLoadId: "MU-DLR-0105" }), sqlStamp(ago(1)));
		// A delete made with the flag on: it recorded its row, which has changed since.
		const recorded = restoreLib.rowDigest(cellsOf(AFTER_ROWS[0], RECORDED_ROW_22),
			{ pickupAddress: "Pickup Address", dropoffAddress: "Drop-off Address", pickupDate: "Pickup Appointment", dropoffDate: "Drop-off Appointment" });
		db.prepare("INSERT INTO deleted_loads (id, load_id, row_index, deleted_at, deleted_by, row_digests) VALUES (22, 'mu-dlr-0121', 27, ?, 'made-up-admin-a1', ?)")
			.run(sqlStamp(ago(3)), JSON.stringify([recorded]));
		audit.run(isoStamp(ago(3) + 250), 1, "made-up-admin-a1", "Super Admin", "delete_load", "load", "mu-dlr-0121", deleteText("MU-DLR-0121", 27, ` — ${months("2026-11")}`));
	}

	const dbFile = path.join(dir, "app.db");
	fs.writeFileSync(dbFile, db.serialize());
	db.close();
	const valuesFile = path.join(dir, "values.json");
	fs.writeFileSync(valuesFile, JSON.stringify({ range: "'Job Tracking'!A1:L30", majorDimension: "ROWS", values: valuesOf(rows) }));
	// The copy's settings, kept outside the database's folder (a folder with server.js or settings is an app's).
	const flagsDir = `${dir}-settings`;
	fs.mkdirSync(flagsDir, { recursive: true });
	const flagsFile = path.join(flagsDir, "made-up-flags.txt");
	fs.writeFileSync(flagsFile, [
		"APP_TIMEZONE=America/New_York",
		"MADE_UP_SETTING=made-up-setting-value-77",
		...(after ? ["DELETED_LOAD_RESTORE_ENABLED=true"] : []),
		"",
	].join("\n"));
	return { dbFile, valuesFile, flagsFile, values: valuesOf(rows) };
}

// The load numbers --ids prints (P1, then P2), as the sheet shows them.
const PERSON_IDS = ["MU-DLR-0104", "MU-DLR-0106", "MU-DLR-0112", "MU-DLR-0107", "MU-DLR-0108"];

// The report's answer for each variant, worked out by hand from the rows and deletes above (cost.medianMs
// aside, which is measured).
const EXPECTED = {
	base: {
		dryRun: true,
		state: {
			flag: "off", tripCover: "off", rows: 25, rowsAfterDedupe: 22, records: 21, loadIds: 20, withRecordedRows: 0,
			storedNotices: { hidden: 0, hiddenClosed: 0, refusedCreate: 0, restored: 0 }, restoreLoad: 0, clearLoadDelete: 0,
		},
		months: [{ month: "2026-08", closed: true }, { month: "2026-09", closed: true }, { month: "2026-10", closed: false }, { month: "2026-11", closed: false }],
		withLiveRow: { count: 19, of: 21, older: 19, recorded: 0 },
		banner: {
			count: 11, records: [3, 4, 6, 9, 11, 12, 14, 15, 16, 17, 18],
			evidence: { deleted_with_no_row: 6, created_by_rate_con: 2, created_in_sheet_row: 1, created_by_n8n: 1, row_changed: 0, row_in_other_month: 3 },
			press: { createNew: 7, onlyRestore: 2, neither: 2 },
			months: { "2026-09": 1, "2026-10": 6, "2026-11": 4 }, noMonth: 1,
			p1: { count: 3, noRowNumber: 2, datesMoved: 1 },
		},
		closedOnly: { count: 2, months: { "2026-08": 1, "2026-09": 1 } },
		notShown: {
			count: 6, why: { auditNamesItsMonths: 4, noAuditRow: 1, auditNamesNoMonth: 1, recordedRows: 0, other: 0 },
			openMonths: { "2026-10": 4, "2026-11": 1 }, closed: 1, noMonth: 0, p2: { moreThanOneLiveRow: 1, noneAtStoredRow: 1 },
		},
		notices: { wouldWrite: { hidden: 11, hidden_closed: 2 }, stored: { hidden: 0, hidden_closed: 0 } },
		buttons: {
			count: 21,
			restore: { count: 15, months: { "2026-10": 10, "2026-11": 5 }, cancelledRowsOnly: 1, anotherDeleteStays: 2 },
			refuse: { count: 6, closedMonth: 4, noMonth: 1, noSheetRow: 1 },
		},
		creates: { loadIds: 20, last90Days: { rateCon: 2, rateConByRole: { Dispatcher: 1, "Super Admin": 1, other: 0 }, newJobOrDataManager: 1, n8n: 1 } },
		person: { count: 5, printed: false },
	},
	after: {
		dryRun: true,
		state: {
			flag: "on", tripCover: "off", rows: 26, rowsAfterDedupe: 23, records: 21, loadIds: 20, withRecordedRows: 1,
			storedNotices: { hidden: 1, hiddenClosed: 1, refusedCreate: 0, restored: 1 }, restoreLoad: 1, clearLoadDelete: 0,
		},
		months: [{ month: "2026-08", closed: true }, { month: "2026-09", closed: true }, { month: "2026-10", closed: false }, { month: "2026-11", closed: false }],
		withLiveRow: { count: 20, of: 21, older: 19, recorded: 1 },
		banner: {
			count: 12, records: [3, 4, 6, 9, 11, 12, 14, 15, 16, 17, 18, 22],
			evidence: { deleted_with_no_row: 6, created_by_rate_con: 2, created_in_sheet_row: 1, created_by_n8n: 1, row_changed: 1, row_in_other_month: 3 },
			press: { createNew: 8, onlyRestore: 2, neither: 2 },
			months: { "2026-09": 1, "2026-10": 6, "2026-11": 5 }, noMonth: 1,
			p1: { count: 3, noRowNumber: 2, datesMoved: 1 },
		},
		closedOnly: { count: 2, months: { "2026-08": 1, "2026-09": 1 } },
		notShown: {
			count: 6, why: { auditNamesItsMonths: 4, noAuditRow: 1, auditNamesNoMonth: 1, recordedRows: 0, other: 0 },
			openMonths: { "2026-10": 4, "2026-11": 1 }, closed: 1, noMonth: 0, p2: { moreThanOneLiveRow: 1, noneAtStoredRow: 1 },
		},
		notices: { wouldWrite: { hidden: 11, hidden_closed: 1 }, stored: { hidden: 1, hidden_closed: 1 } },
		buttons: {
			count: 21,
			restore: { count: 15, months: { "2026-10": 9, "2026-11": 6 }, cancelledRowsOnly: 0, anotherDeleteStays: 2 },
			refuse: { count: 6, closedMonth: 4, noMonth: 1, noSheetRow: 1 },
		},
		creates: { loadIds: 20, last90Days: { rateCon: 2, rateConByRole: { Dispatcher: 1, "Super Admin": 1, other: 0 }, newJobOrDataManager: 1, n8n: 1 } },
		person: { count: 5, printed: false },
	},
};

// Each record's press, as the restore route would answer it now (the parity runner checks the report's
// prediction against the route itself; these are the hand-worked answers). "OK" restores; anything else is
// the route's refusal code. Record 2 is gone in the after variant; record 22 is there only.
const PRESS = {
	1: ["NO_SHEET_ROW", "NO_SHEET_ROW"], 2: ["OK", "OK"], 3: ["OK", "OK"], 4: ["OK", "OK"], 5: ["PERIOD_FINALIZED", "PERIOD_FINALIZED"],
	6: ["OK", "OK"], 7: ["OK", "DELETED_ROWS_PRESENT"], 8: ["OK", "DELETED_ROWS_PRESENT"], 9: ["PERIOD_FINALIZED", "DELETED_ROWS_PRESENT"],
	10: ["PERIOD_FINALIZED", "PERIOD_FINALIZED"], 11: ["PERIOD_UNRESOLVED", "PERIOD_UNRESOLVED"], 12: ["OK", "OK"], 13: ["OK", "DELETED_ROWS_PRESENT"],
	14: ["OK", "DELETED_ROWS_PRESENT"], 15: ["OK", "OK"], 16: ["OK", "OK"], 17: ["OK", "OK"], 18: ["OK", "DELETED_ROWS_PRESENT"],
	19: ["OK", "DELETED_ROWS_PRESENT"], 20: ["PERIOD_FINALIZED", "DELETED_ROWS_PRESENT"], 21: ["OK", "DELETED_ROWS_PRESENT"], 22: ["OK", "OK"],
};
// The groups each record lands in (none: no live row).
const GROUPS = {
	base: { none: [1, 2], banner: [3, 4, 6, 9, 11, 12, 14, 15, 16, 17, 18], closedOnly: [5, 10], notShown: [7, 8, 13, 19, 20, 21] },
	after: { none: [1], banner: [3, 4, 6, 9, 11, 12, 14, 15, 16, 17, 18, 22], closedOnly: [5, 10], notShown: [7, 8, 13, 19, 20, 21] },
};

module.exports = { HEADERS, PLANTED, REASON, PERSON_IDS, EXPECTED, PRESS, GROUPS, buildWorld };
