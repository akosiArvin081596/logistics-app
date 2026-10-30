"use strict";
// C.H. Robinson updates: which loads are CHR's, which milestone events a load's
// status history makes, and the only payload shape that may ever leave LogisX.
// Nothing CHR-bound is built by copying a record: buildPayload() takes named
// values, each checked against its own rule, and drops what fails.
//
// Pure: no network, database, files, environment or clock.

const autoInvoiceRules = require("./auto-invoice-rules");
const brokerContact = require("./broker-contact");
const driverInstructions = require("./driver-instructions");
const { normalizeLoadId } = require("./ratecon-load");
const { stopZone, stateFromAddress } = require("./stop-zone");

const CHR_DOMAIN = "chrobinson.com";
const LOAD_NUMBER_RE = /^\d{9}$/;
const UNIT_RE = /^[A-Za-z0-9-]{1,12}$/;
const CITY_RE = /^[A-Za-z .'-]{1,40}$/;
// Shapes that read as a person's data although they fit the unit pattern.
const SSN_SHAPE_RE = /^\d{3}-\d{2}-\d{4}$/;
const PHONE7_SHAPE_RE = /^\d{3}-\d{4}$/;
const DATE_SHAPE_RE = /^(?:\d{1,2}-\d{1,2}-(?:\d{2}|\d{4})|\d{4}-\d{1,2}-\d{1,2})$/;
const STATE_PART_RE = /^([A-Za-z]{2})\.?(?:\s{1,3}\d{5}(?:-\d{4})?)?$/;
const COUNTRY_PART_RE = /^(?:USA?|United States)$/i;
const WITHHELD = "[withheld]";

const MILESTONE_EVENTS = Object.freeze(["arrived_pickup", "departed_pickup", "arrived_delivery", "departed_delivery", "delivered"]);
const PICKUP_EVENTS = Object.freeze(["arrived_pickup", "departed_pickup"]);
const FINAL_EVENTS = Object.freeze(["arrived_delivery", "delivered"]);
const PROJECTION_KEYS = Object.freeze(["loadKey", "loadId", "brokerDomain", "trailer", "pickupAddress", "dropoffAddress", "driverName"]);
const PAYLOAD_KEYS = Object.freeze(["loadNumber", "event", "stop", "eventAt", "eventLocal", "place", "position", "truck", "trailer"]);
// What manual and override rows hold (server.js STATUS_OVERRIDE_ALLOWED).
const STATUS_LIST = Object.freeze(["Dispatched", "Heading to Shipper", "At Shipper", "Loading", "In Transit", "At Receiver", "Delivered"]);
const CANCELLED_RE = /^(cancel|canceled|cancelled)$/i;
// The cells server.js's buildRateConLoadCtx() reads (a runner pins them), and
// the Driver column. The Payment column is never read here.
const COLUMN_RULES = Object.freeze({
	loadId: /load.?id|job.?id/i,
	email: /^email$/i,
	trailer: /trailer/i,
	pickupAddress: /pickup.*address/i,
	dropoffAddress: /drop.?off.*address|deliv.*address/i,
	driver: /^driver$/i,
});
// A revert can undo a true next stop (an override used to record it), so the
// page asks a person to check CHR's copy rather than to correct it.
const REVERTED_NOTE = "Sent, then reverted: check it in Navisphere.";
// Named columns only: actor (a driver's name) and reason (internal notes) are
// never read.
const HISTORY_SQL = Object.freeze({
	above: "SELECT id, load_id, old_status, new_status, source, changed_at FROM load_status_history WHERE id > ? ORDER BY id ASC LIMIT ?",
	forLoad: "SELECT id, load_id, old_status, new_status, source, changed_at FROM load_status_history WHERE load_id = ? ORDER BY changed_at ASC, id ASC",
	maxId: "SELECT COALESCE(MAX(id), 0) AS id FROM load_status_history",
});

// ------------------------------------------------------------------ loads

const loadKey = normalizeLoadId;
const domainOf = autoInvoiceRules.emailDomain;

// The sheet's Load ID as CHR knows it: one leading "#" dropped.
function loadNumberOf(v) {
	return String(v == null ? "" : v).trim().replace(/^#/, "").trim();
}

function isChrDomain(domain) {
	return typeof domain === "string" && (domain === CHR_DOMAIN || domain.endsWith(`.${CHR_DOMAIN}`));
}

function cellOf(row, headers, re) {
	const col = (Array.isArray(headers) ? headers : []).find((h) => re.test(h));
	return col ? String((row && row[col]) || "").trim() : "";
}

// One Job Tracking row as the CHR integration may hold it: the Email cell's
// domain (never the agent's address) and no money. driverName stays in memory,
// only to find the truck.
function projectRow(row, headers) {
	const rawId = cellOf(row, headers, COLUMN_RULES.loadId);
	return {
		loadKey: loadKey(rawId),
		loadId: loadNumberOf(rawId),
		brokerDomain: domainOf(cellOf(row, headers, COLUMN_RULES.email)),
		trailer: cellOf(row, headers, COLUMN_RULES.trailer),
		pickupAddress: cellOf(row, headers, COLUMN_RULES.pickupAddress),
		dropoffAddress: cellOf(row, headers, COLUMN_RULES.dropoffAddress),
		driverName: cellOf(row, headers, COLUMN_RULES.driver),
	};
}

// { verdict: "chr" } | { verdict: "other" } (another broker: nothing is
// recorded) | { verdict: "skip", reason } (recorded as skipped_not_chr, no
// payload) | { verdict: "withheld" } (the Load ID holds a protected number:
// nothing is stored). Tested before every other check of the row; the sweep also
// tests the history key before any verdict, which covers a load not in the sheet.
function chrLoadTest(proj, { redactor = null } = {}) {
	if (!proj) return { verdict: "skip", reason: "load_missing" };
	if (redactor && redactor.hits(proj.loadId)) return { verdict: "withheld" };
	if (!proj.brokerDomain) return { verdict: "skip", reason: "email_blank" };
	if (!isChrDomain(proj.brokerDomain)) return { verdict: "other" };
	if (!LOAD_NUMBER_RE.test(String(proj.loadId || ""))) return { verdict: "skip", reason: "load_id_not_9_digits" };
	return { verdict: "chr" };
}

// ------------------------------------------------------------------ the state machine
// Phases: before, at_pickup (k), departed_pickup (k), at_drop (j),
// departed_drop (j), delivered. A status maps to a class with a position; a
// row is a forward step, a repeat of the current phase, a jump past a stop
// (NL2: the event it lands on is held), or a revert, which voids every phase
// after the one it returns to.

const STATUS_CLASS = Object.freeze({
	dispatched: "before", "heading to shipper": "before", assigned: "before", unassigned: "before",
	"at shipper": "at_pickup", loading: "at_pickup",
	"in transit": "in_transit",
	"at receiver": "at_drop",
	delivered: "delivered", completed: "delivered", "pod received": "delivered",
});
const CLASS_POS = Object.freeze({ before: 0, at_pickup: 1, in_transit: 2, at_drop: 3, delivered: 4 });
const PHASE_CLASS = Object.freeze({
	before: "before", at_pickup: "at_pickup", departed_pickup: "in_transit", at_drop: "at_drop", departed_drop: "in_transit", delivered: "delivered",
});
// Rows from these routes only set the phase: they make no event and void nothing.
const PHASE_ONLY_SOURCES = new Set(["dispatch", "accept", "decline"]);
const BEFORE = Object.freeze({ kind: "before", k: 0, j: 0 });

function statusOf(s) {
	return String(s == null ? "" : s).slice(0, 64).trim().toLowerCase().replace(/\s{1,64}/g, " ");
}

// A stored changed_at (UTC, no zone mark) or an ISO instant, as epoch ms.
function instantMs(s) {
	const t = String(s == null ? "" : s).trim().slice(0, 40).replace(" ", "T");
	return Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(t) ? t : `${t}Z`);
}

function forward(phase, cls, status) {
	const { kind, k, j } = phase;
	if (cls === "delivered") {
		return kind === "before" || kind === "delivered" ? null
			: { phase: { kind: "delivered", k, j }, event: "delivered", stop: { kind: "delivery", index: Math.max(j, 1) } };
	}
	switch (kind) {
		case "before":
			if (status === "at shipper") return { phase: { kind: "at_pickup", k: 1, j: 0 }, event: "arrived_pickup", stop: { kind: "pickup", index: 1 } };
			if (status === "loading") return { phase: { kind: "at_pickup", k: 1, j: 0 }, event: null };
			if (cls === "in_transit") return { phase: { kind: "departed_pickup", k: 1, j: 0 }, event: "departed_pickup", stop: { kind: "pickup", index: 1 } };
			return null;
		case "at_pickup":
			if (cls === "in_transit") return { phase: { kind: "departed_pickup", k, j }, event: "departed_pickup", stop: { kind: "pickup", index: k } };
			if (cls === "at_drop") return { phase: { kind: "at_drop", k, j: 1 }, event: "arrived_delivery", stop: { kind: "delivery", index: 1 } };
			return null;
		case "departed_pickup":
			if (status === "at shipper") return { phase: { kind: "at_pickup", k: k + 1, j }, event: "arrived_pickup", stop: { kind: "pickup", index: k + 1 }, multi: true };
			if (cls === "at_drop") return { phase: { kind: "at_drop", k, j: 1 }, event: "arrived_delivery", stop: { kind: "delivery", index: 1 } };
			return null;
		case "at_drop":
			if (cls === "in_transit") return { phase: { kind: "departed_drop", k, j }, event: "departed_delivery", stop: { kind: "delivery", index: j }, multi: true };
			return null;
		case "departed_drop":
			if (cls === "at_drop") return { phase: { kind: "at_drop", k, j: j + 1 }, event: "arrived_delivery", stop: { kind: "delivery", index: j + 1 }, multi: true };
			return null;
		default:
			return null;
	}
}

function makeEvent(key, next, row, jump) {
	const tag = next.event === "delivered" ? "final" : `${next.stop.kind === "pickup" ? "p" : "d"}${next.stop.index}`;
	return {
		key: `ms|${key}|${next.event}|${tag}|h${row.id}`,
		event: next.event,
		stop: { kind: next.stop.kind, index: next.stop.index },
		final: FINAL_EVENTS.includes(next.event),
		rowId: row.id,
		source: row.source,
		at: row.at,
		atMs: instantMs(row.at),
		jump: Boolean(jump),
	};
}

function push(stack, next, row, key, jump) {
	stack.push({ phase: next.phase, event: next.event ? makeEvent(key, next, row, jump) : null, multi: Boolean(next.multi) });
}

// The phase a jump lands on, and its event (held by the sweep).
function jumpTo(stack, cls, row, key) {
	const { k, j } = stack[stack.length - 1].phase;
	if (cls === "at_drop") push(stack, { phase: { kind: "at_drop", k, j: j + 1 }, event: "arrived_delivery", stop: { kind: "delivery", index: j + 1 } }, row, key, true);
	else if (cls === "delivered") push(stack, { phase: { kind: "delivered", k, j }, event: "delivered", stop: { kind: "delivery", index: Math.max(j, 1) } }, row, key, true);
}

// Back to the latest phase of the row's class, voiding everything after it.
// With no such phase left, the row is applied from where the rewind stopped.
function revert(stack, cls, row, key) {
	const pos = CLASS_POS[cls];
	while (stack.length > 1 && CLASS_POS[PHASE_CLASS[stack[stack.length - 1].phase.kind]] > pos) stack.pop();
	const top = stack[stack.length - 1];
	if (PHASE_CLASS[top.phase.kind] === cls) return;
	const next = forward(top.phase, cls, row.status);
	if (next) push(stack, next, row, key, false);
	else jumpTo(stack, cls, row, key);
}

function step(stack, row, key) {
	const cls = STATUS_CLASS[row.status];
	if (!cls) return;
	const top = stack[stack.length - 1];
	if (PHASE_ONLY_SOURCES.has(row.source)) {
		if (top.phase.kind !== "before") stack.push({ phase: BEFORE, event: null, multi: false });
		return;
	}
	if (PHASE_CLASS[top.phase.kind] === cls) return;
	const pos = CLASS_POS[cls];
	const curPos = CLASS_POS[PHASE_CLASS[top.phase.kind]];
	// An override exists to correct a status: one that reads earlier is a revert,
	// even where a manual tap of the same status would be the next stop.
	if (row.source === "override" && pos < curPos) return revert(stack, cls, row, key);
	const next = forward(top.phase, cls, row.status);
	if (next) return push(stack, next, row, key, false);
	if (pos > curPos) return jumpTo(stack, cls, row, key);
	return revert(stack, cls, row, key);
}

// Replays one load's history rows (any order) after its last Cancelled, oldest
// first by changed_at then id, as computeStatusPhases() orders them. Returns the
// live events entered by rows above baselineId, every live key (the sweep voids
// recorded rows whose key is no longer live), the history's multi-stop signal
// and the final phase. The same rows always give the same answer.
function replayLoad(rows, { loadKey: key = "", baselineId = 0 } = {}) {
	const lk = loadKey(key);
	const sorted = (Array.isArray(rows) ? rows : [])
		.map((r) => ({
			id: Number(r && r.id),
			status: statusOf(r && r.new_status),
			source: String((r && r.source) || "").trim().toLowerCase().slice(0, 20),
			at: String((r && r.changed_at) || "").trim().slice(0, 40),
		}))
		.filter((r) => Number.isInteger(r.id) && r.id > 0 && r.status)
		.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id - b.id));
	let start = 0;
	sorted.forEach((r, i) => { if (CANCELLED_RE.test(r.status)) start = i + 1; });
	const stack = [{ phase: BEFORE, event: null, multi: false }];
	for (const r of sorted.slice(start)) step(stack, r, lk);
	const live = stack.filter((s) => s.event).map((s) => s.event);
	const floor = Number(baselineId) || 0;
	return {
		events: live.filter((e) => e.rowId > floor),
		liveKeys: live.map((e) => e.key),
		multiStop: stack.some((s) => s.multi),
		phase: { ...stack[stack.length - 1].phase },
	};
}

