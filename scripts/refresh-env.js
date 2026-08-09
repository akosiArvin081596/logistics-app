#!/usr/bin/env node
// scripts/refresh-env.js — rebuild a LOCAL or STAGING app.db from a production
// snapshot, trimmed and sanitized, so changes can be tested before they reach prod.
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS
//
//   Staging was 89 commits behind main, its app.db was 639 KB against
//   production's 313 MB, and `routemate_telemetry` held ZERO rows. Every feature
//   that reads telemetry — driver-pay "active days", fuel events, the range and
//   MPG math, geofence departure — therefore behaved differently there than in
//   production, silently and in the optimistic direction. A staging environment
//   that disagrees with production is worse than no staging environment, because
//   people trust it.
//
// WHAT IT DOES NOT DO
//
//   It never reads the LIVE production app.db. The source is the nightly
//   snapshot written by scripts/backup-db.js, which is already a consistent
//   Online-Backup-API copy AND has already passed PRAGMA integrity_check. Taking
//   our own snapshot of the live file would add risk for no gain.
//
// ---------------------------------------------------------------------------
// Usage:
//   node scripts/refresh-env.js --from <snapshot.db|.gz> --to <app.db> --yes-non-prod
//                               [--telemetry-days N | --telemetry-all]
//                               [--allow-mail] [--dry-run] [--no-backup]
//
//   node scripts/refresh-env.js --sanitize-only --from <snap> --emit <out.gz>   # ON THE VPS
//   node scripts/refresh-env.js --check-env-only --to <app.db>                  # gates only
//   node scripts/refresh-env.js --verify <file.db|.gz> [--strict-scan]          # assert only
//   node scripts/refresh-env.js --from <sanitized.gz> --to <app.db> --from-sanitized …
//
// See scripts/README-env-refresh.md for the full runbook.
//
// ---------------------------------------------------------------------------
// WHY --sanitize-only EXISTS: the sanitizer has to run BEFORE the file moves
//
//   Until 2026-08-09 refresh-local.sh scp'd the production snapshot to a laptop
//   and sanitized it there. Every gate below was real, every assertion held —
//   and all of it ran AFTER a full plaintext copy of every SSN, EIN and bank
//   account number had already been written to a developer's disk. The redaction
//   was correct and pointless: the egress had already happened.
//
//   The four modes above split the one thing this script used to do into the
//   pieces that flow needs, so that each piece can run where it belongs:
//
//     --check-env-only   on the LAPTOP, first — judges the target environment
//                        (sheet / mail / autogen) before a single byte moves.
//     --sanitize-only    on the VPS — reads a snapshot, writes a sanitized .gz,
//                        installs nothing anywhere.
//     --verify           anywhere — re-runs the assertions on a finished file.
//     --from-sanitized   on the LAPTOP — install an already-sanitized artifact,
//                        asserting it is clean rather than trusting the sender.
//
//   Nothing was removed. `--from … --to …` still does the whole job in one pass
//   for callers where the snapshot never leaves the box it is on — which is
//   exactly refresh-staging.sh, whose source and target share a filesystem.
// ---------------------------------------------------------------------------
"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const { pipeline } = require("stream/promises");

// ---------------------------------------------------------------------------
// Known-production identifiers. These are the values server.js falls back to
// when the env var is absent, which is the whole trap this script guards:
// production's .env sets NO SPREADSHEET_ID at all, so anything started without
// an explicit override writes to the live Dispatch Management sheet.
// ---------------------------------------------------------------------------
const PROD_SHEET_ID = "1ey1n0AAG0k8k-qwkWh2T_C8VqqY129OQQr7D5wNl7Mo";
const PROD_ARCHIVE_ID = "1WCiMmcI7GuS4eFaG9PAop5CFtMKKtfla1sOAKxcEduI";
const PROD_APP_DIR = "/var/www/logistics-app";

// Matches scripts/prepare-test-fixtures.js and test-suite.js's own default, so a
// refreshed DB is immediately runnable by the harness without a second step.
const PASSWORD = "Password123!";

// RFC 2606 reserves .invalid: guaranteed never to resolve, so even a
// misconfigured mailer cannot deliver. A real-looking domain (example.com,
// or worse a typo'd real one) can.
const MAIL_DOMAIN = "invalid";
// NANP 555-0100..555-0199 is the reserved fictional range.
const PLACEHOLDER_PHONE = "555-0100";

const DEFAULT_TELEMETRY_DAYS = 45;

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
function opt(name, fallback = null) {
	const i = argv.indexOf(name);
	return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
}
const has = (name) => argv.includes(name);

const FROM = opt("--from");
const TO = opt("--to");
const CONFIRMED = has("--yes-non-prod");
const DRY_RUN = has("--dry-run");
const ALLOW_MAIL = has("--allow-mail");
const NO_BACKUP = has("--no-backup");
const TELEMETRY_ALL = has("--telemetry-all");
const TELEMETRY_DAYS = TELEMETRY_ALL ? null : Math.max(0, parseInt(opt("--telemetry-days", String(DEFAULT_TELEMETRY_DAYS)), 10) || 0);

const EMIT = opt("--emit");
const VERIFY = opt("--verify");
const STRICT_SCAN = has("--strict-scan");
const FROM_SANITIZED = has("--from-sanitized");

// One of: install | sanitize-only | check-env-only | verify.
const MODE = has("--verify") ? "verify"
	: has("--sanitize-only") ? "sanitize-only"
	: has("--check-env-only") ? "check-env-only"
	: "install";

