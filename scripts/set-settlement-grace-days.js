#!/usr/bin/env node
// scripts/set-settlement-grace-days.js — sets how many days after a month ends
// that month closes: the fleet-wide investor setting settlement_grace_days
// (investor_config, owner 0), the one the month-close sweep reads on every tick
// (settlementGraceDays()). A month closes at 00:00 (APP_TIMEZONE) on the day
// after its last day plus this many days: 7 closes October on November 8, 14 on
// November 15. Months already closed stay closed (their locks are stamped, not
// derived from the clock). No restart is needed.
//
// It writes through the server's own PUT /api/investor/config handler, lifted
// from this checkout's server.js (scripts/lib/server-lift.js) with
// ?ownerId=global and { settlement_grace_days: <days> }: the route's own
// validation (a whole number from 0 to 28, INVESTOR_CONFIG_KEYS), its upsert,
// and its audit row, written as a system change (user 0, username
// "system: settlement-grace-days script", role "system", action
// update_investor_config, entity investor_config "global", details
// "settlement_grace_days: <old> → <new>"). The call runs inside one transaction
// that also checks the audit row is there; without it nothing is written.
//
// Idempotent: when the stored value already says <days>, it prints "already"
// and writes nothing (exit 0). Refused (exit 2, nothing written) for a value
// the route would refuse.
//
// --dry-run opens the database read-only and prints the change (old → new), the
// audit row it would write, and the close date of the current month (and the
// previous one while it is open, and the next one) under the old and the new
// value; a month the new value would close at once (its new close already
// passed) is named in a WARNING.
//
// Usage (on the server, from the app directory, with the Node pm2 runs it with):
//   node scripts/set-settlement-grace-days.js --days 14 --dry-run
//   node scripts/set-settlement-grace-days.js --days 14
//   --db <file>   default: the app's own database (scripts/lib/app-database.js),
//                 refused while LOCAL_REPLICA is set; another file must be a
//                 copy outside this repository and outside any app directory
// Exit codes: 0 written, already set, or dry run; 1 error (nothing written);
// 2 refused (nothing written).
//
// Required as a module (by its test runner) it runs nothing and exports its
// parts.

"use strict";

const path = require("path");
const { createRequire } = require("module");
const { closure } = require("./lib/server-lift");
const { serverSource } = require("./lib/server-source");
const { parseArgs } = require("./lib/ledger-world");
const { resolveDatabase, DatabaseRefusal } = require("./lib/app-database");

const ROOT = path.join(__dirname, "..");
const ACTOR = "system: settlement-grace-days script";
const SYSTEM_USER = Object.freeze({ id: 0, username: ACTOR, role: "system" });
const KEY = "settlement_grace_days";
const OPTIONS = ["days", "db", "dry-run"];
const ROUTE_HEAD = 'app.put("/api/investor/config", requireRole("Super Admin"), refuseCrossOrigin, (req, res) => {';
const ROOTS = ["INVESTOR_CONFIG_KEYS", "investorConfigValue", "investorConfigSame", "settlementGraceDays", "graceEndsAt", "appTodayKey", "periodWriteLocked", "APP_TIMEZONE"];
const PROVIDED = ["db", "require", "console", "process", "__dirname", "app", "requireRole", "refuseCrossOrigin", "notifyChange", "fetch"];
const DENIED = ["getSheets", "sheets", "SPREADSHEET_ID", "KEY_FILE", "server", "io", "sendEmail", "transporter", "getDrive"];
const LIFTED_REQUIRE_OK = (m) => ["crypto", "path", "fs"].includes(m) || /^\.\/lib\/[\w.-]+$/.test(m);
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS_SHORT = MONTHS.map((m) => m.slice(0, 3));

class Refusal extends Error {}

const monthLabel = (period) => `${MONTHS[Number(period.slice(5, 7)) - 1]} ${period.slice(0, 4)}`;
const shiftMonth = (period, n) => {
	const d = new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)) - 1 + n, 1, 12));
	return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};
