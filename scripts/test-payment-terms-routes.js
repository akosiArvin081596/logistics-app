#!/usr/bin/env node
/**
 * Payment terms invites, end to end through the shipped route handlers.
 *
 * Every route below is lifted out of server.js as written and run against an
 * in-memory SQLite built from server.js's own DDL, with server.js's own
 * helpers (the invite block, buildInvestorDocRender, logAudit / auditText,
 * escapeHtml) and the real lib/investor-payment-terms.js, lib/public-form-input.js
 * and lib/image-size.js. Only the renderers (renderPolicy, fillW9Form), the
 * artifact writer, mail, sockets, the consent / network-evidence readers and
 * the regenerate route's archive helpers are stubbed.
 *
 * WHAT IS ASSERTED
 *   §1 admin routes: create / list never carry a token or its hash; every
 *      write is audited and notified; the revision goes up only when terms
 *      change; a stale revision is 409; reissue kills the old link; revoked
 *      and expired links are refused (410); the public lookup stamps
 *      first_opened_at once and sends no-store / noindex
 *   §2 POST /api/public/investor-apply: no invite → NULL snapshots and the
 *      invites table untouched; an invite binds and snapshots the master and
 *      lease (the W-9 stays NULL); a second submit is 410 with the application
 *      count unchanged; a stale revision is 409 with nothing written; a refusal
 *      inside the transaction rolls everything back; terms in the body are
 *      ignored; the admin email carries the terms, escaped
 *   §3 POST /api/public/investor-preview-pdf: body terms are ignored; a bad
 *      link is 404 before any render or in-flight slot; no token → the render
 *      data is today's shape and no new header
 *   §4 regenerate reprints from the snapshot even after the invite row
 *      changes; an unreadable snapshot is 409 before the archive step
 *   §5 the read-only payment terms view, the application list (Terms,
 *      invite id, docs_total) and detail
 *   §6 source pins: no payout code references the invite table, the snapshot
 *      column or the module; the invite check sits before the transaction
 *      with no await between them
 *   §7 MUTANTS, one per guard, each caught: single use removed; terms taken
 *      from the body (apply, preview); regenerate reading the invite row
 *
 * Pure: no server, no app.db, no network, no browser, no mail.
 *
 * Run: node scripts/test-payment-terms-routes.js    # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");

let pass = 0;
const failures = [];
const ok = (cond, msg) => { if (cond) pass++; else failures.push(msg); };
function die(msg) { console.error(`FAILED: ${msg}`); process.exit(1); }
function record(title, results) {
	console.log(`${title}: ${results.filter((r) => r.ok).length}/${results.length} checks`);
	for (const r of results) ok(r.ok, `${title}: ${r.name}`);
}

let Database;
try {
	Database = require("better-sqlite3");
} catch (e) {
	die(`a server dependency did not load (${e.message}); run npm ci under the .nvmrc Node`);
}
const investorPaymentTerms = require(path.join(ROOT, "lib", "investor-payment-terms.js"));
const publicFormInput = require(path.join(ROOT, "lib", "public-form-input.js"));
const w9Input = require(path.join(ROOT, "lib", "w9-input.js"));
const imageLimits = require(path.join(ROOT, "lib", "image-size.js"));
const piiMask = require(path.join(ROOT, "lib", "pii-mask.js"));
const { safeSignatureImage } = require(path.join(ROOT, "lib", "policy-renderer.js"));

// ── lifting ─────────────────────────────────────────────────────────────────
function count(needle) { return SRC.split(needle).length - 1; }
function liftFunction(name, src = SRC) {
	const needles = [`\nfunction ${name}(`, `\nasync function ${name}(`];
	const hits = needles.reduce((n, x) => n + (src.split(x).length - 1), 0);
	if (hits !== 1) die(`expected exactly 1 definition of ${name}() in server.js, found ${hits}`);
	const needle = needles.find((x) => src.includes(x));
	const a = src.indexOf(needle) + 1;
	const end = src.indexOf("\n}\n", a);
	return src.slice(a, end + 2);
}
function liftRoute(head) {
	const needle = `\n${head}`;
	if (count(needle) !== 1) die(`expected exactly 1 registration ${JSON.stringify(head)}, found ${count(needle)}`);
	const a = SRC.indexOf(needle) + 1;
	const end = SRC.indexOf("\n});", a);
	return SRC.slice(a, end + "\n});".length);
}
function liftConst(head, close = null) {
	const needle = `\n${head}`;
	if (count(needle) !== 1) die(`expected exactly 1 statement starting ${JSON.stringify(head)}, found ${count(needle)}`);
	const a = SRC.indexOf(needle) + 1;
	const end = close ? SRC.indexOf(close, a) : SRC.indexOf(";\n", a);
	return SRC.slice(a, end + (close ? close.length : 1));
}
function tableDdl(table) {
	const m = SRC.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\t\\)`));
	if (!m) die(`could not locate CREATE TABLE ${table}`);
	return `CREATE TABLE ${table} (${m[1]}\n)`;
}
function alterDdl(table, col) {
	const m = SRC.match(new RegExp(`ALTER TABLE ${table} ADD COLUMN ${col} [^"]*`));
	if (!m) die(`could not locate the ${table}.${col} migration`);
	return m[0];
}
function indexDdl(name) {
	const m = SRC.match(new RegExp(`CREATE INDEX IF NOT EXISTS ${name} ON [^"]*`));
	if (!m) die(`could not locate index ${name}`);
	return m[0];
}

const DDL = [
	tableDdl("audit_trail"),
	tableDdl("investors"), alterDdl("investors", "application_id"),
	tableDdl("investor_applications"),
	...["access_token", "vehicles_json", "deleted_at"].map((c) => alterDdl("investor_applications", c)),
	tableDdl("investor_onboarding"),
	tableDdl("investor_onboarding_documents"),
	...["signature_image", "signing_error", "signing_failed_at", "payment_terms_json"].map((c) => alterDdl("investor_onboarding_documents", c)),
	tableDdl("investor_payment_info"),
	tableDdl("investor_invites"),
	indexDdl("idx_investor_invites_status"),
	indexDdl("idx_investor_invites_email"),
];

const HEADS = {
	apply: 'app.post("/api/public/investor-apply", publicFormLimiter, async (req, res) => {',
	preview: 'app.post("/api/public/investor-preview-pdf/:docKey", pdfPreviewLimiter, async (req, res) => {',
	regenerate: 'app.post("/api/admin/investor-onboarding/:id/documents/:docKey/regenerate", requireRole("Super Admin"), onboardingSignLimiter, async (req, res) => {',
	publicInvite: 'app.get("/api/public/investor-invite", investorInviteLookupLimiter, (req, res) => {',
	list: 'app.get("/api/admin/investor-invites", requireRole("Super Admin"), (req, res) => {',
	create: 'app.post("/api/admin/investor-invites", requireRole("Super Admin"), refuseCrossOrigin, (req, res) => {',
	update: 'app.put("/api/admin/investor-invites/:id", requireRole("Super Admin"), refuseCrossOrigin, (req, res) => {',
	reissue: 'app.post("/api/admin/investor-invites/:id/reissue", requireRole("Super Admin"), refuseCrossOrigin, (req, res) => {',
	revoke: 'app.post("/api/admin/investor-invites/:id/revoke", requireRole("Super Admin"), refuseCrossOrigin, (req, res) => {',
	adminPreview: 'app.post("/api/admin/investor-invites/:id/preview/:docKey", requireRole("Super Admin"), onboardingPreviewLimiter, async (req, res) => {',
	termsView: 'app.get("/api/investors/:id/payment-terms", requireRole("Super Admin"), (req, res) => {',
	appList: 'app.get("/api/investor-applications", requireRole("Super Admin"), (req, res) => {',
	appDetail: 'app.get("/api/investor-applications/:id", requireRole("Super Admin"), (req, res) => {',
};
const ROUTES = Object.fromEntries(Object.entries(HEADS).map(([k, h]) => [k, liftRoute(h)]));

const INVITE_FUNCTIONS = [
	"inviteRefusal", "inviteNotFoundRefusal", "inviteRefusalError", "inviteStatusOf", "inviteExpiryFrom", "inviteUseRefusal",
	"resolveInviteToken", "parseInviteRevision", "inviteIdParam", "setInvitePreviewHeaders", "publicInviteView", "adminInviteView",
	"readAdminInvite", "inviteAuditTerms", "readInviteBody", "buildPaymentTermsView", "paymentTermsSummaryOf",
];
const PIECES = {
	evidence: liftConst("const SIGNING_EVIDENCE_VERSION = 1;", "\n}\n"),
	docs: liftConst("const INVESTOR_ONBOARDING_DOCS = [", "\n];"),
	fields: [liftConst("const PUBLIC_INVESTOR_SCALAR_FIELDS = [", "\n];"), liftConst("const PUBLIC_BANKING_SCALAR_FIELDS = ")].join("\n"),
	inflight: [liftConst("const PDF_PREVIEW_MAX_INFLIGHT = "), liftConst("let pdfPreviewInflight = ")].join("\n"),
	inviteConsts: [
		liftConst("const INVITE_TTL_DAYS = "), liftConst("const INVITE_STATUS_FILTERS = "), liftConst("const INVITE_REVOKE_REASON_MAX = "),
		liftConst("const INVITE_ADMIN_SELECT = `", "`;"), liftConst("const INVITE_PREVIEW_SAMPLE = "),
	].join("\n"),
	inviteFns: INVITE_FUNCTIONS.map((n) => liftFunction(n)).join("\n"),
	shared: ["logAudit", "scrubPurgeMarker", "auditText", "escapeHtml", "buildInvestorDocRender"].map((n) => liftFunction(n)).join("\n"),
};

// ── the harness ─────────────────────────────────────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "payment-terms-routes-"));
process.on("exit", () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });
const noop = (req, res, next) => next && next();
const SUPER = { id: 1, username: "super_admin", role: "Super Admin" };

function buildServer({ routes = {}, hooks = {} } = {}) {
	const db = new Database(":memory:");
	// The migrations are idempotent in server.js (try/catch); a column the
	// CREATE already carries is the same "exists" case here.
	for (const sql of DDL) {
		try { db.exec(sql); } catch (e) { if (!/duplicate column name/.test(e.message)) throw e; }
	}
	const calls = { renders: [], w9: [], mail: [], notify: [], archived: 0, errors: [] };
	const state = { artifactPresent: false };
	const handlers = {};
	const reg = (verb) => (p, ...h) => { handlers[`${verb} ${p}`] = h[h.length - 1]; };
	const env = {
		app: { get: reg("GET"), post: reg("POST"), put: reg("PUT"), delete: reg("DELETE") },
		db, crypto, path, fs, __dirname: TMP,
		requireRole: () => noop, refuseCrossOrigin: noop, publicFormLimiter: noop, pdfPreviewLimiter: noop,
		onboardingSignLimiter: noop, onboardingPreviewLimiter: noop, investorInviteLookupLimiter: noop,
		publicFormInput, w9Input, imageLimits, safeSignatureImage, piiMask, investorPaymentTerms,
		maskingEnabled: () => true,
		readTransmittedConsent: (sig, res) => {
			if (sig && sig.consent && sig.consent.agreed === true) return { agreed: 1, text: "I have read and agree." };
			res.status(400).json({ code: "CONSENT_REQUIRED" });
			return null;
		},
		// Called after the invite pre-check and before the transaction: the seam
		// a test uses to change the invite in between.
		signerNetworkEvidence: () => {
			if (hooks.beforeTx) hooks.beforeTx(db);
			return { ip: "127.0.0.1", ipSource: "socket", userAgent: "test" };
		},
		renderPolicy: async (docKey, data) => { calls.renders.push({ docKey, data }); return Buffer.from("%PDF-1.4 stub"); },
		fillW9Form: async (data) => { calls.w9.push(data); return new Uint8Array([37, 80, 68, 70]); },
		writeSignedArtifact: async ({ render, publicUrl }) => { await render(); return { url: publicUrl, sha256: "a".repeat(64), bytes: 4096 }; },
		alertOnboardingDocFailure: () => {},
		resolveOnboardingDocAlert: () => {},
		sendEmail: (to, subject, html) => { calls.mail.push({ to, subject, html }); },
		notifyChange: (domain) => { calls.notify.push(domain); },
		EVIDENCE_DATE_TZ: "UTC",
		signedArtifactLooksValid: () => state.artifactPresent,
		archiveSignedArtifact: () => { calls.archived++; return { file: "archived.pdf", sha256: "b".repeat(64), bytes: 10, at: "2026-09-30T00:00:00.000Z" }; },
		persistSupersededArtifact: () => {},
		sanitizeEvidenceText: (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : ""),
		CONSENT_TEXT_MAX: 1000,
		effectiveDateFromStamp: () => "",
		refreshInvestorOnboardingStatus: () => "fully_onboarded",
		SIGNED_ARCHIVE_DIR: TMP,
		sha256File: () => "",
		console: { error: (...a) => calls.errors.push(a.join(" ")), warn() {}, log() {} },
	};
	const r = { ...ROUTES, ...routes };
	const body = [
		PIECES.evidence, PIECES.docs, PIECES.fields, PIECES.inflight, PIECES.inviteConsts, PIECES.inviteFns, PIECES.shared,
		...Object.values(r),
		"return { getInflight: () => pdfPreviewInflight, setInflight: (n) => { pdfPreviewInflight = n; } };",
	].join("\n");
	const names = Object.keys(env);
	const api = new Function(...names, `"use strict";\n${body}`)(...names.map((k) => env[k]));
	async function call(verb, p, { body: reqBody = {}, params = {}, query = {}, headers = {}, user = null } = {}) {
		const h = handlers[`${verb} ${p}`];
		if (!h) throw new Error(`no handler for ${verb} ${p}`);
		const out = { status: 200, body: undefined, sent: null, headers: {}, headersSent: false };
		const res = {
			get headersSent() { return out.headersSent; },
			status(c) { out.status = c; return res; },
			json(b) { out.body = JSON.parse(JSON.stringify(b)); out.headersSent = true; return res; },
			send(b) { out.sent = b; out.headersSent = true; return res; },
			end(b) { out.sent = b; out.headersSent = true; return res; },
			setHeader(k, v) { out.headers[String(k).toLowerCase()] = v; },
		};
		const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
		const req = {
			body: reqBody, params, query, headers: lower, get: (n) => lower[String(n).toLowerCase()],
			session: user ? { user } : {}, ip: "127.0.0.1", socket: { remoteAddress: "127.0.0.1" },
		};
		await h(req, res);
		return out;
	}
	return { db, calls, state, call, ...api };
}

// ── fixtures ────────────────────────────────────────────────────────────────
const LEASE_BODY = { inviteeName: "Pat Sample", inviteeEmail: "pat@example.com", paymentType: "lease", leaseAmount: "2000", details: "Paid on the 5th." };
const SPLIT_BODY = { inviteeName: "Sam Split", inviteeEmail: "", paymentType: "split", details: "Reviewed after 12 months." };
const STANDARD_BODY = { inviteeName: "Stan Dard", paymentType: "split" };
function applyBody(extra = {}) {
	return {
		legal_name: "Sample Holdings LLC", email: "applicant@example.com", phone: "555-0100", address: "1 Main St, Houston, TX",
		ein_ssn: "00-0000000", entity_type: "LLC",
		vehicles: [{ year: "2022", make: "Volvo", model: "VNL", vin: "4V4NC9EH0NN000000" }],
		banking: { bank_name: "Test Bank", routing_number: "000000000", account_number: "000123", account_type: "Business Checking" },
		signatures: Object.fromEntries(["master_agreement", "vehicle_lease", "w9"].map((k) => [k, { text: "Pat Sample", consent: { agreed: true, text: "I agree" } }])),
		...extra,
	};
}
const tokenOf = (invitePath) => (invitePath || "").split("invite=")[1] || "";
async function createInvite(srv, body) {
	const out = await srv.call("POST", "/api/admin/investor-invites", { body, user: SUPER });
	return { out, token: tokenOf(out.body && out.body.invitePath), id: out.body && out.body.invite && out.body.invite.id };
}
const appCount = (db) => db.prepare("SELECT COUNT(*) AS c FROM investor_applications").get().c;
const docRows = (db, appId) => db.prepare("SELECT doc_key, payment_terms_json FROM investor_onboarding_documents WHERE application_id = ? ORDER BY doc_key").all(appId);
const inviteRow = (db, id) => db.prepare("SELECT * FROM investor_invites WHERE id = ?").get(id);
const audits = (db, action) => db.prepare("SELECT * FROM audit_trail WHERE action = ? ORDER BY id").all(action);
const dump = (db, table) => JSON.stringify(db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all());
const LEASE_TERMS = { type: "lease", leaseAmountCents: 200000, details: "Paid on the 5th." };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// The three fields a contract prints; a parsed snapshot also carries its invite id, revision and time.
const termsOf = (t) => t && { type: t.type, leaseAmountCents: t.leaseAmountCents, details: t.details };

// ── §1 admin routes and the public lookup ───────────────────────────────────
async function scenarioAdmin(srv) {
	const out = [];
	const check = (name, cond) => out.push({ name, ok: !!cond });
	const { db, call, calls } = srv;

	const created = await createInvite(srv, LEASE_BODY);
	const hash = investorPaymentTerms.hashInviteToken(created.token);
	check("create answers 201 with the invite and a /invest?invite= link", created.out.status === 201 && /^\/invest\?invite=[A-Za-z0-9_-]{43}$/.test(created.out.body.invitePath));
	const inviteJson = JSON.stringify(created.out.body.invite);
	check("the created invite carries neither the token nor its hash", !inviteJson.includes(created.token) && !inviteJson.includes(hash) && !/token/i.test(Object.keys(created.out.body.invite).join()));
	check("only the token's sha256 is stored", inviteRow(db, created.id).token_sha256 === hash && !dump(db, "investor_invites").includes(created.token));
	check("the invite's shape", same(created.out.body.invite.paymentTerms, LEASE_TERMS) && created.out.body.invite.termsRevision === 1 &&
		created.out.body.invite.status === "active" && created.out.body.invite.isStandard === false &&
		created.out.body.invite.display.summary === "Fixed monthly lease payment — $2,000.00 per month — with additional terms" &&
		created.out.body.invite.createdBy === "super_admin" && created.out.body.invite.applicationId === null);
	check("the expiry is 30 days out", Math.abs(Date.parse(created.out.body.invite.expiresAt) - Date.now() - 30 * 864e5) < 60000);
	check("create is audited and notified", audits(db, "create_investor_invite").length === 1 && calls.notify.includes("investor-invites"));
	check("the audit row names the terms, never the token", audits(db, "create_investor_invite")[0].details.includes("$2,000.00") && !audits(db, "create_investor_invite")[0].details.includes(created.token));

	const bad = [
		[{ ...LEASE_BODY, inviteeName: "" }, 400, "INVALID_FIELD", "inviteeName"],
		[{ ...LEASE_BODY, inviteeName: ["a"] }, 400, "INVALID_FIELD", "inviteeName"],
		[{ ...LEASE_BODY, inviteeEmail: "a@b.com, c@d.com" }, 400, "INVALID_EMAIL", "inviteeEmail"],
		[{ ...LEASE_BODY, leaseAmount: "" }, 400, "INVALID_PAYMENT_TERMS", "leaseAmount"],
		[{ ...LEASE_BODY, leaseAmount: "1e3" }, 400, "INVALID_PAYMENT_TERMS", "leaseAmount"],
		[{ ...LEASE_BODY, paymentType: "bonus" }, 400, "INVALID_PAYMENT_TERMS", "paymentType"],
		[{ ...LEASE_BODY, details: `Great ${String.fromCodePoint(0x1f600)}` }, 400, "INVALID_PAYMENT_TERMS", "details"],
	];
	const before = dump(db, "investor_invites");
	for (const [body, status, code, field] of bad) {
		const r = await call("POST", "/api/admin/investor-invites", { body, user: SUPER });
		check(`create refuses ${JSON.stringify(body).slice(0, 60)}… with ${status} ${code} (${field})`, r.status === status && r.body.code === code && r.body.field === field);
	}
	check("a refused create writes nothing", dump(db, "investor_invites") === before);

	const list = await call("GET", "/api/admin/investor-invites", { query: {}, user: SUPER });
	const listJson = JSON.stringify(list.body);
	check("the list has the invite and neither token nor hash", list.body.invites.length === 1 && !listJson.includes(created.token) && !listJson.includes(hash) && !listJson.includes("token_sha256"));
	check("the list filters by status", (await call("GET", "/api/admin/investor-invites", { query: { status: "active" }, user: SUPER })).body.invites.length === 1 &&
		(await call("GET", "/api/admin/investor-invites", { query: { status: "used" }, user: SUPER })).body.invites.length === 0);
	check("an unknown status filter is 400", (await call("GET", "/api/admin/investor-invites", { query: { status: "bogus" }, user: SUPER })).status === 400);

	// Public lookup.
	const look = await call("GET", "/api/public/investor-invite", { headers: { "X-Invite-Token": created.token } });
	check("the public lookup answers the invite", look.status === 200 && same(Object.keys(look.body.invite).sort(),
		["display", "expiresAt", "inviteeEmail", "inviteeName", "isStandard", "paymentTerms", "termsRevision"]) && same(look.body.invite.paymentTerms, LEASE_TERMS));
	check("…with no-store and noindex", look.headers["cache-control"] === "no-store" && look.headers["x-robots-tag"] === "noindex");
	const opened = inviteRow(db, created.id).first_opened_at;
	await call("GET", "/api/public/investor-invite", { headers: { "X-Invite-Token": created.token } });
	check("first_opened_at is stamped once", !!opened && inviteRow(db, created.id).first_opened_at === opened);
	check("a malformed or unknown link is 404", (await call("GET", "/api/public/investor-invite", { headers: { "X-Invite-Token": "abc" } })).body.code === "INVITE_NOT_FOUND" &&
		(await call("GET", "/api/public/investor-invite", { headers: { "X-Invite-Token": "A".repeat(43) } })).status === 404 &&
		(await call("GET", "/api/public/investor-invite", {})).status === 404);

	// Update.
	check("an edit without expectedRevision is 400", (await call("PUT", "/api/admin/investor-invites/:id", { params: { id: String(created.id) }, body: LEASE_BODY, user: SUPER })).body.code === "REVISION_REQUIRED");
	const nameOnly = await call("PUT", "/api/admin/investor-invites/:id", { params: { id: String(created.id) }, body: { ...LEASE_BODY, inviteeName: "Pat Q. Sample", expectedRevision: 1 }, user: SUPER });
	check("a name-only edit keeps the revision", nameOnly.status === 200 && nameOnly.body.invite.termsRevision === 1 && nameOnly.body.invite.inviteeName === "Pat Q. Sample");
	const termsEdit = await call("PUT", "/api/admin/investor-invites/:id", { params: { id: String(created.id) }, body: { ...LEASE_BODY, leaseAmount: "2500", expectedRevision: 1 }, user: SUPER });
	check("a terms edit bumps the revision", termsEdit.status === 200 && termsEdit.body.invite.termsRevision === 2 && termsEdit.body.invite.paymentTerms.leaseAmountCents === 250000);
	const upd = audits(db, "update_investor_invite");
	check("edits are audited before → after", upd.length === 2 && upd[1].details.includes("$2,000.00") && upd[1].details.includes("$2,500.00") && upd[1].details.includes("revision 1 → 2"));
	const stale = await call("PUT", "/api/admin/investor-invites/:id", { params: { id: String(created.id) }, body: { ...LEASE_BODY, expectedRevision: 1 }, user: SUPER });
	check("a stale revision is 409 with the current one", stale.status === 409 && stale.body.code === "INVITE_REVISION_CONFLICT" && stale.body.termsRevision === 2);
	check("an unknown id is 404", (await call("PUT", "/api/admin/investor-invites/:id", { params: { id: "999" }, body: { ...LEASE_BODY, expectedRevision: 1 }, user: SUPER })).body.code === "INVITE_NOT_FOUND");
	const noChange = await call("PUT", "/api/admin/investor-invites/:id", { params: { id: String(created.id) }, body: { ...LEASE_BODY, leaseAmount: "$2500.00", expectedRevision: 2 }, user: SUPER });
	check("an edit that changes nothing writes nothing", noChange.status === 200 && audits(db, "update_investor_invite").length === 2);

	// Reissue.
	const reissued = await call("POST", "/api/admin/investor-invites/:id/reissue", { params: { id: String(created.id) }, user: SUPER });
	const newToken = tokenOf(reissued.body.invitePath);
	check("reissue answers a new link", reissued.status === 200 && newToken.length === 43 && newToken !== created.token);
	check("the old link is dead", (await call("GET", "/api/public/investor-invite", { headers: { "X-Invite-Token": created.token } })).status === 404);
	check("the new link works, unopened, same revision", inviteRow(db, created.id).first_opened_at === null &&
		(await call("GET", "/api/public/investor-invite", { headers: { "X-Invite-Token": newToken } })).body.invite.termsRevision === 2);
	check("reissue is audited", audits(db, "reissue_investor_invite").length === 1);

	// Revoke.
	check("a revoke reason over 300 characters is 400", (await call("POST", "/api/admin/investor-invites/:id/revoke", { params: { id: String(created.id) }, body: { reason: "x".repeat(301) }, user: SUPER })).status === 400);
	const revoked = await call("POST", "/api/admin/investor-invites/:id/revoke", { params: { id: String(created.id) }, body: { reason: "Sent to the wrong person\nsecond line" }, user: SUPER });
	check("revoke answers the revoked invite", revoked.status === 200 && revoked.body.invite.status === "revoked" && revoked.body.invite.revokeReason === "Sent to the wrong person second line");
	check("a revoked link is 410", (await call("GET", "/api/public/investor-invite", { headers: { "X-Invite-Token": newToken } })).body.code === "INVITE_REVOKED");
	check("a revoked invite cannot be edited or reissued", (await call("PUT", "/api/admin/investor-invites/:id", { params: { id: String(created.id) }, body: { ...LEASE_BODY, expectedRevision: 2 }, user: SUPER })).body.code === "INVITE_REVOKED" &&
		(await call("POST", "/api/admin/investor-invites/:id/reissue", { params: { id: String(created.id) }, user: SUPER })).body.code === "INVITE_REVOKED");
	check("revoke is audited once", audits(db, "revoke_investor_invite").length === 1);

	// Expiry.
	const exp = await createInvite(srv, SPLIT_BODY);
	db.prepare("UPDATE investor_invites SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(exp.id);
	check("an expired link is 410", (await call("GET", "/api/public/investor-invite", { headers: { "X-Invite-Token": exp.token } })).body.code === "INVITE_EXPIRED");
	check("the list derives expired", (await call("GET", "/api/admin/investor-invites", { query: { status: "expired" }, user: SUPER })).body.invites.map((i) => i.id).join() === String(exp.id));

	// Admin preview renders the invite's terms for the sample applicant.
	const prev = await call("POST", "/api/admin/investor-invites/:id/preview/:docKey", { params: { id: String(created.id), docKey: "master_agreement" }, user: SUPER });
	const last = calls.renders[calls.renders.length - 1];
	check("the admin preview renders the invite's terms for the sample applicant", prev.headers["content-type"] === "application/pdf" && last.data.legalName === "Sample Investor LLC" &&
		last.data.paymentTerms.leaseAmountCents === 250000 && prev.headers["x-payment-terms-revision"] === "2");
	check("the admin preview refuses the W-9 and unknown ids", (await call("POST", "/api/admin/investor-invites/:id/preview/:docKey", { params: { id: String(created.id), docKey: "w9" }, user: SUPER })).status === 404 &&
		(await call("POST", "/api/admin/investor-invites/:id/preview/:docKey", { params: { id: "999", docKey: "vehicle_lease" }, user: SUPER })).body.code === "INVITE_NOT_FOUND");
	return out;
}

// ── §2 apply ────────────────────────────────────────────────────────────────
async function scenarioApply(srv) {
	const out = [];
	const check = (name, cond) => out.push({ name, ok: !!cond });
	const { db, call, calls } = srv;

	// No invite: today's path.
	const lease = await createInvite(srv, LEASE_BODY);
	const invitesBefore = dump(db, "investor_invites");
	const plain = await call("POST", "/api/public/investor-apply", { body: applyBody() });
	check("a plain application still succeeds", plain.status === 200 && plain.body.success === true);
	check("with no invite every snapshot is NULL", docRows(db, plain.body.applicationId).every((r) => r.payment_terms_json === null));
	check("with no invite the invites table is untouched", dump(db, "investor_invites") === invitesBefore);
	check("with no invite the contracts render the standard terms", calls.renders.length === 2 && calls.renders.every((r) => r.data.paymentTerms === null));
	check("with no invite the admin email has no terms block", !calls.mail.find((m) => m.to === "info@logisx.com").html.includes("Payment terms invitation"));

	// With an invite.
	calls.renders.length = 0;
	const bound = await call("POST", "/api/public/investor-apply", { body: applyBody({ invite_token: lease.token, invite_terms_revision: 1 }) });
	const appId = bound.body && bound.body.applicationId;
	const row = inviteRow(db, lease.id);
	check("an invited application succeeds", bound.status === 200 && !!appId);
	check("the invite is bound: used, to this application", row.status === "used" && row.application_id === appId && !!row.used_at);
	const snaps = Object.fromEntries(docRows(db, appId).map((r) => [r.doc_key, r.payment_terms_json]));
	const parsed = investorPaymentTerms.parseSnapshot(snaps.master_agreement);
	check("the master and lease carry one snapshot of the invite's terms", snaps.master_agreement === snaps.vehicle_lease &&
		same({ type: parsed.type, leaseAmountCents: parsed.leaseAmountCents, details: parsed.details }, LEASE_TERMS) && parsed.inviteId === lease.id && parsed.termsRevision === 1);
	check("the W-9 carries no snapshot", snaps.w9 === null);
	check("both contracts render the invite's terms", calls.renders.length === 2 && calls.renders.every((r) => same(r.data.paymentTerms, LEASE_TERMS)));
	check("the bind is audited and notified", audits(db, "bind_investor_invite").length === 1 && audits(db, "bind_investor_invite")[0].entity_id === String(lease.id));
	const adminMail = calls.mail.filter((m) => m.to === "info@logisx.com").pop();
	check("the admin email carries the terms", adminMail.html.includes(`Payment terms invitation #${lease.id} (terms revision 1)`) && adminMail.html.includes("Paid on the 5th."));
	check("the admin email is the terms block between the warning and the body", adminMail.html.indexOf("Payment terms invitation") < adminMail.html.indexOf("A new investor application"));
	check("no step after the response failed", calls.errors.length === 0);

	// Single use.
	const count = appCount(db);
	const again = await call("POST", "/api/public/investor-apply", { body: applyBody({ invite_token: lease.token, invite_terms_revision: 1 }) });
	check("second submit refused 410", again.status === 410 && again.body.code === "INVITE_USED");
	check("second submit writes no application", appCount(db) === count);

	// Stale revision.
	const split = await createInvite(srv, SPLIT_BODY);
	await call("PUT", "/api/admin/investor-invites/:id", { params: { id: String(split.id) }, body: { ...SPLIT_BODY, details: "Changed.", expectedRevision: 1 }, user: SUPER });
	const staleBefore = dump(db, "investor_invites");
	const stale = await call("POST", "/api/public/investor-apply", { body: applyBody({ invite_token: split.token, invite_terms_revision: 1 }) });
	check("a stale revision is 409 with the current revision", stale.status === 409 && stale.body.code === "INVITE_TERMS_CHANGED" && stale.body.termsRevision === 2);
	check("a stale revision writes nothing", appCount(db) === count && dump(db, "investor_invites") === staleBefore);
	check("a token without a revision is 400", (await call("POST", "/api/public/investor-apply", { body: applyBody({ invite_token: split.token }) })).body.code === "INVITE_REVISION_REQUIRED");
	check("a malformed or unknown token is 404", (await call("POST", "/api/public/investor-apply", { body: applyBody({ invite_token: "nope", invite_terms_revision: 1 }) })).body.code === "INVITE_NOT_FOUND" &&
		(await call("POST", "/api/public/investor-apply", { body: applyBody({ invite_token: "B".repeat(43), invite_terms_revision: 1 }) })).status === 404);
	check("a token that is not one scalar is 400", (await call("POST", "/api/public/investor-apply", { body: applyBody({ invite_token: [split.token], invite_terms_revision: 2 }) })).body.code === "INVALID_FIELD");
	const expired = await createInvite(srv, STANDARD_BODY);
	db.prepare("UPDATE investor_invites SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(expired.id);
	check("an expired link is 410", (await call("POST", "/api/public/investor-apply", { body: applyBody({ invite_token: expired.token, invite_terms_revision: 1 }) })).body.code === "INVITE_EXPIRED");
	check("refusals wrote no application", appCount(db) === count);

	// Body terms are ignored.
	calls.renders.length = 0;
	const hijack = {
		paymentTerms: { type: "lease", leaseAmountCents: 999900, details: "hijack" },
		payment_type: "lease", lease_amount_cents: 999900, leaseAmountCents: 999900, amendment_details: "hijack", leaseAmount: "9999", details: "hijack",
	};
	const viaBody = await call("POST", "/api/public/investor-apply", { body: applyBody({ invite_token: split.token, invite_terms_revision: 2, ...hijack }) });
	const splitTerms = { type: "split", leaseAmountCents: null, details: "Changed." };
	const bodySnap = investorPaymentTerms.parseSnapshot(docRows(db, viaBody.body.applicationId).find((r) => r.doc_key === "master_agreement").payment_terms_json);
	check("body terms ignored (snapshot)", viaBody.status === 200 && same({ type: bodySnap.type, leaseAmountCents: bodySnap.leaseAmountCents, details: bodySnap.details }, splitTerms));
	check("body terms ignored (render)", calls.renders.length === 2 && calls.renders.every((r) => same(r.data.paymentTerms, splitTerms)));

	// A refusal inside the transaction rolls everything back.
	const racer = await createInvite(srv, LEASE_BODY);
	const counts = () => ["investor_applications", "investor_payment_info", "investor_onboarding", "investor_onboarding_documents"].map((t) => db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c).join();
	const beforeRace = counts();
	srv.hooks.beforeTx = (d) => d.prepare("UPDATE investor_invites SET status = 'revoked', revoked_at = 'x' WHERE id = ?").run(racer.id);
	const raced = await call("POST", "/api/public/investor-apply", { body: applyBody({ invite_token: racer.token, invite_terms_revision: 1 }) });
	srv.hooks.beforeTx = null;
	check("an invite revoked after the pre-check is refused inside the transaction", raced.status === 410 && raced.body.code === "INVITE_REVOKED");
	check("…and every write of that submission is rolled back", counts() === beforeRace && inviteRow(db, racer.id).status === "revoked" && inviteRow(db, racer.id).application_id === null);

	// A standard invite binds but snapshots nothing.
	calls.renders.length = 0;
	const std = await createInvite(srv, STANDARD_BODY);
	const stdApp = await call("POST", "/api/public/investor-apply", { body: applyBody({ invite_token: std.token, invite_terms_revision: 1 }) });
	check("a standard invite is bound", inviteRow(db, std.id).status === "used" && inviteRow(db, std.id).application_id === stdApp.body.applicationId);
	check("a standard invite snapshots NULL and renders the standard contract", docRows(db, stdApp.body.applicationId).every((r) => r.payment_terms_json === null) &&
		calls.renders.every((r) => r.data.paymentTerms === null));
	return out;
}

// ── §3 preview ──────────────────────────────────────────────────────────────
const TODAY_PREVIEW_KEYS = ["legalName", "dba", "entityType", "address", "contactPerson", "contactTitle", "phone", "email", "einSsn",
	"yearsInOperation", "fleetSize", "vehicles", "bankName", "bankRouting", "bankAccount", "accountType", "effectiveDate",
	"signatureText", "signatureImage", "signedAt"];
async function scenarioPreview(srv) {
	const out = [];
	const check = (name, cond) => out.push({ name, ok: !!cond });
	const { db, call, calls } = srv;
	const lease = await createInvite(srv, LEASE_BODY);
	const pbody = (extra = {}) => ({ legal_name: "Sample Holdings LLC", vehicles: [], ...extra });
	const hijack = { paymentTerms: { type: "lease", leaseAmountCents: 999900, details: "hijack" }, payment_type: "lease", lease_amount_cents: 999900, amendment_details: "hijack" };

	const plain = await call("POST", "/api/public/investor-preview-pdf/:docKey", { params: { docKey: "master_agreement" }, body: pbody(hijack) });
	const plainData = calls.renders[calls.renders.length - 1].data;
	check("no token: the render data is today's shape", plain.headers["content-type"] === "application/pdf" && same(Object.keys(plainData), TODAY_PREVIEW_KEYS));
	check("no token: no new header", !("x-payment-terms-revision" in plain.headers) && !("cache-control" in plain.headers));
	check("no token: body terms are ignored", !("paymentTerms" in plainData));

	const viaInvite = await call("POST", "/api/public/investor-preview-pdf/:docKey", { params: { docKey: "vehicle_lease" }, body: pbody({ invite_token: lease.token, ...hijack }) });
	const inviteData = calls.renders[calls.renders.length - 1].data;
	check("preview body terms ignored", same(inviteData.paymentTerms, LEASE_TERMS));
	check("an invite render sends its revision and no-store", viaInvite.headers["x-payment-terms-revision"] === "1" && viaInvite.headers["cache-control"] === "no-store");
	check("an invite render is today's data plus the terms", same(Object.keys(inviteData), [...TODAY_PREVIEW_KEYS, "paymentTerms"]));

	// A bad link is refused before the in-flight cap and before any render.
	const rendersBefore = calls.renders.length;
	srv.setInflight(3);
	const badAtCap = await call("POST", "/api/public/investor-preview-pdf/:docKey", { params: { docKey: "master_agreement" }, body: pbody({ invite_token: "Z".repeat(43) }) });
	check("a bad link is 404 before the in-flight cap", badAtCap.status === 404 && badAtCap.body.code === "INVITE_NOT_FOUND" && srv.getInflight() === 3);
	const goodAtCap = await call("POST", "/api/public/investor-preview-pdf/:docKey", { params: { docKey: "master_agreement" }, body: pbody({ invite_token: lease.token }) });
	check("…while a good link still meets the cap", goodAtCap.status === 503);
	srv.setInflight(0);
	check("…and neither started a render", calls.renders.length === rendersBefore);
	check("a malformed link is 404", (await call("POST", "/api/public/investor-preview-pdf/:docKey", { params: { docKey: "master_agreement" }, body: pbody({ invite_token: "x" }) })).status === 404);
	db.prepare("UPDATE investor_invites SET status = 'revoked', revoked_at = 'x' WHERE id = ?").run(lease.id);
	check("a revoked link is 410", (await call("POST", "/api/public/investor-preview-pdf/:docKey", { params: { docKey: "master_agreement" }, body: pbody({ invite_token: lease.token }) })).body.code === "INVITE_REVOKED");
	check("no render ran for a refused link", calls.renders.length === rendersBefore);

	const other = await createInvite(srv, SPLIT_BODY);
	const w9 = await call("POST", "/api/public/investor-preview-pdf/:docKey", { params: { docKey: "w9" }, body: pbody({ invite_token: other.token }) });
	check("the W-9 renders without terms, with the invite headers", w9.headers["x-payment-terms-revision"] === "1" && !("paymentTerms" in calls.w9[calls.w9.length - 1]));
	return out;
}

// ── §4 regenerate ───────────────────────────────────────────────────────────
async function scenarioRegenerate(srv) {
	const out = [];
	const check = (name, cond) => out.push({ name, ok: !!cond });
	const { db, call, calls, state } = srv;
	const lease = await createInvite(srv, LEASE_BODY);
	const applied = await call("POST", "/api/public/investor-apply", { body: applyBody({ invite_token: lease.token, invite_terms_revision: 1 }) });
	const appId = applied.body.applicationId;
	// The invite row changes after signing (it is locked by the routes; this is
	// a direct write standing in for anything that goes around them).
	db.prepare("UPDATE investor_invites SET lease_amount_cents = 350000, amendment_details = 'Changed after signing.' WHERE id = ?").run(lease.id);
	db.prepare("UPDATE investor_onboarding_documents SET signed = 0 WHERE application_id = ? AND doc_key = 'master_agreement'").run(appId);
	calls.renders.length = 0;
	const regen = await call("POST", "/api/admin/investor-onboarding/:id/documents/:docKey/regenerate", { params: { id: String(appId), docKey: "master_agreement" }, body: {}, user: SUPER });
	check("regenerate succeeds", regen.status === 200 && regen.body.regenerated === true);
	check("regenerate renders the snapshot", calls.renders.length === 1 && same(termsOf(calls.renders[0].data.paymentTerms), LEASE_TERMS));
	const audit = audits(db, "regenerate_investor_document").pop();
	check("the regenerate audit names the terms", !!audit && audit.details.includes("payment terms: Fixed monthly lease payment — $2,000.00 per month"));

	// An unreadable snapshot is refused before the archive step.
	db.prepare("UPDATE investor_onboarding_documents SET payment_terms_json = '{\"v\":1,\"type\":\"lease\"}', signed = 1 WHERE application_id = ? AND doc_key = 'master_agreement'").run(appId);
	state.artifactPresent = true;
	calls.renders.length = 0;
	const broken = await call("POST", "/api/admin/investor-onboarding/:id/documents/:docKey/regenerate", {
		params: { id: String(appId), docKey: "master_agreement" }, body: { force: true, reason: "Re-render for the terms test" }, user: SUPER,
	});
	check("an unreadable snapshot is 409", broken.status === 409 && broken.body.code === "PAYMENT_TERMS_SNAPSHOT_INVALID");
	check("…before the archive step and any render", calls.archived === 0 && calls.renders.length === 0);
	state.artifactPresent = false;

	// The standard contract regenerates on the standard terms, and the W-9 has none.
	const plain = await call("POST", "/api/public/investor-apply", { body: applyBody() });
	db.prepare("UPDATE investor_onboarding_documents SET signed = 0 WHERE application_id = ?").run(plain.body.applicationId);
	calls.renders.length = 0;
	await call("POST", "/api/admin/investor-onboarding/:id/documents/:docKey/regenerate", { params: { id: String(plain.body.applicationId), docKey: "vehicle_lease" }, body: {}, user: SUPER });
	check("a standard document regenerates on the standard terms", calls.renders.length === 1 && calls.renders[0].data.paymentTerms === null);
	const w9 = await call("POST", "/api/admin/investor-onboarding/:id/documents/:docKey/regenerate", { params: { id: String(plain.body.applicationId), docKey: "w9" }, body: {}, user: SUPER });
	check("the W-9 regenerates", w9.status === 200 && w9.body.regenerated === true);
	return out;
}

// ── §5 views ────────────────────────────────────────────────────────────────
async function scenarioViews(srv) {
	const out = [];
	const check = (name, cond) => out.push({ name, ok: !!cond });
	const { db, call } = srv;
	const lease = await createInvite(srv, LEASE_BODY);
	const invited = (await call("POST", "/api/public/investor-apply", { body: applyBody({ invite_token: lease.token, invite_terms_revision: 1 }) })).body.applicationId;
	const plain = (await call("POST", "/api/public/investor-apply", { body: applyBody() })).body.applicationId;
	const addInvestor = db.prepare("INSERT INTO investors (full_name, carrier_name, application_id) VALUES (?, ?, ?)");
	const invInvited = addInvestor.run("Pat Sample", "Carrier A", invited).lastInsertRowid;
	const invPlain = addInvestor.run("Plain Investor", "Carrier B", plain).lastInsertRowid;
	const invNone = addInvestor.run("Manual Investor", "Carrier C", 0).lastInsertRowid;

	const v = (await call("GET", "/api/investors/:id/payment-terms", { params: { id: String(invInvited) }, user: SUPER })).body;
	check("the invited investor's view", v.state === "signed" && v.applicationId === invited && v.investorId === invInvited && same(v.paymentTerms, LEASE_TERMS) &&
		v.isDefault === false && v.consistent === true && v.display.summary.startsWith("Fixed monthly lease payment"));
	check("…its documents", same(v.documents.map((d) => [d.docKey, d.signed, d.hasSnapshot]), [["master_agreement", true, true], ["vehicle_lease", true, true], ["w9", true, false]]));
	check("…its invite", v.invite && v.invite.id === lease.id && v.invite.status === "used" && v.invite.termsRevision === 1 && !JSON.stringify(v).includes("token"));
	const p = (await call("GET", "/api/investors/:id/payment-terms", { params: { id: String(invPlain) }, user: SUPER })).body;
	check("a standard investor's view", p.state === "signed" && p.paymentTerms === null && p.isDefault === true && p.invite === null && p.consistent === true &&
		p.display.summary === "50/50 profit split — standard contract terms");
	const n = (await call("GET", "/api/investors/:id/payment-terms", { params: { id: String(invNone) }, user: SUPER })).body;
	check("an investor with no application", n.state === "no_application" && n.paymentTerms === null && n.documents.length === 0);
	check("an unknown investor is 404", (await call("GET", "/api/investors/:id/payment-terms", { params: { id: "9999" }, user: SUPER })).body.code === "INVESTOR_NOT_FOUND");
	db.prepare("UPDATE investor_onboarding_documents SET payment_terms_json = NULL WHERE application_id = ? AND doc_key = 'vehicle_lease'").run(invited);
	check("a lease that disagrees with the master is flagged", (await call("GET", "/api/investors/:id/payment-terms", { params: { id: String(invInvited) }, user: SUPER })).body.consistent === false);

	// Application list: Terms column, invite id, docs_total.
	const insApp = db.prepare("INSERT INTO investor_applications (legal_name, email, status, access_token) VALUES (?, 'x@example.com', 'New', 'secret-token')");
	const twoDocs = insApp.run("Two Docs LLC").lastInsertRowid;
	const addDoc = db.prepare("INSERT INTO investor_onboarding_documents (application_id, doc_key, doc_name) VALUES (?, ?, ?)");
	addDoc.run(twoDocs, "master_agreement", "Master");
	addDoc.run(twoDocs, "w9", "W-9");
	const noDocs = insApp.run("No Docs LLC").lastInsertRowid;
	const list = (await call("GET", "/api/investor-applications", { query: {}, user: SUPER })).body;
	const byId = new Map(list.map((a) => [a.id, a]));
	check("the list's Terms column", byId.get(invited).payment_terms_summary === "Fixed monthly lease payment — $2,000.00 per month — with additional terms" &&
		byId.get(plain).payment_terms_summary === "50/50 profit split — standard contract terms");
	check("the list's invite id", byId.get(invited).invite_id === lease.id && byId.get(plain).invite_id === null);
	check("the list's docs_total", byId.get(invited).docs_total === 3 && byId.get(twoDocs).docs_total === 2 && byId.get(noDocs).docs_total === 0);
	check("the list still drops the access token", list.every((a) => !("access_token" in a)) && !JSON.stringify(list).includes("secret-token"));
	const detail = (await call("GET", "/api/investor-applications/:id", { params: { id: String(plain) }, query: {}, user: SUPER })).body;
	check("the detail carries the payment terms view", detail.paymentTerms && detail.paymentTerms.state === "signed" && detail.paymentTerms.investorId === invPlain && detail.paymentTerms.isDefault === true);
	return out;
}

// ── run ─────────────────────────────────────────────────────────────────────
const SCENARIOS = { admin: scenarioAdmin, apply: scenarioApply, preview: scenarioPreview, regenerate: scenarioRegenerate, views: scenarioViews };
async function runScenario(key, opts = {}) {
	const hooks = {};
	const srv = buildServer({ ...opts, hooks });
	srv.hooks = hooks;
	return SCENARIOS[key](srv);
}

// A mutant is caught when the named check fails under it. A mutant that
// crashes the scenario proves nothing about the guard, so it fails the run.
async function caught(key, checkName, routes) {
	let results;
	try {
		results = await runScenario(key, { routes });
	} catch (e) {
		die(`mutant probe for "${checkName}" crashed the ${key} scenario: ${e.message}`);
	}
	const hit = results.find((r) => r.name === checkName);
	if (!hit) die(`mutant probe: no check named "${checkName}" in ${key}`);
	return !hit.ok;
}
function mutate(routeKey, from, to) {
	const src = ROUTES[routeKey];
	const next = src.replace(from, to);
	if (next === src) die(`mutant for ${routeKey} did not apply`);
	return { [routeKey]: next };
}

(async () => {
	for (const key of Object.keys(SCENARIOS)) record(`§ ${key}`, await runScenario(key));

	// §6 source pins.
	const FORBIDDEN = ["investor_invites", "payment_terms_json", "investorPaymentTerms", "investor-payment-terms"];
	const payoutSources = {
		resolveInvestorSplitPct: liftFunction("resolveInvestorSplitPct"),
		computeInvestorMonthlyEarnings: liftFunction("computeInvestorMonthlyEarnings"),
		reconcileInvestorPayouts: liftFunction("reconcileInvestorPayouts"),
		finalizePeriods: liftFunction("finalizePeriods"),
		"GET /api/investor": liftRoute('app.get("/api/investor", requireRole("Super Admin", "Investor"), async (req, res) => {'),
		"lib/payout-statement.js": fs.readFileSync(path.join(ROOT, "lib", "payout-statement.js"), "utf8"),
	};
	for (const [name, src] of Object.entries(payoutSources)) {
		ok(src.length > 100 && FORBIDDEN.every((t) => !src.includes(t)), `§6 ${name} references none of ${FORBIDDEN.join(", ")}`);
	}
	ok(!ROUTES.regenerate.includes("investor_invites") && !PIECES.shared.includes("investor_invites"), "§6 regenerate and buildInvestorDocRender never read investor_invites");
	const apply = ROUTES.apply;
	const precheck = apply.indexOf("resolveInviteToken(invite_token)");
	const tx = apply.indexOf("db.transaction(");
	const run = apply.indexOf("const appId = applyTx();");
	ok(precheck > 0 && precheck < tx && tx < run && !/\bawait\b/.test(apply.slice(precheck, run)), "§6 apply checks the invite before its transaction, with no await in between");
	ok(/const invite = inviteCheck \? db\.prepare\("SELECT \* FROM investor_invites WHERE id = \?"\)/.test(apply) && apply.indexOf("inviteUseRefusal(invite)") > tx,
		"§6 apply re-reads and re-checks the invite inside the transaction");
	const previewSrc = ROUTES.preview;
	ok(previewSrc.indexOf("resolveInviteToken(invite_token)") > 0 && previewSrc.indexOf("resolveInviteToken(invite_token)") < previewSrc.indexOf("pdfPreviewInflight >= PDF_PREVIEW_MAX_INFLIGHT"),
		"§6 preview resolves the invite before the in-flight cap");
	for (const key of ["create", "update", "reissue", "revoke"]) {
		ok(!/\bawait\b/.test(ROUTES[key]) && ROUTES[key].includes("refuseCrossOrigin"), `§6 ${key} is synchronous and same-origin only`);
	}
	ok(/PUBLIC_INVESTOR_SCALAR_FIELDS = \[[^\]]*"invite_token", "invite_terms_revision"/.test(SRC), "§6 the invite fields are checked as scalars");

	// §7 mutants, one per guard.
	const bindUpdate = /const used = db\.prepare\(`UPDATE investor_invites SET status = 'used'[\s\S]*?\.run\([^)]*\);/;
	ok(await caught("apply", "second submit refused 410", mutate("apply", bindUpdate, "const used = { changes: 1 };")),
		"§7 MUTANT single use removed (the bind UPDATE skipped) is caught");
	ok(await caught("apply", "body terms ignored (render)", mutate("apply", "paymentTerms: boundInvite ? boundInvite.terms : null,",
		"paymentTerms: req.body.paymentTerms || (boundInvite ? boundInvite.terms : null),")),
	"§7 MUTANT apply rendering terms taken from the body is caught");
	ok(await caught("preview", "preview body terms ignored", mutate("preview", "? { ...appData, paymentTerms: investorPaymentTerms.effectiveTerms(investorPaymentTerms.termsFromInviteRow(invite)) }",
		"? { ...appData, paymentTerms: req.body.paymentTerms || investorPaymentTerms.effectiveTerms(investorPaymentTerms.termsFromInviteRow(invite)) }")),
	"§7 MUTANT preview rendering terms taken from the body is caught");
	ok(await caught("regenerate", "regenerate renders the snapshot", mutate("regenerate", "investorPaymentTerms.parseSnapshot(docRow.payment_terms_json)",
		"investorPaymentTerms.effectiveTerms(investorPaymentTerms.termsFromInviteRow(db.prepare(\"SELECT * FROM investor_invites WHERE application_id = ?\").get(appId)))")),
	"§7 MUTANT regenerate reading the invite row is caught");

	console.log(`\n${"=".repeat(64)}`);
	if (failures.length) {
		console.log(`FAILURES (${failures.length}):`);
		for (const f of failures) console.log(`  x ${f}`);
		console.log(`\n${pass} passed, ${failures.length} failed`);
		process.exit(1);
	}
	console.log(`${pass} assertions passed`);
})().catch((e) => {
	console.error("FAIL  runner crashed:", e);
	process.exit(1);
});
