"use strict";

// Driver Performance, Phase B4: the rules for locked week rows, streaks, freezes,
// excuses and the quarterly flag. REPORT ONLY: nothing here reaches an invoice, a
// ledger, a payout or an investor figure (scripts/test-performance-weeks.js pins it).
// Pure apart from lib/app-time.js's one read of APP_TIMEZONE: no network, database or
// file access. lib/driver-performance-weeks-routes.js gathers the facts and stores rows.

const appTime = require("./app-time");
const arrivalPickup = require("./arrival-pickup");
const fuelPickupArrival = require("./fuel-pickup-arrival");
const perf = require("./driver-performance");

// The tier reading, at the plan's default: a build setting, never the owner's answer.
// A tier is the day rate itself, and no one drops below his agreed rate. A different
// answer changes only this constant.
const TIER_READING = Object.freeze({
	id: "a-absolute",
	tiers: Object.freeze([
		Object.freeze({ level: 1, weeks: 3, rateCents: 32500 }),
		Object.freeze({ level: 2, weeks: 6, rateCents: 35000 }),
	]),
});

const QUARTERLY_WEEKS = 13;
const MIN_WORKED_DAYS = 3;
const DAYS_IN_WEEK = 7;
// Sat 06:00 on the business clock, after a rollup that covers Friday night.
const LOCK_HOUR = 6;
// A linked device silent for more than this share of the week reads "pending".
const SILENT_SHARE = 1 / 3;
const HOS_DECLINE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

const LOCKED_VERDICTS = Object.freeze(["met", "missed", "frozen", "pending"]);
// Never "met": the office can hold or reset a week, but only a week's facts can qualify it.
const OFFICE_VERDICTS = Object.freeze(["excused", "frozen", "missed"]);
const PROPOSAL_VERDICTS = Object.freeze(["excused", "frozen"]);
// A frozen, pending or excused week's days pay no uplift unless the office approves it.
const NEEDS_APPROVAL = Object.freeze(["frozen", "pending", "excused"]);

// ── Settings ────────────────────────────────────────────────────────────────

// The owner's go as a calendar day, or "": no default stands in for it, so anything
// else (empty, "true", a bad date) means streaks have not started.
function parseGoDay(raw) {
	const v = String(raw === null || raw === undefined ? "" : raw).trim();
	return arrivalPickup.isCalendarDay(v) ? v : "";
}

// The quarterly bonus in cents, or null: the amount is the owner's to give.
function parseBonusCents(raw) {
	const v = String(raw === null || raw === undefined ? "" : raw).trim();
	if (!/^\d{1,7}(\.\d{2})?$/.test(v)) return null;
	const cents = Math.round(Number(v) * 100);
	return cents > 0 ? cents : null;
}

function bonusText(cents) {
	return cents === null ? "Quarterly bonus due: amount not set" : `Quarterly bonus due: $${(cents / 100).toFixed(2)}`;
}

// ── The calendar ────────────────────────────────────────────────────────────

const weekEndOf = (weekStart) => perf.addDays(weekStart, DAYS_IN_WEEK - 1);

// A week that began on or before `day` is not a full week after it, so this is the
// next Saturday strictly after `day`, even when `day` is itself a Saturday.
function firstFullWeekAfter(day, weekRangeOf) {
	return perf.addDays(weekRangeOf(day).weekStart, DAYS_IN_WEEK);
}

// The first week whose streak counts, or "" with no go: after both the go and the
// switch-on, so a back-dated go can't reach a week from before either.
function streakStartWeek({ goDay, switchOnDay }, weekRangeOf) {
	if (!goDay || !switchOnDay) return "";
	return firstFullWeekAfter(goDay > switchOnDay ? goDay : switchOnDay, weekRangeOf);
}

function wallClockOn(day, hour) {
	const [y, m, d] = String(day).split("-").map(Number);
	return appTime.wallClockToMs(appTime.appTimeZone(), y, m, d, hour, 0, 0);
}

// The instant the week ends: the next Saturday's 00:00 on the business clock.
const weekCloseMs = (weekStart) => wallClockOn(perf.addDays(weekStart, DAYS_IN_WEEK), 0);
const lockMomentMs = (weekStart) => wallClockOn(perf.addDays(weekStart, DAYS_IN_WEEK), LOCK_HOUR);

// The latest week whose lock moment has passed at nowMs. Only this week can lock: a
// week older than it stays unwritten, so switching off and on again can't backfill.
function lockableWeek(nowMs, weekRangeOf) {
	const current = weekRangeOf(perf.businessDayOf(nowMs)).weekStart;
	const previous = perf.addDays(current, -DAYS_IN_WEEK);
	return nowMs >= lockMomentMs(previous) ? previous : perf.addDays(previous, -DAYS_IN_WEEK);
}

