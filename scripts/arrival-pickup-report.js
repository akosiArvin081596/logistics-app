#!/usr/bin/env node
// scripts/arrival-pickup-report.js — what the arrival pickup date
// (ARRIVAL_PICKUP_DATE_ENABLED, lib/arrival-pickup.js) would change, run on the
// server with no login before the rule goes on. Read-only: it opens app.db with a
// read-only handle, reads Job Tracking with the read-only scope (or a saved
// values.get), makes no other network call and writes nothing anywhere.
//
// It lifts this checkout's server.js (scripts/lib/ledger-world.js) and runs the
// server's own code with the rule off (today) and on from a candidate FROM, every
// other setting as the app's .env has it. Five sections:
//   1 recorder health    the status rows written since FROM: "At Shipper" rows by
//                        source and role, the taps' position verdicts and fix ages,
//                        batch taps, geofence rows by other_load_hauling and by the
//                        other load's status, the geofence's ping-to-row lag (first
//                        history rows apart), the stored zones and the days where the
//                        shipper's day is not the app's day
//   2 in-scope loads     completed loads of daily-rate drivers assigned FROM or
//                        later: the official pickup by source or none by reason,
//                        official minus scheduled days, the S3 lists, D11b's
//                        driver-days with and without an ELD, the loads the rule
//                        could not read or place, and the weekly invoices saved
//                        after their week's Friday batch ran
//   3 money              the payout ledger per scope, driver and month; each
//                        investor's raw earnings and payable (split and lease months
//                        apart) and the company's share; a check that driver pay,
//                        investor and company earnings add up to zero per scope and
//                        month; the weekly invoice per driver-week (an issued invoice
//                        is never regenerated); invoice and ledger side by side; and
//                        GET /api/investor checked to move as the ledger does
//   4 checks             every closed month and every month before FROM unchanged
//   5 cross-check        the official day against the replayed pickup arrival
//                        (load_eld_miles.pickup_arrive_ms), with and without the
//                        load's dispatch as a lower bound
// Drivers are "driver 1", …; investors their owner id; Load IDs and invoice
// numbers only with --ids. No name is printed.
//
// Usage (on the server, from the app directory, with the Node pm2 runs it with):
//   node scripts/arrival-pickup-report.js --db=app.db --sheet-id=<id> --from=YYYY-MM-DD [--key=service-account-key.json] [--ids] [--json]
//   --from=YYYY-MM-DD       the ARRIVAL_PICKUP_DATE_FROM to try: a calendar date, not
//                           after today (APP_TIMEZONE), in a month after the latest
//                           closed one (the recorder's switch-on date is the one to use)
//   --sheet-id=env          the SPREADSHEET_ID the .env sets (refused when none)
//   --values-json=<file>    a saved values.get of Job Tracking, in place of --sheet-id
//   --env-file=<file>       with a copy of the database under the temp directory only
//   --ids                   list Load IDs and invoice numbers (default: counts only)
//   --json                  print the whole result as JSON (default: a text report)
//   --dry-run               accepted; the run is always read-only
// Exit codes: 0 done, 1 error, or a closed month or a month before FROM would
// change, or the money does not add up, or the investor view and the ledger move
// apart; 2 refused (FROM missing, not a date, in the future or in a closed month, a
// missing input, or the rule already on in the app's .env, so "today" would
// already include it).

"use strict";

const path = require("path");
const { createRequire } = require("module");
const { buildLedgerWorld, parseArgs, sheetFor, envFor } = require("./lib/ledger-world");
const loadPayDays = require("../lib/load-pay-days");
const ledgerDayOnce = require("../lib/ledger-day-once");
const eldMiles = require("../lib/eld-miles");
const appTime = require("../lib/app-time");

const tripWorkDays = require("../lib/trip-work-days");

