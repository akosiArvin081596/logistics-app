#!/usr/bin/env node
// scripts/data-fix-driver-rates.js — gives a daily-rate driver a dated rate
// schedule: his own rate in effect each day from a date on, as the dated
// readers of pay_rate_history price it (server.js loadPayRateIndex(); the
// daily-rate rule's driverDayRater() and PAYOUT_RULES_V2's datedRates), and,
// when the plan says so, his Drivers Database rate (drivers_directory.pay_daily).
//
// What it writes, per driver of the plan file (one SQLite transaction for all):
//   - drivers_directory.pay_daily, when the plan names a new rate;
//   - one pay_rate_history row per dated segment ("from" day, rate), dated at
//     that day's midnight in APP_TIMEZONE, source 'data-fix', APPENDED: no
//     existing row is ever edited or deleted;
//   - a cover row for each seed row dated on or after the first segment whose
//     rate differs from the plan's rate that day: same rate as the plan, same
//     effective_from as the seed, so it sorts right after it (higher id) and the
//     seed never prices a day;
//   - one audit_trail row per write, as a system change (user 0, role system),
//     with the reference "<ref>-<n>" of the approval.
// After the write recordPayRateChanges() finds each driver's latest row equal
// to his directory rate and adds nothing (the plan's last rate must be that rate).
//
// Write only what a replay proves: the rate every dated reader reads for every
// day is computed before and after (the plan, simulated), then read back through
// the server's own loadPayRateIndex(), lifted from this checkout's server.js,
// on the database after the write (a dry run writes to an in-memory copy of the
// three tables that reader reads; an apply reads its own transaction). Any day
// from the first segment on that does not read the plan's rate, or a reader
// that disagrees with the simulation, writes nothing.
//
// Refused (exit 2, nothing written):
//   - a driver name that matches no Drivers Database row, or more than one
//     (normalizeDriverName());
//   - a segment or cover row dated in or before the latest closed month (#547
//     review L2: no row changes a closed-month day);
//   - a closed-month day whose rate would change under any reader that prices it:
//     the Drivers Database rate under the month lock (directoryEditLockBlockers(),
//     its history unbounded, so every closed month counts), a closed month the
//     daily-rate rule priced (fail-closed: while one exists, any changed day is
//     refused, because a later day can pay in it through its load's Assigned
//     month), and PAYOUT_RULES_V2's dated reader while that flag is on;
//   - unreadable month locks, a plan file that does not parse or validate, an
//     approval the script does not list, and the daily-rate rule set here
//     without its start record (lifting it would stamp one).
// With PAYOUT_RULES_V2 off, a day before the first segment can still read a new
// first row (a day before a driver's first row reads that row): those days are
// listed as the V2 listing, not refused (pay plan Q13 / P12, on the #419 gaps
// list, accepted 2026-10-21).
//
// Skipped and said (exit 2; an apply then writes nothing for any driver, so the
// dry run must be clean first): pay type not fixed; a Drivers Database rate
// that is neither the plan's "expect" rate nor its new rate; a plan whose last
// rate is not the driver's directory rate after the fix; a rate saved by a
// person (any non-seed row) on or after the first segment that differs from the
// plan; a change to an open-month day before the first segment; a change to a
// day's price with the flags as set in a month the daily-rate rule does not
// price (the fix must not move pay while the flags are off); a write whose
// reference is already in the audit trail but whose row is not in place.
//
// Idempotent: a write already in place is reported "already applied" and not
// written again; a replay writes 0 rows and exits 0.
//
// It reads and writes SQLite only: no Google Sheets (the month lock is sized
// with every closed month, which can only over-refuse), no network.
//
// The plan file (JSON, kept outside the repository: it names real drivers):
//   { "approval": "<one of APPROVALS>",
//     "drivers": [
//       { "name": "<Drivers Database name>", "expect": { "payDaily": 0 }, "payDaily": 200,
//         "rates": [ { "from": "2026-11-01", "rate": 200 } ] },
//       { "name": "<name>", "expect": { "payDaily": 240 },
//         "rates": [ { "from": "2026-11-01", "rate": 220 }, { "from": "2026-11-05", "rate": 240 } ] } ] }
//   "payDaily" (optional) is the new Drivers Database rate; "expect.payDaily" the
//   rate it must hold before the fix.
//
// Usage (on the server, from the app directory, with the Node pm2 runs it with):
//   node scripts/data-fix-driver-rates.js --plan=<file.json> --dry-run [--db=app.db] [--env-file=<file>]
//   node scripts/data-fix-driver-rates.js --plan=<file.json> --approval=<approval> [--db=app.db]
//   --dry-run    opens the database read-only and prints every row it would
//                write, each driver's rate per day for the first segment's
//                month before and after, and the V2 listing
//   --approval   required to apply: the plan's approval, recorded in the audit rows
//   --db         default: app.db next to server.js; else a copy under the temp
//                directory (scripts/lib/ledger-world.js dbScope())
//   --env-file   the flags to read, for a copy of the database only (default:
//                the app directory's .env)
// Exit codes: 0 done (written, already applied, or a clean dry run), 1 error
// (nothing written), 2 refused or skipped (nothing written).
//
// Required as a module (by its test runner) it runs nothing and exports its parts.

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { createRequire } = require("module");
const { closure } = require("./lib/server-lift");
const { envFor, openDb } = require("./lib/ledger-world");
const driverRateOnly = require("../lib/driver-rate-only");

