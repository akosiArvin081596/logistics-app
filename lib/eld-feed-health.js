// ELD feed silence — pure decision logic (no network, no DB, no clock of its own).
//
// WHAT THIS EXISTS TO CATCH, AND WHY IT IS NOT "JUST MONITORING"
// -------------------------------------------------------------
// Nothing in this app noticed when an ELD feed stopped. Measured on production
// 2026-09-19, three separate shapes of silence were live at once and none of
// them had produced a single signal:
//
//   LogisX-#2372  x78f4qtVukzwiF6ur7D04A   last fix 2026-08-11  (39 days)
//   LogisX-#302   18000505841 (Linxup)     last fix 2026-07-27  (54 days)
//   (orphan)      18000507597 (Linxup)     attached to NO truck, degraded to
//                                          exactly 1 ping/day from 2026-09-06
//
// That is a MONEY defect, not a dashboard gap. getEldTravelDaysByVehicle() is
// coverage-aware: a load window with NO pings falls back to the FULL scheduled
// window rather than reporting zero, which is the right call for a truck that
// predates the feed and the wrong one for a truck whose device died. The load
// then pays on the `estimated` basis — more driver days than were worked, so
// MORE driver pay and LESS investor profit — and writes nothing anywhere saying
// it did. Silence is the failure mode, so silence must be the thing that alarms.
//
// WHY THREE CONDITIONS AND NOT ONE
// --------------------------------
// The obvious detector is "newest fix older than N hours". It catches #2372 and
// #302 and is blind to the other two:
//
//   (a) STALE        linked + Active + not retired, newest fix older than
//                    `staleHours`. Includes the never-reported case, which is a
//                    link that has produced nothing at all.
//   (b) ORPHAN       a vehicle id writing telemetry that matches no truck's
//                    routemate_vehicle_id. (a) cannot see it — there is no truck
//                    row to iterate. This is the 18000507597 shape: a device we
//                    are paying for, pushing data we file under nothing, so its
//                    miles are invisible to every pay and haul path.
//   (c) TRICKLE      linked + Active + not retired, fewer than `minFixes24h`
//                    distinct fixes in the last 24 h. A device that degrades to
//                    one ping a day is NEVER stale by (a) — its newest fix keeps
//                    refreshing — while carrying no usable position history at
//                    all. Coverage-aware pay math sees "pings exist" and trusts
//                    a day built from one sample.
//
// THE ORPHAN LOOKBACK IS DELIBERATELY WIDER THAN THE STALE WINDOW.
// An orphan is a CONFIGURATION defect, not a liveness one: the device is
// mis-linked whether or not it pushed in the last hour, and the condition does
// not go away by itself. Judged on a 24 h window, 18000507597 — last seen four
// days before the sweep was written — would already have aged out of the only
// window that could report it, i.e. the detector would arrive too late for the
// exact row that motivated it. Telemetry purges at 90 days, so a 7-day default
// is bounded above by the data anyway.
//
// EVERYTHING HERE IS PURE. `nowMs` and `todayKey` are passed in; nothing calls
// Date.now() or new Date() on its own behalf, so the whole decision surface is
// drivable from a test without a server, a database or a fixed system clock.
// server.js owns the queries, the alert ledger, the mail and the socket fan-out.

"use strict";

// 24 h. One missed poll is not an outage; a full day of silence on a truck that
// is supposed to be working is. Below ~6 h this would alarm on a legitimately
// parked weekend truck whose device sleeps.
const DEFAULT_STALE_HOURS = 24;

// Healthy trucks in this fleet write ~5,760 rows/day (#33 and #91, measured
// 2026-09-19) — roughly one every 15 s. 10 in 24 h is three orders of magnitude
// below that and still comfortably above the 1/day trickle, so it separates
// "degraded" from "quiet weekend" without needing a per-truck baseline.
const DEFAULT_MIN_FIXES_24H = 10;

// 7 days. See the orphan note above: this window answers "is this device part of
// our current data stream", not "did it ping recently".
const DEFAULT_UNLINKED_LOOKBACK_HOURS = 168;

const HOUR_MS = 60 * 60 * 1000;

// The window the alert cap counts sends over, and how long a RESOLVED feed must
// wait after its last alert before it may alert again. Without the cooldown a
// feed hovering at the trickle floor — its fix count crossing the threshold back
// and forth — resolved and re-opened every other hourly sweep, and every re-open
// was a fresh email.
const ALERT_WINDOW_MS = 24 * HOUR_MS;
const DEFAULT_REOPEN_COOLDOWN_HOURS = 24;

