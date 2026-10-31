"use strict";

// The KPI Viewer role: an account that opens only GET /api/kpis/viewer and its own sign-in, session check,
// password change and sign-out. Everything else refuses it: requireRole names it on that route only,
// requireAuth admits only FOUR_ROLES and the socket register joins it to no room (both keep a literal copy
// of FOUR_ROLES to stay self-contained; scripts/test-kpi-viewer.js pins the copies to it).
//
// Seeing figures takes the role, KPI_VIEWER_ENABLED with a users CHECK that admits the role, and the
// account's id on KPI_VIEWER_IDS. The answer is built field by field from an allowlist, never the admin
// answer with fields taken out, so a field the admin answer gains later never reaches it.
//
// Pure: no database, no environment read, no I/O; server.js reads the setting and the rows and hands them in.

const { parseListedAccountIds } = require("./listed-accounts");
const { isDisabledRow } = require("./account-disable");

const ROLE = "KPI Viewer";
const FOUR_ROLES = Object.freeze(["Super Admin", "Dispatcher", "Driver", "Investor"]);
const NO_APPROVED_TEXT = "No KPI has been approved for sharing yet.";

// ── KPI_VIEWER_IDS ──────────────────────────────────────────────────────────────────────────────────

// The setting, read strictly (lib/listed-accounts.js). Only the "listed" verdict lets a KPI Viewer see
// figures, so unset, empty and invalid all let nobody: the page had no earlier behaviour to keep.
function viewerList(raw) {
	return parseListedAccountIds(raw);
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// The KPI Viewer accounts against the list, for the start-up line: `summary` joins the line, `errors` and
// `warnings` follow it. `readAccounts` returns the users rows whose role is KPI Viewer (server.js reads
// them); a failed read is reported, never thrown. Account ids only, never a name.
function census(list, readAccounts) {
	const listText = list.state === "valid" ? `valid (${plural(list.ids.length, "id")})` : list.state;
	const errors = [];
	const warnings = [];
	if (list.state === "invalid") {
		errors.push(`[kpi-viewer] KPI_VIEWER_IDS is set but invalid (${list.problem}): no KPI Viewer sees figures until it lists account ids only`);
	}
	let rows = null;
	try { rows = readAccounts(); } catch { rows = null; }
	if (!Array.isArray(rows)) {
		errors.push("[kpi-viewer] the KPI Viewer accounts could not be read");
		return { summary: `KPI_VIEWER_IDS ${listText}; KPI Viewer accounts unreadable`, errors, warnings };
	}
	const enabled = rows.filter((r) => r && !isDisabledRow(r)).map((r) => r.id);
	const listed = enabled.filter((id) => list.isListedId(id));
	for (const id of list.ids) {
		if (!enabled.includes(id)) errors.push(`[kpi-viewer] KPI_VIEWER_IDS lists account #${id}, which isn't an enabled KPI Viewer account`);
	}
	for (const id of enabled) {
		if (!list.isListedId(id)) warnings.push(`[kpi-viewer] KPI Viewer account #${id} isn't on KPI_VIEWER_IDS: its KPI page shows no figures`);
	}
	return { summary: `KPI_VIEWER_IDS ${listText}; ${plural(rows.length, "KPI Viewer account")}, ${listed.length} listed`, errors, warnings };
}

function logCensus(c, log) {
	for (const line of c.errors) log.error(line);
	for (const line of c.warnings) log.warn(line);
}

// ── who may read the page ───────────────────────────────────────────────────────────────────────────

// Why GET /api/kpis/viewer refuses a caller its requireRole("Super Admin", "KPI Viewer") let through, or
// null when it may read. A Super Admin reads the same answer as a preview, whatever the list says.
function viewerRefusal({ enabled, schemaReady, list, user }) {
	if (enabled !== true) return { status: 404, body: { error: "Not found", code: "FEATURE_OFF" } };
	if (schemaReady !== true) {
		return { status: 503, body: { error: "The shared KPI page isn't set up on this server yet.", code: "KPI_VIEWER_SCHEMA" } };
	}
	const role = user && user.role;
	if (role === "Super Admin") return null;
	if (role !== ROLE) return { status: 403, body: { error: "Forbidden" } };
	if (list && typeof list.verdict === "function" && list.verdict(user) === "listed") return null;
	return { status: 403, body: { error: "This account isn't on the KPI viewer list yet.", code: "KPI_VIEWER_NOT_LISTED" } };
}

// ── Add User and Edit User ──────────────────────────────────────────────────────────────────────────

const hasText = (v) => v !== undefined && v !== null && String(v).trim() !== "";
const FIELDS = {
	status: 400, code: "KPI_VIEWER_FIELDS",
	error: "A KPI Viewer account has no driver name or company name. Remove them and try again. Nothing was changed.",
	tail: "nothing was written — a KPI Viewer account holds no driver or company name",
};

// Why Add User refuses a new KPI Viewer, or null: only while KPI_VIEWER_ENABLED is on and the users CHECK
// admits the role, and never with a driver or company name, neither of which means anything for it.
function createRefusal({ enabled, schemaReady, driverName, companyName }) {
	if (enabled !== true) {
		return {
			status: 403, code: "KPI_VIEWER_DISABLED",
			error: "KPI Viewer accounts are turned off on this server. Nothing was changed.",
			tail: "nothing was written — the KPI Viewer role is off (KPI_VIEWER_ENABLED)",
		};
	}
	if (schemaReady !== true) {
		return {
			status: 503, code: "KPI_VIEWER_SCHEMA",
			error: "KPI Viewer accounts can't be created yet: the accounts table doesn't admit the role. Nothing was changed.",
			tail: "nothing was written — the users table doesn't admit the role yet",
		};
	}
	if (hasText(driverName) || hasText(companyName)) return { ...FIELDS };
	return null;
}

// Why Edit User refuses a change that involves a KPI Viewer, or null. A KPI Viewer account's role is fixed
// and no account becomes one, so a role sent either way is refused unless it is the account's own; and the
// account holds no driver or company name.
function editRefusal({ currentRole, role, driverName, companyName }) {
	const asked = role === undefined || role === null || role === "" ? null : role;
	if (asked !== null && (asked === ROLE) !== (currentRole === ROLE)) {
		return {
			status: 409, code: "KPI_VIEWER_ROLE_FIXED",
			error: "A KPI Viewer account's role can't be changed, and no account can be changed into one. Nothing was changed.",
			tail: "nothing was written — a KPI Viewer account's role is fixed",
		};
	}
	if (currentRole === ROLE && (hasText(driverName) || hasText(companyName))) return { ...FIELDS };
	return null;
}

// ── the page's answer ───────────────────────────────────────────────────────────────────────────────

// The fields copied at each depth. Nothing else is ever copied: no job state, settings, recipients,
// approval, definitionVersion, breakdown, coverage or before/after rows (each before/after row carries the
// date of a setting).
const TOP_FIELDS = Object.freeze(["asOfDay", "timeZone", "generatedAt"]);
const METRIC_FIELDS = Object.freeze(["key", "label", "unit", "kind", "group", "definition", "status", "missingReason", "value", "display", "confidence", "computedDay"]);
const SOURCE_FIELDS = Object.freeze(["label", "url"]);
const PERIOD_FIELDS = Object.freeze(["label", "from", "to", "value", "display"]);
const SERIES_FIELDS = Object.freeze(["period", "value", "display"]);
const COMPARISON_FIELDS = Object.freeze(["kind", "label", "basePeriod", "value", "baseValue", "deltaPct", "display", "status"]);
const WEEKLY_FIELDS = Object.freeze(["mode", "weekRule", "reason"]);
const WEEK_FIELDS = Object.freeze(["weekStart", "weekEnd", "to", "label", "value", "display", "partial"]);
const WEEK_COMPARISON_FIELDS = Object.freeze(["kind", "label", "display", "status", "note"]);

const plain = (v) => v === null || typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v));
// The named fields of `obj` that hold a plain value (an object or array under a named field is dropped);
// null when `obj` isn't an object.
function pick(obj, fields) {
	if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
	const out = {};
	for (const f of fields) if (Object.prototype.hasOwnProperty.call(obj, f) && plain(obj[f])) out[f] = obj[f];
	return out;
}
const pickEach = (arr, fields) => (Array.isArray(arr) ? arr.map((x) => pick(x, fields)).filter(Boolean) : []);
const strings = (arr) => (Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : []);