const ROOT = path.join(__dirname, "..");
const ACTOR = "system: data-fix-driver-rates";
const SOURCE = "data-fix";
// The approvals this script applies, each with its reference prefix. Adding one
// is a reviewed change to this file.
const APPROVALS = Object.freeze({
	"arvin-2026-10-21-a-b": Object.freeze({ ref: "DRF-20261021", what: "pay decisions a and b of 2026-10-21, dated daily rates" }),
});
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
// The closed months' frozen rows: never written here; an apply proves it.
const FINGERPRINTED = ["investor_payouts", "investor_payout_history", "financials_ledger_items", "financials_ledger_freezes", "period_locks"];
// The tables loadPayRateIndex() reads, copied for a dry run's after-state.
const READER_TABLES = ["pay_rate_history", "drivers_directory", "trucks", "audit_trail"];
const ROOTS = ["normalizeDriverName", "loadPayRateIndex", "directoryEditLockBlockers", "directoryPayStruct", "truckDailyRateCandidates",
	"resolveDailyRate", "driverRateOnlyApplies", "installPeriodLockTriggers", "appDay", "lockedPeriodsDesc", "periodLocksReadable",
	"PAYOUT_RULES_V2_ENABLED", "DRIVER_RATE_ONLY_FROM"];
const PROVIDED = ["db", "require", "console", "process", "__dirname", "fetch"];
const DENIED = ["getSheets", "sheets", "SPREADSHEET_ID", "KEY_FILE", "server", "io", "jtCacheInvalidate", "sendEmail", "transporter", "getDrive", "app"];
const LIFTED_REQUIRE_OK = (m) => m === "crypto" || /^\.\/lib\/[\w.-]+$/.test(m);

// A refusal: nothing was written, exit 2.
class Refusal extends Error {}

// ---------------------------------------------------------------- helpers

function addDays(day, n) {
	const [y, m, d] = day.split("-").map(Number);
	const x = new Date(Date.UTC(y, m - 1, d + n, 12));
	return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, "0")}-${String(x.getUTCDate()).padStart(2, "0")}`;
}
const monthOf = (day) => String(day).slice(0, 7);
function lastDayOf(month) {
	const [y, m] = month.split("-").map(Number);
	return addDays(`${month}-01`, new Date(Date.UTC(y, m, 0, 12)).getUTCDate() - 1);
}
const usd = (n) => (n == null ? "none" : `$${Number(n).toFixed(2)}`);
const validDay = (s) => DAY_RE.test(String(s)) && addDays(String(s), 0) === String(s);

// --flag=value / --flag value for --plan, --db, --approval, --env-file;
// --dry-run and --help take none. Anything else is refused, so a mistyped
// --dry-run can never fall through to an apply.
function parseCli(argv) {
	const VALUE = new Set(["plan", "db", "approval", "env-file"]);
	const BOOL = new Set(["dry-run", "help"]);
	const out = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (!a.startsWith("--")) throw new Error(`unexpected argument ${JSON.stringify(a)}`);
		const eq = a.indexOf("=");
		const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
		if (BOOL.has(name)) {
			if (eq !== -1) throw new Error(`--${name} takes no value`);
			out[name] = true;
		} else if (VALUE.has(name)) {
			const value = eq !== -1 ? a.slice(eq + 1) : argv[++i];
			if (value === undefined || value === "" || value.startsWith("--")) throw new Error(`--${name} needs a value`);
			out[name] = value;
		} else {
			throw new Error(`unknown option --${name}`);
		}
	}
	return out;
}

// The plan file, checked: an approval this script lists, and per driver a
// name, an expected current rate, an optional new rate and dated segments in
// order (each day valid, each rate above $0).
function readPlan(text) {
	let plan;
	try { plan = JSON.parse(text); } catch (err) { throw new Refusal(`the plan file is not JSON (${err.message})`); }
	if (!plan || typeof plan !== "object") throw new Refusal("the plan file holds no plan");
	if (!Object.prototype.hasOwnProperty.call(APPROVALS, plan.approval)) {
		throw new Refusal(`the plan's approval ${JSON.stringify(plan.approval)} is not one this script applies (${Object.keys(APPROVALS).join(", ")})`);
	}
	if (!Array.isArray(plan.drivers) || !plan.drivers.length) throw new Refusal("the plan names no driver");
	const rate = (x) => typeof x === "number" && Number.isFinite(x) && x >= 0 && Math.round(x * 100) === x * 100;
	const drivers = plan.drivers.map((d, i) => {
		const at = `plan driver ${i + 1}`;
		if (!d || typeof d.name !== "string" || !d.name.trim()) throw new Refusal(`${at}: no name`);
		if (!d.expect || !rate(d.expect.payDaily)) throw new Refusal(`${at}: expect.payDaily must be a rate in dollars and cents`);
		if (d.payDaily !== undefined && !(rate(d.payDaily) && d.payDaily > 0)) throw new Refusal(`${at}: payDaily must be a rate above $0`);
		if (!Array.isArray(d.rates) || !d.rates.length) throw new Refusal(`${at}: no dated rates`);
		let prev = "";
		const rates = d.rates.map((s, j) => {
			if (!s || !validDay(s.from)) throw new Refusal(`${at}, rate ${j + 1}: "from" must be a day (YYYY-MM-DD)`);
			if (!(rate(s.rate) && s.rate > 0)) throw new Refusal(`${at}, rate ${j + 1}: the rate must be above $0`);
			if (prev && s.from <= prev) throw new Refusal(`${at}: the dated rates must be in date order, one per day`);
			prev = s.from;
			return { from: s.from, rate: s.rate };
		});
		return { name: d.name, expect: { payDaily: d.expect.payDaily }, payDaily: d.payDaily, rates };
	});
	const keys = drivers.map((d) => d.name.trim().toLowerCase().replace(/\s+/g, " "));
	if (new Set(keys).size !== keys.length) throw new Refusal("the plan names a driver twice");
	return { approval: plan.approval, ...APPROVALS[plan.approval], drivers };
}