const arrivalPickup = loadPayDays.arrivalPickup;
const ROOT = path.join(__dirname, "..");
const FIGURES = ["revenue", "driverPay", "fixedCosts", "tripExpenses", "maintFundCost", "complianceCost"];
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
// The add-up and the view checks allow a dollar of rounding: the split is applied
// to the raw net and rounded once.
const ROUNDING_USD = 1;
// The stop points (S3) the switch-on waits on: reviewed constants, never settings.
const S3 = Object.freeze({ earlyShare: 0.05, rejectedTapShare: 0.2, noArrivalShare: 0.2, tapNoFixShare: 0.2, earlyDays: 2, extendedDays: 2 });
const round2 = (x) => Math.round(x * 100) / 100;
const usd = (x) => (x === null || x === undefined ? "n/a" : `${x < 0 ? "-" : ""}$${Math.abs(x).toFixed(2)}`);
const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)}%` : "n/a");
const text = (v) => (v === null || v === undefined ? "" : String(v));
const statusOf = (s) => text(s).trim().toLowerCase().replace(/\s+/g, " ");
// load_status_history and load_eld_miles key a load lower-case, any leading "#" removed.
const loadKey = (id) => text(id).trim().toLowerCase().replace(/^#/, "");
// changed_at is SQLite's UTC "YYYY-MM-DD HH:MM:SS", with no zone marker.
const stampMs = (s) => Date.parse(text(s).trim().replace(" ", "T") + "Z");
const addDay = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 24 * HOUR).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / (24 * HOUR));
function dayRange(a, b) {
	const out = [];
	for (let d = a; d <= b; d = addDay(d, 1)) out.push(d);
	return out;
}
const inc = (o, k, n = 1) => { o[k] = (o[k] || 0) + n; };
const COMPLETED_RE = /delivered|completed|pod received/i;
const FOLLOW_UP_RE = /^(at receiver|delivered)$/;
// The other load's status a geofence arrival is read against, most under way
// first: the first four make other_load_hauling 1 (lib/arrival-recorder.js).
const OTHER_ORDER = ["in transit", "loading", "at shipper", "heading to shipper", "at receiver"];
const HISTORY_SQL = `SELECT id, load_id, old_status, new_status, source, actor, actor_role, fix_ms, pickup_zone, local_tz, other_load_hauling, changed_at
	FROM load_status_history ORDER BY changed_at, id`;

// Ages and lags in bands that show the rule's 5- and 15-minute thresholds.
function ageBand(ms) {
	if (ms <= 2 * MINUTE) return "0-2 min";
	if (ms <= 5 * MINUTE) return "2-5 min";
	if (ms <= 15 * MINUTE) return "5-15 min";
	if (ms <= HOUR) return "15-60 min";
	if (ms <= 6 * HOUR) return "1-6 h";
	return "over 6 h";
}
function diffBand(d) {
	if (d <= -3) return "-3 or less";
	if (d >= 3) return "+3 or more";
	return d > 0 ? `+${d}` : String(d);
}

// A change in `month` that the report must stop on: { closed: true } in a closed
// month, { beforeFrom: true } in a month before FROM's, else null.
function monthGuard(month, isLocked, fromMonth) {
	if (isLocked(month)) return { closed: true };
	if (month < fromMonth) return { beforeFrom: true };
	return null;
}

function refuse(msg) {
	console.error(`REFUSED: ${msg}`);
	process.exit(2);
}

function latestClosedOf(dbFile) {
	const Database = createRequire(path.join(ROOT, "server.js"))("better-sqlite3");
	const probe = new Database(dbFile, { readonly: true, fileMustExist: true });
	try {
		if (!probe.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'period_locks'").get()) {
			refuse("the database has no period_locks table, so its closed months cannot be told");
		}
		return ledgerDayOnce.latestClosedMonth(probe);
	} finally {
		probe.close();
	}
}

// The server functions this script runs, lifted from server.js with their closure.
const EXTRA_ROOTS = [
	"payoutRules", "jobTrackingRowsOf", "invoiceWeekColumns", "invoiceWeekVerdict", "invoiceCompletionDay", "selectInvoiceWeekLoads",
	"getWeekRange", "parseInvoiceDate", "jobTrackingMonthCols", "invoiceWeekPaidDays", "invoiceDayPricing", "liveWeeklyInvoicesForDriverWeek",
	"invoicePaidDaysOf", "getDriverPayStructures", "truckDailyRateCandidates", "resolveDailyRate", "normalizeDriverName", "loadKeySet",
	"getDeletedLoadIds", "tripDayResolver", "invoiceExtraRuleLoads", "moneySheetDate", "getEldTravelDaysByVehicle", "resolveInvestorSplitPct",
];

// Every status row, by load, oldest first; `error` when the recorder's columns
// can't be read (an older copy of the database).
function readHistory(db) {
	try {
		const byLoad = new Map();
		for (const r of db.prepare(HISTORY_SQL).all()) {
			const k = loadKey(r.load_id);
			if (!k) continue;
			if (!byLoad.has(k)) byLoad.set(k, []);
			byLoad.get(k).push({ ...r, ms: stampMs(r.changed_at), status: statusOf(r.new_status), src: statusOf(r.source), role: text(r.actor_role).trim() });
		}
		return { byLoad, error: null };
	} catch (err) {
		return { byLoad: new Map(), error: text(err && err.message) };
	}
}

// The mapped pickup and drop-off points, by load key.
function readPoints(db) {
	const out = new Map();
	try {
		for (const r of db.prepare("SELECT load_id, origin_lat, origin_lng, dest_lat, dest_lng FROM load_coordinates").all()) {
			const ok = (lat, lng) => Number.isFinite(Number(lat)) && Number.isFinite(Number(lng)) && !(Number(lat) === 0 && Number(lng) === 0) && lat !== null && lng !== null;
			out.set(loadKey(r.load_id), {
				pickup: ok(r.origin_lat, r.origin_lng) ? { lat: Number(r.origin_lat), lng: Number(r.origin_lng) } : null,
				dest: ok(r.dest_lat, r.dest_lng) ? { lat: Number(r.dest_lat), lng: Number(r.dest_lng) } : null,
			});
		}
	} catch { /* no table: every load reads as unmapped */ }
	return out;
}

// The latest status of a load at `atMs`, from its history ("" before its first row).
function statusAt(rows, atMs) {
	let s = "";
	for (const r of rows || []) { if (r.ms <= atMs) s = r.status; else break; }
	return s;
}

// Section 1. `driverOf` maps a load key to its sheet driver, `loadsOf` a driver to
// the keys of their loads, so a geofence arrival is read against the driver's
// other loads (each row counted once, by the most under-way one).
function recorderHealth({ history, sinceMs, appZone, driverOf, loadsOf, points }) {
	const out = {
		since: new Date(sinceMs).toISOString().slice(0, 10),
		readable: !history.error,
		error: history.error,
		rows: 0, recorderRows: 0, rowsWithoutRole: 0,
		atShipper: {},
		taps: { driver: { inside: 0, outside: 0, unknown: 0 }, staff: { inside: 0, outside: 0, unknown: 0 } },
		driverTaps: 0, driverTapsNoFix: 0, tapFixAge: {},
		batchTaps: 0, manualFollowedWithin15: 0,
		geofence: { rows: 0, byHauling: {}, lag: {}, noFix: 0, fixAfterRow: 0, beforeDispatch: 0, firstRow: { rows: 0, lag: {} } },
		zones: {}, zoneFromAppFallback: 0, shipperDayNotAppDay: 0,
	};
	if (history.error) return out;
	for (const [key, rows] of history.byLoad) {
		rows.forEach((r, k) => {
			if (!(r.ms >= sinceMs)) return;
			out.rows++;
			if (r.role) out.recorderRows++; else out.rowsWithoutRole++;
			if (r.status !== "at shipper") return;
			inc(out.atShipper, `${r.src || "(none)"} / ${r.role || "(no role)"}`);
			if (!r.role) return;
			const tz = text(r.local_tz).trim();
			const zone = statusOf(r.pickup_zone);
			const fixMs = Number(r.fix_ms) > 0 ? Number(r.fix_ms) : null;
			inc(out.zones, tz || "(empty)");
			const moment = r.src === "geofence" && fixMs ? fixMs : r.ms;
			if (tz && eldMiles.localDayInTz(moment, tz) !== appTime.dayInZone(moment, appZone && appTime.businessZoneAt(moment, appZone))) out.shipperDayNotAppDay++;
			// The recorder takes the zone from the mapped point, else a fresh fix, else
			// the app's zone: no point now and no position on the row means the last.
			const pt = points.get(key);
			if (!zone && !(pt && pt.pickup)) out.zoneFromAppFallback++;
			if (r.src === "manual") {
				const group = r.role === "Driver" ? "driver" : "staff";
				const verdict = zone === "inside" || zone === "outside" ? zone : "unknown";
				out.taps[group][verdict]++;
				let followed = false;
				for (let j = k + 1; j < rows.length && rows[j].ms - r.ms <= arrivalPickup.BATCH_TAP_MS; j++) {
					if (FOLLOW_UP_RE.test(rows[j].status)) { followed = true; break; }
				}
				if (followed) out.manualFollowedWithin15++;
				if (group === "driver") {
					out.driverTaps++;
					if (fixMs) inc(out.tapFixAge, ageBand(r.ms - fixMs)); else out.driverTapsNoFix++;
					if (followed && verdict === "unknown") out.batchTaps++;
				}
			} else if (r.src === "geofence") {
				const g = out.geofence;
				g.rows++;
				const hauling = r.other_load_hauling === 0 || r.other_load_hauling === 1 ? String(r.other_load_hauling) : "(empty)";
				const driver = driverOf.get(key);
				let other = driver ? "none" : "driver not on the sheet";
				if (driver) {
					let best = OTHER_ORDER.length;
					for (const o of loadsOf.get(driver) || []) {
						if (o === key) continue;
						const at = OTHER_ORDER.indexOf(statusAt(history.byLoad.get(o), r.ms));
						if (at !== -1 && at < best) best = at;
					}
					if (best < OTHER_ORDER.length) other = OTHER_ORDER[best];
				}
				if (!g.byHauling[hauling]) g.byHauling[hauling] = {};
				inc(g.byHauling[hauling], other);
				if (!fixMs) { g.noFix++; return; }
				const lag = r.ms - fixMs;
				if (lag < 0) g.fixAfterRow++; else inc(g.lag, ageBand(lag));
				if (k === 0) { g.firstRow.rows++; if (lag >= 0) inc(g.firstRow.lag, ageBand(lag)); }
				for (let j = k - 1; j >= 0; j--) {
					if (rows[j].status === "dispatched") { if (fixMs < rows[j].ms) g.beforeDispatch++; break; }
				}
			}
		});
	}
	return out;
}

// Section 2 and 5: each completed, live load of a daily-rate driver assigned FROM
// or later, with the rule's answer for it (`resolver`, the pay paths' own).
function inScopeLoads({ api, jt, from, resolver, history, points, eldByVid, unitToVid, replays }) {
	const { headers, data } = jt;
	const cols = api.invoiceWeekColumns(headers);
	const monthCols = api.jobTrackingMonthCols(headers);
	const deletedKeys = api.loadKeySet(api.getDeletedLoadIds());
	const payStructs = api.getDriverPayStructures();
	const truckCol = headers.find((h) => /^truck$|truck[._\s-]?(unit|number|#)|unit[._\s-]?number/i.test(h));
	const excluded = { noAssignedDate: 0, percentage: 0 };
	const loads = [];
	for (const row of data) {
		const verdict = api.invoiceWeekVerdict(row, cols, "", "", deletedKeys);
		if (verdict === "open" || verdict === "deleted") continue;
		const nameNorm = api.normalizeDriverName(cols.driverCol ? text(row[cols.driverCol]).trim() : "");
		if (!nameNorm) continue;
		const percentage = (payStructs[nameNorm] || {}).payType === "percentage";
		const assignedDate = monthCols && monthCols.dateCol && row[monthCols.dateCol] ? api.moneySheetDate(row[monthCols.dateCol]) : null;
		const assigned = arrivalPickup.dayKeyOf(assignedDate);
		if (!assigned) { if (!percentage) excluded.noAssignedDate++; continue; }
		if (assigned < from) continue;
		if (percentage) { excluded.percentage++; continue; }
		const loadId = cols.loadIdCol ? text(row[cols.loadIdCol]).trim() : "";
		const key = loadKey(loadId);
		const unit = truckCol ? text(row[truckCol]).trim().toLowerCase() : "";
		const load = {
			loadId, key, driver: nameNorm, assigned, dated: verdict !== "undated",
			scheduledPickup: arrivalPickup.dayKeyOf(api.parseInvoiceDate(cols.pickupCol ? row[cols.pickupCol] : null)),
			scheduledDropoff: arrivalPickup.dayKeyOf(api.parseInvoiceDate(cols.dropoffCol ? row[cols.dropoffCol] : null)),
			vid: unit ? unitToVid[unit] || null : null,
		};
		const answer = resolver.forLoad({ loadId, assigned: assignedDate, completed: true });
		const rows = history.byLoad.get(key) || [];
		if (!answer) load.outcome = "out of scope";
		else if (answer.error) { load.outcome = "not read"; load.error = answer.error; }
		else if (answer.none) load.outcome = answer.none;
		else if (answer.fallback) {
			load.outcome = "no delivery";
			load.fallbackKind = rows.some((r) => COMPLETED_RE.test(r.status)) ? "moved off its completed status since" : "no completed row in the history";
		} else {
			load.outcome = answer.arrival.source;
			load.start = answer.start;
			load.delivered = answer.delivered;
			load.zone = answer.arrival.zone;
			load.arrivalMs = answer.arrival.ms;
			load.deliveredMs = answer.deliveredMs;
			const at = rows.findIndex((r) => answer.arrival.rowId !== null && Number(r.id) === answer.arrival.rowId);
			const row0 = at === -1 ? null : rows[at];
			load.firstRowGeofence = !!row0 && at === 0 && row0.src === "geofence";
			load.firstRowDayMoved = load.firstRowGeofence && eldMiles.localDayInTz(row0.ms, load.zone) !== load.start;
			const actor = row0 ? api.normalizeDriverName(text(row0.actor)) : "";
			load.fromAnotherDriver = !!actor && actor !== nameNorm;
			const dest = (points.get(key) || {}).dest;
			load.receiverDay = dest ? eldMiles.localDayInTz(load.deliveredMs, eldMiles.usTzForLongitude(dest.lng)) : "";
		}
		const replay = replays.get(key);
		if (replay) {
			// The bound: the load's latest dispatch at or before its official arrival
			// (with none, its latest dispatch).
			let dispatchMs = null;
			for (const r of rows) { if (r.status === "dispatched" && (!load.arrivalMs || r.ms <= load.arrivalMs)) dispatchMs = r.ms; }
			load.replay = { ms: replay, withinDispatch: dispatchMs !== null && replay >= dispatchMs, noDispatch: dispatchMs === null };
		}
		if (load.start) {
			load.officialMinusScheduled = load.scheduledPickup ? daysBetween(load.scheduledPickup, load.start) : null;
			if (load.scheduledDropoff) {
				load.arrivalAfterDropoff = load.start > load.scheduledDropoff;
				load.extendedBy = daysBetween(load.scheduledDropoff, load.delivered);
				if (load.extendedBy > 0) {
					// D11b (a), built: to the later of the drop-off and the delivery. (b):
					// to the drop-off, else (D11) the delivery, else the arrival day.
					const endA = [load.scheduledDropoff, load.delivered].filter((d) => d >= load.start).sort().pop() || load.start;
					const endB = load.scheduledDropoff >= load.start ? load.scheduledDropoff : (load.delivered >= load.start ? load.delivered : load.start);
					const eld = load.vid ? eldByVid[load.vid] : null;
					const a = loadPayDays.eldCountedDays(dayRange(load.start, endA), eld);
					const b = loadPayDays.eldCountedDays(dayRange(load.start, endB), eld);
					load.d11b = { covered: a.covered, a: { window: dayRange(load.start, endA).length, paid: a.days.length }, b: { window: dayRange(load.start, endB).length, paid: b.days.length } };
				}
			} else {
				load.blankDropoffDays = dayRange(load.start, load.delivered >= load.start ? load.delivered : load.start).length;
			}
		}
		loads.push(load);
	}
	return { loads, excluded };
}

// Section 2's counts, and section 5's cross-check, from inScopeLoads().
function summarizeLoads(loads) {
	const official = loads.filter((l) => l.start);
	const s = {
		inScope: loads.length,
		official: { geofence: 0, driver: 0 },
		none: Object.fromEntries(arrivalPickup.REASONS.map((r) => [r, 0])),
		noDelivery: {},
		notRead: loads.filter((l) => l.outcome === "not read").length,
		officialMinusScheduled: {},
		noScheduledPickup: 0,
		earlyBy2: official.filter((l) => l.officialMinusScheduled !== null && l.officialMinusScheduled <= -S3.earlyDays),
		arrivalAfterDropoff: official.filter((l) => l.arrivalAfterDropoff),
		completedAfterDropoff: { eld: { loads: 0, a: { window: 0, paid: 0 }, b: { window: 0, paid: 0 } }, noEld: { loads: 0, a: { window: 0, paid: 0 }, b: { window: 0, paid: 0 } } },
		noEldExtended2: official.filter((l) => l.d11b && !l.d11b.covered && l.extendedBy >= S3.extendedDays),
		blankDropoff: { loads: 0, days: {} },
		fromAnotherDriver: official.filter((l) => l.fromAnotherDriver),
		receiverDayDiffers: 0, noReceiverPoint: 0,
		firstRowGeofence: official.filter((l) => l.firstRowGeofence),
		firstRowDayMoved: official.filter((l) => l.firstRowDayMoved).length,
		notReadLoads: loads.filter((l) => l.outcome === "not read"),
		noDeliveryLoads: loads.filter((l) => l.outcome === "no delivery"),
	};
	for (const l of loads) {
		if (l.start) inc(s.official, l.outcome);
		else if (l.outcome === "no delivery") inc(s.noDelivery, l.fallbackKind);
		else if (Object.prototype.hasOwnProperty.call(s.none, l.outcome)) s.none[l.outcome]++;
	}
	for (const l of official) {
		if (l.officialMinusScheduled === null) s.noScheduledPickup++;
		else inc(s.officialMinusScheduled, diffBand(l.officialMinusScheduled));
		if (l.d11b) {
			const g = s.completedAfterDropoff[l.d11b.covered ? "eld" : "noEld"];
			g.loads++;
			for (const k of ["a", "b"]) { g[k].window += l.d11b[k].window; g[k].paid += l.d11b[k].paid; }
		}
		if (l.blankDropoffDays) { s.blankDropoff.loads++; inc(s.blankDropoff.days, String(l.blankDropoffDays)); }
		if (!l.receiverDay) s.noReceiverPoint++;
		else if (l.receiverDay !== l.delivered) s.receiverDayDiffers++;
	}
	// Section 5: the replayed arrival's day in the shipper's zone against the
	// official day; and how many loads with no official pickup have a replay.
	const x = { compared: 0, agree: 0, differ: 0, bounded: { compared: 0, agree: 0, differ: 0 }, outsideBound: 0, noDispatch: 0, noArrivalWithReplay: {} };
	for (const l of loads) {
		if (!l.replay) continue;
		if (!l.start) {
			if (l.outcome !== "out of scope") {
				const e = x.noArrivalWithReplay[l.outcome] || (x.noArrivalWithReplay[l.outcome] = { replays: 0, withinDispatch: 0 });
				e.replays++;
				if (l.replay.withinDispatch) e.withinDispatch++;
			}
			continue;
		}
		const same = eldMiles.localDayInTz(l.replay.ms, l.zone) === l.start;
		x.compared++;
		if (same) x.agree++; else x.differ++;
		if (l.replay.withinDispatch) {
			x.bounded.compared++;
			if (same) x.bounded.agree++; else x.bounded.differ++;
		} else if (l.replay.noDispatch) x.noDispatch++;
		else x.outsideBound++;
	}
	s.crossCheck = x;
	return s;
}

// Weekly invoices saved after their week's Friday batch last ran, whose ARRIVAL
// lines no batch names, and arrival lines kept after it (the Friday batch reads a
// week's kept lines only when it runs).
const KEPT_LINES_PREFIX = "arrival_pickup_lines:";
function afterBatch(db, from) {
	try {
		const runs = new Map(db.prepare("SELECT week_end, ran_at FROM invoice_autogen_runs WHERE COALESCE(summary, '') NOT LIKE 'baseline%'").all()
			.map((r) => [r.week_end, Date.parse(r.ran_at)]));
		const out = { invoices: 0, weeks: 0, noBatchRun: 0, keptLines: 0 };
		const weeks = new Set();
		for (const r of db.prepare("SELECT week_end, strftime('%Y-%m-%dT%H:%M:%SZ', created_at) AS created FROM invoices WHERE deleted_at = '' AND is_manual = 0 AND week_end >= ?").all(from)) {
			const ran = runs.get(r.week_end);
			if (!Number.isFinite(ran)) { out.noBatchRun++; continue; }
			if (Date.parse(r.created) > ran) { out.invoices++; weeks.add(r.week_end); }
		}
		out.weeks = weeks.size;
		for (const r of db.prepare("SELECT key, strftime('%Y-%m-%dT%H:%M:%SZ', updated_at) AS saved FROM server_state WHERE substr(key, 1, ?) = ?").all(KEPT_LINES_PREFIX.length, KEPT_LINES_PREFIX)) {
			const weekStart = text(r.key).slice(KEPT_LINES_PREFIX.length, KEPT_LINES_PREFIX.length + 10);
			const ran = arrivalPickup.isCalendarDay(weekStart) ? runs.get(addDay(weekStart, 6)) : NaN;
			if (Number.isFinite(ran) && Date.parse(r.saved) > ran) out.keptLines++;
		}
		return out;
	} catch (err) {
		return { error: text(err && err.message) };
	}
}

// Section 3a: the payout ledger, every scope (computeFleetLedger()), with the
// rule off and on; each changed driver-day, and per scope, driver and month.
async function ledgerSection(api, off, on, from, problems) {
	const fleetOff = await api.computeFleetLedger({ rules: off });
	const fleetOn = await api.computeFleetLedger({ rules: on });
	const fromMonth = from.slice(0, 7);
	const perDay = [];
	const driverMonths = new Map();
	const onByOwner = new Map(fleetOn.scopes.map((s) => [s.ownerId, s]));
	const keyed = (items) => new Map(items.filter((i) => i.kind === "driver_pay").map((i) => [`${i.driver}\t${i.month}\t${i.day || ""}`, i]));
	for (const scope of fleetOff.scopes) {
		const next = onByOwner.get(scope.ownerId) || { items: [], months: [] };
		const a = keyed(scope.items);
		const b = keyed(next.items);
		const note = (was, is) => {
			const it = is || was;
			const daysChange = it.day ? (is ? 1 : 0) - (was ? 1 : 0) : ((is && is.days) || 0) - ((was && was.days) || 0);
			const payChange = ((is && is.cents) || 0) - ((was && was.cents) || 0);
			if (!daysChange && !payChange) return;
			const guard = monthGuard(it.month, api.isLocked, fromMonth);
			if (guard) problems.push({ section: "ledger", ownerId: scope.ownerId, issue: `driver pay in ${it.month} (${guard.closed ? "closed" : "before FROM"}) would change`, ...guard });
			if (it.day && daysChange) perDay.push({ ownerId: scope.ownerId, driver: it.driver, month: it.month, day: it.day, change: is ? "added" : "removed", loadId: (is || was).loadId || "", amount: payChange / 100 });
			const mk = `${scope.ownerId}\t${it.driver}\t${it.month}`;
			const row = driverMonths.get(mk) || { ownerId: scope.ownerId, driver: it.driver, month: it.month, daysAdded: 0, daysRemoved: 0, driverPayChange: 0 };
			if (daysChange > 0) row.daysAdded += daysChange; else row.daysRemoved -= daysChange;
			row.driverPayChange = round2(row.driverPayChange + payChange / 100);
			driverMonths.set(mk, row);
		};
		for (const [k, it] of a) note(it, b.get(k) || null);
		for (const [k, it] of b) if (!a.has(k)) note(null, it);
		const monthsOf = (ms) => new Map(ms.map((m) => [m.month, m]));
		const x = monthsOf(scope.months);
		const y = monthsOf(next.months);
		for (const mk of new Set([...x.keys(), ...y.keys()])) {
			const moved = FIGURES.filter((f) =>Math.round(((x.get(mk) || {})[f] || 0) * 100) !== Math.round(((y.get(mk) || {})[f] || 0) * 100));
			if (!moved.length) continue;
			const guard = monthGuard(mk, api.isLocked, fromMonth);
			if (guard) problems.push({ section: "ledger", ownerId: scope.ownerId, issue: `${mk} (${guard.closed ? "closed" : "before FROM"}) changed: ${moved.join(", ")}`, ...guard });
		}
	}
	perDay.sort((p, q) => p.ownerId - q.ownerId || p.driver.localeCompare(q.driver) || p.day.localeCompare(q.day));
	const company = (fleet) => new Map(((fleet.scopes.find((s) => s.ownerId === 0) || { months: [] }).months).map((m) => [m.month, m]));
	return { perDay, driverMonths: [...driverMonths.values()].sort((p, q) => p.ownerId - q.ownerId || p.driver.localeCompare(q.driver) || p.month.localeCompare(q.month)), companyOff: company(fleetOff), companyOn: company(fleetOn) };
}

// One scope-month's problems ([] when it adds up): driver pay, investor and company
// changes must sum to zero (within ROUNDING_USD), and a split month's investor
// change must be its Split % of the net's change, a lease month's none.
function addUpProblems({ ownerId, month, driverPayChange, investorChange, companyChange, netChange, basis = "split", splitPct = 50 }) {
	const out = [];
	const sum = round2(driverPayChange + investorChange + companyChange);
	if (Math.abs(sum) > ROUNDING_USD) out.push({ section: "money", ownerId, issue: `${month}: driver pay ${usd(driverPayChange)} + investor ${usd(investorChange)} + company ${usd(companyChange)} = ${usd(sum)}, not zero`, addUp: true });
	const expected = basis === "lease" ? 0 : round2((netChange * splitPct) / 100);
	if (ownerId !== 0 && Math.abs(investorChange - expected) > ROUNDING_USD) {
		out.push({ section: "money", ownerId, issue: `${month} (${basis}): the investor's earnings moved ${usd(investorChange)}, not ${usd(expected)}`, addUp: true });
	}
	return out;
}

