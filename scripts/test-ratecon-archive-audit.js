#!/usr/bin/env node
/**
 * POST /api/loads/from-ratecon's audit line says where the dropped rate con was actually saved.
 * It said "rate-con archived to Drive" whenever the LOCAL copy (uploads/rate-cons plus a RATECON
 * documents row) was written, while the Drive mirror is best-effort and in production always
 * fails (the service account has no quota in that folder), so every such row's drive_file_id was
 * empty while its audit line claimed Drive.
 *
 *   §1 the route, lifted whole (scripts/lib/server-lift.js) over a stand-in Job Tracking, Payments
 *      Table and Job Details, a recording database, a real temp folder for uploads and a stand-in
 *      Drive client. The create_load_ratecon audit details end with:
 *      - "rate-con saved locally" when the local copy was written and no Drive folder is set;
 *      - the same when a folder is set and the Drive create throws, or answers no file id;
 *      - "rate-con saved locally and copied to Drive" only when the Drive create answered an id
 *        and the documents row was updated with it;
 *      - "rate-con NOT saved locally; copied to Drive" when the local write failed and the Drive
 *        create answered an id (no documents row names it);
 *      - "rate-con NOT saved" when the local write failed and nothing reached Drive, and when no
 *        PDF was attached;
 *      and never "archived to Drive". The load itself is created as before in every case (200,
 *      the Job Tracking row appended, the warnings the route already gave).
 *
 * Every value here is made up: load numbers, amounts, addresses, names, file and folder ids.
 * SERVER_JS=<file> runs against another copy of server.js (the base, to show the cases fail).
 * Pure: no server, no network, no app.db. Run: node scripts/test-ratecon-archive-audit.js
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { createRequire } = require("module");
const { closure } = require("./lib/server-lift");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(process.env.SERVER_JS || path.join(ROOT, "server.js"), "utf8");
// server.js's own require, so a lifted `require("./lib/...")` finds this checkout's lib/.
const rootRequire = createRequire(path.join(ROOT, "server.js"));

let pass = 0;
let fail = 0;
function ok(label, cond, detail) {
	if (cond) { pass++; return; }
	fail++;
	console.log(`FAIL ${label}${detail === undefined ? "" : `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
}
function eq(actual, expected, label) {
	ok(label, JSON.stringify(actual) === JSON.stringify(expected), { got: actual, want: expected });
}

const HEAD = 'app.post("/api/loads/from-ratecon", requireRole("Super Admin", "Dispatcher"), rateConLimiter, async (req, res) => {';
const PROVIDED = ["app", "db", "fs", "path", "require", "console", "process", "requireRole", "rateConLimiter", "io", "notifyChange",
	"insertDispatchNotification", "logAudit", "upsertLoadCoordsStmt", "getSheets", "getDrive", "geocodeAddress", "jtCacheInvalidate",
	"SPREADSHEET_ID", "GOOGLE_MAPS_API_KEY", "RATECON_DRIVE_FOLDER_ID", "DATA_DIR", "fetch", "getDeletedLoadIds"];
const LIFTED = closure(SRC, { routes: [HEAD], provided: PROVIDED, denied: ["server", "auth", "google", "sheetsClient", "sendEmail", "transporter"] });

const JT_HEADERS = ["Load ID", "Details", "Driver", "Pickup Address", "Drop-off Address", "Job Status", "  Payment  ", "Assigned Date"];
const PAY_HEADERS = [" Job ID", "Contract ID", "Payment Amount"];
const JD_HEADERS = ["Load ID", "Rate Per Mile", "Distance", "Details", "Payment"];
const FOLDER = "folder-under-test-b5";
const PDF = Buffer.from("%PDF-1.4\n%%EOF\n").toString("base64");
const QUIET = { log() {}, warn() {}, info() {}, error() {} };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "logisx-ratecon-audit-"));

// One run of the route. drive: "none" (no folder set), "id" (create answers an id), "noid"
// (create answers no id), "throws". localFails: writing the PDF under uploads/ throws.
async function run({ loadId, drive = "none", localFails = false, pdf = PDF }) {
	const tabs = { "Job Tracking": [JT_HEADERS], "Payments Table": [PAY_HEADERS], "Job Details": [JD_HEADERS] };
	const sheets = { spreadsheets: { values: {
		get: async ({ range }) => ({ data: { values: tabs[range] || [] } }),
		append: async ({ range, requestBody }) => {
			tabs[range].push(requestBody.values[0]);
			return { data: { updates: { updatedRange: `'${range}'!A${tabs[range].length}:H${tabs[range].length}` } } };
		},
		update: async () => ({ data: {} }),
		batchUpdate: async () => ({ data: {} }),
	} } };
	const sql = [];
	const db = { prepare: (s) => ({ run: (...args) => { sql.push({ s: s.trim().split(/\s+/).slice(0, 2).join(" "), args }); return { changes: 1 }; } }) };
	const dataDir = fs.mkdtempSync(path.join(tmp, "data-"));
	const fsUnder = localFails
		? { ...fs, writeFileSync: (p, ...rest) => { if (String(p).startsWith(dataDir)) throw new Error("disk full (test)"); return fs.writeFileSync(p, ...rest); } }
		: fs;
	const driveCalls = [];
	const getDrive = async () => ({ files: { create: async (p) => {
		driveCalls.push(p.requestBody && p.requestBody.parents);
		if (drive === "throws") throw new Error("storage quota exceeded (test)");
		return { data: drive === "id" ? { id: "drive-file-under-test-b5", name: `${loadId}.pdf` } : {} };
	} } });
	const audits = [];
	const routes = {};
	const app = { post: (p, ...h) => { routes[p] = h[h.length - 1]; } };
	const deps = {
		app, db, fs: fsUnder, path, require: rootRequire, console: QUIET, process: { env: {} },
		requireRole: () => (req, res, next) => next(), rateConLimiter: (req, res, next) => next(),
		io: { to: () => ({ emit() {}, except: () => ({ emit() {} }) }) }, notifyChange() {},
		insertDispatchNotification: { run() {} },
		logAudit: (req, action, entity, entityId, details) => audits.push({ action, entity, entityId, details }),
		upsertLoadCoordsStmt: { run() {} },
		getSheets: async () => sheets, getDrive, geocodeAddress: async () => null, jtCacheInvalidate() {},
		SPREADSHEET_ID: "sheet-under-test-b5", GOOGLE_MAPS_API_KEY: "", RATECON_DRIVE_FOLDER_ID: drive === "none" ? "" : FOLDER,
		DATA_DIR: dataDir, fetch: async () => { throw new Error("test: no network"); }, getDeletedLoadIds: () => new Set(),
	};
	new Function(...PROVIDED, `"use strict";\n${LIFTED.text}`)(...PROVIDED.map((n) => deps[n]));
	const out = { status: 200, body: null };
	const res = { status(c) { out.status = c; return res; }, json(b) { out.body = b; return res; }, on() {} };
	const fields = {
		"Load Number": loadId, Rate: "$1,250.00", "Broker Name": "Example Brokerage Test",
		"Pickup Address": "100 Test Way, Dallas, TX 75201", "Drop-off Address": "200 Sample Rd, Austin, TX 78701",
	};
	await routes["/api/loads/from-ratecon"]({ body: { fields, pdfBase64: pdf, fileName: "ratecon-under-test.pdf" }, session: { user: { role: "Super Admin" } } }, res);
	const audit = audits.find((a) => a.action === "create_load_ratecon");
	return {
		status: out.status, body: out.body, audit, details: audit ? audit.details : "", driveCalls, sql,
		appended: tabs["Job Tracking"].length - 1, savedLocally: fs.existsSync(path.join(dataDir, "uploads", "rate-cons", `${loadId}.pdf`)),
	};
}

// The audit line's last clause: what it says about the rate con.
const tail = (details) => {
	const m = /; (rate-con [^;]*(?:; copied to Drive)?)$/.exec(details || "");
	return m ? m[1] : null;
};

(async () => {
	try {
		console.log("§1 POST /api/loads/from-ratecon, lifted: the audit line says where the rate con went");
		const common = (label, r) => {
			eq(r.status, 200, `§1 ${label}: the load is created (200)`);
			eq(r.appended, 1, `§1 ${label}: one Job Tracking row is appended`);
			ok(`§1 ${label}: one create_load_ratecon audit row`, !!r.audit, r.details);
			ok(`§1 ${label}: the audit line still names the load, file and rate per mile`,
				/^Created load RC-71\d\d from a dropped rate-con \(ratecon-under-test\.pdf\); \d+(\.\d+)? mi @ \$[\d.]+\/mi; /.test(r.details), r.details);
			ok(`§1 ${label}: never "archived to Drive"`, !/archived to Drive/.test(r.details), r.details);
		};

		{
			const r = await run({ loadId: "RC-7101", drive: "none" });
			common("local copy, no Drive folder", r);
			ok("§1 local copy, no Drive folder: the PDF is under uploads/rate-cons", r.savedLocally);
			eq(r.driveCalls.length, 0, "§1 local copy, no Drive folder: no Drive call");
			eq(tail(r.details), "rate-con saved locally", "§1 local copy, no Drive folder: says \"rate-con saved locally\"");
		}
		{
			const r = await run({ loadId: "RC-7102", drive: "throws" });
			common("local copy, Drive create throws", r);
			eq(r.driveCalls, [[FOLDER]], "§1 local copy, Drive create throws: the configured folder was tried");
			eq(tail(r.details), "rate-con saved locally", "§1 local copy, Drive create throws: says \"rate-con saved locally\"");
			const warned = ((r.body && r.body.warnings) || []).filter((w) => /rate-con|Drive/i.test(w));
			eq(warned, [], "§1 local copy, Drive create throws: no rate-con or Drive warning to the dispatcher, as before");
		}
		{
			const r = await run({ loadId: "RC-7103", drive: "noid" });
			common("local copy, Drive answers no id", r);
			ok("§1 local copy, Drive answers no id: the documents row is not updated", !r.sql.some((q) => q.s === "UPDATE documents"), r.sql);
			eq(tail(r.details), "rate-con saved locally", "§1 local copy, Drive answers no id: says \"rate-con saved locally\"");
		}
		{
			const r = await run({ loadId: "RC-7104", drive: "id" });
			common("local copy, Drive answers an id", r);
			ok("§1 local copy, Drive answers an id: the documents row gets the Drive id",
				r.sql.some((q) => q.s === "UPDATE documents" && q.args[0] === "drive-file-under-test-b5"), r.sql);
			eq(tail(r.details), "rate-con saved locally and copied to Drive", "§1 local copy, Drive answers an id: says \"rate-con saved locally and copied to Drive\"");
		}
		{
			const r = await run({ loadId: "RC-7105", drive: "none", localFails: true });
			common("local write fails, no Drive folder", r);
			ok("§1 local write fails, no Drive folder: no documents row is written", !r.sql.some((q) => /documents/.test(q.s)), r.sql);
			ok("§1 local write fails, no Drive folder: the dispatcher is warned, as before",
				!!(r.body && r.body.warnings || []).find((w) => /could not be saved/.test(w)), r.body && r.body.warnings);
			eq(tail(r.details), "rate-con NOT saved", "§1 local write fails, no Drive folder: says \"rate-con NOT saved\"");
		}
		{
			const r = await run({ loadId: "RC-7106", drive: "id", localFails: true });
			common("local write fails, Drive answers an id", r);
			ok("§1 local write fails, Drive answers an id: no documents row names the Drive copy", !r.sql.some((q) => /documents/.test(q.s)), r.sql);
			eq(tail(r.details), "rate-con NOT saved locally; copied to Drive", "§1 local write fails, Drive answers an id: says \"rate-con NOT saved locally; copied to Drive\"");
		}
		{
			const r = await run({ loadId: "RC-7107", drive: "id", pdf: "" });
			common("no PDF attached", r);
			eq(r.driveCalls.length, 0, "§1 no PDF attached: no Drive call");
			eq(tail(r.details), "rate-con NOT saved", "§1 no PDF attached: says \"rate-con NOT saved\"");
		}
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
	console.log(fail ? `\nFAILED: ${pass} passed, ${fail} failed` : `\nPASS: ${pass} checks`);
	process.exit(fail ? 1 : 0);
})().catch((e) => {
	fs.rmSync(tmp, { recursive: true, force: true });
	console.error(e);
	process.exit(1);
});
