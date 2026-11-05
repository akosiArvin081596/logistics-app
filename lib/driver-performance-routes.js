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
// The rules live in lib/driver-performance.js and a pickup's proof in
// lib/driver-pickup-proof.js; this file gathers the facts.
// ===========================================================================

const rateLimit = require("express-rate-limit");
const { normalizeLoadId } = require("./ratecon-load");
const fuelPickupArrival = require("./fuel-pickup-arrival");
const pickupProof = require("./driver-pickup-proof");
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
const DAY_MS = 24 * 60 * 60 * 1000;
// Two arrivals further apart than this aren't one visit, and the truck's track isn't read for them.
const VISIT_MAX_MS = DAY_MS;
// With no track to bound a visit, two arrivals are one only this close: the geofence writes one row
// a ping, so twins land minutes apart, and any wider isn't certain.
const NO_TRACK_VISIT_MS = 15 * 60 * 1000;
const FIXES_SQL = `SELECT location_date_ms AS ms, latitude, longitude, speed FROM routemate_telemetry
	WHERE routemate_vehicle_id = ? AND location_date_ms >= ? AND location_date_ms <= ?
	  AND dropped_reason = '' AND latitude IS NOT NULL AND longitude IS NOT NULL
	ORDER BY location_date_ms ASC, id ASC`;