// v1 sends pickup 1 and the final delivery only: a drop arrival is checked at
// the mapped drop-off point, which is the last stop.
function isSendable(ev) {
	if (!ev || !ev.stop) return false;
	if (PICKUP_EVENTS.includes(ev.event)) return ev.stop.kind === "pickup" && Number(ev.stop.index) === 1;
	if (FINAL_EVENTS.includes(ev.event)) return ev.stop.kind === "delivery";
	return false;
}

function payloadStop(ev) {
	if (!isSendable(ev)) return null;
	return PICKUP_EVENTS.includes(ev.event) ? { kind: "pickup", index: 1 } : { kind: "delivery", index: "final" };
}

// A driver-instructions payload's stops counted by kind, or null.
function instructionStopCounts(payload) {
	if (!payload || !Array.isArray(payload.stops)) return null;
	let pickups = 0;
	let deliveries = 0;
	for (const s of payload.stops) {
		const kind = String((s && s.kind) || "").trim().toLowerCase();
		if (kind === "pickup") pickups++;
		else if (kind === "delivery") deliveries++;
	}
	return { pickups, deliveries };
}

function multiStopSignal({ history = false, instructionStops = null, marked = false } = {}) {
	if (history) return { multiStop: true, why: "history" };
	if (instructionStops && (instructionStops.pickups > 1 || instructionStops.deliveries > 1)) return { multiStop: true, why: "instructions" };
	if (marked) return { multiStop: true, why: "person" };
	return { multiStop: false, why: "" };
}

