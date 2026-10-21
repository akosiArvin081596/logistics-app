// What part of a rate con a driver may be shown: the allowlist, the deny pass, the
// staff-edit check, the publish rule and the Needs Review heuristic (the owner's request,
// 2026-10-21; product-decisions.md "Rate-con driver instructions"). Not wired yet: the
// tables, the extraction call and the routes come in later PRs.
//
// WHAT A DRIVER MAY SEE. Per load and per stop: every shipment ID and reference number,
// shipper, receiver and warehouse instructions, driving directions, hours, and every
// requirement or restriction (high value, seals, never unattended, PPE, check-in rules,
// team, temperature, tarps, photos and so on).
//
// WHAT NEVER REACHES ANY OUTPUT. Payment, rates, accessorials or any dollar amount
// (one money hit drops the whole item); the load's own amounts, matched by their digits;
// contract terms and carrier certifications; the carrier's account numbers (the
// CARRIER_ACCOUNT_NUMBERS_DENY values, matched digits-only across separators, and any
// "T" + digits shape); broker emails and phones and every phone and email at all (the
// #525 rule, facility phones included); sentences telling the carrier to contact the
// broker. A run of 7+ digits that isn't one of the stop's own references (or the Load
// ID) is withheld; a time or date is not such a run.
//
// THE SHAPE. filterInstructions() builds the only shape a driver can get from whatever
// the extractor (or a stored row) holds: unknown keys, categories, kinds and stop kinds
// are dropped, every string goes through the deny pass, every list is capped. Items
// holding redirect wording, another street address, an `other` category or a
// prompt-injection marker are kept for staff with a `flag`, and the driver view hides
// them on every read. The same pass runs on every read (driverView(), staffView()), so a
// rule or deny value added later covers rows stored before it.
//
// Pure: no network, DB, fs or environment reads; the caller passes the deny list, the
// load's own amounts, contacts and sheet addresses in buildContext(). A context holds
// secrets: never log, store or send it. Every input is capped before any pattern runs and
// every quantifier is bounded (path-backend.md): the text comes from rate cons anyone can
// email in.
"use strict";

const brokerContact = require("./broker-contact");
const cellCompare = require("./cell-compare");
const kpiWeight = require("./kpi-weight");
const driveIndex = require("./ratecon-drive-index");

const SCHEMA_VERSION = 1;

const REFERENCE_LABELS = Object.freeze({
	pickup_number: "Pickup #",
	delivery_number: "Delivery #",
	appointment_number: "Appointment #",
	po_number: "PO #",
	bol_number: "BOL #",
	seal_number: "Seal #",
	order_number: "Order #",
	shipment_id: "Shipment ID",
	line_reference: "Ref #",
	other_reference: "Reference",
});
const REFERENCE_TYPES = Object.freeze(Object.keys(REFERENCE_LABELS));

// The closed requirement enum. Anything else (tracking, payment, billing, accessorial,
// detention, insurance, carrier_certification, contract_terms, broker_contact ...) is
// dropped whatever the text says.
const CATEGORY_LABELS = Object.freeze({
	high_value: "High value",
	no_unattended: "Never unattended",
	same_driver: "Same driver",
	seal: "Seal",
	securement: "Load securement",
	equipment: "Equipment",
	temperature: "Temperature",
	food_grade: "Food grade",
	ppe: "PPE",
	check_in: "Check-in",
	photos: "Photos",
	team: "Team",
	tarp: "Tarp",
	hazmat: "Hazmat",
	twic: "TWIC",
	drop_trailer: "Drop trailer",
	scale_weight: "Scale / weight",
	tandems: "Tandems",
	bol_check: "BOL check",
	work_required: "Work required",
	hours: "Hours",
	other: "Other",
});
const REQUIREMENT_CATEGORIES = Object.freeze(Object.keys(CATEGORY_LABELS));
const CRITICAL_CATEGORIES = Object.freeze(["high_value", "no_unattended", "same_driver", "seal", "hazmat", "temperature", "team", "ppe"]);
const INSTRUCTION_KINDS = Object.freeze(["shipper", "receiver", "warehouse", "directions", "hours"]);
const STOP_KINDS = Object.freeze(["pickup", "delivery"]);

const LIMITS = Object.freeze({
	stops: 8,
	referencesPerStop: 12,
	requirementsPerStop: 25,
	loadRequirements: 25,
	instructionsPerStop: 12,
	textChars: 600,
	rawChars: 2000,
	facilityChars: 80,
	placeChars: 60,
	labelChars: 30,
	referenceChars: 40,
	referenceDigits: 20,
	payloadBytes: 60 * 1024,
	storedBytes: 512 * 1024,
	denyValues: 50,
	denyDigitsMin: 5,
	extraContacts: 50,
	ownAmountMinDollars: 100,
	heuristicCandidates: 500,
});

const FOOTNOTE = "From the rate con. Questions: contact dispatch.";
const APPOINTMENT_BY_DISPATCH = "Appointment: to be set by dispatch";
const CONTACT_WITHHELD = brokerContact.WITHHELD_TEXT;
const NUMBER_WITHHELD = "[number withheld]";
const REFUSAL_CODE = "INSTRUCTIONS_CONTENT_NOT_ALLOWED";
const INVALID_CODE = "INSTRUCTIONS_INVALID";
const REFUSAL_MESSAGE = "This can't be shown to drivers. Remove it and save again.";
const INVALID_MESSAGE = "This field isn't in the expected form.";

// One line of staff text per Needs Review reason. Counts only, never a token: a token
// could be an account number or a phone. {n} is the count.
const REVIEW_REASONS = Object.freeze({
	no_rate_con: "No rate con is on file for this active load.",
	rate_con_unmatched: "A rate-con file names this load but couldn't be matched to it. Re-read it or type the instructions.",
	rate_con_not_read: "The rate con on file hasn't been read for driver instructions yet. Re-read it.",
	extract_failed: "The rate con couldn't be read. Re-read it or type the instructions.",
	load_number_unconfirmed: "The load number on the rate con doesn't match this load.",
	reference_missed: "{n} reference-like number(s) on the rate con are not in the instructions.",
	reference_not_on_rate_con: "{n} reference(s) in the instructions are not on the rate con.",
	unusual_content: "{n} item(s) hold another address, redirect wording or no category. Drivers don't see them.",
	stop_place_mismatch: "A stop's city or state differs from the load's pickup or drop-off address.",
	refiltered: "Something stored was withheld under the current rules.",
	money_or_number_withheld: "{n} reference(s) were left out: they looked like an amount, a phone or an account number, or weren't a plain reference.",
	reference_too_long: "{n} reference(s) were longer than 20 digits or 40 characters and left out.",
	reference_unknown_type: "{n} reference(s) had a kind the app doesn't show and were left out.",
	requirement_missed: "The rate con mentions requirements the instructions don't include: {list}.",
	stop_count_mismatch: "The rate con lists a different number of stops than the instructions.",
	not_cross_checked: "The rate con's text can't be read, so the instructions can't be checked for completeness.",
	suspicious_text: "{n} item(s) hold text that reads like instructions to a computer. Drivers don't see them.",
	rate_con_changed: "A newer reading of the rate con is waiting: accept it or keep the current one.",
});
const REASON_ORDER = Object.freeze(Object.keys(REVIEW_REASONS));