// ⚠️ ONE CLOCK FORMAT. Alert stamps are toISOString() strings ("…T…Z") while
// SQLite's datetime() writes "YYYY-MM-DD HH:MM:SS" (UTC). Compared as raw text
// the "T" sorts after the space, so every stamp on the cutoff's own DATE counted
// as inside a "last 24 h" window. Everything here compares epoch milliseconds,
// and a bare SQLite stamp is read as UTC — never as the machine's local time.
function stampMs(stamp) {
	const s = String(stamp == null ? "" : stamp).trim();
	if (!s) return NaN;
	const sqlite = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/.exec(s);
	return Date.parse(sqlite ? `${sqlite[1]}T${sqlite[2]}Z` : s);
}

// The send stamps inside the rolling window that ends at nowMs. Unreadable ones
// are dropped rather than counted.
function sendsInWindow(sends, nowMs, windowMs) {
	const from = nowMs - windowMs;
	return (Array.isArray(sends) ? sends : []).filter((s) => {
		const t = stampMs(s);
		return Number.isFinite(t) && t > from;
	});
}

// Is a resolved feed still inside the cooldown that follows its last alert? A
// feed that was never delivered (no stamp) has no cooldown.
function reopenCooldownActive(lastAlertedAt, nowMs, cooldownMs) {
	const t = stampMs(lastAlertedAt);
	return Number.isFinite(t) && nowMs - t < cooldownMs;
}

// ⚠️ THE ALERT KEY IS VALIDATED, NOT MERELY TRIMMED — same reasoning as the
// duplicate-receipt alerter's key. A vehicle id reaches this function from two
// places that are not ours to trust: `trucks.routemate_vehicle_id` is free text
// an admin types into the Trucks UI, and an orphan id arrives straight off the
// Linxup webhook body. An unvalidated key therefore forges pm2 log lines and
// mail Subject headers with a newline, and an unbounded one bloats a PRIMARY
// KEY. Anything outside the shape every real id satisfies (Routemate's opaque
// base64-ish handles, Linxup's numeric device ids) collapses into one shared
// per-UTC-day bucket, so a malformed id costs at most one ping a day rather
// than one per sweep.
const VEHICLE_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;

function isUsableVehicleId(vehicleId) {
	return VEHICLE_ID_RE.test(String(vehicleId == null ? "" : vehicleId));
}

function feedAlertKey(vehicleId, nowMs) {
	const raw = String(vehicleId == null ? "" : vehicleId).trim();
	if (isUsableVehicleId(raw)) return `vid:${raw}`;
	const day = new Date(Number.isFinite(nowMs) ? nowMs : 0).toISOString().slice(0, 10);
	return `vid:unkeyed:${day}`;
}

// Is this truck retired as of `todayKey` (a bare YYYY-MM-DD calendar day)?
//
// ⚠️ STRING COMPARISON, NEVER new Date(). A bare date parses as UTC midnight,
// which in America/Chicago is 19:00 the PREVIOUS day — the same trap documented
// at truckChargeUntilMonth() in server.js, where it would have dropped a month
// of fixed costs. Here it would silence a truck a day early, which is the
// cheaper direction but still wrong, and copying the discipline costs nothing.
//
// ⚠️ ANYTHING MALFORMED READS AS **NOT RETIRED**, i.e. keep monitoring. Every
// production row has retired_at = '' today, so an inverted reading here would
// silence the entire fleet at once. "" is the overwhelmingly common value and it
// must never mean "retired long ago" — the same "" inversion that has already
// been corrected twice in the money math (PR #205, PR #216).
//
// A retirement date in the FUTURE is not a retirement yet: the truck is still
// working, still expected to report, and still able to mis-pay a load.
function isRetiredOn(retiredAt, todayKey) {
	const retired = String(retiredAt == null ? "" : retiredAt).trim();
	const m = retired.match(/^(\d{4})-(\d{2})-(\d{2})$/);
	if (!m) return false;
	const mo = parseInt(m[2], 10), dd = parseInt(m[3], 10);
	if (mo < 1 || mo > 12 || dd < 1 || dd > 31) return false;
	const today = String(todayKey == null ? "" : todayKey).trim();
	if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) return false; // unknown clock -> keep monitoring
	return retired <= today;
}