// Only these two modes put a database into an environment that will later be
// BOOTED, so only these two are judged by the target-environment gates. The
// other two install nothing: --sanitize-only writes a standalone artifact and
// --verify opens a file read-only. Applying a gate about somebody else's .env
// to them would not add safety, it would just make the gate meaningless in the
// one place people would then learn to bypass it.
const NEEDS_TARGET_ENV = MODE === "install" || MODE === "check-env-only";
const INSTALLS = MODE === "install";

const log = (m) => console.log(`[refresh] ${m}`);
const warn = (m) => console.log(`[refresh] WARNING: ${m}`);
function refuse(m, ...extra) {
	console.error(`[refresh] REFUSING: ${m}`);
	for (const e of extra) console.error(`           ${e}`);
	process.exit(1);
}
const human = (b) => (b >= 1 << 30 ? (b / (1 << 30)).toFixed(2) + " GB" : (b / (1 << 20)).toFixed(1) + " MB");

function usage() {
	console.error("usage: node scripts/refresh-env.js --from <snapshot.db|.gz> --to <app.db> --yes-non-prod");
	console.error("       [--telemetry-days N | --telemetry-all] [--allow-mail] [--dry-run] [--no-backup]");
	console.error("       [--from-sanitized]");
	console.error("   or: node scripts/refresh-env.js --sanitize-only --from <snap> --emit <out.gz>");
	console.error("   or: node scripts/refresh-env.js --check-env-only --to <app.db>");
	console.error("   or: node scripts/refresh-env.js --verify <file.db|.gz> [--strict-scan]");
	process.exit(2);
}
if (MODE === "install" && (!FROM || !TO)) usage();
if (MODE === "sanitize-only" && (!FROM || !EMIT)) usage();
if (MODE === "check-env-only" && !TO) usage();
if (MODE === "verify" && !VERIFY) usage();

const srcPath = FROM ? path.resolve(FROM) : null;
const dstPath = TO ? path.resolve(TO) : null;
const dstDir = dstPath ? path.dirname(dstPath) : null;
const emitPath = EMIT ? path.resolve(EMIT) : null;
const verifyPath = VERIFY ? path.resolve(VERIFY) : null;

// ===========================================================================
// SAFETY GATES
//
// Modeled on scripts/prepare-test-fixtures.js — deployed-path refusal,
// NODE_ENV refusal, explicit opt-in flag — with three additions this script
// needs because it does far more damage than setting a password: it REPLACES a
// database, and the environment it produces is then booted against a Google
// Sheet.
// ===========================================================================

// 0. Never READ the live production database. The header has always claimed
//    this ("It never reads the LIVE production app.db") and nothing enforced
//    it. --sanitize-only is designed to be run ON the VPS, one directory away
//    from that file, so the claim now has to be a check: the live app.db has a
//    writer, and better-sqlite3 opening it would also create -wal/-shm sidecars
//    beside a database this script has no business touching.
const PROD_LIVE_DB = path.join(PROD_APP_DIR, "app.db");
if (srcPath && (srcPath === PROD_LIVE_DB || srcPath === `${PROD_LIVE_DB}-wal` || srcPath === `${PROD_LIVE_DB}-shm`)) {
	refuse(
		`--from is the LIVE production database (${srcPath}).`,
		"Use a snapshot from /var/www/logistics-app/backups/ — those are Online-Backup-API",
		"copies that have already passed integrity_check and have no writer."
	);
}

// 1. Never the production application directory. Note this is deliberately
//    narrower than prepare-test-fixtures' blanket /var/www refusal: staging
//    lives at /var/www/logisx-staging and IS a legitimate target.
//    Applies to --emit as well as --to: --sanitize-only runs on the VPS, so it
//    is the one mode with production's own directory within easy reach.
for (const [flag, p] of [["--to", dstPath], ["--emit", emitPath]]) {
	if (!p) continue;
	if (p === PROD_LIVE_DB || path.dirname(p) === PROD_APP_DIR || p.startsWith(PROD_APP_DIR + path.sep)) {
		refuse(`${flag} ${p} is inside the production application directory (${PROD_APP_DIR}).`);
	}
}
if (srcPath && dstPath && srcPath === dstPath) refuse("--from and --to are the same file.");
if (srcPath && emitPath && srcPath === emitPath) refuse("--from and --emit are the same file.");

// 2. NODE_ENV. Scoped to the modes that install: --sanitize-only replaces no
//    database anywhere, and it is meant to run on the VPS, where a shell that
//    happens to export NODE_ENV=production must not be able to stop a run whose
//    entire purpose is to make the data safe to move.
if (INSTALLS && process.env.NODE_ENV === "production") refuse("NODE_ENV=production.");

// 3. Explicit opt-in — again only where a database is replaced.
if (INSTALLS && !CONFIRMED) {
	refuse("pass --yes-non-prod to confirm this is a throwaway local/staging database.", `target would have been: ${dstPath}`);
}

// ---------------------------------------------------------------------------
// 4. THE SPREADSHEET GATE — the one that actually matters.
//
// This script does not talk to Google. But the environment it produces gets
// BOOTED, and server.js falls through to the production sheet whenever
// SPREADSHEET_ID is absent. So "is this environment safe to start?" is checked
// here, once, rather than hoped for later. We read the .env that sits beside
// the target database, because that is the file the server will actually load.
//
// A path check cannot substitute for this: a directory named "logisx-staging"
// whose .env has no SPREADSHEET_ID is production, whatever it is called. This
// is the same trap as the staging sheet TITLED "logisx-production" — identify
// by ID, never by name.
// ---------------------------------------------------------------------------
function parseEnvFile(p) {
	const out = {};
	if (!fs.existsSync(p)) return out;
	for (const raw of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq === -1) continue;
		out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
	}
	return out;
}

