// An opaque key for a load whose Load ID is withheld (the Dispatcher raw Load ID
// plan, PR 2, decision 6; server.js WITHHELD LOAD KEYS, behind
// WITHHELD_LOAD_REFS_ENABLED, off by default).
//
// Since #525 and #549 every role but Super Admin is served a Load ID that holds
// broker contact (a phone or an email inside it, or the row's own broker phone
// as bare digits) as its shown text: "QA-[contact withheld]", or
// "[contact withheld]" when the ID is only contact. A load's pages fetch, edit
// and assign it by its Load ID, so a Dispatcher could see such a load but not
// open it. A key stands in for the ID: the server issues it beside the shown
// text (`_loadKey` on a row, `loadKey` beside a `loadId`), the client sends it
// wherever it would send the ID, and the server reads it back as the stored ID
// (server.js loadIdFor()). The key carries nothing of the ID:
//
//   key = "wk-" + base64url(HMAC-SHA256(secret, the ID compared as loads are)),
//         cut to 30 characters
//
// [A-Za-z0-9_-] only, so a key passes both Load ID patterns of
// lib/load-id-rule.js and travels every route and URL a Load ID does. The
// secret is random per process (no new secret to keep): after a restart every
// key is unknown (404 LOAD_KEY_UNKNOWN) and the page reads its rows again.
//
// The reply guard (replyGuardFor(), guardReply()) is a safety net for a request
// that named a load by its key: every string of the reply has the ID's exact
// text, and each phone or email the shown text withholds, swapped for the shown
// text. A phone is matched by its ten digits with at most three separator
// characters between digit groups (as broker-contact.js ownPatterns() does), and
// never inside a longer number or a decimal, so coordinates, timestamps, row
// numbers and reference numbers are left alone. It never changes an outcome.
//
// Pure: no network, DB or fs (crypto hashing only). Every pattern is bounded.
"use strict";

const crypto = require("crypto");
const { WITHHELD_TEXT, findContact, loadIdKey } = require("./broker-contact");

const KEY_PREFIX = "wk-";
const KEY_BODY_LENGTH = 27;
const LOAD_KEY_RE = /^wk-[A-Za-z0-9_-]{27}$/;
const MAX_DEPTH = 40;

// Whether `v` has a key's shape (it may still be unknown).
function isLoadKey(v) {
	return typeof v === "string" && LOAD_KEY_RE.test(v);
}

// The keys of one process: keyFor(id) is "" for a blank ID. Two spellings of
// one load ("#123", " 123 ", "QA-1" and "qa-1") share a key, as they share a
// load everywhere else (loadIdKey()).
function createLoadKeys({ secret = crypto.randomBytes(32) } = {}) {
	if (!Buffer.isBuffer(secret) && !(typeof secret === "string" && secret)) {
		throw new TypeError("createLoadKeys: secret must be a Buffer or a non-empty string");
	}
	function keyFor(raw) {
		const id = typeof raw === "number" && Number.isFinite(raw) ? String(raw) : raw;
		if (typeof id !== "string") return "";
		const norm = loadIdKey(id);
		if (!norm) return "";
		return KEY_PREFIX + crypto.createHmac("sha256", secret).update(norm, "utf8").digest("base64url").slice(0, KEY_BODY_LENGTH);
	}
	return { keyFor };
}

// The keys of one Job Tracking read: key -> { raw, shown, key, drivers }, for
// each load whose ID the index (lib/broker-contact.js buildShownLoadIdIndex())
// withholds. `raw` is the ID as the first row holding it stores it, `shown` the
// index's text, `drivers` every Driver cell of the rows holding it, each put
// through `driverKey` (server.js passes normalizeDriverName()). The rows are
// header-keyed and never changed.
function buildLoadKeyTable(headers, rows, { index = null, keyFor = null, driverKey = (s) => String(s == null ? "" : s).trim().toLowerCase() } = {}) {
	const table = new Map();
	if (!index || !index.byKey || typeof keyFor !== "function") return table;
	const hs = headers || [];
	const idCol = hs.find((h) => /load.?id|job.?id/i.test(String(h == null ? "" : h)));
	const driverCol = hs.find((h) => /driver/i.test(String(h == null ? "" : h)));
	if (idCol == null) return table;
	for (const row of rows || []) {
		const raw = String(row && row[idCol] != null ? row[idCol] : "").trim();
		if (!raw) continue;
		const hit = index.byKey.get(loadIdKey(raw));
		if (!hit || !hit.hidden) continue;
		const key = keyFor(raw);
		if (!key) continue;
		let entry = table.get(key);
		if (!entry) {
			entry = { raw, shown: hit.shown, key, drivers: new Set() };
			table.set(key, entry);
		}
		const driver = driverCol != null ? driverKey(row[driverCol]) : "";
		if (driver) entry.drivers.add(driver);
	}
	return table;
}