// Section 3b: each investor's months off and on (computeInvestorMonthlyEarnings()
// and computeLossCarryForward(), as the server settles), the company's share of a
// split month, the company scope, and the add-up per scope and month.
async function investorSection(api, off, on, from, ledger, problems) {
	const fromMonth = from.slice(0, 7);
	const carrierDB = api.getCarrierDBFromSQLite();
	const driverCol = api.findCol(carrierDB.headers, /driver/i) || carrierDB.headers[0];
	const carrierCol = api.findCol(carrierDB.headers, /carrier/i);
	const globalConfig = {};
	api.db.prepare("SELECT key, value FROM investor_config WHERE owner_id = 0").all().forEach((r) => { globalConfig[r.key] = r.value; });
	const months = [];
	const earnings = new Map();
	for (const inv of api.listSettlableInvestors()) {
		const config = { ...globalConfig };
		api.db.prepare("SELECT key, value FROM investor_config WHERE owner_id = ?").all(inv.ownerId).forEach((r) => { config[r.key] = r.value; });
		const splitPct = api.resolveInvestorSplitPct(config);
		const investorDriverSet = api.getInvestorDriverSet(inv.ownerId, carrierDB.data, driverCol, carrierCol);
		const run = async (rules) => {
			const { monthlyEarnings } = await api.computeInvestorMonthlyEarnings({ user: { id: inv.ownerId }, isSuperAdmin: false, investorDriverSet, investorOwnerId: inv.ownerId, config, rules });
			const carry = api.computeLossCarryForward(monthlyEarnings);
			return new Map(monthlyEarnings.map((m) => [m.month, {
				driverPay: m.exact.driverPay, net: m.exact.netProfit, raw: m.investorEarnings, payable: carry[m.month].payable, basis: m.payoutBasis ? "lease" : "split",
			}]));
		};
		const was = await run(off);
		const is = await run(on);
		earnings.set(inv.ownerId, { was, is });
		for (const period of [...new Set([...was.keys(), ...is.keys()])].sort()) {
			const p = was.get(period) || { driverPay: 0, net: 0, raw: 0, payable: 0, basis: "split" };
			const q = is.get(period) || { ...p, driverPay: 0, net: 0, raw: 0, payable: 0 };
			const row = {
				ownerId: inv.ownerId, period, basis: q.basis, splitPct,
				driverPayChange: round2(q.driverPay - p.driverPay),
				rawNow: round2(p.raw), rawOn: round2(q.raw), investorChange: round2(q.raw - p.raw),
				payableNow: round2(p.payable), payableOn: round2(q.payable), payableChange: round2(q.payable - p.payable),
				netChange: round2(q.net - p.net),
			};
			row.companyChange = round2(row.netChange - row.investorChange);
			if (!row.driverPayChange && !row.investorChange && !row.payableChange && !row.netChange) continue;
			const guard = monthGuard(period, api.isLocked, fromMonth);
			if (guard) problems.push({ section: "money", ownerId: inv.ownerId, issue: `${period} (${guard.closed ? "closed" : "before FROM"}) changed its earnings or payable`, ...guard });
			problems.push(...addUpProblems({ ownerId: inv.ownerId, month: period, driverPayChange: row.driverPayChange, investorChange: row.investorChange, companyChange: row.companyChange, netChange: row.netChange, basis: row.basis, splitPct }));
			months.push(row);
		}
	}
	const company = [];
	for (const mk of [...new Set([...ledger.companyOff.keys(), ...ledger.companyOn.keys()])].sort()) {
		const p = ledger.companyOff.get(mk) || { driverPay: 0, netProfit: 0 };
		const q = ledger.companyOn.get(mk) || { driverPay: 0, netProfit: 0 };
		const row = { ownerId: 0, period: mk, driverPayChange: round2(q.driverPay - p.driverPay), companyChange: round2(q.netProfit - p.netProfit) };
		if (!row.driverPayChange && !row.companyChange) continue;
		const guard = monthGuard(mk, api.isLocked, fromMonth);
		if (guard) problems.push({ section: "money", ownerId: 0, issue: `${mk} (${guard.closed ? "closed" : "before FROM"}) changed the company's earnings`, ...guard });
		problems.push(...addUpProblems({ ownerId: 0, month: mk, driverPayChange: row.driverPayChange, investorChange: 0, companyChange: row.companyChange, netChange: row.companyChange }));
		company.push(row);
	}
	return { months, company, earnings };
}

