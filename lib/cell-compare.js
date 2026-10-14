// One reading of a sheet cell's amount and moment, shared by the re-issued
// rate-con hold (server.js, reissueSameValue()) and the daily integrity check's
// check 5 (lib/integrity-check.js), so the two never disagree about whether a
// Payment or an appointment really changed.
//
// Pure: no network, DB or fs. Every pattern is bounded and every input is capped
// (the text comes from the sheet and from rate-con emails).
"use strict";

const MAX_CELL = 40;

// A dollar amount in whole cents, or null when the cell is not one amount.
// " $ 1,234.56 ", "$1,234.56" and "1234.56" are one amount; "1234.560" too (digits
// past the cents must be zeros: "1234.565" is null, never rounded). Negative:
// "-$100.00", "$-100.00" and the accounting "($100.00)".
function moneyCents(v) {
	let s = String(v == null ? "" : v).trim();
	if (!s || s.length > MAX_CELL) return null;
	const paren = /^\((.{1,38})\)$/.exec(s);
	if (paren) s = paren[1];
	s = s.replace(/[\s$,]/g, "");
	const m = /^(-?)(\d{1,9})(?:\.(\d{0,2})0{0,8})?$/.exec(s);
	if (!m || (paren && m[1])) return null;
	const cents = Number(m[2]) * 100 + Number((m[3] || "").padEnd(2, "0"));
	if (cents === 0) return 0;
	return paren || m[1] ? -cents : cents;
}

function pad(n) { return String(n).padStart(2, "0"); }

// A sheet date or date-time as one wall-clock moment ("2026-10-09 00:00:00"), or
// null when the text is not one. US "10/9/2026", "10/9/2026 0:00",
// "10/9/2026, 3:56:51 PM"; ISO "2026-10-09", "2026-10-09 08:00",
// "2026-10-09T08:00:00". A date alone is that day at 0:00. A zone or an offset
// ("Z", "+02:00") makes an instant, not a wall-clock time, so it is null.
function momentKey(v) {
	const s = String(v == null ? "" : v).trim();
	if (!s || s.length > MAX_CELL) return null;
	let y;
	let mo;
	let d;
	let rest;
	let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:(?:T|,?\s{1,3})(.{1,30}))?$/.exec(s);
	if (m) {
		[y, mo, d, rest] = [Number(m[1]), Number(m[2]), Number(m[3]), m[4]];
	} else if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:,?\s{1,3}(.{1,30}))?$/.exec(s))) {
		[y, mo, d, rest] = [Number(m[3]), Number(m[1]), Number(m[2]), m[4]];
	} else {
		return null;
	}
	let h = 0;
	let mi = 0;
	let sec = 0;
	if (rest !== undefined) {
		const t = /^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s{0,3}([AaPp][Mm]))?$/.exec(rest);
		if (!t) return null;
		h = Number(t[1]);
		mi = Number(t[2]);
		sec = t[3] === undefined ? 0 : Number(t[3]);
		if (t[4]) {
			if (h < 1 || h > 12) return null;
			h = (h % 12) + (/^p/i.test(t[4]) ? 12 : 0);
		}
	}
	const days = new Date(Date.UTC(y, mo, 0)).getUTCDate();
	if (mo < 1 || mo > 12 || d < 1 || d > days || h > 23 || mi > 59 || sec > 59) return null;
	return `${y}-${pad(mo)}-${pad(d)} ${pad(h)}:${pad(mi)}:${pad(sec)}`;
}

// Whether two cells name the same wall-clock moment (false when either is none).
function sameMoment(a, b) {
	const x = momentKey(a);
	return x !== null && x === momentKey(b);
}

module.exports = { moneyCents, momentKey, sameMoment };