// True only when both are readable instants and `at` is after `since`.
function approvedAfter(at, since) {
	const a = Date.parse(at);
	const s = Date.parse(since);
	return Number.isFinite(a) && Number.isFinite(s) && a > s;
}

function weeklyOf(w) {
	const out = pick(w, WEEKLY_FIELDS);
	if (!out || w.mode !== "weekly") return out;
	out.series = pickEach(w.series, WEEK_FIELDS);
	out.current = pick(w.current, WEEK_FIELDS);
	out.toDate = pick(w.toDate, WEEK_FIELDS);
	out.comparison = pick(w.comparison, WEEK_COMPARISON_FIELDS);
	return out;
}

function metricOf(m, weeklySince) {
	const out = pick(m, METRIC_FIELDS);
	out.source = typeof m.source === "string" ? m.source : pick(m.source, SOURCE_FIELDS);
	out.assumptions = strings(m.assumptions);
	out.warnings = strings(m.warnings);
	out.current = pick(m.current, PERIOD_FIELDS);
	out.totals = pickEach(m.totals, PERIOD_FIELDS);
	out.series = pickEach(m.series, SERIES_FIELDS);
	out.comparisons = pickEach(m.comparisons, COMPARISON_FIELDS);
	// Weekly figures are finer than monthly ones, so they show only under an approval given after weekly
	// figures began (K8): `weeklySince` is server_state 'kpi.weekly_since', null while weekly is off.
	if (m.weekly && m.approval && approvedAfter(m.approval.at, weeklySince)) out.weekly = weeklyOf(m.weekly);
	return out;
}

// The page's answer, from GET /api/admin/kpis's (kpiResponse(): stored rows, approvals already checked
// against today's definitions and settings). A metric not approved now isn't sent at all, not even its key.
function viewerAnswer(response, { weeklySince = null } = {}) {
	const r = response && typeof response === "object" ? response : {};
	const out = pick(r, TOP_FIELDS);
	if (r.weekly && typeof r.weekly === "object" && typeof r.weekly.weekRule === "string") out.weekRule = r.weekly.weekRule;
	out.metrics = (Array.isArray(r.metrics) ? r.metrics : [])
		.filter((m) => m && typeof m === "object" && m.approval && m.approval.approved === true)
		.map((m) => metricOf(m, weeklySince));
	if (!out.metrics.length) out.note = NO_APPROVED_TEXT;
	return out;
}

module.exports = {
	ROLE,
	FOUR_ROLES,
	NO_APPROVED_TEXT,
	viewerList,
	census,
	logCensus,
	viewerRefusal,
	createRefusal,
	editRefusal,
	viewerAnswer,
};
