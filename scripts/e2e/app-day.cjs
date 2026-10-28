// The business day the harness plants by: APP_TIMEZONE's (lib/app-time.js; US
// Eastern unless set, the zone boot-server.sh boots every server in), never the
// runner's clock zone or UTC. The made-up seed's truck assignment and B1's expense
// both take their day from here, so they name the same day at any hour.
//
//   appDayKey([instant])    the business day of an instant (default now), YYYY-MM-DD
//   appDayStartIso(dayKey)  the first instant of that business day, as the ISO
//                           string truck_assignments stores
//
// Requiring it has no effect: lib/app-time.js is pure.
"use strict";
const { appDay, appTimeZone, wallClockToMs } = require("../../lib/app-time.js");

function appDayKey(instant = new Date()) {
	return appDay(instant);
}

// The startup backfill and plant-before-boot.cjs read an assignment's first ten
// characters as its day. For this instant they are the business day itself in a
// zone behind UTC and the day before in one ahead of it: never a later day.
function appDayStartIso(dayKey) {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dayKey));
	if (!m) throw new Error(`not a YYYY-MM-DD day: ${JSON.stringify(dayKey)}`);
	return new Date(wallClockToMs(appTimeZone(), +m[1], +m[2], +m[3], 0, 0, 0)).toISOString();
}

module.exports = { appDayKey, appDayStartIso };