// ── One driver-week ─────────────────────────────────────────────────────────

// Approved days off lower the target pro rata, but never below the 3-worked-day
// minimum's worth, so days off can't make a week easier than 3 full days.
function weekTargets(daysOff) {
	const off = Math.max(0, Number(daysOff) || 0);
	const days = Math.max(MIN_WORKED_DAYS, perf.TARGET_DAYS - off);
	return {
		days,
		credits: (perf.CREDIT_TARGET * days) / perf.TARGET_DAYS,
		hours: (perf.HOURS_TARGET * days) / perf.TARGET_DAYS,
	};
}

// The verdict a week locks with. Silence comes before every freeze but a week fully
// off: a device that stopped reporting also removes the hours and the worked days, so
// reading those first would let pulling the plug freeze a week instead of risking it.
function baseVerdict({ daysOff, silentDays, hours, workedDays, credits }) {
	const targets = weekTargets(daysOff);
	const says = (verdict, reason) => ({ verdict, reason, targets });
	if ((Number(daysOff) || 0) >= DAYS_IN_WEEK) return says("frozen", "all-days-off");
	if ((Number(silentDays) || 0) > DAYS_IN_WEEK * SILENT_SHARE) return says("pending", "eld-silent");
	if (hours === null || hours === undefined) return says("frozen", "no-hours-data");
	if ((Number(workedDays) || 0) < MIN_WORKED_DAYS) return says("frozen", "under-3-worked-days");
	return perf.weekMet(credits, hours, targets) ? says("met", "targets-reached") : says("missed", "targets-not-reached");
}

const hosStopStands = (decisions) => (decisions || []).some((x) => x.kind === "hos_stop")
	&& !(decisions || []).some((x) => x.kind === "hos_decline");

// The verdict a locked row reads today: its own, unless a decision says otherwise. The
// row never changes; decisions sit beside it. An automatic excuse only rescues a missed
// week: a met week stays met, and a pending week waits for a Super Admin, so a tap can't
// cover a silent ELD. decisions: oldest first.
function effectiveVerdict(row, decisions) {
	const list = decisions || [];
	const office = [...list].reverse().find((x) => x.kind === "office_verdict");
	if (office) return { verdict: office.verdict, why: "office" };
	if (row.verdict === "missed") {
		const officeCredits = list.filter((x) => x.kind === "pickup_credit").length;
		const credits = Number(row.credits) + officeCredits * perf.CREDIT_WEIGHTS.pickup;
		const targets = { credits: row.target_credits, hours: row.target_hours };
		if (officeCredits > 0 && perf.weekMet(credits, row.hours, targets)) return { verdict: "met", why: "office-pickup-credit" };
		if (hosStopStands(list)) return { verdict: "excused", why: "hos-stop" };
	}
	return { verdict: row.verdict, why: "locked" };
}

// ── The streak ──────────────────────────────────────────────────────────────

// weeks: oldest first, { weekStart, eligible, verdict }. Only a row locked as eligible
// counts. Frozen, excused and pending weeks neither gain nor reset.
function walkStreak(weeks) {
	let streak = 0;
	const quarterly = [];
	const unresolved = [];
	const counts = { met: 0, missed: 0, frozen: 0, excused: 0, pending: 0 };
	for (const w of weeks || []) {
		if (!w.eligible) continue;
		counts[w.verdict] += 1;
		if (w.verdict === "met") {
			streak += 1;
			if (streak % QUARTERLY_WEEKS === 0) quarterly.push(w.weekStart);
		} else if (w.verdict === "missed") streak = 0;
		else if (w.verdict === "pending") unresolved.push(w.weekStart);
	}
	return { streak, quarterly, unresolved, counts };
}

// The tier a walk earns. While a pending week is undecided the tier is held, not given:
// a decision of "missed" would reset the streak, so a silent ELD can't protect a tier.
function tierEarned({ streak, unresolved }, reading = TIER_READING) {
	if (unresolved && unresolved.length) return { level: null, held: "pending-week" };
	let level = 0;
	for (const t of reading.tiers) if (streak >= t.weeks) level = t.level;
	return { level, held: null };
}