// ---------------------------------------------------------------- the server's own readers

// The server.js functions this script reads with, lifted from this checkout and
// bound to `db`, with the environment `env` (the app's .env or --env-file).
// Their warnings are collected, not printed.
let LIFTED = null;
function liftWorld(db, env) {
	if (!LIFTED) LIFTED = closure(fs.readFileSync(path.join(ROOT, "server.js"), "utf8"), { roots: ROOTS, provided: PROVIDED, denied: DENIED });
	const appRequire = createRequire(path.join(ROOT, "server.js"));
	const warnings = [];
	const quiet = { log() {}, info() {}, error: (...a) => warnings.push(a.join(" ")), warn: (...a) => warnings.push(a.join(" ")) };
	const liftedRequire = (m) => {
		if (!LIFTED_REQUIRE_OK(m)) throw new Error(`lifted code required ${m}, which this script does not load`);
		return appRequire(m);
	};
	const noFetch = () => { throw new Error("lifted code called fetch(); this script makes no network calls"); };
	const body = ['"use strict";', LIFTED.text, `return { ${ROOTS.join(", ")} };`].join("\n");
	const api = new Function(...PROVIDED, body)(db, liftedRequire, quiet, { env: { ...env }, argv: [] }, ROOT, noFetch);
	api.warnings = warnings;
	return api;
}

// The earliest instant whose business day (appDay()) is `day`, on a 15-minute
// grid: midnight in APP_TIMEZONE.
function midnightOf(day, appDay) {
	const base = Date.parse(`${day}T00:00:00.000Z`);
	const step = 15 * 60000;
	for (let t = base - 14 * 3600000; t <= base + 14 * 3600000; t += step) {
		if (appDay(new Date(t)) === day && appDay(new Date(t - step)) !== day) return new Date(t).toISOString();
	}
	throw new Error(`no midnight found for ${day} in APP_TIMEZONE`);
}

// The rate on `day` from rows sorted by (effective_from, id), exactly as
// loadPayRateIndex().at() reads them: the last row whose business day is on or
// before `day`; a day before the first row reads the first row; no row, null.
function rateOn(rows, day) {
	if (!rows.length) return null;
	let rate = rows[0].rate;
	for (const x of rows) { if (x.day && x.day <= day) rate = x.rate; else break; }
	return rate;
}

function historyOf(db, key, appDay) {
	return db.prepare("SELECT id, rate, effective_from, source FROM pay_rate_history WHERE subject = 'driver' AND subject_key = ? ORDER BY effective_from, id").all(key)
		.map((r) => {
			const d = new Date(r.effective_from);
			return { id: r.id, rate: Number(r.rate) || 0, effective_from: r.effective_from, source: r.source, day: isNaN(d) ? "" : appDay(d) };
		});
}

// loadPayRateIndex()'s in-memory row for a directory rate that differs from the
// latest history row: it counts from today.
function withCurrent(rows, current, today) {
	if (!rows.length) return [{ id: 0, day: "", rate: current }];
	return rows[rows.length - 1].rate === current ? rows : [...rows, { id: Infinity, day: today, rate: current }];
}

function auditRefs(db, ref) {
	const out = new Set();
	const re = new RegExp(`\\[(${ref}-\\d+)\\]`, "g");
	for (const r of db.prepare("SELECT details FROM audit_trail WHERE username = ? AND user_id = 0 AND role = 'system'").all(ACTOR)) {
		for (const m of String(r.details || "").matchAll(re)) out.add(m[1]);
	}
	return out;
}