// ------------------------------------------------------------------ the redactor
// Exact values only, never a shape. Deny values are read as the
// driver-instructions deny pass reads them: digit runs bridged by up to 8
// characters that are neither letters nor digits. The values are held only in
// this closure: the returned object has hits(), redact() and a count.

const EXACT_MIN = 8;
const TEXT_CAP = 4000;
const DENY_RUN_RE = /\p{N}(?:[^\p{L}\p{N}]{0,8}\p{N}){0,2000}/gu;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function createRedactor({ denyList = "", exact = [] } = {}) {
	const deny = driverInstructions.parseDenyList(denyList).values.slice();
	const words = [...new Set((Array.isArray(exact) ? exact : [])
		.map((v) => String(v == null ? "" : v).trim().toLowerCase())
		.filter((v) => v.length >= EXACT_MIN))];
	const wordRes = words.map((w) => new RegExp(escapeRe(w), "gi"));
	const runHits = (run) => {
		const digits = run.normalize("NFKC").replace(/\D/g, "");
		return deny.some((v) => digits.includes(v));
	};
	function hits(text) {
		const s = String(text == null ? "" : text).slice(0, TEXT_CAP);
		if (deny.length) {
			for (const m of s.matchAll(DENY_RUN_RE)) if (runHits(m[0])) return true;
		}
		if (words.length) {
			const low = s.normalize("NFKC").toLowerCase();
			if (words.some((w) => low.includes(w))) return true;
		}
		return false;
	}
	function redact(text) {
		let s = String(text == null ? "" : text).slice(0, TEXT_CAP);
		if (deny.length) s = s.replace(DENY_RUN_RE, (run) => (runHits(run) ? WITHHELD : run));
		for (const re of wordRes) s = s.replace(re, WITHHELD);
		return s;
	}
	return Object.freeze({ hits, redact, count: deny.length + words.length });
}

