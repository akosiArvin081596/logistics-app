"use strict";
// The header lines of a printed invoice, built one way for every path that
// renders one: POST /api/invoices/generate, the manual invoice's payee list and
// the Personal correction draft in server.js, scripts/regenerate-invoice-pdfs.js,
// and lib/policy-field-maps.js for the weekday.
//
//   providerAddressLine()  the FROM block's Address line from a drivers_directory
//                          row. Most saved street fields already hold the whole
//                          address ("street, city, ST zip, country"), and the old
//                          join added city, state and zip a second time. This only
//                          decides what prints; saved addresses are never changed.
//   weekdayOfDateText()    the weekday of a printed date ("Oct 15, 2026" is a
//                          Thursday), by calendar arithmetic on the date itself and
//                          never through a zone, so every server gives the same day.
//                          The Submission Date cell used to print a literal "Friday,".
//   invoiceDateFromStamp() a SQLite UTC stamp ("2026-10-16 00:30:00") as the date
//                          the invoice prints, in APP_TIMEZONE ("Oct 15, 2026").
//
// Pure apart from lib/app-time.js reading APP_TIMEZONE once.

const appTime = require("./app-time");

const clean = (v) => String(v == null ? "" : v).replace(/\s+/g, " ").trim();
// For comparing parts: case, dots and spacing ignored ("U.S.A." is "usa").
const fold = (v) => clean(v).toLowerCase().replace(/\./g, "");
// `word` (one or more words) is the last of `text`'s words.
const endsWithWord = (text, word) => !!word && ` ${text}`.endsWith(` ${word}`);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A trailing country part: the invoices are US-only, and the split fields hold none.
const COUNTRY_RE = /^(?:usa|us|united states(?: of america)?)$/;
// The same country written after the zip with no comma ("... TX 77002 USA").
const COUNTRY_AFTER_ZIP_RE = /(\d{5}(?:-\d{4})?) (?:U\.?S\.?A?\.?|United States(?: of America)?)$/i;
// The US states, DC and the territories, by USPS code and by name (folded): the
// only words read as a state that isn't the saved one ("Texas" when "TX" is saved).
const US_STATES = [
	"al", "ak", "az", "ar", "ca", "co", "ct", "de", "fl", "ga", "hi", "id", "il", "in", "ia", "ks", "ky",
	"la", "me", "md", "ma", "mi", "mn", "ms", "mo", "mt", "ne", "nv", "nh", "nj", "nm", "ny", "nc", "nd",
	"oh", "ok", "or", "pa", "ri", "sc", "sd", "tn", "tx", "ut", "vt", "va", "wa", "wv", "wi", "wy",
	"dc", "pr", "gu", "vi", "as", "mp",
	"alabama", "alaska", "arizona", "arkansas", "california", "colorado", "connecticut", "delaware",
	"florida", "georgia", "hawaii", "idaho", "illinois", "indiana", "iowa", "kansas", "kentucky",
	"louisiana", "maine", "maryland", "massachusetts", "michigan", "minnesota", "mississippi",
	"missouri", "montana", "nebraska", "nevada", "new hampshire", "new jersey", "new mexico",
	"new york", "north carolina", "north dakota", "ohio", "oklahoma", "oregon", "pennsylvania",
	"rhode island", "south carolina", "south dakota", "tennessee", "texas", "utah", "vermont",
	"virginia", "washington", "west virginia", "wisconsin", "wyoming",
	"district of columbia", "puerto rico", "guam", "virgin islands", "american samoa", "northern mariana islands",
];
const endsWithUsState = (text) => US_STATES.some((s) => endsWithWord(text, s));