function fingerprint(db) {
	const h = crypto.createHash("sha256");
	for (const t of FINGERPRINTED) {
		const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
		h.update(`${t}:`);
		if (!exists) { h.update("absent\n"); continue; }
		for (const r of db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).iterate()) h.update(`${JSON.stringify(r)}\n`);
	}
	return h.digest("hex");
}

// ---------------------------------------------------------------- the plan

// Everything a run would write and why, computed from the database as it is.
// Pure reads. `world` is liftWorld(db, env); `today` the business day.
function buildPlan(db, world, plan, { today = world.appDay(new Date()) } = {}) {
	const out = { approval: plan.approval, ref: plan.ref, what: plan.what, today, drivers: [], refusals: [], warnings: [] };
	if (!world.periodLocksReadable()) {
		out.refusals.push("the month locks (period_locks) cannot be read, so no closed month can be ruled out");
		return out;
	}
	const locked = world.lockedPeriodsDesc();
	const latestClosed = locked[0] || "";
	out.locked = locked.slice().sort();
	out.latestClosed = latestClosed;
	const ruleStart = driverRateOnly.readStart(db);
	out.ruleStart = ruleStart;
	out.v2On = !!world.PAYOUT_RULES_V2_ENABLED;
	out.ruleFrom = world.DRIVER_RATE_ONLY_FROM || "";
	if (out.ruleFrom && !ruleStart) {
		out.refusals.push("DRIVER_RATE_ONLY_FROM is set here but the rule has no start record in this database; reading it would stamp one. Start the server first");
		return out;
	}
	out.ruleClosed = locked.filter((p) => driverRateOnly.closedMonthAnswer(db, p, ruleStart) === true).sort();
	const refs = auditRefs(db, plan.ref);
	const directory = db.prepare("SELECT * FROM drivers_directory ORDER BY id").all();
	let n = 0;
	const nextRef = () => `${plan.ref}-${++n}`;

	for (const entry of plan.drivers) {
		const key = world.normalizeDriverName(entry.name);
		const d = { name: entry.name, key, writes: [], skips: [], days: [], v2: [], notes: [] };
		out.drivers.push(d);
		const rows = directory.filter((r) => world.normalizeDriverName(r.driver_name) === key);
		if (rows.length !== 1) {
			out.refusals.push(`"${entry.name}" matches ${rows.length} Drivers Database rows; exactly one is needed`);
			continue;
		}
		const row = rows[0];
		d.row = row;
		const struct = world.directoryPayStruct(row);
		const current = struct.payDaily;
		const finalRate = entry.payDaily !== undefined ? entry.payDaily : current;
		d.current = current;
		d.finalRate = finalRate;
		d.payType = struct.payType;
		const segs = entry.rates;
		const firstDay = segs[0].from;
		const target = (day) => { let r = null; for (const s of segs) { if (s.from <= day) r = s.rate; } return r; };
		const hist = historyOf(db, key, world.appDay);
		d.history = hist;

		if (struct.payType !== "fixed") d.skips.push(`pay type is ${struct.payType}, not fixed`);
		if (current !== entry.expect.payDaily && !(entry.payDaily !== undefined && current === entry.payDaily)) {
			d.skips.push(`the Drivers Database rate is ${usd(current)}; the plan expects ${usd(entry.expect.payDaily)}${entry.payDaily !== undefined ? ` (or ${usd(entry.payDaily)} once applied)` : ""}`);
		}
		if (segs[segs.length - 1].rate !== finalRate) {
			d.skips.push(`the plan's last rate ${usd(segs[segs.length - 1].rate)} is not the driver's Drivers Database rate after the fix (${usd(finalRate)}); the server would add its own row`);
		}

		// The writes, in a fixed order (directory, segments, covers), so each
		// keeps its reference on every run.
		if (entry.payDaily !== undefined) {
			d.writes.push({ ref: nextRef(), kind: "directory", rowId: row.id, from: entry.expect.payDaily, to: entry.payDaily, present: current === entry.payDaily });
		}
		for (const s of segs) {
			const eff = midnightOf(s.from, world.appDay);
			const present = hist.some((h) => h.source === SOURCE && h.effective_from === eff && h.rate === s.rate);
			d.writes.push({ ref: nextRef(), kind: "segment", rate: s.rate, effective_from: eff, day: s.from, present });
		}
		for (const h of hist) {
			if (h.source === SOURCE || !h.day || h.day < firstDay) continue;
			const want = target(h.day);
			const ours = hist.filter((x) => x.source === SOURCE && x.effective_from === h.effective_from && x.id > h.id).pop();
			if (ours) {
				if (ours.rate !== want) d.skips.push(`row ${ours.id} (${usd(ours.rate)}, ${h.day}) is not the plan's ${usd(want)}`);
				d.writes.push({ ref: nextRef(), kind: "cover", rate: want, effective_from: h.effective_from, day: h.day, covers: h, present: ours.rate === want });
			} else if (h.rate !== want) {
				if (h.source === "seed") d.writes.push({ ref: nextRef(), kind: "cover", rate: want, effective_from: h.effective_from, day: h.day, covers: h, present: false });
				else d.skips.push(`a rate saved on ${h.day} (row ${h.id}, ${usd(h.rate)}, source ${h.source}) differs from the plan's ${usd(want)}`);
			}
		}
		for (const w of d.writes) {
			if (!w.present && refs.has(w.ref)) d.skips.push(`${w.ref} is in the audit trail but its write is not in place (changed since?)`);
			if (w.present && !refs.has(w.ref)) d.notes.push(`${w.ref} is already in place without its audit row (set by hand?)`);
		}

		// L2: no row dated in or before a closed month.
		for (const w of d.writes) {
			if (w.kind !== "directory" && !w.present && latestClosed && monthOf(w.day) <= latestClosed) {
				out.refusals.push(`${entry.name}: ${w.ref} would be dated ${w.day}, in or before the latest closed month ${latestClosed}`);
			}
		}

		// The Drivers Database rate under the month lock (every closed month).
		if (entry.payDaily !== undefined && current !== entry.payDaily) {
			const lock = world.directoryEditLockBlockers(row, { pay_daily: entry.payDaily }, { history: { floor: "", unbounded: true } });
			if (lock.unreadable) out.refusals.push(`${entry.name}: the month lock cannot be read`);
			for (const b of lock.blockers || []) out.refusals.push(`${entry.name}: the month lock refuses ${b.field} (${(b.periods || []).join(", ")}): ${b.detail}`);
		}

		// The replay, simulated: every day each reader can read, before and after.
		const afterRows = [...hist];
		let nextId = Math.max(0, ...hist.map((h) => h.id)) + 1;
		for (const w of d.writes) {
			if (w.kind === "directory" || w.present) continue;
			afterRows.push({ id: nextId++, rate: w.rate, effective_from: w.effective_from, source: SOURCE, day: w.day });
		}
		afterRows.sort((a, b) => (a.effective_from < b.effective_from ? -1 : a.effective_from > b.effective_from ? 1 : a.id - b.id));
		const beforeRead = withCurrent(hist, current, today);
		const afterRead = withCurrent(afterRows, finalRate, today);
		d.afterRows = afterRows;
		const allDays = [...hist, ...afterRows].map((h) => h.day).filter(Boolean);
		const firstLocked = out.locked.length ? `${out.locked[0]}-01` : firstDay;
		const start = addDays([firstLocked, firstDay, ...allDays].sort()[0], -1);
		// Through the end of the first segment's month, whose days are printed.
		const showMonth = monthOf(firstDay);
		const end = [addDays([today, ...allDays, ...segs.map((s) => s.from)].sort().pop(), 1), lastDayOf(showMonth)].sort().pop();
		d.range = { start, end };
		const truckRates = [...new Set(world.truckDailyRateCandidates(entry.name))];
		let changed = false;
		for (let day = start; day <= end; day = addDays(day, 1)) {
			const before = rateOn(beforeRead, day);
			const after = rateOn(afterRead, day);
			if (before !== after) changed = true;
			const closed = !!latestClosed && monthOf(day) <= latestClosed;
			if (day >= firstDay) {
				if (after !== target(day)) d.skips.push(`after the fix ${day} would read ${usd(after)}, not the plan's ${usd(target(day))}`);
			} else if (before !== after) {
				if (closed) d.v2.push({ day, before, after });
				else d.skips.push(`${day} (an open month, before the plan's first day) would read ${usd(after)} instead of ${usd(before)}`);
			}
			// The price with the flags as set, in a month the daily-rate rule does
			// not price: the undated chain, which must not move.
			const month = monthOf(day);
			const ruleMonth = world.driverRateOnlyApplies(month);
			const asSet = (own, dated) => truckRates.map((t) => (ruleMonth ? world.resolveDailyRate(dated == null ? own : dated, 0, month) : world.resolveDailyRate(own, t, month)));
			const setBefore = asSet(current, before);
			const setAfter = asSet(finalRate, after);
			if (!ruleMonth && !closed && setBefore.join() !== setAfter.join()) {
				d.skips.push(`${day}: the price with the flags as set would move ${setBefore.map(usd).join("/")} -> ${setAfter.map(usd).join("/")}`);
			}
			if (month === showMonth) {
				const ruleOn = (own, dated) => { const r = dated == null ? own : dated; return r > 0 ? r : 250; };
				d.days.push({ day, asSet: [setBefore, setAfter], ruleOn: [ruleOn(current, before), ruleOn(finalRate, after)], v2Own: [before, after] });
			}
		}
		if (d.v2.length && out.v2On) out.refusals.push(`${entry.name}: PAYOUT_RULES_V2 is on here and ${d.v2.length} closed-month day(s) would read a different rate (${d.v2[0].day} first)`);
		if (changed && out.ruleClosed.length) out.refusals.push(`${entry.name}: ${out.ruleClosed.join(", ")} closed under the daily-rate rule, and a later day can pay in it; a changed rate is refused while one exists`);
		d.skips = [...new Set(d.skips)];
	}
	out.warnings = world.warnings.slice();
	out.refused = out.refusals.length > 0;
	out.skipped = out.drivers.some((d) => d.skips.length);
	out.pending = out.drivers.flatMap((d) => d.writes.filter((w) => !w.present).map((w) => ({ driver: d, w })));
	return out;
}