// What a tier adds per paid day over the agreed rate: never below 0, so the engine can't
// lower anyone. null when the tier is held or the agreed rate isn't on file.
function upliftPerPaidDayCents(level, agreedCents, reading = TIER_READING) {
	if (level === null || level === undefined) return null;
	if (level === 0) return 0;
	if (agreedCents === null || agreedCents === undefined || !Number.isFinite(Number(agreedCents)) || Number(agreedCents) <= 0) return null;
	const tier = reading.tiers.find((t) => t.level === level);
	return tier ? Math.max(0, tier.rateCents - Number(agreedCents)) : null;
}

const needsOfficeApproval = (verdict) => NEEDS_APPROVAL.includes(verdict);

// A Super Admin may decline an automatic excuse for 7 days from the driver's mark.
function hosDeclineOpen(markedMs, nowMs) {
	return Number.isFinite(markedMs) && nowMs <= markedMs + HOS_DECLINE_DAYS * DAY_MS;
}

// ── Pickup credit ───────────────────────────────────────────────────────────

// One load's pickup for the week's credit: { ms, source }, { ms, withheld } with why it
// isn't proof enough, or null when there is nothing to judge. A first geofence "In
// Transit" alone can be a queued load the truck only passed, one of two twins at one
// shipper, or a status staff later moved back, so a credit needs the load's current run
// and no errand or twin at that visit. events: the load's history rows. errandAt(ms) and
// twinAt(ms) answer for this driver. truckHasEldAt(ms): did his truck's ELD report then.
function qualifiedPickup({ events, driverKey, normalizeName, eldDepartMs, eldTruckIsHis = true, truckHasEldAt, errandAt, twinAt }) {
	const run = fuelPickupArrival.currentRun(events);
	const rows = run ? run.rows : [];
	const mine = (r) => normalizeName(r.actor) === driverKey;
	const transit = rows.filter((r) => r.status === "in transit");
	const heldAtVisit = (r) => {
		const arrival = [...rows].reverse().find((a) => a.status === "at shipper" && a.ms <= r.ms);
		const moments = arrival ? [arrival.ms, r.ms] : [r.ms];
		if ((arrival && arrival.hauling === 1) || r.hauling === 1 || moments.some((m) => errandAt(m))) return "errand";
		return moments.some((m) => twinAt(m)) ? "twin" : null;
	};

	const geofenceRows = transit.filter((r) => r.source === "geofence");
	const geofence = geofenceRows.find(mine);
	if (geofence) {
		const held = heldAtVisit(geofence);
		return held ? { ms: geofence.ms, withheld: held } : { ms: geofence.ms, source: "geofence" };
	}
	const depart = Number(eldDepartMs);
	if (depart > 0 && (!run || depart >= run.startMs)) {
		if (!eldTruckIsHis) return { ms: depart, withheld: "reassigned" };
		if (errandAt(depart)) return { ms: depart, withheld: "errand" };
		if (twinAt(depart)) return { ms: depart, withheld: "twin" };
		return { ms: depart, source: "eld" };
	}
	// A reassign writes no row, so the geofence row of a load now his is someone else's visit.
	if (geofenceRows.length) return { ms: geofenceRows[0].ms, withheld: "reassigned" };
	const tap = transit.find((r) => (r.source === "manual" && mine(r)) || r.source === "override");
	if (tap) {
		if (truckHasEldAt(tap.ms)) return { ms: tap.ms, withheld: "no-truck-record" };
		const held = heldAtVisit(tap);
		if (held) return { ms: tap.ms, withheld: held };
		return { ms: tap.ms, source: tap.source === "override" ? "dispatch" : "driver" };
	}
	const undone = arrivalPickup.orderedRows(events).find((r) => r.status === "in transit");
	if (undone) return { ms: undone.ms, withheld: "undone" };
	if (depart > 0) return { ms: depart, withheld: "undone" };
	return null;
}

module.exports = {
	TIER_READING,
	QUARTERLY_WEEKS,
	MIN_WORKED_DAYS,
	DAYS_IN_WEEK,
	LOCK_HOUR,
	SILENT_SHARE,
	HOS_DECLINE_DAYS,
	LOCKED_VERDICTS,
	OFFICE_VERDICTS,
	PROPOSAL_VERDICTS,
	parseGoDay,
	parseBonusCents,
	bonusText,
	weekEndOf,
	firstFullWeekAfter,
	streakStartWeek,
	weekCloseMs,
	lockMomentMs,
	lockableWeek,
	weekTargets,
	baseVerdict,
	hosStopStands,
	effectiveVerdict,
	walkStreak,
	tierEarned,
	upliftPerPaidDayCents,
	needsOfficeApproval,
	hosDeclineOpen,
	qualifiedPickup,
};