const nextDay = (day) => {
	const d = new Date(`${day}T12:00:00Z`);
	d.setUTCDate(d.getUTCDate() + 1);
	return d.toISOString().slice(0, 10);
};
const dayText = (day) => {
	const d = new Date(`${day}T12:00:00Z`);
	return `${WEEKDAYS[d.getUTCDay()]} ${MONTHS_SHORT[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
};

function readOptions(argv) {
	const args = parseArgs(argv);
	for (const a of argv) {
		if (!a.startsWith("--")) continue;
		const name = a.slice(2).split("=")[0];
		if (!OPTIONS.includes(name)) throw new Refusal(`unknown option --${name}`);
	}
	if (typeof args.days !== "string" || !args.days.trim()) throw new Refusal("--days <0-28> is required");
	if (args.db !== undefined && (typeof args.db !== "string" || !args.db.trim())) throw new Refusal("--db needs a file");
	if (args["dry-run"] !== undefined && args["dry-run"] !== true) throw new Refusal("--dry-run takes no value");
	return { days: args.days.trim(), db: typeof args.db === "string" ? args.db.trim() : null, dryRun: args["dry-run"] === true };
}

// The route and the helpers it and the close dates need, lifted from `root`'s
// server.js, on `db`. Returns { api, call(req) }.
function buildWorld({ root = ROOT, db }) {
	const SRC = serverSource({ root });
	const appRequire = createRequire(path.join(root, "server.js"));
	const lifted = closure(SRC, { roots: ROOTS, routes: [ROUTE_HEAD], provided: PROVIDED, denied: DENIED });
	const routes = {};
	const app = { put: (p, ...h) => { routes[`PUT ${p}`] = h[h.length - 1]; } };
	const pass = () => (req, res, next) => next && next();
	const liftedRequire = (m) => {
		if (!LIFTED_REQUIRE_OK(m)) throw new Error(`lifted code required ${m}, which this script does not load`);
		return appRequire(m);
	};
	const noFetch = () => { throw new Error("lifted code called fetch(); this script makes no network calls"); };
	const scriptProcess = { env: process.env, argv: [], exit: () => { throw new Error("lifted code called process.exit()"); } };
	const body = ['"use strict";', lifted.text, `return { ${ROOTS.join(", ")} };`].join("\n");
	const api = new Function(...PROVIDED, body)(db, liftedRequire, console, scriptProcess, root, app, pass, pass(), () => {}, noFetch);
	// The handler is synchronous (no await between its checks and its write).
	const call = (req) => {
		const out = { status: 200, body: null };
		const res = { status(c) { out.status = c; return res; }, json(b) { out.body = b; return res; } };
		routes["PUT /api/investor/config"](req, res);
		return out;
	};
	return { api, call, liftedNames: lifted.names };
}

// What the run would do: { state: "set" | "already", oldStored, oldDays, newDays, closes, warnings, auditDetails }.
function plan(db, api, { days }, { today = null } = {}) {
	const spec = api.INVESTOR_CONFIG_KEYS.get(KEY);
	if (!spec) throw new Error(`${KEY} is not in INVESTOR_CONFIG_KEYS`);
	const read = api.investorConfigValue(spec, days);
	if (!read.ok) throw new Refusal(`${KEY} must be a whole number from ${spec.min} to ${spec.max}; got ${JSON.stringify(days)}`);
	const row = db.prepare("SELECT value FROM investor_config WHERE owner_id = 0 AND key = ?").get(KEY);
	const oldStored = row ? row.value : undefined;
	const oldDays = api.settlementGraceDays();
	const newDays = Number(read.value);
	const todayKey = today || api.appTodayKey();
	const current = todayKey.slice(0, 7);
	const months = [shiftMonth(current, -1), current, shiftMonth(current, 1)].filter((m) => m === current || m > current || !api.periodWriteLocked(m));
	const zone = api.APP_TIMEZONE === "America/New_York" ? "ET" : api.APP_TIMEZONE;
	const closes = months.map((m) => {
		const oldEnd = api.graceEndsAt(m, oldDays);
		const newEnd = api.graceEndsAt(m, newDays);
		return {
			period: m, oldCloses: `${dayText(nextDay(oldEnd))} 00:00 ${zone}`, newCloses: `${dayText(nextDay(newEnd))} 00:00 ${zone}`,
			lastOpenDay: newEnd, closesNow: m < current && todayKey > newEnd && !api.periodWriteLocked(m),
		};
	});
	const warnings = closes.filter((c) => c.closesNow).map((c) => `${monthLabel(c.period)} would close at the next sweep tick: its last open day under ${newDays} is ${c.lastOpenDay}, before today (${todayKey})`);
	const state = api.investorConfigSame(spec, oldStored, read.value) ? "already" : "set";
	const auditDetails = `${KEY}: ${oldStored === undefined ? "unset" : oldStored} → ${read.value}`;
	return { state, oldStored, oldDays, newDays, value: read.value, closes, warnings, auditDetails };
}

// Sets the value through the route, in one IMMEDIATE transaction (the database
// is held from the first read) with the audit check.
function apply(db, call, p) {
	return db.transaction(() => {
		const before = db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM audit_trail").get().id;
		const res = call({ query: { ownerId: "global" }, body: { [KEY]: p.value }, session: { user: SYSTEM_USER } });
		if (res.status !== 200 || !res.body || !Array.isArray(res.body.changed) || !res.body.changed.includes(KEY)) {
			throw new Refusal(`PUT /api/investor/config answered ${res.status}: ${JSON.stringify(res.body)}; nothing written`);
		}
		const audits = db.prepare("SELECT * FROM audit_trail WHERE id > ? ORDER BY id").all(before);
		const ok = audits.length === 1 && audits[0].action === "update_investor_config" && audits[0].username === ACTOR
			&& audits[0].role === "system" && Number(audits[0].user_id) === 0 && audits[0].entity_id === "global" && audits[0].details === p.auditDetails;
		if (!ok) throw new Error(`the route's audit row is not the one expected (${JSON.stringify(audits)}); nothing written`);
		return audits[0].id;
	}).immediate();
}

