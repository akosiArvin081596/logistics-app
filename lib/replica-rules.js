// The rules a local replica of production is held to, in one pure module (no
// fs, no network, no process state): the app reads them at boot in replica mode
// (lib/replica-mode.js), and `npm run replica:pull` ships this file to the
// server, where the settings export applies the same rules to production's .env
// (scripts/replica/remote/settings.js). One copy, so what the export copies and
// what the replica refuses cannot drift apart.
//
// Nothing here prints or returns a setting's value: every function answers with
// names and rules only.
"use strict";

// A setting is a SECRET, and is never copied off the server, when its name
// contains any of these (case-insensitive).
const SECRET_NAME_PARTS = Object.freeze(["KEY", "SECRET", "TOKEN", "PASS", "CREDENTIAL", "PRIVATE", "AUTH", "SMTP", "DSN", "WEBHOOK"]);
const SECRET_NAME_RE = new RegExp(SECRET_NAME_PARTS.join("|"), "i");

// Settings that stay on production although neither their name nor their value
// marks them secret: the payout bank's routing and account numbers printed on
// invoices (INVOICE_BANK_SETTINGS in lib/broker-invoice.js). Never copied, and a
// replica's settings file may not hold them, so a replica's invoice prints "Bank
// details not set". Judged by name before the allowlist, so how the app reads
// them never decides it.
const PRODUCTION_ONLY_SETTINGS = Object.freeze(["INVOICE_BANK_ROUTING", "INVOICE_BANK_ACCOUNT"]);

// Settings that describe how a process runs rather than how the business runs.
// replica:start sets each of them itself, so production's values are never
// copied: NODE_ENV=production in particular is a reason for the replica to
// refuse to start.
const RUNTIME_KEYS = Object.freeze([
	"NODE_ENV", "PORT", "BIND_HOST", "DATABASE_PATH", "NODE_OPTIONS",
	"LOCAL_REPLICA", "LOGISX_REPLICA_TASK", "LOGISX_REPLICA_SETTINGS", "LOGISX_REPLICA_DATA_DIR",
	"LOGISX_REPLICA_GUARD_LOG", "LOGISX_REPLICA_LAUNCHER",
]);

// Set by replica:start, and by nothing else: a replica refuses to start without
// it, so it is only ever started the way that sets its environment (no proxy, no
// credential, none of the shell's variables).
const LAUNCHER_ENV = "LOGISX_REPLICA_LAUNCHER";
const LAUNCHER_VALUE = "replica:start";

// Every credential the app (server.js and lib/) or its Google client reads to
// reach a service outside this machine, or that a service uses to reach it.
// A replica refuses to start while any of them is set to anything. Each name
// also matches SECRET_NAME_RE today; the list exists so the refusal still names
// them if that rule ever changes. scripts/test-replica-mode.js fails when
// server.js or lib/ reads a secret-named variable this list does not name
// (SESSION_SECRET aside).
const OUTBOUND_CREDENTIALS = Object.freeze([
	"GMAIL_APP_PASSWORD",
	"GEMINI_API_KEY",
	"GOOGLE_MAPS_API_KEY",
	"GOOGLE_MAPS_BROWSER_KEY",
	"GOOGLE_APPLICATION_CREDENTIALS",
	"ROUTEMATE_API_KEY",
	"SCANKIT_API_KEY",
	"LINXUP_WEBHOOK_TOKEN",
	"N8N_EXTRACT_SECRET",
	"N8N_WEBHOOK_SECRET",
	"N8N_INVOICE_WEBHOOK_URL",
	"SETUP_RECOVERY_TOKEN",
	"ORS_API_KEY",
]);

// Signs the replica's own session cookies; it reaches nothing. replica:start
// hands the server a fresh random one on every start, in its environment only
// (never written to disk), so it is the one secret-named variable a replica
// accepts.
const SESSION_SECRET_NAME = "SESSION_SECRET";