const REQUIRED_DEPS = [
	"requireRole", "getJobTrackingCached", "liveJobTrackingView", "everyJobTrackingRow", "invoiceWeekColumns", "invoiceWeekVerdict",
	"invoiceCompletionDay", "loadKeySet", "getDeletedLoadIds", "normalizeDriverName", "getWeekRange", "appTodayKey", "buildDriverAtResolver",
	"buildEldDeviceResolver", "directoryPayStruct", "shownLoadId", "routeShownLoadIdIndex",
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

	// Every load's status history and the truck's own record of its departure from the
	// shipper (load ids as normalizeLoadId() keys them).
	function pickupFacts() {
		const byLoad = new Map();
		for (const r of db.prepare(
			`SELECT id, load_id, old_status, new_status, source, actor, actor_role, fix_ms, pickup_zone, local_tz, other_load_hauling, changed_at
			 FROM load_status_history ORDER BY changed_at, id`,
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

	// Map(load key -> { key, ms, source, loadId }): each load with a pickup credit that these periods can
	// show, for the driver the record gives it to. billed: the loads delivered in them.
	function provenPickups({ periods, jt, cols, everyRow, liveRows, deletedKeys, directory, trucks, resolver, billed }) {
		const lo = periods.reduce((m, p) => (p.start < m ? p.start : m), periods[0].start);
		const hi = periods.reduce((m, p) => (p.end > m ? p.end : m), periods[0].end);
		const facts = pickupFacts();
		const liveKeys = new Set(liveRows.map((row) => (cols.loadIdCol ? normalizeLoadId(row[cols.loadIdCol]) : "")));
		const statusCell = (row) => (cols.statusCol ? row[cols.statusCol] : "");
		const driverOf = (row) => (cols.driverCol ? norm(row[cols.driverCol]) : "");

		// Each load's rows on the sheet: every row, as the invoice reads them.
		const sheet = new Map();
		const driverNames = new Set(directory.keys());
		for (const r of db.prepare("SELECT DISTINCT driver_name FROM truck_assignments").all()) driverNames.add(norm(r.driver_name));
		for (const row of everyRow) {
			const who = driverOf(row);
			if (who) driverNames.add(who);
			const loadKey = cols.loadIdCol ? normalizeLoadId(row[cols.loadIdCol]) : "";
			if (!loadKey) continue;
			let load = sheet.get(loadKey);
			if (!load) sheet.set(loadKey, (load = { rows: [], named: new Set(), completed: null }));
			load.rows.push(row);
			if (who) load.named.add(who);
			if (["bill", "other-week", "undated"].includes(d.invoiceWeekVerdict(row, cols, lo, hi, deletedKeys))) load.completed = row;
		}
		// A completed row keeps a load live whatever copy sits below it, as the invoice bills it.
		const isLive = (loadKey, load) => liveKeys.has(loadKey) || !!load.completed;

		// The ID as stored only where his own list or his own invoice serves it. Anywhere else, a stale copy
		// naming him included, as any other driver is served it, asking every copy for its own contact.
		const loadIdFor = (who, loadKey, load) => {
			const bottom = load.rows[load.rows.length - 1];
			if (liveKeys.has(loadKey) && driverOf(bottom) === who) return bottom[cols.loadIdCol];
			if (load.completed && driverOf(load.completed) === who) return load.completed[cols.loadIdCol];
			const raw = bottom[cols.loadIdCol];
			const index = d.routeShownLoadIdIndex(jt);
			for (const row of load.rows) {
				const shown = d.shownLoadId("Driver", raw, { row, index });
				if (shown !== raw) return shown;
			}
			return raw;
		};

		const truckAt = (key, ms) => trucks.find((t) => norm(resolver.atInstant(t.id, ms)) === key) || null;
		let reported = null;
		const truckHasEldAt = (who, ms) => {
			// A tap older than these periods can't land in them, and its truck's days aren't read back that far.
			const day = perf.businessDayOf(ms);
			if (day < lo || day > hi) return true;
			if (!reported) reported = eldReportedDays(perf.addDays(lo, -perf.ELD_REPORTING_LOOKBACK_DAYS), hi);
			const truck = truckAt(who, ms);
			return !!truck && perf.eldReportingOn(reported.get(Number(truck.id)), day);
		};
		let devices = null;
		const trackBetween = (who, fromMs, toMs) => {
			const truck = truckAt(who, fromMs);
			if (!truck) return [];
			if (!devices) devices = d.buildEldDeviceResolver();
			const vid = devices.vehicleForTruckAt(truck.id, fromMs);
			return vid ? db.prepare(FIXES_SQL).all(vid, fromMs, toMs) : [];
		};

		// A coarse window, so only a load with a departure around these periods, or delivered in them, is
		// judged: a day either side covers any business day's edge.
		const fromMs = Date.parse(`${lo}T00:00:00Z`) - DAY_MS;
		const toMs = Date.parse(`${hi}T00:00:00Z`) + 2 * DAY_MS;
		const around = (ms) => ms >= fromMs && ms <= toMs;

		const credited = new Map();
		for (const [loadKey, load] of sheet) {
			if (!isLive(loadKey, load)) continue;
			const events = facts.byLoad.get(loadKey) || [];
			const eldDepart = facts.eld.get(loadKey) || null;
			const near = (eldDepart && around(eldDepart.ms)) || events.some((r) => /^\s*in transit\s*$/i.test(r.new_status) && around(sqliteUtcMs(r.changed_at)));
			if (!near && !billed.has(loadKey)) continue;

			const pick = pickupProof.qualifiedPickup({
				events,
				eldDepart,
				// The invoice's row says whose load it is, else the bottom row, as his load list reads it.
				driverNow: (load.completed && driverOf(load.completed)) || driverOf(load.rows[load.rows.length - 1]),
				waitingOnSheet: !!cols.statusCol && pickupProof.statusesStillWaiting(load.rows.map(statusCell)),
				normalizeName: norm,
				isDriverName: (key) => driverNames.has(key),
				onSheet: (key) => load.named.has(key),
				holderOf: (truckId, ms) => norm(resolver.atInstant(truckId, ms)),
				truckHasEldAt,
			});
			if (!pick || !pick.source) continue;
			credited.set(loadKey, {
				loadKey,
				key: pick.driverKey,
				ms: pick.ms,
				source: pick.source,
				arrival: pick.arrival,
				truckId: eldDepart ? eldDepart.truckId : 0,
				loadId: loadIdFor(pick.driverKey, loadKey, load),
				rawId: cols.loadIdCol ? load.rows[load.rows.length - 1][cols.loadIdCol] : "",
			});
		}

		// Are two of his credits one visit? The truck's own arrivals, on his own live loads, in a stretch
		// its track says it stayed at the shipper. Only the fixes between the two can say it left, so
		// only those are read: arrivals a day apart are normal, and this runs synchronously.
		const sameVisit = (who, x, y) => {
			if (!x.arrival || !y.arrival) return false;
			const ms = sqliteUtcMs(x.arrival.changed_at);
			const other = sqliteUtcMs(y.arrival.changed_at);
			const apart = Math.abs(ms - other);
			if (apart > VISIT_MAX_MS) return false;
			const c = db.prepare("SELECT origin_lat, origin_lng, dest_lat, dest_lng FROM load_coordinates WHERE load_id IN (?, ?) LIMIT 1").get(String(x.rawId).trim(), x.loadKey) || {};
			const pickup = { latitude: c.origin_lat, longitude: c.origin_lng };
			const radiusM = fuelPickupArrival.visitRadiusM(pickup, { latitude: c.dest_lat, longitude: c.dest_lng });
			const fixes = radiusM ? trackBetween(who, Math.min(ms, other), Math.max(ms, other)) : [];
			if (!fixes.length) return apart <= NO_TRACK_VISIT_MS;
			return fuelPickupArrival.twinAtShipper({ history: [y.arrival], loadId: x.loadKey, driver: who, sheetLoadIds: [y.loadKey], normalizeName: norm, fixes, pickup, radiusM })(ms);
		};
		const oneDeparture = (x, y) => x.source === "eld" && y.source === "eld" && x.ms === y.ms && x.truckId === y.truckId;

		// Twins: two credits for what the record says was one departure, and it can't say which load
		// was aboard, so neither stands. A load earning nothing, or another driver's, is no twin of his.
		const byDriver = new Map();
		for (const c of credited.values()) {
			if (!byDriver.has(c.key)) byDriver.set(c.key, []);
			byDriver.get(c.key).push(c);
		}
		const twins = new Set();
		for (const [who, his] of byDriver) {
			his.forEach((x, i) => his.slice(i + 1).forEach((y) => {
				if (!oneDeparture(x, y) && !sameVisit(who, x, y)) return;
				twins.add(x.loadKey);
				twins.add(y.loadKey);
			}));
		}
		for (const loadKey of twins) credited.delete(loadKey);
		return credited;
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
			const key = cols.driverCol ? norm(row[cols.driverCol]) : "";
			if (key && d.invoiceWeekVerdict(row, cols, periods[0].start, periods[0].end, deletedKeys) === "open") openLoads.add(key);
		}

		// Delivered loads: the weekly invoice's own verdict over every row, as it reads them and with its
		// last billable row winning, so a week here is the week his invoice bills, whatever copy of the
		// load sits below it; a month is its completion days' month.
		const delivered = periods.map(() => new Map());
		for (const row of everyRow) {
			const raw = cols.driverCol ? String(row[cols.driverCol] || "").trim() : "";
			const key = norm(raw);
			if (!key) continue;
			allNames.add(raw);
			const loadKey = (cols.loadIdCol && normalizeLoadId(row[cols.loadIdCol])) || `_row_${row._rowIndex}`;
			periods.forEach((p, i) => {
				if (d.invoiceWeekVerdict(row, cols, p.start, p.end, deletedKeys) !== "bill") return;
				addToSet(delivered[i], key, loadKey);
				if (!names.has(key)) names.set(key, raw);
				if (kind === "week") {
					const entry = ownEntry(i, key, loadKey);
					entry.loadId = cols.loadIdCol ? row[cols.loadIdCol] : "";
					entry.deliveryDay = d.invoiceCompletionDay(row, cols);
				}
			});
		}

		// Pickups count toward the week's credits only, for whoever made them.
		const pickups = periods.map(() => new Map());
		if (kind === "week") {
			const billed = new Set();
			for (const byDriver of own) for (const byLoad of byDriver.values()) for (const loadKey of byLoad.keys()) billed.add(loadKey);
			const proven = provenPickups({ periods, jt, cols, everyRow, liveRows: live.data, deletedKeys, directory, trucks, resolver, billed });
			const pickupOf = new Map(); // load key -> { key, day }, in or out of these periods
			for (const [loadKey, pick] of proven) {
				const day = perf.businessDayOf(pick.ms);
				pickupOf.set(loadKey, { key: pick.key, day });
				periods.forEach((p, i) => {
					if (day < p.start || day > p.end) return;
					if (!pickups[i].has(pick.key)) pickups[i].set(pick.key, []);
					pickups[i].get(pick.key).push({ loadKey, source: pick.source });
					const entry = ownEntry(i, pick.key, loadKey);
					if (!entry.loadId) entry.loadId = pick.loadId;
					entry.pickupDay = day;
				});
			}

			// A delivery whose pickup didn't count for him in its own week says what became of it.
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
