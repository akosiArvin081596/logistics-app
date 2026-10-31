"use strict";
// Owner-operators: the rules a weekly settlement, the books and the report share.
// Pure: callers pass in the rows, sheet days and clock they read; nothing here
// touches the database, the network or the environment. Money is integer cents.

const appTime = require("./app-time");
const { normalizeLoadId } = require("./ratecon-load");

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

const OO_FLAG_NAMES = Object.freeze({
	onboarding: "OWNER_OPERATOR_ONBOARDING_ENABLED",
	loadPay: "OWNER_OPERATOR_LOAD_PAY_ENABLED",
	settlements: "OWNER_OPERATOR_SETTLEMENTS_ENABLED",
	escrow: "OWNER_OPERATOR_ESCROW_ENABLED",
});

// Each flag is on only when set to exactly "true"; server.js reads them once at boot.
function ooFlagsFromEnv(env) {
	if (!env || typeof env !== "object") env = {};
	return Object.freeze({
		onboarding: env.OWNER_OPERATOR_ONBOARDING_ENABLED === "true",
		loadPay: env.OWNER_OPERATOR_LOAD_PAY_ENABLED === "true",
		settlements: env.OWNER_OPERATOR_SETTLEMENTS_ENABLED === "true",
		escrow: env.OWNER_OPERATOR_ESCROW_ENABLED === "true",
	});
}

// The one start-up line: each flag's state and no other setting.
function ooFlagsStartupLine(flags) {
	const f = flags || {};
	return `[owner-operator] ${Object.entries(OO_FLAG_NAMES).map(([key, name]) => `${name} ${f[key] === true ? "on" : "off"}`).join("; ")}`;
}

// ---------------------------------------------------------------------------
// Schema: created at boot whatever the flags (additive); nothing reads it yet.
// ---------------------------------------------------------------------------

const OO_TABLES = Object.freeze([
	"owner_operator_applications",
	"owner_operators",
	"owner_operator_trucks",
	"owner_operator_charges",
	"owner_operator_settlement_lines",
	"owner_operator_escrow_uses",
	"owner_operator_toll_notices",
	"owner_operator_ledger_exits",
]);

// Every settlement line kind, signed from his side; "deductible" is the charge an
// escrow use for a deductible adds, the one use with no other record in the app.
const OO_LINE_KINDS = Object.freeze(["load", "load_change", "fee", "receipt", "receipt_change", "weekly", "one_time",
	"carry_in", "installment", "escrow", "escrow_use", "deductible", "escrow_return"]);

