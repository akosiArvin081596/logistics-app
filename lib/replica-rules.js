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
