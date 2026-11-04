"use strict";
// Receipts auto-approve, rules v1: the pure judge. No DB, no network, no clock:
// the pass gathers every fact (the time included) and stores what this returns.
// "approve" needs the server's own re-read of the stored file and no rule holding.

const crypto = require("crypto");
const { findDuplicateGroups, GALLONS_DISAGREE_MIN_ABS, GALLONS_DISAGREE_MIN_REL } = require("./receipt-duplicates");
const { cpgBand } = require("./receipt-gallons-recovery");
const { normalizeVendor } = require("./expense-analytics");

const RULES_VERSION = "v1";

// Report order. Rules 1-10 cost nothing; 11-19 need the re-read.
const FREE_RULES = ["NO_ELD_FILL", "ADJACENT_DAY", "PLACE_FAR", "TRUCK_UNSET", "TRUCK_NOT_HELD",
	"TRUCK_CHANGE_DAY", "OWNER_MISMATCH", "DUPLICATE", "OVERRIDDEN", "PRICE"];
const READ_RULES = ["NO_PHOTO", "OCR_TOTAL", "OCR_DATE", "OCR_GALLONS", "OCR_PLACE", "OCR_BRAND",
	"OCR_LOW", "SAME_PAPER", "OCR_MIXED"];
const RULES = [...FREE_RULES, ...READ_RULES];
// A receipt whose reads kept failing after its waits ran out.
const OCR_UNREAD = "OCR_UNREAD";
// The pass offers only Fuel receipts; anything else is held here too.
const NOT_FUEL = "NOT_FUEL";

const MAX_PLACE_KM = 50;
const FILL_WAIT_HOURS = 48;
// Only failed reads count toward this; a cap, the deadline or the day latch defers for free.
const MAX_READ_WAITS = 6;
// Gallons are read to hundredths, so a fuel-only total can sit up to half a
// hundredth-gallon's price above gallons x price; one more cent for the pump's rounding.
const MIXED_TOL_GALLONS = 0.005;
const MIXED_TOL_DOLLARS = 0.01;
const FINGERPRINT_SCHEME = "v1";
const MAX_DETAILS = 40;

const str = (v) => (v == null ? "" : String(v)).trim();
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const positive = (v) => {
	const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
	return Number.isFinite(n) && n > 0 ? n : null;
};
const cents = (v) => {
	const n = positive(v);
	return n == null ? null : Math.round(n * 100);
};
const round2 = (n) => Math.round(n * 100) / 100;
const unitKey = (v) => str(v).toLowerCase();
const driverKey = (v) => str(v).toLowerCase().replace(/\s+/g, " ");
const idOf = (v) => {
	const n = Number(v);
	return Number.isInteger(n) ? n : null;
};
// true or false, or null when the set or the id is missing (the caller holds).
const hasId = (set, id) => (id == null ? null
	: set instanceof Set ? set.has(id) : Array.isArray(set) ? set.map(Number).includes(id) : null);

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
// A calendar day key, or "" when the text isn't a real date.
function dayKey(v) {
	const s = str(v).slice(0, 10);
	const m = DAY_RE.exec(s);
	if (!m) return "";
	const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
	return d.toISOString().slice(0, 10) === s ? s : "";
}
function shiftDay(key, n) {
	const m = DAY_RE.exec(key);
	return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + n)).toISOString().slice(0, 10);
}
// SQLite's CURRENT_TIMESTAMP carries no zone and is UTC; never read it as local time.
const STAMP_RE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?)(Z|[+-]\d{2}:\d{2})?$/;
function stampMs(v) {
	const m = STAMP_RE.exec(str(v));
	return m ? Date.parse(`${m[1]}T${m[2]}${m[3] || "Z"}`) : NaN;
}
function stateCode(v) {
	const s = str(v).toUpperCase();
	return /^[A-Z]{2}$/.test(s) ? s : "";
}
function brandOf(...vals) {
	for (const v of vals) {
		const b = typeof v === "string" && v.trim() ? normalizeVendor(v) : "";
		if (b) return b;
	}
	return "";
}

// Model and client details: [{ label, value }] or its JSON text, shaped as the
// expense route stores them. Anything else reads as no details.
function detailPairs(details) {
	let arr = details;
	if (typeof arr === "string") {
		try { arr = JSON.parse(arr); } catch { return []; }
	}
	if (!Array.isArray(arr)) return [];
	return arr
		.filter((d) => d && typeof d === "object" && typeof d.label === "string" && d.label.trim())
		.slice(0, MAX_DETAILS)
		.map((d) => ({ label: d.label.trim().slice(0, 40), value: str(d.value).slice(0, 200) }));
}