// The one Address line: the street field as saved, plus only the city, state and
// zip it doesn't already show, in "street, city, ST zip" order.
//   - A street holding none of the saved city, state or zip prints exactly as it
//     always did: street, city, state, zip, each after a comma.
//   - Only the parts after the street's first comma are searched, so a street
//     named after its city ("45 Houston Ave") still gets the city.
//   - The state is found only where a state goes: the last word before the zip,
//     or of the last part. A "Ct", "NE" or "Co Rd" inside the street is not it,
//     nor is the city written before the zip.
//   - A part is never dropped: when it can't tell, it prints the part again.
function providerAddressLine(row) {
	const r = row || {};
	const city = clean(r.city);
	const state = clean(r.state);
	const zip = clean(r.zip);
	const asBefore = [r.address, r.city, r.state, r.zip].filter(Boolean).join(", ");
	const out = clean(r.address).split(",").map(clean).filter(Boolean);
	while (out.length > 1 && COUNTRY_RE.test(fold(out[out.length - 1]))) out.pop();
	if (out.length) out[out.length - 1] = out[out.length - 1].replace(COUNTRY_AFTER_ZIP_RE, "$1");

	const st = fold(state);
	const ct = fold(city);
	const zip5 = /^\d{5}/.test(zip) ? zip.slice(0, 5) : "";
	// The saved zip at the end of a part (folded, or as written), and the text before it.
	const zipEndRe = zip5 ? new RegExp(`(^| )(${zip5}(?:-\\d{4})?)$`) : zip ? new RegExp(`(^| )(${escapeRe(fold(zip))})$`, "i") : null;
	const beforeZip = (p) => {
		const m = zipEndRe ? zipEndRe.exec(p) : null;
		return m ? p.slice(0, m.index).trim() : null;
	};
	// Text that fills the state's place before the zip: it ends with the saved
	// state, or with a US state's name or code and isn't the city ("Texas 77002"
	// when "TX" is saved; never "Katy 77494" or "Washington 15301" in Washington, PA).
	const isState = (text, isCity) => !!text && (endsWithWord(text, st) || (!isCity && text !== ct && !text.endsWith(` ${ct}`) && endsWithUsState(text)));

	// One part ending with the zip ("1200 Elm St Houston TX 77002") is the whole
	// address only when the saved state (else the city) is the word before the zip.
	if (out.length === 1) {
		const before = beforeZip(fold(out[0]));
		if (before != null && (st ? endsWithWord(before, st) : !ct || endsWithWord(before, ct))) return out[0];
	}

	// Where each part already is, as an index into `tail` (out[i + 1]), or -1.
	const tail = out.slice(1).map(fold);
	const cityAt = ct
		? tail.findIndex((p) => {
			if (p === ct) return true;
			if (!p.startsWith(`${ct} `)) return false;
			const rest = p.slice(ct.length + 1);
			return (st && (rest === st || rest.startsWith(`${st} `))) || beforeZip(rest) != null;
		})
		: -1;
	const zipAt = zip ? tail.findIndex((p) => beforeZip(p) != null) : -1;
	let stateAt = -1;
	if (zipAt >= 0) {
		const before = beforeZip(tail[zipAt]);
		if (before) {
			if (isState(before, false)) stateAt = zipAt;
		} else if (zipAt >= 1 && isState(tail[zipAt - 1], cityAt === zipAt - 1)) {
			// A zip on its own: "..., Houston, TX, 77002" or "..., Houston, Texas, 77002".
			stateAt = zipAt - 1;
		}
	} else if (tail.length && endsWithWord(tail[tail.length - 1].replace(/ \d{5}(?:-\d{4})?$/, ""), st)) {
		// No saved zip in it: the last part, less any other zip it ends with.
		stateAt = tail.length - 1;
	}

	if (!(cityAt >= 0 || stateAt >= 0 || zipAt >= 0)) return city || state || zip ? asBefore : out.join(", ");

	const pending = [];
	if (state && stateAt < 0) {
		// "..., Houston, 77002": the state goes in before the zip (as text, never
		// read as a replacement pattern: a public form can type "$'" into it).
		const next = zipAt >= 0 ? out[zipAt + 1].replace(zipEndRe, (_m, sp, z) => `${sp}${state} ${z}`) : null;
		if (next != null && next !== out[zipAt + 1]) out[zipAt + 1] = next;
		else pending.push(state);
	}
	if (zip && zipAt < 0) {
		// "..., Houston, TX": the zip joins the state's part.
		const last = out.length - 1;
		if (!pending.length && stateAt >= 0 && stateAt === tail.length - 1 && endsWithWord(fold(out[last]), st)) out[last] = `${out[last]} ${zip}`;
		else pending.push(zip);
	}
	if (pending.length) out.push(pending.join(" "));
	if (city && cityAt < 0) {
		// Before the part already holding the state or zip, else before what was
		// just added, else at the end.
		const held = [stateAt, zipAt].filter((i) => i >= 0);
		const at = held.length ? Math.min(...held) + 1 : pending.length ? out.length - 1 : out.length;
		out.splice(at, 0, city);
	}
	return out.join(", ");
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

// The calendar date a printed date names, as [year, month, day], or null. Takes
// what the invoices print ("Oct 15, 2026", "October 15, 2026", "Sept 15, 2026"),
// a day key ("2026-10-15") and "10/15/2026". A date that doesn't exist (Feb 30)
// is null.
function calendarDateOf(text) {
	const s = clean(text);
	let y;
	let m;
	let d;
	let x;
	if ((x = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s))) {
		[y, m, d] = [+x[1], +x[2], +x[3]];
	} else if ((x = /^([A-Za-z]{3,9})\.? (\d{1,2}),? (\d{4})$/.exec(s))) {
		const name = x[1].toLowerCase();
		m = MONTHS.findIndex((full) => full.startsWith(name)) + 1;
		if (!m) return null;
		[d, y] = [+x[2], +x[3]];
	} else if ((x = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s))) {
		[m, d, y] = [+x[1], +x[2], +x[3]];
	} else {
		return null;
	}
	const t = new Date(Date.UTC(y, m - 1, d));
	if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
	return [y, m, d];
}