// ---------------------------------------------------------------- reply guard
function escapeRe(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function digitsOf(s) {
	return String(s).replace(/\D/g, "");
}
function tenDigits(digits) {
	if (digits.length === 10) return digits;
	if (digits.length === 11 && digits[0] === "1") return digits.slice(1);
	return "";
}

// The parts of `raw` its shown text withholds: what stands where `shown` reads
// "[contact withheld]". An ID shown as "[contact withheld]" alone is withheld
// whole.
function withheldParts(raw, shown) {
	if (!raw || raw === shown) return [];
	if (typeof shown !== "string" || shown === WITHHELD_TEXT || !shown.includes(WITHHELD_TEXT)) return [raw];
	const pieces = shown.split(WITHHELD_TEXT).map(escapeRe);
	const m = new RegExp(`^${pieces.join("([\\s\\S]+?)")}$`).exec(raw);
	if (m) return m.slice(1);
	return findContact(raw).map((r) => raw.slice(r.start, r.end));
}

// What the reply guard swaps for a request that named the load `raw` (shown as
// `shown`): { re, raw, shown }, re null when there is nothing to look for. The
// ID itself is swapped for its shown text, a phone or an email of it for
// "[contact withheld]".
const SEP = "[\\s().\\-\\u2010-\\u2015\\u2212/]{0,3}";
const BEFORE_NUMBER = "(?<!\\d)(?<!\\d[.,])";
const AFTER_NUMBER = "(?!\\d)(?![.,]\\d)";
function replyGuardFor(raw, shown) {
	const text = String(raw == null ? "" : raw).trim();
	const shownText = typeof shown === "string" && shown ? shown : WITHHELD_TEXT;
	const phones = new Set();
	const emails = new Set();
	for (const part of withheldParts(text, shownText)) {
		const found = findContact(part);
		for (const r of found) {
			const p = part.slice(r.start, r.end);
			if (p.includes("@")) emails.add(p.replace(/^<|>$/g, "").replace(/^mailto:/i, "").toLowerCase());
			else {
				const ten = tenDigits(digitsOf(p.replace(/(?:ext\.?|extension|x)\s{0,3}\d{1,6}\s*$/i, "")));
				if (ten) phones.add(ten);
			}
		}
		if (!found.length) {
			const ten = tenDigits(digitsOf(part));
			if (ten) phones.add(ten);
			else if (part.includes("@")) emails.add(part.trim().toLowerCase());
		}
	}
	const alts = [];
	if (text) alts.push(`${/^\d/.test(text) ? BEFORE_NUMBER : ""}${escapeRe(text)}${/\d$/.test(text) ? AFTER_NUMBER : ""}`);
	for (const e of emails) if (e) alts.push(escapeRe(e));
	for (const ten of phones) {
		alts.push(`${BEFORE_NUMBER}(?:\\+?1${SEP})?\\(?${ten.slice(0, 3)}${SEP}${ten.slice(3, 6)}${SEP}${ten.slice(6)}${AFTER_NUMBER}`);
	}
	return { re: alts.length ? new RegExp(alts.join("|"), "gi") : null, raw: text, shown: shownText };
}

// `value` (a reply body: a string, or JSON data) with every match of `guard`
// swapped for its shown text, in every string at any depth, object keys
// included: { value, hits }. A value with no match comes back as the same
// object; anything that is not a string, an array or a plain object is left as
// it is.
function guardReply(value, guard) {
	let hits = 0;
	if (!guard || !guard.re) return { value, hits };
	const raw = String(guard.raw || "").toLowerCase();
	const swap = (s) => {
		guard.re.lastIndex = 0;
		if (!guard.re.test(s)) return s;
		guard.re.lastIndex = 0;
		return s.replace(guard.re, (m) => {
			hits++;
			return raw && m.toLowerCase() === raw ? guard.shown : WITHHELD_TEXT;
		});
	};
	const plain = (v) => {
		const proto = Object.getPrototypeOf(v);
		return proto === Object.prototype || proto === null;
	};
	const walk = (v, depth) => {
		if (typeof v === "string") return swap(v);
		if (depth > MAX_DEPTH || !v || typeof v !== "object") return v;
		if (Array.isArray(v)) {
			let changed = false;
			const out = v.map((x) => { const y = walk(x, depth + 1); if (y !== x) changed = true; return y; });
			return changed ? out : v;
		}
		if (!plain(v)) return v;
		let changed = false;
		const out = {};
		for (const [k, x] of Object.entries(v)) {
			const k2 = swap(k);
			const y = walk(x, depth + 1);
			if (k2 !== k || y !== x) changed = true;
			out[k2] = y;
		}
		return changed ? out : v;
	};
	const out = walk(value, 0);
	return { value: out, hits };
}

module.exports = {
	KEY_PREFIX,
	LOAD_KEY_RE,
	isLoadKey,
	createLoadKeys,
	buildLoadKeyTable,
	withheldParts,
	replyGuardFor,
	guardReply,
};
