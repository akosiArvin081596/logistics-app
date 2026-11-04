"use strict";
// The C.H. Robinson page's routes, under /api/integrations/chr. Each one is
// registered on the app with requireRole("Super Admin") first; every write takes
// the same-origin guard next, then its limiter where it has one, so a refused
// request never spends the budget. A catch-all of the mount's own answers a
// JSON 404, so no CHR path ever reaches the app page. Answers hold codes,
// times, counts and each row's allowlisted payload: never a person's name or
// address, a response from CHR or a deny value.
//
// Who may choose Pilot or Live and press Test connection (A3, fail closed): only
// an account on the listed-accounts setting, never the shared login. The pilot
// is set or moved only while sending is off (M6). Any Super Admin may view,
// choose Off or Dry run, hold a load, retry, resume and press Stop everything.

const rateLimit = require("express-rate-limit");
const E = require("./chr-events");
const S = require("./chr-store");
const appTime = require("./app-time");
const { isSharedLoginName } = require("./sign-in");

const MOUNT_PATH = "/api/integrations/chr";
// The load-detail id rule the status routes use: checked before any lookup.
const LOAD_ID_RE = /^[A-Za-z0-9\-_.#]{1,40}$/;
const HOLD_LIMIT = Object.freeze({ windowMs: 15 * 60 * 1000, max: 30 });
const RETRY_LIMIT = Object.freeze({ windowMs: 15 * 60 * 1000, max: 30 });
const RESUME_LIMIT = Object.freeze({ windowMs: 15 * 60 * 1000, max: 6 });
const TEST_LIMIT = Object.freeze({ windowMs: 15 * 60 * 1000, max: 6 });
// A retry of a milestone older than this needs confirmOld; a resume gives up
// pending rows older than RESUME_OLD_MS unless the person confirms.
const RETRY_OLD_MS = 24 * 60 * 60 * 1000;
const RESUME_OLD_MS = 2 * 60 * 60 * 1000;
const RECENT_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
const REASON_MAX = 200;
const MODE_KINDS = Object.freeze(["milestones", "location"]);
// The page's POD and draft lines: a count, and the newest draft's time and
// whether it went to a chrobinson.com address. The recipient is read only to
// answer that; it never leaves this file.
const POD_COUNT_SQL = "SELECT COUNT(*) AS n FROM documents WHERE load_id IN (?, ?) AND UPPER(type) = 'POD' AND deleted_at IS NULL";
const DRAFT_SQL = "SELECT created_at, recipient FROM load_invoice_drafts WHERE load_id IN (?, ?) ORDER BY id DESC LIMIT 1";

const LIVE_REFUSED = Object.freeze({
	not_listed: "Only an account on the listed-accounts setting may choose Live.",
	live_all_off: "Live for every C.H. Robinson load is switched off on the server; a pilot can reach one load.",
	send_off: "Sending to C.H. Robinson is switched off on the server.",
	not_connected: "LogisX has no C.H. Robinson connection yet.",
});
const PILOT_REFUSED = Object.freeze({
	not_listed: "Only an account on the listed-accounts setting may set or move the pilot.",
	send_on: "The pilot can be set or moved only while sending to C.H. Robinson is off.",
});

function todayStartIso(nowMs) {
	try {
		const zone = appTime.appTimeZone();
		const [y, m, d] = appTime.dayInZone(new Date(nowMs), zone).split("-").map(Number);
		return new Date(appTime.wallClockToMs(zone, y, m, d, 0, 0, 0)).toISOString();
	} catch {
		return new Date(nowMs - DAY_MS).toISOString();
	}
}

// One chr_events row as the page may see it; the payload keeps only the
// allowlisted keys, even if a stored one held more.
function eventView(r) {
	let payload = null;
	if (r.payload_json) {
		try {
			const p = JSON.parse(r.payload_json);
			if (p && typeof p === "object" && !Array.isArray(p)) {
				payload = {};
				for (const k of E.PAYLOAD_KEYS) if (p[k] !== undefined) payload[k] = p[k];
			}
		} catch {
			payload = null;
		}
	}
	return {
		id: r.id, loadId: r.load_id, kind: r.kind, event: r.event, stop: { kind: r.stop_kind, index: r.stop_index }, source: r.source,
		eventAt: r.event_at, verify: r.verify, mode: r.mode, status: r.status, holdReason: r.hold_reason, skipReason: r.skip_reason,
		attempts: r.attempts, httpStatus: r.http_status, resultCode: r.result_code, fieldsDropped: r.fields_dropped,
		reverted: Boolean(r.reverted_at), createdAt: r.created_at, sentAt: r.sent_at, payload,
	};
}

function loadView(r) {
	return {
		loadId: r.load_id, multiStop: Boolean(r.multi_stop), multiStopWhy: r.multi_stop_why, hold: Boolean(r.hold), holdReason: r.hold_reason,
		holdBy: r.hold_by, holdAt: r.hold_at, lastEvent: r.last_event, lastEventAt: r.last_event_at, updatedAt: r.updated_at,
	};
}

// ctx: { db, config, on, status(), logAudit, onChange, now, log, listedAccounts,
// transportReady() }; guards: { requireRole, refuseCrossOrigin }, both required.
function mount(app, ctx, guards) {
	if (!guards || typeof guards.requireRole !== "function") throw new Error("chr-integration: mount() needs requireRole");
	if (typeof guards.refuseCrossOrigin !== "function") throw new Error("chr-integration: mount() needs refuseCrossOrigin");
	const { db, config } = ctx;
	const log = ctx.log || console;
	const now = typeof ctx.now === "function" ? ctx.now : () => Date.now();
	const onChange = typeof ctx.onChange === "function" ? ctx.onChange : () => {};
	const transportReady = typeof ctx.transportReady === "function" ? ctx.transportReady : () => false;
	const list = ctx.listedAccounts && typeof ctx.listedAccounts.verdict === "function" ? ctx.listedAccounts : null;
	// Written out on every route, so scripts/test-withheld-load-key-routes.js can see each
	// one opens with the Super Admin gate (a Super Admin is served every Load ID as stored,
	// so these routes never take an opaque key).
	const { requireRole } = guards;
	const write = guards.refuseCrossOrigin;
	const at = (p) => `${MOUNT_PATH}${p}`;
	const notFound = (res, code) => res.status(404).json({ error: "Not found", code });

	if (ctx.on !== true) {
		app.get(at("/status"), requireRole("Super Admin"), (req, res) => res.json({ enabled: false }));
		app.use(MOUNT_PATH, requireRole("Super Admin"), (req, res) => notFound(res, "FEATURE_OFF"));
		return;
	}
	const limiter = (limit, what) => rateLimit({
		windowMs: limit.windowMs,
		max: limit.max,
		keyGenerator: (req) => `u:${req.session.user.id}`,
		message: { error: `Too many C.H. Robinson ${what}. Try again in a few minutes.`, code: "CHR_RATE_LIMITED" },
		standardHeaders: true,
		legacyHeaders: false,
	});
	const holdLimiter = limiter(HOLD_LIMIT, "holds");
	const retryLimiter = limiter(RETRY_LIMIT, "retries");
	const resumeLimiter = limiter(RESUME_LIMIT, "resumes");
	const testLimiter = limiter(TEST_LIMIT, "connection tests");
	const testConnection = typeof ctx.testConnection === "function" ? ctx.testConnection : async () => ({ resultCode: "NOT_CONFIGURED", httpStatus: null });

	const audit = (req, action, entityId, details) => {
		try { ctx.logAudit(req, action, "chr", entityId, config.redactor.redact(details).slice(0, 2000)); } catch { log.error(`[chr] audit ${action} failed`); }
	};
	const userOf = (req) => (req.session && req.session.user) || null;
	const isListed = (user) => Boolean(user) && !isSharedLoginName(user.username) && Boolean(list) && list.state === "valid" && list.verdict(user) === "listed";
	function liveCheck(user) {
		if (!isListed(user)) return { allowed: false, reason: "not_listed" };
		if (config.liveAllEnabled !== true) return { allowed: false, reason: "live_all_off" };
		if (config.sendEnabled !== true) return { allowed: false, reason: "send_off" };
		if (transportReady() !== true) return { allowed: false, reason: "not_connected" };
		return { allowed: true, reason: "" };
	}
	// M6: the pilot is set or moved only while sending is off.
	function pilotCheck(user) {
		if (!isListed(user)) return { allowed: false, reason: "not_listed" };
		if (config.sendEnabled === true) return { allowed: false, reason: "send_on" };
		return { allowed: true, reason: "" };
	}
	const statusFor = (req) => ({
		...ctx.status(), today: S.countsByStatus(db, { sinceIso: todayStartIso(now()) }), live: liveCheck(userOf(req)), pilot: pilotCheck(userOf(req)),
		testConnection: { allowed: isListed(userOf(req)) },
	});
	// A failure answers a fixed code; the error's text stays out of the answer and the log.
	const guarded = (code, fn) => (req, res) => {
		try {
			return fn(req, res);
		} catch {
			log.error(`[chr] ${req.method} ${req.route ? req.route.path : MOUNT_PATH} failed`);
			return res.status(500).json({ error: "The C.H. Robinson page could not do that. Try again.", code });
		}
	};
	const keyOf = (req) => {
		const raw = String((req.params && req.params.loadId) || "");
		return LOAD_ID_RE.test(raw) ? E.loadKey(raw) : null;
	};
	const badLoad = (res) => res.status(400).json({ error: "That is not a load ID.", code: "INVALID_LOAD_ID" });
	const notChr = (res) => res.status(404).json({ error: "LogisX has no C.H. Robinson updates for that load.", code: "NOT_A_CHR_LOAD" });

	app.get(at("/status"), requireRole("Super Admin"), guarded("CHR_READ_FAILED", (req, res) => res.json(statusFor(req))));

	app.get(at("/events"), requireRole("Super Admin"), guarded("CHR_READ_FAILED", (req, res) => {
		const q = req.query || {};
		const status = typeof q.status === "string" ? q.status : "";
		const loadId = typeof q.loadId === "string" ? q.loadId : "";
		const before = typeof q.before === "string" ? q.before : "";
		if (status && !S.STATUSES.includes(status)) return res.status(400).json({ error: "That is not a status.", code: "INVALID_CHR_FILTER", field: "status" });
		if (loadId && !LOAD_ID_RE.test(loadId)) return res.status(400).json({ error: "That is not a load ID.", code: "INVALID_CHR_FILTER", field: "loadId" });
		if (before && !/^[1-9]\d{0,15}$/.test(before)) return res.status(400).json({ error: "That is not a row number.", code: "INVALID_CHR_FILTER", field: "before" });
		const rows = S.listEvents(db, { status, loadId: loadId ? E.loadKey(loadId) : "", before: before ? Number(before) : 0 });
		const events = rows.map(eventView);
		res.json({ events, next: events.length === S.EVENT_PAGE ? events[events.length - 1].id : null });
	}));

	app.get(at("/loads"), requireRole("Super Admin"), guarded("CHR_READ_FAILED", (req, res) => {
		const rows = S.recentLoads(db, { sinceIso: new Date(now() - RECENT_DAYS * DAY_MS).toISOString() });
		res.json({ loads: rows.map((r) => ({ ...loadView(r), counts: S.countsByStatus(db, { loadId: r.load_id }) })) });
	}));

	function podAndDraft(key) {
		const ids = [key, `#${key}`];
		let pod = null;
		let draft = null;
		try { pod = { count: db.prepare(POD_COUNT_SQL).get(...ids).n }; } catch { pod = null; }
		try {
			const d = db.prepare(DRAFT_SQL).get(...ids);
			draft = d ? { at: String(d.created_at || ""), toChr: E.isChrDomain(E.domainOf(String(d.recipient || ""))) } : null;
		} catch {
			draft = null;
		}
		return { pod, draft };
	}

	app.get(at("/loads/:loadId"), requireRole("Super Admin"), guarded("CHR_READ_FAILED", (req, res) => {
		const key = keyOf(req);
		if (key === null) return badLoad(res);
		const row = S.tablesExist(db) ? S.loadRow(db, key) : null;
		if (!row) return notChr(res);
		res.json({
			load: loadView(row),
			counts: S.countsByStatus(db, { loadId: key }),
			events: S.listEvents(db, { loadId: key }).map(eventView),
			...podAndDraft(key),
		});
	}));

	app.put(at("/settings"), requireRole("Super Admin"), write, guarded("CHR_WRITE_FAILED", (req, res) => {
		const parsed = S.settingsPatch(req.body);
		if (parsed.error) return res.status(400).json({ error: parsed.error, code: "INVALID_CHR_SETTINGS", field: parsed.field });
		const user = userOf(req);
		const before = S.readSettings(db);
		const { pilotLoad, ...fields } = parsed.patch;
		for (const kind of MODE_KINDS) {
			if (fields[kind] !== "live") continue;
			const live = liveCheck(user);
			if (!live.allowed) return res.status(409).json({ error: LIVE_REFUSED[live.reason], code: "SEND_NOT_PERMITTED", reason: live.reason, field: kind });
		}
		// Choosing Pilot for a kind, or naming the pilot's load, sets or moves the pilot.
		const movesPilot = pilotLoad !== undefined || MODE_KINDS.some((k) => fields[k] === "pilot" && before[k] !== "pilot");
		if (movesPilot) {
			const p = pilotCheck(user);
			if (!p.allowed) return res.status(409).json({ error: PILOT_REFUSED[p.reason], code: "PILOT_NOT_PERMITTED", reason: p.reason, field: pilotLoad !== undefined ? "pilotLoad" : "milestones" });
		}
		if (pilotLoad !== undefined) {
			// A key holding a protected number is never stored, and the answer never repeats
			// it; checked first, since the deny list can grow after a load was recorded.
			if (config.redactor.hits(pilotLoad)) return res.status(400).json({ error: "That load can't be the pilot.", code: "INVALID_CHR_SETTINGS", field: "pilotLoad" });
			if (!S.tablesExist(db) || !S.loadRow(db, pilotLoad)) {
				return res.status(409).json({ error: "The pilot must be a load the C.H. Robinson recorder has seen.", code: "NOT_A_CHR_LOAD", field: "pilotLoad" });
			}
		}
		const nowIso = new Date(now()).toISOString();
		let pilot = before.pilot;
		if (pilotLoad !== undefined && (!pilot || pilot.loadKey !== pilotLoad)) pilot = { loadKey: pilotLoad, setAt: nowIso, setBy: (user || {}).username || "", until: "" };
		const next = S.normalizeSettings({ ...before, ...fields, pilot });
		if (MODE_KINDS.some((k) => next[k] === "pilot") && !next.pilot) {
			return res.status(400).json({ error: "Name the pilot's load (a 9-digit Load ID).", code: "INVALID_CHR_SETTINGS", field: "pilotLoad" });
		}
		if (!MODE_KINDS.some((k) => next[k] === "pilot")) next.pilot = null;
		const changed = S.SETTING_FIELDS.filter((k) => before[k] !== next[k]);
		const pilotChanged = JSON.stringify(before.pilot) !== JSON.stringify(next.pilot);
		if (changed.length || pilotChanged) {
			S.writeSettings(db, next, { by: (user || {}).username || "", nowIso });
			for (const k of changed.filter((f) => MODE_KINDS.includes(f))) audit(req, "chr_mode_change", k, `${k}: ${before[k]} → ${next[k]}`);
			if (pilotChanged) audit(req, "chr_pilot_set", "pilot", next.pilot ? `The pilot load is ${next.pilot.loadKey}${before.pilot ? ` (was ${before.pilot.loadKey})` : ""}.` : "The pilot was cleared.");
			const rest = changed.filter((f) => !MODE_KINDS.includes(f));
			if (rest.length) audit(req, "chr_settings_update", "settings", rest.map((k) => `${k}: ${before[k]} → ${next[k]}`).join("; "));
			onChange();
		}
		res.json({ ...statusFor(req), changed: pilotChanged ? [...changed, "pilot"] : changed });
	}));

	// Every kind Off at once, whatever it was; always allowed.
	app.post(at("/stop"), requireRole("Super Admin"), write, guarded("CHR_WRITE_FAILED", (req, res) => {
		const nowIso = new Date(now()).toISOString();
		const before = S.readSettings(db);
		S.writeSettings(db, { ...before, ...Object.fromEntries(MODE_KINDS.map((k) => [k, "off"])) }, { by: (userOf(req) || {}).username || "", nowIso });
		audit(req, "chr_mode_change", "all", `Stop everything: ${MODE_KINDS.map((k) => `${k}: ${before[k]} → off`).join("; ")}`);
		onChange();
		res.json(statusFor(req));
	}));

	app.post(at("/loads/:loadId/hold"), requireRole("Super Admin"), write, holdLimiter, guarded("CHR_WRITE_FAILED", (req, res) => {
		const key = keyOf(req);
		if (key === null) return badLoad(res);
		const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
		const reason = typeof body.reason === "string" ? body.reason.trim() : "";
		if (typeof body.hold !== "boolean" || !reason || reason.length > REASON_MAX) {
			return res.status(400).json({ error: `Send hold (true or false) and a reason of at most ${REASON_MAX} characters.`, code: "INVALID_CHR_HOLD" });
		}
		if (!S.tablesExist(db) || !S.loadRow(db, key)) return notChr(res);
		const nowIso = new Date(now()).toISOString();
		const by = (userOf(req) || {}).username || "";
		const released = db.transaction(() => {
			S.setHold(db, { loadId: key, hold: body.hold, reason, by, nowIso, redactor: config.redactor });
			return body.hold ? 0 : S.releaseHeld(db, key, nowIso);
		})();
		if (body.hold) audit(req, "chr_load_hold", key, `Held: ${reason}`);
		else audit(req, "chr_load_release", key, `Released (${released} held update(s) go back to the checks): ${reason}`);
		onChange();
		res.json({ load: loadView(S.loadRow(db, key)), released });
	}));

	// A failed, given-up or unknown live update back to the sender. An unknown
	// outcome may already be at CHR, and an old milestone may be stale: each needs
	// the person's confirmation first.
	app.post(at("/events/:id/retry"), requireRole("Super Admin"), write, retryLimiter, guarded("CHR_WRITE_FAILED", (req, res) => {
		const raw = String((req.params && req.params.id) || "");
		if (!/^[1-9]\d{0,15}$/.test(raw)) return res.status(400).json({ error: "That is not a row number.", code: "INVALID_CHR_ROW" });
		const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
		const row = S.tablesExist(db) ? S.eventRow(db, Number(raw)) : null;
		if (!row) return notFound(res, "NOT_FOUND");
		if (row.mode !== "live" || !["failed", "gave_up", "outcome_unknown"].includes(row.status)) {
			return res.status(409).json({ error: "Only a failed, given-up or unknown live update can be retried.", code: "NOT_RETRYABLE" });
		}
		if (row.status === "outcome_unknown" && body.confirmUnknown !== true) {
			return res.status(409).json({ error: "C.H. Robinson may already have this update; check Navisphere first, then confirm.", code: "CONFIRM_UNKNOWN" });
		}
		const nowMs = now();
		if (row.kind === "milestone" && Date.parse(row.event_at) < nowMs - RETRY_OLD_MS && body.confirmOld !== true) {
			return res.status(409).json({ error: "This update is more than 24 hours old; confirm to send it anyway.", code: "CONFIRM_OLD" });
		}
		if (!S.retryRow(db, row.id, { nowIso: new Date(nowMs).toISOString(), by: (userOf(req) || {}).username || "" })) {
			return res.status(409).json({ error: "Only a failed, given-up or unknown live update can be retried.", code: "NOT_RETRYABLE" });
		}
		audit(req, "chr_retry", String(row.id), `Row ${row.id} (${row.status}) back to the sender${body.confirmOld === true ? "; old, confirmed" : ""}${body.confirmUnknown === true ? "; unknown outcome, confirmed" : ""}.`);
		onChange();
		res.json({ id: row.id, status: "pending" });
	}));

	// After a pause: pending live updates older than two hours are given up unless
	// the person confirms they still go (CHR's view may already hold them).
	app.post(at("/resume"), requireRole("Super Admin"), write, resumeLimiter, guarded("CHR_WRITE_FAILED", (req, res) => {
		const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
		const state = S.readState(db);
		if (!state.pausedReason) return res.status(409).json({ error: "Sending is not paused.", code: "NOT_PAUSED" });
		const nowMs = now();
		const nowIso = new Date(nowMs).toISOString();
		const old = S.tablesExist(db) ? S.pendingLiveOlderThan(db, new Date(nowMs - RESUME_OLD_MS).toISOString()) : [];
		const gaveUp = body.confirm === true ? 0 : S.giveUpIds(db, old, nowIso);
		S.writeState(db, { ...S.readState(db), pausedReason: "", pausedAt: "", pausedUntil: "", failStreak: 0 }, nowIso);
		audit(req, "chr_resume", "sending", `Resumed after ${state.pausedReason}: ${body.confirm === true ? `${old.length} update(s) older than 2 hours confirmed to go` : `${gaveUp} update(s) older than 2 hours given up`}.`);
		onChange();
		res.json({ resumed: true, gaveUp, confirmed: body.confirm === true ? old.length : 0 });
	}));

	// A token only, no load data; the listed accounts only (A3).
	app.post(at("/test-connection"), requireRole("Super Admin"), write, testLimiter, async (req, res) => {
		try {
			if (!isListed(userOf(req))) return res.status(403).json({ error: "Only an account on the listed-accounts setting may test the connection.", code: "TEST_NOT_PERMITTED" });
			let r;
			try { r = await testConnection(); } catch { r = { resultCode: "NETWORK", httpStatus: null }; }
			const resultCode = r && typeof r.resultCode === "string" ? r.resultCode : "BAD_RESPONSE";
			const httpStatus = r && Number.isInteger(r.httpStatus) ? r.httpStatus : null;
			const nowIso = new Date(now()).toISOString();
			if (resultCode === "SENT") S.writeState(db, { ...S.readState(db), lastTokenOkAt: nowIso }, nowIso);
			audit(req, "chr_test_connection", "connection", `Test connection: ${resultCode}${httpStatus ? ` (${httpStatus})` : ""}.`);
			onChange();
			return res.json({ resultCode, httpStatus });
		} catch {
			log.error("[chr] POST /test-connection failed");
			return res.status(500).json({ error: "The C.H. Robinson page could not do that. Try again.", code: "CHR_WRITE_FAILED" });
		}
	});

	app.use(MOUNT_PATH, requireRole("Super Admin"), (req, res) => notFound(res, "NOT_FOUND"));
}

module.exports = {
	MOUNT_PATH,
	LOAD_ID_RE,
	HOLD_LIMIT,
	RETRY_LIMIT,
	RESUME_LIMIT,
	TEST_LIMIT,
	RETRY_OLD_MS,
	RESUME_OLD_MS,
	LIVE_REFUSED,
	PILOT_REFUSED,
	POD_COUNT_SQL,
	DRAFT_SQL,
	eventView,
	loadView,
	todayStartIso,
	mount,
};
