"use strict";

// ===========================================================================
// Driver Performance, Phase B4: locked week rows, streaks, freezes, excuses and
// the quarterly flag. REPORT ONLY: no invoice, ledger, payout or investor path
// reads these tables, and nothing here writes outside them and the audit trail
// (scripts/test-performance-weeks.js pins both).
//
//   GET  /api/admin/driver-performance/weeks                              ?week=
//        the weekly report (Super Admin)
//   POST /api/admin/driver-performance/weeks/:directoryId/:weekStart/decision
//        excused, frozen or missed, with a reason (Super Admin)
//   POST /api/admin/driver-performance/weeks/:directoryId/:weekStart/hos-decline
//        declines an automatic excuse within its 7 days (Super Admin)
//   POST /api/admin/driver-performance/weeks/:directoryId/:weekStart/pickup-credit
//        credits a pickup the truck's record can't prove (Super Admin)
//   POST /api/driver-performance/weeks/:directoryId/:weekStart/proposal
//        proposes a decision; it changes nothing (Dispatcher, Super Admin)
//   POST /api/driver/me/performance/hos-stop
//        the driver marks an hours-of-service stop this week (Driver)
//
// DRIVER_PERFORMANCE_WEEKS_ENABLED is on only when exactly "true". Off there is no
// table and no timer, and every route falls through as if it weren't there.
// The rules live in lib/driver-performance-weeks.js; this file gathers the facts.
// ===========================================================================

const rateLimit = require("express-rate-limit");
const { normalizeLoadId } = require("./ratecon-load");
const arrivalPickup = require("./arrival-pickup");
const fuelPickupArrival = require("./fuel-pickup-arrival");
const eldActivity = require("./eld-activity-daily");
const perf = require("./driver-performance");
const rules = require("./driver-performance-weeks");

const WEEK_PATH = "/api/admin/driver-performance/weeks/:directoryId/:weekStart";
const PATHS = Object.freeze({
	report: "/api/admin/driver-performance/weeks",
	decision: `${WEEK_PATH}/decision`,
	hosDecline: `${WEEK_PATH}/hos-decline`,
	pickupCredit: `${WEEK_PATH}/pickup-credit`,
	proposal: "/api/driver-performance/weeks/:directoryId/:weekStart/proposal",
	hosStop: "/api/driver/me/performance/hos-stop",
});
const HOURS_LABEL = "estimate, not checked";
const SWITCH_ON_KEY = "performance_weeks_switch_on";
const ROLLUP_LAST_RUN_KEY = eldActivity.ELD_ACTIVITY_LAST_RUN_KEY;
const RATE_LIMIT = 120;
const REASON_MIN = 3;
const REASON_MAX = 500;
const DAY_MS = 24 * 60 * 60 * 1000;
const VISIT_LOOKBACK_MS = DAY_MS;
const WITHHELD_REASONS = Object.freeze(["undone", "reassigned", "errand", "twin", "no-truck-record"]);
const REQUIRED_DEPS = [
	"requireRole", "logAudit", "getJobTrackingCached", "liveJobTrackingView", "invoiceWeekColumns", "invoiceWeekVerdict",
	"invoiceCompletionDay", "loadKeySet", "getDeletedLoadIds", "normalizeDriverName", "getWeekRange", "appTodayKey",
	"buildDriverAtResolver", "buildEldDeviceResolver", "driverAvailabilityByName", "agreedRateOn", "now",
];

// A locked row and a recorded decision never change: the triggers hold that against any
// later code path, so a correction can only ever appear beside a row, never inside it.
const immutable = (table) => [
	`CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, '${table} rows never change'); END`,
	`CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT, '${table} rows are never deleted'); END`,
];
const SCHEMA_SQL = Object.freeze([
	`CREATE TABLE IF NOT EXISTS performance_week_runs (
		week_start TEXT PRIMARY KEY,
		locked_at TEXT NOT NULL,
		rows_written INTEGER NOT NULL
	)`,
	...immutable("performance_week_runs"),
	`CREATE TABLE IF NOT EXISTS performance_weeks (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		directory_id INTEGER NOT NULL,
		week_start TEXT NOT NULL,
		week_end TEXT NOT NULL,
		unit_number TEXT NOT NULL DEFAULT '',
		verdict TEXT NOT NULL CHECK (verdict IN ('met', 'missed', 'frozen', 'pending')),
		reason TEXT NOT NULL,
		credits REAL NOT NULL,
		deliveries INTEGER NOT NULL,
		pickups INTEGER NOT NULL,
		hours REAL,
		rei REAL,
		target_credits REAL NOT NULL,
		target_hours REAL NOT NULL,
		worked_days INTEGER NOT NULL,
		days_off INTEGER NOT NULL,
		silent_days INTEGER NOT NULL,
		source_mix TEXT NOT NULL,
		detail TEXT NOT NULL,
		streak_eligible INTEGER NOT NULL CHECK (streak_eligible IN (0, 1)),
		locked_at TEXT NOT NULL,
		UNIQUE (directory_id, week_start)
	)`,
	...immutable("performance_weeks"),
	"CREATE INDEX IF NOT EXISTS idx_performance_weeks_week ON performance_weeks(week_start)",
	`CREATE TABLE IF NOT EXISTS performance_week_decisions (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		directory_id INTEGER NOT NULL,
		week_start TEXT NOT NULL,
		kind TEXT NOT NULL CHECK (kind IN ('hos_stop', 'hos_decline', 'office_verdict', 'proposal', 'pickup_credit')),
		verdict TEXT NOT NULL DEFAULT '',
		load_key TEXT NOT NULL DEFAULT '',
		reason TEXT NOT NULL DEFAULT '',
		actor TEXT NOT NULL,
		actor_role TEXT NOT NULL,
		created_ms INTEGER NOT NULL
	)`,
	...immutable("performance_week_decisions"),
	"CREATE INDEX IF NOT EXISTS idx_performance_decisions_week ON performance_week_decisions(directory_id, week_start)",
]);