// ---------------------------------------------------------------- the writes

function writePlan(db, plan, nowIso) {
	const audit = db.prepare("INSERT INTO audit_trail (timestamp, user_id, username, role, action, entity, entity_id, details) VALUES (?, 0, ?, 'system', ?, ?, ?, ?)");
	const tag = `Data fix ${plan.ref}, approval ${plan.approval} (${plan.what})`;
	const written = [];
	for (const { driver: d, w } of plan.pending) {
		if (w.kind === "directory") {
			const changes = db.prepare("UPDATE drivers_directory SET pay_daily = ? WHERE id = ? AND pay_daily IS ?").run(w.to, d.row.id, d.row.pay_daily).changes;
			if (changes !== 1) throw new Error(`Drivers Database row ${d.row.id} changed while this run was writing; nothing was written`);
			const a = audit.run(nowIso, ACTOR, "update_driver_pay", "drivers_directory", String(d.row.id),
				`${d.row.driver_name}: pay_daily ${Number(w.from).toFixed(2)} -> ${Number(w.to).toFixed(2)}. ${tag}. [${w.ref}]`);
			written.push({ ref: w.ref, table: "drivers_directory", id: d.row.id, auditId: Number(a.lastInsertRowid) });
		} else {
			const r = db.prepare("INSERT INTO pay_rate_history (subject, subject_key, rate, effective_from, source) VALUES ('driver', ?, ?, ?, ?)").run(d.key, w.rate, w.effective_from, SOURCE);
			const id = Number(r.lastInsertRowid);
			const why = w.kind === "cover"
				? `, after ${w.covers.source} row ${w.covers.id} (${Number(w.covers.rate).toFixed(2)}) at the same instant, so that row never prices a day`
				: "";
			const a = audit.run(nowIso, ACTOR, "pay_rate_entry", "pay_rate_history", String(id),
				`driver ${d.key}: ${Number(w.rate).toFixed(2)} a day from ${w.effective_from} (${w.day}, business day)${why}. ${tag}. [${w.ref}]`);
			written.push({ ref: w.ref, table: "pay_rate_history", id, auditId: Number(a.lastInsertRowid) });
		}
	}
	return written;
}