// Whether the investor view's change and the ledger's differ by more than rounding.
function viewMovedApart(ledgerChange, viewChange) {
	return Math.abs(ledgerChange - viewChange) > ROUNDING_USD;
}

// Section 3c: GET /api/investor as each investor, off (`offWorld`) and on
// (`onWorld`, the rule on in its settings): each open month's investor earnings
// must move exactly as the ledger's do.
async function investorViewCheck(offWorld, onWorld, earnings, problems) {
	const out = [];
	const monthsOf = async (world, ownerId) => {
		const r = await world.call("GET /api/investor", { session: { user: { id: ownerId, role: "Investor", username: `investor ${ownerId}` } }, query: {}, params: {}, headers: {} });
		if (r.status !== 200) throw new Error(`GET /api/investor as owner ${ownerId} answered ${r.status}`);
		const seen = new Set();
		const find = (o) => {
			if (!o || typeof o !== "object" || seen.has(o)) return null;
			seen.add(o);
			if (Array.isArray(o.monthlyEarnings)) return o.monthlyEarnings;
			for (const v of Object.values(o)) { const hit = find(v); if (hit) return hit; }
			return null;
		};
		return new Map((find(r.body) || []).map((m) => [m.month, Number(m.investorEarnings) || 0]));
	};
	for (const [ownerId, { was, is }] of earnings) {
		const viewWas = await monthsOf(offWorld, ownerId);
		const viewIs = await monthsOf(onWorld, ownerId);
		for (const mk of [...new Set([...was.keys(), ...is.keys(), ...viewWas.keys(), ...viewIs.keys()])].sort()) {
			if (offWorld.api.isLocked(mk)) continue;
			const ledgerChange = round2(((is.get(mk) || {}).raw || 0) - ((was.get(mk) || {}).raw || 0));
			const viewChange = round2((viewIs.get(mk) || 0) - (viewWas.get(mk) || 0));
			if (!ledgerChange && !viewChange) continue;
			out.push({ ownerId, period: mk, ledgerChange, viewChange });
			if (viewMovedApart(ledgerChange, viewChange)) problems.push({ section: "investor view", ownerId, issue: `${mk}: the investor view moves ${usd(viewChange)}, the ledger ${usd(ledgerChange)}`, view: true });
		}
	}
	return out;
}