function parseJson(text, fallback) {
	try { return JSON.parse(text); } catch { return fallback; }
}

// SQLite's CURRENT_TIMESTAMP text is UTC with no zone marker; NaN when unreadable.
const stampMs = (text) => Date.parse(`${String(text || "").trim().replace(" ", "T")}Z`);

// A reason as stored: one line, within its bounds; null when it isn't one.
function cleanReason(raw) {
	if (typeof raw !== "string" || raw.length > REASON_MAX * 4) return null;
	const v = raw.replace(/\s+/g, " ").trim();
	return v.length >= REASON_MIN && v.length <= REASON_MAX ? v : null;
}

function mount(app, deps) {
	const d = deps || {};
	for (const name of REQUIRED_DEPS) {
		if (typeof d[name] !== "function") throw new Error(`driver-performance-weeks-routes: deps.${name} is required`);
	}
	if (!d.db || typeof d.db.prepare !== "function") throw new Error("driver-performance-weeks-routes: deps.db is required");
	const db = d.db;
	const enabled = d.enabled === true;
	const norm = d.normalizeDriverName;
	const logger = d.logger || console;
	const goDay = rules.parseGoDay(d.goDay);
	const bonusCents = rules.parseBonusCents(d.quarterlyBonus);
	logger.log(`[driver-performance-weeks] DRIVER_PERFORMANCE_WEEKS_ENABLED ${enabled ? "on" : "off"}`);

	function performanceWeeksFlagGate(req, res, next) {
		if (!enabled) return next("route");
		return next();
	}
	// Built only when on: a limiter's store starts a timer, and off starts none.
	const limited = enabled ? [rateLimit({
		windowMs: 15 * 60 * 1000,
		max: RATE_LIMIT,
		keyGenerator: (req) => `u:${req.session.user.id}`,
		message: { error: "Too many requests. Try again in a few minutes.", code: "PERFORMANCE_RATE_LIMITED" },
		standardHeaders: true,
	})] : [];
	const gated = (...roles) => [performanceWeeksFlagGate, d.requireRole(...roles), ...limited];

	if (enabled) {
		for (const sql of SCHEMA_SQL) db.exec(sql);
		// The first day this ever ran on: no row is ever written for a week before it.
		db.prepare("INSERT OR IGNORE INTO server_state (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)")
			.run(SWITCH_ON_KEY, JSON.stringify({ day: d.appTodayKey(), atMs: d.now() }));
	}

	const stateOf = (key) => {
		const row = db.prepare("SELECT value FROM server_state WHERE key = ?").get(key);
		return row ? parseJson(row.value, null) : null;
	};
	const switchOnDay = () => {
		const s = stateOf(SWITCH_ON_KEY);
		return (s && s.day) || "";
	};
	// The week locks only after a rollup that covers its Friday night, so a late rollup
	// can't freeze or miss a week for hours it hadn't stored yet.
	function rollupCovers(weekStart) {
		const last = stateOf(ROLLUP_LAST_RUN_KEY);
		return !!last && Number(last.atMs) >= rules.weekCloseMs(weekStart);
	}
	const isLocked = (weekStart) => !!db.prepare("SELECT 1 FROM performance_week_runs WHERE week_start = ?").get(weekStart);

	// ── Facts ──────────────────────────────────────────────────────────────────

	// One directory row per driver name, the lowest id when two rows name one driver.
	function directoryByKey() {
		const out = new Map();
		for (const r of db.prepare("SELECT id, driver_name, status, pay_type, pay_daily, user_id FROM drivers_directory ORDER BY id").all()) {
			const key = norm(r.driver_name);
			if (key && !out.has(key)) out.set(key, r);
		}
		return out;
	}

	function ownerOperatorUserIds() {
		return new Set(db.prepare("SELECT user_id FROM owner_operators WHERE status <> 'ended'").all().map((r) => Number(r.user_id)));
	}

	// Day-rate company drivers only: a percentage driver or an owner-operator has no day
	// rate for a tier to act on (the board's own rule).
	function exclusionOf(row, ooUsers, extraUserId) {
		const ids = [Number(row.user_id), Number(extraUserId)].filter((n) => Number.isFinite(n) && n > 0);
		return perf.boardExclusion({ status: row.status, payType: row.pay_type, ownerOperator: ids.some((n) => ooUsers.has(n)) });
	}

	// Every driver in the roster, with what the week's rows would say today. No write.
	function gatherWeek(weekStart, jt, nowMs) {
		const weekEnd = rules.weekEndOf(weekStart);
		const days = perf.daysBetween(weekStart, weekEnd);
		const live = d.liveJobTrackingView(jt);
		const cols = d.invoiceWeekColumns(live.headers);
		const deletedKeys = d.loadKeySet(d.getDeletedLoadIds());
		const directory = directoryByKey();
		const ooUsers = ownerOperatorUserIds();
		const trucks = db.prepare("SELECT id, unit_number, COALESCE(retired_at, '') AS retired_at FROM trucks ORDER BY id").all();
		const countable = trucks.filter((t) => !String(t.retired_at).trim() && !perf.isTestUnit(t.unit_number));
		const countableIds = new Set(countable.map((t) => Number(t.id)));
		const resolver = d.buildDriverAtResolver(trucks.map((t) => t.id));
		const devices = d.buildEldDeviceResolver();

		// Who held which countable truck on each day, and whether a device was linked to it.
		// The link decides "has an ELD", never its reports: a device silent for weeks is
		// still linked, so going quiet can't turn into "no ELD" and a freeze.
		const heldByKey = new Map();
		const holdings = new Map();
		for (const t of countable) {
			for (const day of days) {
				const key = norm(resolver.atDay(t.id, day));
				if (!key) continue;
				if (!heldByKey.has(key)) heldByKey.set(key, new Map());
				const byDay = heldByKey.get(key);
				if (!byDay.has(day)) byDay.set(day, []);
				byDay.get(day).push({ truckId: Number(t.id), linked: !!devices.vehicleForTruckOnDay(t.id, day) });
				if (!holdings.has(key)) holdings.set(key, new Map());
				const held = holdings.get(key);
				if (!held.has(t.id)) held.set(t.id, { truckId: t.id, unit: t.unit_number, days: 0, firstDay: day, lastDay: day });
				const h = held.get(t.id);
				h.days += 1;
				h.lastDay = day;
			}
		}

		const reported = new Set(db.prepare(
			"SELECT truck_id, local_day FROM eld_activity_daily WHERE samples > 0 AND local_day >= ? AND local_day <= ?",
		).all(weekStart, weekEnd).map((r) => `${r.truck_id}|${r.local_day}`));
		const activity = new Map();
		for (const r of db.prepare(
			"SELECT driver_id, truck_id, local_day, driving_min, basis FROM eld_activity_daily WHERE week_start = ?",
		).all(weekStart)) {
			if (!countableIds.has(Number(r.truck_id))) continue;
			if (!activity.has(r.driver_id)) activity.set(r.driver_id, []);
			activity.get(r.driver_id).push(r);
		}
		// Approved and not cancelled only: a waiting or declined request lowers no target.
		const availability = d.driverAvailabilityByName(weekStart);

		// Delivered loads: the weekly invoice's own verdict, so a week here is its week.
		const deliveries = new Map();
		const loadsByKey = new Map();
		for (const row of live.data) {
			const key = cols.driverCol ? norm(row[cols.driverCol]) : "";
			if (!key) continue;
			const loadKey = (cols.loadIdCol && normalizeLoadId(row[cols.loadIdCol])) || "";
			if (loadKey) {
				if (!loadsByKey.has(key)) loadsByKey.set(key, new Map());
				loadsByKey.get(key).set(loadKey, String(row[cols.loadIdCol]));
			}
			if (d.invoiceWeekVerdict(row, cols, weekStart, weekEnd, deletedKeys) !== "bill") continue;
			if (!deliveries.has(key)) deliveries.set(key, new Map());
			deliveries.get(key).set(loadKey || `_row_${row._rowIndex}`, d.invoiceCompletionDay(row, cols));
		}

		const history = db.prepare(
			`SELECT id, load_id, old_status, new_status, source, actor, actor_role, fix_ms, pickup_zone, local_tz, other_load_hauling, changed_at
			 FROM load_status_history ORDER BY changed_at, id`,
		).all();
		const historyByLoad = new Map();
		for (const r of history) {
			const k = normalizeLoadId(r.load_id);
			if (!historyByLoad.has(k)) historyByLoad.set(k, []);
			historyByLoad.get(k).push(r);
		}
		const departs = new Map();
		for (const r of db.prepare("SELECT load_id, truck_id, pickup_depart_ms FROM load_eld_miles WHERE pickup_depart_ms > 0").all()) {
			departs.set(normalizeLoadId(r.load_id), r);
		}
		const coords = db.prepare("SELECT origin_lat, origin_lng, dest_lat, dest_lng FROM load_coordinates WHERE load_id = ?");
		const fixesFor = db.prepare(`SELECT location_date_ms AS ms, latitude, longitude, speed FROM routemate_telemetry
			WHERE routemate_vehicle_id = ? AND location_date_ms >= ? AND location_date_ms <= ?
			  AND dropped_reason = '' AND latitude IS NOT NULL AND longitude IS NOT NULL
			ORDER BY location_date_ms ASC, id ASC`);
		const reportedDays = new Map();
		for (const r of db.prepare(
			`SELECT truck_id, local_day FROM eld_miles_daily
			 WHERE samples > 0 AND truck_id > 0 AND local_day >= ? AND local_day <= ? GROUP BY truck_id, local_day`,
		).all(perf.addDays(weekStart, -perf.ELD_REPORTING_LOOKBACK_DAYS), weekEnd)) {
			if (!reportedDays.has(Number(r.truck_id))) reportedDays.set(Number(r.truck_id), new Set());
			reportedDays.get(Number(r.truck_id)).add(r.local_day);
		}
		const truckAt = (key, ms) => trucks.find((t) => norm(resolver.atInstant(t.id, ms)) === key) || null;
		const nearToMs = rules.weekCloseMs(weekStart) + DAY_MS;
		const nearFromMs = nearToMs - (rules.DAYS_IN_WEEK + 2) * DAY_MS;

		const out = [];
		for (const [key, row] of directory) {
			if (exclusionOf(row, ooUsers)) continue;
			const myLoads = loadsByKey.get(key) || new Map();
			const sheetLoadIds = [...myLoads.values()];
			const off = new Set();
			for (const a of availability.get(key) || []) {
				for (const day of days) if (a.from_date <= day && day <= a.to_date) off.add(day);
			}

			const pickups = [];
			const withheld = [];
			for (const [loadKey, shownId] of myLoads) {
				const events = historyByLoad.get(loadKey) || [];
				const depart = departs.get(loadKey) || null;
				// Only a load with an event around this week can credit it, which spares the
				// errand and twin reads for every older load on his sheet.
				const near = (ms) => ms >= nearFromMs && ms <= nearToMs;
				if (!events.some((r) => near(stampMs(r.changed_at))) && !(depart && near(Number(depart.pickup_depart_ms)))) continue;
				const ask ={ history, loadId: shownId, driver: row.driver_name, sheetLoadIds, normalizeName: norm };
				const errandAt = fuelPickupArrival.otherLoadUnderWayAt(ask);
				const twinAt = (ms) => {
					const truck = truckAt(key, ms);
					const vid = truck ? devices.vehicleForTruckAt(truck.id, ms) : "";
					const lc = coords.get(loadKey) || {};
					const pickup = { latitude: lc.origin_lat, longitude: lc.origin_lng };
					const dest = { latitude: lc.dest_lat, longitude: lc.dest_lng };
					const fixes = vid ? fixesFor.all(vid, ms - VISIT_LOOKBACK_MS, ms + VISIT_LOOKBACK_MS) : [];
					return fuelPickupArrival.twinAtShipper({ ...ask, fixes, pickup, radiusM: fuelPickupArrival.visitRadiusM(pickup, dest), nowMs })(ms);
				};
				const pick = rules.qualifiedPickup({
					events,
					driverKey: key,
					normalizeName: norm,
					eldDepartMs: depart ? depart.pickup_depart_ms : 0,
					eldTruckIsHis: !depart || !(Number(depart.truck_id) > 0) || Number((truckAt(key, Number(depart.pickup_depart_ms)) || {}).id) === Number(depart.truck_id),
					truckHasEldAt: (ms) => {
						const truck = truckAt(key, ms);
						return !!truck && perf.eldReportingOn(reportedDays.get(Number(truck.id)), perf.businessDayOf(ms));
					},
					errandAt,
					twinAt,
				});
				if (!pick) continue;
				const day = perf.businessDayOf(pick.ms);
				if (day < weekStart || day > weekEnd) continue;
				if (pick.withheld) withheld.push({ load: loadKey, reason: pick.withheld, day });
				else pickups.push({ load: loadKey, source: pick.source, day });
			}

			// Hours are attributed to the assigned driver, so a day he had off is the shop's
			// or a cover driver's. Each truck-local day is capped by perf.creditedHours().
			const hoursByDay = new Map();
			const worked = new Set();
			for (const a of activity.get(row.id) || []) {
				if (a.basis !== eldActivity.BASIS_ESTIMATE || a.driving_min === null || off.has(a.local_day)) continue;
				hoursByDay.set(a.local_day, (hoursByDay.get(a.local_day) || 0) + Number(a.driving_min) / 60);
				if (Number(a.driving_min) > 0) worked.add(a.local_day);
			}
			const delivered = deliveries.get(key) || new Map();
			for (const day of delivered.values()) if (day) worked.add(day);
			for (const p of pickups) worked.add(p.day);
			const hours = perf.creditedHours([...hoursByDay.values()]);

			const byDay = heldByKey.get(key) || new Map();
			const silent = days.filter((day) => {
				if (off.has(day)) return false;
				const linked = (byDay.get(day) || []).filter((h) => h.linked);
				return linked.length > 0 && !linked.some((h) => reported.has(`${h.truckId}|${day}`));
			});

			const credits = perf.loadCredits(delivered.size, pickups.length);
			const base = rules.baseVerdict({ daysOff: off.size, silentDays: silent.length, hours, workedDays: worked.size, credits });
			const mix = { geofence: 0, eld: 0, driver: 0, dispatch: 0, withheld: Object.fromEntries(WITHHELD_REASONS.map((w) => [w, 0])) };
			for (const p of pickups) mix[p.source] += 1;
			for (const w of withheld) mix.withheld[w.reason] += 1;
			const unit = perf.chooseUnit(holdings.has(key) ? [...holdings.get(key).values()] : []);
			out.push({
				directoryId: row.id,
				unitNumber: unit ? String(unit.unit || "") : "",
				verdict: base.verdict,
				reason: base.reason,
				credits,
				deliveries: delivered.size,
				pickups: pickups.length,
				hours,
				rei: perf.rei(credits, hours, base.targets),
				targetCredits: base.targets.credits,
				targetHours: base.targets.hours,
				workedDays: worked.size,
				daysOff: off.size,
				silentDays: silent.length,
				mix,
				detail: { deliveries: [...delivered.keys()], pickups, withheld, silent, daysOff: [...off] },
			});
		}
		return out;
	}

	// ── The lock ───────────────────────────────────────────────────────────────

	const insertRow = () => db.prepare(`INSERT INTO performance_weeks
		(directory_id, week_start, week_end, unit_number, verdict, reason, credits, deliveries, pickups, hours, rei, target_credits, target_hours,
		 worked_days, days_off, silent_days, source_mix, detail, streak_eligible, locked_at)
		VALUES (@directoryId, @weekStart, @weekEnd, @unitNumber, @verdict, @reason, @credits, @deliveries, @pickups, @hours, @rei, @targetCredits, @targetHours,
		 @workedDays, @daysOff, @silentDays, @mix, @detail, @eligible, @lockedAt)`);

	// One week, once, whole: the run marker and every row go in one transaction, so a
	// driver added later joins no locked week and a restart leaves no partial week.
	let running = false;
	async function lockDue(nowArg) {
		if (!enabled) return { skipped: "off" };
		if (running) return { skipped: "busy" };
		running = true;
		try {
			const nowMs = Number.isFinite(nowArg) ? nowArg : d.now();
			const weekStart = rules.lockableWeek(nowMs, d.getWeekRange);
			const onDay = switchOnDay();
			if (!onDay || weekStart < rules.firstFullWeekAfter(onDay, d.getWeekRange)) return { skipped: "before-first-full-week", weekStart };
			if (isLocked(weekStart)) return { skipped: "locked", weekStart };
			if (!rollupCovers(weekStart)) return { skipped: "rollup-not-covered", weekStart };
			let jt;
			try {
				jt = await d.getJobTrackingCached();
			} catch {
				return { skipped: "sheet-unreadable", weekStart };
			}
			const start = rules.streakStartWeek({ goDay, switchOnDay: onDay }, d.getWeekRange);
			// Stored with the row, never read from the setting later, so a go given or
			// back-dated afterwards can't pull an earlier week into a streak.
			const eligible = start && weekStart >= start ? 1 : 0;
			const lockedAt = new Date(nowMs).toISOString();
			const rows = gatherWeek(weekStart, jt, nowMs);
			const insert = insertRow();
			const wrote = db.transaction(() => {
				if (isLocked(weekStart)) return 0;
				for (const r of rows) {
					insert.run({
						directoryId: r.directoryId, weekStart, weekEnd: rules.weekEndOf(weekStart), unitNumber: r.unitNumber, verdict: r.verdict, reason: r.reason,
						credits: r.credits, deliveries: r.deliveries, pickups: r.pickups, hours: r.hours, rei: r.rei, targetCredits: r.targetCredits, targetHours: r.targetHours,
						workedDays: r.workedDays, daysOff: r.daysOff, silentDays: r.silentDays, mix: JSON.stringify(r.mix), detail: JSON.stringify(r.detail), eligible, lockedAt,
					});
				}
				db.prepare("INSERT INTO performance_week_runs (week_start, locked_at, rows_written) VALUES (?, ?, ?)").run(weekStart, lockedAt, rows.length);
				return rows.length;
			})();
			logger.log(`[driver-performance-weeks] locked week ${weekStart}: ${wrote} row(s)`);
			return { locked: weekStart, rows: wrote };
		} catch (err) {
			logger.error("[driver-performance-weeks] the lock failed:", err && err.message);
			return { error: (err && err.message) || "ERROR" };
		} finally {
			running = false;
		}
	}

	// ── The report ─────────────────────────────────────────────────────────────

	function decisionsByDriverWeek() {
		const out = new Map();
		for (const r of db.prepare("SELECT * FROM performance_week_decisions ORDER BY id").all()) {
			const k = `${r.directory_id}|${r.week_start}`;
			if (!out.has(k)) out.set(k, []);
			out.get(k).push(r);
		}
		return out;
	}

	// A later correction (a cancelled load, an ELD backfill) is shown beside the locked
	// row, and the row stays as it was.
	function correctionNotes(row, now) {
		if (!now) return [{ kind: "not-in-roster", locked: row.verdict, now: null }];
		const notes = [];
		if (now.credits !== row.credits) notes.push({ kind: "credits", locked: row.credits, now: now.credits });
		const hoursAt = (h) => (h === null ? null : Math.round(h * 100) / 100);
		if (hoursAt(now.hours) !== hoursAt(row.hours)) notes.push({ kind: "hours", locked: hoursAt(row.hours), now: hoursAt(now.hours) });
		if (now.verdict !== row.verdict) notes.push({ kind: "verdict", locked: row.verdict, now: now.verdict });
		return notes;
	}

	const decisionView = (x) => ({
		kind: x.kind, verdict: x.verdict || null, load: x.load_key || null, reason: x.reason || null, actor: x.actor, role: x.actor_role, at: new Date(x.created_ms).toISOString(),
	});

	app.get(PATHS.report, ...gated("Super Admin"), async (req, res) => {
		res.set("Cache-Control", "private, no-store");
		try {
			const nowMs = d.now();
			const asked = req.query.week === undefined ? "" : String(req.query.week);
			if (asked && !isWeekStart(asked)) return res.status(400).json({ error: "week must be a Saturday, YYYY-MM-DD.", code: "BAD_WEEK" });
			const latest = db.prepare("SELECT MAX(week_start) AS w FROM performance_week_runs").get().w || "";
			const week = asked || latest;
			const run = week ? db.prepare("SELECT * FROM performance_week_runs WHERE week_start = ?").get(week) : null;
			const onDay = switchOnDay();
			const start = rules.streakStartWeek({ goDay, switchOnDay: onDay }, d.getWeekRange);
			const names = new Map(db.prepare("SELECT id, driver_name, pay_daily FROM drivers_directory").all().map((r) => [r.id, r]));
			const decisions = decisionsByDriverWeek();
			const allRows = db.prepare("SELECT * FROM performance_weeks ORDER BY directory_id, week_start").all();
			const byDriver = new Map();
			for (const r of allRows) {
				if (!byDriver.has(r.directory_id)) byDriver.set(r.directory_id, []);
				const list = decisions.get(`${r.directory_id}|${r.week_start}`) || [];
				byDriver.get(r.directory_id).push({ row: r, list, ...rules.effectiveVerdict(r, list) });
			}
			let liveRows = null;
			if (run) {
				try {
					liveRows = new Map(gatherWeek(week, await d.getJobTrackingCached(), nowMs).map((x) => [x.directoryId, x]));
				} catch {
					liveRows = null;
				}
			}
			const walkOf = (list) => rules.walkStreak(list.map((w) => ({ weekStart: w.row.week_start, eligible: !!w.row.streak_eligible, verdict: w.verdict })));
			const drivers = [];
			for (const [directoryId, weeks] of byDriver) {
				const at = weeks.findIndex((w) => w.row.week_start === week);
				if (at < 0) continue;
				const { row, list, verdict, why } = weeks[at];
				const before = walkOf(weeks.slice(0, at));
				const through = walkOf(weeks.slice(0, at + 1));
				const during = rules.tierEarned(before);
				const next = rules.tierEarned(through);
				const dir = names.get(directoryId) || null;
				const rate = dir ? d.agreedRateOn(norm(dir.driver_name), dir.pay_daily, row.week_end) : null;
				const agreedCents = Number(rate) > 0 ? Math.round(Number(rate) * 100) : null;
				const detail = parseJson(row.detail, {});
				drivers.push({
					directoryId,
					name: dir ? dir.driver_name : null,
					unitNumber: row.unit_number,
					lockedVerdict: row.verdict,
					lockedReason: row.reason,
					verdict,
					verdictWhy: why,
					credits: row.credits,
					officeCredits: list.filter((x) => x.kind === "pickup_credit").length,
					targetCredits: row.target_credits,
					deliveries: row.deliveries,
					pickups: row.pickups,
					sourceMix: parseJson(row.source_mix, {}),
					withheld: detail.withheld || [],
					hoursEstimate: row.hours,
					targetHours: row.target_hours,
					rei: row.rei,
					reiDisplay: perf.reiDisplay(row.rei, row.verdict === "met"),
					workedDays: row.worked_days,
					daysOff: row.days_off,
					silentDays: row.silent_days,
					countsTowardStreak: !!row.streak_eligible,
					streak: through.streak,
					excuses: through.counts.excused,
					frozenWeeks: through.counts.frozen,
					undecidedPendingWeeks: through.unresolved,
					tierDuringWeek: during,
					upliftThisWeek: {
						perPaidDayCents: rules.upliftPerPaidDayCents(during.level, agreedCents),
						needsOfficeApproval: rules.needsOfficeApproval(verdict),
					},
					tierForNewWeek: next,
					upliftNewWeekPerPaidDayCents: rules.upliftPerPaidDayCents(next.level, agreedCents),
					quarterlyBonus: { flaggedWeeks: through.quarterly, text: through.quarterly.length ? rules.bonusText(bonusCents) : null },
					decisions: list.map(decisionView),
					notes: liveRows ? correctionNotes(row, liveRows.get(directoryId) || null) : [],
				});
			}
			drivers.sort((a, b) => String(a.name).localeCompare(String(b.name)));
			const lockMs = week ? rules.lockMomentMs(week) : null;
			return res.json({
				reportOnly: true,
				paysNothing: true,
				hoursLabel: HOURS_LABEL,
				go: {
					set: !!goDay,
					day: goDay || null,
					firstStreakWeek: start || null,
					text: goDay ? "Streaks count from the first full week after the owner's go." : "Streaks have not started: the owner's go is not set.",
				},
				switchedOnDay: onDay || null,
				tierReading: { id: rules.TIER_READING.id, tiers: rules.TIER_READING.tiers, isOwnersAnswer: false },
				week: week ? {
					start: week,
					end: rules.weekEndOf(week),
					state: run ? "locked" : nowMs < lockMs ? "not-closed" : !rollupCovers(week) ? "held-for-rollup" : "not-locked",
					lockedAt: run ? run.locked_at : null,
				} : null,
				correctionsChecked: !!liveRows,
				drivers,
			});
		} catch (err) {
			logger.error("[driver-performance-weeks] the report failed:", (err && err.message) || "ERROR");
			return res.status(500).json({ error: "The report could not be worked out.", code: "PERFORMANCE_WEEKS_FAILED" });
		}
	});

	// ── Decisions ──────────────────────────────────────────────────────────────

	function isWeekStart(day) {
		return arrivalPickup.isCalendarDay(day) && d.getWeekRange(day).weekStart === day;
	}

	const insertDecision = (fields) => db.prepare(`INSERT INTO performance_week_decisions
		(directory_id, week_start, kind, verdict, load_key, reason, actor, actor_role, created_ms)
		VALUES (@directoryId, @weekStart, @kind, @verdict, @loadKey, @reason, @actor, @role, @ms)`).run({ verdict: "", loadKey: "", reason: "", ...fields });

	const actorOf = (req) => ({ actor: String(req.session.user.username || "system"), role: String(req.session.user.role || "") });
	const auditId = (directoryId, weekStart) => `${directoryId}:${weekStart}`;

	// The driver and week a decision names: the driver in the directory; a Saturday; this
	// week or one that has a run on record. Answers and returns null when it isn't.
	function targetOf(req, res) {
		const directoryId = Number(req.params.directoryId);
		const weekStart = String(req.params.weekStart);
		if (!Number.isInteger(directoryId) || directoryId <= 0) {
			res.status(404).json({ error: "Driver not found", code: "DRIVER_NOT_FOUND" });
			return null;
		}
		const driver = db.prepare("SELECT id, driver_name FROM drivers_directory WHERE id = ?").get(directoryId);
		if (!driver) {
			res.status(404).json({ error: "Driver not found", code: "DRIVER_NOT_FOUND" });
			return null;
		}
		if (!isWeekStart(weekStart)) {
			res.status(400).json({ error: "The week must be a Saturday, YYYY-MM-DD.", code: "BAD_WEEK" });
			return null;
		}
		const current = d.getWeekRange(d.appTodayKey()).weekStart;
		if (weekStart > current) {
			res.status(400).json({ error: "That week hasn't started.", code: "WEEK_IN_FUTURE" });
			return null;
		}
		const row = db.prepare("SELECT * FROM performance_weeks WHERE directory_id = ? AND week_start = ?").get(directoryId, weekStart) || null;
		const locked = isLocked(weekStart);
		const closedUnlocked = !locked && weekStart < current && weekStart === perf.addDays(current, -rules.DAYS_IN_WEEK);
		if (locked ? !row : !(weekStart === current || closedUnlocked)) {
			res.status(404).json({ error: "No such week on record for this driver.", code: "WEEK_NOT_ON_RECORD" });
			return null;
		}
		return { directoryId, weekStart, driver, row };
	}

	function reasonOf(req, res) {
		const reason = cleanReason(req.body && req.body.reason);
		if (reason === null) res.status(400).json({ error: `A reason of ${REASON_MIN} to ${REASON_MAX} characters is required.`, code: "REASON_REQUIRED" });
		return reason;
	}

	const failedWrite = (res, err) => {
		logger.error("[driver-performance-weeks] a decision failed:", (err && err.message) || "ERROR");
		return res.status(500).json({ error: "The decision could not be saved.", code: "PERFORMANCE_WEEKS_FAILED" });
	};

	app.post(PATHS.decision, ...gated("Super Admin"), (req, res) => {
		res.set("Cache-Control", "private, no-store");
		try {
			const target = targetOf(req, res);
			if (!target) return undefined;
			const verdict = req.body && req.body.verdict;
			if (!rules.OFFICE_VERDICTS.includes(verdict)) {
				return res.status(400).json({ error: `The verdict must be one of ${rules.OFFICE_VERDICTS.join(", ")}.`, code: "BAD_VERDICT" });
			}
			const reason = reasonOf(req, res);
			if (reason === null) return undefined;
			if (verdict === "missed" && !target.row) return res.status(409).json({ error: "A week reads missed only once it has locked.", code: "WEEK_NOT_LOCKED" });
			insertDecision({ directoryId: target.directoryId, weekStart: target.weekStart, kind: "office_verdict", verdict, reason, ...actorOf(req), ms: d.now() });
			d.logAudit(req, "performance_week_decision", "driver_performance_week", auditId(target.directoryId, target.weekStart), `${verdict}: ${reason}`);
			return res.json({ saved: true, verdict });
		} catch (err) {
			return failedWrite(res, err);
		}
	});

	app.post(PATHS.hosDecline, ...gated("Super Admin"), (req, res) => {
		res.set("Cache-Control", "private, no-store");
		try {
			const target = targetOf(req, res);
			if (!target) return undefined;
			const reason = reasonOf(req, res);
			if (reason === null) return undefined;
			const here = db.prepare("SELECT * FROM performance_week_decisions WHERE directory_id = ? AND week_start = ? ORDER BY id").all(target.directoryId, target.weekStart);
			const mark = here.find((x) => x.kind === "hos_stop");
			if (!mark) return res.status(404).json({ error: "No hours-of-service stop is marked for this week.", code: "HOS_STOP_NOT_FOUND" });
			if (here.some((x) => x.kind === "hos_decline")) return res.status(409).json({ error: "This stop was already declined.", code: "HOS_ALREADY_DECLINED" });
			if (!rules.hosDeclineOpen(mark.created_ms, d.now())) {
				return res.status(409).json({ error: `The ${rules.HOS_DECLINE_DAYS} days to decline this stop have passed.`, code: "HOS_DECLINE_CLOSED" });
			}
			insertDecision({ directoryId: target.directoryId, weekStart: target.weekStart, kind: "hos_decline", reason, ...actorOf(req), ms: d.now() });
			d.logAudit(req, "performance_hos_decline", "driver_performance_week", auditId(target.directoryId, target.weekStart), reason);
			return res.json({ saved: true });
		} catch (err) {
			return failedWrite(res, err);
		}
	});

	app.post(PATHS.pickupCredit, ...gated("Super Admin"), async (req, res) => {
		res.set("Cache-Control", "private, no-store");
		try {
			const body = req.body || {};
			const loadKey = typeof body.loadId === "string" && body.loadId.length <= 64 ? normalizeLoadId(body.loadId) : "";
			let jt;
			try {
				jt = await d.getJobTrackingCached();
			} catch {
				return res.status(503).json({ error: "Job Tracking can't be read right now. Try again in a minute.", code: "PERFORMANCE_UNAVAILABLE" });
			}
			// Every check after the last await, so nothing can slip between it and the write.
			const target = targetOf(req, res);
			if (!target) return undefined;
			const reason = reasonOf(req, res);
			if (reason === null) return undefined;
			if (!loadKey) return res.status(400).json({ error: "A load id is required.", code: "LOAD_REQUIRED" });
			const live = d.liveJobTrackingView(jt);
			const cols = d.invoiceWeekColumns(live.headers);
			const who = norm(target.driver.driver_name);
			const his = cols.driverCol && cols.loadIdCol && live.data.some((row) => normalizeLoadId(row[cols.loadIdCol]) === loadKey && norm(row[cols.driverCol]) === who);
			if (!his) return res.status(404).json({ error: "That load isn't this driver's.", code: "LOAD_NOT_HIS" });
			const lockedCredit = db.prepare("SELECT detail FROM performance_weeks WHERE directory_id = ?").all(target.directoryId)
				.some((r) => (parseJson(r.detail, {}).pickups || []).some((p) => p.load === loadKey));
			const officeCredit = db.prepare("SELECT 1 FROM performance_week_decisions WHERE directory_id = ? AND kind = 'pickup_credit' AND load_key = ?").get(target.directoryId, loadKey);
			if (lockedCredit || officeCredit) return res.status(409).json({ error: "This load's pickup is already credited.", code: "PICKUP_ALREADY_CREDITED" });
			insertDecision({ directoryId: target.directoryId, weekStart: target.weekStart, kind: "pickup_credit", loadKey, reason, ...actorOf(req), ms: d.now() });
			d.logAudit(req, "performance_pickup_credit", "driver_performance_week", auditId(target.directoryId, target.weekStart), `${loadKey}: ${reason}`);
			return res.json({ saved: true });
		} catch (err) {
			return failedWrite(res, err);
		}
	});

	app.post(PATHS.proposal, ...gated("Dispatcher", "Super Admin"), (req, res) => {
		res.set("Cache-Control", "private, no-store");
		try {
			const target = targetOf(req, res);
			if (!target) return undefined;
			const verdict = req.body && req.body.verdict;
			if (!rules.PROPOSAL_VERDICTS.includes(verdict)) {
				return res.status(400).json({ error: `The verdict must be one of ${rules.PROPOSAL_VERDICTS.join(", ")}.`, code: "BAD_VERDICT" });
			}
			const reason = reasonOf(req, res);
			if (reason === null) return undefined;
			insertDecision({ directoryId: target.directoryId, weekStart: target.weekStart, kind: "proposal", verdict, reason, ...actorOf(req), ms: d.now() });
			d.logAudit(req, "performance_week_proposal", "driver_performance_week", auditId(target.directoryId, target.weekStart), `${verdict}: ${reason}`);
			return res.json({ proposed: true });
		} catch (err) {
			return failedWrite(res, err);
		}
	});

	// The driver's own mark, from his session: the route takes no driver in its path, and
	// its answer carries no hours, verdict or figure.
	app.post(PATHS.hosStop, ...gated("Driver"), (req, res) => {
		res.set("Cache-Control", "private, no-store");
		try {
			const key = norm(req.session.user.driverName);
			const row = key ? directoryByKey().get(key) || null : null;
			if (!row || exclusionOf(row, ownerOperatorUserIds(), req.session.user.id)) return res.status(404).json({ error: "Not found", code: "NOT_ELIGIBLE" });
			const weekStart = d.getWeekRange(d.appTodayKey()).weekStart;
			const marked = db.prepare("SELECT 1 FROM performance_week_decisions WHERE directory_id = ? AND week_start = ? AND kind = 'hos_stop'").get(row.id, weekStart);
			if (!marked) {
				insertDecision({ directoryId: row.id, weekStart, kind: "hos_stop", ...actorOf(req), ms: d.now() });
				d.logAudit(req, "performance_hos_stop", "driver_performance_week", auditId(row.id, weekStart), "marked by the driver");
			}
			return res.json({ marked: true, weekStart });
		} catch (err) {
			return failedWrite(res, err);
		}
	});

	return { enabled, PATHS, lockDue };
}

module.exports = { mount, PATHS, SCHEMA_SQL, HOURS_LABEL, SWITCH_ON_KEY };
