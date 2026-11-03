"use strict";
// Passenger authorizations (Form PA-1), behind PASSENGER_AUTHORIZATION_ENABLED.
// A driver files one for a rider; the passenger (a parent or legal guardian for
// a minor) and the driver sign on his phone, and it is valid only once a Super
// Admin countersigns for LogisX Inc., as 49 CFR 392.60 wants. Optional: it never
// reads or writes the onboarding tables, so it cannot move a driver's onboarding.
//
// A rider's details reach the driver who filed and Super Admins only (anyone
// else gets 404); notices and audit rows name the driver and the reference, never
// the rider. PDFs live in storage/, outside uploads/, read back only by the PDF
// route, by a name this module wrote, and only while they match their digest.
//
// Every route: the role guard (server.js's requireAuth/requireRole, which also
// refuse a write without X-Requested-With), the cross-site guard on writes, the
// flag (off: 404 FEATURE_OFF), a limiter keyed on the account, the handler.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const { ipKeyGenerator } = require("express-rate-limit");
const POLICY_FIELD_MAPS = require("./policy-field-maps");
const { PASSENGER_AUTHORIZATION_TEXT: PA_TEXT } = require("./passenger-authorization-text");

const DOC_KEY = "passenger_authorization";
const FORM_VERSION = PA_TEXT.FORM_VERSION;

// The only stored PDF names: a 128-bit token, so a name is never guessed and
// never reused, and nothing from a request ever becomes part of a path.
const PDF_FILE_RE = /^pa-[0-9a-f]{32}-(driver|final)\.pdf$/;
const REFERENCE_RE = /^PA-[0-9A-F]{8}$/;
const REQUEST_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const LIMITS = Object.freeze({
	nameMin: 2,
	passengerNameMax: 100,
	guardianNameMax: 100,
	relationshipMax: 40,
	tripPointMax: 120,
	truckUnitMax: 20,
	companyNameMax: 100,
	companyTitleMax: 60,
	reasonMax: 300,
	validFromMaxDays: 90,
	expiryMaxDays: 365,
	maxOpen: 10,
});

// Requests per 15 minutes per account. A render is the most expensive thing a
// route here can be made to do, and every write adds audit rows and notices.
const RATE = Object.freeze({ form: 30, create: 10, pdf: 60, list: 120, countersign: 30, decide: 30 });

const STATUS = Object.freeze({ AWAITING: "awaiting_company", AUTHORIZED: "authorized", DECLINED: "declined", REVOKED: "revoked" });