// Section 3d: each driver-week that bills an in-scope load, the weekly invoice's
// days and amount with the rule off and on (invoiceWeekPaidDays() and
// invoiceDayPricing(), the code generate runs), and the live invoice if any.
function invoiceSection(api, values, from, inScope, problems) {
	const { headers, data } = api.jobTrackingRowsOf(values);
	const cols = api.invoiceWeekColumns(headers);
	const deletedKeys = api.loadKeySet(api.getDeletedLoadIds());
	const fromMonth = from.slice(0, 7);
	const weeks = new Map();
	for (const row of data) {
		if (api.invoiceWeekVerdict(row, cols, "", "", deletedKeys) !== "other-week") continue;
		const load = inScope.get(loadKey(cols.loadIdCol ? row[cols.loadIdCol] : ""));
		if (!load) continue;
		const display = cols.driverCol ? text(row[cols.driverCol]).trim() : "";
		const nameNorm = api.normalizeDriverName(display);
		if (nameNorm !== load.driver) continue;
		const { weekStart, weekEnd } = api.getWeekRange(api.invoiceCompletionDay(row, cols));
		const key = `${nameNorm}\t${weekStart}`;
		if (!weeks.has(key)) weeks.set(key, { nameNorm, display, weekStart, weekEnd, loadIds: [] });
		const w = weeks.get(key);
		if (!w.loadIds.includes(load.loadId)) w.loadIds.push(load.loadId);
	}
	const payStructs = api.getDriverPayStructures();
	const tripRule = api.tripDayResolver();
	const out = [];
	for (const w of weeks.values()) {
		const week = api.selectInvoiceWeekLoads(data, headers, w.display, w.weekStart, w.weekEnd, deletedKeys);
		const payStruct = payStructs[w.nameNorm] || { payType: "fixed", payPercentage: 0 };
		const weekRule = tripRule && payStruct.payType !== "percentage" ? tripRule : null;
		const extraRuleLoads = weekRule
			? api.invoiceExtraRuleLoads({ data, headers, driverName: w.display, billed: week.loads, weekStart: w.weekStart, weekEnd: w.weekEnd, resolver: weekRule, deletedKeys })
			: [];
		const args = { headers, cols: week.cols, loads: week.loads, extraRuleLoads, weekRule, weekStart: w.weekStart, weekEnd: w.weekEnd, nameNorm: w.nameNorm };
		const now = api.invoiceWeekPaidDays({ ...args, arrivalFrom: null });
		const withRule = api.invoiceWeekPaidDays({ ...args, arrivalFrom: from });
		const truckRate = api.truckDailyRateCandidates(w.display).slice(-1)[0];
		const dailyRate = api.resolveDailyRate(payStruct.payDaily, truckRate, w.weekEnd.slice(0, 7));
		const price = (r) => api.invoiceDayPricing({ dailyRate, nameNorm: w.nameNorm, payDaily: payStruct.payDaily, truckRate, weekRule, dayPayMonth: r.dayPayMonth }).totalOf(r.activeDaySet);
		const daysNow = [...now.activeDaySet].sort();
		const daysOn = [...withRule.activeDaySet].sort();
		const addedDays = daysOn.filter((d) => !now.activeDaySet.has(d));
		const removedDays = daysNow.filter((d) => !withRule.activeDaySet.has(d));
		for (const d of [...addedDays, ...removedDays]) {
			const guard = monthGuard(d.slice(0, 7), api.isLocked, fromMonth);
			if (guard) problems.push({ section: "invoice", issue: `${d} (${guard.closed ? "closed month" : "before FROM"}) would change on a weekly invoice`, ...guard });
		}
		const amountNow = price(now);
		const amountOn = price(withRule);
		const live = api.liveWeeklyInvoicesForDriverWeek(w.display, w.weekStart);
		const inv = live.length === 1 ? live[0] : null;
		const notes = withRule.arrival || { errors: [], fallbacks: [], extended: [] };
		const afterSwitchOn = !addedDays.length && !removedDays.length ? "nothing changes"
			: live.length > 1 ? `${live.length} live invoices for this week: a person decides`
				: !inv ? "no invoice yet: the week's invoice pays these days when it is generated"
					: inv.status === "Draft" ? "Draft: regenerating it pays these days"
						: `issued (${inv.status}): never regenerated; a wrong paid day is corrected with Driver Pay Overrides`;
		out.push({
			driver: w.nameNorm, weekStart: w.weekStart, weekEnd: w.weekEnd, loadIds: w.loadIds.sort(),
			daysNow, daysOn, addedDays, removedDays, amountNow, amountOn, delta: round2(amountOn - amountNow),
			lines: { notRead: notes.errors.length, notApplied: notes.fallbacks.length, extended: notes.extended.length },
			invoice: inv ? { invoiceNumber: inv.invoice_number, status: inv.status, totalEarnings: Number(inv.total_earnings) || 0, paidDays: api.invoicePaidDaysOf(inv) } : null,
			afterSwitchOn,
		});
	}
	out.sort((p, q) => p.driver.localeCompare(q.driver) || p.weekStart.localeCompare(q.weekStart));
	return out;
}

