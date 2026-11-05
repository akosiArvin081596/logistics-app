"use strict";

// ===========================================================================
// Driver Performance: each driver's own week, and the Super Admin's board.
// Display only: nothing here writes, and nothing reaches pay.
//
//   GET /api/driver/me/performance             the signed-in driver's own week
//                                              (Driver only), from the session:
//                                              his count, what's left, the label
//                                              and his loads that counted, this
//                                              week and last
//   GET /api/driver/performance/leaderboard    ?period=week|month, the board
//                                              (Super Admin): units, never names
//                                              or ids. To a Driver it is absent
//                                              unless boardForDrivers is on
//   GET /api/admin/driver-performance          ?period=week|month, the same
//                                              periods with names, reasons and
//                                              each credit's source (Super Admin)
//
// DRIVER_PERFORMANCE_ENABLED is a kill switch, on unless set to false. Off, all
// three answer 404 FEATURE_OFF before any role check. A Driver gets 404
// NOT_ELIGIBLE from his own week unless he is active, not an owner-operator, and
// held a countable truck or has a counted load this week or last.
// The rules live in lib/driver-performance.js; this file gathers the facts.
// ===========================================================================

const rateLimit = require("express-rate-limit");
const { normalizeLoadId } = require("./ratecon-load");
const perf = require("./driver-performance");

const PATHS = Object.freeze({
	own: "/api/driver/me/performance",
	board: "/api/driver/performance/leaderboard",
	admin: "/api/admin/driver-performance",
});
// The Job Tracking read behind every answer is itself cached this long.
const CACHE_TTL_MS = 60_000;
// Requests per 15 minutes per account: opening the tab is a handful.
const RATE_LIMIT = 120;
const HOURS_LABEL = "estimate, not checked";
const PERIOD_KINDS = new Set(["week", "month"]);
// load_status_history sources that are a person's tap, as the admin report names them.
const TAP_SOURCES = Object.freeze({ manual: "driver", override: "dispatch" });
const REQUIRED_DEPS = [
	"requireRole", "getJobTrackingCached", "liveJobTrackingView", "everyJobTrackingRow", "invoiceWeekColumns", "invoiceWeekVerdict",
	"invoiceCompletionDay", "loadKeySet", "getDeletedLoadIds", "normalizeDriverName", "getWeekRange", "appTodayKey", "buildDriverAtResolver",
	"directoryPayStruct",
];

// SQLite's CURRENT_TIMESTAMP text ("YYYY-MM-DD HH:MM:SS") is UTC; 0 when unreadable.
function sqliteUtcMs(text) {
	const v = String(text || "").trim();
	if (!v) return 0;
	const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(v) ? v : `${v.replace(" ", "T")}Z`;
	const ms = Date.parse(iso);
	return Number.isFinite(ms) ? ms : 0;
}

function addToSet(map, key, value) {
	let s = map.get(key);
	if (!s) map.set(key, (s = new Set()));
	s.add(value);
}

