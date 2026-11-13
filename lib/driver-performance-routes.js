"use strict";

// ===========================================================================
// Driver Performance: each driver's own week, and the Super Admin's board.
// Display only: nothing here writes, and nothing reaches pay.
//
//   GET /api/driver/me/performance             the signed-in driver's own week
//                                              (Driver only), from the session:
//                                              his count, what's left, the label,
//                                              the bar's color and his loads that
//                                              counted, this week and last; and
//                                              each past week's figure from the
//                                              first counted week
//   GET /api/driver/performance/leaderboard    ?period=week|month, the board
//                                              (Super Admin): units, never names
//                                              or ids. To a Driver it is absent
//                                              unless boardForDrivers is on
//   GET /api/admin/driver-performance          ?period=week|month, the same
//                                              periods with names, reasons and
//                                              each credit's source (Super Admin)
//   GET /api/admin/driver-performance/weeks    each driver's own answer, by name,
//                                              as his own route gives it; and this
//                                              week's off the board (Super Admin)
//
// mount() also returns invoiceWeek(), no route: the weekly invoice's copy of one
// of his weeks, as his own route builds it, for the generate route's
// performance page (server.js), which prints it and pays nothing by it.
//
// DRIVER_PERFORMANCE_ENABLED is a kill switch, on unless set to false. Off, all
// four answer 404 FEATURE_OFF before any role check, and invoiceWeek() null. A
// Driver gets 404 NOT_ELIGIBLE from his own week unless he is active, not an
// owner-operator, and held a countable truck or has a counted load this week or
// last.
// A past week's driving hours come only with DRIVER_PERFORMANCE_HOURS_ENABLED
// on, when server.js hands in the daily ELD activity rollup's reader; without
// it nothing here reads that table, and each past week has no hours at all.
// The rules live in lib/driver-performance.js and a pickup's proof in
// lib/driver-pickup-proof.js; this file gathers the facts.
// ===========================================================================

const rateLimit = require("express-rate-limit");
const { normalizeLoadId } = require("./ratecon-load");
const pickupProof = require("./driver-pickup-proof");
const perf = require("./driver-performance");