function resolveOptions(opts) {
	const o = opts || {};
	const pos = (v, dflt) => {
		const n = Number(v);
		return Number.isFinite(n) && n > 0 ? n : dflt;
	};
	return {
		nowMs: Number.isFinite(Number(o.nowMs)) ? Number(o.nowMs) : 0,
		staleHours: pos(o.staleHours, DEFAULT_STALE_HOURS),
		minFixes24h: pos(o.minFixes24h, DEFAULT_MIN_FIXES_24H),
		unlinkedLookbackHours: pos(o.unlinkedLookbackHours, DEFAULT_UNLINKED_LOOKBACK_HOURS),
		todayKey: String(o.todayKey == null ? "" : o.todayKey).trim(),
	};
}

function silentHoursFrom(lastFixMs, nowMs) {
	if (!Number.isFinite(Number(lastFixMs)) || Number(lastFixMs) <= 0) return null;
	return Math.max(0, (nowMs - Number(lastFixMs)) / HOUR_MS);
}

// One truck row -> one verdict.
//
// Input shape (all supplied by the caller's query; nothing is looked up here):
//   { truckId, unitNumber, status, retiredAt, vehicleId, lastFixMs, fixes24h }
//
// `state` is one of:
//   ok | stale | never_reported | trickle        <- linked + Active + not retired
//   no_device | inactive | retired               <- deliberately NOT alerting
// `alert` is the single boolean every caller should branch on.
function judgeTruckFeed(row, opts) {
	const o = resolveOptions(opts);
	const r = row || {};
	const vehicleId = String(r.vehicleId == null ? "" : r.vehicleId).trim();
	const unitNumber = String(r.unitNumber == null ? "" : r.unitNumber);
	const status = String(r.status == null ? "" : r.status).trim();
	const fixes24h = Number.isFinite(Number(r.fixes24h)) ? Number(r.fixes24h) : 0;
	const lastFixMs = Number.isFinite(Number(r.lastFixMs)) && Number(r.lastFixMs) > 0 ? Number(r.lastFixMs) : null;
	const silentHours = silentHoursFrom(lastFixMs, o.nowMs);

	const base = {
		kind: "truck",
		truckId: Number.isFinite(Number(r.truckId)) ? Number(r.truckId) : null,
		unitNumber,
		vehicleId,
		lastFixMs,
		silentHours,
		fixes24h,
		alert: false,
		state: "ok",
		reason: "",
		key: vehicleId ? feedAlertKey(vehicleId, o.nowMs) : "",
	};

	// ⚠️ ORDER MATTERS AND IT IS NOT ARBITRARY. Retirement is checked BEFORE the
	// link, so a retired truck whose device was handed to another truck cannot
	// alarm twice under two different states; and the link is checked before
	// status, so "this Active truck has no device at all" stays a distinct,
	// silent state rather than being swallowed by the freshness maths.

	// Retired. Nobody is driving it; its device going quiet is the expected
	// outcome of retiring it, not news. Respects trucks.retired_at — see
	// docs/claude/truck-retirement.md.
	if (isRetiredOn(r.retiredAt, o.todayKey)) {
		return { ...base, state: "retired", reason: `retired ${String(r.retiredAt).trim()}` };
	}

	// No device linked at all (production: INV-24-A). NOT an alert, on purpose.
	// An empty routemate_vehicle_id is a deliberate admin state — the truck may
	// simply have no ELD — and the three conditions this sweep implements are
	// about feeds that exist and have gone wrong. It is still SURFACED in the
	// feeds array so it is visible on the health endpoints rather than absent,
	// which is how INV-24-A stayed unnoticed in the first place.
	if (!vehicleId) {
		return { ...base, state: "no_device", reason: "no ELD device linked" };
	}

	// Parked/retired-in-practice statuses. An Inactive or OOS truck is expected
	// to be silent; alarming on it trains people to dismiss the alert that
	// matters, which is the failure this whole feature exists to avoid.
	if (status !== "Active") {
		return { ...base, state: "inactive", reason: `truck status ${status || "unknown"}` };
	}

	// (a) STALE — including the never-reported case.
	// A link that has produced no fix EVER is the same defect as one that stopped:
	// the pay math has no telemetry for this truck either way. It gets its own
	// state so the alert body can say the true thing ("this link has never
	// produced a fix") instead of quoting a silence duration it cannot compute.
	if (lastFixMs === null) {
		return {
			...base,
			state: "never_reported",
			alert: true,
			reason: "ELD linked but has never reported a fix",
		};
	}
	if (silentHours >= o.staleHours) {
		return {
			...base,
			state: "stale",
			alert: true,
			reason: `no ELD fix for ${Math.floor(silentHours)} h (threshold ${o.staleHours} h)`,
		};
	}

	// (c) TRICKLE — fresh enough that (a) will never fire, yet carrying almost no
	// position history. Checked only AFTER (a) so a stale truck reports the more
	// informative of the two conditions rather than both.
	if (fixes24h < o.minFixes24h) {
		return {
			...base,
			state: "trickle",
			alert: true,
			reason: `only ${fixes24h} ELD fix(es) in the last 24 h (expected at least ${o.minFixes24h})`,
		};
	}

	return base;
}