function describe(p) {
	const out = [];
	out.push(`${KEY}: ${p.oldStored === undefined ? `unset (the server uses ${p.oldDays})` : p.oldStored} → ${p.value}`);
	for (const c of p.closes) out.push(`  ${monthLabel(c.period)} closes ${c.newCloses} (now: ${c.oldCloses})`);
	for (const w of p.warnings) out.push(`WARNING: ${w}`);
	if (p.state === "set") out.push(`Audit row: update_investor_config, investor_config global, by "${ACTOR}" (system): ${p.auditDetails}`);
	return out;
}

function main() {
	const opts = readOptions(process.argv.slice(2));
	let target;
	try { target = resolveDatabase(opts.db, ROOT); } catch (err) {
		if (err instanceof DatabaseRefusal) throw new Refusal(err.message);
		throw err;
	}
	const Database = createRequire(path.join(ROOT, "server.js"))("better-sqlite3");
	const db = new Database(target.file, { readonly: opts.dryRun, fileMustExist: true });
	try {
		if (opts.dryRun && !db.readonly) throw new Error("refusing: the dry run's SQLite handle is not read-only");
		db.pragma("busy_timeout = 10000");
		const { api, call } = buildWorld({ db });
		console.log(`Database: ${target.file} (${target.scope === "app" ? "the app's own" : "a copy"})`);
		const p = plan(db, api, opts);
		if (p.state === "already") {
			for (const line of describe(p)) console.log(line);
			console.log(`already ${p.value}; nothing written`);
			return 0;
		}
		if (opts.dryRun) {
			console.log("DRY RUN: nothing written.");
			for (const line of describe(p)) console.log(line);
			return 0;
		}
		for (const line of describe(p)) console.log(line);
		const auditId = apply(db, call, p);
		console.log(`WRITTEN: ${KEY} = ${p.value}; audit row ${auditId}`);
		return 0;
	} finally {
		db.close();
	}
}

if (require.main === module) {
	try {
		process.exit(main());
	} catch (err) {
		if (err instanceof Refusal) { console.error(`REFUSED: ${err.message}`); process.exit(2); }
		console.error(`ERROR: ${err.stack || err.message}`);
		process.exit(1);
	}
}

module.exports = { ACTOR, KEY, ROOTS, DENIED, Refusal, readOptions, buildWorld, plan, apply, describe };