// A value that is a URL carrying credentials: userinfo (scheme://user:pass@host
// or scheme://token@host), a query parameter whose name says it is one, or a
// path segment that reads like a token (webhook URLs carry theirs in the path).
const URL_USERINFO_RE = /^[a-z][a-z0-9+.-]*:\/\/[^/?#\s]*@/i;
const URL_CREDENTIAL_PARAM_RE = /[?&](?:[a-z0-9_.-]*(?:key|secret|token|pass|password|pwd|auth|signature|sig|credential|code)[a-z0-9_.-]*)=/i;

function isSecretName(name) {
	return SECRET_NAME_RE.test(String(name || ""));
}

// A long run of key characters with letters and digits mixed: how API keys,
// tokens and secrets look, and how words, flags, numbers and names do not.
function looksLikeToken(s) {
	const v = String(s == null ? "" : s);
	if (v.length < 20 || !/^[A-Za-z0-9_\-+=.~]+$/.test(v)) return false;
	if (!/[0-9]/.test(v) || !/[A-Za-z]/.test(v)) return false;
	return (/[a-z]/.test(v) && /[A-Z]/.test(v)) || /^[0-9a-f]{32,}$/i.test(v) || v.length >= 32;
}

function isCredentialUrl(value) {
	const v = String(value == null ? "" : value).trim();
	if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return false;
	if (URL_USERINFO_RE.test(v) || URL_CREDENTIAL_PARAM_RE.test(v)) return true;
	const pathPart = v.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, "").split(/[?#]/)[0];
	return pathPart.split("/").some((seg) => looksLikeToken(decodeURIComponentSafe(seg)));
}

function decodeURIComponentSafe(s) {
	try { return decodeURIComponent(s); } catch { return s; }
}

// A value that is itself a key: one token, no spaces, no path. An identifier
// setting (a name ending in _ID or _IDS, such as a spreadsheet or folder ID)
// looks the same and is not a credential, so it is not judged by its shape.
function isBareKeyValue(name, value) {
	if (/_IDS?$/i.test(String(name || ""))) return false;
	return looksLikeToken(String(value == null ? "" : value).trim());
}

// What the settings export does with one production setting: { copy, rule }.
// `rule` names why a setting is skipped and is safe to print (it never quotes
// the value). With `readByApp` (the names server.js and lib/ read), anything
// else is skipped too: a setting the app never reads cannot change what a
// replica does, and an unknown name is not copied on the strength of its name.
function classifySetting(name, value, { readByApp } = {}) {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(name || ""))) return { copy: false, rule: "not a plain variable name" };
	if (isSecretName(name)) {
		const part = SECRET_NAME_PARTS.find((p) => new RegExp(p, "i").test(name));
		return { copy: false, rule: `secret: name contains ${part}` };
	}
	if (PRODUCTION_ONLY_SETTINGS.includes(name)) return { copy: false, rule: "production only: payout bank details" };
	if (RUNTIME_KEYS.includes(name)) return { copy: false, rule: "runtime: set by replica:start" };
	if (readByApp && !readByApp.has(name)) return { copy: false, rule: "not read by the app" };
	if (isCredentialUrl(value)) return { copy: false, rule: "secret: value is a URL carrying credentials" };
	if (isBareKeyValue(name, value)) return { copy: false, rule: "secret: value looks like a key" };
	if (/[\r\n]/.test(String(value == null ? "" : value))) return { copy: false, rule: "multi-line value" };
	return { copy: true, rule: "business setting" };
}

// The settings names an app's code reads (process.env.NAME), from its sources.
function namesReadBy(sources) {
	const names = new Set();
	for (const src of sources) for (const m of String(src).matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)) names.add(m[1]);
	return names;
}

// The names of the outbound credentials an environment sets, for the boot
// refusal. Every variable is judged by its name (OUTBOUND_CREDENTIALS, then the
// secret-name rule) and by its value (a URL carrying credentials). Empty values
// count as unset.
function outboundCredentialsSet(env) {
	const hits = [];
	for (const [name, raw] of Object.entries(env || {})) {
		const value = raw == null ? "" : String(raw);
		if (!value.trim() || name === SESSION_SECRET_NAME) continue;
		if (OUTBOUND_CREDENTIALS.includes(name) || isSecretName(name)) hits.push(name);
		else if (isCredentialUrl(value)) hits.push(`${name} (a URL carrying credentials)`);
	}
	return hits.sort();
}

// Proxy settings an HTTP client may follow (any case), and Node's switch that
// makes its own fetch and http follow them. A replica runs with none.
const PROXY_ENV_NAMES = Object.freeze(["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"]);
function proxySettingsSet(env) {
	return Object.entries(env || {})
		.filter(([name, v]) => String(v == null ? "" : v).trim() !== ""
			&& (PROXY_ENV_NAMES.includes(name.toUpperCase()) || name === "NODE_USE_ENV_PROXY"))
		.map(([name]) => name)
		.sort();
}