// The invoice and the ledger, per driver and in all: the weekly invoice pays only
// the window days inside the completion week, the ledger every window day.
function sideBySide(weeks, driverMonths) {
	const by = new Map();
	const row = (d) => by.get(d) || by.set(d, { driver: d, invoiceDays: 0, invoiceChange: 0, ledgerDays: 0, ledgerChange: 0 }).get(d);
	for (const w of weeks) {
		const r = row(w.driver);
		r.invoiceDays += w.addedDays.length - w.removedDays.length;
		r.invoiceChange = round2(r.invoiceChange + w.delta);
	}
	for (const m of driverMonths) {
		const r = row(m.driver);
		r.ledgerDays += m.daysAdded - m.daysRemoved;
		r.ledgerChange = round2(r.ledgerChange + m.driverPayChange);
	}
	const drivers = [...by.values()].sort((p, q) => p.driver.localeCompare(q.driver));
	const total = drivers.reduce((t, r) => ({
		invoiceDays: t.invoiceDays + r.invoiceDays, invoiceChange: round2(t.invoiceChange + r.invoiceChange),
		ledgerDays: t.ledgerDays + r.ledgerDays, ledgerChange: round2(t.ledgerChange + r.ledgerChange),
	}), { invoiceDays: 0, invoiceChange: 0, ledgerDays: 0, ledgerChange: 0 });
	return { drivers, total };
}

// The S3 stop points, each with its measure and threshold.
function s3Checks(summary, health) {
	const officialCount = summary.official.geofence + summary.official.driver;
	const rejected = summary.none.far_tap + summary.none.batch_tap;
	const driverSourced = summary.official.driver + rejected;
	const noArrival = summary.none.staff_only + summary.none.far_tap + summary.none.hauling_other_load;
	const row = (name, n, d, limit) => ({ name, count: n, of: d, share: d ? n / d : 0, limit, stop: !!d && n / d > limit });
	return [
		row("official pickup 2+ days before the scheduled one, of loads with an official pickup", summary.earlyBy2.length, officialCount, S3.earlyShare),
		row("rejected driver taps (far + batch), of driver-sourced arrivals", rejected, driverSourced, S3.rejectedTapShare),
		row("staff-only, far-tap and hauling-another-load loads, of in-scope loads", noArrival, summary.inScope, S3.noArrivalShare),
		row("driver taps with no fix within 5 minutes, of driver taps", health.driverTapsNoFix, health.driverTaps, S3.tapNoFixShare),
		{ name: "no-ELD loads that D11b (a) extends by 2+ days (a handful is the limit: the lead judges)", count: summary.noEldExtended2.length, of: null, share: null, limit: null, stop: null },
	];
}

// Drivers as numbered labels ("driver 1", … in name order), and Load IDs and
// invoice numbers kept only with --ids.
function present(result, ids) {
	const names = new Set();
	const seen = (d) => { if (d) names.add(d); };
	result.money.ledger.perDay.forEach((d) => seen(d.driver));
	result.money.ledger.driverMonths.forEach((d) => seen(d.driver));
	result.money.invoiceWeeks.forEach((w) => seen(w.driver));
	result.money.sideBySide.drivers.forEach((d) => seen(d.driver));
	const labels = new Map([...names].sort().map((n, i) => [n, `driver ${i + 1}`]));
	const label = (d) => labels.get(d) || "driver";
	const idList = (list) => (ids ? list.map((l) => l.loadId).sort() : undefined);
	const L = result.loads;
	result.loads = {
		...L,
		earlyBy2: { count: L.earlyBy2.length, loadIds: idList(L.earlyBy2) },
		arrivalAfterDropoff: { count: L.arrivalAfterDropoff.length, loadIds: idList(L.arrivalAfterDropoff) },
		noEldExtended2: { count: L.noEldExtended2.length, loadIds: idList(L.noEldExtended2) },
		fromAnotherDriver: { count: L.fromAnotherDriver.length, loadIds: idList(L.fromAnotherDriver) },
		firstRowGeofence: { count: L.firstRowGeofence.length, dayMoved: L.firstRowDayMoved, loadIds: idList(L.firstRowGeofence) },
		notReadLoads: ids ? L.notReadLoads.map((l) => ({ loadId: l.loadId, error: l.error })) : undefined,
		noDeliveryLoads: idList(L.noDeliveryLoads),
	};
	delete result.loads.firstRowDayMoved;
	const m = result.money;
	m.ledger.perDay = m.ledger.perDay.map((d) => ({ ...d, driver: label(d.driver), loadId: ids ? d.loadId : undefined }));
	m.ledger.driverMonths = m.ledger.driverMonths.map((d) => ({ ...d, driver: label(d.driver) }));
	m.invoiceWeeks = m.invoiceWeeks.map((w) => ({
		...w, driver: label(w.driver), loadIds: ids ? w.loadIds : undefined, loads: w.loadIds.length,
		invoice: w.invoice ? { ...w.invoice, invoiceNumber: ids ? w.invoice.invoiceNumber : undefined } : null,
	}));
	m.sideBySide.drivers = m.sideBySide.drivers.map((d) => ({ ...d, driver: label(d.driver) }));
}