// The proof: the server's own reader (loadPayRateIndex(), lifted, on the
// database after the write) reads, for every planned driver and every day of
// the replay, the rate the simulation computed. Throws on any difference.
function prove(afterWorld, plan) {
	const idx = afterWorld.loadPayRateIndex();
	let days = 0;
	for (const d of plan.drivers) {
		if (!d.range) continue;
		const sim = withCurrent(d.afterRows, d.finalRate, plan.today);
		for (let day = d.range.start; day <= d.range.end; day = addDays(day, 1)) {
			const got = idx.at("driver", d.key, day);
			const want = rateOn(sim, day);
			if (got !== want) throw new Error(`the replay does not hold: the server's reader reads ${usd(got)} for ${d.name} on ${day}, the plan ${usd(want)}; nothing was written`);
			days++;
		}
	}
	return days;
}

// The three tables the reader reads (and the audit trail's shape), copied into
// memory for a dry run's after-state.
function shadowCopy(db) {
	const Database = createRequire(path.join(ROOT, "server.js"))("better-sqlite3");
	const mem = new Database(":memory:");
	for (const t of READER_TABLES) {
		const def = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
		if (!def) throw new Error(`the database has no ${t} table`);
		mem.exec(def.sql);
		if (t === "audit_trail") continue;
		const rows = db.prepare(`SELECT * FROM ${t}`).all();
		if (!rows.length) continue;
		const cols = Object.keys(rows[0]);
		const ins = mem.prepare(`INSERT INTO ${t} (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`);
		mem.transaction(() => { for (const r of rows) ins.run(...cols.map((c) => r[c])); })();
	}
	return mem;
}

// A dry run: the plan, then its writes on an in-memory copy and the proof there.
function dryRun(db, env, plan, { nowIso = new Date().toISOString(), today } = {}) {
	const world = liftWorld(db, env);
	const built = buildPlan(db, world, plan, today ? { today } : {});
	if (built.refused || built.skipped) return { plan: built, written: [], provedDays: null };
	if (!built.pending.length) return { plan: built, written: [], provedDays: prove(world, built) };
	const mem = shadowCopy(db);
	try {
		const written = writePlan(mem, built, nowIso);
		const provedDays = prove(liftWorld(mem, env), built);
		return { plan: built, written, provedDays };
	} finally {
		mem.close();
	}
}