let effectiveSheet = "";
function runTargetEnvGates() {
	const envPath = path.join(dstDir, ".env");
	const env = parseEnvFile(envPath);
	// An explicit SPREADSHEET_ID in the caller's environment overrides the file,
	// exactly as dotenv behaves at boot.
	effectiveSheet = process.env.SPREADSHEET_ID || env.SPREADSHEET_ID || "";

	if (!effectiveSheet) {
		refuse(
			"no SPREADSHEET_ID for the target environment.",
			`checked: ${envPath} and the SPREADSHEET_ID environment variable.`,
			"server.js falls through to the PRODUCTION sheet when this is unset, so a database",
			"refreshed next to such an .env would be a production writer on first boot.",
			"Set a non-production SPREADSHEET_ID before refreshing."
		);
	}
	if (effectiveSheet === PROD_SHEET_ID) {
		refuse(`the target environment's SPREADSHEET_ID is the PRODUCTION sheet (${PROD_SHEET_ID}).`);
	}
	log(`target sheet: ${effectiveSheet} (not production)`);

	const effectiveArchive = process.env.ARCHIVE_SPREADSHEET_ID || env.ARCHIVE_SPREADSHEET_ID || "";
	if (!effectiveArchive) {
		warn("ARCHIVE_SPREADSHEET_ID is unset — the archive viewer will read the PRODUCTION archive.");
		warn("  That sheet is read-only in this app, so it is a leak of scope, not a write risk.");
	} else if (effectiveArchive === PROD_ARCHIVE_ID) {
		warn("ARCHIVE_SPREADSHEET_ID is the production archive (read-only; scope leak, not a write risk).");
	}

	// -----------------------------------------------------------------------
	// 5. OUTBOUND-EFFECT GATE.
	//
	// Scrubbing addresses out of the database is only half the job. The other
	// half is the environment: a staging box holding production's Gmail app
	// password can email a real driver the moment a code path fires, whatever
	// the DB says. Both halves are required — one is the belt, one the braces.
	// -----------------------------------------------------------------------
	const mailArmed = Boolean(env.GMAIL_USER && env.GMAIL_APP_PASSWORD);
	if (mailArmed && !ALLOW_MAIL) {
		refuse(
			`${envPath} has BOTH GMAIL_USER and GMAIL_APP_PASSWORD set.`,
			"This environment can send real email (onboarding acceptance, investor outreach,",
			"the auto-invoice batch summary) and draft real invoices over IMAP.",
			"Remove them from the target .env, or pass --allow-mail if you have deliberately",
			"pointed them at a throwaway mailbox."
		);
	}
	if (mailArmed && ALLOW_MAIL) warn("--allow-mail: this environment CAN send email. Addresses are still scrubbed below.");

	if (String(env.INVOICE_AUTOGEN_ENABLED || "").toLowerCase() === "true") {
		refuse(
			`${envPath} has INVOICE_AUTOGEN_ENABLED=true.`,
			"That batch generates AND auto-submits weekly driver invoices on a timer, then emails a",
			"summary. It moves money and it fires without anyone touching the UI. Turn it off in",
			"the target environment before refreshing."
		);
	}
	for (const k of ["N8N_WEBHOOK_SECRET", "N8N_EXTRACT_SECRET"]) {
		if (env[k]) warn(`${k} is set — n8n could reach this environment and create loads. Remove it unless that is intended.`);
	}
}

// The gates run BEFORE any source file is read, and — the point of
// --check-env-only — before refresh-local.sh has opened an ssh connection.
if (NEEDS_TARGET_ENV) runTargetEnvGates();

if (MODE === "check-env-only") {
	log("target environment gates passed. Nothing was read, copied or written.");
	process.exit(0);
}

const readPath = MODE === "verify" ? verifyPath : srcPath;
if (!fs.existsSync(readPath)) refuse(`${MODE === "verify" ? "file to verify" : "source snapshot"} not found: ${readPath}`);

// ---------------------------------------------------------------------------
let Database;
try {
	Database = require("better-sqlite3");
} catch {
	refuse("better-sqlite3 not available — run this from the application directory so node_modules resolves.");
}

const bcrypt = (() => {
	try { return require("bcryptjs"); } catch { return null; }
})();
if (!bcrypt) refuse("bcryptjs not available — run this from the application directory so node_modules resolves.");

// ---------------------------------------------------------------------------
// Work happens on a temp file beside the target, then swaps in atomically. The
// source snapshot is never opened for writing.
// ---------------------------------------------------------------------------
// 2026-08-08T13:19:23.456Z -> 20260808131923 (14 chars; 15 would trail the
// milliseconds' dot into every backup filename).
const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
// The work file sits beside whatever this run is producing: the target database
// when installing, the emitted artifact when sanitizing on the VPS, and the
// file itself when merely verifying one.
const workBase = MODE === "sanitize-only" ? emitPath : MODE === "verify" ? verifyPath : dstPath;
const workPath = `${workBase}.refresh-${stamp}.tmp`;
function rmWork() {
	for (const p of [workPath, `${workPath}-shm`, `${workPath}-wal`]) {
		try { fs.unlinkSync(p); } catch {}
	}
}