// ---------------------------------------------------------------- patterns
// The separators a digit run may bridge (plan §3.2): white space, "#", ":", ".", hyphen,
// the Unicode hyphens and dashes, minus. Up to 8 of them between two digits.
const NUM_SEP = "[ #:.\\-\\u2010-\\u2015\\u2212]";
const RUN7_RE = new RegExp(`\\d(?:${NUM_SEP}{0,8}\\d){0,${LIMITS.rawChars}}`, "g");
// For the deny values the bridge is wider: any 1-8 characters that are not a letter or
// a digit, so no punctuation splits an account number past the check.
const DENY_RUN_RE = new RegExp(`\\p{N}(?:[^\\p{L}\\p{N}]{0,8}\\p{N}){0,${LIMITS.rawChars}}`, "gu");
// A "T" + 5-9 digits, not preceded by a letter or digit (any letter case, separators).
const T_NUMBER_RE = new RegExp(`(?<![A-Za-z0-9])t${NUM_SEP}{0,3}\\d{5,9}`, "i");
// Sentences naming a carrier identifier (plan §3.2 step 2): dropped whole. The acronyms
// in capitals anywhere, in any letter case when a number follows, and USDOT always.
const CARRIER_ID_ACRONYM_RE = /\b(?:MC|DOT|SCAC|ABA)\b/;
const CARRIER_ID_NUMBER_RE = /\b(?:us[ -]?dot|mc|dot|scac|aba|icc)[ ]{0,3}(?:#|no\b\.?|num(?:ber)?\b|:)?[ ]{0,3}\d|\bus[ -]?dot\b/i;
const CARRIER_ID_RE = /\b(?:carrier|vendor)[ ]{0,3}(?:#|no\b|no\.|num\b|number|code|id\b)|\baccounts?\b|\bacct\b|\bremit\w{0,6}|\brouting\b|\bbank(?:s|ing)?\b/i;
function carrierIdHit(s) {
	return T_NUMBER_RE.test(s) || CARRIER_ID_ACRONYM_RE.test(s) || CARRIER_ID_NUMBER_RE.test(s) || CARRIER_ID_RE.test(s);
}
// Money (plan §3.2 step 4): one hit drops the whole item. The phrases in INNOCENT_RE
// are taken out first: they hold a money word but aren't about money.
const INNOCENT_RE = /\bbills?[ ]{1,3}of[ ]{1,3}lading\b|\bin[ ]{1,3}advance\b|\badvanced?[ ]{1,3}notice\b|\bpay(?:ing)?[ ]{1,3}attention\b|\bin[ ]{1,3}charge\b|\bdollar[ ]{1,3}general\b|\bdollar[ ]{1,3}tree\b|\bfamily[ ]{1,3}dollar\b/gi;
const MONEY_RE = new RegExp([
	"\\$", "\\bUSD\\b", "\\bdollars?\\b", "\\bcents?\\b", "\\brates?\\b", "\\bline[ ]{1,3}haul\\b",
	"\\bsurcharges?\\b", "\\bFSC\\b", "\\baccessorials?\\b", "\\bdetention\\b", "\\blayovers?\\b", "\\bTONU\\b",
	"\\breimburs\\w{0,8}", "\\bpa(?:y|ys|id|ying|yment|yments|yable|yout|youts)\\b", "\\binvoic\\w{0,4}",
	"\\bbill(?:s|ed|ing|able)?\\b", "\\bquick[ ]{0,2}pay\\b", "\\bfactoring\\b", "\\badvances?\\b", "\\bfees?\\b",
	"\\bcharge(?:s|d)?\\b", "\\bcharge[ ]{0,2}backs?\\b", "\\bcosts?\\b", "\\bprice[sd]?\\b", "\\bpricing\\b",
	"\\bcompensat\\w{0,8}", "\\bbonus(?:es)?\\b", "\\bdeduct\\w{0,6}", "\\bper[ ]{1,3}mile\\b", "\\bRPM\\b",
	"\\bhourly\\b", "/[ ]{0,2}hr\\b", "\\bflat[ ]{1,3}(?:rate|fee|charge|amount|pay)\\b", "\\bfine[sd]?\\b",
	"\\bpenalt(?:y|ies)\\b", "\\bclaim[ ]{1,3}amounts?\\b",
	// Any currency sign; slang; a figure named as an amount, a flat figure, or a figure per unit.
	"\\p{Sc}", "\\bbucks?\\b", "\\bamounts?[ ]{0,3}[:=#]?[ ]{0,3}\\d", "\\bflat[ ]{0,3}[:=]?[ ]{0,3}\\d",
	"\\d[ ]{0,3}(?:per|/)[ ]{0,3}(?:pallet|piece|pc|case|carton|unit|cwt|stop|hour|hr|day|week|mile|load)s?\\b",
].join("|"), "iu");
// An amount with cents ("540.00", "1,050.75"), unless a unit follows (a length, a weight).
const CENTS_RE = /(?<![\d.,])\d{1,3}(?:,\d{3}){1,3}\.\d{2}(?![\d.])|(?<![\d.,])\d{1,9}\.\d{2}(?![\d.])/g;
const UNIT_AFTER_RE = /^[ ]{0,2}(?:%|°|'|"|(?:ft|feet|foot|in|inch|inches|lbs?|pounds?|kgs?|mi|miles?|hrs?|hours?|deg|degrees?|f|c|m|meters?|tons?)\b)/i;
// The load's own amounts, as digit groups joined by one separator ("1,200", "1200.00",
// "1 200", "1-200", "1'200", an en dash); a group is joined to the ones before it only in
// thousands grouping (3 digits), so a date's or a reference's digits never are.
const AMOUNT_RUN_RE = new RegExp("(?<!\\d)\\d{1,40}(?:[.,' \\-\\u2010-\\u2015\\u2212\\p{Pi}\\p{Pf}]\\d{1,40}){0,10}(?!\\d)", "gu");
// Terms and contract blocks (plan §3.2 step 5).
const TERMS_RE = /subject[ ]{1,3}to[ ]{1,3}(?:the[ ]{1,3})?terms|agreement[ ]{1,3}for[ ]{1,3}motor[ ]{1,3}contract[ ]{1,3}carrier|\baddend(?:um|a)\b|liquidated[ ]{1,3}damages|indemnif|\binsurance\b|confidential[ ]{1,3}information[ ]{1,3}of|\btariffs?\b|carrier[ ]{1,3}certif|\bobjections?\b[^.]{0,80}\bterms\b|\bterms[ ]{1,3}(?:and|&)[ ]{1,3}conditions\b|\bliab(?:le|ility)\b/i;
// Telling the carrier to contact the broker (decision 6): the sentence is dropped.
const BROKER_RE = /\bCHR\b|\bC\.?[ ]{0,2}H\.?[ ]{0,2}Robinson\b|\bnavisphere\b|\bbrokers?\b|\byour[ ]{1,3}(?:rep|representative|account[ ]{1,3}manager)\b|\b(?:carrier|CHR|broker)[ ]{1,3}(?:rep|representative)s?\b/i;
const CONTACT_VERB_RE = /\b(?:call(?:s|ed|ing)?|phone|e-?mail(?:s|ed|ing)?|contact(?:s|ed|ing)?|reach(?:ing)?[ ]{1,3}out|notif(?:y|ied|ication)|text|message|check[ ]{1,3}with|ask|inform|alert|let[ ]{1,3}\S{1,30}[ ]{1,3}know)\b/i;
const SCHEDULING_RE = /\bcontact[ ]{1,3}(?:CHR|C\.?[ ]{0,2}H\.?[ ]{0,2}Robinson)[ ]{1,3}for[ ]{1,3}(?:scheduling|an?[ ]{1,3}appointment|appointments?)\b/i;
// CHR's note stamp before "Scheduled Pick-up Date, Needs Confirmation" is the note's own
// time, not a pickup date: it is never shown (the Needs Confirmation plan, F4).
const NOTE_STAMP_RE = /(?<!\d)(?:19|20)\d{6}[ ]{1,3}\d{4}[ ]{0,2}:[ ]{0,3}/g;
const NEEDS_CONFIRMATION_RE = /scheduled[ ]{0,2}pick[ -]{0,2}up[ ]{0,2}date[ ]{0,2},?[ ]{0,2}needs[ ]{1,2}confirmation/i;
// Prompt-injection markers (plan §3.2 step 8; "you are", "JSON" and "assistant" alone
// are not markers).
const INJECTION_RE = /\bignore[ ]{1,3}(?:all[ ]{1,3})?(?:the[ ]{1,3})?(?:previous|prior|above)\b|\bsystem[ ]{0,2}:|\breturn[ ]{1,3}the[ ]{1,3}following\b|\binstructions?[ ]{1,3}to[ ]{1,3}the[ ]{1,3}AI\b|\bdisregard\b/i;
// Misleading content (plan §3.2 step 7).
const REDIRECT_RE = /\bdeliver(?:y|ies)?[ ]{1,3}(?:(?:has|have)[ ]{1,3}been[ ]{1,3}|is[ ]{1,3}|was[ ]{1,3})?moved[ ]{1,3}to\b|\bdeliver[ ]{1,3}to\b|\brelease[ ]{1,3}to\b|\bhold\b|\bdo[ ]{1,3}not[ ]{1,3}deliver\b|\bnew[ ]{1,3}address\b|\bre-?rout(?:e|ed|ing)\b|\bredirect\w{0,4}|\binstead[ ]{1,3}of\b/i;
const STREET_RE = /(?<![A-Za-z0-9#])(\d{1,6})[ ]{1,3}(?:[NSEW]\.?[ ]{1,3}|(?:north|south|east|west)[ ]{1,3})?(?:[A-Za-z][A-Za-z'.-]{0,24}[ ]{1,3}){1,4}(?:street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|lane|ln|way|highway|hwy|parkway|pkwy|court|ct|place|pl|circle|cir|trail|trl|terrace|ter|pike|route|rte|expressway|expy|freeway|fwy)\b/gi;
// An email spelled out with any ending: "<word> at <word> dot <word>" (broker-contact's
// spelled pattern knows only common endings).
const SPELLED_ANY_RE = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}[ ]{0,3}(?:[([{][ ]{0,2}at[ ]{0,2}[)\]}]|[ ]at[ ])[ ]{0,3}[A-Za-z0-9-]{1,63}(?:[ ]{0,3}(?:[([{][ ]{0,2}dot[ ]{0,2}[)\]}]|[ ]dot[ ])[ ]{0,3}[A-Za-z0-9-]{1,63}){1,6}(?![A-Za-z0-9])/gi;
const SPELLED_ANY_ONE_RE = new RegExp(SPELLED_ANY_RE.source, "i");
// A 7-digit phone: 3 + 4 digits with a separator (plan R2, L1).
const PHONE7_RE = new RegExp("(?<![\\d+])\\d{3}[ ]{0,2}[-\\u2010-\\u2015\\u2212.][ ]{0,2}\\d{4}(?![\\d])|(?<![\\d+\\-.])\\d{3} \\d{4}(?!\\d)", "g");
const PHONE7_ONE_RE = new RegExp(PHONE7_RE.source);
// A reference value as kept (plan §3.1), and a label.
const REF_VALUE_RE = /^[A-Za-z0-9][A-Za-z0-9 #/.-]{0,39}$/;
const REF_LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9 #/.-]{0,29}$/;
const PLACE_RE = /^([A-Za-z][A-Za-z .'-]{0,39}),[ ]{0,2}([A-Za-z]{2})$/;
// After the pass a contact marker and words: a facility staff line is a name, a title
// and a withheld contact, and no instruction.
const STAFF_TITLE_RE = /\b(?:manager|supervisor|coordinator|clerk|lead|foreman|dispatcher|scheduler|receiver|shipper|contact|office|desk|admin|rep)\b/i;
const ACTION_RE = /\b(?:must|should|call|check|arrive|bring|require[sd]?|need[sd]?|deliver|pick|load|unload|use|park|sign|wait|do|don't|never|no|before|after|only)\b/i;
const ABBREVIATIONS = new Set(["st", "ave", "dr", "rd", "no", "approx", "min", "max", "etc", "blvd", "hwy", "ln", "mt", "ft", "hrs", "appt", "dept", "bldg", "ste", "inc", "co", "corp", "mr", "mrs", "ms", "jr", "sr", "vs"]);

// ---------------------------------------------------------------- context
// The deny values as digit strings. A value with fewer than LIMITS.denyDigitsMin digits
// is ignored (it would match too much) and counted for the caller's start-up warning.
function parseDenyList(value) {
	const raw = Array.isArray(value) ? value : String(value == null ? "" : value).slice(0, 4000).split(/[,;\n]/);
	const values = [];
	let ignored = 0;
	for (const v of raw.slice(0, LIMITS.denyValues * 4)) {
		const s = String(v == null ? "" : v).trim();
		if (!s) continue;
		const digits = s.replace(/\D/g, "");
		if (digits.length < LIMITS.denyDigitsMin || digits.length > 20) { ignored++; continue; }
		if (!values.includes(digits) && values.length < LIMITS.denyValues) values.push(digits);
	}
	return { values, ignored };
}

function denyListConfigured(value) {
	return parseDenyList(value).values.length > 0;
}

// The digit forms of the load's own amounts: whole dollars, and dollars and cents
// ("$1,200.00" -> "1200", "120000"); the dollars as numbers, for amounts in words.
// Amounts under LIMITS.ownAmountMinDollars are skipped: their digits are everywhere.
function ownAmountForms(values) {
	const digits = new Set();
	const dollars = new Set();
	for (const v of Array.isArray(values) ? values.slice(0, 20) : []) {
		const cents = cellCompare.moneyCents(typeof v === "number" ? String(v) : typeof v === "string" ? v.slice(0, 40) : "");
		if (cents === null) continue;
		const abs = Math.abs(cents);
		const whole = Math.floor(abs / 100);
		if (whole < LIMITS.ownAmountMinDollars) continue;
		digits.add(String(whole));
		digits.add(`${whole}${String(abs % 100).padStart(2, "0")}`);
		dollars.add(whole);
	}
	return { digits, dollars };
}

// The city and state of a sheet address ("100 Test Park Dr, Springfield, IL 62701").
function placeOfAddress(raw) {
	const s = typeof raw === "string" ? raw.slice(0, 300) : "";
	const city = driveIndex.cityOfAddress(s);
	const parts = s.split(",").map((x) => x.trim()).filter(Boolean);
	const last = parts.length >= 2 ? parts[parts.length - 1] : "";
	const st = /^([A-Za-z]{2})\b/.exec(last);
	return { city: normCity(city), state: st ? st[1].toUpperCase() : "", address: s };
}

function normCity(s) {
	return String(s || "").toLowerCase().replace(/[^a-z ]/g, " ").replace(/ {2,2000}/g, " ").trim();
}

// Everything the deny pass needs besides the text. `denyList`: the
// CARRIER_ACCOUNT_NUMBERS_DENY value (string or array); `amounts`: the load's own amounts
// (sheet Payment, Payments Table, Job Details Payment, the main extraction's rates);
// `contactEntries`: [label, value] pairs for broker-contact ownContact() (the row's Phone
// Number, Email, Broker Contact Name); `loadId`; the sheet's pickup and drop-off addresses.
function buildContext(o = {}) {
	const entries = Array.isArray(o.contactEntries) ? o.contactEntries.slice(0, 50) : [];
	const forms = ownAmountForms(o.amounts);
	const loadId = typeof o.loadId === "string" || typeof o.loadId === "number" ? String(o.loadId).trim().slice(0, 40) : "";
	const pickup = placeOfAddress(o.pickupAddress);
	const delivery = placeOfAddress(o.dropoffAddress);
	const ctx = Object.freeze({
		deny: Object.freeze(parseDenyList(o.denyList).values),
		amountDigits: forms.digits,
		amountDollars: forms.dollars,
		contactEntries: entries,
		own: brokerContact.ownContact(entries),
		loadId: REF_VALUE_RE.test(loadId) ? loadId : "",
		sheet: { pickup, delivery },
		addresses: [pickup.address, delivery.address].filter(Boolean),
	});
	BUILT_CONTEXTS.add(ctx);
	return ctx;
}

// Only the very object buildContext() returned (not a copy, not a look-alike), and only
// with at least one deny value: anything else throws, so a caller that forgot the context
// or the deny list fails closed instead of filtering with less.
const BUILT_CONTEXTS = new WeakSet();
function requireContext(ctx) {
	if (ctx && BUILT_CONTEXTS.has(ctx) && ctx.deny.length > 0) return ctx;
	const err = new Error("driver-instructions: a context from buildContext() with a configured deny list is required");
	err.code = "DRIVER_INSTRUCTIONS_CONTEXT";
	throw err;
}

// ---------------------------------------------------------------- normalizing
// Every line break but "\n": CR, CRLF, NEL, VT, FF and the Unicode line and paragraph separators.
const LINE_BREAKS_RE = new RegExp("\\r\\n|[\\r\\u0085\\u000b\\u000c\\u2028\\u2029]", "g");
// NFKC; format, private-use and combining characters removed (zero-width, bidi, soft
// hyphen); every white space but a line break becomes a space; runs collapsed. Returns
// null when the text holds digits from another script (they would slip past every digit
// rule), else the text with "\n" as its only line break.
function normalizeText(raw) {
	let s = raw.length > LIMITS.rawChars ? raw.slice(0, LIMITS.rawChars) : raw;
	s = s.normalize("NFKC");
	s = s.replace(/[\p{Cf}\p{Co}\p{M}]/gu, "");
	s = s.replace(LINE_BREAKS_RE, "\n");
	s = s.replace(/[\u0000-\u0009\u000e-\u001f\u007f-\u009f]/g, " ");
	s = s.replace(/[^\S\n]/g, " ");
	if (/\p{Nd}/u.test(s.replace(/[0-9]/g, ""))) return null;
	s = s.replace(/ {2,2000}/g, " ").replace(/ ?\n[ \n]{0,2000}/g, "\n");
	return s.trim();
}

// The text with its line breaks as spaces (a hyphen at a line end joins the next line),
// and the same text with its line breaks removed, with joinedIndex -> spacedIndex; and,
// for the drop rules only, the joined text with a hyphen at a line end removed too, so a
// word hyphenated across lines ("compen-" / "sated") is read whole.
function lineVariants(s) {
	let spaced = "";
	let joined = "";
	let dehyphenated = "";
	const map = [];
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (c === "\n") {
			if (i > 0 && s[i - 1] === "-") {
				dehyphenated = dehyphenated.slice(0, -1);
				continue;
			}
			spaced += " ";
			continue;
		}
		map.push(spaced.length);
		spaced += c;
		joined += c;
		dehyphenated += c;
	}
	map.push(spaced.length);
	return { spaced, joined, dehyphenated, map };
}

function digitsOf(s) {
	return String(s).replace(/\D/g, "");
}

// ---------------------------------------------------------------- the rules
function denyHit(s, deny) {
	if (!deny.length) return false;
	DENY_RUN_RE.lastIndex = 0;
	let m;
	while ((m = DENY_RUN_RE.exec(s)) !== null) {
		const digits = digitsOf(m[0].normalize("NFKC"));
		if (deny.some((d) => digits.includes(d))) return true;
	}
	return false;
}

function centsAmount(s) {
	CENTS_RE.lastIndex = 0;
	let m;
	while ((m = CENTS_RE.exec(s)) !== null) {
		if (!UNIT_AFTER_RE.test(s.slice(m.index + m[0].length, m.index + m[0].length + 12))) return true;
	}
	return false;
}

const SMALL_NUMBERS = new Map(["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"].map((w, i) => [w, i]));
const TENS = new Map(["twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"].map((w, i) => [w, (i + 2) * 10]));
// The numbers written in words ("one thousand two hundred" -> 1200), two words or more.
function wordNumbers(s) {
	const words = s.toLowerCase().match(/[a-z]{1,12}/g) || [];
	const out = [];
	let cur = 0;
	let total = 0;
	let n = 0;
	const flush = () => {
		if (n >= 2) out.push(total + cur);
		cur = 0;
		total = 0;
		n = 0;
	};
	for (const w of words) {
		if (SMALL_NUMBERS.has(w)) { cur += SMALL_NUMBERS.get(w); n++; continue; }
		if (TENS.has(w)) { cur += TENS.get(w); n++; continue; }
		if (w === "hundred") { cur = (cur || 1) * 100; n++; continue; }
		if (w === "thousand") { total += (cur || 1) * 1000; cur = 0; n++; continue; }
		if (w === "million") { total = (total + (cur || 1)) * 1000000; cur = 0; n++; continue; }
		if (w === "and" && n > 0) continue;
		flush();
	}
	flush();
	return out;
}

function ownAmountHit(s, ctx) {
	if (!ctx.amountDigits.size) return false;
	AMOUNT_RUN_RE.lastIndex = 0;
	let m;
	while ((m = AMOUNT_RUN_RE.exec(s)) !== null) {
		const groups = m[0].match(/\d{1,40}/g) || [];
		for (let i = 0; i < groups.length; i++) {
			let digits = "";
			for (let j = i; j < groups.length; j++) {
				if (j > i && groups[j].length !== 3) break;
				digits += groups[j];
				if (ctx.amountDigits.has(digits)) return true;
			}
		}
	}
	return wordNumbers(s).some((v) => ctx.amountDollars.has(v));
}

// Which drop rule `s` meets, or "": [counter key, staff rule].
function dropRule(s, ctx) {
	if (denyHit(s, ctx.deny)) return ["number", "number", true];
	if (carrierIdHit(s)) return ["number", "number", false];
	const plain = s.replace(INNOCENT_RE, " ");
	if (MONEY_RE.test(plain) || centsAmount(plain)) return ["money", "money", false];
	if (ownAmountHit(s, ctx)) return ["money", "number", false];
	if (TERMS_RE.test(s)) return ["terms", "terms", false];
	return null;
}

// Sentence ends: ".", "!", "?" or ";" before a space or the end, not after an initial
// ("C.H.") or a common abbreviation.
function sentences(s) {
	const out = [];
	let start = 0;
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (c !== "." && c !== "!" && c !== "?" && c !== ";") continue;
		if (i + 1 < s.length && s[i + 1] !== " ") continue;
		if (c === ".") {
			let k = i - 1;
			while (k >= start && i - k <= 8 && /[A-Za-z]/.test(s[k])) k--;
			const word = s.slice(k + 1, i).toLowerCase();
			if (word.length === 1 || ABBREVIATIONS.has(word)) continue;
		}
		const part = s.slice(start, i + 1).trim();
		if (part) out.push(part);
		start = i + 1;
	}
	const rest = s.slice(start).trim();
	if (rest) out.push(rest);
	return out;
}

// Drops each sentence telling the carrier to contact the broker; "Contact CHR for
// scheduling" becomes the fixed appointment line.
function brokerSentences(s) {
	if (!BROKER_RE.test(s)) return { text: s, changed: false };
	const kept = [];
	let changed = false;
	for (const sentence of sentences(s)) {
		if (SCHEDULING_RE.test(sentence)) {
			if (!kept.includes(APPOINTMENT_BY_DISPATCH)) kept.push(APPOINTMENT_BY_DISPATCH);
			changed = true;
			continue;
		}
		if (BROKER_RE.test(sentence) && CONTACT_VERB_RE.test(sentence)) {
			changed = true;
			continue;
		}
		kept.push(sentence);
	}
	return { text: kept.join(" "), changed };
}

// Placeholder marks (Unicode private use; normalizeText() removes any from the input).
const MASK_OPEN = String.fromCharCode(0xe000);
const MASK_CLOSE = String.fromCharCode(0xe001);
const MASK_FIRST = 0xe100;
const MASK_RE = new RegExp("\\ue000([\\ue100-\\ue1c7])\\ue001", "g");

// Whole-token occurrences of the protected values (the stop's references, the Load ID)
// swapped for placeholders that hold no digit, so the number rules leave them alone.
function maskProtected(s, values) {
	const list = [...new Set(values.filter((v) => typeof v === "string" && v.length >= 3))].sort((a, b) => b.length - a.length);
	if (!list.length) return { text: s, restore: (t) => t };
	const re = new RegExp(`(?<![A-Za-z0-9])(?:${list.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![A-Za-z0-9])`, "gi");
	const found = [];
	const text = s.replace(re, (m) => {
		if (found.length >= 200) return m;
		found.push(m);
		return `${MASK_OPEN}${String.fromCharCode(MASK_FIRST + found.length - 1)}${MASK_CLOSE}`;
	});
	return { text, restore: (t) => t.replace(MASK_RE, (_m, c) => found[c.charCodeAt(0) - MASK_FIRST]) };
}

function validTime(hh, mm) {
	return hh.length >= 1 && hh.length <= 2 && Number(hh) <= 23 && mm.length === 2 && Number(mm) <= 59;
}
function validHHMM(g) {
	return g.length === 4 && validTime(g.slice(0, 2), g.slice(2));
}
function validDate(y, m, d) {
	return Number(m) >= 1 && Number(m) <= 12 && Number(d) >= 1 && Number(d) <= 31 && (y.length === 2 || (Number(y) >= 1990 && Number(y) <= 2099));
}
// A bridged digit run that is one date ("10-24-2026", "2026-10-25"), one time or time
// range ("0700-1500", "08:00 - 17:00"), or one date followed by one time or time range
// ("10-24-2026 08:00", "10-24 0800-1500"): not a number to withhold. A chain of more
// times or dates, or a time before a date, is.
const DATE_TIME_SHAPES = new Set(["date", "time", "time time", "date time", "date time time"]);
function dateTimeRun(run) {
	const groups = run.match(/\d{1,2000}/g) || [];
	if (groups.length > 7) return false;
	const seps = run.split(/\d{1,2000}/).slice(1, -1).map((x) => x.trim());
	const kinds = [];
	let i = 0;
	while (i < groups.length) {
		const g = groups[i];
		if (i + 1 < groups.length && seps[i] === ":" && validTime(g, groups[i + 1])) { kinds.push("time"); i += 2; continue; }
		if (i + 2 < groups.length && seps[i] === seps[i + 1] && (seps[i] === "-" || seps[i] === ".")) {
			const [a, b, c] = [g, groups[i + 1], groups[i + 2]];
			if ((a.length === 4 && b.length <= 2 && c.length <= 2 && validDate(a, b, c))
				|| (a.length <= 2 && b.length <= 2 && (c.length === 2 || c.length === 4) && validDate(c, a, b))) { kinds.push("date"); i += 3; continue; }
		}
		// A month and day with no year ("10-24"), only at the start of the run.
		if (i === 0 && groups.length > 2 && (seps[0] === "-" || seps[0] === ".") && g.length <= 2 && groups[1].length <= 2 && validDate("00", g, groups[1])) { kinds.push("date"); i += 2; continue; }
		if (validHHMM(g)) { kinds.push("time"); i += 1; continue; }
		return false;
	}
	return DATE_TIME_SHAPES.has(kinds.join(" "));
}

// The deny pass on one string. Returns { text, drop, rule, flag, changedBy, denyHit,
// contacts, numbers }: `drop` the counter key when the item goes, `rule` the staff
// refusal rule, `flag` unusual_content / suspicious_text, `changedBy` the staff rule of
// the first step that changed the text. `scope.protect`: the values the 7+ digit rule
// keeps; `scope.addresses`: the sheet addresses an item may name.
function cleanText(raw, ctx, own, scope, maxChars) {
	const res = { text: "", drop: "", rule: "", flag: "", changedBy: "", denyHit: false, contacts: 0, numbers: 0 };
	if (typeof raw !== "string") { res.drop = "invalid"; res.rule = "invalid"; return res; }
	const norm = normalizeText(raw);
	if (norm === null) { res.drop = "number"; res.rule = "number"; return res; }
	if (!norm) { res.drop = "empty"; res.rule = "invalid"; return res; }
	const { spaced, joined, dehyphenated, map } = lineVariants(norm);
	const variants = [...new Set([spaced, joined, dehyphenated])];
	for (const variant of variants) {
		const hit = dropRule(variant, ctx);
		if (hit) {
			res.drop = hit[0];
			res.rule = hit[1];
			res.denyHit = hit[2];
			return res;
		}
	}
	const note = (rule) => { if (!res.changedBy) res.changedBy = rule; };
	if (variants.some((v) => INJECTION_RE.test(v))) res.flag = "suspicious_text";
	let s = spaced;
	// A contact split across a line break: found in the joined text, withheld whole.
	if (joined !== spaced) {
		// (A span that grew when mapped back holds a line break the spaced text made a space.)
		const spans = brokerContact.findContact(joined)
			.map((r) => ({ start: map[r.start], end: map[r.end - 1] + 1, length: r.end - r.start, email: joined.slice(r.start, r.end).includes("@") }))
			.filter((r) => r.end - r.start > r.length)
			.sort((a, b) => b.start - a.start);
		for (const r of spans) {
			s = s.slice(0, r.start) + CONTACT_WITHHELD + s.slice(r.end);
			res.contacts++;
			note(r.email ? "contact" : "number");
		}
	}
	// The CHR note stamp is never shown as a date.
	const stamped = s.replace(NOTE_STAMP_RE, "");
	if (stamped !== s) { s = stamped; note("number"); }
	if (NEEDS_CONFIRMATION_RE.test(s)) {
		const at = s.search(NEEDS_CONFIRMATION_RE);
		const before = s.slice(Math.max(0, at - 24), at);
		const lead = /[0-9/:.\- ]{1,24}$/.exec(before);
		if (lead && /\d/.test(lead[0])) {
			s = s.slice(0, at - lead[0].length) + s.slice(at);
			note("number");
		}
	}
	const broker = brokerSentences(s);
	if (broker.changed) { s = broker.text; note("contact"); }
	if (!s.trim()) { res.drop = "contact"; res.rule = "contact"; return res; }
	// Contacts (#525): every email and formatted phone, and the row's own contact.
	const before = s;
	const hadEmail = brokerContact.findContact(s).some((r) => s.slice(r.start, r.end).includes("@"));
	const red = brokerContact.redactContactText(s, own);
	if (red.changed) {
		s = red.text || CONTACT_WITHHELD;
		res.contacts += countOf(s, CONTACT_WITHHELD) - countOf(before, CONTACT_WITHHELD);
		note(hadEmail || digitsOf(s).length === digitsOf(before).length ? "contact" : "number");
	}
	s = s.replace(SPELLED_ANY_RE, () => { res.contacts++; note("contact"); return CONTACT_WITHHELD; });
	// 7-digit phones and 7+ digit runs, the protected values masked.
	const masked = maskProtected(s, scope.protect);
	let t = masked.text.replace(PHONE7_RE, () => { res.contacts++; note("number"); return CONTACT_WITHHELD; });
	t = t.replace(RUN7_RE, (run) => {
		if (digitsOf(run).length < 7 || dateTimeRun(run)) return run;
		res.numbers++;
		note("number");
		return NUMBER_WITHHELD;
	});
	s = masked.restore(t);
	if (s.includes("@")) { res.drop = "contact"; res.rule = "contact"; return res; }
	// A line left with fewer than 3 words once its contact is withheld, or a staff line
	// (a name, a title, a contact and no instruction), is dropped.
	if (s.includes(CONTACT_WITHHELD)) {
		const restText = s.split(CONTACT_WITHHELD).join(" ");
		const rest = restText.match(/[A-Za-z]{2,40}/g) || [];
		if (rest.length < 3 || (rest.length <= 6 && STAFF_TITLE_RE.test(restText) && !ACTION_RE.test(restText))) {
			res.drop = "contact";
			res.rule = res.changedBy || "contact";
			return res;
		}
	}
	if (!res.flag && (REDIRECT_RE.test(s) || foreignAddress(s, scope.addresses))) res.flag = "unusual_content";
	s = s.replace(/ {2,2000}/g, " ").trim();
	if (s.length > maxChars) {
		s = cutText(s, maxChars);
		note("invalid");
	}
	res.text = s;
	return res;
}

function countOf(s, part) {
	let n = 0;
	let at = s.indexOf(part);
	while (at !== -1) { n++; at = s.indexOf(part, at + part.length); }
	return n;
}

// A street address whose house number is in none of the sheet's addresses.
function foreignAddress(s, addresses) {
	STREET_RE.lastIndex = 0;
	let m;
	while ((m = STREET_RE.exec(s)) !== null) {
		const num = m[1];
		const own = addresses.some((a) => new RegExp(`(?<![0-9])${num}(?![0-9])`).test(a));
		if (!own) return true;
	}
	return false;
}

// Cut at a word boundary to at most `max` characters with "..." after it; a last word
// holding a digit, an "@" or part of a withheld marker goes too, so the cut leaves no
// fragment the next read would withhold differently.
function cutText(s, max) {
	let cut = s.slice(0, Math.max(0, max - 3));
	const sp = cut.lastIndexOf(" ");
	if (sp > 0) cut = cut.slice(0, sp);
	for (let k = 0; k < 4; k++) {
		const lastSp = cut.lastIndexOf(" ");
		const last = cut.slice(lastSp + 1);
		const openMarker = cut.lastIndexOf("[") > cut.lastIndexOf("]");
		if (!(/[\d@]/.test(last) || openMarker) || lastSp <= 0) break;
		cut = openMarker ? cut.slice(0, cut.lastIndexOf("[")).trimEnd() : cut.slice(0, lastSp);
	}
	return `${cut.trimEnd()}...`;
}

// ---------------------------------------------------------------- references
// One reference, kept verbatim or dropped: { ref, drop, reason, rule, denyHit }.
// Every rule runs on the value and on the printed label as given, and any hit drops the
// whole reference: the account numbers by their digits alone (the value's, and the label's
// and value's together), carrier identifiers, money and the load's own amounts, emails and
// phones (7-digit ones too) and the load's own contact (its phones by their digits).
function cleanReference(r, ctx, own = ctx.own) {
	const out = { ref: null, drop: "", reason: "", rule: "", denyHit: false, field: "value" };
	if (!r || typeof r !== "object" || Array.isArray(r)) { out.drop = "invalid"; out.rule = "invalid"; out.field = ""; return out; }
	if (!REFERENCE_TYPES.includes(r.type)) { out.drop = "type"; out.reason = "reference_unknown_type"; out.rule = "invalid"; out.field = "type"; return out; }
	const value = typeof r.value === "string" ? r.value.trim() : typeof r.value === "number" && Number.isSafeInteger(r.value) ? String(r.value) : "";
	if (!value) { out.drop = "invalid"; out.rule = "invalid"; return out; }
	const capped = value.slice(0, 200);
	if (digitsOf(capped).length > LIMITS.referenceDigits) { out.drop = "too_long"; out.reason = "reference_too_long"; out.rule = "number"; return out; }
	if (value.length > LIMITS.referenceChars) { out.drop = "too_long"; out.reason = "reference_too_long"; out.rule = "invalid"; return out; }
	const withheld = (rule = "number", field = "value") => { out.drop = "withheld"; out.reason = "money_or_number_withheld"; out.rule = rule; out.field = field; return out; };
	const label = typeof r.label === "string" ? normalizeText(r.label.slice(0, 200)) : "";
	if (label === null) return withheld("number", "label");
	const valueDigits = digitsOf(value.normalize("NFKC"));
	const allDigits = digitsOf(`${label} ${value}`.normalize("NFKC"));
	if (ctx.deny.some((d) => valueDigits.includes(d) || allDigits.includes(d))) { out.denyHit = true; return withheld(); }
	if (!REF_VALUE_RE.test(value)) return withheld(/@/.test(value) ? "contact" : "invalid");
	for (const [text, field] of [[value, "value"], [label, "label"]]) {
		if (!text) continue;
		if (carrierIdHit(text)) return withheld("number", field);
		const plain = text.replace(INNOCENT_RE, " ");
		if (MONEY_RE.test(plain) || centsAmount(plain) || /^\d{1,9}\.\d{2}$/.test(text)) return withheld("money", field);
		if (ownAmountHit(text, ctx)) return withheld("number", field);
		const contact = contactRule(text, own);
		if (contact) return withheld(contact, field);
	}
	const phones = own && own.phones ? [...own.phones] : [];
	if (phones.some((p) => valueDigits.includes(p) || (valueDigits.length >= 7 && valueDigits.includes(p.slice(3))))) return withheld();
	out.ref = { type: r.type, label: cleanLabel(label, r.type, ctx), value };
	return out;
}

// "contact" (an email or the load's own contact name), "number" (a phone, 7-digit ones
// too, or the load's own phone) or "".
function contactRule(text, own) {
	const found = brokerContact.findContact(text);
	if (found.some((r) => text.slice(r.start, r.end).includes("@")) || SPELLED_ANY_ONE_RE.test(text)) return "contact";
	if (found.length || PHONE7_ONE_RE.test(text)) return "number";
	const red = brokerContact.redactContactText(text, own);
	if (red.changed) return digitsOf(red.text).length < digitsOf(text).length ? "number" : "contact";
	return "";
}

// A printed label is kept when it is a short plain label; anything else gets the type's
// own label. labelRule() says why not: "" (kept or blank), "invalid" (not a plain label),
// "number" (a number, an account number or a phone in it), "money".
function labelRule(label, ctx) {
	if (label == null) return "";
	if (typeof label !== "string") return "invalid";
	const s = label.trim();
	if (!s) return "";
	if (s.length > LIMITS.labelChars || !REF_LABEL_RE.test(s)) return "invalid";
	if (denyHit(s, ctx.deny) || T_NUMBER_RE.test(s) || digitsOf(s).length >= 4 || brokerContact.findContact(s).length) return "number";
	if (MONEY_RE.test(s.replace(INNOCENT_RE, " "))) return "money";
	return "";
}

function cleanLabel(label, type, ctx) {
	const s = typeof label === "string" ? label.trim() : "";
	return s && !labelRule(s, ctx) ? s : REFERENCE_LABELS[type];
}

function cleanPlace(place) {
	const s = typeof place === "string" ? place.trim() : "";
	if (!s || s.length > LIMITS.placeChars) return "";
	const m = PLACE_RE.exec(s.replace(/ {2,2000}/g, " "));
	return m ? `${m[1].trim()}, ${m[2].toUpperCase()}` : "";
}

// ---------------------------------------------------------------- the allowlist
function newRun(ctx, extraContacts) {
	const own = extraContacts.length
		? brokerContact.ownContact([...ctx.contactEntries, ...extraContacts.map((v) => ["Contact", v])])
		: ctx.own;
	return {
		ctx,
		own,
		denyHit: false,
		reasons: new Set(),
		reasonCounts: {},
		counts: { droppedItems: {}, droppedReferences: {}, withheldContacts: 0, withheldNumbers: 0, flaggedItems: 0 },
	};
}

function bump(obj, key, n = 1) {
	obj[key] = (obj[key] || 0) + n;
}

function addReason(run, code, n = 1) {
	run.reasons.add(code);
	bump(run.reasonCounts, code, n);
}

function cleanItems(list, run, scope, max, kind) {
	const out = [];
	for (const item of Array.isArray(list) ? list : []) {
		if (out.length >= max) { bump(run.counts.droppedItems, "caps"); continue; }
		if (!item || typeof item !== "object" || Array.isArray(item)) { bump(run.counts.droppedItems, "invalid"); continue; }
		const key = kind === "requirement" ? String(item.category == null ? "" : item.category).trim().toLowerCase().slice(0, 40) : String(item.kind == null ? "" : item.kind).trim().toLowerCase().slice(0, 40);
		const allowed = kind === "requirement" ? REQUIREMENT_CATEGORIES : INSTRUCTION_KINDS;
		if (!allowed.includes(key)) { bump(run.counts.droppedItems, "category"); continue; }
		const r = cleanText(item.text, run.ctx, run.own, scope, LIMITS.textChars);
		if (r.denyHit) run.denyHit = true;
		if (r.drop) { bump(run.counts.droppedItems, r.drop); continue; }
		run.counts.withheldContacts += r.contacts;
		run.counts.withheldNumbers += r.numbers;
		let flag = r.flag;
		if (!flag && key === "other") flag = "unusual_content";
		const entry = kind === "requirement" ? { category: key, text: r.text, critical: CRITICAL_CATEGORIES.includes(key) } : { kind: key, text: r.text };
		if (flag) {
			entry.flag = flag;
			run.counts.flaggedItems++;
			addReason(run, flag);
		}
		out.push(entry);
	}
	return out;
}

function cleanStop(stop, run) {
	if (!stop || typeof stop !== "object" || Array.isArray(stop)) return null;
	const kind = String(stop.kind == null ? "" : stop.kind).trim().toLowerCase();
	if (!STOP_KINDS.includes(kind)) return null;
	const references = [];
	const seen = new Set();
	for (const r of Array.isArray(stop.references) ? stop.references : []) {
		if (references.length >= LIMITS.referencesPerStop) { bump(run.counts.droppedReferences, "caps"); continue; }
		const c = cleanReference(r, run.ctx, run.own);
		if (c.denyHit) run.denyHit = true;
		if (!c.ref) {
			bump(run.counts.droppedReferences, c.drop);
			if (c.reason) addReason(run, c.reason);
			continue;
		}
		const key = `${c.ref.type}\u0000${c.ref.value.toUpperCase()}`;
		if (seen.has(key)) continue;
		seen.add(key);
		references.push(c.ref);
	}
	const scope = { protect: [...references.map((r) => r.value), run.ctx.loadId], addresses: run.ctx.addresses };
	const facility = cleanText(typeof stop.facility === "string" ? stop.facility : "", run.ctx, run.own, scope, LIMITS.facilityChars);
	if (facility.denyHit) run.denyHit = true;
	return {
		seq: 0,
		kind,
		facility: facility.drop || facility.flag ? "" : facility.text,
		place: cleanPlace(stop.place),
		references,
		requirements: cleanItems(stop.requirements, run, scope, LIMITS.requirementsPerStop, "requirement"),
		instructions: cleanItems(stop.instructions, run, scope, LIMITS.instructionsPerStop, "instruction"),
	};
}

function emptyPayload() {
	return { v: SCHEMA_VERSION, loadRequirements: [], stops: [], footnote: FOOTNOTE };
}

// The only shape a driver can receive, built from `raw` (an extraction, a staff edit or a
// stored payload): { payload, reasons, reasonCounts, counts, denyHit }. `payload` is the
// staff view (flagged items carry `flag`); driverView() is what a driver may get.
function filterInstructions(raw, ctx) {
	const c = requireContext(ctx);
	const src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
	const extra = Array.isArray(src.contacts) ? src.contacts.slice(0, LIMITS.extraContacts).filter((v) => typeof v === "string").map((v) => v.slice(0, 200)) : [];
	const run = newRun(c, extra);
	const stops = [];
	for (const st of Array.isArray(src.stops) ? src.stops : []) {
		if (stops.length >= LIMITS.stops) { bump(run.counts.droppedItems, "caps"); continue; }
		const s = cleanStop(st, run);
		if (s) stops.push(s);
	}
	stops.forEach((s, i) => { s.seq = i + 1; });
	const allRefs = stops.flatMap((s) => s.references.map((r) => r.value));
	const loadScope = { protect: [...allRefs, c.loadId], addresses: c.addresses };
	const payload = {
		v: SCHEMA_VERSION,
		loadRequirements: cleanItems(src.loadRequirements, run, loadScope, LIMITS.loadRequirements, "requirement"),
		stops,
		footnote: FOOTNOTE,
	};
	capPayload(payload, run);
	placeMismatch(stops, c, run);
	return {
		payload,
		reasons: REASON_ORDER.filter((code) => run.reasons.has(code)),
		reasonCounts: run.reasonCounts,
		counts: run.counts,
		denyHit: run.denyHit,
	};
}

// Over LIMITS.payloadBytes, items go from the end: the last stop's instructions, then
// its requirements, then its references, then the load's requirements.
function capPayload(payload, run) {
	let size = Buffer.byteLength(JSON.stringify(payload));
	if (size <= LIMITS.payloadBytes) return;
	const lists = [];
	for (const s of payload.stops) lists.push(s.references, s.requirements, s.instructions);
	lists.push(payload.loadRequirements);
	for (let k = lists.length - 1; k >= 0 && size > LIMITS.payloadBytes; k--) {
		const list = lists[k];
		while (list.length && size > LIMITS.payloadBytes) {
			size -= Buffer.byteLength(JSON.stringify(list.pop())) + 1;
			bump(run.counts.droppedItems, "caps");
		}
	}
}

// The first pickup's and the last delivery's place against the sheet's pickup and
// drop-off address; unknown on either side is not a mismatch.
function placeMismatch(stops, ctx, run) {
	const firstPickup = stops.find((s) => s.kind === "pickup");
	const lastDelivery = [...stops].reverse().find((s) => s.kind === "delivery");
	for (const [stop, sheet] of [[firstPickup, ctx.sheet.pickup], [lastDelivery, ctx.sheet.delivery]]) {
		if (!stop || !stop.place || !sheet || !sheet.city) continue;
		const m = PLACE_RE.exec(stop.place);
		if (!m) continue;
		if (normCity(m[1]) !== sheet.city || (sheet.state && m[2].toUpperCase() !== sheet.state)) {
			addReason(run, "stop_place_mismatch");
			return;
		}
	}
}

// ---------------------------------------------------------------- read time
function parseStored(stored) {
	if (stored && typeof stored === "object" && !Array.isArray(stored)) return stored;
	if (typeof stored !== "string" || !stored || stored.length > LIMITS.storedBytes) return null;
	try {
		const v = JSON.parse(stored);
		return v && typeof v === "object" && !Array.isArray(v) ? v : null;
	} catch {
		return null;
	}
}

function canonical(v, depth = 0) {
	if (depth > 8) return "null";
	if (Array.isArray(v)) return `[${v.map((x) => canonical(x, depth + 1)).join(",")}]`;
	if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k], depth + 1)}`).join(",")}}`;
	return JSON.stringify(v === undefined ? null : v);
}

function withoutFlags(payload) {
	const strip = (items) => (Array.isArray(items) ? items.map((x) => {
		if (!x || typeof x !== "object") return x;
		const { flag, ...rest } = x;
		return rest;
	}) : items);
	return {
		...payload,
		loadRequirements: strip(payload.loadRequirements),
		stops: Array.isArray(payload.stops) ? payload.stops.map((s) => (s && typeof s === "object" ? { ...s, requirements: strip(s.requirements), instructions: strip(s.instructions) } : s)) : payload.stops,
	};
}

// The stored payload for staff, re-filtered with the current rules and values: { payload,
// changed, reasons, denyHit }. `changed` means the row needs `refiltered`.
function staffView(stored, ctx) {
	requireContext(ctx);
	const parsed = parseStored(stored);
	if (!parsed) return { payload: emptyPayload(), changed: true, reasons: ["refiltered"], denyHit: false };
	const r = filterInstructions(parsed, ctx);
	const changed = canonical(withoutFlags(r.payload)) !== canonical(withoutFlags(parsed));
	const reasons = changed ? REASON_ORDER.filter((code) => code === "refiltered" || r.reasons.includes(code)) : r.reasons;
	return { payload: r.payload, changed, reasons, denyHit: r.denyHit };
}

// What a driver may get from a stored payload: re-filtered, and every flagged item
// (another address, redirect wording, `other`, an injection marker) hidden.
function driverView(stored, ctx) {
	const s = staffView(stored, ctx);
	const keep = (items) => items.filter((x) => !x.flag);
	const p = s.payload;
	return {
		payload: {
			v: p.v,
			loadRequirements: keep(p.loadRequirements),
			stops: p.stops.map((st) => ({ ...st, requirements: keep(st.requirements), instructions: keep(st.instructions) })),
			footnote: p.footnote,
		},
		changed: s.changed,
		denyHit: s.denyHit,
	};
}

function isPublished(row) {
	return !!(row && (row.published_at || row.publishedAt));
}

// ---------------------------------------------------------------- staff edits
// A staff edit is refused, never cleaned (plan §3.2): { ok: true, payload } or
// { ok: false, status: 400, code, rule, field, denyHit }. Every number rule answers
// rule "number"; refusalBody() is all a response may carry (denyHit is for the server's
// own alert count only).
function validateStaffEdit(body, ctx) {
	const c = requireContext(ctx);
	const invalid = (field) => ({ ok: false, status: 400, code: INVALID_CODE, rule: "", field, denyHit: false });
	const refuse = (rule, field, deny = false) => ({ ok: false, status: 400, code: REFUSAL_CODE, rule, field, denyHit: !!deny });
	if (!body || typeof body !== "object" || Array.isArray(body)) return invalid("payload");
	const lr = body.loadRequirements == null ? [] : body.loadRequirements;
	const stops = body.stops == null ? [] : body.stops;
	if (!Array.isArray(lr) || lr.length > LIMITS.loadRequirements) return invalid("loadRequirements");
	if (!Array.isArray(stops) || stops.length > LIMITS.stops) return invalid("stops");
	const own = c.own;
	const checkItems = (list, path, kind, scope, max) => {
		if (list == null) return null;
		if (!Array.isArray(list) || list.length > max) return invalid(path);
		for (let i = 0; i < list.length; i++) {
			const item = list[i];
			const at = `${path}[${i}]`;
			if (!item || typeof item !== "object" || Array.isArray(item)) return invalid(at);
			const key = kind === "requirement" ? item.category : item.kind;
			if (!(kind === "requirement" ? REQUIREMENT_CATEGORIES : INSTRUCTION_KINDS).includes(key)) return invalid(`${at}.${kind === "requirement" ? "category" : "kind"}`);
			if (typeof item.text !== "string" || !item.text.trim() || item.text.length > LIMITS.textChars) return invalid(`${at}.text`);
			const r = cleanText(item.text, c, own, scope, LIMITS.textChars);
			if (r.drop) return r.rule === "invalid" ? invalid(`${at}.text`) : refuse(r.rule, `${at}.text`, r.denyHit);
			if (r.changedBy) return r.changedBy === "invalid" ? invalid(`${at}.text`) : refuse(r.changedBy, `${at}.text`);
			if (r.flag) return refuse("unusual", `${at}.text`);
		}
		return null;
	};
	const refs = [];
	for (let i = 0; i < stops.length; i++) {
		const st = stops[i];
		const at = `stops[${i}]`;
		if (!st || typeof st !== "object" || Array.isArray(st)) return invalid(at);
		if (!STOP_KINDS.includes(st.kind)) return invalid(`${at}.kind`);
		if (st.facility != null && (typeof st.facility !== "string" || st.facility.length > LIMITS.facilityChars)) return invalid(`${at}.facility`);
		if (st.place != null && st.place !== "" && !cleanPlace(st.place)) return invalid(`${at}.place`);
		const list = st.references == null ? [] : st.references;
		if (!Array.isArray(list) || list.length > LIMITS.referencesPerStop) return invalid(`${at}.references`);
		const stopRefs = [];
		for (let k = 0; k < list.length; k++) {
			const ref = list[k];
			const rat = `${at}.references[${k}]`;
			const lr = ref && typeof ref === "object" && !Array.isArray(ref) ? labelRule(ref.label, c) : "";
			if (lr === "invalid") return invalid(`${rat}.label`);
			if (lr) return refuse(lr, `${rat}.label`, lr === "number" && denyHit(String(ref.label), c.deny));
			const r = cleanReference(ref, c, c.own);
			if (!r.ref) {
				if (r.rule === "invalid") return invalid(r.field ? `${rat}.${r.field}` : rat);
				return refuse(r.rule, `${rat}.${r.field || "value"}`, r.denyHit);
			}
			stopRefs.push(r.ref.value);
		}
		refs.push(stopRefs);
		if (st.facility) {
			const f = cleanText(st.facility, c, own, { protect: [...stopRefs, c.loadId], addresses: c.addresses }, LIMITS.facilityChars);
			if (f.drop) return f.rule === "invalid" ? invalid(`${at}.facility`) : refuse(f.rule, `${at}.facility`, f.denyHit);
			if (f.changedBy) return f.changedBy === "invalid" ? invalid(`${at}.facility`) : refuse(f.changedBy, `${at}.facility`);
			if (f.flag) return refuse("unusual", `${at}.facility`);
		}
		const scope = { protect: [...stopRefs, c.loadId], addresses: c.addresses };
		const bad = checkItems(st.requirements, `${at}.requirements`, "requirement", scope, LIMITS.requirementsPerStop)
			|| checkItems(st.instructions, `${at}.instructions`, "instruction", scope, LIMITS.instructionsPerStop);
		if (bad) return bad;
	}
	const bad = checkItems(lr, "loadRequirements", "requirement", { protect: [...refs.flat(), c.loadId], addresses: c.addresses }, LIMITS.loadRequirements);
	if (bad) return bad;
	const r = filterInstructions(body, c);
	return { ok: true, payload: r.payload, reasons: r.reasons };
}

function refusalBody(res) {
	if (!res || res.ok) return null;
	if (res.code === INVALID_CODE) return { error: INVALID_MESSAGE, code: INVALID_CODE, field: res.field, rule: "" };
	return { error: REFUSAL_MESSAGE, code: REFUSAL_CODE, rule: res.rule, field: res.rule === "number" ? fieldKind(res.field) : res.field };
}

// A number refusal names the kind of field, never which item: "references" for any
// part of a reference, else the field's own name ("text", "facility"). The full
// path stays in the caller's audit row.
function fieldKind(field) {
	const parts = String(field || "").replace(/\[\d{1,4}\]/g, "").split(".").filter(Boolean);
	if (parts.includes("references")) return "references";
	return parts.length ? parts[parts.length - 1] : "payload";
}

// ---------------------------------------------------------------- publish rule
// What a new extraction does to the stored row (plan §2.2, §4; decision 3). A first
// extraction is published when it has no review reason, else it waits hidden for a
// person. Afterwards a new extraction replaces the payload only when it has no review
// reason, no person reviewed or edited the current one, and no driver has read it;
// otherwise it waits in `pending` (rate_con_changed) and the current one stays. A failed
// extraction never replaces anything. `current`: the row (snake_case or camelCase) or
// null; `next`: { payload, reasons, failed }.
// Answers { action: insert | replace | pending | unchanged, status, publish, pendingReasons }.
function decideExtractionWrite(current, next) {
	const n = next || {};
	const reasons = [...new Set(Array.isArray(n.reasons) ? n.reasons : [])];
	const get = (k1, k2) => (current ? current[k1] || current[k2] || "" : "");
	if (!current) {
		if (n.failed) return { action: "insert", status: "failed", publish: false, pendingReasons: [] };
		return { action: "insert", status: reasons.length ? "needs_review" : "auto", publish: !reasons.length, pendingReasons: [] };
	}
	const status = current.status || "";
	if (n.failed) return { action: "unchanged", status, publish: false, pendingReasons: [] };
	const touched = status === "reviewed" || !!get("reviewed_at", "reviewedAt") || !!get("reviewed_by", "reviewedBy") || current.source === "staff";
	const shown = !!get("driver_shown_at", "driverShownAt");
	const stored = parseStored(current.payload);
	if (!stored || status === "failed" || status === "none") {
		if (!touched && !shown) return { action: "replace", status: reasons.length ? "needs_review" : "auto", publish: !reasons.length, pendingReasons: [] };
	} else if (canonical(withoutFlags(stored)) === canonical(withoutFlags(n.payload || {}))) {
		return { action: "unchanged", status, publish: false, pendingReasons: [] };
	}
	if (!reasons.length && !touched && !shown) return { action: "replace", status: "auto", publish: true, pendingReasons: [] };
	return { action: "pending", status, publish: false, pendingReasons: ["rate_con_changed", ...reasons.filter((r) => r !== "rate_con_changed")] };
}

// ---------------------------------------------------------------- Needs Review heuristic
// Requirement keyword families on the rate con, and the categories that answer each.
const FAMILIES = [
	["high_value", /high[ -]{0,2}value/i, ["high_value"]],
	["no_unattended", /unattended/i, ["no_unattended", "high_value"]],
	["seal", /\bseal(?:s|ed)?\b/i, ["seal"]],
	["ppe", /\bPPE\b|hard[ -]{0,2}hats?|safety[ ]{1,3}(?:glasses|goggles|vests?|shoes|boots)|hi[ -]{0,2}vis|steel[ -]{0,2}toe|closed[ -]{0,2}toe|\bgoggles\b/i, ["ppe"]],
	["securement", /\bstraps?\b|load[ -]{0,2}locks?|bulkheads?|load[ -]{0,2}bars?/i, ["securement", "equipment"]],
	["temperature", /\breefer\b|temperature|\bfreeze\b|\bfrozen\b/i, ["temperature"]],
	["food_grade", /food[ -]{0,2}grade/i, ["food_grade", "equipment"]],
	["team", /\bteam[ ]{1,3}(?:drivers?|service|required|load)\b/i, ["team", "same_driver"]],
	["tarp", /\btarps?\b/i, ["tarp"]],
	["hazmat", /haz[ -]{0,2}mat|\bplacard/i, ["hazmat"]],
	["twic", /\bTWIC\b/i, ["twic"]],
	["photos", /\bphotos?\b|\bpictures?\b/i, ["photos"]],
	["scale_weight", /\bscale[sd]?\b|axle[ ]{0,2}weights?|over[ ]{0,2}weight/i, ["scale_weight"]],
	["tandems", /\btandems?\b/i, ["tandems", "equipment"]],
	["drop_trailer", /drop[ -]{0,2}(?:trailer|&[ ]{0,2}hook|and[ ]{0,2}hook)/i, ["drop_trailer"]],
];
// Sections of a rate con that are never driver text: from one of these to the next
// driver section (or the end).
const BOILERPLATE_START = ["rate details", "payment information", "submit freight bill", "contract addendum", "additional terms", "requires automated shipment check-in"];
const DRIVER_SECTION = ["shipper#", "shipper #", "receiver#", "receiver #", "customer requirements", "customer-specified", "warehouse notes", "driving directions", "high value", "shipper instructions", "receiver instructions"];

function positionsOf(lower, word, out, tag) {
	let at = lower.indexOf(word);
	let n = 0;
	while (at !== -1 && n < 2000) {
		out.push([at, tag, word.length]);
		at = lower.indexOf(word, at + word.length);
		n++;
	}
}

function stripBoilerplate(text) {
	const lower = text.toLowerCase();
	const marks = [];
	for (const w of BOILERPLATE_START) positionsOf(lower, w, marks, "start");
	for (const w of DRIVER_SECTION) positionsOf(lower, w, marks, "end");
	if (!marks.some((m) => m[1] === "start")) return text;
	marks.sort((a, b) => a[0] - b[0]);
	let out = "";
	let at = 0;
	let from = -1;
	for (const [pos, tag] of marks) {
		if (tag === "start" && from === -1 && pos >= at) { out += text.slice(at, pos); from = pos; }
		else if (tag === "end" && from !== -1) { at = pos; from = -1; }
	}
	if (from === -1) out += text.slice(at);
	return out;
}

function alnumUpper(s) {
	return String(s == null ? "" : s).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// Every string the extractor returned (references, texts, facility, place, address),
// alnum and upper case: the tokens and the whole, for "is this token in it".
function extractionHaystack(extraction) {
	const parts = [];
	const add = (v) => { if (typeof v === "string" && v) parts.push(v.slice(0, LIMITS.rawChars)); };
	const src = extraction && typeof extraction === "object" ? extraction : {};
	for (const r of Array.isArray(src.loadRequirements) ? src.loadRequirements.slice(0, 100) : []) add(r && r.text);
	for (const s of Array.isArray(src.stops) ? src.stops.slice(0, 20) : []) {
		if (!s || typeof s !== "object") continue;
		add(s.facility); add(s.place); add(s.address);
		for (const r of Array.isArray(s.references) ? s.references.slice(0, 50) : []) add(r && (typeof r.value === "number" ? String(r.value) : r.value));
		for (const r of Array.isArray(s.requirements) ? s.requirements.slice(0, 100) : []) add(r && r.text);
		for (const r of Array.isArray(s.instructions) ? s.instructions.slice(0, 100) : []) add(r && r.text);
	}
	const tokens = new Set();
	for (const p of parts) for (const t of p.split(/[^A-Za-z0-9-]{1,2000}/)) { const a = alnumUpper(t); if (a) tokens.add(a); }
	return { tokens, joined: parts.map(alnumUpper).join("|") };
}

function extractedCategories(extraction, payload) {
	const cats = new Set();
	const src = extraction && typeof extraction === "object" ? extraction : {};
	const add = (r) => { if (r && typeof r.category === "string") cats.add(r.category.trim().toLowerCase().slice(0, 40)); };
	(Array.isArray(src.loadRequirements) ? src.loadRequirements.slice(0, 100) : []).forEach(add);
	for (const s of Array.isArray(src.stops) ? src.stops.slice(0, 20) : []) if (s && Array.isArray(s.requirements)) s.requirements.slice(0, 100).forEach(add);
	payload.loadRequirements.forEach(add);
	for (const s of payload.stops) s.requirements.forEach(add);
	return cats;
}

// A token on the rate con that is not a reference: the Load ID, a date, a time range, a
// ZIP+4, a phone shape, the account number (its shape or a deny value).
function notAReference(tok, text, start, ctx) {
	const a = alnumUpper(tok);
	if (ctx.loadId && a === alnumUpper(ctx.loadId)) return true;
	if (/^\d{8}$/.test(tok) && validDate(tok.slice(0, 4), tok.slice(4, 6), tok.slice(6))) return true;
	if (/^\d{1,2}-\d{1,2}-(?:\d{2}|\d{4})$/.test(tok) || /^\d{4}-\d{1,2}-\d{1,2}$/.test(tok)) return true;
	if (/^\d{3,4}-\d{3,4}$/.test(tok) && tok.split("-").every((g) => validHHMM(g.padStart(4, "0")))) return true;
	if (/^\d{5}-\d{4}$/.test(tok)) return true;
	if (/^\d{3}-\d{4}$/.test(tok) || /^1?-?\d{3}-\d{3}-\d{4}$/.test(tok)) return true;
	if (/^T-?\d{5,9}$/i.test(tok)) return true;
	const pre = /(^|[^A-Za-z0-9])t[ #:.-]{0,3}$/i.exec(text.slice(Math.max(0, start - 6), start));
	if (pre && (pre[1] !== "" || start <= 6)) return true;
	if (ctx.deny.some((d) => digitsOf(tok).includes(d))) return true;
	const win = text.slice(Math.max(0, start - 30), start + tok.length + 2);
	if (brokerContact.findContact(win).some((r) => r.end > win.length - tok.length - 2)) return true;
	return false;
}

// Reference-shaped tokens of the visible text: 6-24 of [A-Z0-9-] with 4+ digits.
function referenceTokens(text, cap) {
	const out = [];
	const seen = new Set();
	let i = 0;
	const n = text.length;
	while (i < n && out.length < cap) {
		const c = text.charCodeAt(i);
		const word = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45;
		if (!word) { i++; continue; }
		let e = i + 1;
		while (e < n) {
			const d = text.charCodeAt(e);
			if (!((d >= 48 && d <= 57) || (d >= 65 && d <= 90) || (d >= 97 && d <= 122) || d === 45)) break;
			e++;
		}
		let s = i;
		let t = e;
		while (s < t && text.charCodeAt(s) === 45) s++;
		while (t > s && text.charCodeAt(t - 1) === 45) t--;
		const tok = text.slice(s, t);
		if (tok.length >= 6 && tok.length <= 24 && digitsOf(tok).length >= 4) {
			const key = tok.toUpperCase();
			if (!seen.has(key)) { seen.add(key); out.push([tok, s]); }
		}
		i = e;
	}
	return out;
}

function stopHeaderCount(text) {
	const count = (re) => {
		const set = new Set();
		re.lastIndex = 0;
		let m;
		let k = 0;
		while ((m = re.exec(text)) !== null && k++ < 2000) set.add(m[1]);
		return set.size;
	};
	const sr = count(/SHIPPER[ ]{0,2}#[ ]{0,2}(\d{1,2})\b/gi) + count(/RECEIVER[ ]{0,2}#[ ]{0,2}(\d{1,2})\b/gi);
	if (sr) return sr;
	const stops = count(/\bStop[ ]{0,2}#?[ ]{0,2}(\d{1,2})\b/gi);
	if (stops) return stops;
	return count(/\bPick[ ]{0,2}#?[ ]{0,2}(\d{1,2})\b/gi) + count(/\bDrop[ ]{0,2}#?[ ]{0,2}(\d{1,2})\b/gi);
}

// The Needs Review reasons for one extraction (plan §5): { codes, counts }. `extraction`:
// the extractor's answer; `filtered`: filterInstructions() of it (computed when absent);
// `visibleText`: pdfVisibleText() of the PDF ("" or null when not read); `byteLength`:
// the PDF's size; `source`: "dropzone" checks the load number against `loadId`;
// `failed`: the extraction failed or was invalid. no_rate_con, refiltered and
// rate_con_changed come from the routes and the publish rule.
function reviewReasons(o = {}) {
	const ctx = requireContext(o.ctx);
	if (o.failed) return { codes: ["extract_failed"], counts: {} };
	const filtered = o.filtered && o.filtered.payload ? o.filtered : filterInstructions(o.extraction, ctx);
	const codes = new Set(filtered.reasons);
	const counts = { ...filtered.reasonCounts };
	const extraction = o.extraction && typeof o.extraction === "object" ? o.extraction : {};
	const loadId = o.loadId != null ? String(o.loadId).slice(0, 40) : ctx.loadId;
	if (o.source === "dropzone" && loadId) {
		const got = alnumUpper(typeof extraction.loadNumber === "string" || typeof extraction.loadNumber === "number" ? String(extraction.loadNumber).slice(0, 40) : "");
		if (!got || got !== alnumUpper(loadId)) codes.add("load_number_unconfirmed");
	}
	const text = typeof o.visibleText === "string" ? o.visibleText.slice(0, kpiWeight.MAX_TEXT_CHARS) : "";
	const readable = !!text && kpiWeight.classifyPdfText(text, o.byteLength) === "ok";
	const p = filtered.payload;
	const found = p.loadRequirements.length > 0 || p.stops.some((s) => s.references.length || s.requirements.length);
	if (!readable) {
		if (found) codes.add("not_cross_checked");
	} else {
		const body = stripBoilerplate(text);
		const hay = extractionHaystack(extraction);
		const tctx = { ...ctx, loadId: ctx.loadId || loadId };
		let missed = 0;
		for (const [tok, start] of referenceTokens(body, LIMITS.heuristicCandidates)) {
			if (notAReference(tok, body, start, tctx)) continue;
			const a = alnumUpper(tok);
			const core = a.replace(/^[A-Z]{1,4}(?=\d)/, "");
			if (hay.tokens.has(a) || hay.tokens.has(core) || hay.joined.includes(a) || (core.length >= 4 && hay.joined.includes(core))) continue;
			missed++;
		}
		if (missed) { codes.add("reference_missed"); counts.reference_missed = missed; }
		const visible = alnumUpper(text);
		let invented = 0;
		for (const s of p.stops) for (const r of s.references) if (!visible.includes(alnumUpper(r.value))) invented++;
		if (invented) { codes.add("reference_not_on_rate_con"); counts.reference_not_on_rate_con = invented; }
		const cats = extractedCategories(extraction, p);
		const missing = FAMILIES.filter(([, re, answers]) => re.test(body) && !answers.some((c) => cats.has(c))).map(([fam]) => fam);
		if (missing.length) { codes.add("requirement_missed"); counts.requirement_missed = missing; }
		const headers = stopHeaderCount(text);
		if (headers && headers !== p.stops.length) codes.add("stop_count_mismatch");
	}
	return { codes: REASON_ORDER.filter((c) => codes.has(c)), counts };
}

// Staff text for each code, counts and category names only.
function reasonMessages(codes, counts = {}) {
	return (Array.isArray(codes) ? codes : []).filter((c) => REVIEW_REASONS[c]).map((code) => {
		const v = counts ? counts[code] : undefined;
		const n = typeof v === "number" && Number.isFinite(v) ? Math.max(1, Math.floor(v)) : 1;
		const list = Array.isArray(v) ? v.filter((x) => CATEGORY_LABELS[x]).map((x) => CATEGORY_LABELS[x].toLowerCase()).join(", ") : "";
		return { code, text: REVIEW_REASONS[code].replace("{n}", String(n)).replace("{list}", list || "some requirements") };
	});
}

module.exports = {
	SCHEMA_VERSION,
	REFERENCE_TYPES,
	REFERENCE_LABELS,
	REQUIREMENT_CATEGORIES,
	CATEGORY_LABELS,
	CRITICAL_CATEGORIES,
	INSTRUCTION_KINDS,
	STOP_KINDS,
	LIMITS,
	FOOTNOTE,
	APPOINTMENT_BY_DISPATCH,
	CONTACT_WITHHELD,
	NUMBER_WITHHELD,
	REFUSAL_CODE,
	INVALID_CODE,
	REVIEW_REASONS,
	parseDenyList,
	denyListConfigured,
	buildContext,
	filterInstructions,
	emptyPayload,
	staffView,
	driverView,
	isPublished,
	validateStaffEdit,
	refusalBody,
	decideExtractionWrite,
	reviewReasons,
	reasonMessages,
};