// The snapshot folder on the server: one level under /root/logisx-replica-tmp,
// named by a stamp of this shape (e.g. 20261008T0700Z-3fa1c2d9). The
// production-write guard allows the snapshot's VACUUM INTO only into a folder
// of this shape.
const REMOTE_TMP_PARENT = "/root/logisx-replica-tmp";
const STAMP_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
function isValidStamp(stamp) {
	return typeof stamp === "string" && stamp.length <= 64 && STAMP_RE.test(stamp);
}

// A task (working copy) name: lower-case words, digits and dashes.
const TASK_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
function isValidTask(task) {
	return typeof task === "string" && TASK_RE.test(task);
}

// replica:start --enable <NAME>: the flags one replica task's server may get set
// to "true" (in its environment only, never in the settings file). An allowlist,
// so a flag added to the app later is refused until someone has checked it:
// each name here is off by default where the app reads it, and what it switches
// on is a business rule computed on the task's working copy (its database, its
// Sheets copy, its files), with nothing that leaves this machine.
const ENABLE_ALLOWED = Object.freeze([
	"PAYOUT_RULES_V2_ENABLED",
	"INVESTOR_LEASE_PAYOUTS_ENABLED",
	"PRE_DISPATCH_PAY_DAY_RULE_ENABLED",
	"LEDGER_DAY_ONCE_ENABLED",
	"TRIP_WORK_DAYS_ENABLED",
	"PERSONAL_EXPENSE_DEDUCTIONS_ENABLED",
	// Lets a closed-month invoice be marked Paid on the task's own database; the
	// driver status email a payment sends is the same with the flag off.
	"MARK_PAID_CLOSED_MONTH_ENABLED",
	"PERIOD_FINALIZE_ENABLED",
	"MAINTENANCE_NOTICE_ENABLED",
	// Driver availability (R11): time-off rows in the task's own database, the
	// ELD silence sweep's verdicts and the assign routes' warning. It sends
	// nothing itself; the sweep's mail is ELD_STALE_ALERT_ENABLED's.
	"DRIVER_AVAILABILITY_ENABLED",
]);

// Every other _ENABLED flag the app reads, with why --enable refuses it. The
// network guard would stop the outbound ones anyway; refusing them up front
// keeps a replica task from even trying, and keeps the guard log empty.
const KILL_SWITCH = "a kill switch, on unless set to false: \"true\" is already its value, so --enable could only override production's own choice";
const ENABLE_REFUSED = Object.freeze({
	ROUTEMATE_ENABLED: "the Routemate ELD feed: reaches an outside service (and server.js keeps it off in a replica)",
	LINXUP_ENABLED: "the Linxup ELD feed: reaches an outside service (and server.js keeps it off in a replica)",
	SCANKIT_ENABLED: "ScanKit receipt OCR: reaches an outside service (and server.js keeps it off in a replica)",
	RATECON_RECONCILE_ENABLED: "the rate-con reconcile reads the Gmail inbox",
	RATECON_INDEX_APPLY_ENABLED: "the rate-con index downloads PDFs from Google Drive",
	FUEL_GALLONS_RECOVERY_ENABLED: "gallons recovery sends receipts to Gemini OCR, a metered outside API",
	KPI_DEADHEAD_ROUTES_ENABLED: "deadhead miles call the paid Google Routes API",
	INVOICE_AUTOGEN_ENABLED: "the weekly invoice batch is a scheduled job that submits invoices, and a replica starts no scheduled jobs",
	FUEL_EVENTS_ENABLED: "the fuel-event sweep is a scheduled job that sends alerts, and a replica starts no scheduled jobs",
	CHAT_ORPHAN_SWEEP_ENABLED: "the chat-attachment sweep is a scheduled job that deletes files, and a replica starts no scheduled jobs",
	KPI_DIGEST_ENABLED: `the KPI digest sends email; ${KILL_SWITCH}`,
	INTEGRITY_CHECK_ENABLED: `the daily integrity check sends its findings by email; ${KILL_SWITCH}`,
	ELD_STALE_ALERT_ENABLED: `the ELD-silence alert sends email; ${KILL_SWITCH}`,
	EXPENSE_DUPLICATE_ALERT_ENABLED: `the duplicate-receipt alert sends email; ${KILL_SWITCH}`,
	FUEL_LOW_ALERT_ENABLED: `the low-fuel alert sends email; ${KILL_SWITCH}`,
	INVOICE_UNDATED_ALERT_ENABLED: `the undated-load alert sends email; ${KILL_SWITCH}`,
	RATECON_EXTRACT_ALERT_ENABLED: `the unusable rate-con alert sends email; ${KILL_SWITCH}`,
	RATECON_REISSUE_HOLD_ENABLED: `the re-issued rate-con hold alerts by email; ${KILL_SWITCH}`,
	KPI_SNAPSHOT_ENABLED: `the nightly KPI snapshot is a scheduled job; ${KILL_SWITCH}`,
	PII_MASK_ENABLED: KILL_SWITCH,
	BROKER_CONTACT_VALUE_REDACTION_ENABLED: KILL_SWITCH,
	LOAD_HAUL_ELD_ENABLED: KILL_SWITCH,
});