function mount(app, deps) {
	const d = deps || {};
	for (const name of REQUIRED_DEPS) {
		if (typeof d[name] !== "function") throw new Error(`driver-performance-routes: deps.${name} is required`);
	}
	if (!d.db || typeof d.db.prepare !== "function") throw new Error("driver-performance-routes: deps.db is required");
	const db = d.db;
	const enabled = d.enabled === true;
	const boardForDrivers = d.boardForDrivers === true;
	const norm = d.normalizeDriverName;
	(d.logger || console).log(`[driver-performance] DRIVER_PERFORMANCE_ENABLED ${enabled ? "on" : "off"}`);

	function driverPerformanceFlagGate(req, res, next) {
		if (!enabled) return res.status(404).json({ error: "Not found", code: "FEATURE_OFF" });
		return next();
	}

	// To a Driver the ranking doesn't exist: the kill switch's own answer, whatever he asks and
	// before any read. The code behind it stays, and the Super Admin's board doesn't change.
	function boardForDriversGate(req, res, next) {
		if (!boardForDrivers && req.session.user.role !== "Super Admin") return res.status(404).json({ error: "Not found", code: "FEATURE_OFF" });
		return next();
	}

	// After the role gate, so a refused caller spends none of it.
	const limiter = rateLimit({
		windowMs: 15 * 60 * 1000,
		max: RATE_LIMIT,
		keyGenerator: (req) => `u:${req.session.user.id}`,
		message: { error: "Too many requests. Try again in a few minutes.", code: "PERFORMANCE_RATE_LIMITED" },
		standardHeaders: true,
	});

	// ── Facts ──────────────────────────────────────────────────────────────────

	// One directory row per driver name (normalizeDriverName), the lowest id when
	// two rows name the same driver, as findDirectoryRowForDriver() picks.
	function directoryByKey() {
		const out = new Map();
		for (const r of db.prepare("SELECT id, driver_name, status, pay_type, user_id FROM drivers_directory ORDER BY id").all()) {
			const key = norm(r.driver_name);
			if (key && !out.has(key)) out.set(key, r);
		}
		return out;
	}

	function ownerOperatorUserIds() {
		return new Set(db.prepare("SELECT user_id FROM owner_operators WHERE status <> 'ended'").all().map((r) => Number(r.user_id)));
	}

	function isOwnerOperator(row, ooUsers, extraUserId) {
		const ids = [Number(row.user_id), Number(extraUserId)].filter((n) => Number.isFinite(n) && n > 0);
		return ids.some((n) => ooUsers.has(n));
	}

	function exclusionOf(row, ooUsers, extraUserId) {
		return perf.boardExclusion({ status: row.status, payType: row.pay_type, ownerOperator: isOwnerOperator(row, ooUsers, extraUserId) });
	}

	// The session's own driver: { key, row, exclusion, personalExclusion }; row null
	// when the account names no directory driver. exclusion is the board's rule.
	function viewerOf(req) {
		const key = norm(req.session.user.driverName);
		if (!key) return { key: "", row: null, exclusion: "not-in-directory", personalExclusion: "not-in-directory" };
		const row = directoryByKey().get(key) || null;
		if (!row) return { key, row: null, exclusion: "not-in-directory", personalExclusion: "not-in-directory" };
		const ooUsers = ownerOperatorUserIds();
		return {
			key,
			row,
			exclusion: exclusionOf(row, ooUsers, req.session.user.id),
			personalExclusion: perf.personalExclusion({ status: row.status, ownerOperator: isOwnerOperator(row, ooUsers, req.session.user.id) }),
		};
	}

	// The truck's own record of each load's departure from the shipper, and the
	// first "In Transit" a person set (load ids as normalizeLoadId() keys them).
	function pickupFacts() {
		const geofence = new Map();
		for (const r of db.prepare(
			`SELECT load_id, MIN(changed_at) AS at FROM load_status_history
			 WHERE source = 'geofence' AND LOWER(TRIM(new_status)) = 'in transit' GROUP BY load_id`,
		).all()) {
			const ms = sqliteUtcMs(r.at);
			if (ms) geofence.set(normalizeLoadId(r.load_id), ms);
		}
		// SQLite gives the bare `source` column from the row MIN() picked.
		const tap = new Map();
		for (const r of db.prepare(
			`SELECT load_id, source, MIN(changed_at) AS at FROM load_status_history
			 WHERE source IN ('manual', 'override') AND LOWER(TRIM(new_status)) = 'in transit' GROUP BY load_id`,
		).all()) {
			const ms = sqliteUtcMs(r.at);
			if (ms) tap.set(normalizeLoadId(r.load_id), { ms, source: TAP_SOURCES[r.source] });
		}
		const eld = new Map();
		for (const r of db.prepare("SELECT load_id, pickup_depart_ms FROM load_eld_miles WHERE pickup_depart_ms > 0").all()) {
			eld.set(normalizeLoadId(r.load_id), Number(r.pickup_depart_ms));
		}
		return { geofence, tap, eld };
	}

	// Map(truck id -> Set of days its ELD sent data), from the miles rollup.
	function eldReportedDays(from, to) {
		const out = new Map();
		for (const r of db.prepare(
			`SELECT truck_id, local_day FROM eld_miles_daily
			 WHERE samples > 0 AND truck_id > 0 AND local_day >= ? AND local_day <= ? GROUP BY truck_id, local_day`,
		).all(from, to)) addToSet(out, Number(r.truck_id), r.local_day);
		return out;
	}

	// ── One period kind's boards, built from one Job Tracking read ─────────────

	function build(kind, periods, jt) {
		const live = d.liveJobTrackingView(jt);
		const everyRow = d.everyJobTrackingRow(jt);
		const cols = d.invoiceWeekColumns(live.headers);
		const deletedKeys = d.loadKeySet(d.getDeletedLoadIds());
		const directory = directoryByKey();
		const ooUsers = ownerOperatorUserIds();
		const trucks = db.prepare("SELECT id, unit_number, COALESCE(retired_at, '') AS retired_at FROM trucks ORDER BY id").all();
		const countable = trucks.filter((t) => !String(t.retired_at).trim() && !perf.isTestUnit(t.unit_number));
		const resolver = d.buildDriverAtResolver(trucks.map((t) => t.id));
		const names = new Map(); // key -> a spelling to show the Super Admin
		// Every name a unit label is checked against, whichever list holds it.
		const allNames = new Set([...directory.values()].map((r) => r.driver_name));

		// Each driver's own counted loads, by period: Map(key -> Map(load key -> entry)).
		// Read per request, one driver's slice at a time, so no row can reach another.
		const own = periods.map(() => new Map());
		const ownEntry = (i, key, loadKey, row) => {
			let byLoad = own[i].get(key);
			if (!byLoad) own[i].set(key, (byLoad = new Map()));
			let entry = byLoad.get(loadKey);
			if (!entry) byLoad.set(loadKey, (entry = { loadKey, loadId: "", pickupDay: "", deliveryDay: "", pickupNote: "" }));
			entry.loadId = cols.loadIdCol ? row[cols.loadIdCol] : "";
			return entry;
		};
		// Who has a load in his name that isn't finished: live rows only, so cancelled ones aren't.
		const openLoads = new Set();
		for (const row of live.data) {
			const raw = cols.driverCol ? String(row[cols.driverCol] || "").trim() : "";
			const key = norm(raw);
			if (!key) continue;
			allNames.add(raw);
			if (d.invoiceWeekVerdict(row, cols, periods[0].start, periods[0].end, deletedKeys) === "open") openLoads.add(key);
		}

		// Delivered loads: the weekly invoice's own verdict over every row, as it reads them and with its
		// last billable row winning, so a week here is the week his invoice bills, whatever copy of the
		// load sits below it; a month is its completion days' month.
		const delivered = periods.map(() => new Map());
		for (const row of everyRow) {
			const raw = cols.driverCol ? String(row[cols.driverCol] || "").trim() : "";
			const key = norm(raw);
			if (!key) continue;
			const loadKey = (cols.loadIdCol && normalizeLoadId(row[cols.loadIdCol])) || `_row_${row._rowIndex}`;
			periods.forEach((p, i) => {
				if (d.invoiceWeekVerdict(row, cols, p.start, p.end, deletedKeys) !== "bill") return;
				addToSet(delivered[i], key, loadKey);
				if (!names.has(key)) names.set(key, raw);
				if (kind === "week") ownEntry(i, key, loadKey, row).deliveryDay = d.invoiceCompletionDay(row, cols);
			});
		}

		// Pickups count toward the week's credits only.
		const pickups = periods.map(() => new Map());
		if (kind === "week") {
			const facts = pickupFacts();
			const lo = periods.reduce((m, p) => (p.start < m ? p.start : m), periods[0].start);
			const hi = periods.reduce((m, p) => (p.end > m ? p.end : m), periods[0].end);
			let reported = null;
			const seen = new Set();
			const pickupOf = new Map(); // load key -> { key, day }, in or out of these periods
			// A load's pickup goes with its bottom live row, as his load list reads it, unless a dated
			// delivered row sits above that: the row his invoice bills, whatever copy sits below it.
			const rowOfLoad = new Map();
			const loadKeyOf = (row) => (cols.loadIdCol ? normalizeLoadId(row[cols.loadIdCol]) : "");
			for (const row of live.data) rowOfLoad.set(loadKeyOf(row), row);
			for (const row of everyRow) {
				if (["bill", "other-week"].includes(d.invoiceWeekVerdict(row, cols, lo, hi, deletedKeys))) rowOfLoad.set(loadKeyOf(row), row);
			}
			for (const row of rowOfLoad.values()) {
				const key = cols.driverCol ? norm(row[cols.driverCol]) : "";
				const loadKey = loadKeyOf(row);
				if (!key || !loadKey || seen.has(loadKey)) continue;
				seen.add(loadKey);
				const tap = facts.tap.get(loadKey) || null;
				let truckHasEld = false;
				if (tap && !facts.geofence.has(loadKey) && !facts.eld.has(loadKey)) {
					const tapDay = perf.businessDayOf(tap.ms);
					if (tapDay < lo || tapDay > hi) continue;
					if (!reported) reported = eldReportedDays(perf.addDays(lo, -perf.ELD_REPORTING_LOOKBACK_DAYS), hi);
					const truck = trucks.find((t) => norm(resolver.atInstant(t.id, tap.ms)) === key) || null;
					truckHasEld = !!truck && perf.eldReportingOn(reported.get(Number(truck.id)), tapDay);
				}
				const ev = perf.pickupEvidence({
					geofenceMs: facts.geofence.get(loadKey),
					eldDepartMs: facts.eld.get(loadKey),
					tapMs: tap && tap.ms,
					tapSource: tap && tap.source,
					truckHasEld,
				});
				if (!ev) continue;
				const day = perf.businessDayOf(ev.ms);
				pickupOf.set(loadKey, { key, day });
				periods.forEach((p, i) => {
					if (day < p.start || day > p.end) return;
					if (!pickups[i].has(key)) pickups[i].set(key, []);
					pickups[i].get(key).push({ loadKey, source: ev.source });
					ownEntry(i, key, loadKey, row).pickupDay = day;
				});
			}

			// A delivery whose pickup didn't count in its own week says what became of it.
			periods.forEach((_p, i) => {
				for (const [key, byLoad] of own[i]) {
					for (const entry of byLoad.values()) {
						if (entry.pickupDay) continue;
						const at = pickupOf.get(entry.loadKey);
						if (!at || at.key !== key) entry.pickupNote = "not-counted";
						else if (i === 0 && at.day >= periods[1].start && at.day <= periods[1].end) entry.pickupNote = "last-week";
						else entry.pickupNote = "another-week";
					}
				}
			});
		}

		const mostLoads = perf.categoryById("most-loads");
		const boards = periods.map((p, i) => {
			// Who held which countable truck on each day of the period, up to today.
			const holdings = new Map(); // key -> Map(truck id -> holding)
			const days = perf.daysBetween(p.start, p.lastDay);
			for (const t of countable) {
				for (const day of days) {
					const raw = resolver.atDay(t.id, day);
					const key = norm(raw);
					if (!key) continue;
					if (!names.has(key)) names.set(key, String(raw).trim());
					allNames.add(raw);
					if (!holdings.has(key)) holdings.set(key, new Map());
					const m = holdings.get(key);
					let h = m.get(t.id);
					if (!h) m.set(t.id, (h = { truckId: t.id, unit: t.unit_number, days: 0, firstDay: day, lastDay: day }));
					h.days += 1;
					h.lastDay = day;
				}
			}

			const keys = new Set([...holdings.keys(), ...delivered[i].keys(), ...pickups[i].keys()]);
			const people = [];
			const chosen = new Map(); // directory id -> holding
			for (const key of keys) {
				const row = directory.get(key) || null;
				const held = holdings.has(key) ? [...holdings.get(key).values()] : [];
				let reason = row ? exclusionOf(row, ooUsers) : "not-in-directory";
				if (!reason && !held.length) reason = "no-truck-in-period";
				if (!reason) chosen.set(row.id, perf.chooseUnit(held));
				people.push({ key, row, held, reason });
			}
			const nameParts = perf.unitNameParts(allNames);
			const labels = perf.boardLabels(chosen, p, nameParts);
			const countOf = (key) => (delivered[i].get(key) || new Set()).size;
			const ranked = perf.rankEntries(mostLoads, people.filter((x) => !x.reason).map((x) => ({
				driverId: x.row.id,
				label: labels.get(x.row.id).label,
				ownLabel: labels.get(x.row.id).ownLabel,
				value: countOf(x.key),
			})));
			const rankOf = new Map(ranked.map((e) => [e.driverId, e.rank]));

			const report = people.map((x) => {
				const own = x.reason ? null : labels.get(x.row.id);
				const picks = pickups[i].get(x.key) || [];
				const bySource = { geofence: 0, eld: 0, driver: 0, dispatch: 0 };
				for (const pk of picks) bySource[pk.source] += 1;
				return {
					directoryId: x.row ? x.row.id : null,
					name: x.row ? x.row.driver_name : names.get(x.key) || x.key,
					listed: !x.reason,
					reason: x.reason,
					unitLabel: own ? own.label : null,
					ownLabel: own ? own.ownLabel : null,
					units: x.held
						.sort((a, b) => (a.firstDay < b.firstDay ? -1 : a.firstDay > b.firstDay ? 1 : a.truckId - b.truckId))
						.map((h) => {
							const label = perf.unitLabel(h.unit, nameParts);
							// The stored text, here only, so the office can correct a refused unit.
							return { unitLabel: label.text, unitNumber: h.unit, labelRefused: label.refused, days: h.days, firstDay: h.firstDay, lastDay: h.lastDay };
						}),
					rank: x.reason ? null : rankOf.get(x.row.id),
					loads: countOf(x.key),
					pickups: kind === "week" ? { total: picks.length, ...bySource } : null,
					credits: kind === "week" ? perf.loadCredits(countOf(x.key), picks.length) : null,
					hoursEstimate: null,
				};
			}).sort((a, b) => (a.listed !== b.listed ? (a.listed ? -1 : 1)
				: a.listed && a.rank !== b.rank ? a.rank - b.rank
				: String(a.name).localeCompare(String(b.name))));

			return { id: p.id, start: p.start, end: p.end, ranked: { "most-loads": ranked }, report, holders: new Set(holdings.keys()) };
		});

		return { periods, delivered, pickups, own, openLoads, boards };
	}

	// Per period kind, while the same Job Tracking read stands and for at most
	// CACHE_TTL_MS. Who "you" is never enters it: rows are projected per request.
	const cache = new Map();
	async function snapshot(kind) {
		const today = d.appTodayKey();
		const periods = perf.boardPeriods(kind, today, d.getWeekRange);
		if (!periods) throw new Error(`no ${kind} periods for ${today}`);
		let jt;
		try {
			jt = await d.getJobTrackingCached();
		} catch (err) {
			const e = new Error("Job Tracking could not be read");
			e.unavailable = true;
			throw e;
		}
		const hit = cache.get(kind);
		const now = Date.now();
		if (hit && hit.jt === jt && hit.today === today && now - hit.at < CACHE_TTL_MS) return hit.value;
		const value = build(kind, periods, jt);
		cache.set(kind, { jt, today, at: now, value });
		return value;
	}

	// ── Answers ────────────────────────────────────────────────────────────────

	const notEligible = (res) => res.status(404).json({ error: "Not found", code: "NOT_ELIGIBLE" });
	// His own counted loads for one period, in the order they counted, as his screen may see them.
	function ownLoads(snap, i, key) {
		const byLoad = snap.own[i].get(key);
		if (!byLoad) return [];
		const firstDay = (e) => [e.pickupDay, e.deliveryDay].filter(Boolean).sort()[0];
		return [...byLoad.values()]
			.sort((a, b) => (firstDay(a) < firstDay(b) ? -1 : firstDay(a) > firstDay(b) ? 1 : a.loadKey.localeCompare(b.loadKey, "en", { numeric: true })))
			.map((e) => perf.countedLoad(e));
	}
	// A driver sees the others only while he is on a board himself. Whether he is
	// comes from the boards, so a driver with no truck gets the same answer as one
	// off the board by rule.
	async function onAnyBoard(driverId) {
		for (const kind of PERIOD_KINDS) {
			const snap = await snapshot(kind);
			if (snap.boards.some((b) => b.ranked["most-loads"].some((e) => e.driverId === driverId))) return true;
		}
		return false;
	}
	function failed(res, err) {
		if (err && err.unavailable) {
			return res.status(503).json({ error: "Performance can't be worked out right now. Try again in a minute.", code: "PERFORMANCE_UNAVAILABLE" });
		}
		console.error("[driver-performance] failed:", (err && err.message) || "ERROR");
		return res.status(500).json({ error: "Performance could not be worked out.", code: "PERFORMANCE_FAILED" });
	}
	function periodKind(req, res) {
		const raw = req.query.period === undefined ? "week" : String(req.query.period);
		if (PERIOD_KINDS.has(raw)) return raw;
		res.status(400).json({ error: "period must be week or month.", code: "BAD_PERIOD" });
		return null;
	}

	app.get(PATHS.own, driverPerformanceFlagGate, d.requireRole("Driver"), limiter, async (req, res) => {
		res.set("Cache-Control", "private, no-store");
		try {
			const viewer = viewerOf(req);
			if (!viewer.row || viewer.personalExclusion) return notEligible(res);
			const snap = await snapshot("week");
			// Held a countable truck, or has a counted load, this week or last.
			if (!snap.boards.some((b, i) => b.holders.has(viewer.key) || snap.own[i].has(viewer.key))) return notEligible(res);
			const today = d.appTodayKey();
			const oldest = snap.periods[snap.periods.length - 1].start;
			const offRows = typeof d.driverAvailabilityByName === "function" ? d.driverAvailabilityByName(oldest).get(viewer.key) || [] : [];
			return res.json({
				view: "no-hours-data",
				creditWeights: { ...perf.CREDIT_WEIGHTS },
				// Which sentence about his invoice is true of him: the money math's own reading.
				invoicePaysDays: d.directoryPayStruct(viewer.row).payType !== "percentage",
				weeks: snap.periods.map((p, i) => perf.personalWeek({
					id: p.id,
					start: p.start,
					end: p.end,
					today,
					deliveries: (snap.delivered[i].get(viewer.key) || new Set()).size,
					pickups: (snap.pickups[i].get(viewer.key) || []).length,
					loads: ownLoads(snap, i, viewer.key),
					offDays: perf.offDaysInWeek(offRows, p.start, p.end),
					openLoad: snap.openLoads.has(viewer.key),
				})),
			});
		} catch (err) {
			return failed(res, err);
		}
	});

	app.get(PATHS.board, driverPerformanceFlagGate, d.requireRole("Super Admin", "Driver"), boardForDriversGate, limiter, async (req, res) => {
		res.set("Cache-Control", "private, no-store");
		try {
			const kind = periodKind(req, res);
			if (!kind) return undefined;
			let viewerId = null;
			if (req.session.user.role !== "Super Admin") {
				const viewer = viewerOf(req);
				if (!viewer.row || viewer.exclusion || !(await onAnyBoard(viewer.row.id))) return notEligible(res);
				viewerId = viewer.row.id;
			}
			const snap = await snapshot(kind);
			return res.json({
				period: kind,
				view: perf.BOARD_VIEW,
				boards: snap.boards.map((b) => ({
					id: b.id,
					start: b.start,
					end: b.end,
					categories: perf.CATEGORIES.map((c) => perf.projectCategory(c, b.ranked[c.id] || [], viewerId)),
				})),
			});
		} catch (err) {
			return failed(res, err);
		}
	});

	app.get(PATHS.admin, driverPerformanceFlagGate, d.requireRole("Super Admin"), limiter, async (req, res) => {
		res.set("Cache-Control", "private, no-store");
		try {
			const kind = periodKind(req, res);
			if (!kind) return undefined;
			const snap = await snapshot(kind);
			return res.json({
				period: kind,
				hoursLabel: HOURS_LABEL,
				boards: snap.boards.map((b) => ({ id: b.id, start: b.start, end: b.end, drivers: b.report })),
			});
		} catch (err) {
			return failed(res, err);
		}
	});

	return { PATHS, clearCache: () => cache.clear() };
}

module.exports = { mount, PATHS, CACHE_TTL_MS, RATE_LIMIT, HOURS_LABEL, sqliteUtcMs };