// Anything this script materializes from a production snapshot is a full copy
// of the data it is about to redact, so it is owner-only from the instant it
// exists — not after the sanitize, which is the window that matters.
function materialize(from, to) {
	// Create the file empty and restricted BEFORE any bytes land in it: a mode
	// applied afterwards leaves the whole write readable to everyone.
	fs.writeFileSync(to, "", { mode: 0o600 });
	try { fs.chmodSync(to, 0o600); } catch {}
	if (/\.gz$/i.test(from)) {
		log("decompressing snapshot…");
		return pipeline(fs.createReadStream(from), zlib.createGunzip(), fs.createWriteStream(to, { flags: "w", mode: 0o600 }));
	}
	// Copy rather than open-and-backup: the nightly snapshot has no writer, so a
	// byte copy is already consistent, and it is much faster.
	fs.copyFileSync(from, to);
	try { fs.chmodSync(to, 0o600); } catch {}
	return Promise.resolve();
}

// Declared, not invoked, here: the call sits at the very bottom of the file so
// that every const below has been initialized before any mode runs. --verify on
// an uncompressed file reaches collectLeaks with no await in front of it, which
// during module evaluation is a temporal-dead-zone ReferenceError rather than a
// verification.
async function main() {
	if (MODE === "verify") return runVerify();

	log(`source: ${srcPath} (${human(fs.statSync(srcPath).size)})`);
	log(MODE === "sanitize-only" ? `emit:   ${emitPath}` : `target: ${dstPath}`);
	if (DRY_RUN) log("DRY RUN — the target will not be replaced.");

	// -- 1. materialize the source into the work file ------------------------
	await materialize(srcPath, workPath);
	log(`working copy ${human(fs.statSync(workPath).size)}`);

	// An artifact that is already sanitized is installed, not re-sanitized: the
	// assertions are what make it safe, and they run either way. Re-running the
	// scrub would also re-hash every password and mint new onboarding tokens for
	// no gain, on data that has already been proven clean.
	if (FROM_SANITIZED) return installSanitized();

	const db = new Database(workPath, { fileMustExist: true });
	// The work file is a throwaway we are about to rewrite wholesale. Durability
	// per-statement buys nothing and costs a great deal on ~900k deletes.
	db.pragma("journal_mode = OFF");
	db.pragma("synchronous = OFF");

	const tableExists = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
	const colsOf = (t) => {
		try { return db.prepare(`PRAGMA table_info("${t}")`).all().map((c) => c.name); } catch { return []; }
	};
	const countOf = (t) => {
		try { return db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get().c; } catch { return 0; }
	};
	// Only ever touches columns that exist. The schema drifts (staging was
	// missing period_locks, fuel_events and four other tables entirely), so a
	// hardcoded column list would crash on exactly the databases most in need
	// of a refresh.
	function setCols(table, assignments, where = "") {
		if (!tableExists(table)) return 0;
		const present = new Set(colsOf(table));
		const sets = Object.entries(assignments).filter(([c]) => present.has(c));
		if (!sets.length) return 0;
		const sql = `UPDATE "${table}" SET ${sets.map(([c]) => `"${c}" = ?`).join(", ")}${where ? ` WHERE ${where}` : ""}`;
		try { return db.prepare(sql).run(...sets.map(([, v]) => v)).changes; } catch (e) { warn(`${table}: ${e.message}`); return 0; }
	}
	const summary = [];

	// -- 2. trim telemetry ---------------------------------------------------
	//
	// routemate_telemetry is ~99.7% of every row in this database (933,893 of
	// ~936,000) and is the known performance hotspot. See the README for the
	// full tradeoff; the short version is that trimming does NOT zero historical
	// driver pay, it flips those months to the `estimated` fallback, which pays
	// the FULL scheduled window — i.e. trimming inflates old driver pay and
	// therefore deflates old investor payouts relative to production.
	const telemetryBefore = countOf("routemate_telemetry");
	if (tableExists("routemate_telemetry") && !TELEMETRY_ALL) {
		if (TELEMETRY_DAYS === 0) {
			const n = db.prepare("DELETE FROM routemate_telemetry").run().changes;
			summary.push(`routemate_telemetry: emptied (${n} rows removed)`);
		} else {
			// Cut on the newest row in the snapshot, not on wall-clock now(). A
			// snapshot restored a week later would otherwise silently keep a
			// week less than asked for.
			const newest = db.prepare("SELECT MAX(fetched_at) m FROM routemate_telemetry").get().m;
			if (!newest) {
				summary.push("routemate_telemetry: already empty");
			} else {
				const n = db
					.prepare("DELETE FROM routemate_telemetry WHERE fetched_at < datetime(?, ?)")
					.run(newest, `-${TELEMETRY_DAYS} day`).changes;
				const kept = countOf("routemate_telemetry");
				summary.push(`routemate_telemetry: kept ${kept} rows (last ${TELEMETRY_DAYS}d to ${newest}), removed ${n}`);
			}
		}
	} else if (TELEMETRY_ALL) {
		summary.push(`routemate_telemetry: kept all ${telemetryBefore} rows (--telemetry-all)`);
	}

	// driver_locations is the retired phone-GPS table: no endpoint reads or
	// writes it any more, and it is nothing but historical position PII.
	if (tableExists("driver_locations")) {
		const n = db.prepare("DELETE FROM driver_locations").run().changes;
		if (n) summary.push(`driver_locations: emptied (${n} rows) — retired 2026-05-13, no reader`);
	}

	// -- 3. sanitize ---------------------------------------------------------

	// 3a. Sessions. A session row caches the user record, so one surviving
	//     session authenticates against the OLD password hash we are about to
	//     replace. Clearing them is what makes the re-hash below actually take
	//     effect, and it forces re-login on a copy that is not production.
	if (tableExists("sessions")) {
		const n = db.prepare("DELETE FROM sessions").run().changes;
		summary.push(`sessions: cleared (${n}) — forces re-login`);
	}

	// 3b. Passwords. Production hashes are bcrypt, so they are not reversible —
	//     but they ARE the live credentials, and a copy of them on a laptop or a
	//     staging box is a copy of production's authentication. Replace every
	//     one with the harness's own default so the DB is usable AND no
	//     production password works here.
	if (tableExists("users")) {
		const hash = bcrypt.hashSync(PASSWORD, 10);
		const n = setCols("users", { password_hash: hash, must_change_password: 0 });
		summary.push(`users: ${n} password hash(es) replaced with the test default`);

		// demo_viewer: role "Super Admin", password published in a public repo,
		// gated only by an HTTP-method check. Removed from production
		// 2026-08-04; a copy is the same account with the same hole.
		try {
			const d = db.prepare("SELECT id FROM users WHERE username = 'demo_viewer'").get();
			if (d) {
				db.prepare("DELETE FROM users WHERE id = ?").run(d.id);
				summary.push("users: demo_viewer deleted (removed from production 2026-08-04)");
			}
		} catch {}

		// 3c. Email. Rewritten per-row to <username>@invalid so accounts stay
		//     distinguishable (support tickets, the investor preview, "which
		//     investor is this") while being undeliverable by construction.
		if (colsOf("users").includes("email")) {
			const n2 = db
				.prepare(`UPDATE users SET email = lower(replace(replace(username,' ','.'),'@','.')) || '@${MAIL_DOMAIN}' WHERE COALESCE(email,'') <> ''`)
				.run().changes;
			summary.push(`users: ${n2} email(s) redirected to @${MAIL_DOMAIN}`);
		}
	}

	// 3d. Every other address/phone the app could actually send to. These are
	//     the tables nodemailer and the outreach log read from.
	let contacts = 0;
	for (const [table, cols] of Object.entries({
		drivers_directory: { email: `id || '.driver@${MAIL_DOMAIN}'`, phone: null, cell: null },
		investors: { email: `id || '.investor@${MAIL_DOMAIN}'`, phone: null },
		investor_applications: { email: `id || '.investorapp@${MAIL_DOMAIN}'`, phone: null },
		investor_outreach_log: { email: `id || '.outreach@${MAIL_DOMAIN}'` },
		job_applications: { email: `id || '.applicant@${MAIL_DOMAIN}'`, phone: null, cell: null },
		sheet_job_tracking: { email: `'row@${MAIL_DOMAIN}'`, phone_number: null },
	})) {
		if (!tableExists(table)) continue;
		const present = new Set(colsOf(table));
		for (const [col, expr] of Object.entries(cols)) {
			if (!present.has(col)) continue;
			try {
				const sql = expr
					? `UPDATE "${table}" SET "${col}" = ${expr} WHERE COALESCE("${col}",'') <> ''`
					: `UPDATE "${table}" SET "${col}" = '${PLACEHOLDER_PHONE}' WHERE COALESCE("${col}",'') <> ''`;
				contacts += db.prepare(sql).run().changes;
			} catch (e) { warn(`${table}.${col}: ${e.message}`); }
		}
	}
	summary.push(`contact fields: ${contacts} email/phone value(s) neutralized`);

	// 3e. Money and identity. Bank details, tax ids and licence numbers have no
	//     test value whatsoever — nothing computes from them, they are only ever
	//     displayed or printed — so there is no reason to carry them.
	let secrets = 0;
	secrets += setCols("investor_payment_info", { routing_number: "", account_number: "", account_name: "REDACTED", bank_name: "REDACTED BANK" });
	secrets += setCols("driver_payment_info", {
		bank_routing: "", bank_account: "", bank_acct_name: "REDACTED",
		bank_name: "REDACTED BANK", bank_address: "REDACTED", bank_phone: PLACEHOLDER_PHONE, check_name: "REDACTED",
	});
	secrets += setCols("investors", { ein_ssn: "", address: "REDACTED" });
	secrets += setCols("investor_applications", { ein_ssn: "", address: "REDACTED" });
	secrets += setCols("job_applications", { ssn: "", dob: "", drivers_license: "", address: "REDACTED", signature: "" });
	secrets += setCols("drivers_directory", { address: "REDACTED" });
	summary.push(`bank / tax / identity fields: ${secrets} row-update(s) redacted`);

	// 3f. Signatures are a legal artefact and, as base64 images, also most of
	//     the weight of the onboarding tables.
	//     ⚠️ The SIGNING EVIDENCE columns go with them. `signed_ip` and
	//     `signed_user_agent` are personal data about the signer — an address
	//     and a browser fingerprint — and `consent_text` is free text off the
	//     wire. Without this, every refresh copies real signer IPs into a 644
	//     app.db on the shared VPS and onto every developer's laptop, and the
	//     assertion block below passes while it happens, because it only knows
	//     to look for emails, sessions and bank numbers. `evidence_version` and
	//     `artifact_sha256` are deliberately KEPT: the version is what marks a
	//     row as captured-under-the-evidence-regime, and a digest of a file that
	//     is not copied anyway discloses nothing.
	let sigs = 0;
	const EVIDENCE_REDACTIONS = { signed_ip: "", signed_ip_source: "", signed_user_agent: "", consent_text: "" };
	sigs += setCols("onboarding_documents", { signature_text: "REDACTED", ...EVIDENCE_REDACTIONS });
	sigs += setCols("investor_onboarding_documents", { signature_text: "REDACTED", signature_image: "", ...EVIDENCE_REDACTIONS });
	if (sigs) summary.push(`signatures + signing evidence: ${sigs} redacted`);

	// 3g. Onboarding access tokens are live bearer credentials for the PUBLIC
	//     /api/public/investor-onboarding/:id/* flow. Regenerating them means a
	//     leaked copy of this database cannot be replayed against production,
	//     and a link mailed from production cannot be replayed against staging.
	if (tableExists("investor_applications") && colsOf("investor_applications").includes("access_token")) {
		const rows = db.prepare("SELECT id FROM investor_applications WHERE COALESCE(access_token,'') <> ''").all();
		const upd = db.prepare("UPDATE investor_applications SET access_token = ? WHERE id = ?");
		for (const r of rows) upd.run(crypto.randomBytes(24).toString("hex"), r.id);
		if (rows.length) summary.push(`investor_applications: ${rows.length} access token(s) regenerated`);
	}

	// DELIBERATELY NOT SCRUBBED, and why:
	//   geocode_cache.address, load_coordinates.pickup_address/dropoff_address —
	//     shipper/receiver facility addresses, i.e. business locations, not
	//     personal contact details. They are also the ONLY coordinate source
	//     geofencing has (checkGeofence's sheet columns do not exist), so
	//     scrubbing them disables the feature you would be trying to test.
	//   trucks.license_plate, trailers.license_plate, routemate_vehicles.license_num —
	//     company asset identifiers, and the ELD linkage keys off adjacent
	//     columns. No personal exposure.
	//   messages / notifications bodies — operational content, and the chat
	//     surfaces are worth exercising with realistic volume.

	// -- 4. reclaim + verify -------------------------------------------------
	log("vacuuming…");
	db.pragma("journal_mode = DELETE");   // VACUUM cannot run with journal_mode=OFF
	db.exec("VACUUM");
	const integrity = db.pragma("integrity_check", { simple: true });
	const tables = db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table'").get().c;
	const users = countOf("users");
	const telemetryAfter = countOf("routemate_telemetry");
	// Leave the file in DELETE mode, i.e. with NO -wal/-shm sidecars. server.js
	// sets `journal_mode = WAL` itself on boot, so handing it a WAL file buys
	// nothing — and it costs something: the rename below moves only the main
	// file, so any sidecar written here is orphaned under the old name, exactly
	// the failure scripts/backup-db.js documents. A stray -wal beside a database
	// it does not belong to is not staleness, it is corruption.
	db.pragma("journal_mode = DELETE");
	db.close();

	if (String(integrity).toLowerCase() !== "ok") {
		rmWork();
		refuse(`integrity_check on the rebuilt database returned "${integrity}" — nothing was replaced.`);
	}

	// A sanitizer that silently no-ops is worse than none: it produces a file
	// everyone believes is clean.
	const { leaks, advisories } = collectLeaks(workPath);
	for (const a of advisories) warn(a);
	if (leaks.length) {
		rmWork();
		refuse("post-sanitization check failed — nothing was replaced.", ...leaks);
	}

	log("");
	for (const s of summary) log(`  ${s}`);
	log("");
	log(`rebuilt: ${human(fs.statSync(workPath).size)}, ${tables} tables, ${users} users, ${telemetryAfter} telemetry rows`);
	log(`verified: integrity_check ok`);

	if (DRY_RUN) {
		rmWork();
		log("DRY RUN — work file discarded, target untouched.");
		return;
	}

	// -- 4b. emit, for the run that happens ON THE VPS ------------------------
	// This is the whole point of --sanitize-only: the bytes that leave the box
	// are these bytes, produced after every redaction above and after the
	// assertions just passed. Nothing is installed; the caller transfers the
	// artifact and deletes the working copy.
	if (MODE === "sanitize-only") return emitArtifact();

	// -- 5. swap in ----------------------------------------------------------
	if (fs.existsSync(dstPath) && !NO_BACKUP) {
		const bak = `${dstPath}.pre-refresh-${stamp}`;
		fs.renameSync(dstPath, bak);
		// -wal / -shm belong to the OLD database. Left in place they would be
		// interpreted as sidecars of the NEW file, which is a different database
		// — that is corruption, not staleness.
		for (const sfx of ["-wal", "-shm"]) {
			try { fs.renameSync(`${dstPath}${sfx}`, `${bak}${sfx}`); } catch {}
		}
		log(`previous database moved to ${path.basename(bak)}`);
	} else if (fs.existsSync(dstPath)) {
		for (const sfx of ["-wal", "-shm"]) { try { fs.unlinkSync(`${dstPath}${sfx}`); } catch {} }
		fs.unlinkSync(dstPath);
	}
	fs.renameSync(workPath, dstPath);
	// Belt and braces: clear any sidecar the work file may still have left.
	for (const sfx of ["-wal", "-shm"]) { try { fs.unlinkSync(`${workPath}${sfx}`); } catch {} }
	log(`installed ${dstPath}`);
	log("");
	log(`Every account's password is now: ${PASSWORD}`);
	log("Start the server with an explicit non-production SPREADSHEET_ID:");
	log(`  SPREADSHEET_ID=${effectiveSheet} PORT=<non-3000> npm start`);
}