const MESSAGES = Object.freeze({
	REQUEST_ID_REQUIRED: "This form is out of date. Close it, open it again and sign again.",
	PASSENGER_NAME_REQUIRED: "Enter the passenger's full name (2 to 100 characters).",
	PASSENGER_AGE_REQUIRED: "Say whether the passenger is 18 or older.",
	GUARDIAN_REQUIRED: "For a passenger under 18, enter the parent or legal guardian's name and how they are related to the passenger.",
	MINOR_ATTESTATION_REQUIRED: "Confirm that the passenger is older than 10 and fits the seat and seat belt.",
	TRIP_POINTS_REQUIRED: "Enter where the trip starts and where it ends (2 to 120 characters each).",
	DATES_INVALID: "The start date must be today or within the next 90 days, and the expiry date on or after it.",
	EXPIRY_TOO_LONG: "The expiry date can be at most 365 days after the start date.",
	TRUCK_UNIT_REQUIRED: "Enter the truck's unit number.",
	TRUCK_UNIT_TOO_LONG: "The truck's unit number can be at most 20 characters.",
	SIGNATURE_REQUIRED: "Draw the signature before sending.",
	CONSENT_REQUIRED: "Each signer must tick the box agreeing to the form before signing.",
	DRIVER_NAME_REQUIRED: "Your account has no driver name on file. Ask the office to add it, then sign again.",
	TOO_MANY_OPEN: "You already have 10 passenger authorizations waiting or in force. Wait for one to end before sending another.",
	REQUEST_ID_CONFLICT: "This form could not be sent. Close it, open it again and sign again.",
	SIGN_IN_AGAIN: "Your session is out of date. Sign in again.",
	PRINTED_NAME_REQUIRED: "Type your full name (2 to 100 characters).",
	TITLE_REQUIRED: "Type your title (2 to 60 characters).",
	REASON_REQUIRED: "Give a reason (2 to 300 characters).",
	NOT_FOUND: "Not found",
	FEATURE_OFF: "Not found",
	ALREADY_DECIDED: "This passenger authorization has already been decided.",
	AUTHORIZATION_EXPIRED: "This passenger authorization has expired. The driver can send a new one.",
	AUTHORIZATION_INCOMPLETE: "This passenger authorization is missing something the form needs, so it can't be signed. Decline it so the driver can send a new one.",
	NOT_REVOCABLE: "Only a passenger authorization the company has signed can be ended.",
	VIEW_INVALID: "Unknown list.",
	RENDER_FAILED: "The signed form could not be produced. Nothing was lost; try again in a moment.",
	PDF_UNAVAILABLE: "This form's file can't be opened right now.",
	RATE_LIMITED: "Too many requests. Try again in a few minutes.",
	FAILED: "Something went wrong. Try again.",
});

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS passenger_authorizations (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	reference TEXT NOT NULL UNIQUE,
	request_id TEXT NOT NULL UNIQUE,
	driver_user_id INTEGER NOT NULL,
	driver_name TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'awaiting_company'
		CHECK(status IN ('awaiting_company','authorized','declined','revoked')),
	form_version TEXT NOT NULL,
	passenger_name TEXT NOT NULL,
	passenger_adult INTEGER NOT NULL CHECK(passenger_adult IN (0,1)),
	guardian_name TEXT NOT NULL DEFAULT '',
	guardian_relationship TEXT NOT NULL DEFAULT '',
	minor_attested INTEGER NOT NULL DEFAULT 0,
	truck_unit TEXT NOT NULL DEFAULT '',
	trip_start TEXT NOT NULL,
	trip_end TEXT NOT NULL,
	valid_from TEXT NOT NULL,
	expires_on TEXT NOT NULL,
	passenger_signature_text TEXT NOT NULL,
	passenger_signature_image TEXT NOT NULL,
	passenger_consent_text TEXT NOT NULL DEFAULT '',
	driver_signature_text TEXT NOT NULL,
	driver_signature_image TEXT NOT NULL,
	driver_consent_text TEXT NOT NULL DEFAULT '',
	driver_signed_at TEXT NOT NULL,
	driver_signed_on TEXT NOT NULL,
	driver_signed_ip TEXT NOT NULL DEFAULT '',
	driver_signed_ip_source TEXT NOT NULL DEFAULT '',
	driver_signed_user_agent TEXT NOT NULL DEFAULT '',
	driver_pdf_file TEXT NOT NULL,
	driver_pdf_sha256 TEXT NOT NULL,
	driver_pdf_bytes INTEGER NOT NULL,
	company_user_id INTEGER,
	company_account TEXT NOT NULL DEFAULT '',
	company_printed_name TEXT NOT NULL DEFAULT '',
	company_title TEXT NOT NULL DEFAULT '',
	company_signature_image TEXT NOT NULL DEFAULT '',
	company_consent_text TEXT NOT NULL DEFAULT '',
	company_signed_at TEXT NOT NULL DEFAULT '',
	company_signed_on TEXT NOT NULL DEFAULT '',
	company_signed_ip TEXT NOT NULL DEFAULT '',
	company_signed_ip_source TEXT NOT NULL DEFAULT '',
	company_signed_user_agent TEXT NOT NULL DEFAULT '',
	final_pdf_file TEXT NOT NULL DEFAULT '',
	final_pdf_sha256 TEXT NOT NULL DEFAULT '',
	final_pdf_bytes INTEGER NOT NULL DEFAULT 0,
	decided_reason TEXT NOT NULL DEFAULT '',
	decided_by TEXT NOT NULL DEFAULT '',
	decided_at TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pa_driver ON passenger_authorizations(driver_user_id);
CREATE INDEX IF NOT EXISTS idx_pa_status ON passenger_authorizations(status);
`;

// What a driver's own list and answers carry: never an image, consent text,
// address, browser, file name or digest.
const PUBLIC_COLUMNS = [
	"id", "reference", "status", "form_version", "driver_name", "passenger_name", "passenger_adult",
	"guardian_name", "guardian_relationship", "minor_attested", "truck_unit", "trip_start", "trip_end",
	"valid_from", "expires_on", "driver_signed_at", "driver_signed_on", "company_printed_name", "company_title",
	"company_signed_on", "decided_at", "created_at",
];
// A Super Admin also sees who decided and why; still no image or evidence.
const ADMIN_COLUMNS = [...PUBLIC_COLUMNS, "driver_user_id", "company_account", "company_signed_at", "decided_reason", "decided_by"];

const REQUIRED_DEPS = [
	"db", "requireAuth", "requireRole", "refuseCrossSite", "renderPolicy", "safeSignatureImage", "writeSignedArtifact",
	"readTransmittedConsent", "signerNetworkEvidence", "cleanText", "imageLimits", "logAudit",
	"insertDispatchNotification", "emitDispatchNotice", "insertNotification", "emitToDriver", "notifyChange",
	"appDay", "storageDir",
];

// Off unless exactly "true".
function enabled(env = process.env) {
	return Boolean(env) && env.PASSENGER_AUTHORIZATION_ENABLED === "true";
}

function ensureSchema(db) {
	db.exec(SCHEMA_SQL);
}

// ── Calendar days ("YYYY-MM-DD"): never through a time zone ─────────────────
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// [year, month, day] of a real calendar day, else null: Feb 30 and month 13
// are refused, never rolled into the next month.
function calendarDay(value) {
	if (typeof value !== "string") return null;
	const m = DAY_RE.exec(value);
	if (!m) return null;
	const y = Number(m[1]);
	const mo = Number(m[2]);
	const d = Number(m[3]);
	const t = new Date(Date.UTC(y, mo - 1, d));
	return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d ? [y, mo, d] : null;
}

// UTC arithmetic and UTC getters only, so no time zone can move the day; "" for
// a day that isn't one.
function addDays(day, n) {
	const p = calendarDay(day);
	if (!p) return "";
	const t = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n));
	return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}

// "November 2, 2026", the way the form prints a date.
function dateText(day) {
	const p = calendarDay(day);
	return p ? `${MONTHS[p[1] - 1]} ${p[2]}, ${p[0]}` : "";
}

// What a row reads as on `todayKey` (the business day): it expires at the end
// of its expiry day, and an unsigned one past that can no longer be signed.
function statusOf(row, todayKey) {
	const status = row && row.status;
	if (status === STATUS.DECLINED || status === STATUS.REVOKED) return status;
	const today = String(todayKey || "");
	const expired = String((row && row.expires_on) || "") < today;
	if (status === STATUS.AWAITING) return expired ? "expired" : "awaiting_company";
	if (status === STATUS.AUTHORIZED) {
		if (expired) return "expired";
		return today < String(row.valid_from || "") ? "scheduled" : "active";
	}
	return "unknown";
}

// ── Submission checks (pure) ─────────────────────────────────────────────────

// Free text off the wire, cleaned like evidence text (server.js
// sanitizeEvidenceText, injected) with runs of spaces folded. Read whole, so a
// value over `max` is refused, never cut short. null when it isn't a string.
function readText(value, max, cleanText) {
	if (typeof value !== "string") return null;
	if (value.length > max * 8) return { text: "", length: Infinity };
	const text = String(cleanText(value, max * 4)).replace(/\s+/g, " ").trim();
	return { text, length: Array.from(text).length };
}

function boundedText(value, min, max, cleanText) {
	const t = readText(value, max, cleanText);
	return t && t.length >= min && t.length <= max ? t.text : null;
}

function requestIdOf(body) {
	const v = body && typeof body === "object" ? body.requestId : undefined;
	return typeof v === "string" && REQUEST_ID_RE.test(v) ? v.toLowerCase() : null;
}

// The driver's form, checked field by field. { ok: true, value } or
// { ok: false, code, field }. Signatures and consent are checked by the route,
// which owns the image and consent rules.
function validateSubmission(body, { todayKey, cleanText }) {
	const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
	const no = (code, field) => ({ ok: false, code, field, error: MESSAGES[code] });
	const requestId = requestIdOf(b);
	if (!requestId) return no("REQUEST_ID_REQUIRED", "requestId");
	const passengerName = boundedText(b.passengerName, LIMITS.nameMin, LIMITS.passengerNameMax, cleanText);
	if (passengerName === null) return no("PASSENGER_NAME_REQUIRED", "passengerName");
	// A real true or false: the age decides who signs and what the form says.
	if (b.passengerAdult !== true && b.passengerAdult !== false) return no("PASSENGER_AGE_REQUIRED", "passengerAdult");
	const adult = b.passengerAdult === true;
	let guardianName = "";
	let guardianRelationship = "";
	if (!adult) {
		guardianName = boundedText(b.guardianName, LIMITS.nameMin, LIMITS.guardianNameMax, cleanText);
		if (guardianName === null) return no("GUARDIAN_REQUIRED", "guardianName");
		guardianRelationship = boundedText(b.guardianRelationship, LIMITS.nameMin, LIMITS.relationshipMax, cleanText);
		if (guardianRelationship === null) return no("GUARDIAN_REQUIRED", "guardianRelationship");
		if (b.minorAttested !== true) return no("MINOR_ATTESTATION_REQUIRED", "minorAttested");
	}
	// The form names the truck the rider may travel in, and it never reads
	// AUTHORIZED without one, so a form without it could never be signed.
	const unit = readText(b.truckUnit, LIMITS.truckUnitMax, cleanText);
	if (!unit || unit.length === 0) return no("TRUCK_UNIT_REQUIRED", "truckUnit");
	if (unit.length > LIMITS.truckUnitMax) return no("TRUCK_UNIT_TOO_LONG", "truckUnit");
	const tripStart = boundedText(b.tripStart, LIMITS.nameMin, LIMITS.tripPointMax, cleanText);
	if (tripStart === null) return no("TRIP_POINTS_REQUIRED", "tripStart");
	const tripEnd = boundedText(b.tripEnd, LIMITS.nameMin, LIMITS.tripPointMax, cleanText);
	if (tripEnd === null) return no("TRIP_POINTS_REQUIRED", "tripEnd");
	const latestStart = addDays(todayKey, LIMITS.validFromMaxDays);
	if (!calendarDay(b.validFrom) || b.validFrom < todayKey || b.validFrom > latestStart) return no("DATES_INVALID", "validFrom");
	if (!calendarDay(b.expiresOn) || b.expiresOn < b.validFrom) return no("DATES_INVALID", "expiresOn");
	if (b.expiresOn > addDays(b.validFrom, LIMITS.expiryMaxDays)) return no("EXPIRY_TOO_LONG", "expiresOn");
	return {
		ok: true,
		value: {
			requestId, passengerName, passengerAdult: adult, guardianName, guardianRelationship,
			minorAttested: !adult, truckUnit: unit.text, tripStart, tripEnd, validFrom: b.validFrom, expiresOn: b.expiresOn,
		},
	};
}

// ── Rows as answered ─────────────────────────────────────────────────────────
// The columns a query selects (PUBLIC_COLUMNS or ADMIN_COLUMNS) are what an
// answer carries, so an image or evidence column never leaves SQLite at all.
const FLAG_COLUMNS = new Set(["passenger_adult", "minor_attested"]);
function answerRow(row, todayKey) {
	const out = {};
	for (const [col, value] of Object.entries(row)) {
		out[col.replace(/_([a-z0-9])/g, (m, ch) => ch.toUpperCase())] = FLAG_COLUMNS.has(col) ? value === 1 : value;
	}
	out.displayStatus = statusOf(row, todayKey);
	return out;
}

// The field map's input for a row; `company` adds the countersign.
function renderDataOf(row, company = null) {
	const data = {
		reference: row.reference,
		passengerName: row.passenger_name,
		passengerAdult: row.passenger_adult === 1,
		guardianName: row.guardian_name,
		guardianRelationship: row.guardian_relationship,
		driverName: row.driver_name,
		truckUnit: row.truck_unit,
		tripStart: row.trip_start,
		tripEnd: row.trip_end,
		validFrom: dateText(row.valid_from),
		expiresOn: dateText(row.expires_on),
		// Both sign together on the driver's phone, so one date prints for both.
		passengerSignedOn: row.driver_signed_on,
		passengerSignatureImage: row.passenger_signature_image,
		driverSignedOn: row.driver_signed_on,
		driverSignatureImage: row.driver_signature_image,
	};
	if (company) {
		data.companyPrintedName = company.printedName;
		data.companyTitle = company.title;
		data.companySignedOn = company.signedOn;
		data.companySignatureImage = company.signatureImage;
	}
	return data;
}

// Whether the form would read AUTHORIZED: asked of the field map itself, so
// the countersign keeps no second copy of what the form needs.
function formWouldAuthorize(data) {
	const fields = POLICY_FIELD_MAPS[DOC_KEY](data);
	return fields.text["Validity notice"] === PA_TEXT.VALIDITY_NOTICE.authorized;
}

function sha256(buf) {
	return crypto.createHash("sha256").update(buf).digest("hex");
}

function sessionUserId(req) {
	const id = req.session && req.session.user ? Number(req.session.user.id) : NaN;
	return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function rowIdOf(req) {
	const raw = String(req.params.id || "");
	if (!/^[1-9][0-9]{0,15}$/.test(raw)) return null;
	const id = Number(raw);
	return Number.isSafeInteger(id) ? id : null;
}

function refuse(res, status, code, extra = null) {
	return res.status(status).set("Cache-Control", "no-store").json({ code, error: MESSAGES[code] || MESSAGES.FAILED, ...(extra || {}) });
}

function answer(res, status, body) {
	return res.status(status).set("Cache-Control", "no-store").json(body);
}

function sendPdf(res, buf, fileLabel) {
	res.status(200).set({
		"Content-Type": "application/pdf",
		"Content-Length": String(buf.length),
		"Content-Disposition": `inline; filename="passenger-authorization-${fileLabel}.pdf"`,
		"Cache-Control": "private, no-store",
		"X-Content-Type-Options": "nosniff",
	});
	return res.end(buf);
}

function accountLimiter(max) {
	return rateLimit({
		windowMs: 15 * 60 * 1000,
		max,
		keyGenerator: (req) => {
			const id = req.session && req.session.user && req.session.user.id;
			return id ? `u:${id}` : `ip:${ipKeyGenerator(req.ip)}`;
		},
		message: { code: "RATE_LIMITED", error: MESSAGES.RATE_LIMITED },
		standardHeaders: true,
	});
}

function mount(app, deps) {
	const missing = REQUIRED_DEPS.filter((k) => deps == null || deps[k] === undefined || deps[k] === null);
	if (missing.length) throw new Error(`passenger-authorization: mount needs ${missing.join(", ")}`);
	const {
		db, requireAuth, requireRole, refuseCrossSite, renderPolicy, safeSignatureImage, writeSignedArtifact,
		readTransmittedConsent, signerNetworkEvidence, cleanText, imageLimits, logAudit,
		insertDispatchNotification, emitDispatchNotice, insertNotification, emitToDriver, notifyChange, appDay,
	} = deps;
	const on = deps.enabled === true;
	const log = deps.logger || console;
	const storageDir = path.resolve(String(deps.storageDir));
	if (on) ensureSchema(db);

	const off = (req, res, next) => (on ? next() : refuse(res, 404, "FEATURE_OFF"));
	// A driver's routes key everything on the account id the session carries.
	const needAccount = (req, res, next) => (sessionUserId(req) ? next() : refuse(res, 403, "SIGN_IN_AGAIN"));
	const limit = {
		form: accountLimiter(RATE.form),
		create: accountLimiter(RATE.create),
		pdf: accountLimiter(RATE.pdf),
		list: accountLimiter(RATE.list),
		countersign: accountLimiter(RATE.countersign),
		decide: accountLimiter(RATE.decide),
	};
	const today = () => String(appDay());
	const publicCols = PUBLIC_COLUMNS.join(", ");
	const adminCols = ADMIN_COLUMNS.join(", ");

	// Statements are prepared on first use: off, the table may not exist.
	const sql = new Map();
	const stmt = (text) => {
		let s = sql.get(text);
		if (!s) { s = db.prepare(text); sql.set(text, s); }
		return s;
	};

	// A Driver account as the users table has it now: the session's copy of the
	// name can be stale, and the form prints the account's own.
	function driverAccount(userId) {
		const row = stmt("SELECT id, role, driver_name FROM users WHERE id = ?").get(userId);
		if (!row || row.role !== "Driver") return null;
		return { id: row.id, name: String(row.driver_name || "").trim() };
	}

	// A row's file, only by a name this module writes (no separator can match
	// PDF_FILE_RE) and only of the kind the column holds.
	function storedPath(name, kind) {
		if (typeof name !== "string" || !PDF_FILE_RE.test(name) || !name.endsWith(`-${kind}.pdf`)) return null;
		return path.join(storageDir, name);
	}

	// A file this request wrote that no row will ever name.
	function discard(file) {
		if (!file) return;
		try { fs.unlinkSync(file); } catch { /* never written, or already gone */ }
	}

	function newFile(kind) {
		const name = `pa-${crypto.randomBytes(16).toString("hex")}-${kind}.pdf`;
		return { name, full: path.join(storageDir, name) };
	}

	function newReference() {
		for (let i = 0; i < 8; i++) {
			const ref = `PA-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
			if (!stmt("SELECT 1 FROM passenger_authorizations WHERE reference = ?").get(ref)) return ref;
		}
		throw new Error("no unused reference");
	}

	function openCount(userId, todayKey) {
		return stmt(`SELECT COUNT(*) AS n FROM passenger_authorizations
			WHERE driver_user_id = ? AND status IN ('awaiting_company', 'authorized') AND expires_on >= ?`).get(userId, todayKey).n;
	}

	// A signature as it arrives: the size and type rules every signing route
	// uses, and the renderer's own image rule, so a stored image always prints.
	function signatureImageOf(value) {
		const v = imageLimits.checkSignatureImage(value);
		if (v.ok && v.absent) return { refusal: { status: 400, body: { code: "SIGNATURE_REQUIRED", error: MESSAGES.SIGNATURE_REQUIRED } } };
		if (!v.ok) return { refusal: { status: v.status, body: imageLimits.refusalBody(v, "signature") } };
		const safe = safeSignatureImage(value);
		if (!safe) return { refusal: { status: 415, body: imageLimits.refusalBody({ status: 415, code: imageLimits.UNSUPPORTED_IMAGE_TYPE }, "signature") } };
		return { image: safe };
	}

	// Consent ticked and sent (server.js's rule: agreed === true, strictly).
	function consentOf(value) {
		const c = readTransmittedConsent({ consent: value }, null);
		return c ? c.text : null;
	}

	async function writePdf(kind, data, label) {
		fs.mkdirSync(storageDir, { recursive: true, mode: 0o700 });
		const file = newFile(kind);
		try {
			const artifact = await writeSignedArtifact({
				render: () => renderPolicy(DOC_KEY, data),
				signedPath: file.full,
				publicUrl: file.name,
				label,
			});
			return { file, artifact };
		} catch (err) {
			discard(file.full);
			throw err;
		}
	}

	// The driver's notice goes to the account's name now (a rename since filing
	// moves it), and to no one when the account is gone.
	function tellDriver(row, title, body) {
		const account = driverAccount(row.driver_user_id);
		if (!account || !account.name) return;
		insertNotification.run(account.name.toLowerCase(), "passenger_authorization", title, body, JSON.stringify({ id: row.id, reference: row.reference }));
		emitToDriver(account.name);
	}

	// ── Feature discovery ──────────────────────────────────────────────────
	app.get("/api/passenger-authorizations/feature", requireAuth, (req, res) => answer(res, 200, { enabled: on }));

	// ── The blank form, the driver's name filled ─────────────────────────────
	app.get("/api/passenger-authorizations/form.pdf", requireRole("Driver"), off, limit.form, needAccount, async (req, res) => {
		try {
			const account = driverAccount(sessionUserId(req));
			if (!account) return refuse(res, 403, "SIGN_IN_AGAIN");
			const buf = await renderPolicy(DOC_KEY, { driverName: account.name });
			if (!buf || !buf.length) throw new Error("no PDF");
			return sendPdf(res, Buffer.isBuffer(buf) ? buf : Buffer.from(buf), "form");
		} catch (err) {
			log.error("[passenger-authorization] blank form render failed:", (err && err.code) || "ERROR");
			return refuse(res, 503, "RENDER_FAILED", { retryable: true });
		}
	});

	// ── The driver's own ─────────────────────────────────────────────────────
	app.get("/api/passenger-authorizations", requireRole("Driver"), off, limit.list, needAccount, (req, res) => {
		const todayKey = today();
		const rows = stmt(`SELECT ${publicCols} FROM passenger_authorizations WHERE driver_user_id = ? ORDER BY created_at DESC, id DESC LIMIT 200`).all(sessionUserId(req));
		return answer(res, 200, { authorizations: rows.map((r) => answerRow(r, todayKey)) });
	});

	// ── File one: the passenger (or guardian) and the driver sign ────────────
	app.post("/api/passenger-authorizations", requireRole("Driver"), refuseCrossSite, off, limit.create, needAccount, async (req, res) => {
		const uid = sessionUserId(req);
		const body = req.body && typeof req.body === "object" ? req.body : {};
		try {
			const requestId = requestIdOf(body);
			if (!requestId) return refuse(res, 400, "REQUEST_ID_REQUIRED", { field: "requestId" });
			const todayKey = today();
			// A double submit answers the row the first one made, with no second render.
			const byRequest = () => stmt(`SELECT ${publicCols}, driver_user_id AS owner_user_id FROM passenger_authorizations WHERE request_id = ?`).get(requestId);
			const replayOf = (found) => {
				const shown = { ...found };
				delete shown.owner_user_id;
				return answer(res, 200, { authorization: answerRow(shown, todayKey), replay: true });
			};
			const prior = byRequest();
			if (prior) {
				if (prior.owner_user_id !== uid) return refuse(res, 409, "REQUEST_ID_CONFLICT");
				return replayOf(prior);
			}

			const checked = validateSubmission(body, { todayKey, cleanText });
			if (!checked.ok) return refuse(res, 400, checked.code, { field: checked.field });
			const v = checked.value;
			const passengerImage = signatureImageOf(body.passengerSignatureImage);
			if (passengerImage.refusal) return res.status(passengerImage.refusal.status).set("Cache-Control", "no-store").json({ ...passengerImage.refusal.body, signer: "passenger" });
			const driverImage = signatureImageOf(body.driverSignatureImage);
			if (driverImage.refusal) return res.status(driverImage.refusal.status).set("Cache-Control", "no-store").json({ ...driverImage.refusal.body, signer: "driver" });
			const passengerConsent = consentOf(body.passengerConsent);
			if (passengerConsent === null) return refuse(res, 400, "CONSENT_REQUIRED", { signer: "passenger" });
			const driverConsent = consentOf(body.driverConsent);
			if (driverConsent === null) return refuse(res, 400, "CONSENT_REQUIRED", { signer: "driver" });

			const account = driverAccount(uid);
			if (!account) return refuse(res, 403, "SIGN_IN_AGAIN");
			if (!account.name) return refuse(res, 409, "DRIVER_NAME_REQUIRED");
			if (openCount(uid, todayKey) >= LIMITS.maxOpen) return refuse(res, 409, "TOO_MANY_OPEN");

			const net = signerNetworkEvidence(req);
			const signedAt = new Date().toISOString();
			const row = {
				reference: newReference(),
				request_id: requestId,
				driver_user_id: uid,
				driver_name: account.name,
				form_version: FORM_VERSION,
				passenger_name: v.passengerName,
				passenger_adult: v.passengerAdult ? 1 : 0,
				guardian_name: v.guardianName,
				guardian_relationship: v.guardianRelationship,
				minor_attested: v.minorAttested ? 1 : 0,
				truck_unit: v.truckUnit,
				trip_start: v.tripStart,
				trip_end: v.tripEnd,
				valid_from: v.validFrom,
				expires_on: v.expiresOn,
				// The passenger for themselves, a guardian for a minor.
				passenger_signature_text: v.passengerAdult ? v.passengerName : v.guardianName,
				passenger_signature_image: passengerImage.image,
				passenger_consent_text: passengerConsent,
				driver_signature_text: account.name,
				driver_signature_image: driverImage.image,
				driver_consent_text: driverConsent,
				driver_signed_at: signedAt,
				// Stored as printed, so a later render can't move the date.
				driver_signed_on: dateText(todayKey),
				driver_signed_ip: net.ip,
				driver_signed_ip_source: net.ipSource,
				driver_signed_user_agent: net.userAgent,
				created_at: signedAt,
			};

			let written;
			try {
				written = await writePdf("driver", renderDataOf(row), `passenger authorization ${row.reference}`);
			} catch (err) {
				log.error("[passenger-authorization] driver-stage render failed:", (err && err.code) || "ERROR");
				return refuse(res, 503, "RENDER_FAILED", { retryable: true, reason: (err && err.code) || "DOCUMENT_RENDER_FAILED" });
			}
			row.driver_pdf_file = written.file.name;
			row.driver_pdf_sha256 = written.artifact.sha256;
			row.driver_pdf_bytes = written.artifact.bytes;

			// After the last await: what another request did meanwhile decides.
			const raced = byRequest();
			if (raced) {
				discard(written.file.full);
				if (raced.owner_user_id !== uid) return refuse(res, 409, "REQUEST_ID_CONFLICT");
				return replayOf(raced);
			}
			if (openCount(uid, todayKey) >= LIMITS.maxOpen) {
				discard(written.file.full);
				return refuse(res, 409, "TOO_MANY_OPEN");
			}
			const cols = Object.keys(row);
			let id;
			try {
				id = db.transaction(() => {
					const info = stmt(`INSERT INTO passenger_authorizations (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...cols.map((c) => row[c]));
					const newId = Number(info.lastInsertRowid);
					logAudit(req, "passenger_authorization_submit", "passenger_authorization", newId, `Passenger authorization ${row.reference} submitted`);
					return newId;
				})();
			} catch (err) {
				discard(written.file.full);
				log.error("[passenger-authorization] save failed:", (err && err.code) || "ERROR");
				return refuse(res, 503, "RENDER_FAILED", { retryable: true, reason: "SAVE_FAILED" });
			}

			try {
				const title = "Passenger authorization to sign";
				const text = `${row.driver_name} sent a passenger authorization (${row.reference}) for company signature.`;
				const meta = { id, reference: row.reference };
				insertDispatchNotification.run("passenger-authorization", title, text, JSON.stringify(meta));
				emitDispatchNotice({ type: "passenger-authorization", title, body: text, metadata: meta });
				notifyChange("passenger-authorizations");
				emitToDriver(row.driver_name);
			} catch (err) {
				log.error("[passenger-authorization] notice failed:", (err && err.code) || "ERROR");
			}
			const saved = stmt(`SELECT ${publicCols} FROM passenger_authorizations WHERE id = ?`).get(id);
			return answer(res, 201, { authorization: answerRow(saved, todayKey) });
		} catch (err) {
			log.error("[passenger-authorization] create failed:", (err && err.code) || "ERROR");
			return refuse(res, 500, "FAILED");
		}
	});

	// ── A PDF: the countersigned copy once authorized, else the driver-stage one
	app.get("/api/passenger-authorizations/:id/pdf", requireAuth, off, limit.pdf, async (req, res) => {
		const role = req.session.user.role;
		const id = rowIdOf(req);
		const uid = sessionUserId(req);
		const cols = "id, reference, status, driver_pdf_file, driver_pdf_sha256, final_pdf_file, final_pdf_sha256";
		try {
			// A Super Admin reads any; a Driver only his own, matched in SQL; anyone else nothing.
			let row = null;
			if (id && role === "Super Admin") row = stmt(`SELECT ${cols} FROM passenger_authorizations WHERE id = ?`).get(id);
			else if (id && uid && role === "Driver") row = stmt(`SELECT ${cols} FROM passenger_authorizations WHERE id = ? AND driver_user_id = ?`).get(id, uid);
			if (!row) return refuse(res, 404, "NOT_FOUND");
			const final = row.status === STATUS.AUTHORIZED;
			const file = storedPath(final ? row.final_pdf_file : row.driver_pdf_file, final ? "final" : "driver");
			if (!file) {
				log.error("[passenger-authorization] row has no usable file name:", row.id);
				return refuse(res, 404, "NOT_FOUND");
			}
			let buf;
			try {
				buf = await fs.promises.readFile(file);
			} catch (err) {
				if (err && err.code === "ENOENT") return refuse(res, 404, "NOT_FOUND");
				throw err;
			}
			// The file served is the file signed, or nothing.
			if (sha256(buf) !== (final ? row.final_pdf_sha256 : row.driver_pdf_sha256)) {
				log.error("[passenger-authorization] stored PDF does not match its digest:", row.id);
				return refuse(res, 500, "PDF_UNAVAILABLE");
			}
			// A Super Admin opening a rider's form is on the record; the shared login records the account.
			if (role === "Super Admin") logAudit(req, "passenger_authorization_pdf_view", "passenger_authorization", row.id, `Passenger authorization ${row.reference} PDF opened`);
			return sendPdf(res, buf, REFERENCE_RE.test(row.reference) ? row.reference : String(row.id));
		} catch (err) {
			log.error("[passenger-authorization] pdf failed:", (err && err.code) || "ERROR");
			return refuse(res, 500, "PDF_UNAVAILABLE");
		}
	});

	// ── Super Admin: the lists ───────────────────────────────────────────────
	const VIEWS = {
		waiting: { where: "status = 'awaiting_company' AND expires_on >= ?", params: (t) => [t] },
		authorized: { where: "status = 'authorized' AND expires_on >= ?", params: (t) => [t] },
		ended: { where: "status IN ('declined', 'revoked') OR expires_on < ?", params: (t) => [t] },
	};
	app.get("/api/admin/passenger-authorizations", requireRole("Super Admin"), off, limit.list, (req, res) => {
		const view = req.query.view === undefined ? "waiting" : String(req.query.view);
		if (!Object.prototype.hasOwnProperty.call(VIEWS, view)) return refuse(res, 400, "VIEW_INVALID");
		const todayKey = today();
		const v = VIEWS[view];
		const rows = stmt(`SELECT ${adminCols} FROM passenger_authorizations WHERE ${v.where} ORDER BY created_at DESC, id DESC LIMIT 500`).all(...v.params(todayKey));
		return answer(res, 200, { view, authorizations: rows.map((r) => answerRow(r, todayKey)), reviewNote: PA_TEXT.REVIEW_NOTE });
	});

	// ── Super Admin: countersign for LogisX Inc. ─────────────────────────────
	app.post("/api/admin/passenger-authorizations/:id/countersign", requireRole("Super Admin"), refuseCrossSite, off, limit.countersign, async (req, res) => {
		const id = rowIdOf(req);
		if (!id) return refuse(res, 404, "NOT_FOUND");
		const body = req.body && typeof req.body === "object" ? req.body : {};
		try {
			const todayKey = today();
			const row = stmt("SELECT * FROM passenger_authorizations WHERE id = ?").get(id);
			if (!row) return refuse(res, 404, "NOT_FOUND");
			if (row.status !== STATUS.AWAITING) return refuse(res, 409, "ALREADY_DECIDED");
			if (row.expires_on < todayKey) return refuse(res, 409, "AUTHORIZATION_EXPIRED");
			const printedName = boundedText(body.printedName, LIMITS.nameMin, LIMITS.companyNameMax, cleanText);
			if (printedName === null) return refuse(res, 400, "PRINTED_NAME_REQUIRED", { field: "printedName" });
			const title = boundedText(body.title, LIMITS.nameMin, LIMITS.companyTitleMax, cleanText);
			if (title === null) return refuse(res, 400, "TITLE_REQUIRED", { field: "title" });
			const image = signatureImageOf(body.signatureImage);
			if (image.refusal) return res.status(image.refusal.status).set("Cache-Control", "no-store").json({ ...image.refusal.body, signer: "company" });
			const consent = consentOf(body.consent);
			if (consent === null) return refuse(res, 400, "CONSENT_REQUIRED", { signer: "company" });

			const company = { printedName, title, signedOn: dateText(todayKey), signatureImage: image.image };
			const data = renderDataOf(row, company);
			if (!formWouldAuthorize(data)) return refuse(res, 409, "AUTHORIZATION_INCOMPLETE");

			const net = signerNetworkEvidence(req);
			let written;
			try {
				written = await writePdf("final", data, `passenger authorization ${row.reference} (countersigned)`);
			} catch (err) {
				log.error("[passenger-authorization] final render failed:", (err && err.code) || "ERROR");
				return refuse(res, 503, "RENDER_FAILED", { retryable: true, reason: (err && err.code) || "DOCUMENT_RENDER_FAILED" });
			}

			// After the last await: the status condition is what stops a decision
			// made meanwhile from being overwritten.
			const nowKey = today();
			const user = req.session.user;
			let info;
			try {
				info = stmt(`UPDATE passenger_authorizations SET status = 'authorized',
					company_user_id = ?, company_account = ?, company_printed_name = ?, company_title = ?,
					company_signature_image = ?, company_consent_text = ?, company_signed_at = ?, company_signed_on = ?,
					company_signed_ip = ?, company_signed_ip_source = ?, company_signed_user_agent = ?,
					final_pdf_file = ?, final_pdf_sha256 = ?, final_pdf_bytes = ?
					WHERE id = ? AND status = 'awaiting_company' AND expires_on >= ?`).run(
					sessionUserId(req), String(user.username || ""), printedName, title,
					image.image, consent, new Date().toISOString(), company.signedOn,
					net.ip, net.ipSource, net.userAgent,
					written.file.name, written.artifact.sha256, written.artifact.bytes,
					id, nowKey,
				);
			} catch (err) {
				discard(written.file.full);
				throw err;
			}
			if (info.changes !== 1) {
				discard(written.file.full);
				const now = stmt("SELECT status FROM passenger_authorizations WHERE id = ?").get(id);
				return refuse(res, 409, now && now.status === STATUS.AWAITING ? "AUTHORIZATION_EXPIRED" : "ALREADY_DECIDED");
			}
			logAudit(req, "passenger_authorization_countersign", "passenger_authorization", id, `Passenger authorization ${row.reference} countersigned`);
			try {
				tellDriver(row, "Passenger authorization signed",
					`LogisX Inc. signed your passenger authorization ${row.reference}. It is valid from ${dateText(row.valid_from)} to ${dateText(row.expires_on)}.`);
				notifyChange("passenger-authorizations");
			} catch (err) {
				log.error("[passenger-authorization] notice failed:", (err && err.code) || "ERROR");
			}
			const saved = stmt(`SELECT ${adminCols} FROM passenger_authorizations WHERE id = ?`).get(id);
			return answer(res, 200, { authorization: answerRow(saved, nowKey) });
		} catch (err) {
			log.error("[passenger-authorization] countersign failed:", (err && err.code) || "ERROR");
			return refuse(res, 500, "FAILED");
		}
	});

	// ── Super Admin: decline an unsigned one, or end a signed one ────────────
	function decide({ from, to, refusal, verb, title, words }) {
		return (req, res) => {
			const id = rowIdOf(req);
			if (!id) return refuse(res, 404, "NOT_FOUND");
			const body = req.body && typeof req.body === "object" ? req.body : {};
			const reason = boundedText(body.reason, LIMITS.nameMin, LIMITS.reasonMax, cleanText);
			if (reason === null) return refuse(res, 400, "REASON_REQUIRED", { field: "reason" });
			try {
				const row = stmt("SELECT id, reference, status, driver_user_id FROM passenger_authorizations WHERE id = ?").get(id);
				if (!row) return refuse(res, 404, "NOT_FOUND");
				const info = stmt(`UPDATE passenger_authorizations SET status = ?, decided_reason = ?, decided_by = ?, decided_at = ?
					WHERE id = ? AND status = ?`).run(to, reason, String(req.session.user.username || ""), new Date().toISOString(), id, from);
				if (info.changes !== 1) return refuse(res, 409, refusal);
				logAudit(req, `passenger_authorization_${verb}`, "passenger_authorization", id, `Passenger authorization ${row.reference} ${to}`);
				try {
					tellDriver(row, title, words(row.reference));
					notifyChange("passenger-authorizations");
				} catch (err) {
					log.error("[passenger-authorization] notice failed:", (err && err.code) || "ERROR");
				}
				const saved = stmt(`SELECT ${adminCols} FROM passenger_authorizations WHERE id = ?`).get(id);
				return answer(res, 200, { authorization: answerRow(saved, today()) });
			} catch (err) {
				log.error(`[passenger-authorization] ${verb} failed:`, (err && err.code) || "ERROR");
				return refuse(res, 500, "FAILED");
			}
		};
	}
	app.post("/api/admin/passenger-authorizations/:id/decline", requireRole("Super Admin"), refuseCrossSite, off, limit.decide, decide({
		from: STATUS.AWAITING, to: STATUS.DECLINED, refusal: "ALREADY_DECIDED", verb: "decline",
		title: "Passenger authorization declined",
		words: (ref) => `LogisX Inc. declined your passenger authorization ${ref}. Send a new one if the passenger still needs to ride.`,
	}));
	app.post("/api/admin/passenger-authorizations/:id/revoke", requireRole("Super Admin"), refuseCrossSite, off, limit.decide, decide({
		from: STATUS.AUTHORIZED, to: STATUS.REVOKED, refusal: "NOT_REVOCABLE", verb: "revoke",
		title: "Passenger authorization ended",
		words: (ref) => `LogisX Inc. ended your passenger authorization ${ref}. The passenger may no longer ride under it.`,
	}));

	return { enabled: on };
}

module.exports = {
	enabled,
	ensureSchema,
	validateSubmission,
	statusOf,
	calendarDay,
	addDays,
	dateText,
	mount,
	PDF_FILE_RE,
	REFERENCE_RE,
	REQUEST_ID_RE,
	LIMITS,
	RATE,
	MESSAGES,
	PUBLIC_COLUMNS,
	ADMIN_COLUMNS,
	SCHEMA_SQL,
};
