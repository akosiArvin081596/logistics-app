// Which Google Sheet a process reads and writes (the Dispatch Management book,
// SPREADSHEET_ID). Pure: no fs, no network; every function takes the
// environment it judges.
//
// Only production's own process may run without SPREADSHEET_ID, and it gets the
// production sheet. That process is the one ecosystem.config.js defines: pm2
// app `logistics-app` in /var/www/logistics-app (pm2 puts `name` and `pm_cwd`
// in its environment, and they come back the same from pm2's dump after a
// reboot). Production's .env names no SPREADSHEET_ID, so this is its config.
//
// Anything else must name its sheet: the server refuses to start, and scripts
// and test-suite.js refuse to run, without one. Before this, an unset
// SPREADSHEET_ID meant the production sheet everywhere: a local server or a
// one-off script quietly read and wrote the live book.
"use strict";

const PRODUCTION_SPREADSHEET_ID = "1ey1n0AAG0k8k-qwkWh2T_C8VqqY129OQQr7D5wNl7Mo";
const PRODUCTION_PM2_NAME = "logistics-app";
const PRODUCTION_DIR = "/var/www/logistics-app";

function namedSpreadsheetId(env) {
	return String((env && env.SPREADSHEET_ID) || "").trim();
}

function isProductionProcess(env, cwd) {
	return !!env && env.name === PRODUCTION_PM2_NAME && env.pm_cwd === PRODUCTION_DIR && cwd === PRODUCTION_DIR;
}

// The server's sheet: SPREADSHEET_ID, else the production sheet for
// production's own process. Anything else gets { id: "", error }.
function resolveServerSpreadsheetId(env, cwd) {
	const named = namedSpreadsheetId(env);
	if (named) return { id: named, source: "SPREADSHEET_ID" };
	if (isProductionProcess(env, cwd)) return { id: PRODUCTION_SPREADSHEET_ID, source: "production process" };
	return {
		id: "",
		error: "SPREADSHEET_ID is not set. Name the sheet this server reads and writes in its .env " +
			"(staging's own sheet, or a test copy); refresh-local.sh and replica:start set one. Only " +
			`production's own pm2 process (${PRODUCTION_PM2_NAME} in ${PRODUCTION_DIR}) uses the ` +
			"production sheet without it.",
	};
}

// A script's sheet: SPREADSHEET_ID, always explicit. With `refuseProduction`
// the production sheet is refused as well (anything that writes test data).
function scriptSpreadsheetId(env, { script, refuseProduction = false } = {}) {
	const named = namedSpreadsheetId(env);
	const who = script || "this script";
	if (!named) {
		return {
			id: "",
			error: `${who} needs SPREADSHEET_ID: name the sheet it reads or writes ` +
				`(SPREADSHEET_ID=<id> node ...). It no longer falls back to the production sheet.`,
		};
	}
	if (refuseProduction && named === PRODUCTION_SPREADSHEET_ID) {
		return { id: "", error: `${who} writes test data, so it refuses the production sheet. Point it at a test copy.` };
	}
	return { id: named };
}

module.exports = {
	PRODUCTION_SPREADSHEET_ID,
	PRODUCTION_PM2_NAME,
	PRODUCTION_DIR,
	isProductionProcess,
	resolveServerSpreadsheetId,
	scriptSpreadsheetId,
};
