"use strict";

// The rows deduplicateLoads() drops, kept beside the Job Tracking read they came from: the weekly
// invoice reads every row, and a count that must agree with it needs them too. Beside it, in a
// WeakMap, so the read every caller shares is never written and no other caller can see them.

const EVERY_ROW = new WeakMap();

function keepEveryRow(read, rows) {
	EVERY_ROW.set(read, rows);
}

// A read that kept none (a script's own) answers the rows it has.
function everyJobTrackingRow(jt) {
	return (jt && (EVERY_ROW.get(jt) || jt.data)) || [];
}

module.exports = { keepEveryRow, everyJobTrackingRow };