// "Thursday" for "Oct 15, 2026"; "" for a date it can't read.
function weekdayOfDateText(text) {
	const ymd = calendarDateOf(text);
	return ymd ? WEEKDAYS[new Date(Date.UTC(ymd[0], ymd[1] - 1, ymd[2])).getUTCDay()] : "";
}

// "Oct 17, 2026" for the day key "2026-10-17", by calendar arithmetic (no zone);
// "" for anything else: a blank, another date shape, a day that doesn't exist.
function dayKeyDateText(day) {
	if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return "";
	const ymd = calendarDateOf(day);
	if (!ymd) return "";
	const month = MONTHS[ymd[1] - 1];
	return `${month[0].toUpperCase()}${month.slice(1, 3)} ${ymd[2]}, ${ymd[0]}`;
}

// A UTC stamp as SQLite's datetime() writes it ("2026-10-16 00:30:00") or as ISO
// with a Z, as the date text an invoice prints in `timeZone` (APP_TIMEZONE unless
// named); "" for a blank or unreadable stamp, and for one that names no real
// moment (month 13, Feb 30, hour 24), which Date.UTC would roll into another day.
function invoiceDateFromStamp(stamp, timeZone = appTime.appTimeZone()) {
	const x = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,6})?)?Z?$/.exec(clean(stamp));
	if (!x) return "";
	const [y, mo, d, h, mi, s] = [+x[1], +x[2], +x[3], +x[4], +x[5], +(x[6] || 0)];
	const t = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
	const real = t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d
		&& t.getUTCHours() === h && t.getUTCMinutes() === mi && t.getUTCSeconds() === s;
	return real ? appTime.dateTextInZone(t, timeZone) : "";
}

module.exports = { providerAddressLine, weekdayOfDateText, dayKeyDateText, invoiceDateFromStamp };
