#!/usr/bin/env node
/**
 * Passenger authorizations, the API (PR 2 of 4): lib/passenger-authorization.js,
 * its one mount in server.js, scripts/passenger-authorization-report.js and the
 * flag's replica rule.
 *
 * HOW. Each world is express on port 0 with an in-memory SQLite and a temp
 * storage folder. server.js's own requireAuth, requireRole, refuseCrossSite,
 * sanitizeEvidenceText, readTransmittedConsent, signerNetworkEvidence and
 * writeSignedArtifact are lifted from its source (scripts/lib/server-lift.js);
 * the field map and the renderer's image check are the real ones; a stand-in
 * renderer builds the real fields and answers a made-up PDF (or fails, or
 * waits, on cue).
 *
 * WHAT IS ASSERTED
 *   §1 flag off: every route answers 404 FEATURE_OFF after its role guard; the
 *      feature route says false; no table, no folder, no render, no row
 *   §2 roles: signed out 401; a write without X-Requested-With refused; a
 *      cross-site write refused; Driver on admin routes 403; Dispatcher and
 *      Investor 403 on driver routes and 404 on the PDF route; Super Admin 403
 *      on driver routes; a session with no account id refused
 *   §3 validation: one case per code, the window edges, a non-day, the string
 *      "true", consent agreed: 1, refused images (absent, a URL, SVG, oversize,
 *      one the renderer would drop), text cleaned and never cut short
 *   §4 create: the render gets the passenger's and driver's images and no
 *      company image; the file's sha256 is the row's; the driver's name comes
 *      from his account; one render per request id; another driver's request id
 *      409; the 11th open row 409 before any render; two creates racing for the
 *      10th place or for one request id; the dispatch notice, audit row and live
 *      events carry the reference and the driver, never the rider; own list only
 *   §5 render failure: 503 retryable, no row, no notice, no file left
 *   §6 countersign, decline, revoke: transitions and 409s; the final file is new
 *      and the driver-stage file unchanged; the company's fields and the account
 *      recorded; the field map decides AUTHORIZATION_INCOMPLETE; the driver's
 *      notice goes to the account's name now; RACES: a decline landing during a
 *      countersign's render, and the expiry passing during one
 *   §7 the PDF route: the owner 200 with the four headers; the countersigned copy
 *      once authorized; another driver, a Dispatcher, an Investor 404; a Super
 *      Admin 200, on the audit trail; a stored name this module never writes, a
 *      file of the wrong kind, a missing file 404; changed bytes 500
 *   §8 statusOf() at the edges; the business day and calendar dates under other
 *      host time zones
 *   §9 the approval gate untouched; server.js mounts the module once, above
 *      app.get("*"), outside the KPI and CHR blocks, the room from driverRoom()
 *   §10 the report script: read-only, counts only, exit 2 without --db
 *   §11 mutants, one per decision: each must first hold on the real module, then
 *      be caught
 *
 * Made-up people and places only. No network beyond 127.0.0.1, no real database.
 * Run: node scripts/test-passenger-authorization-routes.js    # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const Module = require("module");
const { spawnSync } = require("child_process");
const express = require("express");
const Database = require("better-sqlite3");

const ROOT = path.join(__dirname, "..");
const LIB_PATH = path.join(ROOT, "lib", "passenger-authorization.js");
const REPORT_PATH = path.join(ROOT, "scripts", "passenger-authorization-report.js");
const IMG = require(path.join(ROOT, "lib", "image-size.js"));
const RENDERER = require(path.join(ROOT, "lib", "policy-renderer.js"));
const SRC = require("./lib/server-source").serverSource();
const { closure } = require("./lib/server-lift");

let pass = 0;
const failures = [];
const ok = (cond, msg) => { if (cond) pass++; else failures.push(msg); };
const eq = (actual, expected, msg) => {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	ok(a === e, `${msg}\n      expected ${e}\n      actual   ${a}`);
};
// A part that throws (on the base commit the module does not exist) is one failure, not a crash.
async function part(title, fn) {
	console.log(title);
	try { await fn(); } catch (err) { failures.push(`${title}: threw ${err && err.message ? err.message : err}`); }
}

const tempDirs = [];
process.on("exit", () => { for (const d of tempDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });
const tempDir = (prefix) => {
	const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
	tempDirs.push(d);
	return d;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

// ── the module, compiled at its own path (so its requires resolve) ───────────
function compile(src) {
	const m = new Module(LIB_PATH, module);
	m.filename = LIB_PATH;
	m.paths = Module._nodeModulePaths(path.dirname(LIB_PATH));
	m._compile(src, LIB_PATH);
	return m.exports;
}
const libSource = () => fs.readFileSync(LIB_PATH, "utf8");
let REAL = null;
const realLib = () => (REAL = REAL || compile(libSource()));

// ── server.js's own guards and signing helpers ───────────────────────────────
const H = (() => {
	const names = ["requireAuth", "requireRole", "refuseCrossSite", "sanitizeEvidenceText", "readTransmittedConsent", "signerNetworkEvidence", "writeSignedArtifact", "ONBOARDING_DOCS"];
	const lifted = closure(SRC, {
		roots: names,
		provided: ["fs", "crypto", "path", "DRIVER_MOBILE_ORIGINS", "logAuditRefusal"],
		denied: ["app", "io", "server", "db", "sendEmail", "transporter", "getSheets", "getDrive", "getJobTrackingCached"],
	});
	return new Function("fs", "crypto", "path", "DRIVER_MOBILE_ORIGINS", "logAuditRefusal", `${lifted.text}\nreturn { ${names.join(", ")} };`)(fs, crypto, path, [], () => {});
})();
// The guards' refusal lines are coalesced console warnings; kept out of the output.
const realWarn = console.warn;
console.warn = () => {};
process.on("exit", () => { console.warn = realWarn; });

// ── made-up people and values ────────────────────────────────────────────────
const USERS = {
	casey: { id: 90102, username: "casey.example", role: "Driver", driverName: "Casey Example" },
	jordan: { id: 90103, username: "jordan.example", role: "Driver", driverName: "Jordan Example" },
	nameless: { id: 90104, username: "nameless.example", role: "Driver", driverName: "" },
	admin: { id: 1, username: "super_admin", role: "Super Admin" },
	dispatch: { id: 2, username: "dana.dispatch", role: "Dispatcher" },
	investor: { id: 3, username: "ivy.investor", role: "Investor" },
	// A session from before sessions carried the account id.
	noid: { username: "old.session", role: "Driver", driverName: "Casey Example" },
};
const RIDER_WORDS = ["Jane Example", "Riley Example", "Pat Example", "Houston", "Dallas", "Parent"];

// A PNG data URI whose header the image check reads (300 x 100), then made-up bytes.
function png(tag) {
	const head = Buffer.alloc(33);
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0);
	head.writeUInt32BE(13, 8);
	head.write("IHDR", 12, "latin1");
	head.writeUInt32BE(300, 16);
	head.writeUInt32BE(100, 20);
	head[24] = 8;
	head[25] = 6;
	return `data:image/png;base64,${Buffer.concat([head, Buffer.from(`made-up ${tag} signature`)]).toString("base64")}`;
}
const PNG_PASSENGER = png("passenger");
const PNG_DRIVER = png("driver");
const PNG_COMPANY = png("company");
// The image check accepts it (Node reads "-" as base64url); the renderer would drop it.
const PNG_RENDERER_DROPS = (() => { const at = "data:image/png;base64,".length + 50; return PNG_PASSENGER.slice(0, at) + "-" + PNG_PASSENGER.slice(at + 1); })();
const CONSENT = { agreed: true, text: "I have read and agree to the terms of this document" };
const UA = "MadeUpTestBrowser/1.0";

const TODAY = "2026-11-03";
// Day arithmetic of this runner's own, so no case leans on the module's.
function plusDays(day, n) {
	const [y, m, d] = day.split("-").map(Number);
	return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function adultBody(over = {}) {
	return {
		requestId: crypto.randomUUID(),
		passengerName: "Jane Example",
		passengerAdult: true,
		truckUnit: "T-0000",
		tripStart: "Houston, TX",
		tripEnd: "Dallas, TX",
		validFrom: TODAY,
		expiresOn: "2026-11-09",
		passengerSignatureImage: PNG_PASSENGER,
		passengerConsent: { ...CONSENT },
		driverSignatureImage: PNG_DRIVER,
		driverConsent: { ...CONSENT },
		...over,
	};
}
const minorBody = (over = {}) => adultBody({
	passengerName: "Riley Example", passengerAdult: false, guardianName: "Pat Example", guardianRelationship: "Parent", minorAttested: true, ...over,
});
const countersignBody = (over = {}) => ({ printedName: "Sam Example", title: "Safety Manager", signatureImage: PNG_COMPANY, consent: { ...CONSENT }, ...over });

const CREATE = "/api/passenger-authorizations";
const LIST = "/api/passenger-authorizations";
const FORM = "/api/passenger-authorizations/form.pdf";
const FEATURE = "/api/passenger-authorizations/feature";
const ADMIN_LIST = "/api/admin/passenger-authorizations";
const pdfOf = (id) => `/api/passenger-authorizations/${id}/pdf`;
const countersignOf = (id) => `/api/admin/passenger-authorizations/${id}/countersign`;
const declineOf = (id) => `/api/admin/passenger-authorizations/${id}/decline`;
const revokeOf = (id) => `/api/admin/passenger-authorizations/${id}/revoke`;

const FIXTURE_SQL = `
CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, role TEXT NOT NULL, driver_name TEXT DEFAULT '');
CREATE TABLE audit_trail (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL, user_id INTEGER NOT NULL, username TEXT NOT NULL, role TEXT NOT NULL, action TEXT NOT NULL, entity TEXT NOT NULL, entity_id TEXT DEFAULT '', details TEXT DEFAULT '');
CREATE TABLE notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, driver_name TEXT NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL, body TEXT DEFAULT '', metadata TEXT DEFAULT '{}', read INTEGER DEFAULT 0);
CREATE TABLE dispatch_notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, title TEXT NOT NULL, body TEXT DEFAULT '', metadata TEXT DEFAULT '{}', read INTEGER DEFAULT 0);
CREATE TABLE driver_onboarding (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL UNIQUE, status TEXT NOT NULL, drug_test_result TEXT DEFAULT '');
CREATE TABLE onboarding_documents (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, doc_key TEXT NOT NULL, doc_name TEXT DEFAULT '', signed INTEGER DEFAULT 0, signed_pdf_url TEXT DEFAULT '', UNIQUE(user_id, doc_key));
`;

// A stand-in for renderPolicy(): the real fields from the real field map, then
// a made-up PDF; or a failure, a page that isn't a PDF, a truncated one, or a
// render held until released.
function makeRenderer() {
	const r = { calls: [], mode: "ok", held: [] };
	r.fn = async (docKey, data) => {
		const fields = RENDERER.buildRenderFields(docKey, data);
		r.calls.push({ docKey, data: JSON.parse(JSON.stringify(data)), images: Object.keys(fields.signatureImagesByLabel || {}), notice: fields.text["Validity notice"] });
		if (r.mode === "throw") { const e = new Error("made-up render failure"); e.code = "DOCUMENT_RENDER_FAILED"; throw e; }
		if (r.mode === "not-pdf") return Buffer.from("<html>made-up error page</html>".padEnd(2000, " "));
		if (r.mode === "tiny") return Buffer.from("%PDF-1.4 made-up");
		const bytes = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.from(JSON.stringify(fields.text)), Buffer.from(`\n${r.calls.length} ${crypto.randomBytes(4).toString("hex")}\n`), Buffer.alloc(1200, 32)]);
		if (r.mode === "hold") return new Promise((resolve) => r.held.push(() => resolve(bytes)));
		return bytes;
	};
	r.release = () => { for (const go of r.held.splice(0)) go(); };
	r.waitHeld = async (n) => {
		for (let i = 0; i < 400 && r.held.length < n; i++) await sleep(5);
		return r.held.length >= n;
	};
	return r;
}

function call(base, method, urlPath, { user = null, body, xrw = true, headers = {} } = {}) {
	return new Promise((resolve, reject) => {
		const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
		const h = { "user-agent": UA, ...headers };
		if (user) h["x-test-user"] = user;
		if (xrw) h["x-requested-with"] = "XMLHttpRequest";
		if (data) { h["content-type"] = "application/json"; h["content-length"] = String(data.length); }
		const req = http.request(base + urlPath, { method, headers: h }, (res) => {
			const chunks = [];
			res.on("data", (c) => chunks.push(c));
			res.on("end", () => {
				const buf = Buffer.concat(chunks);
				let json = null;
				if (/json/.test(String(res.headers["content-type"] || ""))) { try { json = JSON.parse(buf.toString("utf8")); } catch { json = null; } }
				resolve({ status: res.statusCode, headers: res.headers, json: json || {}, buf });
			});
		});
		req.on("error", reject);
		if (data) req.write(data);
		req.end();
	});
}

async function world({ on = true, lib = null, today = TODAY } = {}) {
	const L = lib || realLib();
	const db = new Database(":memory:");
	db.exec(FIXTURE_SQL);
	const addUser = db.prepare("INSERT INTO users (id, username, role, driver_name) VALUES (?, ?, ?, ?)");
	for (const u of Object.values(USERS)) if (u.id) addUser.run(u.id, u.username, u.role, u.driverName || "");
	const storageDir = path.join(tempDir("pa-routes-"), "storage", "passenger-authorizations");
	const state = { today };
	const calls = { dispatchEmits: [], driverEmits: [], changes: [], logs: [] };
	const renderer = makeRenderer();
	const app = express();
	app.use(express.json({ limit: "50mb" }));
	app.use((req, res, next) => {
		const key = req.get("x-test-user");
		req.session = key && USERS[key] ? { user: { ...USERS[key] } } : {};
		next();
	});
	L.mount(app, {
		db,
		enabled: on,
		requireAuth: H.requireAuth,
		requireRole: H.requireRole,
		refuseCrossSite: H.refuseCrossSite,
		renderPolicy: renderer.fn,
		safeSignatureImage: RENDERER.safeSignatureImage,
		writeSignedArtifact: H.writeSignedArtifact,
		readTransmittedConsent: H.readTransmittedConsent,
		signerNetworkEvidence: H.signerNetworkEvidence,
		cleanText: H.sanitizeEvidenceText,
		imageLimits: IMG,
		logAudit: (req, action, entity, entityId, details) => {
			const u = (req.session && req.session.user) || {};
			db.prepare("INSERT INTO audit_trail (timestamp, user_id, username, role, action, entity, entity_id, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
				.run(new Date().toISOString(), u.id || 0, u.username || "system", u.role || "system", action, entity, String(entityId || ""), details || "");
		},
		insertDispatchNotification: db.prepare("INSERT INTO dispatch_notifications (type, title, body, metadata) VALUES (?, ?, ?, ?)"),
		emitDispatchNotice: (n) => calls.dispatchEmits.push(n),
		insertNotification: db.prepare("INSERT INTO notifications (driver_name, type, title, body, metadata) VALUES (?, ?, ?, ?, ?)"),
		emitToDriver: (name) => calls.driverEmits.push(name),
		notifyChange: (d) => calls.changes.push(d),
		appDay: () => state.today,
		storageDir,
		logger: { error: (...a) => calls.logs.push(a.join(" ")), warn: (...a) => calls.logs.push(a.join(" ")) },
	});
	const server = http.createServer(app);
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const base = `http://127.0.0.1:${server.address().port}`;
	const w = {
		L, db, storageDir, state, calls, renderer, base,
		req: (method, p, o) => call(base, method, p, o),
		close: () => new Promise((r) => server.close(r)),
		files: () => (fs.existsSync(storageDir) ? fs.readdirSync(storageDir).sort() : []),
		rows: () => (tableExists(db) ? db.prepare("SELECT * FROM passenger_authorizations ORDER BY id").all() : []),
		row: (id) => db.prepare("SELECT * FROM passenger_authorizations WHERE id = ?").get(id),
		count: (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n,
	};
	w.create = async (user = "casey", body = adultBody()) => {
		const r = await w.req("POST", CREATE, { user, body });
		return { r, id: r.json && r.json.authorization ? r.json.authorization.id : null };
	};
	w.countersign = (id, over = {}) => w.req("POST", countersignOf(id), { user: "admin", body: countersignBody(over) });
	return w;
}
async function withWorld(L, opts, fn) {
	const w = await world({ ...opts, lib: L });
	try { return await fn(w); } finally { await w.close(); }
}
const tableExists = (db) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'passenger_authorizations'").get();
const code = (r) => (r && r.json ? r.json.code : undefined);

// A row written straight to the table, for the states a route can't reach on its own.
let seedN = 0;
function seedRow(db, over = {}) {
	seedN++;
	const row = {
		reference: `PA-${String(seedN).padStart(8, "0")}`,
		request_id: crypto.randomUUID(),
		driver_user_id: USERS.casey.id,
		driver_name: "Casey Example",
		status: "awaiting_company",
		form_version: "PA-1",
		passenger_name: "Jane Example",
		passenger_adult: 1,
		guardian_name: "",
		guardian_relationship: "",
		minor_attested: 0,
		truck_unit: "T-0000",
		trip_start: "Houston, TX",
		trip_end: "Dallas, TX",
		valid_from: TODAY,
		expires_on: "2026-11-09",
		passenger_signature_text: "Jane Example",
		passenger_signature_image: PNG_PASSENGER,
		passenger_consent_text: CONSENT.text,
		driver_signature_text: "Casey Example",
		driver_signature_image: PNG_DRIVER,
		driver_consent_text: CONSENT.text,
		driver_signed_at: "2026-11-03T15:00:00.000Z",
		driver_signed_on: "November 3, 2026",
		driver_pdf_file: `pa-${crypto.randomBytes(16).toString("hex")}-driver.pdf`,
		driver_pdf_sha256: "0".repeat(64),
		driver_pdf_bytes: 0,
		created_at: "2026-11-03T15:00:00.000Z",
		...over,
	};
	const cols = Object.keys(row);
	const info = db.prepare(`INSERT INTO passenger_authorizations (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...cols.map((c) => row[c]));
	return { ...row, id: Number(info.lastInsertRowid) };
}

// ── validation cases: [body change, status, code, field or signer] ──────────
const LONG = (n, ch = "a") => ch.repeat(n);
const VCASES = {
	noRequestId: [(b) => ({ ...b, requestId: undefined }), 400, "REQUEST_ID_REQUIRED"],
	requestIdNotUuid: [(b) => ({ ...b, requestId: "not-a-uuid" }), 400, "REQUEST_ID_REQUIRED"],
	requestIdV1: [(b) => ({ ...b, requestId: "6ba7b810-9dad-11d1-80b4-00c04fd430c8" }), 400, "REQUEST_ID_REQUIRED"],
	noPassengerName: [(b) => ({ ...b, passengerName: undefined }), 400, "PASSENGER_NAME_REQUIRED", "passengerName"],
	passengerName1: [(b) => ({ ...b, passengerName: "J" }), 400, "PASSENGER_NAME_REQUIRED", "passengerName"],
	passengerName101: [(b) => ({ ...b, passengerName: LONG(101) }), 400, "PASSENGER_NAME_REQUIRED", "passengerName"],
	passengerNameNumber: [(b) => ({ ...b, passengerName: 12345 }), 400, "PASSENGER_NAME_REQUIRED", "passengerName"],
	passengerNameBlank: [(b) => ({ ...b, passengerName: "  \u0000\u0001  " }), 400, "PASSENGER_NAME_REQUIRED", "passengerName"],
	// Padded far past its limit with characters the cleaning strips: refused whole, never trimmed to fit.
	passengerNamePadded: [(b) => ({ ...b, passengerName: "​".repeat(900) + "Jane Example" }), 400, "PASSENGER_NAME_REQUIRED", "passengerName"],
	noAge: [(b) => ({ ...b, passengerAdult: undefined }), 400, "PASSENGER_AGE_REQUIRED", "passengerAdult"],
	ageString: [(b) => ({ ...b, passengerAdult: "true" }), 400, "PASSENGER_AGE_REQUIRED", "passengerAdult"],
	ageNumber: [(b) => ({ ...b, passengerAdult: 1 }), 400, "PASSENGER_AGE_REQUIRED", "passengerAdult"],
	minorNoGuardian: [(b) => ({ ...minorBody(), requestId: b.requestId, guardianName: undefined }), 400, "GUARDIAN_REQUIRED", "guardianName"],
	minorRelationship1: [(b) => ({ ...minorBody(), requestId: b.requestId, guardianRelationship: "P" }), 400, "GUARDIAN_REQUIRED", "guardianRelationship"],
	minorRelationship41: [(b) => ({ ...minorBody(), requestId: b.requestId, guardianRelationship: LONG(41) }), 400, "GUARDIAN_REQUIRED", "guardianRelationship"],
	minorNoAttestation: [(b) => ({ ...minorBody(), requestId: b.requestId, minorAttested: undefined }), 400, "MINOR_ATTESTATION_REQUIRED", "minorAttested"],
	minorAttestationString: [(b) => ({ ...minorBody(), requestId: b.requestId, minorAttested: "true" }), 400, "MINOR_ATTESTATION_REQUIRED", "minorAttested"],
	noTruck: [(b) => ({ ...b, truckUnit: undefined }), 400, "TRUCK_UNIT_REQUIRED", "truckUnit"],
	truckSpaces: [(b) => ({ ...b, truckUnit: "   " }), 400, "TRUCK_UNIT_REQUIRED", "truckUnit"],
	truck21: [(b) => ({ ...b, truckUnit: LONG(21, "T") }), 400, "TRUCK_UNIT_TOO_LONG", "truckUnit"],
	noTripStart: [(b) => ({ ...b, tripStart: undefined }), 400, "TRIP_POINTS_REQUIRED", "tripStart"],
	tripEnd121: [(b) => ({ ...b, tripEnd: LONG(121) }), 400, "TRIP_POINTS_REQUIRED", "tripEnd"],
	noTripEnd: [(b) => ({ ...b, tripEnd: "" }), 400, "TRIP_POINTS_REQUIRED", "tripEnd"],
	validFromNotADay: [(b) => ({ ...b, validFrom: "2026-02-30" }), 400, "DATES_INVALID", "validFrom"],
	validFromYesterday: [(b) => ({ ...b, validFrom: plusDays(TODAY, -1) }), 400, "DATES_INVALID", "validFrom"],
	validFromPlus91: [(b) => ({ ...b, validFrom: plusDays(TODAY, 91), expiresOn: plusDays(TODAY, 95) }), 400, "DATES_INVALID", "validFrom"],
	expiresBeforeStart: [(b) => ({ ...b, expiresOn: plusDays(TODAY, -1) }), 400, "DATES_INVALID", "expiresOn"],
	expiresNotADay: [(b) => ({ ...b, expiresOn: "2026-11-31" }), 400, "DATES_INVALID", "expiresOn"],
	expiresPlus366: [(b) => ({ ...b, expiresOn: plusDays(TODAY, 366) }), 400, "EXPIRY_TOO_LONG", "expiresOn"],
	noPassengerImage: [(b) => ({ ...b, passengerSignatureImage: undefined }), 400, "SIGNATURE_REQUIRED", "passenger"],
	noDriverImage: [(b) => ({ ...b, driverSignatureImage: "" }), 400, "SIGNATURE_REQUIRED", "driver"],
	imageUrl: [(b) => ({ ...b, passengerSignatureImage: "https://example.com/made-up.png" }), 415, "UNSUPPORTED_IMAGE_TYPE", "passenger"],
	imageSvg: [(b) => ({ ...b, driverSignatureImage: `data:image/svg+xml;base64,${Buffer.from("<svg/>").toString("base64")}` }), 415, "UNSUPPORTED_IMAGE_TYPE", "driver"],
	imageOversize: [(b) => ({ ...b, passengerSignatureImage: `data:image/png;base64,${"A".repeat(IMG.SIGNATURE_DATA_URI_MAX_LENGTH)}` }), 413, "IMAGE_TOO_LARGE", "passenger"],
	imageRendererDrops: [(b) => ({ ...b, passengerSignatureImage: PNG_RENDERER_DROPS }), 415, "UNSUPPORTED_IMAGE_TYPE", "passenger"],
	passengerConsentOne: [(b) => ({ ...b, passengerConsent: { agreed: 1, text: CONSENT.text } }), 400, "CONSENT_REQUIRED", "passenger"],
	passengerConsentMissing: [(b) => ({ ...b, passengerConsent: undefined }), 400, "CONSENT_REQUIRED", "passenger"],
	driverConsentString: [(b) => ({ ...b, driverConsent: { agreed: "true" } }), 400, "CONSENT_REQUIRED", "driver"],
};
// The edges that must be accepted: [label, body change].
const ACCEPTED = {
	startToday: (b) => ({ ...b, validFrom: TODAY, expiresOn: TODAY }),
	startPlus90: (b) => ({ ...b, validFrom: plusDays(TODAY, 90), expiresOn: plusDays(TODAY, 90) }),
	expiryPlus365: (b) => ({ ...b, expiresOn: plusDays(TODAY, 365) }),
	name100: (b) => ({ ...b, passengerName: LONG(100, "b") }),
	truck20: (b) => ({ ...b, truckUnit: LONG(20, "T") }),
	trip120: (b) => ({ ...b, tripStart: LONG(120, "s"), tripEnd: LONG(120, "e") }),
	relationship40: () => minorBody({ guardianRelationship: LONG(40, "r") }),
};

async function vcase(w, name) {
	const [change, status, wantCode, where] = VCASES[name];
	const before = w.renderer.calls.length;
	const r = await w.req("POST", CREATE, { user: "jordan", body: change(adultBody()) });
	const at = r.json.field || r.json.signer;
	return r.status === status && code(r) === wantCode && (where === undefined || at === where) && w.renderer.calls.length === before;
}
const vcases = (names) => (L) => withWorld(L, {}, async (w) => {
	for (const n of names) if (!(await vcase(w, n))) return false;
	return w.count("passenger_authorizations") === 0;
});
const accepts = (names) => (L) => withWorld(L, {}, async (w) => {
	for (const n of names) {
		const r = await w.req("POST", CREATE, { user: "casey", body: ACCEPTED[n](adultBody()) });
		if (r.status !== 201) return false;
	}
	return true;
});

// ── checks a mutant must break (each also asserted on the real module in §11) ─
const CHECK = {
	offIs404: (L) => withWorld(L, { on: false }, async (w) => {
		const r = await w.req("GET", LIST, { user: "casey" });
		return r.status === 404 && code(r) === "FEATURE_OFF";
	}),
	offFeatureFalse: (L) => withWorld(L, { on: false }, async (w) => {
		const r = await w.req("GET", FEATURE, { user: "casey" });
		return r.status === 200 && r.json.enabled === false;
	}),
	offNoTable: (L) => withWorld(L, { on: false }, async (w) => !tableExists(w.db)),
	onFeatureTrue: (L) => withWorld(L, {}, async (w) => {
		const r = await w.req("GET", FEATURE, { user: "dispatch" });
		return r.status === 200 && r.json.enabled === true;
	}),
	createRoleDriverOnly: (L) => withWorld(L, {}, async (w) => {
		const r = await w.req("POST", CREATE, { user: "admin", body: adultBody() });
		return r.status === 403 && r.json.error === "Forbidden" && w.count("passenger_authorizations") === 0;
	}),
	listRoleDriverOnly: (L) => withWorld(L, {}, async (w) => {
		const r = await w.req("GET", LIST, { user: "dispatch" });
		return r.status === 403 && r.json.error === "Forbidden";
	}),
	formRoleDriverOnly: (L) => withWorld(L, {}, async (w) => {
		const r = await w.req("GET", FORM, { user: "dispatch" });
		return r.status === 403 && r.json.error === "Forbidden";
	}),
	adminListSuperAdminOnly: (L) => withWorld(L, {}, async (w) => {
		await w.create();
		const r = await w.req("GET", ADMIN_LIST, { user: "casey" });
		return r.status === 403 && r.json.error === "Forbidden";
	}),
	countersignSuperAdminOnly: (L) => withWorld(L, {}, async (w) => {
		const { id } = await w.create();
		const r = await w.req("POST", countersignOf(id), { user: "casey", body: countersignBody() });
		return r.status === 403 && r.json.error === "Forbidden" && w.row(id).status === "awaiting_company";
	}),
	declineSuperAdminOnly: (L) => withWorld(L, {}, async (w) => {
		const { id } = await w.create();
		const r = await w.req("POST", declineOf(id), { user: "casey", body: { reason: "made-up reason" } });
		return r.status === 403 && r.json.error === "Forbidden" && w.row(id).status === "awaiting_company";
	}),
	revokeSuperAdminOnly: (L) => withWorld(L, {}, async (w) => {
		const { id } = await w.create();
		await w.countersign(id);
		const r = await w.req("POST", revokeOf(id), { user: "casey", body: { reason: "made-up reason" } });
		return r.status === 403 && r.json.error === "Forbidden" && w.row(id).status === "authorized";
	}),
	crossSiteCreate: (L) => withWorld(L, {}, async (w) => {
		const r = await w.req("POST", CREATE, { user: "casey", body: adultBody(), headers: { "sec-fetch-site": "cross-site" } });
		return r.status === 403 && code(r) === "CROSS_SITE_REFUSED" && w.count("passenger_authorizations") === 0;
	}),
	crossSiteCountersign: (L) => withWorld(L, {}, async (w) => {
		const { id } = await w.create();
		const r = await w.req("POST", countersignOf(id), { user: "admin", body: countersignBody(), headers: { "sec-fetch-site": "cross-site" } });
		return r.status === 403 && code(r) === "CROSS_SITE_REFUSED" && w.row(id).status === "awaiting_company";
	}),
	crossSiteDecline: (L) => withWorld(L, {}, async (w) => {
		const { id } = await w.create();
		const r = await w.req("POST", declineOf(id), { user: "admin", body: { reason: "made-up reason" }, headers: { "sec-fetch-site": "cross-site" } });
		return r.status === 403 && code(r) === "CROSS_SITE_REFUSED" && w.row(id).status === "awaiting_company";
	}),
	crossSiteRevoke: (L) => withWorld(L, {}, async (w) => {
		const { id } = await w.create();
		await w.countersign(id);
		const r = await w.req("POST", revokeOf(id), { user: "admin", body: { reason: "made-up reason" }, headers: { "sec-fetch-site": "cross-site" } });
		return r.status === 403 && code(r) === "CROSS_SITE_REFUSED" && w.row(id).status === "authorized";
	}),
	pdfOtherRoles404: (L) => withWorld(L, {}, async (w) => {
		const { id } = await w.create();
		const a = await w.req("GET", pdfOf(id), { user: "dispatch" });
		const b = await w.req("GET", pdfOf(id), { user: "investor" });
		return a.status === 404 && b.status === 404 && code(a) === "NOT_FOUND" && code(b) === "NOT_FOUND";
	}),
	pdfOtherDriver404: (L) => withWorld(L, {}, async (w) => {
		const { id } = await w.create();
		const r = await w.req("GET", pdfOf(id), { user: "jordan" });
		return r.status === 404 && code(r) === "NOT_FOUND";
	}),
	pdfOwnerAndAdmin: (L) => withWorld(L, {}, async (w) => {
		const { id } = await w.create();
		const file = fs.readFileSync(path.join(w.storageDir, w.row(id).driver_pdf_file));
		const a = await w.req("GET", pdfOf(id), { user: "casey" });
		const b = await w.req("GET", pdfOf(id), { user: "admin" });
		return a.status === 200 && b.status === 200 && a.buf.equals(file) && b.buf.equals(file);
	}),
	pdfStrangeName404: (L) => withWorld(L, {}, async (w) => {
		const { id } = await w.create();
		const bytes = Buffer.from("%PDF-1.4 made-up planted file".padEnd(1200, " "));
		fs.writeFileSync(path.join(w.storageDir, "x-driver.pdf"), bytes);
		w.db.prepare("UPDATE passenger_authorizations SET driver_pdf_file = 'x-driver.pdf', driver_pdf_sha256 = ? WHERE id = ?").run(sha(bytes), id);
		const r = await w.req("GET", pdfOf(id), { user: "casey" });
		return r.status === 404 && !r.buf.equals(bytes);
	}),
	pdfWrongKind404: (L) => withWorld(L, {}, async (w) => {
		const a = await w.create();
		await w.countersign(a.id);
		const signed = w.row(a.id);
		const b = await w.create();
		w.db.prepare("UPDATE passenger_authorizations SET driver_pdf_file = ?, driver_pdf_sha256 = ? WHERE id = ?").run(signed.final_pdf_file, signed.final_pdf_sha256, b.id);
		const r = await w.req("GET", pdfOf(b.id), { user: "casey" });
		return r.status === 404;
	}),
	pdfDigest500: (L) => withWorld(L, {}, async (w) => {
		const { id } = await w.create();
		fs.writeFileSync(path.join(w.storageDir, w.row(id).driver_pdf_file), Buffer.from("%PDF-1.4 made-up replaced bytes".padEnd(1500, " ")));
		const r = await w.req("GET", pdfOf(id), { user: "casey" });
		return r.status === 500 && code(r) === "PDF_UNAVAILABLE";
	}),
	pdfRevokedServesDriverCopy: (L) => withWorld(L, {}, async (w) => {
		const { id } = await w.create();
		await w.countersign(id);
		await w.req("POST", revokeOf(id), { user: "admin", body: { reason: "made-up reason" } });
		const row = w.row(id);
		const r = await w.req("GET", pdfOf(id), { user: "casey" });
		return row.status === "revoked" && r.status === 200 && r.buf.equals(fs.readFileSync(path.join(w.storageDir, row.driver_pdf_file)));
	}),
	pdfAuthorizedServesFinal: (L) => withWorld(L, {}, async (w) => {
		const { id } = await w.create();
		await w.countersign(id);
		const row = w.row(id);
		const r = await w.req("GET", pdfOf(id), { user: "casey" });
		return r.status === 200 && r.buf.equals(fs.readFileSync(path.join(w.storageDir, row.final_pdf_file)));
	}),
	pdfAdminAudited: (L) => withWorld(L, {}, async (w) => {
		const { id } = await w.create();
		const before = w.count("audit_trail");
		await w.req("GET", pdfOf(id), { user: "casey" });
		const afterDriver = w.count("audit_trail");
		await w.req("GET", pdfOf(id), { user: "admin" });
		const rows = w.db.prepare("SELECT action, entity_id, details FROM audit_trail ORDER BY id DESC LIMIT 1").all();
		return afterDriver === before && w.count("audit_trail") === before + 1 && rows[0].action === "passenger_authorization_pdf_view" && rows[0].entity_id === String(id);
	}),
	pdfHeaderNosniff: (L) => withWorld(L, {}, async (w) => {
		const { id } = await w.create();
		const r = await w.req("GET", pdfOf(id), { user: "casey" });
		return r.headers["x-content-type-options"] === "nosniff";
	}),
	pdfHeaderNoStore: (L) => withWorld(L, {}, async (w) => {
		const { id } = await w.create();
		const r = await w.req("GET", pdfOf(id), { user: "casey" });
		return r.headers["cache-control"] === "private, no-store";
	}),
	jsonNoStore: (L) => withWorld(L, {}, async (w) => {
		await w.create();
		const r = await w.req("GET", LIST, { user: "casey" });
		return r.status === 200 && r.headers["cache-control"] === "no-store";
	}),
	listOwnOnly: (L) => withWorld(L, {}, async (w) => {
		await w.create("casey");
		const r = await w.req("GET", LIST, { user: "jordan" });
		return r.status === 200 && r.json.authorizations.length === 0;
	}),
	listNoImages: (L) => withWorld(L, {}, async (w) => {
		await w.create("casey");
		const r = await w.req("GET", LIST, { user: "casey" });
		const text = JSON.stringify(r.json);
		return r.status === 200 && r.json.authorizations.length === 1 && !text.includes("data:image") && !text.includes(CONSENT.text) && !text.includes(UA) && !/pa-[0-9a-f]{32}/.test(text);
	}),
	adminListNoImages: (L) => withWorld(L, {}, async (w) => {
		const { id } = await w.create("casey");
		await w.countersign(id);
		const r = await w.req("GET", `${ADMIN_LIST}?view=authorized`, { user: "admin" });
		const text = JSON.stringify(r.json);
		return r.status === 200 && r.json.authorizations.length === 1 && !text.includes("data:image") && !text.includes(CONSENT.text) && !text.includes(UA) && !/pa-[0-9a-f]{32}/.test(text);
	}),
	adminViews: (L) => withWorld(L, {}, async (w) => {
		const waiting = seedRow(w.db, {});
		const lapsed = seedRow(w.db, { valid_from: "2026-10-01", expires_on: plusDays(TODAY, -1) });
		const active = seedRow(w.db, { status: "authorized" });
		const scheduled = seedRow(w.db, { status: "authorized", valid_from: plusDays(TODAY, 5), expires_on: plusDays(TODAY, 9) });
		const over = seedRow(w.db, { status: "authorized", valid_from: "2026-10-01", expires_on: plusDays(TODAY, -1) });
		const declined = seedRow(w.db, { status: "declined" });
		const revoked = seedRow(w.db, { status: "revoked" });
		const ids = async (view) => (await w.req("GET", `${ADMIN_LIST}?view=${view}`, { user: "admin" })).json.authorizations.map((a) => a.id).sort((x, y) => x - y);
		const dflt = (await w.req("GET", ADMIN_LIST, { user: "admin" })).json.authorizations.map((a) => a.id);
		return JSON.stringify(await ids("waiting")) === JSON.stringify([waiting.id])
			&& JSON.stringify(dflt) === JSON.stringify([waiting.id])
			&& JSON.stringify(await ids("authorized")) === JSON.stringify([active.id, scheduled.id])
			&& JSON.stringify(await ids("ended")) === JSON.stringify([lapsed.id, over.id, declined.id, revoked.id].sort((x, y) => x - y));
	}),
	adminViewInvalid: (L) => withWorld(L, {}, async (w) => {
		const r = await w.req("GET", `${ADMIN_LIST}?view=everything`, { user: "admin" });
		return r.status === 400 && code(r) === "VIEW_INVALID";
	}),
	adminReviewNote: (L) => withWorld(L, {}, async (w) => {
		const r = await w.req("GET", ADMIN_LIST, { user: "admin" });
		return r.status === 200 && typeof r.json.reviewNote === "string" && /lawyer/.test(r.json.reviewNote);
	}),
	replayOneRender: (L) => withWorld(L, {}, async (w) => {
		const body = adultBody();
		const a = await w.req("POST", CREATE, { user: "casey", body });
		const b = await w.req("POST", CREATE, { user: "casey", body });
		return a.status === 201 && b.status === 200 && b.json.replay === true && b.json.authorization.id === a.json.authorization.id
			&& JSON.stringify(Object.keys(b.json.authorization).sort()) === JSON.stringify(Object.keys(a.json.authorization).sort())
			&& w.renderer.calls.length === 1 && w.count("passenger_authorizations") === 1 && w.files().length === 1;
	}),
	replayOtherDriver409: (L) => withWorld(L, {}, async (w) => {
		const body = adultBody();
		await w.req("POST", CREATE, { user: "casey", body });
		const r = await w.req("POST", CREATE, { user: "jordan", body });
		return r.status === 409 && code(r) === "REQUEST_ID_CONFLICT" && !JSON.stringify(r.json).includes("Jane Example") && w.count("passenger_authorizations") === 1;
	}),
	replayRace: (L) => withWorld(L, {}, async (w) => {
		const body = adultBody();
		w.renderer.mode = "hold";
		const p1 = w.req("POST", CREATE, { user: "casey", body });
		const p2 = w.req("POST", CREATE, { user: "casey", body });
		if (!(await w.renderer.waitHeld(2))) { w.renderer.release(); await Promise.all([p1, p2]); return false; }
		w.renderer.release();
		const rs = await Promise.all([p1, p2]);
		const statuses = rs.map((r) => r.status).sort();
		return JSON.stringify(statuses) === "[200,201]" && w.count("passenger_authorizations") === 1 && w.files().length === 1;
	}),
	openLimitBeforeRender: (L) => withWorld(L, {}, async (w) => {
		for (let i = 0; i < 10; i++) seedRow(w.db, i % 2 ? { status: "authorized" } : {});
		const r = await w.req("POST", CREATE, { user: "casey", body: adultBody() });
		return r.status === 409 && code(r) === "TOO_MANY_OPEN" && w.renderer.calls.length === 0 && w.files().length === 0;
	}),
	openLimitTenth: (L) => withWorld(L, {}, async (w) => {
		for (let i = 0; i < 9; i++) seedRow(w.db, {});
		// Ended ones never count: declined, revoked, and both kinds past their expiry.
		seedRow(w.db, { status: "declined" });
		seedRow(w.db, { status: "revoked" });
		seedRow(w.db, { valid_from: "2026-10-01", expires_on: plusDays(TODAY, -1) });
		seedRow(w.db, { status: "authorized", valid_from: "2026-10-01", expires_on: plusDays(TODAY, -1) });
		const tenth = await w.req("POST", CREATE, { user: "casey", body: adultBody() });
		const eleventh = await w.req("POST", CREATE, { user: "casey", body: adultBody() });
		const other = await w.req("POST", CREATE, { user: "jordan", body: adultBody() });
		return tenth.status === 201 && eleventh.status === 409 && code(eleventh) === "TOO_MANY_OPEN" && other.status === 201;
	}),
	openLimitRace: (L) => withWorld(L, {}, async (w) => {
		for (let i = 0; i < 9; i++) seedRow(w.db, {});
		w.renderer.mode = "hold";
		const p1 = w.req("POST", CREATE, { user: "casey", body: adultBody() });
		const p2 = w.req("POST", CREATE, { user: "casey", body: adultBody() });
		if (!(await w.renderer.waitHeld(2))) { w.renderer.release(); await Promise.all([p1, p2]); return false; }
		w.renderer.release();
		const rs = await Promise.all([p1, p2]);
		const statuses = rs.map((r) => r.status).sort();
		const open = w.db.prepare("SELECT COUNT(*) AS n FROM passenger_authorizations WHERE driver_user_id = ? AND status = 'awaiting_company'").get(USERS.casey.id).n;
		return JSON.stringify(statuses) === "[201,409]" && open === 10 && w.files().length === 1;
	}),
	nameFromAccount: (L) => withWorld(L, {}, async (w) => {
		const { r, id } = await w.create("casey", adultBody({ driverName: "Someone Else" }));
		return r.status === 201 && w.row(id).driver_name === "Casey Example" && w.renderer.calls[0].data.driverName === "Casey Example";
	}),
	namelessAccount409: (L) => withWorld(L, {}, async (w) => {
		const r = await w.req("POST", CREATE, { user: "nameless", body: adultBody() });
		return r.status === 409 && code(r) === "DRIVER_NAME_REQUIRED" && w.renderer.calls.length === 0;
	}),
	minorGuardianSigns: (L) => withWorld(L, {}, async (w) => {
		const { r, id } = await w.create("casey", minorBody());
		const row = id ? w.row(id) : {};
		return r.status === 201 && row.passenger_signature_text === "Pat Example" && row.guardian_name === "Pat Example" && row.minor_attested === 1 && row.passenger_adult === 0;
	}),
	adultGuardianBlank: (L) => withWorld(L, {}, async (w) => {
		const { r, id } = await w.create("casey", adultBody({ guardianName: "Pat Example", guardianRelationship: "Parent", minorAttested: true }));
		const row = id ? w.row(id) : {};
		return r.status === 201 && row.guardian_name === "" && row.guardian_relationship === "" && row.minor_attested === 0 && row.passenger_signature_text === "Jane Example";
	}),
	textCleaned: (L) => withWorld(L, {}, async (w) => {
		const { r, id } = await w.create("casey", adultBody({ passengerName: "  Jane‮   Example \u0007 ", tripStart: "Houston,\tTX" }));
		const row = id ? w.row(id) : {};
		return r.status === 201 && row.passenger_name === "Jane Example" && row.trip_start === "Houston, TX";
	}),
	renderGetsTwoImages: (L) => withWorld(L, {}, async (w) => {
		await w.create();
		const c = w.renderer.calls[0];
		return !!c && c.docKey === "passenger_authorization" && JSON.stringify(c.images) === JSON.stringify(["Passenger or guardian signature", "Driver signature"])
			&& c.notice === "NOT VALID UNTIL SIGNED FOR LOGISX INC.";
	}),
	fileIsTheRows: (L) => withWorld(L, {}, async (w) => {
		const a = await w.create();
		const b = await w.create();
		const ra = w.row(a.id);
		const rb = w.row(b.id);
		const fa = fs.readFileSync(path.join(w.storageDir, ra.driver_pdf_file));
		return /^pa-[0-9a-f]{32}-driver\.pdf$/.test(ra.driver_pdf_file) && ra.driver_pdf_file !== rb.driver_pdf_file
			&& sha(fa) === ra.driver_pdf_sha256 && fa.length === ra.driver_pdf_bytes && w.files().length === 2;
	}),
	noticeNamesNoRider: (L) => withWorld(L, {}, async (w) => {
		const { id } = await w.create("casey", minorBody());
		const n = w.db.prepare("SELECT * FROM dispatch_notifications").all();
		const a = w.db.prepare("SELECT * FROM audit_trail WHERE action = 'passenger_authorization_submit'").all();
		const ref = w.row(id).reference;
		const text = JSON.stringify([n, a, w.calls.dispatchEmits]);
		return n.length === 1 && a.length === 1 && n[0].body.includes(ref) && n[0].body.includes("Casey Example") && a[0].details.includes(ref)
			&& RIDER_WORDS.every((word) => !text.includes(word));
	}),
	createAudited: (L) => withWorld(L, {}, async (w) => {
		const { id } = await w.create();
		const a = w.db.prepare("SELECT * FROM audit_trail WHERE action = 'passenger_authorization_submit'").all();
		return a.length === 1 && a[0].entity === "passenger_authorization" && a[0].entity_id === String(id);
	}),
	createEmits: (L) => withWorld(L, {}, async (w) => {
		await w.create();
		return w.calls.dispatchEmits.length === 1 && w.calls.dispatchEmits[0].type === "passenger-authorization"
			&& JSON.stringify(w.calls.changes) === JSON.stringify(["passenger-authorizations"]) && JSON.stringify(w.calls.driverEmits) === JSON.stringify(["Casey Example"]);
	}),
	renderFailureRetryable: (L) => withWorld(L, {}, async (w) => {
		w.renderer.mode = "throw";
		const r = await w.req("POST", CREATE, { user: "casey", body: adultBody() });
		return r.status === 503 && code(r) === "RENDER_FAILED" && r.json.retryable === true && w.count("passenger_authorizations") === 0
			&& w.count("dispatch_notifications") === 0 && w.count("audit_trail") === 0 && w.calls.dispatchEmits.length === 0;
	}),
	renderFailureLeavesNoFile: (L) => withWorld(L, {}, async (w) => {
		w.renderer.mode = "tiny";
		const r = await w.req("POST", CREATE, { user: "casey", body: adultBody() });
		return r.status === 503 && w.files().length === 0 && w.count("passenger_authorizations") === 0;
	}),
	countersignAgain409NoRender: (L) => withWorld(L, {}, async (w) => {
		const { id } = await w.create();
		await w.countersign(id);
		const before = w.renderer.calls.length;
		const r = await w.countersign(id);
		return r.status === 409 && code(r) === "ALREADY_DECIDED" && w.renderer.calls.length === before;
	}),
	countersignExpired409NoRender: (L) => withWorld(L, {}, async (w) => {
		const row = seedRow(w.db, { valid_from: "2026-10-01", expires_on: plusDays(TODAY, -1) });
		const r = await w.countersign(row.id);
		return r.status === 409 && code(r) === "AUTHORIZATION_EXPIRED" && w.renderer.calls.length === 0;
	}),
	countersignIncomplete: (L) => withWorld(L, {}, async (w) => {
		const row = seedRow(w.db, { truck_unit: "" });
		const r = await w.countersign(row.id);
		return r.status === 409 && code(r) === "AUTHORIZATION_INCOMPLETE" && w.renderer.calls.length === 0 && w.row(row.id).status === "awaiting_company";
	}),
	countersignFields: (L) => withWorld(L, {}, async (w) => {
		const { id } = await w.create();
		const r = await w.countersign(id);
		const row = w.row(id);
		return r.status === 200 && row.status === "authorized" && row.company_printed_name === "Sam Example" && row.company_title === "Safety Manager"
			&& row.company_account === "super_admin" && row.company_user_id === 1 && row.company_signed_on === "November 3, 2026"
			&& row.company_consent_text === CONSENT.text && row.company_signature_image === PNG_COMPANY && row.company_signed_user_agent === UA;
	}),
	countersignValidation: (L) => withWorld(L, {}, async (w) => {
		const { id } = await w.create();
		const cases = [
			[{ printedName: "S" }, 400, "PRINTED_NAME_REQUIRED"],
			[{ printedName: LONG(101) }, 400, "PRINTED_NAME_REQUIRED"],
			[{ title: undefined }, 400, "TITLE_REQUIRED"],
			[{ title: LONG(61) }, 400, "TITLE_REQUIRED"],
			[{ signatureImage: undefined }, 400, "SIGNATURE_REQUIRED"],
			[{ signatureImage: "https://example.com/made-up.png" }, 415, "UNSUPPORTED_IMAGE_TYPE"],
			[{ consent: { agreed: 1 } }, 400, "CONSENT_REQUIRED"],
		];
		for (const [over, status, c] of cases) {
			const r = await w.countersign(id, over);
			if (r.status !== status || code(r) !== c) return false;
		}
		return w.row(id).status === "awaiting_company" && w.renderer.calls.length === 1;
	}),
	countersignNewFinalFile: (L) => withWorld(L, {}, async (w) => {
		const { id } = await w.create();
		const before = w.row(id);
		const driverBytes = fs.readFileSync(path.join(w.storageDir, before.driver_pdf_file));
		await w.countersign(id);
		const after = w.row(id);
		const finalBytes = fs.readFileSync(path.join(w.storageDir, after.final_pdf_file));
		const c = w.renderer.calls[w.renderer.calls.length - 1];
		return /^pa-[0-9a-f]{32}-final\.pdf$/.test(after.final_pdf_file) && after.driver_pdf_file === before.driver_pdf_file
			&& sha(fs.readFileSync(path.join(w.storageDir, after.driver_pdf_file))) === before.driver_pdf_sha256 && sha(driverBytes) === before.driver_pdf_sha256
			&& sha(finalBytes) === after.final_pdf_sha256 && finalBytes.length === after.final_pdf_bytes
			&& c.images.length === 3 && c.images.includes("Company signature") && c.notice === "AUTHORIZED BY LOGISX INC.";
	}),
	countersignNotice: (L) => withWorld(L, {}, async (w) => {
		const { id } = await w.create("casey", minorBody());
		await w.countersign(id);
		const n = w.db.prepare("SELECT * FROM notifications").all();
		const ref = w.row(id).reference;
		return n.length === 1 && n[0].driver_name === "casey example" && n[0].type === "passenger_authorization" && n[0].body.includes(ref)
			&& n[0].body.includes("November 3, 2026 to November 9, 2026") && RIDER_WORDS.every((word) => !JSON.stringify(n).includes(word))
			&& w.calls.driverEmits[w.calls.driverEmits.length - 1] === "Casey Example";
	}),
	countersignAudited: (L) => withWorld(L, {}, async (w) => {
		const { id } = await w.create();
		await w.countersign(id);
		const a = w.db.prepare("SELECT * FROM audit_trail WHERE action = 'passenger_authorization_countersign'").all();
		return a.length === 1 && a[0].entity_id === String(id) && a[0].username === "super_admin";
	}),
	noticeToCurrentName: (L) => withWorld(L, {}, async (w) => {
		const { id } = await w.create();
		w.db.prepare("UPDATE users SET driver_name = 'Casey Q. Example' WHERE id = ?").run(USERS.casey.id);
		await w.countersign(id);
		const n = w.db.prepare("SELECT driver_name FROM notifications").all();
		const c = w.renderer.calls[w.renderer.calls.length - 1];
		return n.length === 1 && n[0].driver_name === "casey q. example" && c.data.driverName === "Casey Example"
			&& w.calls.driverEmits[w.calls.driverEmits.length - 1] === "Casey Q. Example";
	}),
	raceDeclineDuringCountersign: (L) => withWorld(L, {}, async (w) => {
		const { id } = await w.create();
		w.renderer.mode = "hold";
		const p = w.countersign(id);
		if (!(await w.renderer.waitHeld(1))) { w.renderer.release(); await p; return false; }
		const d = await w.req("POST", declineOf(id), { user: "admin", body: { reason: "made-up reason" } });
		w.renderer.release();
		const r = await p;
		const row = w.row(id);
		return d.status === 200 && r.status === 409 && code(r) === "ALREADY_DECIDED" && row.status === "declined"
			&& row.company_printed_name === "" && row.final_pdf_file === "" && !w.files().some((f) => f.endsWith("-final.pdf"));
	}),
	raceExpiryDuringCountersign: (L) => withWorld(L, {}, async (w) => {
		const { id } = await w.create("casey", adultBody({ validFrom: TODAY, expiresOn: TODAY }));
		w.renderer.mode = "hold";
		const p = w.countersign(id);
		if (!(await w.renderer.waitHeld(1))) { w.renderer.release(); await p; return false; }
		w.state.today = plusDays(TODAY, 1);
		w.renderer.release();
		const r = await p;
		const row = w.row(id);
		return r.status === 409 && code(r) === "AUTHORIZATION_EXPIRED" && row.status === "awaiting_company" && row.final_pdf_file === ""
			&& !w.files().some((f) => f.endsWith("-final.pdf"));
	}),
	declineFlow: (L) => withWorld(L, {}, async (w) => {
		const { id } = await w.create();
		const r = await w.req("POST", declineOf(id), { user: "admin", body: { reason: "  The trip end needs a city ‮ " } });
		const row = w.row(id);
		const audit = w.db.prepare("SELECT details FROM audit_trail WHERE action = 'passenger_authorization_decline'").all();
		const n = w.db.prepare("SELECT body FROM notifications").all();
		return r.status === 200 && row.status === "declined" && row.decided_reason === "The trip end needs a city" && row.decided_by === "super_admin"
			&& /^\d{4}-\d{2}-\d{2}T/.test(row.decided_at) && audit.length === 1 && !audit[0].details.includes("trip end")
			&& n.length === 1 && n[0].body.includes("declined") && n[0].body.includes(row.reference);
	}),
	declineOnlyAwaiting: (L) => withWorld(L, {}, async (w) => {
		const { id } = await w.create();
		await w.countersign(id);
		const r = await w.req("POST", declineOf(id), { user: "admin", body: { reason: "made-up reason" } });
		return r.status === 409 && code(r) === "ALREADY_DECIDED" && w.row(id).status === "authorized";
	}),
	revokeOnlyAuthorized: (L) => withWorld(L, {}, async (w) => {
		const { id } = await w.create();
		const r = await w.req("POST", revokeOf(id), { user: "admin", body: { reason: "made-up reason" } });
		return r.status === 409 && code(r) === "NOT_REVOCABLE" && w.row(id).status === "awaiting_company";
	}),
	reasonBounds: (L) => withWorld(L, {}, async (w) => {
		const { id } = await w.create();
		const a = await w.req("POST", declineOf(id), { user: "admin", body: { reason: "x" } });
		const b = await w.req("POST", declineOf(id), { user: "admin", body: { reason: LONG(301) } });
		const c = await w.req("POST", declineOf(id), { user: "admin", body: {} });
		const okd = await w.req("POST", declineOf(id), { user: "admin", body: { reason: LONG(300) } });
		return [a, b, c].every((r) => r.status === 400 && code(r) === "REASON_REQUIRED") && okd.status === 200;
	}),
	revokeFlow: (L) => withWorld(L, {}, async (w) => {
		const { id } = await w.create();
		await w.countersign(id);
		const r = await w.req("POST", revokeOf(id), { user: "admin", body: { reason: "made-up reason" } });
		const row = w.row(id);
		const n = w.db.prepare("SELECT body FROM notifications ORDER BY id DESC LIMIT 1").get();
		return r.status === 200 && row.status === "revoked" && row.decided_by === "super_admin" && !!n && n.body.includes("ended");
	}),
	ids404: (L) => withWorld(L, {}, async (w) => {
		const rs = await Promise.all(["abc", "0", "1e3", "99999", "-1"].map((x) => w.req("POST", countersignOf(x), { user: "admin", body: countersignBody() })));
		const ps = await Promise.all(["abc", "0", "99999"].map((x) => w.req("GET", pdfOf(x), { user: "admin" })));
		return [...rs, ...ps].every((r) => r.status === 404);
	}),
	createLimiter: (L) => withWorld(L, {}, async (w) => {
		const statuses = [];
		for (let i = 0; i < 11; i++) statuses.push((await w.req("POST", CREATE, { user: "jordan", body: adultBody() })).status);
		return JSON.stringify(statuses) === JSON.stringify([...Array(10).fill(201), 429]);
	}),
	signerEvidence: (L) => withWorld(L, {}, async (w) => {
		const { id } = await w.create();
		const row = w.row(id);
		return row.driver_signed_user_agent === UA && ["proxy", "socket"].includes(row.driver_signed_ip_source) && row.driver_signed_ip !== ""
			&& row.passenger_consent_text === CONSENT.text && row.driver_consent_text === CONSENT.text && /^\d{4}-\d{2}-\d{2}T.*Z$/.test(row.driver_signed_at);
	}),
	printedDates: (L) => withWorld(L, {}, async (w) => {
		const { id } = await w.create("casey", adultBody({ validFrom: "2026-11-30", expiresOn: "2027-01-02" }));
		const d = w.renderer.calls[0].data;
		return w.row(id).driver_signed_on === "November 3, 2026" && d.validFrom === "November 30, 2026" && d.expiresOn === "January 2, 2027"
			&& d.passengerSignedOn === "November 3, 2026" && d.driverSignedOn === "November 3, 2026";
	}),
	featureNeedsSignIn: (L) => withWorld(L, {}, async (w) => (await w.req("GET", FEATURE)).status === 401),
	needAccount: (L) => withWorld(L, {}, async (w) => {
		await w.create();
		const r = await w.req("GET", LIST, { user: "noid" });
		return r.status === 403 && code(r) === "SIGN_IN_AGAIN";
	}),
	accountNoLongerDriver: (L) => withWorld(L, {}, async (w) => {
		w.db.prepare("UPDATE users SET role = 'Dispatcher' WHERE id = ?").run(USERS.casey.id);
		const r = await w.req("POST", CREATE, { user: "casey", body: adultBody() });
		return r.status === 403 && code(r) === "SIGN_IN_AGAIN" && w.renderer.calls.length === 0;
	}),
	formPdf: (L) => withWorld(L, {}, async (w) => {
		const r = await w.req("GET", FORM, { user: "casey" });
		const c = w.renderer.calls[0] || {};
		return r.status === 200 && r.headers["content-type"] === "application/pdf" && r.headers["content-disposition"] === 'inline; filename="passenger-authorization-form.pdf"'
			&& r.headers["cache-control"] === "private, no-store" && r.buf.subarray(0, 4).toString("latin1") === "%PDF"
			&& c.docKey === "passenger_authorization" && JSON.stringify(c.data) === JSON.stringify({ driverName: "Casey Example" }) && w.files().length === 0;
	}),
	formFailure: (L) => withWorld(L, {}, async (w) => {
		w.renderer.mode = "throw";
		const r = await w.req("GET", FORM, { user: "casey" });
		return r.status === 503 && code(r) === "RENDER_FAILED" && r.json.retryable === true;
	}),
	pdfFormerDriverNow404: (L) => withWorld(L, {}, async (w) => {
		const { id } = await w.create();
		w.db.prepare("UPDATE passenger_authorizations SET driver_user_id = ? WHERE id = ?").run(USERS.dispatch.id, id);
		const r = await w.req("GET", pdfOf(id), { user: "dispatch" });
		return r.status === 404;
	}),
	pdfFilenameSafe: (L) => withWorld(L, {}, async (w) => {
		const { id } = await w.create();
		w.db.prepare("UPDATE passenger_authorizations SET reference = ? WHERE id = ?").run('PA-1"x', id);
		const r = await w.req("GET", pdfOf(id), { user: "casey" });
		return r.status === 200 && r.headers["content-disposition"] === `inline; filename="passenger-authorization-${id}.pdf"`;
	}),
	pdfMissing404: (L) => withWorld(L, {}, async (w) => {
		const { id } = await w.create();
		fs.unlinkSync(path.join(w.storageDir, w.row(id).driver_pdf_file));
		const r = await w.req("GET", pdfOf(id), { user: "casey" });
		return r.status === 404 && code(r) === "NOT_FOUND";
	}),
	idsStrict: (L) => withWorld(L, {}, async (w) => {
		const { id } = await w.create();
		const a = await w.req("GET", pdfOf(`0${id}`), { user: "casey" });
		const b = await w.req("GET", pdfOf(`${id}.0`), { user: "casey" });
		const c = await w.req("POST", countersignOf(`0${id}`), { user: "admin", body: countersignBody() });
		return a.status === 404 && b.status === 404 && c.status === 404 && w.row(id).status === "awaiting_company";
	}),
	createSaveFailureCleans: (L) => withWorld(L, {}, async (w) => {
		w.db.exec("CREATE TRIGGER made_up_insert_failure BEFORE INSERT ON passenger_authorizations BEGIN SELECT RAISE(ABORT, 'made-up failure'); END;");
		const r = await w.req("POST", CREATE, { user: "casey", body: adultBody() });
		return r.status === 503 && r.json.reason === "SAVE_FAILED" && r.json.retryable === true && w.files().length === 0 && w.count("dispatch_notifications") === 0;
	}),
	createAtomic: (L) => withWorld(L, {}, async (w) => {
		w.db.exec("CREATE TRIGGER made_up_audit_failure BEFORE INSERT ON audit_trail BEGIN SELECT RAISE(ABORT, 'made-up failure'); END;");
		const r = await w.req("POST", CREATE, { user: "casey", body: adultBody() });
		return r.status === 503 && w.count("passenger_authorizations") === 0 && w.files().length === 0;
	}),
	countersignSaveFailureCleans: (L) => withWorld(L, {}, async (w) => {
		const { id } = await w.create();
		w.db.exec("CREATE TRIGGER made_up_update_failure BEFORE UPDATE ON passenger_authorizations BEGIN SELECT RAISE(ABORT, 'made-up failure'); END;");
		const r = await w.countersign(id);
		return r.status === 500 && w.row(id).status === "awaiting_company" && !w.files().some((f) => f.endsWith("-final.pdf"));
	}),
	// The reference is checked against those on file: the first one drawn here collides.
	referenceUnique: (L) => withWorld(L, {}, async (w) => {
		seedRow(w.db, { reference: "PA-00000000" });
		const real = crypto.randomBytes;
		let first = true;
		crypto.randomBytes = function (n, ...rest) {
			if (n === 4 && first) { first = false; return Buffer.alloc(4); }
			return real.call(crypto, n, ...rest);
		};
		let r;
		try { r = await w.req("POST", CREATE, { user: "casey", body: adultBody() }); } finally { crypto.randomBytes = real; }
		return !first && r.status === 201 && r.json.authorization.reference !== "PA-00000000";
	}),
	countersignEmits: (L) => withWorld(L, {}, async (w) => {
		const { id } = await w.create();
		await w.countersign(id);
		return JSON.stringify(w.calls.changes) === JSON.stringify(["passenger-authorizations", "passenger-authorizations"]);
	}),
	declineEmits: (L) => withWorld(L, {}, async (w) => {
		const { id } = await w.create();
		await w.req("POST", declineOf(id), { user: "admin", body: { reason: "made-up reason" } });
		return JSON.stringify(w.calls.changes) === JSON.stringify(["passenger-authorizations", "passenger-authorizations"])
			&& JSON.stringify(w.calls.driverEmits) === JSON.stringify(["Casey Example", "Casey Example"]);
	}),
	// Each route stops a caller at its own count (per 15 minutes), counting refusals too.
	limiterForm: (L) => withWorld(L, {}, async (w) => {
		for (let i = 0; i < 30; i++) if ((await w.req("GET", FORM, { user: "casey" })).status !== 200) return false;
		return (await w.req("GET", FORM, { user: "casey" })).status === 429;
	}),
	limiterPdf: (L) => withWorld(L, {}, async (w) => {
		for (let i = 0; i < 60; i++) if ((await w.req("GET", pdfOf(99999), { user: "casey" })).status !== 404) return false;
		return (await w.req("GET", pdfOf(99999), { user: "casey" })).status === 429;
	}),
	limiterList: (L) => withWorld(L, {}, async (w) => {
		for (let i = 0; i < 120; i++) if ((await w.req("GET", LIST, { user: "casey" })).status !== 200) return false;
		return (await w.req("GET", LIST, { user: "casey" })).status === 429;
	}),
	limiterAdminList: (L) => withWorld(L, {}, async (w) => {
		for (let i = 0; i < 120; i++) if ((await w.req("GET", ADMIN_LIST, { user: "admin" })).status !== 200) return false;
		return (await w.req("GET", ADMIN_LIST, { user: "admin" })).status === 429;
	}),
	limiterCountersign: (L) => withWorld(L, {}, async (w) => {
		for (let i = 0; i < 30; i++) if ((await w.req("POST", countersignOf(99999), { user: "admin", body: countersignBody() })).status !== 404) return false;
		return (await w.req("POST", countersignOf(99999), { user: "admin", body: countersignBody() })).status === 429;
	}),
	limiterDecline: (L) => withWorld(L, {}, async (w) => {
		for (let i = 0; i < 30; i++) if ((await w.req("POST", declineOf(99999), { user: "admin", body: { reason: "made-up reason" } })).status !== 404) return false;
		return (await w.req("POST", declineOf(99999), { user: "admin", body: { reason: "made-up reason" } })).status === 429;
	}),
	limiterRevoke: (L) => withWorld(L, {}, async (w) => {
		for (let i = 0; i < 30; i++) if ((await w.req("POST", revokeOf(99999), { user: "admin", body: { reason: "made-up reason" } })).status !== 404) return false;
		return (await w.req("POST", revokeOf(99999), { user: "admin", body: { reason: "made-up reason" } })).status === 429;
	}),
	limiterPerAccount: (L) => withWorld(L, {}, async (w) => {
		for (let i = 0; i < 61; i++) await w.req("GET", pdfOf(99999), { user: "casey" });
		const casey = await w.req("GET", pdfOf(99999), { user: "casey" });
		const jordan = await w.req("GET", pdfOf(99999), { user: "jordan" });
		return casey.status === 429 && jordan.status === 404;
	}),
};

// Each check's answer on the real module, worked out once: the sections report it,
// and §11 needs it to hold before a mutant may count as caught.
const realResults = new Map();
async function holds(name, check = CHECK[name]) {
	if (!realResults.has(name)) {
		let v;
		try { v = await check(realLib()); } catch { v = false; }
		realResults.set(name, v);
	}
	return realResults.get(name);
}

(async () => {
	// ── §1 flag off ────────────────────────────────────────────────────────────
	await part("§1 flag off", async () => {
		const w = await world({ on: false });
		try {
			const f = await w.req("GET", FEATURE, { user: "casey" });
			eq([f.status, f.json.enabled], [200, false], "§1 the feature route answers { enabled: false }");
			eq((await w.req("GET", FEATURE)).status, 401, "§1 ...signed out, 401");
			const routes = [
				["GET", FORM, "casey"], ["GET", LIST, "casey"], ["POST", CREATE, "casey"], ["GET", pdfOf(1), "casey"], ["GET", pdfOf(1), "admin"],
				["GET", pdfOf(1), "dispatch"], ["GET", ADMIN_LIST, "admin"], ["POST", countersignOf(1), "admin"], ["POST", declineOf(1), "admin"],
				["POST", revokeOf(1), "admin"],
			];
			for (const [m, p, u] of routes) {
				const r = await w.req(m, p, { user: u, body: m === "POST" ? (p === CREATE ? adultBody() : countersignBody({ reason: "made-up reason" })) : undefined });
				eq([r.status, code(r)], [404, "FEATURE_OFF"], `§1 ${m} ${p} as ${u}: 404 FEATURE_OFF`);
			}
			// The role guard answers first.
			eq((await w.req("GET", LIST)).status, 401, "§1 signed out on the driver list: 401, not 404");
			eq((await w.req("GET", ADMIN_LIST, { user: "casey" })).status, 403, "§1 a Driver on the admin list: 403, not 404");
			eq((await w.req("POST", CREATE, { user: "dispatch", body: adultBody() })).status, 403, "§1 a Dispatcher filing one: 403, not 404");
			eq((await w.req("POST", CREATE, { user: "casey", body: adultBody(), xrw: false })).status, 403, "§1 a write without X-Requested-With: 403, not 404");
			ok(!tableExists(w.db), "§1 no table is made");
			ok(!fs.existsSync(w.storageDir), "§1 no storage folder is made");
			eq(w.renderer.calls.length, 0, "§1 nothing is rendered");
			eq([w.count("audit_trail"), w.count("notifications"), w.count("dispatch_notifications")], [0, 0, 0], "§1 no audit row and no notice");
			eq([w.calls.dispatchEmits.length, w.calls.driverEmits.length, w.calls.changes.length], [0, 0, 0], "§1 no live event");
		} finally { await w.close(); }
		const L = realLib();
		eq([L.enabled({}), L.enabled({ PASSENGER_AUTHORIZATION_ENABLED: "true" }), L.enabled({ PASSENGER_AUTHORIZATION_ENABLED: "TRUE" }),
			L.enabled({ PASSENGER_AUTHORIZATION_ENABLED: "1" }), L.enabled({ PASSENGER_AUTHORIZATION_ENABLED: " true" }), L.enabled(null)],
		[false, true, false, false, false, false], "§1 the flag is on only for exactly \"true\"");
		ok(await holds("onFeatureTrue"), "§1 on, the feature route answers { enabled: true } to any signed-in role");
		ok(await holds("featureNeedsSignIn"), "§1 ...and only to a signed-in one");
		let threw = false;
		try { L.mount(express(), { db: new Database(":memory:"), enabled: false }); } catch { threw = true; }
		ok(threw, "§1 a mount missing its dependencies throws at start, not at the first request");
	});

	// ── §2 roles ────────────────────────────────────────────────────────────────
	await part("§2 roles", async () => {
		const w = await world();
		try {
			const { id } = await w.create();
			ok(!!id, "§2 (fixture) a driver's authorization exists");
			const all = [["GET", FEATURE], ["GET", FORM], ["GET", LIST], ["POST", CREATE], ["GET", pdfOf(id)], ["GET", ADMIN_LIST],
				["POST", countersignOf(id)], ["POST", declineOf(id)], ["POST", revokeOf(id)]];
			for (const [m, p] of all) eq((await w.req(m, p, { body: m === "POST" ? {} : undefined })).status, 401, `§2 signed out: ${m} ${p} 401`);
			const csrf = await w.req("POST", CREATE, { user: "casey", body: adultBody(), xrw: false });
			eq([csrf.status, code(csrf)], [403, "CSRF_HEADER_REQUIRED"], "§2 a Driver's write without X-Requested-With is refused");
			const csrf2 = await w.req("POST", countersignOf(id), { user: "admin", body: countersignBody(), xrw: false });
			eq([csrf2.status, code(csrf2)], [403, "CSRF_HEADER_REQUIRED"], "§2 ...and a Super Admin's");
			for (const [m, p] of [["GET", ADMIN_LIST], ["POST", countersignOf(id)], ["POST", declineOf(id)], ["POST", revokeOf(id)]]) {
				const r = await w.req(m, p, { user: "casey", body: m === "POST" ? countersignBody({ reason: "made-up reason" }) : undefined });
				eq([r.status, r.json.error], [403, "Forbidden"], `§2 a Driver on ${m} ${p}: 403`);
			}
			for (const who of ["dispatch", "investor"]) {
				for (const [m, p] of [["GET", FORM], ["GET", LIST], ["POST", CREATE]]) {
					const r = await w.req(m, p, { user: who, body: m === "POST" ? adultBody() : undefined });
					eq([r.status, r.json.error], [403, "Forbidden"], `§2 ${who} on ${m} ${p}: 403`);
				}
				const r = await w.req("GET", pdfOf(id), { user: who });
				eq([r.status, code(r)], [404, "NOT_FOUND"], `§2 ${who} on the PDF route: 404, never 403`);
				eq((await w.req("GET", ADMIN_LIST, { user: who })).status, 403, `§2 ${who} on the admin list: 403`);
			}
			for (const [m, p] of [["GET", FORM], ["GET", LIST], ["POST", CREATE]]) {
				const r = await w.req(m, p, { user: "admin", body: m === "POST" ? adultBody() : undefined });
				eq([r.status, r.json.error], [403, "Forbidden"], `§2 a Super Admin on the driver's ${m} ${p}: 403`);
			}
			for (const [m, p] of [["GET", FORM], ["GET", LIST], ["POST", CREATE]]) {
				const r = await w.req(m, p, { user: "noid", body: m === "POST" ? adultBody() : undefined });
				eq([r.status, code(r)], [403, "SIGN_IN_AGAIN"], `§2 a Driver session with no account id on ${m} ${p}: asked to sign in again`);
			}
			eq((await w.req("GET", pdfOf(id), { user: "noid" })).status, 404, "§2 ...and 404 on the PDF route");
			eq(w.count("passenger_authorizations"), 1, "§2 no refusal wrote a row");
		} finally { await w.close(); }
		for (const name of ["crossSiteCreate", "crossSiteCountersign", "crossSiteDecline", "crossSiteRevoke"]) ok(await holds(name), `§2 ${name}: a cross-site write is refused (403 CROSS_SITE_REFUSED) and changes nothing`);
		for (const name of ["createRoleDriverOnly", "listRoleDriverOnly", "formRoleDriverOnly", "adminListSuperAdminOnly", "countersignSuperAdminOnly", "declineSuperAdminOnly", "revokeSuperAdminOnly"]) {
			ok(await holds(name), `§2 ${name}: refused by the role guard`);
		}
		ok(await holds("needAccount"), "§2 needAccount: a Driver session with no account id is asked to sign in again");
		ok(await holds("accountNoLongerDriver"), "§2 accountNoLongerDriver: a session whose account is no longer a Driver files nothing");
		for (const name of ["limiterForm", "limiterPdf", "limiterList", "limiterAdminList", "limiterCountersign", "limiterDecline", "limiterRevoke", "limiterPerAccount"]) {
			ok(await holds(name), `§2 ${name}: each route's own limit per account per 15 minutes, refusals counted`);
		}
	});

	// ── §3 validation ──────────────────────────────────────────────────────────
	await part("§3 validation", async () => {
		const L = realLib();
		ok(IMG.checkSignatureImage(PNG_PASSENGER).ok === true && RENDERER.safeSignatureImage(PNG_PASSENGER) === PNG_PASSENGER, "§3 (fixture) the made-up PNG passes both image rules");
		ok(IMG.checkSignatureImage(PNG_RENDERER_DROPS).ok === true && RENDERER.safeSignatureImage(PNG_RENDERER_DROPS) === null, "§3 (fixture) the dashed PNG passes the image check and not the renderer's");
		// Refusals count against the filing limit (10 per 15 minutes), so 9 cases a world.
		const names = Object.keys(VCASES);
		for (let i = 0; i < names.length; i += 9) {
			const w = await world({ lib: L });
			try {
				for (const name of names.slice(i, i + 9)) {
					const [change, status, wantCode, where] = VCASES[name];
					const r = await w.req("POST", CREATE, { user: "jordan", body: change(adultBody()) });
					eq([r.status, code(r), where === undefined ? undefined : (r.json.field || r.json.signer)], [status, wantCode, where], `§3 ${name}`);
				}
				eq([w.count("passenger_authorizations"), w.renderer.calls.length], [0, 0], `§3 cases ${i + 1}-${Math.min(i + 9, names.length)}: no refusal wrote a row or rendered anything`);
			} finally { await w.close(); }
		}
		ok(await accepts(["startToday", "startPlus90", "expiryPlus365", "name100", "truck20", "trip120", "relationship40"])(L), "§3 the edges are accepted: today, today+90, expiry = start, start+365, 100-character name, 20-character truck, 120-character trip points, 40-character relationship");
		ok(await holds("textCleaned"), "§3 text is cleaned: control and direction characters out, runs of spaces folded, ends trimmed");
		ok(await holds("adultGuardianBlank"), "§3 an adult's guardian fields are stored blank whatever was sent");
		eq(L.validateSubmission(adultBody({ validFrom: TODAY }), { todayKey: "", cleanText: H.sanitizeEvidenceText }).code, "DATES_INVALID", "§3 with no business day, no date is accepted");
	});

	// ── §4 create ──────────────────────────────────────────────────────────────
	await part("§4 create", async () => {
		const L = realLib();
		const w = await world({ lib: L });
		try {
			const { r, id } = await w.create();
			eq(r.status, 201, "§4 an adult's authorization is filed: 201");
			const a = r.json.authorization || {};
			eq(Object.keys(a).sort(), ["companyPrintedName", "companySignedOn", "companyTitle", "createdAt", "decidedAt", "displayStatus", "driverName", "driverSignedAt",
				"driverSignedOn", "expiresOn", "formVersion", "guardianName", "guardianRelationship", "id", "minorAttested", "passengerAdult", "passengerName",
				"reference", "status", "tripEnd", "tripStart", "truckUnit", "validFrom"], "§4 the answer carries the public fields only");
			ok(!JSON.stringify(r.json).includes("data:image") && !JSON.stringify(r.json).includes(UA), "§4 ...no image and no signer evidence");
			eq([a.status, a.displayStatus, a.formVersion, a.driverName, a.passengerName, a.passengerAdult, a.truckUnit, a.validFrom, a.expiresOn],
				["awaiting_company", "awaiting_company", "PA-1", "Casey Example", "Jane Example", true, "T-0000", TODAY, "2026-11-09"], "§4 awaiting the company, as filed");
			ok(/^PA-[0-9A-F]{8}$/.test(a.reference), `§4 the reference is PA- and 8 hex characters (${a.reference})`);
			const c = w.renderer.calls[0] || {};
			eq([w.renderer.calls.length, c.docKey], [1, "passenger_authorization"], "§4 one render, of the passenger authorization");
			eq(c.images, ["Passenger or guardian signature", "Driver signature"], "§4 the render gets the passenger's and the driver's images, and no company image");
			eq(c.notice, "NOT VALID UNTIL SIGNED FOR LOGISX INC.", "§4 ...and reads NOT VALID");
			const row = w.row(id);
			eq(w.files(), [row.driver_pdf_file], "§4 one file, under the storage folder, named in the row");
			const bytes = fs.readFileSync(path.join(w.storageDir, row.driver_pdf_file));
			eq([sha(bytes), bytes.length], [row.driver_pdf_sha256, row.driver_pdf_bytes], "§4 the file's sha256 and size are the row's");
			eq([row.driver_user_id, row.passenger_signature_text, row.driver_signature_text, row.passenger_signature_image, row.driver_signature_image],
				[USERS.casey.id, "Jane Example", "Casey Example", PNG_PASSENGER, PNG_DRIVER], "§4 the signers and their images are stored for the countersign render");
			eq(w.db.prepare("SELECT COUNT(*) AS n FROM passenger_authorizations WHERE request_id = ?").get(r.json.authorization ? row.request_id : "").n, 1, "§4 the request id is stored");
		} finally { await w.close(); }
		for (const name of ["renderGetsTwoImages", "fileIsTheRows", "nameFromAccount", "namelessAccount409", "minorGuardianSigns", "signerEvidence", "printedDates",
			"replayOneRender", "replayOtherDriver409", "replayRace", "openLimitBeforeRender", "openLimitTenth", "openLimitRace", "noticeNamesNoRider", "createAudited",
			"createEmits", "listOwnOnly", "listNoImages", "jsonNoStore", "createLimiter", "referenceUnique", "createSaveFailureCleans", "createAtomic",
			"formPdf", "formFailure"]) {
			ok(await holds(name), `§4 ${name}`);
		}
		const lw = await world({ lib: L });
		try {
			await lw.create("casey", adultBody({ passengerName: "Jane Example" }));
			await lw.create("casey", adultBody({ passengerName: "Morgan Example" }));
			const list = await lw.req("GET", LIST, { user: "casey" });
			eq(list.json.authorizations.map((x) => x.passengerName), ["Morgan Example", "Jane Example"], "§4 the driver's list is his own, newest first");
		} finally { await lw.close(); }
	});

	// ── §5 render failure ──────────────────────────────────────────────────────
	await part("§5 render failure", async () => {
		const L = realLib();
		for (const mode of ["throw", "not-pdf", "tiny"]) {
			const w = await world({ lib: L });
			try {
				w.renderer.mode = mode;
				const body = adultBody();
				const r = await w.req("POST", CREATE, { user: "casey", body });
				eq([r.status, code(r), r.json.retryable], [503, "RENDER_FAILED", true], `§5 a render that ${mode === "throw" ? "fails" : mode === "not-pdf" ? "answers no PDF" : "is cut short"}: 503 retryable`);
				eq([w.count("passenger_authorizations"), w.count("dispatch_notifications"), w.count("audit_trail"), w.calls.dispatchEmits.length], [0, 0, 0, 0], `§5 ...${mode}: no row, no notice, no audit row`);
				eq(w.files(), [], `§5 ...${mode}: no file left behind`);
				w.renderer.mode = "ok";
				const again = await w.req("POST", CREATE, { user: "casey", body });
				eq(again.status, 201, `§5 ...${mode}: the same request again succeeds once the renderer does`);
			} finally { await w.close(); }
		}
		ok(!realLib().PDF_FILE_RE.test("x-driver.pdf") && realLib().PDF_FILE_RE.test(`pa-${"a".repeat(32)}-final.pdf`), "§5 (pattern) only pa-<32 hex>-(driver|final).pdf is a stored name");
	});

	// ── §6 countersign, decline, revoke ────────────────────────────────────────
	await part("§6 countersign, decline, revoke", async () => {
		const L = realLib();
		for (const name of ["countersignFields", "countersignNewFinalFile", "countersignNotice", "countersignAudited", "countersignAgain409NoRender",
			"countersignExpired409NoRender", "countersignIncomplete", "countersignValidation", "noticeToCurrentName", "raceDeclineDuringCountersign",
			"raceExpiryDuringCountersign", "declineFlow", "declineOnlyAwaiting", "revokeOnlyAuthorized", "reasonBounds", "revokeFlow", "ids404", "idsStrict",
			"countersignSaveFailureCleans", "countersignEmits", "declineEmits"]) {
			ok(await holds(name), `§6 ${name}`);
		}
		const w = await world({ lib: L });
		try {
			const { id } = await w.create("jordan");
			w.db.prepare("DELETE FROM users WHERE id = ?").run(USERS.jordan.id);
			const r = await w.countersign(id);
			eq([r.status, w.row(id).status, w.count("notifications"), w.calls.driverEmits.includes("Jordan Example") && w.calls.driverEmits.length === 1],
				[200, "authorized", 0, true], "§6 a deleted driver's authorization can still be signed; no notice goes to a name no account holds");
			ok(r.json.authorization && r.json.authorization.displayStatus === "active" && r.json.authorization.companyAccount === "super_admin", "§6 the answer reads active, signed by the account");
		} finally { await w.close(); }
	});

	// ── §7 the PDF route ───────────────────────────────────────────────────────
	await part("§7 the PDF route", async () => {
		const L = realLib();
		const w = await world({ lib: L });
		try {
			const { id } = await w.create();
			const row = w.row(id);
			const r = await w.req("GET", pdfOf(id), { user: "casey" });
			eq([r.status, r.headers["content-type"], r.headers["content-disposition"], r.headers["cache-control"], r.headers["x-content-type-options"]],
				[200, "application/pdf", `inline; filename="passenger-authorization-${row.reference}.pdf"`, "private, no-store", "nosniff"], "§7 the owner gets it, with the four headers");
			ok(r.buf.equals(fs.readFileSync(path.join(w.storageDir, row.driver_pdf_file))), "§7 ...the driver-stage file's bytes");
			ok(!r.headers["content-security-policy"], "§7 ...and no CSP sandbox (it would stop the phone's PDF viewer in the form's frame)");
			// A planted file outside the folder, and a row naming it.
			const outside = path.join(path.dirname(w.storageDir), "x.pdf");
			const planted = Buffer.from("%PDF-1.4 made-up file outside the folder".padEnd(1200, " "));
			fs.writeFileSync(outside, planted);
			w.db.prepare("UPDATE passenger_authorizations SET driver_pdf_file = '../x.pdf', driver_pdf_sha256 = ? WHERE id = ?").run(sha(planted), id);
			const t = await w.req("GET", pdfOf(id), { user: "casey" });
			ok(t.status === 404 && !t.buf.equals(planted), "§7 a stored name that leaves the folder: 404, nothing read outside it");
			w.db.prepare("UPDATE passenger_authorizations SET driver_pdf_file = ? WHERE id = ?").run(`pa-${"z".repeat(32)}-driver.pdf`, id);
			eq((await w.req("GET", pdfOf(id), { user: "casey" })).status, 404, "§7 a stored name that isn't this module's: 404");
			w.db.prepare("UPDATE passenger_authorizations SET driver_pdf_file = ? WHERE id = ?").run(`pa-${"a".repeat(32)}-driver.pdf`, id);
			eq((await w.req("GET", pdfOf(id), { user: "casey" })).status, 404, "§7 a file that isn't there: 404");
		} finally { await w.close(); }
		for (const name of ["pdfOwnerAndAdmin", "pdfOtherDriver404", "pdfOtherRoles404", "pdfStrangeName404", "pdfWrongKind404", "pdfDigest500",
			"pdfAuthorizedServesFinal", "pdfRevokedServesDriverCopy", "pdfAdminAudited", "pdfHeaderNosniff", "pdfHeaderNoStore",
			"pdfFormerDriverNow404", "pdfFilenameSafe", "pdfMissing404", "adminListNoImages", "adminViews", "adminViewInvalid", "adminReviewNote"]) {
			ok(await holds(name), `§7 ${name}`);
		}
	});

	// ── §8 statusOf() and the business day ─────────────────────────────────────
	await part("§8 statusOf() and the business day", async () => {
		const L = realLib();
		const s = (status, validFrom, expiresOn) => L.statusOf({ status, valid_from: validFrom, expires_on: expiresOn }, TODAY);
		eq([
			s("authorized", "2026-11-01", TODAY), s("authorized", "2026-11-01", plusDays(TODAY, -1)), s("authorized", plusDays(TODAY, 1), "2026-11-20"),
			s("authorized", TODAY, "2026-11-20"), s("awaiting_company", TODAY, TODAY), s("awaiting_company", "2026-11-01", plusDays(TODAY, -1)),
			s("declined", "2026-11-01", "2026-11-02"), s("revoked", TODAY, "2026-12-01"),
		], ["active", "expired", "scheduled", "active", "awaiting_company", "expired", "declined", "revoked"],
		"§8 expires today = active; yesterday = expired; starts tomorrow = scheduled; starts today = active; an unsigned one lapses the same way; declined and revoked stay so");
		eq([L.dateText("2026-11-02"), L.dateText("2027-01-01"), L.dateText("2026-02-30"), L.addDays("2026-12-31", 1), L.addDays("2028-02-28", 1), L.addDays("2026-11-03", 90)],
			["November 2, 2026", "January 1, 2027", "", "2027-01-01", "2028-02-29", "2027-02-01"], "§8 calendar dates and arithmetic");
		// Late evening in Eastern is already tomorrow in UTC: the module reads the business day only.
		const probe = `
			const L = require(${JSON.stringify(LIB_PATH)});
			const appTime = require(${JSON.stringify(path.join(ROOT, "lib", "app-time.js"))});
			const today = appTime.appDay(new Date("2026-11-04T03:30:00Z"));
			const utcDay = new Date("2026-11-04T03:30:00Z").toISOString().slice(0, 10);
			const row = { status: "authorized", valid_from: "2026-11-01", expires_on: "2026-11-03" };
			console.log(JSON.stringify({ today, utcDay, business: L.statusOf(row, today), utc: L.statusOf(row, utcDay), text: L.dateText("2026-11-03"), plus: L.addDays("2026-11-03", 90) }));`;
		const results = {};
		for (const tz of ["UTC", "Pacific/Kiritimati", "Pacific/Pago_Pago"]) {
			const env = { ...process.env, TZ: tz };
			delete env.APP_TIMEZONE;
			const out = spawnSync(process.execPath, ["-e", probe], { encoding: "utf8", env });
			try { results[tz] = JSON.parse(out.stdout.trim()); } catch { results[tz] = { error: (out.stderr || "").split("\n")[0] }; }
		}
		eq(results.UTC, { today: "2026-11-03", utcDay: "2026-11-04", business: "active", utc: "expired", text: "November 3, 2026", plus: "2027-02-01" },
			"§8 on a UTC host at 22:30 Eastern, a form expiring that day is still active (APP_TIMEZONE unset: Eastern)");
		eq([results["Pacific/Kiritimati"], results["Pacific/Pago_Pago"]], [results.UTC, results.UTC], "§8 ...and the same on hosts 14 hours ahead and 11 behind");
	});

	// ── §9 the approval gate is untouched; the mount ───────────────────────────
	await part("§9 the approval gate; the mount", async () => {
		const libSrc = libSource();
		eq(H.ONBOARDING_DOCS.map((d) => d.key), ["contractor_agreement", "equipment_policy", "w9", "mobile_policy", "substance_policy"], "§9 ONBOARDING_DOCS holds exactly the five documents");
		ok(!H.ONBOARDING_DOCS.some((d) => /passenger/i.test(`${d.key} ${d.name}`)), "§9 ...and no passenger document");
		ok(!/onboarding_documents|driver_onboarding|ONBOARDING_DOCS|checkAndCompleteOnboarding/.test(libSrc), "§9 the module never names the onboarding tables, list or step");
		const w = await world();
		try {
			const ob = w.db.prepare("INSERT INTO driver_onboarding (user_id, status, drug_test_result) VALUES (?, 'documents_signed', 'pass')");
			ob.run(USERS.casey.id);
			const doc = w.db.prepare("INSERT INTO onboarding_documents (user_id, doc_key, doc_name, signed, signed_pdf_url) VALUES (?, ?, ?, 1, ?)");
			for (const d of H.ONBOARDING_DOCS) doc.run(USERS.casey.id, d.key, d.name, `/uploads/onboarding-signed/${d.key}-${USERS.casey.id}-signed.pdf`);
			const snap = () => JSON.stringify([w.db.prepare("SELECT * FROM driver_onboarding ORDER BY id").all(), w.db.prepare("SELECT * FROM onboarding_documents ORDER BY id").all()]);
			const before = snap();
			const a = await w.create("casey", minorBody());
			await w.countersign(a.id);
			await w.req("POST", revokeOf(a.id), { user: "admin", body: { reason: "made-up reason" } });
			const b = await w.create();
			await w.req("POST", declineOf(b.id), { user: "admin", body: { reason: "made-up reason" } });
			await w.req("GET", pdfOf(a.id), { user: "casey" });
			ok(before === snap(), "§9 a driver with every document signed and a passed drug test: the onboarding rows are byte-identical after file, sign, revoke and decline");
		} finally { await w.close(); }
		const lines = SRC.split("\n");
		eq(lines.filter((l) => l.includes('require("./lib/passenger-authorization")')).length, 1, "§9 server.js requires the module once");
		eq(lines.filter((l) => /^passengerAuthorization\.mount\(app, \{$/.test(l)).length, 1, "§9 ...and mounts it once, at the top level");
		const at = SRC.indexOf("\npassengerAuthorization.mount(app, {");
		const catchAll = SRC.indexOf('\napp.get("*"');
		const kpi = SRC.indexOf("// KPI BOT —");
		const chrA = SRC.indexOf("// <chr-wiring>");
		const chrB = SRC.indexOf("// </chr-wiring>");
		ok(at > 0 && at < catchAll && at < kpi, "§9 the mount is above the SPA catch-all and outside the KPI block the KPI runners lift");
		ok(at < chrA || at > chrB, "§9 ...and outside the C.H. Robinson block its runner lifts");
		const block = SRC.slice(at, SRC.indexOf("\n});", at));
		ok(block.includes("enabled: passengerAuthorization.enabled(process.env)"), "§9 the flag is read by the module's own enabled()");
		ok(block.includes('emitToDriver: (name) => io.to(driverRoom(name)).emit("passenger-authorizations:changed")'), "§9 the driver's live event goes to driverRoom(), one fixed event");
		ok(block.includes('storageDir: path.join(DATA_DIR, "storage", "passenger-authorizations")') && !block.includes("uploads"), "§9 the PDFs are kept under storage/, never uploads/");
		ok(block.includes("cleanText: sanitizeEvidenceText") && block.includes("refuseCrossSite") && block.includes("requireAuth, requireRole"), "§9 the server's own text cleaning and guards are handed in");
		ok(!/process\.env\.PASSENGER_AUTHORIZATION_ENABLED/.test(SRC), "§9 server.js never reads the flag itself");
		eq(libSrc.split("\n").filter((l) => /env\.PASSENGER_AUTHORIZATION_ENABLED/.test(l)).map((l) => l.trim()),
			['return Boolean(env) && env.PASSENGER_AUTHORIZATION_ENABLED === "true";'], "§9 the module reads the flag on one line, default off");
		const rules = require(path.join(ROOT, "lib", "replica-rules.js"));
		ok(typeof rules.enableRefusal("PASSENGER_AUTHORIZATION_ENABLED") === "string", "§9 a replica task cannot switch it on");
		ok(Object.prototype.hasOwnProperty.call(rules.ENABLE_REFUSED, "PASSENGER_AUTHORIZATION_ENABLED") && !rules.ENABLE_ALLOWED.includes("PASSENGER_AUTHORIZATION_ENABLED"), "§9 ...it is decided: on the refused list, not the allowlist");
	});

	// ── §10 the report script ──────────────────────────────────────────────────
	await part("§10 the report script", async () => {
		const run = (args) => spawnSync(process.execPath, [REPORT_PATH, ...args], { encoding: "utf8" });
		const none = run([]);
		ok(none.status === 2 && /REFUSED/.test(none.stderr), `§10 without --db: exit 2 (exit ${none.status})`);
		const dir = tempDir("pa-report-");
		const missing = run([`--db=${path.join(dir, "missing.db")}`]);
		eq(missing.status, 2, "§10 a --db that doesn't exist: exit 2");
		const bare = path.join(dir, "bare.db");
		{ const db = new Database(bare); db.exec(FIXTURE_SQL); db.close(); }
		const b = run([`--db=${bare}`]);
		ok(b.status === 0 && /passenger_authorizations: absent/.test(b.stdout), `§10 before the switch-on: "absent" (exit ${b.status})`);
		const full = path.join(dir, "full.db");
		{
			const db = new Database(full);
			db.exec(FIXTURE_SQL);
			realLib().ensureSchema(db);
			seedRow(db, { expires_on: "2099-12-31" });
			seedRow(db, { status: "authorized", valid_from: "2099-01-01", expires_on: "2099-02-01" });
			seedRow(db, { status: "authorized", valid_from: "2020-01-01", expires_on: "2099-12-31" });
			seedRow(db, { status: "authorized", valid_from: "2020-01-01", expires_on: "2020-02-01" });
			seedRow(db, { status: "declined", passenger_name: "Riley Example", guardian_name: "Pat Example" });
			seedRow(db, { status: "revoked" });
			db.prepare("INSERT INTO driver_onboarding (user_id, status) VALUES (?, 'documents_pending'), (?, 'fully_onboarded')").run(90102, 90103);
			db.prepare("INSERT INTO onboarding_documents (user_id, doc_key, signed) VALUES (90102, 'w9', 1), (90102, 'mobile_policy', 0)").run();
			db.close();
		}
		const hashBefore = sha(fs.readFileSync(full));
		const j = run([`--db=${full}`, "--json"]);
		let rep = {};
		try { rep = JSON.parse(j.stdout); } catch { rep = {}; }
		eq(rep.passengerAuthorizations, { present: true, rows: 6, byStatus: { awaiting_company: 1, authorized: 3, declined: 1, revoked: 1 },
			readsAs: { awaiting_company: 1, scheduled: 1, active: 1, expired: 1, declined: 1, revoked: 1 } }, "§10 counts by stored status and by what each reads as today");
		eq([rep.driverOnboarding, rep.onboardingDocuments && rep.onboardingDocuments.signed], [{ present: true, rows: 2, byStatus: { documents_pending: 1, fully_onboarded: 1 } }, 1], "§10 ...and the onboarding it must never move");
		const t = run([`--db=${full}`]);
		ok(t.status === 0 && RIDER_WORDS.concat(["Casey Example", "made-up", "pa-"]).every((word) => !t.stdout.includes(word) && !j.stdout.includes(word)), "§10 counts only: no name, place, consent or file name in either output");
		eq(sha(fs.readFileSync(full)), hashBefore, "§10 the database file is byte-identical after both runs");
		const report = require(REPORT_PATH);
		const h = report.openReadOnly(full);
		let threw = false;
		try { h.prepare("INSERT INTO users (username, role) VALUES ('x', 'Driver')").run(); } catch { threw = true; }
		h.close();
		ok(h.readonly === true && threw, "§10 the handle it opens is read-only: a write throws");
	});

	// ── §11 mutants ────────────────────────────────────────────────────────────
	await part("§11 mutants", async () => {
		const M = [
			["M1", "the flag gate always lets requests through", "const off = (req, res, next) => (on ? next() : refuse(res, 404, \"FEATURE_OFF\"));", "const off = (req, res, next) => next();", "offIs404"],
			["M2", "the feature route always says enabled", "answer(res, 200, { enabled: on })", "answer(res, 200, { enabled: true })", "offFeatureFalse"],
			["M3", "the table is made with the flag off", "if (on) ensureSchema(db);", "ensureSchema(db);", "offNoTable"],
			["M4", "filing open to any signed-in role", "app.post(\"/api/passenger-authorizations\", requireRole(\"Driver\"),", "app.post(\"/api/passenger-authorizations\", requireAuth,", "createRoleDriverOnly"],
			["M5", "the driver list open to any signed-in role", "app.get(\"/api/passenger-authorizations\", requireRole(\"Driver\"),", "app.get(\"/api/passenger-authorizations\", requireAuth,", "listRoleDriverOnly"],
			["M6", "the blank form open to any signed-in role", "app.get(\"/api/passenger-authorizations/form.pdf\", requireRole(\"Driver\"),", "app.get(\"/api/passenger-authorizations/form.pdf\", requireAuth,", "formRoleDriverOnly"],
			["M7", "the admin list open to Drivers", "app.get(\"/api/admin/passenger-authorizations\", requireRole(\"Super Admin\"),", "app.get(\"/api/admin/passenger-authorizations\", requireRole(\"Super Admin\", \"Driver\"),", "adminListSuperAdminOnly"],
			["M8", "the countersign open to any signed-in role", "countersign\", requireRole(\"Super Admin\"),", "countersign\", requireAuth,", "countersignSuperAdminOnly"],
			["M9", "the decline open to any signed-in role", "decline\", requireRole(\"Super Admin\"),", "decline\", requireAuth,", "declineSuperAdminOnly"],
			["M10", "the revoke open to any signed-in role", "revoke\", requireRole(\"Super Admin\"),", "revoke\", requireAuth,", "revokeSuperAdminOnly"],
			["M11", "no cross-site guard on filing", "requireRole(\"Driver\"), refuseCrossSite, off, limit.create", "requireRole(\"Driver\"), off, limit.create", "crossSiteCreate"],
			["M12", "no cross-site guard on the countersign", "refuseCrossSite, off, limit.countersign", "off, limit.countersign", "crossSiteCountersign"],
			["M13", "no cross-site guard on the decline", "decline\", requireRole(\"Super Admin\"), refuseCrossSite, off,", "decline\", requireRole(\"Super Admin\"), off,", "crossSiteDecline"],
			["M14", "no cross-site guard on the revoke", "revoke\", requireRole(\"Super Admin\"), refuseCrossSite, off,", "revoke\", requireRole(\"Super Admin\"), off,", "crossSiteRevoke"],
			["M15", "the PDF route's role rule removed (every other role read as a Super Admin)", "if (id && role === \"Super Admin\") row =", "if (id && role !== \"Driver\") row =", "pdfOtherRoles404"],
			["M16", "the PDF route's ownership dropped (fetch by id alone)", "WHERE id = ? AND driver_user_id = ?`).get(id, uid)", "WHERE id = ?`).get(id)", "pdfOtherDriver404"],
			["M17", "a stored name not checked against PDF_FILE_RE", "!PDF_FILE_RE.test(name) || ", "", "pdfStrangeName404"],
			["M18", "a stored file's kind not checked", " || !name.endsWith(`-${kind}.pdf`)", "", "pdfWrongKind404"],
			["M19", "the digest check dropped", "if (sha256(buf) !== (final ? row.final_pdf_sha256 : row.driver_pdf_sha256)) {", "if (false) {", "pdfDigest500"],
			["M20", "a revoked one serves its countersigned copy", "const final = row.status === STATUS.AUTHORIZED;", "const final = Boolean(row.final_pdf_file);", "pdfRevokedServesDriverCopy"],
			["M21", "a Super Admin's open not audited", "if (role === \"Super Admin\") logAudit(", "if (false) logAudit(", "pdfAdminAudited"],
			["M22", "the PDF without nosniff", "\"X-Content-Type-Options\": \"nosniff\",", "", "pdfHeaderNosniff"],
			["M23", "the PDF cacheable", "\"Cache-Control\": \"private, no-store\",", "\"Cache-Control\": \"private, max-age=3600\",", "pdfHeaderNoStore"],
			["M24", "JSON answers cacheable", "return res.status(status).set(\"Cache-Control\", \"no-store\").json(body);", "return res.status(status).json(body);", "jsonNoStore"],
			["M25", "the driver list not limited to his own", "FROM passenger_authorizations WHERE driver_user_id = ? ORDER BY created_at DESC, id DESC LIMIT 200`).all(sessionUserId(req))", "FROM passenger_authorizations WHERE ? IS NOT NULL ORDER BY created_at DESC, id DESC LIMIT 200`).all(sessionUserId(req))", "listOwnOnly"],
			["M26", "the driver list reads every column", "const publicCols = PUBLIC_COLUMNS.join(\", \");", "const publicCols = \"*\";", "listNoImages"],
			["M27", "the admin list reads every column", "const adminCols = ADMIN_COLUMNS.join(\", \");", "const adminCols = \"*\";", "adminListNoImages"],
			["M28", "the waiting view keeps lapsed ones", "waiting: { where: \"status = 'awaiting_company' AND expires_on >= ?\"", "waiting: { where: \"status = 'awaiting_company' AND ? IS NOT NULL\"", "adminViews"],
			["M29", "the ended view misses lapsed ones", "ended: { where: \"status IN ('declined', 'revoked') OR expires_on < ?\"", "ended: { where: \"status IN ('declined', 'revoked') OR ? IS NULL\"", "adminViews"],
			["M30", "the authorized view keeps lapsed ones", "authorized: { where: \"status = 'authorized' AND expires_on >= ?\"", "authorized: { where: \"status = 'authorized' AND ? IS NOT NULL\"", "adminViews"],
			["M31", "an unknown view not refused", "if (!Object.prototype.hasOwnProperty.call(VIEWS, view)) return refuse(res, 400, \"VIEW_INVALID\");", "", "adminViewInvalid"],
			["M32", "no review note for the countersign screen", ", reviewNote: PA_TEXT.REVIEW_NOTE", "", "adminReviewNote"],
			["M33", "any request id accepted", "const REQUEST_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;", "const REQUEST_ID_RE = /^.+$/;", "vRequestId"],
			["M34", "no replay before the render", "const prior = byRequest();", "const prior = null;", "replayOneRender"],
			["M35", "another driver's request id answered with that driver's row", "if (prior.owner_user_id !== uid) return refuse(res, 409, \"REQUEST_ID_CONFLICT\");", "", "replayOtherDriver409"],
			["M36", "no replay check after the render", "const raced = byRequest();", "const raced = null;", "replayRace"],
			["M37", "a passenger name not required", "if (passengerName === null) return no(\"PASSENGER_NAME_REQUIRED\", \"passengerName\");", "", "vPassengerName"],
			["M38", "a 101-character passenger name accepted", "passengerNameMax: 100,", "passengerNameMax: 101,", "vPassengerName101"],
			["M39", "a 1-character name accepted", "nameMin: 2,", "nameMin: 1,", "vPassengerName1"],
			["M40", "the age read loosely", "if (b.passengerAdult !== true && b.passengerAdult !== false) return no(", "if (b.passengerAdult === undefined) return no(", "vAge"],
			["M41", "a minor's guardian not required", "if (guardianName === null) return no(\"GUARDIAN_REQUIRED\", \"guardianName\");", "", "vGuardian"],
			["M42", "a minor's relationship not required", "if (guardianRelationship === null) return no(\"GUARDIAN_REQUIRED\", \"guardianRelationship\");", "", "vRelationship"],
			["M43", "a 41-character relationship accepted", "relationshipMax: 40,", "relationshipMax: 41,", "vRelationship41"],
			["M44", "a minor's attestation not required", "if (b.minorAttested !== true) return no(\"MINOR_ATTESTATION_REQUIRED\", \"minorAttested\");", "", "vAttestation"],
			["M45", "a blank truck unit accepted", "if (!unit || unit.length === 0) return no(", "if (!unit) return no(", "vTruckBlank"],
			["M46", "a 21-character truck unit accepted", "if (unit.length > LIMITS.truckUnitMax) return no(\"TRUCK_UNIT_TOO_LONG\", \"truckUnit\");", "", "vTruck21"],
			["M47", "the trip's start not required", "if (tripStart === null) return no(\"TRIP_POINTS_REQUIRED\", \"tripStart\");", "", "vTripStart"],
			["M48", "a 121-character trip point accepted", "tripPointMax: 120,", "tripPointMax: 121,", "vTripEnd121"],
			["M49", "a start before today accepted", "b.validFrom < todayKey || ", "", "vStartYesterday"],
			["M50", "a start past today+90 accepted", " || b.validFrom > latestStart)", ")", "vStartPlus91"],
			["M51", "an expiry before the start accepted", " || b.expiresOn < b.validFrom)", ")", "vExpiresBefore"],
			["M52", "an expiry past start+365 accepted", "expiryMaxDays: 365,", "expiryMaxDays: 366,", "vExpiryPlus366"],
			["M53", "a day that isn't one rolled forward", "t.getUTCMonth() === mo - 1 && t.getUTCDate() === d ? [y, mo, d] : null;", "true ? [y, mo, d] : null;", "vExpiresNotADay"],
			["M54", "a number read as a name", "if (typeof value !== \"string\") return null;\n\tif (value.length", "if (value == null) return null;\n\tif (value.length", "vNameNumber"],
			["M55", "an over-long value cleaned down to fit", "if (value.length > max * 8) return { text: \"\", length: Infinity };", "", "vNamePadded"],
			["M56", "runs of spaces kept", ".replace(/\\s+/g, \" \").trim();\n\treturn { text, length", ".trim();\n\treturn { text, length", "textCleaned"],
			["M57", "the passenger's image not required", "if (passengerImage.refusal) return", "if (false) return", "vPassengerImage"],
			["M58", "the driver's image not required", "if (driverImage.refusal) return", "if (false) return", "vDriverImage"],
			["M59", "an image the renderer would drop accepted", "const safe = safeSignatureImage(value);", "const safe = value;", "vRendererDrops"],
			["M60", "the passenger's consent not required", "if (passengerConsent === null) return refuse(res, 400, \"CONSENT_REQUIRED\", { signer: \"passenger\" });", "", "vPassengerConsent"],
			["M61", "the driver's consent not required", "if (driverConsent === null) return refuse(res, 400, \"CONSENT_REQUIRED\", { signer: \"driver\" });", "", "vDriverConsent"],
			["M62", "the driver's name taken from the request", "driver_name: account.name,", "driver_name: String(body.driverName || account.name),", "nameFromAccount"],
			["M63", "an account with no driver name may file", "if (!account.name) return refuse(res, 409, \"DRIVER_NAME_REQUIRED\");", "", "namelessAccount409"],
			["M64", "the open limit checked only after rendering", "if (openCount(uid, todayKey) >= LIMITS.maxOpen) return refuse(res, 409, \"TOO_MANY_OPEN\");", "", "openLimitBeforeRender"],
			["M65", "the open limit not checked again after the render", "if (openCount(uid, todayKey) >= LIMITS.maxOpen) {", "if (false) {", "openLimitRace"],
			["M66", "an 11th open one allowed", "maxOpen: 10,", "maxOpen: 11,", "openLimitTenth"],
			["M67", "ended ones counted as open", "status IN ('awaiting_company', 'authorized') AND expires_on >= ?`).get(userId, todayKey)", "status IN ('awaiting_company', 'authorized') AND ? IS NOT NULL`).get(userId, todayKey)", "openLimitTenth"],
			["M68", "a minor's form signed under the passenger's name", "passenger_signature_text: v.passengerAdult ? v.passengerName : v.guardianName,", "passenger_signature_text: v.passengerName,", "minorGuardianSigns"],
			["M69", "an adult's guardian fields kept", "if (!adult) {\n\t\tguardianName =", "{\n\t\tguardianName =", "adultGuardianBlank"],
			["M70", "the filing not audited", "logAudit(req, \"passenger_authorization_submit\"", "(() => {})(req, \"passenger_authorization_submit\"", "createAudited"],
			["M71", "the dispatch notice names the rider", "const text = `${row.driver_name} sent a passenger authorization (${row.reference}) for company signature.`;", "const text = `${row.driver_name} sent a passenger authorization (${row.reference}) for ${row.passenger_name}.`;", "noticeNamesNoRider"],
			["M72", "no live events after filing", "emitDispatchNotice({ type: \"passenger-authorization\", title, body: text, metadata: meta });\n\t\t\t\tnotifyChange(\"passenger-authorizations\");\n\t\t\t\temitToDriver(row.driver_name);", "", "createEmits"],
			["M73", "every file one name", "const name = `pa-${crypto.randomBytes(16).toString(\"hex\")}-${kind}.pdf`;", "const name = `pa-${\"0\".repeat(32)}-${kind}.pdf`;", "fileIsTheRows"],
			["M74", "a failed render answered as final", "return refuse(res, 503, \"RENDER_FAILED\", { retryable: true, reason: (err && err.code) || \"DOCUMENT_RENDER_FAILED\" });\n\t\t\t}\n\t\t\trow.driver_pdf_file", "return refuse(res, 503, \"RENDER_FAILED\", { retryable: false, reason: (err && err.code) || \"DOCUMENT_RENDER_FAILED\" });\n\t\t\t}\n\t\t\trow.driver_pdf_file", "renderFailureRetryable"],
			["M75", "a failed write's file left behind", "\t\t} catch (err) {\n\t\t\tdiscard(file.full);\n\t\t\tthrow err;", "\t\t} catch (err) {\n\t\t\tthrow err;", "renderFailureLeavesNoFile"],
			["M76", "the countersign's status checked only after rendering", "if (row.status !== STATUS.AWAITING) return refuse(res, 409, \"ALREADY_DECIDED\");", "", "countersignAgain409NoRender"],
			["M77", "the countersign's expiry checked only after rendering", "if (row.expires_on < todayKey) return refuse(res, 409, \"AUTHORIZATION_EXPIRED\");", "", "countersignExpired409NoRender"],
			["M78", "the field map not asked before signing", "if (!formWouldAuthorize(data)) return refuse(res, 409, \"AUTHORIZATION_INCOMPLETE\");", "", "countersignIncomplete"],
			["M79", "the countersign's UPDATE without its status condition", "WHERE id = ? AND status = 'awaiting_company' AND expires_on >= ?`).run(", "WHERE id = ? AND expires_on >= ?`).run(", "raceDeclineDuringCountersign"],
			["M80", "the countersign's UPDATE without its expiry condition", "WHERE id = ? AND status = 'awaiting_company' AND expires_on >= ?`).run(", "WHERE id = ? AND status = 'awaiting_company' AND ? IS NOT NULL`).run(", "raceExpiryDuringCountersign"],
			["M81", "the business day not read again after the render", "const nowKey = today();", "const nowKey = todayKey;", "raceExpiryDuringCountersign"],
			["M82", "a lost race's final file left behind", "if (info.changes !== 1) {\n\t\t\t\tdiscard(written.file.full);", "if (info.changes !== 1) {", "raceDeclineDuringCountersign"],
			["M83", "the company's printed name not required", "if (printedName === null) return refuse(res, 400, \"PRINTED_NAME_REQUIRED\", { field: \"printedName\" });", "", "countersignValidation"],
			["M84", "the company's title not required", "if (title === null) return refuse(res, 400, \"TITLE_REQUIRED\", { field: \"title\" });", "", "countersignValidation"],
			["M85", "the company's image not required", "if (image.refusal) return", "if (false) return", "countersignValidation"],
			["M86", "the company's consent not required", "if (consent === null) return refuse(res, 400, \"CONSENT_REQUIRED\", { signer: \"company\" });", "", "countersignValidation"],
			["M87", "the account that signed not recorded", "sessionUserId(req), String(user.username || \"\"), printedName, title,", "sessionUserId(req), \"\", printedName, title,", "countersignFields"],
			["M88", "the countersign not audited", "logAudit(req, \"passenger_authorization_countersign\"", "(() => {})(req, \"passenger_authorization_countersign\"", "countersignAudited"],
			["M89", "no driver notice", "if (!account || !account.name) return;\n\t\tinsertNotification", "return;\n\t\tinsertNotification", "countersignNotice"],
			["M90", "the notice sent to the name as filed", "const account = driverAccount(row.driver_user_id);\n\t\tif (!account", "const account = { name: String(row.driver_name || \"\") };\n\t\tif (!account", "noticeToCurrentName"],
			["M91", "a decision overwrites any status", "WHERE id = ? AND status = ?`).run(to,", "WHERE id = ? AND ? IS NOT NULL`).run(to,", "declineOnlyAwaiting"],
			["M92", "a 301-character reason accepted", "reasonMax: 300,", "reasonMax: 301,", "reasonBounds"],
			["M93", "a reason not required", "if (reason === null) return refuse(res, 400, \"REASON_REQUIRED\", { field: \"reason\" });", "", "reasonBounds"],
			["M94", "the decision's audit row carries the reason", "`Passenger authorization ${row.reference} ${to}`", "`Passenger authorization ${row.reference} ${to}: ${reason}`", "declineFlow"],
			["M95", "the decider not recorded", "WHERE id = ? AND status = ?`).run(to, reason, String(req.session.user.username || \"\"),", "WHERE id = ? AND status = ?`).run(to, reason, \"\",", "declineFlow"],
			["M96", "a form expiring today read as expired", "const expired = String((row && row.expires_on) || \"\") < today;", "const expired = String((row && row.expires_on) || \"\") <= today;", "statusEdges"],
			["M97", "a form starting today read as scheduled", "return today < String(row.valid_from || \"\") ? \"scheduled\" : \"active\";", "return today <= String(row.valid_from || \"\") ? \"scheduled\" : \"active\";", "statusEdges"],
			["M98", "the printed month off by one", "return p ? `${MONTHS[p[1] - 1]} ${p[2]}, ${p[0]}` : \"\";", "return p ? `${MONTHS[p[1] % 12]} ${p[2]}, ${p[0]}` : \"\";", "printedDates"],
			["M99", "the stored print date not the business day's", "driver_signed_on: dateText(todayKey),", "driver_signed_on: dateText(new Date().toISOString().slice(0, 10)),", "printedDatesFixedDay"],
			["M100", "no limiter on filing", "requireRole(\"Driver\"), refuseCrossSite, off, limit.create,", "requireRole(\"Driver\"), refuseCrossSite, off,", "createLimiter"],
			["M101", "the feature route open to anyone", "app.get(\"/api/passenger-authorizations/feature\", requireAuth, (req, res)", "app.get(\"/api/passenger-authorizations/feature\", (req, res)", "featureNeedsSignIn"],
			["M102", "a session with no account id let through", "const needAccount = (req, res, next) => (sessionUserId(req) ? next() : refuse(res, 403, \"SIGN_IN_AGAIN\"));", "const needAccount = (req, res, next) => next();", "needAccount"],
			["M103", "an account that is no longer a Driver may file", "if (!row || row.role !== \"Driver\") return null;", "if (!row) return null;", "accountNoLongerDriver"],
			["M104", "the blank form without the driver's name", "const buf = await renderPolicy(DOC_KEY, { driverName: account.name });", "const buf = await renderPolicy(DOC_KEY, { driverName: \"\" });", "formPdf"],
			["M105", "a failed blank form answered as final", "return refuse(res, 503, \"RENDER_FAILED\", { retryable: true });", "return refuse(res, 503, \"RENDER_FAILED\", { retryable: false });", "formFailure"],
			["M106", "rows filed as a Driver readable after the account stops being one", "else if (id && uid && role === \"Driver\") row =", "else if (id && uid) row =", "pdfFormerDriverNow404"],
			["M107", "a stored reference put in the file name as it is", "REFERENCE_RE.test(row.reference) ? row.reference : String(row.id)", "row.reference", "pdfFilenameSafe"],
			["M108", "a missing file answered 500", "if (err && err.code === \"ENOENT\") return refuse(res, 404, \"NOT_FOUND\");", "", "pdfMissing404"],
			["M109", "ids read loosely", "if (!/^[1-9][0-9]{0,15}$/.test(raw)) return null;", "if (!raw) return null;", "idsStrict"],
			["M110", "a failed save's file left behind", "} catch (err) {\n\t\t\t\tdiscard(written.file.full);\n\t\t\t\tlog.error(\"[passenger-authorization] save failed:\"", "} catch (err) {\n\t\t\t\tlog.error(\"[passenger-authorization] save failed:\"", "createSaveFailureCleans"],
			["M111", "the row and its audit line saved apart", "id = db.transaction(() => {", "id = ((fn) => fn)(() => {", "createAtomic"],
			["M112", "a failed countersign save's file left behind", "} catch (err) {\n\t\t\t\tdiscard(written.file.full);\n\t\t\t\tthrow err;\n\t\t\t}\n\t\t\tif (info.changes", "} catch (err) {\n\t\t\t\tthrow err;\n\t\t\t}\n\t\t\tif (info.changes", "countersignSaveFailureCleans"],
			["M113", "a reference used without checking it is free", "if (!stmt(\"SELECT 1 FROM passenger_authorizations WHERE reference = ?\").get(ref)) return ref;", "return ref;", "referenceUnique"],
			["M114", "no live refresh after a countersign", "to ${dateText(row.expires_on)}.`);\n\t\t\t\tnotifyChange(\"passenger-authorizations\");", "to ${dateText(row.expires_on)}.`);", "countersignEmits"],
			["M115", "no live refresh after a decision", "tellDriver(row, title, words(row.reference));\n\t\t\t\t\tnotifyChange(\"passenger-authorizations\");", "tellDriver(row, title, words(row.reference));", "declineEmits"],
			["M116", "a decision not audited", "logAudit(req, `passenger_authorization_${verb}`", "(() => {})(req, `passenger_authorization_${verb}`", "declineFlow"],
			["M117", "no limiter on the blank form", "off, limit.form, needAccount", "off, needAccount", "limiterForm"],
			["M118", "no limiter on the PDF route", "off, limit.pdf, async", "off, async", "limiterPdf"],
			["M119", "no limiter on the driver list", "requireRole(\"Driver\"), off, limit.list, needAccount", "requireRole(\"Driver\"), off, needAccount", "limiterList"],
			["M120", "no limiter on the admin list", "requireRole(\"Super Admin\"), off, limit.list,", "requireRole(\"Super Admin\"), off,", "limiterAdminList"],
			["M121", "no limiter on the countersign", "off, limit.countersign, async", "off, async", "limiterCountersign"],
			["M122", "no limiter on the decline", "decline\", requireRole(\"Super Admin\"), refuseCrossSite, off, limit.decide,", "decline\", requireRole(\"Super Admin\"), refuseCrossSite, off,", "limiterDecline"],
			["M123", "no limiter on the revoke", "revoke\", requireRole(\"Super Admin\"), refuseCrossSite, off, limit.decide,", "revoke\", requireRole(\"Super Admin\"), refuseCrossSite, off,", "limiterRevoke"],
			["M124", "one limit shared by every account", "return id ? `u:${id}` : `ip:${ipKeyGenerator(req.ip)}`;", "return \"shared\";", "limiterPerAccount"],
			["M125", "a replay answers the owner's account id", "delete shown.owner_user_id;", "", "replayOneRender"],
		];
		// Validation checks, one case each, run in their own world.
		const V = {
			vRequestId: ["requestIdNotUuid"], vPassengerName: ["noPassengerName"], vPassengerName101: ["passengerName101"], vPassengerName1: ["passengerName1"],
			vAge: ["ageString"], vGuardian: ["minorNoGuardian"], vRelationship: ["minorRelationship1"], vRelationship41: ["minorRelationship41"],
			vAttestation: ["minorNoAttestation"], vTruckBlank: ["truckSpaces"], vTruck21: ["truck21"], vTripStart: ["noTripStart"], vTripEnd121: ["tripEnd121"],
			vStartYesterday: ["validFromYesterday"], vStartPlus91: ["validFromPlus91"], vExpiresBefore: ["expiresBeforeStart"], vExpiryPlus366: ["expiresPlus366"],
			vExpiresNotADay: ["expiresNotADay"], vNameNumber: ["passengerNameNumber"], vNamePadded: ["passengerNamePadded"], vPassengerImage: ["noPassengerImage"],
			vDriverImage: ["noDriverImage"], vRendererDrops: ["imageRendererDrops"], vPassengerConsent: ["passengerConsentMissing"], vDriverConsent: ["driverConsentString"],
		};
		const extra = {
			statusEdges: async (L) => L.statusOf({ status: "authorized", valid_from: "2026-11-01", expires_on: TODAY }, TODAY) === "active"
				&& L.statusOf({ status: "authorized", valid_from: TODAY, expires_on: "2026-11-20" }, TODAY) === "active",
			// The print date follows the business day, not the host's clock.
			printedDatesFixedDay: (L) => withWorld(L, { today: "2031-06-15" }, async (w) => {
				const { id } = await w.create("casey", adultBody({ validFrom: "2031-06-15", expiresOn: "2031-06-20" }));
				return !!id && w.row(id).driver_signed_on === "June 15, 2031";
			}),
		};
		const checkOf = (name) => (V[name] ? vcases(V[name]) : CHECK[name] || extra[name]);
		console.log(`  ${M.length} mutants`);
		for (const [id, label, from, to, checkName] of M) {
			const check = checkOf(checkName);
			if (!check) { ok(false, `§11 ${id}: no check named ${checkName}`); continue; }
			ok((await holds(checkName, check)) === true, `§11 ${id}: its check (${checkName}) holds on the real module`);
			const src = libSource();
			const hits = src.split(from).length - 1;
			if (hits !== 1) { ok(false, `§11 ${id} ${label}: the anchor matches ${hits} time(s), not once`); continue; }
			let mutant;
			try { mutant = compile(src.replace(from, () => to)); } catch (err) { ok(false, `§11 ${id} ${label}: the mutant does not load (${err.message})`); continue; }
			// Caught means the check answered false; a check that crashed proves nothing.
			let onMutant;
			try { onMutant = await check(mutant); } catch (err) { onMutant = `threw ${err && err.message}`; }
			ok(onMutant === false, `§11 ${id} caught: ${label} (${checkName})${onMutant === false ? "" : ` [${onMutant}]`}`);
		}
	});

	console.log(failures.length ? `\nFAILED: ${failures.length} of ${pass + failures.length}\n  - ${failures.join("\n  - ")}` : `\nall ${pass} passed`);
	process.exit(failures.length ? 1 : 0);
})().catch((err) => {
	console.error(`runner crashed: ${err && err.stack ? err.stack : err}`);
	process.exit(1);
});