// ── Rule 18: the printed codes ──────────────────────────────────────────────
const AUTH_LABEL = /\b(?:auth[a-z]*|approv[a-z]*|appr)\b/i;
const TXN_LABEL = /\b(?:transaction|trans|tran|txn|trx|invoice|inv|ticket|tkt)\b/i;
// A pump number repeats across tickets; dates and money are not codes.
const NOT_CODE_LABEL = /pump|date|time|type|total|amount|amt|fee|tax|status|method|price/i;

// Words printed beside a code, not part of it.
const CODE_NOISE = new Set(["APPROVED", "APPROVAL", "APPR", "AUTH", "AUTHORIZATION", "CODE", "NO", "NUM", "NUMBER",
	"TRANS", "TRANSACTION", "TXN", "INVOICE", "INV", "TICKET", "TKT"]);
// The code a value prints, with case, spaces, separators and masking removed;
// "" unless it has a digit and 4-32 characters. Dates, times and money are no code.
function normalizeCode(raw) {
	const v = str(raw).toUpperCase();
	if (!v || /\$|\d[:/]\d/.test(v)) return "";
	const code = v
		.replace(/[*•·]/g, "")
		.split(/[\s#.,:()-]+/)
		.map((t) => t.replace(/^X{2,}/, ""))
		.filter((t) => /^[A-Z0-9]+$/.test(t) && !CODE_NOISE.has(t))
		.join("");
	return /\d/.test(code) && code.length >= 4 && code.length <= 32 ? code : "";
}

// Auth or approval codes and transaction, invoice or ticket numbers; a pump number never.
function printedCodes(details) {
	const out = new Set();
	for (const { label, value } of detailPairs(details)) {
		if (NOT_CODE_LABEL.test(label)) continue;
		if (!AUTH_LABEL.test(label) && !TXN_LABEL.test(label)) continue;
		const code = normalizeCode(value);
		if (code) out.add(code);
	}
	return [...out];
}

// One hash per printed code with the brand, so a twin sharing any one code matches.
// Values are hashed, never kept.
function fingerprints(brand, details) {
	const b = str(brand).toUpperCase();
	const fps = printedCodes(details)
		.map((code) => crypto.createHash("sha256").update(`${FINGERPRINT_SCHEME}|${b}|${code}`).digest("hex"));
	return [...new Set(fps)].sort();
}

// The receipts that share a fingerprint with the candidate: Fuel, same truck or
// driver, any status (a person's rejection of one copy sends the other to a person).
// Another receipt's fingerprints come from its own reading or its stored details.
function samePaperIds(candidate, candidateFps, others) {
	const mine = new Set(candidateFps || []);
	if (!mine.size) return [];
	const c = candidate || {};
	const id = idOf(c.id);
	const unit = unitKey(c.truck_unit);
	const drv = driverKey(c.driver);
	const ids = [];
	for (const o of others || []) {
		if (!o || idOf(o.id) === id || str(o.type) !== "Fuel") continue;
		const scoped = (unit && unitKey(o.truck_unit) === unit) || (drv && driverKey(o.driver) === drv);
		if (!scoped) continue;
		const theirs = [
			...(Array.isArray(o.fingerprints) ? o.fingerprints : []),
			...fingerprints(brandOf(o.vendor_normalized, o.vendor), o.receipt_details),
		];
		if (theirs.some((f) => mine.has(f))) ids.push(idOf(o.id));
	}
	return ids.sort((a, b) => a - b);
}

// ── Rule 19: a ticket with anything but fuel on it ──────────────────────────
// Goods named inside a label that would otherwise pass (any label not listed below is an item too).
const NON_FUEL = /merch|grocer|snack|food|drink|beverage|coffee|soda|tobacco|cigar|vape|lottery|lotto|beer|wine|candy|chips|scale|wash|\bdef\b|exhaust fluid|adblue|additive|treatment|kleen|anti-?gel|conditioner|\boil|lube|parts|accessor|charger|\block\b|gift|prepaid|c-?store|store items|store total|inside sale|non-?fuel|misc|other items/i;
// Labels that say only "an item"; their value has to name a fuel or be a bare product code.
const GENERIC_ITEM = /\b(?:product|description|desc|item|items|sku|grade)\b/i;
const PRODUCT_CODE = /^\s*#?\d{1,6}\s*$/;
const FUEL_VALUE = /diesel|\bdsl\b|ulsd|unleaded|\bunl\b|gasoline|\bgas\b|regular|premium|\bplus\b|midgrade|reefer|\bfuel\b|\bbio|\be\d{1,2}\b|\bb\d{1,2}\b|^\s*(?:#|no\.?)\s?[12]\s*$/i;
// What a fuel-only ticket prints besides its fuel: grade, price per gallon, pump,
// discount, subtotal and total, tax, payment and card, auth, transaction number,
// store and address, time, odometer, unit and the driver's fleet prompts.
const FUEL_TICKET_LABELS = [
	/diesel|\bdsl\b|ulsd|unleaded|gasoline|\bgas\b|reefer|\bfuel\b|octane/i,
	/price|\bppg\b|per\s?gal|\/\s?gal|unit\s?cost/i,
	/pump|hose|nozzle|dispenser/i,
	/disc|savings|saved|rebate|reward|loyalty|points/i,
	/sub\s?-?total|total|amount|\bamt\b|balance|\bdue\b|\bsale\b|gallon|\bgal\b|volume|\bvol\b|\bqty\b|quantity/i,
	/tax|\bfet\b|excise/i,
	/\bpay|paid|tender|\bcard\b|cardholder|visa|mastercard|amex|discover|debit|credit|\bcash\b|\bchange\b|entry|swipe|\bchip\b|contactless|account|acct|fleet|\befs\b|comdata|\bwex\b|t-?chek|fuelman|terminal|\btid\b|\bmid\b|merchant|batch|\baid\b|\btvr\b|\btsi\b|arqc|\bemv\b|\bpin\b|signature|verified|\bcopy\b/i,
	AUTH_LABEL,
	/transaction|\btrans\b|\btran\b|\btxn\b|\btrx\b|invoice|\binv\b|ticket|\btkt\b|receipt|\bref|sequence|\bseq\b|trace|\bstan\b|\brrn\b|order/i,
	/address|\baddr|street|city|state|\bzip\b|store|location|\bsite\b|station|phone|\btel\b|vendor|\bname\b/i,
	/time|date|\bday\b/i,
	/odometer|\bodo|mileage|miles|\bhub|engine hours|hours/i,
	/\bunit\b|\btruck\b|\btractor\b|\btrailer\b|\bvehicle\b|\bveh\b|\btag\b|\bplate\b|license/i,
	/driver|employee|\bemp\b|\bid\b|cashier|clerk|operator|register|\blane\b|shift|attendant|\btrip\b|\bpo\b|purchase order|company|customer/i,
];
const PPG_LABEL = /price|\bppg\b|per\s?gal|\/\s?gal|unit\s?cost/i;
const NOT_PPG_LABEL = /disc|total|sub/i;

// The lowest price per gallon the ticket prints (the stricter test), or null.
function pricePerGallon(details) {
	let best = null;
	for (const { label, value } of detailPairs(details)) {
		if (!PPG_LABEL.test(label) || NOT_PPG_LABEL.test(label)) continue;
		for (const m of value.match(/\d{1,4}(?:\.\d{1,4})?/g) || []) {
			const p = Number(m);
			if (p > 0.5 && p < 20 && (best == null || p < best)) best = p;
		}
	}
	return best;
}

// { mixed, items, ppg }: items are the labels read as something other than fuel.
// No price read holds nothing by itself; a total under gallons x price (a discount) is fine.
function mixedTicket(read) {
	const r = read && typeof read === "object" ? read : {};
	const items = [];
	for (const { label, value } of detailPairs(r.details)) {
		let other;
		if (NON_FUEL.test(label)) other = true;
		else if (GENERIC_ITEM.test(label)) other = NON_FUEL.test(value) || !(FUEL_VALUE.test(value) || PRODUCT_CODE.test(value));
		else other = !FUEL_TICKET_LABELS.some((re) => re.test(label));
		if (other) items.push(label);
	}
	const ppg = pricePerGallon(r.details);
	const g = num(r.gallons);
	const total = num(r.amount);
	let over = false;
	if (ppg != null && g != null && g > 0 && total != null && total > 0) {
		over = total - g * ppg > MIXED_TOL_GALLONS * ppg + MIXED_TOL_DOLLARS + 1e-9;
	}
	return { mixed: items.length > 0 || over, items, ppg, over };
}

// ── Rule 8 and rule 9 inputs ────────────────────────────────────────────────
// Every duplicate group, never a capped list. A Rejected receipt isn't spend, so it
// joins only when it is the receipt being judged.
function duplicateMemberIds(rows, { suppressedIds = new Set(), includeId = null } = {}) {
	const inc = includeId == null ? null : idOf(includeId);
	const kept = (rows || []).filter((r) => r && (str(r.status) !== "Rejected" || (inc != null && idOf(r.id) === inc)));
	const ids = new Set();
	for (const g of findDuplicateGroups(kept, { suppressedIds })) {
		for (const r of g.rows) ids.add(idOf(r.id));
	}
	return ids;
}

// An override names the receipt it logged (entity_id) and the one it matched
// ("... expense #N"); both stay a person's.
const OVERRIDE_REF = /expense #(\d{1,12})\b/;
function overrideNamedIds(auditRows) {
	const ids = new Set();
	for (const a of auditRows || []) {
		if (!a || a.action !== "expense_duplicate_override") continue;
		const own = idOf(a.entity_id);
		if (own != null && own > 0) ids.add(own);
		const m = OVERRIDE_REF.exec(str(a.details));
		if (m) ids.add(Number(m[1]));
	}
	return ids;
}

// ── The judge ───────────────────────────────────────────────────────────────
function ownerOf(v) {
	if (v == null || str(v) === "") return null;
	const n = Number(v);
	return Number.isInteger(n) && n >= 0 ? n : null;
}

// Rules 1-10. verdict "hold" (reasons), "wait" (the fill may still be detected,
// wait "FILL") or "read" (every free rule passes; the re-read decides).
function judgeFree(candidate, evidence) {
	const c = candidate || {};
	const ev = evidence || {};
	if (str(c.type) !== "Fuel") return { verdict: "hold", reasons: [NOT_FUEL], wait: null };
	const id = idOf(c.id);
	const reasons = [];
	let wait = null;

	// 1-3: the ELD fill linked to this receipt.
	const link = id != null && ev.link && idOf(ev.link.expense_id) === id ? ev.link : null;
	if (!link) {
		const hours = (stampMs(ev.now) - stampMs(c.created_at)) / 3600000;
		if (Number.isFinite(hours) && hours < FILL_WAIT_HOURS) wait = "FILL";
		else reasons.push("NO_ELD_FILL");
	} else {
		if (str(link.match_basis) !== "exact_day") reasons.push("ADJACENT_DAY");
		const km = link.match_distance_km == null || str(link.match_distance_km) === "" ? NaN : Number(link.match_distance_km);
		// A place taken from the truck's own ping isn't independent of the fill.
		if (!(km >= 0 && km <= MAX_PLACE_KM) || str(c.location_source).toLowerCase() === "eld") reasons.push("PLACE_FAR");
	}

	// 4-7: whose truck, and whose money.
	const unit = unitKey(c.truck_unit);
	const day = dayKey(c.date);
	const spans = (Array.isArray(ev.assignments) ? ev.assignments : []).map((a) => ({
		unit: unitKey(a && a.truck_unit),
		start: dayKey(a && a.start_date),
		open: !str(a && a.end_date),
		end: dayKey(a && a.end_date),
	}));
	if (!unit) reasons.push("TRUCK_UNSET");
	else if (!day || !spans.some((s) => s.unit === unit && s.start && s.start <= day && (s.open || (s.end && s.end >= day)))) {
		reasons.push("TRUCK_NOT_HELD");
	}
	// A start or end within a day of the receipt, or a date that can't be read.
	const lo = day ? shiftDay(day, -1) : "";
	const hi = day ? shiftDay(day, 1) : "";
	const near = (k) => k >= lo && k <= hi;
	if (!day || spans.some((s) => !s.start || near(s.start) || (!s.open && (!s.end || near(s.end))))) {
		reasons.push("TRUCK_CHANGE_DAY");
	}
	if (unit) {
		const own = ownerOf(c.owner_id);
		const truckOwner = ownerOf(ev.truckOwnerId);
		if (own == null || truckOwner == null || own !== truckOwner) reasons.push("OWNER_MISMATCH");
	}

	// 8-10: missing evidence holds.
	if (hasId(ev.duplicateIds, id) !== false) reasons.push("DUPLICATE");
	if (hasId(ev.overriddenIds, id) !== false) reasons.push("OVERRIDDEN");
	const amount = positive(c.amount);
	const gallons = positive(c.gallons);
	const bandLo = num(ev.band && ev.band.min);
	const bandHi = num(ev.band && ev.band.max);
	const cpg = amount != null && gallons != null ? round2(amount / gallons) : null;
	if (cpg == null || bandLo == null || bandHi == null || cpg < bandLo || cpg > bandHi) reasons.push("PRICE");

	if (reasons.length) return { verdict: "hold", reasons, wait: null };
	return { verdict: wait ? "wait" : "read", reasons, wait };
}

// The re-read's values, re-checked here: model output is untrusted.
function readSummary(ocr) {
	const o = ocr && typeof ocr === "object" ? ocr : {};
	const amount = num(o.amount);
	const gallons = num(o.gallons);
	return {
		amount: amount != null && amount > 0 ? round2(amount) : null,
		date: typeof o.date === "string" ? dayKey(o.date) || null : null,
		gallons: gallons != null && gallons > 0 ? round2(gallons) : null,
		state: stateCode(o.state) || null,
		brand: typeof o.vendor === "string" ? normalizeVendor(o.vendor) || null : null,
		confidence: o.confidence === "high" || o.confidence === "medium" ? o.confidence : "low",
	};
}

// Rules 11-19 on a read that came back.
function readReasons(c, ev, ocr) {
	const r = readSummary(ocr);
	const reasons = [];
	const entered = cents(c.amount);
	if (r.amount == null || entered == null || Math.round(r.amount * 100) !== entered) reasons.push("OCR_TOTAL");
	if (!r.date || r.date !== dayKey(c.date)) reasons.push("OCR_DATE");
	const g = positive(c.gallons);
	if (r.gallons == null || g == null) reasons.push("OCR_GALLONS");
	else {
		const diff = Math.abs(r.gallons - g);
		if (diff > GALLONS_DISAGREE_MIN_ABS && diff / Math.max(r.gallons, g) > GALLONS_DISAGREE_MIN_REL) reasons.push("OCR_GALLONS");
	}
	if (!r.state || r.state !== stateCode(c.location_state)) reasons.push("OCR_PLACE");
	const rowBrand = brandOf(c.vendor_normalized, c.vendor);
	if (r.brand && rowBrand && r.brand !== rowBrand) reasons.push("OCR_BRAND");
	if (r.confidence === "low") reasons.push("OCR_LOW");

	// The candidate's own stored details may add a code to hold on, never one to pass on.
	const brand = rowBrand || r.brand || "";
	const readFps = fingerprints(brand, ocr && ocr.details);
	const allFps = [...new Set([...readFps, ...fingerprints(brand, c.receipt_details)])];
	const twins = allFps.length ? (Array.isArray(ev.others) ? samePaperIds(c, allFps, ev.others) : null) : [];
	if (twins === null || twins.length) reasons.push("SAME_PAPER");

	const mix = mixedTicket(ocr);
	if (mix.mixed) reasons.push("OCR_MIXED");
	return { reasons, read: { ...r, ppg: mix.ppg }, fingerprints: readFps, twins: twins || [] };
}

const countOf = (v) => {
	const n = Number(v);
	return Number.isInteger(n) && n > 0 ? n : 0;
};

// The verdict for one receipt.
//   evidence.read: { status: "ok", ocr } | { status: "no_photo" } | { status: "failed" }
//   (the scanner failed) | { status: "deferred" } (cap, deadline or day latch).
function judge(candidate, evidence) {
	const c = candidate || {};
	const ev = evidence || {};
	const prior = countOf(ev.failedReads);
	const out = (verdict, reasons, extra = {}) => ({
		verdict, reasons, wait: null, failedReads: prior, fingerprints: [], read: null, twins: [], ...extra,
	});
	const free = judgeFree(c, ev);
	if (free.verdict !== "read") return out(free.verdict, free.reasons, { wait: free.wait });

	const status = ev.read && typeof ev.read === "object" ? ev.read.status : "deferred";
	if (status === "deferred") return out("wait", [], { wait: "READ_DEFERRED" });
	if (status === "no_photo") return out("hold", ["NO_PHOTO"]);
	if (status === "failed") {
		const n = prior + 1;
		return n > MAX_READ_WAITS ? out("hold", [OCR_UNREAD], { failedReads: n }) : out("wait", [], { wait: "READ_FAILED", failedReads: n });
	}
	if (status !== "ok") return out("hold", [OCR_UNREAD]);

	const r = readReasons(c, ev, ev.read.ocr);
	return out(r.reasons.length ? "hold" : "approve", r.reasons, { fingerprints: r.fingerprints, read: r.read, twins: r.twins });
}

module.exports = {
	RULES_VERSION,
	RULES,
	FREE_RULES,
	READ_RULES,
	OCR_UNREAD,
	NOT_FUEL,
	MAX_PLACE_KM,
	FILL_WAIT_HOURS,
	MAX_READ_WAITS,
	judge,
	judgeFree,
	normalizeCode,
	printedCodes,
	fingerprints,
	samePaperIds,
	mixedTicket,
	pricePerGallon,
	duplicateMemberIds,
	overrideNamedIds,
	// Rule 10's band, from the fleet's own priced receipts (lib/receipt-gallons-recovery.js).
	priceBand: cpgBand,
};
