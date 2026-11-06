"use strict";

// ===========================================================================
// New-feature notices for drivers: what a Driver hasn't read yet, and the small
// table that remembers what they have. The list itself is lib/driver-releases.js;
// when the app shows these answers is client/src/lib/driverReleaseNotices.js. This
// reads and marks. It signs nobody out.
//
//   GET  /api/driver/me/release            { notes, tourOffered }, from their own
//                                          session and rows
//   POST /api/driver/me/release/seen       { ids: [...] } they answered those notes
//   POST /api/driver/me/release/tour-done  { ids: [...] } they finished that tour
//
// DRIVER_RELEASE_NOTICES_ENABLED is a kill switch, on unless set to false. Off,
// all three answer 404 FEATURE_OFF before any role check, nothing is written and
// the driver app stays as it was. Driver only: every other role gets 403.
//
// A sign-in records the latest release id in the session (req.session.driverRelease,
// beside `user`, so GET /api/auth/session doesn't change). Only a sign-in moves it,
// so a session from before an entry reads nothing new: "What's new" waits for the
// next sign-in. Credentials and rights don't come into it. No pay, invoice or broker
// code reads the table: it holds an account id, an id from the list and two times.
// ===========================================================================

const rateLimit = require("express-rate-limit");
const releases = require("./driver-releases");

const PATHS = Object.freeze({
	state: "/api/driver/me/release",
	seen: "/api/driver/me/release/seen",
	tourDone: "/api/driver/me/release/tour-done",
});
// Requests per 15 minutes per account: each app open and each return to the list asks once.
const RATE_LIMIT = 120;

const TABLE_SQL = `CREATE TABLE IF NOT EXISTS driver_release_seen (
	user_id INTEGER NOT NULL,
	release_id TEXT NOT NULL,
	seen_at TEXT,
	tour_done_at TEXT,
	PRIMARY KEY (user_id, release_id)
)`;

function mount(app, deps) {
	const d = deps || {};
	if (typeof d.requireRole !== "function") throw new Error("driver-release-routes: deps.requireRole is required");
	if (!d.db || typeof d.db.prepare !== "function") throw new Error("driver-release-routes: deps.db is required");
	const db = d.db;
	const enabled = d.enabled === true;
	const list = d.releases || releases.RELEASES;
	const logger = d.logger || console;
	const nowIso = () => new Date(d.now ? d.now() : Date.now()).toISOString();
	logger.log(`[driver-releases] DRIVER_RELEASE_NOTICES_ENABLED ${enabled ? "on" : "off"}; current release ${releases.latestReleaseId(list) || "none"}`);

	// A failure here leaves every answer with no notes and no tour offer: never a refused sign-in.
	try {
		db.exec(TABLE_SQL);
	} catch (err) {
		logger.error("driver_release_seen table setup failed:", err.message);
	}

	function flagGate(req, res, next) {
		if (!enabled) return res.status(404).json({ error: "Not found", code: "FEATURE_OFF" });
		return next();
	}

	// After the role gate, so a refused caller spends none of it.
	const limiter = rateLimit({
		windowMs: 15 * 60 * 1000,
		max: RATE_LIMIT,
		keyGenerator: (req) => `u:${req.session.user.id}`,
		message: { error: "Too many requests. Try again in a few minutes.", code: "RELEASE_RATE_LIMITED" },
		standardHeaders: true,
	});

	const seenRows = (userId) => db.prepare("SELECT release_id, seen_at FROM driver_release_seen WHERE user_id = ?").all(userId);

	const markSeen = (userId, ids, at) => {
		const write = db.prepare(`INSERT INTO driver_release_seen (user_id, release_id, seen_at) VALUES (?, ?, ?)
			ON CONFLICT(user_id, release_id) DO UPDATE SET seen_at = COALESCE(seen_at, excluded.seen_at)`);
		db.transaction(() => { for (const id of ids) write.run(userId, id, at); })();
	};
	const markTourDone = (userId, ids, at) => {
		const write = db.prepare(`INSERT INTO driver_release_seen (user_id, release_id, seen_at, tour_done_at) VALUES (?, ?, ?, ?)
			ON CONFLICT(user_id, release_id) DO UPDATE SET seen_at = COALESCE(seen_at, excluded.seen_at), tour_done_at = COALESCE(tour_done_at, excluded.tour_done_at)`);
		db.transaction(() => { for (const id of ids) write.run(userId, id, at, at); })();
	};

	// A first-time driver has no history: everything already listed counts as seen, and he is
	// offered the tour once. His offer waits in its row (seen_at empty) until he answers it, so
	// a first sign-in that lands on the lock screen or in a moving truck doesn't lose it.
	function markFirstSignIn(userId) {
		const at = nowIso();
		const seen = db.prepare("INSERT OR IGNORE INTO driver_release_seen (user_id, release_id, seen_at) VALUES (?, ?, ?)");
		db.transaction(() => {
			for (const r of list) seen.run(userId, r.id, at);
			seen.run(userId, releases.APP_TOUR_ROW, null);
		})();
	}

	// What a sign-in starts with, called through lib/sign-in.js by POST /api/auth/login before it
	// saves the session, with the account row as it stood before this sign-in's stamp. The session's
	// id goes first and reads nothing: a table that can't be written throws to the sign-in's own
	// catch, and costs a first-time driver his offer at most.
	function startSession(session, account) {
		if (!session || !account || account.role !== "Driver") return;
		const latest = releases.latestReleaseId(list);
		if (latest) session.driverRelease = latest;
		if (enabled && String(account.last_login_at ?? "") === "") markFirstSignIn(account.id);
	}

	// A new answer every time: a kept copy could show a note already answered.
	app.get(PATHS.state, flagGate, d.requireRole("Driver"), limiter, (req, res) => {
		res.set("Cache-Control", "private, no-store");
		const answer = { notes: [], tourOffered: false };
		if (releases.sessionIsBehind(req.session.driverRelease, list)) return res.json(answer);
		try {
			const rows = seenRows(req.session.user.id);
			const seen = rows.filter((r) => r.seen_at !== null).map((r) => r.release_id);
			answer.notes = releases.unseenReleases(seen, list);
			answer.tourOffered = rows.some((r) => r.release_id === releases.APP_TOUR_ROW && r.seen_at === null);
		} catch (err) {
			logger.error("driver_release_seen read failed:", err.message);
		}
		return res.json(answer);
	});

	// His own session's id, never one from the request, and only ids the list knows. A repeat
	// changes nothing: the first time stands. No answer here holds anything up on his phone.
	const markRoute = (mark, label) => (req, res) => {
		const ids = req.body && req.body.ids;
		const usable = Array.isArray(ids) && ids.length > 0 && ids.length <= list.length + 1 && ids.every((id) => releases.isMarkableId(id, list));
		if (!usable) return res.status(400).json({ error: "Unknown release.", code: "INVALID_RELEASE" });
		try {
			mark(req.session.user.id, ids, nowIso());
		} catch (err) {
			logger.error(`driver_release_seen ${label} failed:`, err.message);
			return res.status(503).json({ error: "That couldn't be saved. Try again later.", code: "RELEASE_UNAVAILABLE" });
		}
		return res.json({ success: true });
	};
	app.post(PATHS.seen, flagGate, d.requireRole("Driver"), limiter, markRoute(markSeen, "seen"));
	app.post(PATHS.tourDone, flagGate, d.requireRole("Driver"), limiter, markRoute(markTourDone, "tour-done"));

	return { startSession, PATHS };
}

module.exports = { mount, PATHS, RATE_LIMIT, TABLE_SQL };