// The allowed flags that do nothing without their first month (YYYY-MM), and
// the setting that holds it (lib/ledger-day-once.js, lib/load-pay-days.js,
// lib/trip-work-days.js). replica:start --from-month sets it for the task;
// without one these flags are refused, so the banner never says "enabled" for a
// rule that stays off.
const ENABLE_FROM = Object.freeze({
	LEDGER_DAY_ONCE_ENABLED: "LEDGER_DAY_ONCE_FROM",
	PRE_DISPATCH_PAY_DAY_RULE_ENABLED: "PRE_DISPATCH_PAY_DAY_RULE_FROM",
	TRIP_WORK_DAYS_ENABLED: "TRIP_WORK_DAYS_FROM",
});

// A --from-month value: exactly YYYY-MM, a year 2000-2099 and a month 01-12.
function isFromMonth(value) {
	return typeof value === "string" && /^20\d{2}-(0[1-9]|1[0-2])$/.test(value);
}

// Why --enable refuses `name`, or null when it may be set to "true" for one
// replica task. Names only: the value is always "true", so none is accepted.
function enableRefusal(name) {
	if (typeof name !== "string" || !/^[A-Z][A-Z0-9_]*_ENABLED$/.test(name)) {
		return "--enable takes one setting name ending in _ENABLED, in capitals with no value (it is set to true)";
	}
	const v = classifySetting(name, "true");
	if (!v.copy) return `not a business setting (${v.rule})`;
	if (Object.prototype.hasOwnProperty.call(ENABLE_REFUSED, name)) return ENABLE_REFUSED[name];
	if (!ENABLE_ALLOWED.includes(name)) {
		return "not on the replica's --enable allowlist (ENABLE_ALLOWED in lib/replica-rules.js), which takes a flag only once it is checked to reach nothing outside this machine";
	}
	return null;
}

// Chromium (lib/pdf-browser.js) renders PDFs in its own process, beyond the
// app's network guard, and the payout-statement and broker-invoice templates
// link Google Fonts. In replica mode it starts with every host name resolving
// to nothing and every request sent to a closed loopback proxy, so a page can
// load what it carries inline and nothing else.
const CHROMIUM_OFFLINE_ARGS = Object.freeze([
	"--proxy-server=http://127.0.0.1:9",
	"--proxy-bypass-list=<-loopback>",
	"--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE localhost",
]);

module.exports = {
	SECRET_NAME_PARTS,
	SECRET_NAME_RE,
	PRODUCTION_ONLY_SETTINGS,
	RUNTIME_KEYS,
	LAUNCHER_ENV,
	LAUNCHER_VALUE,
	OUTBOUND_CREDENTIALS,
	SESSION_SECRET_NAME,
	REMOTE_TMP_PARENT,
	CHROMIUM_OFFLINE_ARGS,
	PROXY_ENV_NAMES,
	ENABLE_ALLOWED,
	ENABLE_REFUSED,
	ENABLE_FROM,
	enableRefusal,
	isFromMonth,
	isSecretName,
	looksLikeToken,
	isCredentialUrl,
	isBareKeyValue,
	classifySetting,
	namesReadBy,
	outboundCredentialsSet,
	proxySettingsSet,
	isValidStamp,
	isValidTask,
};