// ===========================================================================
// THE ASSERTIONS
//
// One function, used by all three of the places that need to answer "is this
// file safe to move?": the sanitize pass, `--verify` on a finished artifact,
// and `--from-sanitized` before it installs one. Written once on purpose —
// a second copy is a second thing to forget to update when a column is added
// to the scrub list, and the whole value of these checks is that they fail
// when the scrub silently stops covering something.
//
// TIERED, and the tiering is load-bearing.
//   leaks      — a named column that the sanitizer redacts is still populated.
//                Precise, so it is a hard refusal.
//   advisories — the free-text sweep. It reads columns nobody redacts
//                (message bodies, audit notes), where a broker's address is
//                ordinary content rather than a leak. Failing on those would
//                make the refusal routine, and a routine refusal gets bypassed
//                with a flag and then permanently. --strict-scan promotes them
//                for callers who know their data has none.
// ===========================================================================

// ###-##-#### only. NEVER a bare 9-digit run: load ids in this system are
// exactly that shape (562620213, 563593554), so a 9-digit rule would flag the
// Job Tracking mirror on every single run and teach everyone to ignore it.
const SSN_SHAPE = /\b\d{3}-\d{2}-\d{4}\b/;
const ROUTABLE_EMAIL = new RegExp(String.raw`[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]*[A-Za-z0-9]\.[A-Za-z]{2,}`);