const NO_REDACTOR = createRedactor({});

// ------------------------------------------------------------------ the payload

function isoSeconds(ms) {
	return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

const LOCAL_FORMATTERS = new Map();
// The wall-clock time of an instant in `zone`, "YYYY-MM-DDTHH:MM:SS", or null.
function localTime(ms, zone) {
	try {
		if (!LOCAL_FORMATTERS.has(zone)) {
			if (LOCAL_FORMATTERS.size > 50) LOCAL_FORMATTERS.clear();
			LOCAL_FORMATTERS.set(zone, new Intl.DateTimeFormat("en-CA", {
				timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
			}));
		}
		const p = Object.fromEntries(LOCAL_FORMATTERS.get(zone).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
		return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
	} catch {
		return null;
	}
}

// The comma part right before ", ST" (a trailing country part skipped), or null.
function cityBeforeState(address, state) {
	const parts = address.split(",").map((p) => p.trim());
	let end = parts.length - 1;
	if (end > 0 && COUNTRY_PART_RE.test(parts[end])) end--;
	const m = end >= 1 ? STATE_PART_RE.exec(parts[end]) : null;
	return m && m[1].toUpperCase() === state ? parts[end - 1] : null;
}

function personTokens(list) {
	const out = new Set();
	for (const n of Array.isArray(list) ? list : []) {
		for (const t of String(n == null ? "" : n).slice(0, 120).toLowerCase().split(/[^a-z]{1,120}/)) if (t.length >= 3) out.add(t);
	}
	return [...out];
}

function personShaped(v, tokens) {
	if (SSN_SHAPE_RE.test(v) || PHONE7_SHAPE_RE.test(v) || DATE_SHAPE_RE.test(v)) return true;
	if (brokerContact.hasContact(v)) return true;
	const low = v.toLowerCase();
	return tokens.some((t) => low.includes(t));
}

const round4 = (x) => Math.round(x * 1e4) / 1e4;

// The one builder of a CHR payload, from named values only. A value that fails
// its rule is dropped (never cut to fit) and counted in fieldsDropped. A
// position is added only from the ping that confirmed the event, and only when
// the caller says positions are allowed. Refused outright: a Load ID that is
// not 9 digits or holds a protected number, an event off the list, a stop v1
// does not send, no time.
function buildPayload({
	loadId, event, stop, eventAtMs, address = "", point = null, ping = null, positionsAllowed = false,
	truckUnit = "", trailer = "", personNames = [], redactor = null,
} = {}) {
	const red = redactor || NO_REDACTOR;
	const loadNumber = loadNumberOf(loadId);
	if (!LOAD_NUMBER_RE.test(loadNumber) || red.hits(loadNumber)) return { payload: null, refused: "load_number" };
	if (!MILESTONE_EVENTS.includes(event)) return { payload: null, refused: "event" };
	const pStop = payloadStop({ event, stop });
	if (!pStop) return { payload: null, refused: "stop" };
	if (!Number.isFinite(eventAtMs)) return { payload: null, refused: "event_at" };
	let fieldsDropped = 0;
	const tokens = personTokens(personNames);
	const accept = (raw, re) => {
		const v = String(raw == null ? "" : raw).slice(0, 200).trim();
		if (!v) return undefined;
		if (!re.test(v) || personShaped(v, tokens) || red.hits(v)) {
			fieldsDropped++;
			return undefined;
		}
		return v;
	};
	const payload = { loadNumber, event, stop: pStop, eventAt: isoSeconds(eventAtMs) };
	const addr = String(address == null ? "" : address).slice(0, 300);
	const state = stateFromAddress(addr);
	if (state) {
		const zone = stopZone({ address: addr, lat: point && point.latitude, lng: point && point.longitude });
		const time = zone && zone.zone ? localTime(eventAtMs, zone.zone) : null;
		if (time) payload.eventLocal = { time, zone: zone.zone };
		const place = {};
		const cityRaw = cityBeforeState(addr, state);
		const city = cityRaw === null ? undefined : accept(cityRaw, CITY_RE);
		if (city) place.city = city;
		place.state = state;
		payload.place = place;
	}
	if (positionsAllowed === true && ping && Number.isFinite(ping.lat) && Number.isFinite(ping.lng)) {
		payload.position = { lat: round4(ping.lat), lng: round4(ping.lng) };
	}
	const truck = accept(truckUnit, UNIT_RE);
	if (truck) payload.truck = truck;
	const trl = accept(trailer, UNIT_RE);
	if (trl) payload.trailer = trl;
	return { payload, fieldsDropped };
}

module.exports = {
	CHR_DOMAIN,
	MILESTONE_EVENTS,
	PROJECTION_KEYS,
	PAYLOAD_KEYS,
	STATUS_LIST,
	CANCELLED_RE,
	COLUMN_RULES,
	REVERTED_NOTE,
	HISTORY_SQL,
	WITHHELD,
	loadKey,
	loadNumberOf,
	domainOf,
	isChrDomain,
	projectRow,
	chrLoadTest,
	replayLoad,
	isSendable,
	payloadStop,
	instructionStopCounts,
	multiStopSignal,
	createRedactor,
	buildPayload,
	instantMs,
	localTime,
};