// An apply: the closed-month triggers installed first, then the plan, its
// writes, the frozen-row fingerprint and the proof, in one IMMEDIATE
// transaction. Throws Refusal (nothing written) or an error (rolled back).
function apply(db, env, plan, approval, { nowIso = new Date().toISOString(), today } = {}) {
	if (approval !== plan.approval) throw new Refusal(`applying needs --approval=${plan.approval} (the plan's approval)`);
	const world = liftWorld(db, env);
	try {
		world.installPeriodLockTriggers(db);
	} catch (err) {
		throw new Refusal(`the closed-month triggers could not be installed on this connection (${err.message}); nothing was written`);
	}
	const run = db.transaction(() => {
		const built = buildPlan(db, world, plan, today ? { today } : {});
		if (built.refused || built.skipped) return { plan: built, written: [], provedDays: null };
		if (!built.pending.length) return { plan: built, written: [], provedDays: prove(world, built) };
		const frozen = fingerprint(db);
		const written = writePlan(db, built, nowIso);
		const provedDays = prove(liftWorld(db, env), built);
		if (fingerprint(db) !== frozen) throw new Error("the closed months' frozen rows changed; nothing was written");
		return { plan: built, written, provedDays };
	});
	return run.immediate();
}

// ---------------------------------------------------------------- the report

function ranges(items, keyOf) {
	const out = [];
	for (const it of items) {
		const k = keyOf(it);
		const last = out[out.length - 1];
		if (last && last.key === k && addDays(last.to, 1) === it.day) last.to = it.day;
		else out.push({ from: it.day, to: it.day, key: k });
	}
	return out;
}

function render(plan, { dbFile, mode, readonlyHandle, written, provedDays, applyCommand }) {
	const out = [];
	out.push("Data fix: dated driver rates (scripts/data-fix-driver-rates.js)");
	out.push(`Database: ${dbFile} (${readonlyHandle ? "read-only handle" : "writable handle"})`);
	out.push(`Mode: ${mode === "dry-run" ? "DRY RUN, nothing written to the database" : "APPLY"}`);
	out.push(`Approval: ${plan.approval} (${plan.what}); references ${plan.ref}-n`);
	out.push(`Business day: ${plan.today}`);
	if (plan.locked) {
		out.push(`Closed months: ${plan.locked.length ? plan.locked.join(", ") : "none"} (latest ${plan.latestClosed || "none"})`);
		out.push(`Daily-rate rule: ${plan.ruleStart ? `start record from ${plan.ruleStart.from} at ${plan.ruleStart.startedAt}` : "never run (no start record)"}; months closed under it: ${plan.ruleClosed && plan.ruleClosed.length ? plan.ruleClosed.join(", ") : "none"}; DRIVER_RATE_ONLY_FROM ${plan.ruleFrom || "unset"}`);
		out.push(`PAYOUT_RULES_V2: ${plan.v2On ? "ON" : "off"}`);
	}
	for (const [i, d] of plan.drivers.entries()) {
		out.push("");
		if (!d.row) { out.push(`Driver ${i + 1}: ${d.name}: no single Drivers Database row (refused)`); continue; }
		out.push(`Driver ${i + 1}: ${d.name} (Drivers Database row ${d.row.id}, key "${d.key}", pay type ${d.payType}, rate ${usd(d.current)} -> ${usd(d.finalRate)})`);
		out.push("  History before:");
		if (!d.history.length) out.push("    (no row)");
		for (const h of d.history) out.push(`    row ${h.id}: ${usd(h.rate)} from ${h.effective_from} (${h.day}), ${h.source}`);
		out.push("  Writes:");
		for (const w of d.writes) {
			const state = w.present ? "already applied" : mode === "apply" && written.some((x) => x.ref === w.ref) ? "WRITTEN" : "would write";
			const what = w.kind === "directory"
				? `drivers_directory row ${d.row.id}: pay_daily ${usd(w.from)} -> ${usd(w.to)}`
				: `pay_rate_history + driver ${usd(w.rate)} from ${w.effective_from} (${w.day}), source ${SOURCE}` +
					(w.kind === "cover" ? `, after ${w.covers.source} row ${w.covers.id} (${usd(w.covers.rate)}) at the same instant` : "");
			out.push(`    ${w.ref}  ${what}  [${state}]`);
		}
		if (d.days.length) {
			out.push(`  ${monthOf(d.days[0].day)}, the rate per day, before -> after:`);
			out.push("    days                      | flags as set        | DRIVER_RATE_ONLY on | V2 own dated rate");
			const fmt = (x) => (Array.isArray(x) ? x.map(usd).join("/") : usd(x));
			for (const r of ranges(d.days, (x) => JSON.stringify([x.asSet, x.ruleOn, x.v2Own]))) {
				const x = d.days.find((y) => y.day === r.from);
				const span = r.from === r.to ? r.from : `${r.from} .. ${r.to}`;
				out.push(`    ${span.padEnd(25)} | ${`${fmt(x.asSet[0])} -> ${fmt(x.asSet[1])}`.padEnd(19)} | ${`${usd(x.ruleOn[0])} -> ${usd(x.ruleOn[1])}`.padEnd(19)} | ${usd(x.v2Own[0])} -> ${usd(x.v2Own[1])}`);
			}
		}
		if (d.v2.length) {
			out.push(`  V2 listing (PAYOUT_RULES_V2 ${plan.v2On ? "ON: refused" : "off: listed, accepted per pay plan Q13 / #419 gaps"}): closed-month days whose own dated rate reads differently:`);
			for (const r of ranges(d.v2, (x) => `${x.before}|${x.after}`)) {
				const [b, a] = r.key.split("|");
				out.push(`    ${r.from} .. ${r.to}: ${usd(b === "null" ? null : Number(b))} -> ${usd(a === "null" ? null : Number(a))}${r.from === d.v2[0].day ? " (every earlier day reads the same)" : ""}`);
			}
		} else {
			out.push("  V2 listing: no closed-month day reads a different rate");
		}
		for (const s of d.skips) out.push(`  SKIPPED: ${s}`);
		for (const s of d.notes) out.push(`  Note: ${s}`);
	}
	out.push("");
	for (const r of plan.refusals) out.push(`REFUSED: ${r}`);
	for (const w of plan.warnings || []) out.push(`Warning (lifted code): ${w}`);
	const pending = plan.pending ? plan.pending.length : 0;
	if (plan.refused) out.push("Result: refused. Nothing was written.");
	else if (plan.skipped) out.push("Result: skipped (see SKIPPED). Nothing was written for any driver; fix or confirm, then dry-run again.");
	else if (!pending) out.push(`Result: already applied. 0 rows to write${provedDays != null ? `; the server's loadPayRateIndex() reads the plan's rates on ${provedDays} driver-days` : ""}.`);
	else if (mode === "dry-run") {
		out.push(`Result: ${pending} write(s) planned; the replay on an in-memory copy reads the plan's rate through the server's loadPayRateIndex() on ${provedDays} driver-days.`);
		out.push(`Apply with: ${applyCommand}`);
	} else {
		out.push(`Result: ${written.length} write(s) and ${written.length} audit row(s) in one transaction; the server's reader proved ${provedDays} driver-days; the closed months' frozen rows are unchanged.`);
	}
	return out.join("\n");
}