// Columns the scrub above is responsible for. Kept adjacent to it deliberately:
// if a column is added there and not here, the assertion stops covering it, and
// this comment is the only thing standing between that and a silent regression.
const REDACTED_EMPTY = [
	["investor_payment_info", "routing_number", "investor bank routing number"],
	["investor_payment_info", "account_number", "investor bank account number"],
	["driver_payment_info", "bank_routing", "driver bank routing number"],
	["driver_payment_info", "bank_account", "driver bank account number"],
	["investors", "ein_ssn", "investor EIN/SSN"],
	["investor_applications", "ein_ssn", "investor-application EIN/SSN"],
	["job_applications", "ssn", "applicant SSN"],
	["job_applications", "drivers_license", "applicant driver's licence number"],
	// Signing evidence. Asserted, not assumed — the whole point is that a
	// redaction step which silently stops matching (a renamed column, a new
	// table) must fail the run rather than ship a database everyone believes is
	// clean. `evidence_version` and `artifact_sha256` are deliberately NOT here:
	// the version marks a row as captured under the evidence regime, and a digest
	// of a file this script never copies discloses nothing.
	["onboarding_documents", "signed_ip", "signer IP address"],
	["onboarding_documents", "signed_user_agent", "signer user agent"],
	["investor_onboarding_documents", "signed_ip", "signer IP address"],
	["investor_onboarding_documents", "signed_user_agent", "signer user agent"],
];
const REDIRECTED_EMAIL = [
	["users", "email"], ["drivers_directory", "email"], ["investors", "email"],
	["investor_applications", "email"], ["investor_outreach_log", "email"],
	["job_applications", "email"], ["sheet_job_tracking", "email"],
];
const MUST_BE_EMPTY_TABLES = [
	["sessions", "session row(s) survived — each caches a user record and authenticates against the pre-refresh hash"],
	["driver_locations", "retired phone-GPS position row(s) survived"],
];