function printText(r) {
	const lines = [];
	const counts = (o) => (Object.keys(o).length ? Object.entries(o).sort().map(([k, v]) => `${k} ${v}`).join(", ") : "none");
	const ids = (x) => (x && x.loadIds ? ` [${x.loadIds.join(", ")}]` : "");
	lines.push(`Arrival pickup date report, candidate ARRIVAL_PICKUP_DATE_FROM=${r.from} (latest closed month: ${r.latestClosedMonth || "none"}). Nothing was written.`);
	lines.push(`Baseline: ${r.baseline}`);
	const h = r.recorder;
	lines.push("", `1. RECORDER HEALTH (status rows written since ${h.since}, UTC)`);
	if (!h.readable) lines.push(`The status history's recorder columns could not be read (${h.error}): every in-scope load is listed under "arrival not read".`);
	else {
		lines.push(`Rows: ${h.rows} (recorder rows ${h.recorderRows}, rows with no role ${h.rowsWithoutRole}).`);
		lines.push(`At Shipper rows by source / role: ${counts(h.atShipper)}.`);
		lines.push(`Taps (inside / outside / unknown): driver ${h.taps.driver.inside} / ${h.taps.driver.outside} / ${h.taps.driver.unknown}; staff ${h.taps.staff.inside} / ${h.taps.staff.outside} / ${h.taps.staff.unknown}.`);
		lines.push(`Driver taps: ${h.driverTaps}; with no fix within 5 minutes ${h.driverTapsNoFix}; fix age: ${counts(h.tapFixAge)}.`);
		lines.push(`Batch taps (a driver tap, position unknown, At Receiver or Delivered within 15 minutes): ${h.batchTaps}; any manual At Shipper followed within 15 minutes: ${h.manualFollowedWithin15}.`);
		const g = h.geofence;
		lines.push(`Geofence At Shipper rows: ${g.rows}; by other_load_hauling and the driver's most under-way other load: ${Object.keys(g.byHauling).sort().map((k) => `${k}: ${counts(g.byHauling[k])}`).join("; ") || "none"}.`);
		lines.push(`Geofence ping-to-row lag: ${counts(g.lag)}; no fix ${g.noFix}; fix after the row ${g.fixAfterRow}; fix before the load's dispatch ${g.beforeDispatch}.`);
		lines.push(`Geofence arrivals that are the load's first history row: ${g.firstRow.rows} (lag: ${counts(g.firstRow.lag)}).`);
		lines.push(`Stored zones: ${counts(h.zones)}; zone from the app's fallback (no mapped point now, no position on the row) ${h.zoneFromAppFallback}; the shipper's day is not the app's day on ${h.shipperDayNotAppDay}.`);
	}
	const L = r.loads;
	lines.push("", "2. IN-SCOPE LOADS (completed, daily-rate driver, Assigned Date on or after FROM)");
	lines.push(`In scope: ${L.inScope}. Not in scope: no Assigned Date ${r.excluded.noAssignedDate}, percentage drivers ${r.excluded.percentage}.`);
	lines.push(`Official pickup: geofence ${L.official.geofence}, driver ${L.official.driver}. None: ${counts(L.none)}.`);
	lines.push(`Arrival but no Delivered row (paid the scheduled window, named ARRIVAL RULE NOT APPLIED): ${counts(L.noDelivery)}${L.noDeliveryLoads ? ` [${L.noDeliveryLoads.join(", ")}]` : ""}.`);
	lines.push(`Arrival not read (status history unreadable; each paid its scheduled window): ${L.notRead}${L.notReadLoads ? ` [${L.notReadLoads.map((e) => `${e.loadId} (${e.error})`).join(", ")}]` : ""}.`);
	lines.push(`Official minus scheduled pickup, in days: ${counts(L.officialMinusScheduled)}; no scheduled pickup ${L.noScheduledPickup}.`);
	lines.push(`Official pickup 2+ days before the scheduled one (S3): ${L.earlyBy2.count}${ids(L.earlyBy2)}.`);
	lines.push(`Arrival after the scheduled drop-off: ${L.arrivalAfterDropoff.count}${ids(L.arrivalAfterDropoff)}.`);
	const c = L.completedAfterDropoff;
	for (const [k, label] of [["noEld", "no ELD"], ["eld", "ELD-covered"]]) {
		lines.push(`Delivered after the scheduled drop-off, ${label}: ${c[k].loads} load(s); driver-days D11b (a) ${c[k].a.window} (paid ${c[k].a.paid}), (b) ${c[k].b.window} (paid ${c[k].b.paid}).`);
	}
	lines.push(`No-ELD loads D11b (a) extends by 2+ days: ${L.noEldExtended2.count}${ids(L.noEldExtended2)}.`);
	lines.push(`Blank Drop-off with an official pickup (no extension line names these): ${L.blankDropoff.loads} (window days: ${counts(L.blankDropoff.days)}).`);
	lines.push(`Arrival written for another driver (reassigned after it; the rule keeps it): ${L.fromAnotherDriver.count}${ids(L.fromAnotherDriver)}.`);
	lines.push(`First-row geofence arrivals (no lower bound on the moment): ${L.firstRowGeofence.count}, official day not the row's own day ${L.firstRowGeofence.dayMoved}${ids(L.firstRowGeofence)}.`);
	lines.push(`Delivery day in the receiver's zone differs from the shipper's: ${L.receiverDayDiffers}; no mapped drop-off point ${L.noReceiverPoint}.`);
	const b = L.afterBatch;
	lines.push(b.error ? `Invoices saved after their week's batch: not read (${b.error}).`
		: `Weekly invoices (weeks ending on or after FROM) saved after their week's batch ran, so no batch names their ARRIVAL lines: ${b.invoices} in ${b.weeks} week(s); no batch run for their week ${b.noBatchRun}; arrival lines kept after their week's batch ${b.keptLines}.`);
	const m = r.money;
	lines.push("", "3. MONEY (rule off -> on)");
	lines.push("Payout ledger, by scope, driver and month:");
	for (const d of m.ledger.driverMonths) lines.push(`  owner ${d.ownerId}  ${d.driver}  ${d.month}  +${d.daysAdded} / -${d.daysRemoved} day(s)  ${usd(d.driverPayChange)}`);
	if (!m.ledger.driverMonths.length) lines.push("  no change");
	for (const basis of ["split", "lease"]) {
		const list = m.investors.filter((i) => i.basis === basis);
		lines.push(`Investor ${basis} months (raw earnings and payable, the carry-forward included; the company's share):`);
		for (const i of list) lines.push(`  owner ${i.ownerId}  ${i.period}  driver pay ${usd(i.driverPayChange)}  raw ${usd(i.rawNow)} -> ${usd(i.rawOn)}  payable ${usd(i.payableNow)} -> ${usd(i.payableOn)}  company ${usd(i.companyChange)}`);
		if (!list.length) lines.push("  none");
	}
	lines.push("Company scope (owner 0):");
	for (const x of m.company) lines.push(`  ${x.period}  driver pay ${usd(x.driverPayChange)}  company ${usd(x.companyChange)}`);
	if (!m.company.length) lines.push("  no change");
	lines.push(`Driver pay + investor + company add up to zero in every scope and month: ${r.checks.addsUp ? "yes" : "NO"}.`);
	lines.push(`Investor view (GET /api/investor) moves as the ledger: ${r.checks.viewMatchesLedger ? "yes" : "NO"} (${m.investorView.length} open investor-month(s) compared).`);
	lines.push("Weekly invoices (driver, week, loads, days now -> on, $ now -> on, ARRIVAL lines, invoice, once on):");
	for (const w of m.invoiceWeeks) {
		lines.push(`  ${w.driver}  ${w.weekStart}..${w.weekEnd}  ${w.loadIds ? w.loadIds.join(", ") : `${w.loads} load(s)`}  ${w.daysNow.length} -> ${w.daysOn.length} (+[${w.addedDays.join(", ")}] -[${w.removedDays.join(", ")}])  ${usd(w.amountNow)} -> ${usd(w.amountOn)}  lines ${w.lines.notRead}/${w.lines.notApplied}/${w.lines.extended}  ${w.invoice ? `${w.invoice.invoiceNumber ? `${w.invoice.invoiceNumber} ` : ""}${w.invoice.status} paid ${w.invoice.paidDays ? w.invoice.paidDays.length : "?"} day(s) ${usd(w.invoice.totalEarnings)}` : "(no invoice)"}  ${w.afterSwitchOn}`);
	}
	if (!m.invoiceWeeks.length) lines.push("  none");
	lines.push("Invoice and ledger side by side (days, $):");
	for (const d of m.sideBySide.drivers) lines.push(`  ${d.driver}  invoice ${d.invoiceDays} ${usd(d.invoiceChange)}  ledger ${d.ledgerDays} ${usd(d.ledgerChange)}`);
	const t = m.sideBySide.total;
	lines.push(`  all  invoice ${t.invoiceDays} ${usd(t.invoiceChange)}  ledger ${t.ledgerDays} ${usd(t.ledgerChange)}`);
	lines.push("", "4. CHECKS");
	lines.push(`Closed months (${r.closedMonths.join(", ") || "none"}) unchanged: ${r.checks.closedMonthsUnchanged ? "yes" : "NO"}. Months before FROM unchanged: ${r.checks.monthsBeforeFromUnchanged ? "yes" : "NO"}.`);
	lines.push(`Trip work-day rule: ${r.checks.tripRule}`);
	for (const s of r.s3) {
		lines.push(s.of === null ? `S3: ${s.name}: ${s.count}.` : `S3: ${s.name}: ${s.count} of ${s.of} (${pct(s.count, s.of)}; limit ${(s.limit * 100).toFixed(0)}%): ${s.stop ? "STOP" : "within"}.`);
	}
	const x = r.crossCheck;
	lines.push("", "5. CROSS-CHECK against the replayed pickup arrival (load_eld_miles.pickup_arrive_ms)");
	lines.push(`Compared ${x.compared}: same day ${x.agree}, another day ${x.differ}. Within the dispatch bound ${x.bounded.compared}: same day ${x.bounded.agree}, another day ${x.bounded.differ}; before the dispatch ${x.outsideBound}; no dispatch row ${x.noDispatch}.`);
	lines.push(`Loads with no official pickup that have a replay: ${Object.keys(x.noArrivalWithReplay).sort().map((k) => `${k} ${x.noArrivalWithReplay[k].replays} (within the dispatch bound ${x.noArrivalWithReplay[k].withinDispatch})`).join(", ") || "none"}.`);
	for (const p of r.problems) lines.push(`PROBLEM (${p.section}${p.ownerId !== undefined ? `, owner ${p.ownerId}` : ""}): ${p.issue}`);
	console.log(lines.join("\n"));
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const from = typeof args.from === "string" ? args.from.trim() : "";
	if (!from) refuse("--from=YYYY-MM-DD is required: the ARRIVAL_PICKUP_DATE_FROM to try (the recorder's switch-on date)");
	if (!arrivalPickup.isCalendarDay(from)) refuse("--from must be a calendar date (YYYY-MM-DD)");
	if (!args.db || args.db === true) refuse("--db is required");
	const envFile = typeof args["env-file"] === "string" ? args["env-file"] : null;
	let dbFile;
	let env;
	try {
		({ file: dbFile, env } = envFor({ root: ROOT, dbPath: args.db, envFile }));
	} catch (err) {
		refuse(err.message);
	}
	// "Today" must be the rule off, so the comparison is today against the rule.
	if (arrivalPickup.ruleFromEnv(env)) refuse("ARRIVAL_PICKUP_DATE is already on in the app's .env, so today already includes it");
	const appZone = appTime.resolveAppTimeZone(env.APP_TIMEZONE, () => {});
	const today = appTime.dayInZone(Date.now(), appZone);
	if (from > today) refuse(`--from=${from} is in the future (today is ${today}): the report measures what the recorder has written`);
	const latestClosed = latestClosedOf(dbFile);
	if (latestClosed && from.slice(0, 7) <= latestClosed) {
		refuse(`--from=${from} is in or before ${latestClosed}, the latest closed month. The rule may only start in an open month: closed months are final as recorded.`);
	}
	let sheetData;
	try {
		sheetData = await sheetFor(args, ROOT);
	} catch (err) {
		refuse(err.message);
	}
	const world = buildLedgerWorld({ root: ROOT, dbPath: args.db, readonly: true, sheetData, envFile, extraRoots: EXTRA_ROOTS, extraRoutes: ["/api/investor"] });
	try {
		// The rule on in the second world's settings only, for GET /api/investor,
		// which reads them per request; both worlds read one database handle.
		const onWorld = buildLedgerWorld({
			root: ROOT, dbPath: args.db, readonly: true, sheetData, envFile, extraRoots: EXTRA_ROOTS, extraRoutes: ["/api/investor"], db: world.db,
			envOverrides: { ARRIVAL_PICKUP_DATE_ENABLED: "true", ARRIVAL_PICKUP_DATE_FROM: from },
		});
		const api = { ...world.api, db: world.db };
		const ids = args.ids === true;
		const problems = [];
		// One resolver for every "on" reading of the ledger and the loads, so each
		// load is decided once.
		const resolver = arrivalPickup.createArrivalResolver({ db: world.db, fromDay: from });
		const history = readHistory(world.db);
		const points = readPoints(world.db);
		const jt = await api.getJobTrackingCached();
		const cols = api.invoiceWeekColumns(jt.headers);
		const driverOf = new Map();
		const loadsOf = new Map();
		for (const row of jt.data) {
			const key = loadKey(cols.loadIdCol ? row[cols.loadIdCol] : "");
			const d = api.normalizeDriverName(cols.driverCol ? text(row[cols.driverCol]).trim() : "");
			if (!key || !d) continue;
			driverOf.set(key, d);
			if (!loadsOf.has(d)) loadsOf.set(d, []);
			if (!loadsOf.get(d).includes(key)) loadsOf.get(d).push(key);
		}
		const unitToVid = {};
		world.db.prepare("SELECT LOWER(unit_number) AS u, routemate_vehicle_id AS vid FROM trucks WHERE COALESCE(routemate_vehicle_id, '') != ''").all().forEach((t) => { unitToVid[t.u] = t.vid; });
		// The ELD's travel days from the day before FROM, as the pay paths band them.
		const eldByVid = api.getEldTravelDaysByVehicle(Object.values(unitToVid), Date.parse(`${addDay(from, -1)}T00:00:00Z`), Date.now() + 24 * HOUR);
		const replays = new Map();
		try {
			for (const r of world.db.prepare("SELECT load_id, pickup_arrive_ms FROM load_eld_miles WHERE pickup_arrive_ms > 0").all()) replays.set(loadKey(r.load_id), Number(r.pickup_arrive_ms));
		} catch { /* no table: nothing to cross-check */ }

		const sinceMs = Date.parse(`${from}T00:00:00Z`);
		const recorder = recorderHealth({ history, sinceMs, appZone, driverOf, loadsOf, points });
		const { loads, excluded } = inScopeLoads({ api, jt, from, resolver, history, points, eldByVid, unitToVid, replays });
		const summary = summarizeLoads(loads);
		const base = api.payoutRules();
		const off = { ...base, arrivalRule: null };
		const on = { ...base, arrivalRule: resolver };
		const ledger = await ledgerSection(api, off, on, from, problems);
		const inv = await investorSection(api, off, on, from, ledger, problems);
		const investorView = await investorViewCheck(world, onWorld, inv.earnings, problems);
		const inScope = new Map(loads.filter((l) => l.key).map((l) => [l.key, l]));
		const invoiceWeeks = invoiceSection(api, sheetData.values || [], from, inScope, problems);
		const tripFrom = tripWorkDays.ruleFromEnv(env);
		const { crossCheck, ...loadSummary } = summary;
		const result = {
			from,
			latestClosedMonth: latestClosed,
			closedMonths: world.db.prepare("SELECT period FROM period_locks WHERE status = 'locked' ORDER BY period").all().map((r) => r.period),
			baseline: "the arrival pickup date off; every other setting as the app's .env has it",
			recorder,
			excluded,
			loads: { ...loadSummary, afterBatch: afterBatch(world.db, from) },
			money: { ledger: { perDay: ledger.perDay, driverMonths: ledger.driverMonths }, investors: inv.months, company: inv.company, investorView, invoiceWeeks, sideBySide: sideBySide(invoiceWeeks, ledger.driverMonths) },
			crossCheck,
			s3: s3Checks(summary, recorder),
			checks: {
				tripRule: tripFrom
					? `on from ${tripFrom} in the app's .env: a load it pays is paid ahead of the arrival rule (lib/financials-calc.js), so its days are the trip rule's on both runs`
					: "off in the app's .env: no load is paid by it",
			},
		};
		present(result, ids);
		result.checks.closedMonthsUnchanged = !problems.some((p) => p.closed);
		result.checks.monthsBeforeFromUnchanged = !problems.some((p) => p.beforeFrom);
		result.checks.addsUp = !problems.some((p) => p.addUp);
		result.checks.viewMatchesLedger = !problems.some((p) => p.view);
		result.problems = problems;
		result.generatedAt = new Date().toISOString();
		if (args.json === true) console.log(JSON.stringify(result, null, 1));
		else printText(result);
		if (problems.length) process.exitCode = 1;
	} finally {
		world.db.close();
	}
}

module.exports = { addUpProblems, s3Checks, monthGuard, viewMovedApart, S3, ROUNDING_USD };

if (require.main === module) main().catch((err) => { console.error(`ERROR: ${err.stack || err.message}`); process.exit(1); });