const OO_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS owner_operator_applications (
	application_id INTEGER PRIMARY KEY,
	truck_year INTEGER NOT NULL DEFAULT 0,
	truck_make TEXT NOT NULL DEFAULT '',
	truck_model TEXT NOT NULL DEFAULT '',
	truck_vin TEXT NOT NULL DEFAULT '',
	truck_plate TEXT NOT NULL DEFAULT '',
	truck_plate_state TEXT NOT NULL DEFAULT '',
	truck_unit TEXT NOT NULL DEFAULT '',
	truck_ownership TEXT NOT NULL DEFAULT '' CHECK(truck_ownership IN ('', 'own', 'lease')),
	registered_owner TEXT NOT NULL DEFAULT '',
	business_name TEXT NOT NULL DEFAULT '',
	source TEXT NOT NULL DEFAULT 'direct' CHECK(source IN ('direct', 'partner')),
	created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS owner_operators (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	user_id INTEGER NOT NULL UNIQUE,
	application_id INTEGER,
	status TEXT NOT NULL DEFAULT 'onboarding' CHECK(status IN ('onboarding', 'active', 'ended')),
	source TEXT NOT NULL DEFAULT 'direct' CHECK(source IN ('direct', 'partner')),
	business_name TEXT NOT NULL DEFAULT '',
	fee_bps INTEGER NOT NULL DEFAULT 1800 CHECK(fee_bps BETWEEN 1000 AND 2500),
	escrow_target_cents INTEGER NOT NULL DEFAULT 250000 CHECK(escrow_target_cents >= 0),
	escrow_weekly_cents INTEGER NOT NULL DEFAULT 50000 CHECK(escrow_weekly_cents >= 0),
	-- 0 until set: then the server writes its default once, at his first settlement with a balance.
	installment_cents INTEGER NOT NULL DEFAULT 0 CHECK(installment_cents >= 0),
	-- His last settlement week, inclusive; '' while he is active.
	end_week_start TEXT NOT NULL DEFAULT '',
	final_invoice_id INTEGER,
	-- The acceptance instant: his first settlement week is never earlier than its week.
	created_at TEXT NOT NULL,
	created_by TEXT NOT NULL DEFAULT '',
	updated_at TEXT NOT NULL DEFAULT '',
	updated_by TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS owner_operator_trucks (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	oo_id INTEGER NOT NULL,
	truck_id INTEGER NOT NULL,
	start_week_start TEXT NOT NULL,
	-- The last week the link covers, inclusive; '' while it is open.
	end_week_start TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL,
	created_by TEXT NOT NULL DEFAULT '',
	reason TEXT NOT NULL DEFAULT '',
	ended_at TEXT NOT NULL DEFAULT '',
	ended_by TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_oo_trucks_open_oo ON owner_operator_trucks(oo_id) WHERE end_week_start = '';
CREATE UNIQUE INDEX IF NOT EXISTS idx_oo_trucks_open_truck ON owner_operator_trucks(truck_id) WHERE end_week_start = '';
CREATE TABLE IF NOT EXISTS owner_operator_charges (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	oo_id INTEGER NOT NULL,
	kind TEXT NOT NULL CHECK(kind IN ('onboarding', 'weekly', 'one_time')),
	category TEXT NOT NULL,
	label TEXT NOT NULL,
	-- Positive: he pays; negative: a credit, one-time only.
	cents INTEGER NOT NULL CHECK(cents != 0),
	charge_date TEXT NOT NULL DEFAULT '',
	posted_period TEXT NOT NULL DEFAULT '',
	week_start TEXT NOT NULL DEFAULT '',
	from_week_start TEXT NOT NULL DEFAULT '',
	until_week_start TEXT NOT NULL DEFAULT '',
	-- The record of a cost the company paid; 'outside_app' books an equal company cost, 'fee' has none.
	cost_record TEXT NOT NULL DEFAULT '' CHECK(cost_record IN ('', 'receipt', 'compliance_fee', 'outside_app', 'fee')),
	expense_id INTEGER,
	compliance_fee_id INTEGER,
	reason TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL,
	created_by TEXT NOT NULL DEFAULT '',
	created_by_id INTEGER,
	voided_at TEXT NOT NULL DEFAULT '',
	voided_by TEXT NOT NULL DEFAULT '',
	void_reason TEXT NOT NULL DEFAULT '',
	CHECK(cents > 0 OR kind = 'one_time')
);
CREATE TABLE IF NOT EXISTS owner_operator_settlement_lines (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	invoice_id INTEGER NOT NULL,
	oo_id INTEGER NOT NULL,
	kind TEXT NOT NULL CHECK(kind IN ('load', 'load_change', 'fee', 'receipt', 'receipt_change', 'weekly', 'one_time',
		'carry_in', 'installment', 'escrow', 'escrow_use', 'deductible', 'escrow_return')),
	ref TEXT NOT NULL DEFAULT '',
	line_date TEXT NOT NULL DEFAULT '',
	label TEXT NOT NULL,
	-- Signed from his side; a load's or receipt's base_cents is its amount as settled.
	cents INTEGER NOT NULL,
	base_cents INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_oo_lines_invoice ON owner_operator_settlement_lines(invoice_id);
CREATE INDEX IF NOT EXISTS idx_oo_lines_ref ON owner_operator_settlement_lines(oo_id, kind, ref);
CREATE TABLE IF NOT EXISTS owner_operator_escrow_uses (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	oo_id INTEGER NOT NULL,
	purpose TEXT NOT NULL CHECK(purpose IN ('deductible', 'unpaid_charge')),
	cents INTEGER NOT NULL CHECK(cents > 0),
	-- The record behind it. An unpaid charge-back is paid down from his carried balance
	-- and adds no charge; only a deductible adds its own charge line.
	charge_id INTEGER,
	expense_id INTEGER,
	compliance_fee_id INTEGER,
	record_note TEXT NOT NULL DEFAULT '',
	reason TEXT NOT NULL,
	created_at TEXT NOT NULL,
	created_by TEXT NOT NULL DEFAULT '',
	created_by_id INTEGER,
	voided_at TEXT NOT NULL DEFAULT '',
	voided_by TEXT NOT NULL DEFAULT '',
	void_reason TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS owner_operator_toll_notices (
	expense_id INTEGER PRIMARY KEY,
	agency TEXT NOT NULL,
	agency_key TEXT NOT NULL,
	notice_number TEXT NOT NULL DEFAULT '',
	plate_or_transponder TEXT NOT NULL DEFAULT '',
	toll_date TEXT NOT NULL,
	toll_cents INTEGER NOT NULL CHECK(toll_cents >= 0),
	fee_cents INTEGER NOT NULL DEFAULT 0 CHECK(fee_cents >= 0),
	plate_check TEXT NOT NULL CHECK(plate_check IN ('match', 'mismatch', 'not_on_file', 'transponder')),
	duplicate_check TEXT NOT NULL CHECK(duplicate_check IN ('clear', 'possible', 'confirmed_distinct')),
	read_by_ocr INTEGER NOT NULL DEFAULT 0,
	confirmed_by TEXT NOT NULL DEFAULT '',
	confirmed_by_id INTEGER,
	confirmed_at TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_oo_toll_notice ON owner_operator_toll_notices(agency_key, notice_number) WHERE notice_number != '';
-- A later notice for the same trip (same plate or transponder, agency and day) is held as a possible duplicate.
CREATE INDEX IF NOT EXISTS idx_oo_toll_trip ON owner_operator_toll_notices(agency_key, plate_or_transponder, toll_date);
CREATE TABLE IF NOT EXISTS owner_operator_ledger_exits (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	oo_id INTEGER NOT NULL,
	item_kind TEXT NOT NULL CHECK(item_kind IN ('load', 'receipt')),
	ref TEXT NOT NULL,
	reason TEXT NOT NULL,
	decided_by TEXT NOT NULL,
	decided_by_id INTEGER,
	decided_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_oo_ledger_exit ON owner_operator_ledger_exits(oo_id, item_kind, ref);
`;

// Who filed a receipt, stamped on new receipts by a later change; '' on every
// earlier row. One statement each: the caller skips the one whose column exists.
const OO_EXPENSE_COLUMNS = Object.freeze(["filed_by_role", "filed_by_user_id"]);
const OO_EXPENSE_COLUMN_SQL = Object.freeze([
	"ALTER TABLE expenses ADD COLUMN filed_by_role TEXT NOT NULL DEFAULT ''",
	"ALTER TABLE expenses ADD COLUMN filed_by_user_id INTEGER",
]);

// ---------------------------------------------------------------------------
// Terms and money
// ---------------------------------------------------------------------------

const OO_FEE_MIN_BPS = 1000;
const OO_FEE_MAX_BPS = 2500;
const OO_FEE_DEFAULT_BPS = 1800;
const OO_ESCROW_TARGET_DEFAULT_CENTS = 250000;
const OO_ESCROW_WEEKLY_DEFAULT_CENTS = 50000;
const OO_HOLD_DAYS = 45;
const OO_FINAL_LEAD_DAYS = 7;
const OO_MAX_AMOUNT_CENTS = 10000000;

function refusal(code, error, extra) {
	return { ok: false, code, error, ...(extra || {}) };
}

// Dollars as stored (a REAL, or plain digits) to cents, half away from zero; null
// when unreadable, so a caller refuses instead of paying or charging $0.
function ooToCents(value) {
	let n;
	if (typeof value === "number") n = value;
	else if (typeof value === "string") {
		const s = value.trim().replace(/[$,]/g, "");
		if (!/^-?\d+(?:\.\d+)?$/.test(s)) return null;
		n = Number(s);
	} else return null;
	if (!Number.isFinite(n)) return null;
	const c = Math.round(Number((Math.abs(n) * 100).toPrecision(15)));
	return n < 0 ? -c : c;
}

// num / den in integers, rounded half away from zero (den > 0).
function ooDivRound(num, den) {
	const q = Math.floor((2 * Math.abs(num) + den) / (2 * den));
	return num < 0 ? -q : q;
}

// The company fee on load pay (gross), to the cent; a reversal gives it back.
function ooFeeCents(loadCents, feeBps) {
	return ooDivRound(loadCents * feeBps, 10000);
}

// His share of load pay after the fee and his charges: the one figure the weekly
// settlement and the books both use, so the two can't round apart.
function ooShareCents({ loadCents, feeBps, chargeCents }) {
	const feeCents = ooFeeCents(loadCents, feeBps);
	return { feeCents, shareCents: loadCents - feeCents - chargeCents };
}

// A monthly amount on his truck row as a weekly charge: monthly x 12 / 52.
function ooWeeklyFromMonthlyCents(monthlyCents) {
	return ooDivRound(monthlyCents * 12, 52);
}

// A third of the onboarding balance, rounded up to the cent.
function ooInstallmentDefaultCents(balanceCents) {
	return Number.isInteger(balanceCents) && balanceCents > 0 ? Math.floor((balanceCents + 2) / 3) : 0;
}

// The installment a settlement takes: the stored one, else the default, which the
// caller writes once (writeDefault) and never recomputes.
function ooEffectiveInstallment({ storedCents, onboardingLeftCents } = {}) {
	if (Number.isInteger(storedCents) && storedCents > 0) return { cents: storedCents, writeDefault: false };
	const cents = ooInstallmentDefaultCents(onboardingLeftCents);
	return { cents, writeDefault: cents > 0 };
}

// ---------------------------------------------------------------------------
// Days and Saturday-Friday weeks
// ---------------------------------------------------------------------------

const DAY_MS = 86400000;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function dayTime(s) {
	const m = typeof s === "string" ? DAY_RE.exec(s) : null;
	if (!m) return null;
	const y = Number(m[1]);
	const mo = Number(m[2]);
	const d = Number(m[3]);
	const t = Date.UTC(y, mo - 1, d);
	const back = new Date(t);
	return back.getUTCFullYear() === y && back.getUTCMonth() === mo - 1 && back.getUTCDate() === d ? t : null;
}
const dayKey = (t) => new Date(t).toISOString().slice(0, 10);

// A real calendar day written YYYY-MM-DD.
function ooIsDayKey(s) {
	return dayTime(s) !== null;
}

function ooAddDays(day, n) {
	const t = dayTime(day);
	return t === null || !Number.isInteger(n) ? null : dayKey(t + n * DAY_MS);
}

// The Saturday starting a bare day's week, by calendar arithmetic as getWeekRange()
// reads a bare day: a date never goes through a time zone.
function ooWeekStart(day) {
	const t = dayTime(day);
	if (t === null) return null;
	return dayKey(t - ((new Date(t).getUTCDay() + 1) % 7) * DAY_MS);
}

function ooIsWeekStart(s) {
	return ooIsDayKey(s) && ooWeekStart(s) === s;
}

function ooWeekEnd(weekStart) {
	return ooIsWeekStart(weekStart) ? ooAddDays(weekStart, 6) : null;
}

// The week starts from one Saturday through another.
function ooWeeksBetween(from, to) {
	if (!ooIsWeekStart(from) || !ooIsWeekStart(to) || to < from) return [];
	const out = [];
	for (let w = from; w <= to && out.length < 5300; w = ooAddDays(w, 7)) out.push(w);
	return out;
}

const ISO_INSTANT_RE = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const SQLITE_UTC_RE = /^(\d{4}-\d{2}-\d{2}) \d{2}:\d{2}:\d{2}$/;

// The business day of a stored stamp: a bare day is itself; an instant (an ISO
// stamp, or SQLite's UTC CURRENT_TIMESTAMP) is its day in the app's time zone, so
// a Friday-evening stamp stays on Friday though UTC has reached Saturday.
function ooStampDay(stamp, timeZone) {
	const s = typeof stamp === "string" ? stamp.trim() : "";
	if (ooIsDayKey(s)) return s;
	let m = ISO_INSTANT_RE.exec(s);
	let iso = m ? s : null;
	if (!m && (m = SQLITE_UTC_RE.exec(s))) iso = `${s.replace(" ", "T")}Z`;
	if (!iso || !ooIsDayKey(m[1])) return null;
	const ms = Date.parse(iso);
	if (!Number.isFinite(ms)) return null;
	return appTime.dayInZone(new Date(ms), timeZone || appTime.appTimeZone());
}

const laterWeek = (a, b) => (a > b ? a : b);
const earliestWeek = (weeks) => weeks.reduce((a, b) => (b < a ? b : a));

// ---------------------------------------------------------------------------
// His settlement window
// ---------------------------------------------------------------------------

// His first settlement week: the earlier of his onboarding and first-load weeks, never
// before his profile's week. Once a live settlement exists, the first week that settlement
// was built with stays ({ weekStart, firstWeekStart }), whatever week it was for.
function ooFirstSettlementWeek({ profileCreatedAt, onboardedAt, loads, earliestSettlement, timeZone } = {}) {
	const floorDay = ooStampDay(profileCreatedAt, timeZone);
	if (!floorDay) return refusal("OO_PROFILE_DATE_UNREADABLE", "The owner-operator profile has no readable creation date.");
	const floorWeekStart = ooWeekStart(floorDay);
	const dated = [];
	const undated = [];
	for (const load of loads || []) (load && ooIsDayKey(load.day) ? dated : undated).push(load);
	let firstWeekStart = "";
	if (earliestSettlement) {
		const chain = String(earliestSettlement.firstWeekStart || "").trim();
		if (!ooIsWeekStart(chain)) return refusal("OO_CHAIN_WEEK_UNREADABLE", "His earliest settlement has no readable first week.");
		firstWeekStart = laterWeek(floorWeekStart, chain);
	} else {
		const onboardedDay = ooStampDay(onboardedAt, timeZone);
		const candidates = dated.map((l) => ooWeekStart(l.day)).filter((w) => w >= floorWeekStart);
		if (onboardedDay) candidates.push(ooWeekStart(onboardedDay));
		if (candidates.length) firstWeekStart = laterWeek(floorWeekStart, earliestWeek(candidates));
	}
	// The safety-net list: completed loads under his name from before his profile's week,
	// which no settlement takes; a later one found late lands on his next settlement.
	const beforeFloor = dated.filter((l) => ooWeekStart(l.day) < floorWeekStart);
	return { ok: true, floorWeekStart, firstWeekStart, beforeFloor, undated };
}

// Where a dated item falls: before the profile's week (listed, never charged or
// paid), before his first week (his onboarding balance), or on his settlements.
function ooPlaceDay(day, { floorWeekStart, firstWeekStart } = {}) {
	if (!ooIsDayKey(day)) return "undated";
	const week = ooWeekStart(day);
	if (!floorWeekStart || week < floorWeekStart) return "before_floor";
	if (!firstWeekStart || week < firstWeekStart) return "onboarding";
	return "settlement";
}

// A set of references from a Set, a Map (its keys) or a list.
function refSet(refs) {
	return refs instanceof Set ? refs : new Set(refs instanceof Map ? refs.keys() : refs || []);
}

// His receipts by where they count. One already on a live settlement line stays with the
// settlements (settledRefs), so it is never charged again through his onboarding balance.
function ooSplitReceipts(receipts, win, settledRefs) {
	const settled = refSet(settledRefs);
	const out = { onboarding: [], settlement: [], beforeFloor: [], undated: [] };
	const bucket = { onboarding: out.onboarding, settlement: out.settlement, before_floor: out.beforeFloor, undated: out.undated };
	for (const r of receipts || []) if (r) bucket[settled.has(r.ref) ? "settlement" : ooPlaceDay(r.day, win || {})].push(r);
	return out;
}

// ---------------------------------------------------------------------------
// His truck: in-service weeks and weekly charges
// ---------------------------------------------------------------------------

// The in-service date onboarding completion sets: his completion day on the
// business clock, unless his truck already has one (a Super Admin set it first).
function ooInServiceDateOnCompletion({ onboardedAt, currentInServiceDate, timeZone } = {}) {
	if (String(currentInServiceDate == null ? "" : currentInServiceDate).trim() !== "") return "";
	return ooStampDay(onboardedAt, timeZone) || "";
}

// In service in a week: its in-service date is on or before the Friday, and its
// retirement, when set, on or after the Saturday. No in-service date, no charge.
function ooTruckInServiceWeek(truck, weekStart) {
	const friday = ooWeekEnd(weekStart);
	if (!truck || !friday) return false;
	const inService = String(truck.in_service_date == null ? "" : truck.in_service_date).trim();
	if (!ooIsDayKey(inService) || inService > friday) return false;
	const retired = String(truck.retired_at == null ? "" : truck.retired_at).trim();
	return !(ooIsDayKey(retired) && retired < weekStart);
}

// His truck row's weekly insurance and ELD charges, from its monthly amounts.
function ooTruckWeeklyCents(truck) {
	const weekly = (v) => {
		const c = ooToCents(v);
		return c !== null && c > 0 ? ooWeeklyFromMonthlyCents(c) : 0;
	};
	return { insuranceCents: weekly(truck && truck.insurance_monthly), eldCents: weekly(truck && truck.eld_monthly) };
}

// The truck his link covers in a week; overlapping links take the latest start.
function ooTruckForWeek(links, weekStart) {
	let best = null;
	for (const l of links || []) {
		if (!l || !ooIsWeekStart(l.startWeekStart) || l.startWeekStart > weekStart) continue;
		if (l.endWeekStart && (!ooIsWeekStart(l.endWeekStart) || l.endWeekStart < weekStart)) continue;
		if (!best || l.startWeekStart > best.startWeekStart) best = l;
	}
	return best ? best.truck : null;
}

// Weekly charges due on the settlement for week W: his truck row's insurance and
// ELD and any weekly item, for each week from his first through W (never past his
// end week) while his truck is in service, each week charged once.
function ooWeeklyChargeLines({ weekStart, firstWeekStart, endWeekStart, links, charges, chargedRefs } = {}) {
	const charged = chargedRefs instanceof Set ? chargedRefs : new Set(chargedRefs || []);
	const last = endWeekStart && endWeekStart < weekStart ? endWeekStart : weekStart;
	const lines = [];
	for (const w of ooWeeksBetween(firstWeekStart, last)) {
		const truck = ooTruckForWeek(links, w);
		if (!ooTruckInServiceWeek(truck, w)) continue;
		const add = (ref, label, cents) => {
			if (cents > 0 && !charged.has(ref)) lines.push({ kind: "weekly", ref, lineDate: w, label, cents: -cents, baseCents: cents });
		};
		const { insuranceCents, eldCents } = ooTruckWeeklyCents(truck);
		add(`ins:${w}`, "Insurance", insuranceCents);
		add(`eld:${w}`, "ELD service", eldCents);
		for (const c of charges || []) {
			if (!c || c.kind !== "weekly" || c.voided_at || !Number.isInteger(c.cents)) continue;
			if (!ooIsWeekStart(c.from_week_start) || c.from_week_start > w) continue;
			if (c.until_week_start && c.until_week_start < w) continue;
			add(`chg:${c.id}:${w}`, c.label, c.cents);
		}
	}
	return lines;
}

// His truck's in-service weeks from the profile's week to before his first settlement
// week: their insurance and ELD join his onboarding balance, unless a settlement already
// charged that week (chargedRefs).
function ooPreFirstWeekTruckCharges({ floorWeekStart, firstWeekStart, links, chargedRefs } = {}) {
	const charged = refSet(chargedRefs);
	const weeks = [];
	let cents = 0;
	if (!ooIsWeekStart(firstWeekStart)) return { cents, weeks };
	for (const w of ooWeeksBetween(floorWeekStart, ooAddDays(firstWeekStart, -7))) {
		const truck = ooTruckForWeek(links, w);
		if (!ooTruckInServiceWeek(truck, w)) continue;
		const weekly = ooTruckWeeklyCents(truck);
		const insuranceCents = charged.has(`ins:${w}`) ? 0 : weekly.insuranceCents;
		const eldCents = charged.has(`eld:${w}`) ? 0 : weekly.eldCents;
		if (insuranceCents + eldCents === 0) continue;
		weeks.push({ weekStart: w, insuranceCents, eldCents });
		cents += insuranceCents + eldCents;
	}
	return { cents, weeks };
}

// ---------------------------------------------------------------------------
// Charges
// ---------------------------------------------------------------------------

// The onboarding charges on his balance; a voided one never counts.
function ooOnboardingChargeCents(charges) {
	let cents = 0;
	for (const c of charges || []) if (c && c.kind === "onboarding" && !c.voided_at && Number.isInteger(c.cents)) cents += c.cents;
	return cents;
}

// One-time charges and credits for week W or waiting for the next settlement, each once.
function ooDueOneTimeCharges(charges, { weekStart, settledRefs } = {}) {
	const settled = settledRefs instanceof Set ? settledRefs : new Set(settledRefs || []);
	const out = [];
	for (const c of charges || []) {
		if (!c || c.kind !== "one_time" || c.voided_at || !Number.isInteger(c.cents) || c.cents === 0) continue;
		if (c.week_start && !(ooIsWeekStart(c.week_start) && c.week_start <= weekStart)) continue;
		const ref = `chg:${c.id}`;
		if (!settled.has(ref)) out.push({ ref, cents: c.cents, day: c.charge_date || "", label: c.label });
	}
	return out;
}

// ---------------------------------------------------------------------------
// The investor ledger's claim on an item (never paid to him twice)
// ---------------------------------------------------------------------------

// The investor ledger's own reading of a load's Owner ID cell (investorJobRowTest()):
// blank, or the account it names, where 0 is a company truck.
function ooOwnerIdCell(raw) {
	if (raw === undefined || raw === null || String(raw).trim() === "") return { blank: true, ownerId: 0 };
	return { blank: false, ownerId: parseInt(raw) || 0 };
}

// A load the investor ledger gives an investor: an Owner ID other than 0, or a
// blank one its driver fallback claims for an investor.
function ooLoadOnInvestorLedger({ ownerIdCell, blankClaimedByInvestor } = {}) {
	const cell = ooOwnerIdCell(ownerIdCell);
	return cell.blank ? blankClaimedByInvestor === true : cell.ownerId !== 0;
}

// A receipt the investor ledger gives an investor: an owner stamp other than 0, or
// no truck stamp and an investor's driver window claims it (investorExpenseScopeSql()).
function ooReceiptOnInvestorLedger({ ownerId, truckUnit, blankUnitClaimedByInvestor } = {}) {
	if ((Number(ownerId) || 0) !== 0) return true;
	return String(truckUnit == null ? "" : truckUnit).trim() === "" && blankUnitClaimedByInvestor === true;
}

// Held items are listed and never settled; an item with a ledger exit is neither.
function ooSplitLedgerHolds(items, exitRefs) {
	const exits = exitRefs instanceof Set ? exitRefs : new Set(exitRefs || []);
	const out = { candidates: [], held: [] };
	for (const item of items || []) {
		if (!item || exits.has(item.ref)) continue;
		(item.onInvestorLedger === true ? out.held : out.candidates).push(item);
	}
	return out;
}

// The key a load is settled once by: the weekly invoice's normalized Load ID.
function ooLoadRef(loadId) {
	return normalizeLoadId(loadId);
}

// ---------------------------------------------------------------------------
// Lines and balances
// ---------------------------------------------------------------------------

function sumKinds(lines, kinds) {
	let cents = 0;
	for (const l of lines || []) if (l && kinds.includes(l.kind) && Number.isInteger(l.cents)) cents += l.cents;
	return cents;
}

// What his live settlement lines already settled: each load and receipt by its
// amount (for once-forward differences) and each charged reference.
function ooSettledFromLines(lines) {
	const loads = new Map();
	const receipts = new Map();
	const weekly = new Set();
	const oneTime = new Set();
	const escrowUses = new Set();
	for (const l of lines || []) {
		if (!l || !Number.isInteger(l.cents)) continue;
		if (l.kind === "load" || l.kind === "load_change") loads.set(l.ref, (loads.get(l.ref) || 0) + l.cents);
		else if (l.kind === "receipt" || l.kind === "receipt_change") receipts.set(l.ref, (receipts.get(l.ref) || 0) - l.cents);
		else if (l.kind === "weekly") weekly.add(l.ref);
		else if (l.kind === "one_time") oneTime.add(l.ref);
		else if (l.kind === "escrow_use" || l.kind === "deductible") escrowUses.add(l.ref);
	}
	return { loads, receipts, weekly, oneTime, escrowUses };
}

function ooNetCents(lines) {
	return sumKinds(lines, OO_LINE_KINDS);
}

// What a settlement carries to the next: its shortfall, never a positive amount.
function ooCarriedOutCents(lines) {
	return Math.max(0, -ooNetCents(lines));
}

// Deposits add to his escrow; uses and the final return take from it.
function ooEscrowBalanceFromLines(lines) {
	return -sumKinds(lines, ["escrow", "escrow_use", "escrow_return"]);
}

function ooInstallmentsPaidFromLines(lines) {
	return -sumKinds(lines, ["installment"]);
}

// His onboarding balance left: its charges, his pre-first-week receipts and truck
// weeks, less the installments live settlements took.
function ooOnboardingLeftCents({ chargeCents = 0, receiptCents = 0, truckCents = 0, paidCents = 0 } = {}) {
	return chargeCents + receiptCents + truckCents - paidCents;
}

const byDateThenRef = (a, b) => (a.lineDate < b.lineDate ? -1 : a.lineDate > b.lineDate ? 1 : a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0);

// Lines for items against what live settlements settled: a new item in full, a
// settled one by its change, a settled one now gone by its reversal. sign is +1 for
// load pay he earns and -1 for receipts he pays.
function ooDiffItems({ current, settled, newKind, changeKind, sign, eligibleNew }) {
	const byRef = new Map();
	for (const item of current || []) if (item && item.ref) byRef.set(item.ref, item);
	const lines = [];
	for (const ref of new Set([...byRef.keys(), ...settled.keys()])) {
		const item = byRef.get(ref);
		const was = settled.get(ref);
		if (was === undefined) {
			if (!item || !eligibleNew(item) || item.cents === 0) continue;
			lines.push({ kind: newKind, ref, lineDate: item.day, label: item.label || ref, cents: sign * item.cents, baseCents: item.cents });
			continue;
		}
		const now = item ? item.cents : 0;
		if (now === was) continue;
		lines.push({ kind: changeKind, ref, lineDate: item ? item.day : "", label: (item && item.label) || ref, cents: sign * (now - was), baseCents: now });
	}
	return lines.sort(byDateThenRef);
}

// ---------------------------------------------------------------------------
// The settlement
// ---------------------------------------------------------------------------

// One settlement's arithmetic. The installment and escrow never make or deepen a
// short week; escrow starts only once the onboarding balance was already cleared;
// the final settlement takes what he owes and returns his escrow whatever the flags.
function ooSettlementMath(input) {
	const {
		loadCents = 0, feeBps, receiptCents = 0, weeklyCents = 0, oneTimeCents = 0, carriedInCents = 0,
		onboardingLeftCents = 0, installmentCents = 0, final = false, escrow = {},
	} = input || {};
	const {
		enabled: escrowOn = false, targetCents = 0, weeklyCents: escrowWeeklyCents = 0, balanceCents = 0,
		unpaidUseCents = 0, deductibleUseCents = 0,
	} = escrow || {};
	const ints = [loadCents, receiptCents, weeklyCents, oneTimeCents, carriedInCents, onboardingLeftCents, installmentCents,
		targetCents, escrowWeeklyCents, balanceCents, unpaidUseCents, deductibleUseCents];
	if (!ints.every(Number.isInteger)) return refusal("OO_MATH_INPUT", "Every settlement amount must be whole cents.");
	const feeRefusal = ooValidateFeeBps(feeBps);
	if (feeRefusal) return feeRefusal;
	if ([carriedInCents, installmentCents, balanceCents, unpaidUseCents, deductibleUseCents].some((v) => v < 0)) {
		return refusal("OO_MATH_INPUT", "A carried balance, installment, escrow balance or escrow use can't be negative.");
	}
	const escrowUseCents = unpaidUseCents + deductibleUseCents;
	if (escrowUseCents > 0 && !escrowOn && !final) return refusal("OO_ESCROW_OFF", "Escrow is off: no escrow use is applied.");
	if (escrowUseCents > balanceCents) return refusal("OO_ESCROW_USE_OVER_BALANCE", "An escrow use can't be more than the escrow balance.");
	if (unpaidUseCents > carriedInCents) return refusal("OO_ESCROW_USE_OVER_CARRY", "An unpaid charge-back use can't be more than his carried balance.");

	const { feeCents, shareCents } = ooShareCents({ loadCents, feeBps, chargeCents: receiptCents + weeklyCents + oneTimeCents + deductibleUseCents });
	const beforeCents = shareCents - carriedInCents + escrowUseCents;
	// A balance below $0 (paid down, then a receipt or truck week in it dropped out) is
	// overpaid: the installment turns negative and returns it on this settlement.
	const installmentTaken = final ? onboardingLeftCents : Math.min(installmentCents, onboardingLeftCents, Math.max(0, beforeCents));
	const depositAllowed = !final && escrowOn && onboardingLeftCents <= 0;
	const roomCents = Math.max(0, targetCents - balanceCents);
	const depositCents = depositAllowed ? Math.min(escrowWeeklyCents, roomCents, Math.max(0, beforeCents - installmentTaken)) : 0;
	const netBeforeEscrowCents = beforeCents - installmentTaken - depositCents;
	const balanceAfterUsesCents = balanceCents - escrowUseCents;
	const returning = final;
	const appliedCents = returning ? Math.min(balanceAfterUsesCents, Math.max(0, -netBeforeEscrowCents)) : 0;
	const returnedCents = returning ? balanceAfterUsesCents - appliedCents : 0;
	const netCents = netBeforeEscrowCents + appliedCents + returnedCents;
	return {
		ok: true,
		loadCents,
		feeCents,
		receiptCents,
		weeklyCents,
		oneTimeCents,
		deductibleCents: deductibleUseCents,
		shareCents,
		carriedInCents,
		escrowUseCents,
		beforeCents,
		installmentCents: installmentTaken,
		escrowDepositCents: depositCents,
		escrowAppliedCents: appliedCents,
		escrowReturnCents: returnedCents,
		netCents,
		payableCents: Math.max(0, netCents),
		carriedOutCents: Math.max(0, -netCents),
		onboardingLeftAfterCents: onboardingLeftCents - installmentTaken,
		escrowBalanceAfterCents: balanceAfterUsesCents + depositCents - appliedCents - returnedCents,
	};
}

// The settlement for week W: its lines, signed from his side, and its totals. Loads
// and receipts are his live, non-held items of any date; this decides which are new,
// changed or gone, and refuses rather than pay a load $0.
function ooBuildSettlement(input) {
	const {
		weekStart, window: win = {}, endWeekStart = "", final = false, profile = {}, installmentCents = 0,
		loads = [], receipts = [], weeklyLines = [], oneTime = [], settled = ooSettledFromLines([]),
		carriedInCents = 0, onboardingLeftCents = 0, escrow = {},
	} = input || {};
	if (!ooIsWeekStart(weekStart)) return refusal("OO_WEEK_INVALID", "A settlement week starts on a Saturday.");
	const first = (win && win.firstWeekStart) || "";
	if (!first) return refusal("OO_NO_FIRST_WEEK", "He has no first settlement week yet: no onboarding completed and no completed load.");
	if (weekStart < first) return refusal("OO_SETTLEMENT_BEFORE_FIRST_WEEK", "This week is before his first settlement week.");
	if (!final && endWeekStart && weekStart > endWeekStart) return refusal("OWNER_OPERATOR_ENDED", "He has ended: what arrives goes on his final settlement.");
	const friday = ooWeekEnd(weekStart);
	// A load counts from his profile's week, so one found late lands on his next settlement;
	// a receipt counts from his first week (before it, it is on his onboarding balance).
	const floor = (win && win.floorWeekStart) || first;
	const eligibleFrom = (from) => (item) => ooIsDayKey(item.day) && item.day <= friday && ooWeekStart(item.day) >= from;
	const eligibleLoad = eligibleFrom(floor);
	const eligibleReceipt = eligibleFrom(first);
	const onThis = (item, map, eligible) => map.has(item.ref) || eligible(item);
	const noPay = loads.filter((l) => l && onThis(l, settled.loads, eligibleLoad) && !(Number.isInteger(l.cents) && l.cents > 0)).map((l) => l.ref);
	if (noPay.length) return refusal("OO_SETTLEMENT_LOAD_NO_PAY", "A load on this settlement has no readable pay.", { refs: noPay });
	const noAmount = receipts.filter((r) => r && onThis(r, settled.receipts, eligibleReceipt) && !(Number.isInteger(r.cents) && r.cents >= 0)).map((r) => r.ref);
	if (noAmount.length) return refusal("OO_SETTLEMENT_RECEIPT_NO_AMOUNT", "A receipt on this settlement has no readable amount.", { refs: noAmount });

	const loadLines = ooDiffItems({ current: loads, settled: settled.loads, newKind: "load", changeKind: "load_change", sign: 1, eligibleNew: eligibleLoad });
	const receiptLines = ooDiffItems({
		current: receipts,
		settled: settled.receipts,
		newKind: "receipt",
		changeKind: "receipt_change",
		sign: -1,
		eligibleNew: eligibleReceipt,
	});
	const weekly = weeklyLines.filter((l) => l && !settled.weekly.has(l.ref));
	const oneTimeLines = oneTime.filter((c) => c && !settled.oneTime.has(c.ref))
		.map((c) => ({ kind: "one_time", ref: c.ref, lineDate: c.day || weekStart, label: c.label || "Charge", cents: -c.cents, baseCents: c.cents }));
	const useLines = [];
	let unpaidUseCents = 0;
	let deductibleUseCents = 0;
	for (const use of escrow.uses || []) {
		if (!use || settled.escrowUses.has(use.ref)) continue;
		if (!(Number.isInteger(use.cents) && use.cents > 0) || (use.purpose !== "deductible" && use.purpose !== "unpaid_charge")) {
			return refusal("OO_ESCROW_USE_INVALID", "An escrow use needs a purpose and an amount above $0.", { refs: [use.ref] });
		}
		if (use.purpose === "deductible") {
			deductibleUseCents += use.cents;
			useLines.push({ kind: "deductible", ref: use.ref, lineDate: weekStart, label: use.label || "Insurance deductible", cents: -use.cents, baseCents: use.cents });
		} else {
			unpaidUseCents += use.cents;
		}
		useLines.push({ kind: "escrow_use", ref: use.ref, lineDate: weekStart, label: "Paid from your escrow", cents: use.cents, baseCents: use.cents });
	}
	const total = (ls) => ls.reduce((s, l) => s + l.cents, 0);
	const loadCents = total(loadLines);
	const math = ooSettlementMath({
		loadCents,
		feeBps: profile.feeBps,
		receiptCents: -total(receiptLines),
		weeklyCents: -total(weekly),
		oneTimeCents: -total(oneTimeLines),
		carriedInCents,
		onboardingLeftCents,
		installmentCents,
		final,
		escrow: {
			enabled: escrow.enabled === true,
			targetCents: profile.escrowTargetCents || 0,
			weeklyCents: profile.escrowWeeklyCents || 0,
			balanceCents: escrow.balanceCents || 0,
			unpaidUseCents,
			deductibleUseCents,
		},
	});
	if (!math.ok) return math;
	const lines = [...loadLines];
	if (math.feeCents !== 0) lines.push({ kind: "fee", ref: "fee", lineDate: friday, label: "Company fee", cents: -math.feeCents, baseCents: loadCents });
	lines.push(...receiptLines, ...weekly, ...oneTimeLines, ...useLines);
	if (carriedInCents > 0) lines.push({ kind: "carry_in", ref: "carry", lineDate: weekStart, label: "Balance carried in", cents: -carriedInCents, baseCents: carriedInCents });
	if (math.installmentCents !== 0) {
		const label = math.installmentCents > 0 ? "Onboarding installment" : "Onboarding balance overpaid, returned";
		lines.push({ kind: "installment", ref: "installment", lineDate: friday, label, cents: -math.installmentCents, baseCents: math.installmentCents });
	}
	if (math.escrowDepositCents > 0) lines.push({ kind: "escrow", ref: "deposit", lineDate: friday, label: "Escrow", cents: -math.escrowDepositCents, baseCents: math.escrowDepositCents });
	if (math.escrowAppliedCents > 0) lines.push({ kind: "escrow_use", ref: "final", lineDate: friday, label: "Paid from your escrow", cents: math.escrowAppliedCents, baseCents: math.escrowAppliedCents });
	if (math.escrowReturnCents > 0) lines.push({ kind: "escrow_return", ref: "final", lineDate: friday, label: "Escrow returned to you", cents: math.escrowReturnCents, baseCents: math.escrowReturnCents });
	if (!lines.length) return refusal("OO_NOTHING_TO_SETTLE", "Nothing to settle this week.");
	if (ooNetCents(lines) !== math.netCents) throw new Error("ooBuildSettlement(): the lines do not add up to the net");
	return { ok: true, weekStart, weekEnd: friday, firstWeekStart: first, final, lines, totals: math };
}

// The termination hold runs 45 days after his end week's Friday; his final
// settlement is due 7 days before it ends, or at once when End came later. No flag
// is an input: escrow already held always comes back.
function ooFinalSettlementDue({ endWeekStart, today } = {}) {
	const friday = ooWeekEnd(endWeekStart);
	if (!friday || !ooIsDayKey(today)) return refusal("OO_WEEK_INVALID", "His end week must be a Saturday and today a day.");
	const holdEndsOn = ooAddDays(friday, OO_HOLD_DAYS);
	const dueOn = ooAddDays(holdEndsOn, -OO_FINAL_LEAD_DAYS);
	return { ok: true, holdEndsOn, dueOn, due: today >= dueOn };
}

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

// The fee in basis points: 10% to 25%.
function ooValidateFeeBps(bps) {
	return Number.isInteger(bps) && bps >= OO_FEE_MIN_BPS && bps <= OO_FEE_MAX_BPS ? null
		: refusal("OO_FEE_OUT_OF_RANGE", "The fee must be from 10% to 25%.");
}

// A fee typed as a percent ("18", "18.5"), at most two decimals, in basis points.
function ooParseFeePercent(input) {
	const s = typeof input === "number" && Number.isFinite(input) ? String(input) : typeof input === "string" ? input.trim() : "";
	const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(s);
	if (!m) return refusal("OO_FEE_OUT_OF_RANGE", "The fee must be from 10% to 25%, with at most two decimals.");
	const bps = Number(m[1]) * 100 + Number((m[2] || "").padEnd(2, "0"));
	return ooValidateFeeBps(bps) || { ok: true, bps };
}

// A dollar amount typed by staff, to cents: digits and at most two decimals.
function ooParseDollarsToCents(input, { allowNegative = false, allowZero = false, maxCents = OO_MAX_AMOUNT_CENTS } = {}) {
	const s = typeof input === "number" && Number.isFinite(input) ? String(input)
		: typeof input === "string" ? input.trim().replace(/[$,]/g, "") : "";
	const m = /^(-?)(\d{1,9})(?:\.(\d{1,2}))?$/.exec(s);
	const invalid = refusal("OO_AMOUNT_INVALID", "Enter an amount in dollars with at most two decimals.");
	if (!m) return invalid;
	const magnitude = Number(m[2]) * 100 + Number((m[3] || "").padEnd(2, "0"));
	const cents = m[1] ? -magnitude : magnitude;
	if (magnitude === 0 ? !allowZero : (cents < 0 && !allowNegative) || magnitude > maxCents) return invalid;
	return { ok: true, cents: magnitude === 0 ? 0 : cents };
}

// Escrow terms: whole cents, the weekly hold-back no more than the target.
function ooValidateEscrowTerms({ targetCents, weeklyCents } = {}) {
	const valid = Number.isInteger(targetCents) && Number.isInteger(weeklyCents) && targetCents >= 0 && weeklyCents >= 0
		&& weeklyCents <= targetCents && targetCents <= OO_MAX_AMOUNT_CENTS;
	return valid ? null : refusal("OO_ESCROW_TERMS_INVALID", "The escrow target and weekly amount must be whole cents, the weekly amount no more than the target.");
}

// The installment: any amount before he signs; after, only a smaller one than what
// he signed for (or than the default, when he signed with none set).
function ooInstallmentChangeRefusal({ signed, currentCents, nextCents, defaultCents = 0 } = {}) {
	if (!Number.isInteger(nextCents) || nextCents < 0 || nextCents > OO_MAX_AMOUNT_CENTS) return refusal("OO_INSTALLMENT_INVALID", "The installment must be whole cents.");
	if (!signed) return null;
	const base = Number.isInteger(currentCents) && currentCents > 0 ? currentCents : defaultCents;
	return nextCents > 0 && nextCents < base ? null : refusal("OO_INSTALLMENT_ONLY_LOWER", "After he signs, the installment can only be lowered.");
}

// Control, format and line-separator characters become spaces before a text is judged.
const TEXT_STRIP = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu;
// Cut wide, then clean, then judge the whole value, so an over-long text is refused
// rather than silently shortened.
function cleanText(value, max) {
	let raw = String(value == null ? "" : value);
	if (raw.length > max * 4) raw = raw.slice(0, max * 4);
	return raw.normalize("NFC").replace(TEXT_STRIP, " ").trim();
}
const LABEL_RE = /^[\p{L}\p{N}][^\p{C}\p{Zl}\p{Zp}<>]{0,79}$/u;
const REASON_RE = /^[^\p{C}\p{Zl}\p{Zp}]{1,300}$/u;

// A printed label: the Order # rule (1-80 characters, a letter or number first, no
// line break, < or >).
function ooCleanLabel(value) {
	const v = cleanText(value, 200);
	return LABEL_RE.test(v) ? { ok: true, value: v }
		: refusal("OO_LABEL_INVALID", "A label must be 1-80 characters, start with a letter or number, and have no line break, < or >.");
}

// An audit reason: 1-300 characters on one line.
function ooCleanReason(value) {
	const v = cleanText(value, 300);
	return REASON_RE.test(v) ? { ok: true, value: v } : refusal("OO_REASON_INVALID", "A reason must be 1-300 characters.");
}

const OO_CHARGE_KINDS = Object.freeze(["onboarding", "weekly", "one_time"]);
const OO_COST_RECORDS = Object.freeze(["", "receipt", "compliance_fee", "outside_app", "fee"]);
const positiveId = (v) => Number.isInteger(v) && v > 0;

// A charge as the table and the agreement allow it: one of the agreement's
// charge-back categories (the caller's list), a charge for a cost names its record,
// and a credit is one-time only.
function ooValidateCharge(input, { categories } = {}) {
	const c = input || {};
	if (!OO_CHARGE_KINDS.includes(c.kind)) return refusal("OO_CHARGE_KIND_INVALID", "A charge is onboarding, weekly or one-time.");
	if (!Array.isArray(categories) || !categories.includes(c.category)) return refusal("OO_CHARGE_CATEGORY_INVALID", "A charge needs one of the agreement's charge-back categories.");
	const label = ooCleanLabel(c.label);
	if (!label.ok) return label;
	const reason = ooCleanReason(c.reason);
	if (!reason.ok) return reason;
	if (!Number.isInteger(c.cents) || c.cents === 0 || Math.abs(c.cents) > OO_MAX_AMOUNT_CENTS || (c.cents < 0 && c.kind !== "one_time")) {
		return refusal("OO_CHARGE_AMOUNT_INVALID", "A charge is more than $0; only a one-time item may be a credit.");
	}
	const costRecord = c.costRecord == null ? "" : c.costRecord;
	if (!OO_COST_RECORDS.includes(costRecord)) return refusal("OO_CHARGE_RECORD_INVALID", "Unknown cost record.");
	if (c.cents > 0 && costRecord === "") return refusal("OO_CHARGE_RECORD_REQUIRED", "A charge names the record of its cost, or says it is a fee.");
	if ((costRecord === "receipt" && !positiveId(c.expenseId)) || (costRecord === "compliance_fee" && !positiveId(c.complianceFeeId))) {
		return refusal("OO_CHARGE_RECORD_INVALID", "A receipt or compliance fee record needs its id.");
	}
	const chargeDate = c.chargeDate == null ? "" : String(c.chargeDate);
	const weekStart = c.weekStart == null ? "" : String(c.weekStart);
	const fromWeekStart = c.fromWeekStart == null ? "" : String(c.fromWeekStart);
	const untilWeekStart = c.untilWeekStart == null ? "" : String(c.untilWeekStart);
	if (c.kind === "weekly") {
		if (!ooIsWeekStart(fromWeekStart) || (untilWeekStart && (!ooIsWeekStart(untilWeekStart) || untilWeekStart < fromWeekStart))) {
			return refusal("OO_CHARGE_WEEK_INVALID", "A weekly charge runs from one Saturday to another.");
		}
	} else {
		if (!ooIsDayKey(chargeDate)) return refusal("OO_CHARGE_DATE_INVALID", "A charge needs the date of its cost.");
		if (c.kind === "one_time" && weekStart && !ooIsWeekStart(weekStart)) return refusal("OO_CHARGE_WEEK_INVALID", "A settlement week starts on a Saturday.");
	}
	return {
		ok: true,
		charge: {
			kind: c.kind,
			category: c.category,
			label: label.value,
			cents: c.cents,
			chargeDate: c.kind === "weekly" ? "" : chargeDate,
			weekStart: c.kind === "one_time" ? weekStart : "",
			fromWeekStart: c.kind === "weekly" ? fromWeekStart : "",
			untilWeekStart: c.kind === "weekly" ? untilWeekStart : "",
			costRecord,
			expenseId: costRecord === "receipt" ? c.expenseId : null,
			complianceFeeId: costRecord === "compliance_fee" ? c.complianceFeeId : null,
			reason: reason.value,
		},
	};
}

// The month a charge is booked in: its own, or the first open month when its own has closed.
function ooPostedPeriod({ chargeDate, firstOpenMonth } = {}) {
	if (!ooIsDayKey(chargeDate) || !/^\d{4}-(0[1-9]|1[0-2])$/.test(String(firstOpenMonth || ""))) return null;
	const own = chargeDate.slice(0, 7);
	return own < firstOpenMonth ? firstOpenMonth : own;
}

// "partner" only for the partner's own referral code (a setting, never in the
// repo); a blank or unknown code is "direct", and nothing tells which.
function ooSourceFromReferral(code, partnerRef) {
	const c = typeof code === "string" ? code.trim() : "";
	const p = typeof partnerRef === "string" ? partnerRef.trim() : "";
	return p !== "" && c.length <= 64 && c === p ? "partner" : "direct";
}

// A VIN acceptance may match against trucks on file: only a full 17-character one,
// so a blank or partial VIN never matches (and never takes a truck from its driver).
function ooMatchableVin(vin) {
	const v = String(vin == null ? "" : vin).trim().toUpperCase();
	return /^[A-HJ-NPR-Z0-9]{17}$/.test(v) ? v : "";
}

// His end week: a Saturday, never before the week of his last completed load.
function ooEndWeekRefusal({ endWeekStart, lastLoadDay } = {}) {
	if (!ooIsWeekStart(endWeekStart)) return refusal("OO_WEEK_INVALID", "His end week starts on a Saturday.");
	if (ooIsDayKey(lastLoadDay) && endWeekStart < ooWeekStart(lastLoadDay)) {
		return refusal("OO_END_BEFORE_LOAD", "His end week can't be before the week of his last completed load.");
	}
	return null;
}

// The application's own category: position "Owner Operator", trimmed and case-folded.
function ooIsOwnerOperatorPosition(position) {
	return typeof position === "string" && position.trim().toLowerCase() === "owner operator";
}

module.exports = {
	OO_FLAG_NAMES,
	OO_TABLES,
	OO_LINE_KINDS,
	OO_SCHEMA_SQL,
	OO_EXPENSE_COLUMNS,
	OO_EXPENSE_COLUMN_SQL,
	OO_FEE_MIN_BPS,
	OO_FEE_MAX_BPS,
	OO_FEE_DEFAULT_BPS,
	OO_ESCROW_TARGET_DEFAULT_CENTS,
	OO_ESCROW_WEEKLY_DEFAULT_CENTS,
	OO_HOLD_DAYS,
	OO_FINAL_LEAD_DAYS,
	OO_CHARGE_KINDS,
	OO_COST_RECORDS,
	ooFlagsFromEnv,
	ooFlagsStartupLine,
	ooToCents,
	ooDivRound,
	ooFeeCents,
	ooShareCents,
	ooWeeklyFromMonthlyCents,
	ooInstallmentDefaultCents,
	ooEffectiveInstallment,
	ooIsDayKey,
	ooAddDays,
	ooWeekStart,
	ooWeekEnd,
	ooIsWeekStart,
	ooWeeksBetween,
	ooStampDay,
	ooFirstSettlementWeek,
	ooPlaceDay,
	ooSplitReceipts,
	ooInServiceDateOnCompletion,
	ooTruckInServiceWeek,
	ooTruckWeeklyCents,
	ooTruckForWeek,
	ooWeeklyChargeLines,
	ooPreFirstWeekTruckCharges,
	ooOnboardingChargeCents,
	ooDueOneTimeCharges,
	ooOwnerIdCell,
	ooLoadOnInvestorLedger,
	ooReceiptOnInvestorLedger,
	ooSplitLedgerHolds,
	ooLoadRef,
	ooSettledFromLines,
	ooDiffItems,
	ooNetCents,
	ooCarriedOutCents,
	ooEscrowBalanceFromLines,
	ooInstallmentsPaidFromLines,
	ooOnboardingLeftCents,
	ooSettlementMath,
	ooBuildSettlement,
	ooFinalSettlementDue,
	ooValidateFeeBps,
	ooParseFeePercent,
	ooParseDollarsToCents,
	ooValidateEscrowTerms,
	ooInstallmentChangeRefusal,
	ooCleanLabel,
	ooCleanReason,
	ooValidateCharge,
	ooPostedPeriod,
	ooSourceFromReferral,
	ooMatchableVin,
	ooEndWeekRefusal,
	ooIsOwnerOperatorPosition,
};