function collectLeaks(dbPath, { scan = true } = {}) {
	const leaks = [];
	const advisories = [];
	const check = new Database(dbPath, { readonly: true });
	try {
		const cols = (t) => {
			try { return new Set(check.prepare(`PRAGMA table_info("${t}")`).all().map((c) => c.name)); } catch { return new Set(); }
		};
		const has_ = (t, c) => cols(t).has(c);
		const count = (sql) => { try { return check.prepare(sql).get().c; } catch { return 0; } };

		for (const [t, c, label] of REDACTED_EMPTY) {
			if (!has_(t, c)) continue;
			const n = count(`SELECT COUNT(*) c FROM "${t}" WHERE COALESCE("${c}",'') <> ''`);
			if (n) leaks.push(`${n} ${label}(s) survived in ${t}.${c}`);
		}
		for (const [t, c] of REDIRECTED_EMAIL) {
			if (!has_(t, c)) continue;
			const n = count(`SELECT COUNT(*) c FROM "${t}" WHERE COALESCE("${c}",'') <> '' AND "${c}" NOT LIKE '%@${MAIL_DOMAIN}'`);
			if (n) leaks.push(`${n} ${t}.${c} row(s) still hold a routable address`);
		}
		for (const [t, why] of MUST_BE_EMPTY_TABLES) {
			const n = count(`SELECT COUNT(*) c FROM "${t}"`);
			if (n) leaks.push(`${n} ${why}`);
		}

		if (scan) {
			// Every TEXT-ish column in the database, read once. Values are counted
			// and located, never printed — a leak report that quotes the leak is
			// the same disclosure in a log file.
			const tables = check.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
			const redactedCols = new Set(REDACTED_EMPTY.map(([t, c]) => `${t}.${c}`));
			for (const t of tables) {
				let info = [];
				try { info = check.prepare(`PRAGMA table_info("${t}")`).all(); } catch { continue; }
				const textCols = info.filter((c) => !/^(INT|REAL|NUM|BLOB)/i.test(String(c.type || ""))).map((c) => c.name);
				if (!textCols.length) continue;
				let rows;
				try { rows = check.prepare(`SELECT ${textCols.map((c) => `"${c}"`).join(",")} FROM "${t}"`).all(); } catch { continue; }
				const hits = new Map();
				for (const row of rows) {
					for (const c of textCols) {
						const v = row[c];
						if (typeof v !== "string" || v.length < 5) continue;
						const ssn = SSN_SHAPE.test(v);
						const mail = ROUTABLE_EMAIL.test(v) && !v.includes(`@${MAIL_DOMAIN}`);
						if (!ssn && !mail) continue;
						const k = `${c}|${ssn ? "ssn" : ""}${mail ? "email" : ""}`;
						hits.set(k, (hits.get(k) || 0) + 1);
					}
				}
				for (const [k, n] of hits) {
					const [c, kind] = k.split("|");
					const msg = `${t}.${c}: ${n} value(s) matching ${kind === "ssn" ? "an SSN shape (###-##-####)" : "a routable email address"}`;
					// A hit inside a column the scrub owns is never advisory.
					if (STRICT_SCAN || redactedCols.has(`${t}.${c}`)) leaks.push(msg);
					else advisories.push(`free-text scan — ${msg}`);
				}
			}
		}
	} finally {
		try { check.close(); } catch {}
	}
	return { leaks, advisories };
}

