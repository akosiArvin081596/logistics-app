// The server.js helpers the receipts auto-approve scripts run (month locks, the close's grace
// rule, the matcher, the band, the Personal-line check, logAudit), lifted from this checkout and
// handed the script's own database, so the report and the undo tool judge as the server does.

"use strict";

const path = require("path");
const { closure } = require("./server-lift");
const { serverSource } = require("./server-source");

const ROOTS = ["expenseRowPeriodLocked", "periodLocksReadable", "isPastGrace", "settlementGraceDays", "expensePostedPeriod",
	"fuelCpgBandFromFleet", "personalLiveExpenseIds", "normalizeDriverName", "logAudit", "matchFuelEventsToReceipts",
	"FUEL_EVENTS_MATCH_DAYS", "EXPENSE_PERIOD_EXPR", "EXPENSE_PNL_FILTER"];

function liftServer(db, { root = path.join(__dirname, "..", ".."), env = process.env } = {}) {
	const lifted = closure(serverSource({ root }), {
		roots: ROOTS,
		provided: ["db", "require", "process", "console"],
		denied: ["app", "io", "server", "sheets", "getSheets", "getDrive", "getJobTrackingCached", "sendEmail", "transporter", "fetch"],
	});
	const rootRequire = (m) => require(m.startsWith("./") ? path.join(root, m) : m);
	const proc = Object.create(process, { env: { value: env } });
	return new Function("db", "require", "process", "console", `"use strict";\n${lifted.text}\nreturn { ${ROOTS.join(", ")} };`)(
		db, rootRequire, proc, console);
}

// The pass's helpers from the lifted server, for lib/receipt-auto-approve-pass.js.
function passDeps(db, S) {
	return {
		db,
		expenseRowPeriodLocked: S.expenseRowPeriodLocked,
		periodLocksReadable: S.periodLocksReadable,
		monthDue: (period) => S.isPastGrace(period, S.settlementGraceDays()),
		expensePostedPeriod: S.expensePostedPeriod,
		band: S.fuelCpgBandFromFleet,
		personalLiveIds: S.personalLiveExpenseIds,
		normalizeDriverName: S.normalizeDriverName,
		logAudit: S.logAudit,
		matchDays: S.FUEL_EVENTS_MATCH_DAYS,
	};
}

module.exports = { liftServer, passDeps, ROOTS };