// One orphan telemetry id -> one verdict. Condition (b).
//
// Input shape: { vehicleId, lastFixMs, fixes24h }
// The caller is responsible for having already excluded every id that matches a
// trucks.routemate_vehicle_id; this function only judges recency.
function judgeOrphanFeed(row, opts) {
	const o = resolveOptions(opts);
	const r = row || {};
	const vehicleId = String(r.vehicleId == null ? "" : r.vehicleId).trim();
	const fixes24h = Number.isFinite(Number(r.fixes24h)) ? Number(r.fixes24h) : 0;
	const lastFixMs = Number.isFinite(Number(r.lastFixMs)) && Number(r.lastFixMs) > 0 ? Number(r.lastFixMs) : null;
	const silentHours = silentHoursFrom(lastFixMs, o.nowMs);

	const base = {
		kind: "orphan",
		truckId: null,
		unitNumber: "",
		vehicleId,
		lastFixMs,
		silentHours,
		fixes24h,
		alert: false,
		state: "orphan_idle",
		reason: "",
		key: vehicleId ? feedAlertKey(vehicleId, o.nowMs) : "",
	};

	if (!vehicleId) return { ...base, state: "orphan_idle", reason: "empty vehicle id" };
	if (lastFixMs === null) return { ...base, state: "orphan_idle", reason: "no telemetry" };

	// Outside the lookback the device is no longer part of our data stream, so
	// there is nothing actionable left to tell anyone: the rows will age out of
	// routemate_telemetry on the 90-day purge on their own.
	if (silentHours > o.unlinkedLookbackHours) {
		return { ...base, state: "orphan_idle", reason: `last fix ${Math.floor(silentHours)} h ago, outside the ${o.unlinkedLookbackHours} h lookback` };
	}

	return {
		...base,
		state: "orphan",
		alert: true,
		reason: `ELD device is writing telemetry but is linked to no truck (last fix ${Math.floor(silentHours)} h ago, ${fixes24h} fix(es) in 24 h)`,
	};
}

// The whole fleet in one call. `trucks` and `orphans` are the two query results;
// the return is every feed judged, plus the alerting subset in a stable order so
// the sweep, the email and the health endpoints cannot disagree about it.
function judgeEldFeeds(input, opts) {
	const o = resolveOptions(opts);
	const trucks = Array.isArray(input && input.trucks) ? input.trucks : [];
	const orphans = Array.isArray(input && input.orphans) ? input.orphans : [];
	const feeds = [
		...trucks.map((t) => judgeTruckFeed(t, o)),
		...orphans.map((v) => judgeOrphanFeed(v, o)),
	];
	// Longest silence first — the worst feed should be the one a reader sees at
	// the top of a truncated list. A never-reported feed has no silence duration
	// at all and sorts ahead of everything, which is the correct priority.
	const alerts = feeds
		.filter((f) => f.alert)
		.sort((a, b) => (b.silentHours === null ? Infinity : b.silentHours) - (a.silentHours === null ? Infinity : a.silentHours));
	return { feeds, alerts, thresholds: o };
}

function summarizeFeeds(feeds) {
	const out = { total: 0, ok: 0, alerting: 0, stale: 0, never_reported: 0, trickle: 0, orphan: 0, no_device: 0, inactive: 0, retired: 0, orphan_idle: 0 };
	for (const f of Array.isArray(feeds) ? feeds : []) {
		out.total++;
		if (Object.prototype.hasOwnProperty.call(out, f.state)) out[f.state]++;
		if (f.alert) out.alerting++;
	}
	return out;
}

module.exports = {
	DEFAULT_STALE_HOURS,
	DEFAULT_MIN_FIXES_24H,
	DEFAULT_UNLINKED_LOOKBACK_HOURS,
	HOUR_MS,
	ALERT_WINDOW_MS,
	DEFAULT_REOPEN_COOLDOWN_HOURS,
	VEHICLE_ID_RE,
	stampMs,
	sendsInWindow,
	reopenCooldownActive,
	isUsableVehicleId,
	feedAlertKey,
	isRetiredOn,
	judgeTruckFeed,
	judgeOrphanFeed,
	judgeEldFeeds,
	summarizeFeeds,
};