// --- --verify ---------------------------------------------------------------
// Read-only, so it can be pointed at anything: the artifact that just arrived
// over scp, a local app.db of unknown provenance, an old snapshot found in a
// temp directory. A .gz is expanded to a private work file and removed again.
async function runVerify() {
	log(`verifying: ${verifyPath} (${human(fs.statSync(verifyPath).size)})`);
	let target = verifyPath;
	if (/\.gz$/i.test(verifyPath)) {
		await materialize(verifyPath, workPath);
		target = workPath;
	}
	let result;
	try {
		const integrity = new Database(target, { readonly: true });
		const ok = integrity.pragma("integrity_check", { simple: true });
		integrity.close();
		if (String(ok).toLowerCase() !== "ok") {
			rmWork();
			refuse(`integrity_check returned "${ok}".`);
		}
		result = collectLeaks(target, { scan: true });
	} finally {
		if (target === workPath) rmWork();
	}
	for (const a of result.advisories) warn(a);
	if (result.leaks.length) {
		refuse(`${verifyPath} is NOT sanitized.`, ...result.leaks);
	}
	log(`clean: no routable address, bank number, tax id or session survives${STRICT_SCAN ? " (strict scan)" : ""}.`);
	log("integrity_check ok");
}

// --- --sanitize-only --------------------------------------------------------
function emitArtifact() {
	// gzip, because the artifact exists to cross a network. Written 600 from the
	// first byte and only then moved into place, so there is no window in which
	// a complete database sits at the emit path world-readable.
	const tmpOut = `${emitPath}.partial`;
	return pipeline(
		fs.createReadStream(workPath),
		zlib.createGzip({ level: 6 }),
		fs.createWriteStream(tmpOut, { mode: 0o600 })
	).then(() => {
		try { fs.chmodSync(tmpOut, 0o600); } catch {}
		fs.renameSync(tmpOut, emitPath);
		rmWork();                       // the unsanitized-then-sanitized working copy goes now
		log("");
		log(`emitted ${emitPath} (${human(fs.statSync(emitPath).size)}, mode 600)`);
		log("working copy removed. Only the sanitized artifact remains.");
	}).catch((e) => {
		try { fs.unlinkSync(tmpOut); } catch {}
		rmWork();
		refuse(`emit failed: ${e.message}`);
	});
}

// --- --from-sanitized -------------------------------------------------------
// Installs an artifact produced by --sanitize-only elsewhere. It re-asserts
// rather than trusting: the sanitizer that produced this file ran on another
// machine, possibly from an older checkout, and "the sender says it is clean"
// is not a property of the bytes. If the assertions fail the install is
// refused, which is the correct outcome — that artifact must not land.
function installSanitized() {
	const integrity = new Database(workPath, { readonly: true });
	const ok = integrity.pragma("integrity_check", { simple: true });
	const tables = integrity.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table'").get().c;
	let users = 0, telemetry = 0;
	try { users = integrity.prepare("SELECT COUNT(*) c FROM users").get().c; } catch {}
	try { telemetry = integrity.prepare("SELECT COUNT(*) c FROM routemate_telemetry").get().c; } catch {}
	integrity.close();
	if (String(ok).toLowerCase() !== "ok") {
		rmWork();
		refuse(`integrity_check on the received artifact returned "${ok}" — nothing was replaced.`);
	}

	const { leaks, advisories } = collectLeaks(workPath);
	for (const a of advisories) warn(a);
	if (leaks.length) {
		rmWork();
		refuse(
			"the received artifact is NOT sanitized — nothing was replaced.",
			...leaks,
			"This should be impossible: --sanitize-only asserts the same things before it emits.",
			"Do not work around it by sanitizing locally — find out why the remote pass did not run."
		);
	}
	log(`received artifact verified: integrity ok, ${tables} tables, ${users} users, ${telemetry} telemetry rows, 0 leaks`);

	if (DRY_RUN) {
		rmWork();
		log("DRY RUN — work file discarded, target untouched.");
		return;
	}
	if (fs.existsSync(dstPath) && !NO_BACKUP) {
		const bak = `${dstPath}.pre-refresh-${stamp}`;
		fs.renameSync(dstPath, bak);
		for (const sfx of ["-wal", "-shm"]) {
			try { fs.renameSync(`${dstPath}${sfx}`, `${bak}${sfx}`); } catch {}
		}
		log(`previous database moved to ${path.basename(bak)}`);
	} else if (fs.existsSync(dstPath)) {
		for (const sfx of ["-wal", "-shm"]) { try { fs.unlinkSync(`${dstPath}${sfx}`); } catch {} }
		fs.unlinkSync(dstPath);
	}
	fs.renameSync(workPath, dstPath);
	for (const sfx of ["-wal", "-shm"]) { try { fs.unlinkSync(`${workPath}${sfx}`); } catch {} }
	log(`installed ${dstPath}`);
	log("");
	log(`Every account's password is now: ${PASSWORD}`);
	log("Start the server with an explicit non-production SPREADSHEET_ID:");
	log(`  SPREADSHEET_ID=${effectiveSheet} PORT=<non-3000> npm start`);
}

// ---------------------------------------------------------------------------
main().catch((e) => {
	rmWork();
	refuse(e && e.message ? e.message : String(e));
});