// ---------------------------------------------------------------- main

function main() {
	const refuse = (msg) => {
		console.error(`REFUSED: ${msg}`);
		process.exit(2);
	};
	let args;
	try { args = parseCli(process.argv.slice(2)); } catch (err) { refuse(err.message); }
	if (args.help) {
		console.log("Usage: node scripts/data-fix-driver-rates.js --plan=<file.json> (--dry-run | --approval=<approval>) [--db=app.db] [--env-file=<file>]");
		console.log(`Approvals: ${Object.keys(APPROVALS).join(", ")}`);
		return;
	}
	if (!args.plan) refuse("--plan is required");
	const isDry = args["dry-run"] === true;
	if (!isDry && !args.approval) refuse("without --dry-run this run would write; it needs --approval");
	let plan;
	try { plan = readPlan(fs.readFileSync(args.plan, "utf8")); } catch (err) { refuse(err.message); }
	let env;
	let dbFile;
	try { ({ env, file: dbFile } = envFor({ root: ROOT, dbPath: args.db || path.join(ROOT, "app.db"), envFile: args["env-file"] || null })); } catch (err) { refuse(err.message); }
	if (!fs.existsSync(dbFile)) refuse(`no database at ${dbFile}`);
	// lib/app-time.js reads the zone from this process: the run's own setting.
	if (env.APP_TIMEZONE) process.env.APP_TIMEZONE = env.APP_TIMEZONE;
	const db = openDb({ root: ROOT, dbFile, readonly: isDry });
	const readonlyHandle = db.readonly;
	const applyCommand = `cd ${ROOT} && ${process.execPath} scripts/data-fix-driver-rates.js --plan=${path.resolve(args.plan)} --approval=${plan.approval} --db=${dbFile}`;
	let result;
	try {
		result = isDry ? dryRun(db, env, plan) : apply(db, env, plan, args.approval);
	} catch (err) {
		db.close();
		if (err instanceof Refusal) refuse(err.message);
		throw err;
	}
	db.close();
	console.log(render(result.plan, { dbFile, mode: isDry ? "dry-run" : "apply", readonlyHandle, written: result.written, provedDays: result.provedDays, applyCommand }));
	if (result.plan.refused || result.plan.skipped) process.exit(2);
}

if (require.main === module) {
	try {
		main();
	} catch (err) {
		console.error(`ERROR: ${err.message}. Nothing was written.`);
		process.exit(1);
	}
}

module.exports = {
	ACTOR, SOURCE, APPROVALS, Refusal,
	readPlan, liftWorld, buildPlan, dryRun, apply, render, rateOn, midnightOf, parseCli,
};
