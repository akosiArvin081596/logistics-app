"use strict";
// `_pickupArrival`: the facts behind the load detail's read-only pickup line, decided here so the
// browser only words them (client/src/lib/pickupArrival.js). Only while the arrival pickup date rule
// is on (lib/arrival-pickup.js ruleFromEnv()); off, no row gets the key. No Load ID, distance or name.

const arrivalPickup = require("./arrival-pickup");
const appTime = require("./app-time");

const SOURCES = Object.freeze({ geofence: "gps", driver: "driver" });
const MONTH_RE = /^\d{4}-\d{2}$/;

const clockFormatters = new Map();
// Some ICU versions put a narrow no-break space before AM/PM; the line reads the
// same with a plain one. The arrival is read on the business clock in force at it.
function clockOf(ms, businessZone) {
	const at = new Date(ms);
	const zone = businessZone && appTime.businessZoneAt(at, businessZone);
	let f = clockFormatters.get(zone);
	if (!f) {
		f = new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "short" });
		clockFormatters.set(zone, f);
	}
	return { atDay: appTime.dayInZone(at, zone), atTime: f.format(at).replace(/[  ]/g, " ") };
}

// { scheduled } always; { day, at, source, atDay, atTime } too only when the rule pays the
// load from its arrival (a window start): day is the shipper-local day pay starts, at the
// instant, atDay and atTime that instant on the business clock (`zone`), labelled.
function fieldFor(answer, scheduled, zone) {
	const field = { scheduled: arrivalPickup.isCalendarDay(scheduled) ? scheduled : "" };
	const start = answer && arrivalPickup.isCalendarDay(answer.start) ? answer.start : "";
	const arrival = start ? answer.arrival : null;
	const source = arrival && Object.prototype.hasOwnProperty.call(SOURCES, arrival.source) ? SOURCES[arrival.source] : "";
	if (!source || !Number.isFinite(arrival.ms)) return field;
	return { ...field, day: start, at: new Date(arrival.ms).toISOString(), source, ...clockOf(arrival.ms, zone) };
}

// Sets the field on every row while the rule is on; returns how many show an arrival. In scope
// as the pay paths read a load (completed, not a percentage driver, Assigned on or after FROM);
// a month the trip work-day rule covers pays trip days, which can start before the arrival.
function annotateRows({ db, env, rows, read, payTypes, tripFrom = null, zone, log = null }) {
	const fromDay = arrivalPickup.ruleFromEnv(env);
	if (!fromDay || !Array.isArray(rows) || !rows.length) return 0;
	try {
		const resolver = arrivalPickup.createArrivalResolver({ db, fromDay, log });
		const structures = payTypes() || {};
		let shown = 0;
		for (const row of rows) {
			if (!row || typeof row !== "object") continue;
			let answer = null;
			if (read.completed(row)) {
				const key = read.driverKey(row);
				const own = key && Object.prototype.hasOwnProperty.call(structures, key) ? structures[key] : null;
				const assigned = read.assigned(row);
				const month = arrivalPickup.dayKeyOf(assigned).slice(0, 7);
				const tripPays = MONTH_RE.test(String(tripFrom || "")) && MONTH_RE.test(month) && month >= tripFrom;
				if ((!own || own.payType !== "percentage") && !tripPays) answer = resolver.forLoad({ loadId: read.loadId(row), assigned, completed: true });
			}
			row._pickupArrival = fieldFor(answer, read.scheduled(row), zone);
			if (row._pickupArrival.day) shown++;
		}
		return shown;
	} catch (err) {
		// A half-built answer would show some loads' lines and not others: none instead.
		for (const row of rows) if (row && typeof row === "object") delete row._pickupArrival;
		if (typeof log === "function") log(`the pickup arrival line was not built (${err && err.message}); no load shows it`);
		return 0;
	}
}

module.exports = { SOURCES, fieldFor, annotateRows };
