"use strict";
// Driver safety for voice notes (49 CFR 392.82: no hand-held phone use while
// driving, which includes sitting at a light or in traffic). Pure: ELD fixes and
// a clock in, a decision out.
//
// A fix is the truck's latest clean ELD position: { speed (m/s), location_date_ms }.
//   unknown  no fix, a fix older than FRESH_MS (engine off, dead zone), a fix
//            stamped more than FUTURE_SKEW_MS in the future (a skewed clock can
//            neither block nor unblock), or no readable speed
//   moving   a fresh fix above MOVING_MPS (5 mph, the pay rule's threshold)
//   stopped  a fresh fix at or below it
//
// The server refuses a Driver's upload only while MOVING (409
// VOICE_NOTE_WHILE_MOVING, movingRefusal()). The driver app (PR 2) also waits
// until the truck has been stopped STOPPED_MIN_MS (lights, traffic), from
// GET /api/driver/position's stoppedSinceMs (stoppedSinceMs() below), and allows
// an unknown state with the "record only when parked" note: most real use is
// parked with the engine off, where the fix is stale.

const MOVING_MPS = 2.235;
const FRESH_MS = 3 * 60 * 1000;
const FUTURE_SKEW_MS = 2 * 60 * 1000;
const STOPPED_MIN_MS = 2 * 60 * 1000;

const isMoving = (fix) => !!fix && Number.isFinite(fix.speed) && fix.speed > MOVING_MPS;

function fixState(fix, nowMs) {
	if (!fix || !Number.isFinite(fix.location_date_ms) || !Number.isFinite(nowMs)) return "unknown";
	const age = nowMs - fix.location_date_ms;
	if (!(age >= -FUTURE_SKEW_MS) || !(age <= FRESH_MS)) return "unknown";
	if (!Number.isFinite(fix.speed)) return "unknown";
	return isMoving(fix) ? "moving" : "stopped";
}

// The earliest time the truck is known to have been stopped since, from its
// recent fixes, NEWEST FIRST: the time of the last fix above the threshold, or,
// when none of them moved, the oldest fix's time (stopped at least since then).
// Null when the latest fix is moving or there is none.
function stoppedSinceMs(fixesNewestFirst) {
	const fixes = Array.isArray(fixesNewestFirst) ? fixesNewestFirst.filter((f) => f && Number.isFinite(f.location_date_ms)) : [];
	if (!fixes.length || isMoving(fixes[0])) return null;
	const lastMoving = fixes.find(isMoving);
	return lastMoving ? lastMoving.location_date_ms : fixes[fixes.length - 1].location_date_ms;
}

// The server's backstop: refuse only a fresh moving fix.
const movingRefusal = (fix, nowMs) => fixState(fix, nowMs) === "moving";

// The driver app's record button: { allowed, state } with state "moving",
// "stopping" (stopped under STOPPED_MIN_MS, or stopped with no known start),
// "parked" or "unknown". Unknown is allowed (with the note).
function recordGate({ fix, stoppedSince, nowMs }) {
	const state = fixState(fix, nowMs);
	if (state === "unknown") return { allowed: true, state };
	if (state === "moving") return { allowed: false, state };
	const stoppedFor = Number.isFinite(stoppedSince) ? nowMs - stoppedSince : NaN;
	if (!(stoppedFor >= STOPPED_MIN_MS)) return { allowed: false, state: "stopping" };
	return { allowed: true, state: "parked" };
}

module.exports = { MOVING_MPS, FRESH_MS, FUTURE_SKEW_MS, STOPPED_MIN_MS, fixState, stoppedSinceMs, movingRefusal, recordGate };