const PATHS = Object.freeze({
	own: "/api/driver/me/performance",
	board: "/api/driver/performance/leaderboard",
	admin: "/api/admin/driver-performance",
	adminWeeks: "/api/admin/driver-performance/weeks",
});
// The Job Tracking read behind every answer is itself cached this long.
const CACHE_TTL_MS = 60_000;
// Requests per 15 minutes per account: opening the tab is a handful.
const RATE_LIMIT = 120;
const HOURS_LABEL = "estimate, not checked";
const PERIOD_KINDS = new Set(["week", "month"]);
const REQUIRED_DEPS = [
	"requireRole", "getJobTrackingCached", "liveJobTrackingView", "everyJobTrackingRow", "invoiceWeekColumns", "invoiceWeekVerdict",
	"invoiceCompletionDay", "loadKeySet", "getDeletedLoadIds", "normalizeDriverName", "getWeekRange", "appTodayKey", "buildDriverAtResolver",
	"shownLoadId", "routeShownLoadIdIndex",
];

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
	// (driverId, fromWeek, toWeek) => { firstDay, weeks }, only while the hours switch is on.
	const drivingHours = typeof d.drivingHours === "function" ? d.drivingHours : null;
	const norm = d.normalizeDriverName;
	(d.logger || console).log(`[driver-performance] DRIVER_PERFORMANCE_ENABLED ${enabled ? "on" : "off"}; driving hours ${drivingHours ? "on" : "off"}`);

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

	function isOwnerOperator(row, ooUsers, ...extraUserIds) {
		const ids = [row.user_id, ...extraUserIds].map(Number).filter((n) => Number.isFinite(n) && n > 0);
		return ids.some((n) => ooUsers.has(n));
	}

	// The Driver accounts that name each driver: the owner-operator test reads them, as his own route
	// reads his session's account, since a directory row needn't name one.
	function driverAccountsByKey() {
		const out = new Map();
		for (const r of db.prepare("SELECT id, driver_name FROM users WHERE role = 'Driver'").all()) {
			const key = norm(r.driver_name);
			if (!key) continue;
			if (!out.has(key)) out.set(key, []);
			out.get(key).push(r.id);
		}
		return out;
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

	// Every load's status history and the truck's own record of its departure from the
	// shipper (load ids as normalizeLoadId() keys them).
	function pickupFacts() {
		const byLoad = new Map();
		for (const r of db.prepare(
			"SELECT id, load_id, old_status, new_status, source, actor, actor_role, changed_at FROM load_status_history ORDER BY changed_at, id",
		).all()) {
			const loadKey = normalizeLoadId(r.load_id);
			if (!byLoad.has(loadKey)) byLoad.set(loadKey, []);
			byLoad.get(loadKey).push(r);
		}
		const eld = new Map();
		for (const r of db.prepare("SELECT load_id, truck_id, pickup_depart_ms FROM load_eld_miles WHERE pickup_depart_ms > 0").all()) {
			eld.set(normalizeLoadId(r.load_id), { ms: Number(r.pickup_depart_ms), truckId: Number(r.truck_id) || 0 });
		}
		return { byLoad, eld };
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
		// Weeks, the board's or his own, count pickups and keep his rows; a month counts deliveries only.
		const weekly = kind !== "month";
		const lo = periods.reduce((m, p) => (p.start < m ? p.start : m), periods[0].start);
		const hi = periods.reduce((m, p) => (p.end > m ? p.end : m), periods[0].end);
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
		const ownEntry = (i, key, loadKey) => {
			let byLoad = own[i].get(key);
			if (!byLoad) own[i].set(key, (byLoad = new Map()));
			let entry = byLoad.get(loadKey);
			if (!entry) byLoad.set(loadKey, (entry = { loadKey, loadId: "", pickupDay: "", deliveryDay: "", pickupNote: "" }));
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
		// load sits below it; a month is its completion days' month. One verdict over all the periods,
		// then the one its completion day falls in, is each period's own verdict with one date read a row.
		const delivered = periods.map(() => new Map());
		for (const row of everyRow) {
			const raw = cols.driverCol ? String(row[cols.driverCol] || "").trim() : "";
			const key = norm(raw);
			if (!key) continue;
			if (d.invoiceWeekVerdict(row, cols, lo, hi, deletedKeys) !== "bill") continue;
			const day = d.invoiceCompletionDay(row, cols);
			const loadKey = (cols.loadIdCol && normalizeLoadId(row[cols.loadIdCol])) || `_row_${row._rowIndex}`;
			periods.forEach((p, i) => {
				if (day < p.start || day > p.end) return;
				addToSet(delivered[i], key, loadKey);
				if (!names.has(key)) names.set(key, raw);
				if (weekly) {
					const entry = ownEntry(i, key, loadKey);
					entry.loadId = cols.loadIdCol ? row[cols.loadIdCol] : "";
					entry.deliveryDay = day;
				}
			});
		}

		// Pickups count toward the week's credits only, read off each load's bottom live row, as his load
		// list reads it. A credit goes to whoever lib/driver-pickup-proof.js says made it.
		const pickups = periods.map(() => new Map());
		if (weekly) {
			const facts = pickupFacts();
			let reported = null;
			// A tap older than these periods can't land in them, and its truck's days aren't read back that far.
			const truckHasEldAt = (who, ms) => {
				const day = perf.businessDayOf(ms);
				if (day < lo || day > hi) return true;
				if (!reported) reported = eldReportedDays(perf.addDays(lo, -perf.ELD_REPORTING_LOOKBACK_DAYS), hi);
				const truck = trucks.find((t) => norm(resolver.atInstant(t.id, ms)) === who) || null;
				return !!truck && perf.eldReportingOn(reported.get(Number(truck.id)), day);
			};
			const rowsOfLoad = new Map();
			for (const row of everyRow) {
				const loadKey = cols.loadIdCol ? normalizeLoadId(row[cols.loadIdCol]) : "";
				if (!loadKey) continue;
				if (!rowsOfLoad.has(loadKey)) rowsOfLoad.set(loadKey, []);
				rowsOfLoad.get(loadKey).push(row);
			}
			// A load now another driver's, as any other driver is served its ID. One ID can hold more than one
			// number, so each copy's contact runs over what the read's own index and the last copy left.
			const asServedToAnother = (raw, rows) => {
				const index = d.routeShownLoadIdIndex(jt);
				return rows.reduce((text, row) => d.shownLoadId("Driver", text, { row, index }), d.shownLoadId("Driver", raw, { index }));
			};
			const seen = new Set();
			const pickupOf = new Map(); // load key -> { key, day }, in or out of these periods
			for (const row of live.data) {
				const key = cols.driverCol ? norm(row[cols.driverCol]) : "";
				const loadKey = cols.loadIdCol ? normalizeLoadId(row[cols.loadIdCol]) : "";
				if (!key || !loadKey || seen.has(loadKey)) continue;
				seen.add(loadKey);
				const copies = rowsOfLoad.get(loadKey) || [row];
				const pick = pickupProof.qualifiedPickup({
					events: facts.byLoad.get(loadKey) || [],
					eldDepart: facts.eld.get(loadKey) || null,
					driverNow: key,
					waitingOnSheet: !!cols.statusCol && pickupProof.statusesStillWaiting(copies.map((copy) => copy[cols.statusCol])),
					normalizeName: norm,
					isDriverName: (name) => directory.has(name),
					truckHasEldAt,
					heldTruck: (who, truckId, ms) => norm(resolver.atInstant(truckId, ms)) === who,
				});
				if (!pick) continue;
				const day = perf.businessDayOf(pick.ms);
				pickupOf.set(loadKey, { key: pick.driverKey, day });
				periods.forEach((p, i) => {
					if (day < p.start || day > p.end) return;
					if (!pickups[i].has(pick.driverKey)) pickups[i].set(pick.driverKey, []);
					pickups[i].get(pick.driverKey).push({ loadKey, source: pick.source });
					const entry = ownEntry(i, pick.driverKey, loadKey);
					// A delivery already named it, as the row his invoice bills spells it.
					if (!entry.loadId) entry.loadId = pick.driverKey === key ? row[cols.loadIdCol] : asServedToAnother(row[cols.loadIdCol], copies);
					entry.pickupDay = day;
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
					pickups: weekly ? { total: picks.length, ...bySource } : null,
					credits: weekly ? perf.loadCredits(countOf(x.key), picks.length) : null,
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
	// "own" is a driver's own weeks, the board's two and each past one back to
	// the first counted week; it is never a period anyone can ask the board for.
	const cache = new Map();
	async function snapshot(kind) {
		const today = d.appTodayKey();
		const periods = kind === "own" ? perf.ownPeriods(today, d.getWeekRange) : perf.boardPeriods(kind, today, d.getWeekRange);
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

	// His own weeks from the rollup, or null when it can't be read: those weeks then say their hours
	// are coming soon, and the rest of his answer stands.
	function readDrivingHours(directoryId, fromWeek, toWeek) {
		try {
			return drivingHours(directoryId, fromWeek, toWeek);
		} catch (err) {
			console.error("[driver-performance] driving hours read failed:", (err && err.message) || "ERROR");
			return null;
		}
	}

	// He held a countable truck in week i of his own snapshot, or has a counted load in it.
	const hadWeek = (snap, key, i) => snap.boards[i].holders.has(key) || snap.own[i].has(key);
	// Who has a week of his own: this week or last.
	const hasOwnWeek = (snap, key) => hadWeek(snap, key, 0) || hadWeek(snap, key, 1);

	// Approved days off from the snapshot's oldest week on, by driver; none while their flag is off.
	function offRowsByKey(snap) {
		const oldest = snap.periods[snap.periods.length - 1].start;
		return typeof d.driverAvailabilityByName === "function" ? d.driverAvailabilityByName(oldest) : new Map();
	}

	// His figures for week i of his own snapshot. offRows: driverAvailabilityByName()'s rows for him.
	function ownCounts(snap, key, i, offRows) {
		return {
			deliveries: (snap.delivered[i].get(key) || new Set()).size,
			pickups: (snap.pickups[i].get(key) || []).length,
			offDays: perf.offDaysInWeek(offRows, snap.periods[i].start, snap.periods[i].end),
		};
	}

	// Week i of his own snapshot as his own route shows this week and last: his figures, his counted
	// loads and whether a load in his name is open, as of today.
	function ownWeek(snap, key, i, offRows, today) {
		const p = snap.periods[i];
		return perf.personalWeek({
			id: p.id,
			start: p.start,
			end: p.end,
			today,
			...ownCounts(snap, key, i, offRows),
			loads: ownLoads(snap, i, key),
			openLoad: snap.openLoads.has(key),
		});
	}

	// His own route's answer, from his own figures alone. The Super Admin's page shows each driver
	// this same answer, built here from the same snapshot, so the office and the driver can't disagree.
	// offRows: driverAvailabilityByName()'s rows for him.
	function ownAnswer(snap, key, directoryId, offRows) {
		const today = d.appTodayKey();
		// Each closed week from the first counted week that was his, newest first: a week before he
		// had a truck or a load reads as nothing at all, never as a week that earned nothing.
		const pastWeeks = [];
		snap.periods.forEach((p, i) => {
			if (i > 0 && p.start >= perf.FIRST_COUNTED_WEEK && hadWeek(snap, key, i)) pastWeeks.push(perf.pastWeek({ start: p.start, end: p.end, ...ownCounts(snap, key, i, offRows) }));
		});
		if (drivingHours && pastWeeks.length) {
			const read = readDrivingHours(directoryId, pastWeeks[pastWeeks.length - 1].start, pastWeeks[0].start);
			for (const w of pastWeeks) w.hours = perf.weekDrivingHours(read, w.start);
		}
		return {
			view: "no-hours-data",
			creditWeights: { ...perf.CREDIT_WEIGHTS },
			weeks: snap.periods.slice(0, 2).map((_p, i) => ownWeek(snap, key, i, offRows, today)),
			pastWeeks,
			countedFrom: perf.countedFrom(),
		};
	}

	// The weekly invoice's copy of his week (server.js, the generate route's performance page): the week
	// that starts on weekStart as his own route builds it, from the same snapshot, for the invoice's driver
	// by name, the owner-operator test reading every Driver account under that name and userId, the one
	// the invoice found. null when the kill switch is off, his own route would refuse him, or the week
	// isn't one of his: this week, last week or a past week his list shows, never one before the first
	// counted week. hours: the week's driving hours with their switch on, else null. Throws when Job
	// Tracking can't be read, where his own route answers 503.
	async function invoiceWeek({ driverName, userId, weekStart } = {}) {
		if (!enabled) return null;
		const key = typeof driverName === "string" ? norm(driverName) : "";
		const row = key ? directoryByKey().get(key) || null : null;
		if (!row) return null;
		const ownerOperator = isOwnerOperator(row, ownerOperatorUserIds(), ...(driverAccountsByKey().get(key) || []), userId);
		if (perf.personalExclusion({ status: row.status, ownerOperator })) return null;
		const snap = await snapshot("own");
		const i = snap.periods.findIndex((p) => p.start === weekStart);
		if (i < 0 || weekStart < perf.FIRST_COUNTED_WEEK || !hasOwnWeek(snap, key) || (i > 1 && !hadWeek(snap, key, i))) return null;
		return {
			week: ownWeek(snap, key, i, offRowsByKey(snap).get(key) || [], d.appTodayKey()),
			weights: { ...perf.CREDIT_WEIGHTS },
			hours: drivingHours ? perf.weekDrivingHours(readDrivingHours(row.id, weekStart, weekStart), weekStart) : null,
		};
	}

	// The unit a driver's row on the Super Admin's page shows: this week's board label, with a
	// handover's dates; for a driver off the board, each countable unit he held this week; or "".
	function unitOf(reported) {
		if (!reported) return "";
		if (reported.ownLabel) return reported.ownLabel;
		return [...new Set(reported.units.map((u) => u.unitLabel))].join(", ");
	}

	app.get(PATHS.own, driverPerformanceFlagGate, d.requireRole("Driver"), limiter, async (req, res) => {
		res.set("Cache-Control", "private, no-store");
		try {
			const viewer = viewerOf(req);
			if (!viewer.row || viewer.personalExclusion) return notEligible(res);
			const snap = await snapshot("own");
			if (!hasOwnWeek(snap, viewer.key)) return notEligible(res);
			return res.json(ownAnswer(snap, viewer.key, viewer.row.id, offRowsByKey(snap).get(viewer.key) || []));
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

	// Every driver his own route's test lets in, each with the very answer it gives him, so the office
	// and the driver can't disagree; then this week's drivers off the board. Of the board's report only a
	// unit's label, a name and a reason reach the answer, and of a directory row only its id and name.
	app.get(PATHS.adminWeeks, driverPerformanceFlagGate, d.requireRole("Super Admin"), limiter, async (req, res) => {
		res.set("Cache-Control", "private, no-store");
		try {
			const snap = await snapshot("own");
			// The board by unit's own week, so this page and the board never disagree on who is on it.
			const board = (await snapshot("week")).boards[0];
			const reported = new Map(board.report.filter((r) => r.directoryId !== null).map((r) => [r.directoryId, r]));
			const offRows = offRowsByKey(snap);
			const ooUsers = ownerOperatorUserIds();
			const accounts = driverAccountsByKey();
			const drivers = [];
			for (const [key, row] of directoryByKey()) {
				const ownerOperator = isOwnerOperator(row, ooUsers, ...(accounts.get(key) || []));
				if (perf.personalExclusion({ status: row.status, ownerOperator }) || !hasOwnWeek(snap, key)) continue;
				drivers.push({ directoryId: row.id, name: row.driver_name, unit: unitOf(reported.get(row.id)), performance: ownAnswer(snap, key, row.id, offRows.get(key) || []) });
			}
			const credits = (x) => x.performance.weeks[0].credits.value;
			drivers.sort((a, b) => credits(b) - credits(a) || String(a.name).localeCompare(String(b.name)) || a.directoryId - b.directoryId);
			return res.json({
				drivers,
				notOnBoard: board.report.filter((r) => !r.listed).map((r) => ({ name: r.name, reason: r.reason })),
			});
		} catch (err) {
			return failed(res, err);
		}
	});

	return { PATHS, clearCache: () => cache.clear(), invoiceWeek };
}

module.exports = { mount, PATHS, CACHE_TTL_MS, RATE_LIMIT, HOURS_LABEL };
