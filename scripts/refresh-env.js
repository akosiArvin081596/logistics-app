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
// See scripts/README-env-refresh.md for the full runbook.
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

const log = (m) => console.log(`[refresh] ${m}`);
const warn = (m) => console.log(`[refresh] WARNING: ${m}`);
function refuse(m, ...extra) {
	console.error(`[refresh] REFUSING: ${m}`);
	for (const e of extra) console.error(`           ${e}`);
	process.exit(1);
}
const human = (b) => (b >= 1 << 30 ? (b / (1 << 30)).toFixed(2) + " GB" : (b / (1 << 20)).toFixed(1) + " MB");

if (!FROM || !TO) {
	console.error("usage: node scripts/refresh-env.js --from <snapshot.db|.gz> --to <app.db> --yes-non-prod");
	console.error("       [--telemetry-days N | --telemetry-all] [--allow-mail] [--dry-run] [--no-backup]");
	process.exit(2);
}

const srcPath = path.resolve(FROM);
const dstPath = path.resolve(TO);
const dstDir = path.dirname(dstPath);

// ===========================================================================
// SAFETY GATES
//
// Modeled on scripts/prepare-test-fixtures.js — deployed-path refusal,
// NODE_ENV refusal, explicit opt-in flag — with three additions this script
// needs because it does far more damage than setting a password: it REPLACES a
// database, and the environment it produces is then booted against a Google
// Sheet.
// ===========================================================================

// 1. Never the production application directory. Note this is deliberately
//    narrower than prepare-test-fixtures' blanket /var/www refusal: staging
//    lives at /var/www/logisx-staging and IS a legitimate target.
if (dstPath === path.join(PROD_APP_DIR, "app.db") || dstDir === PROD_APP_DIR || dstPath.startsWith(PROD_APP_DIR + path.sep)) {
	refuse(`${dstPath} is inside the production application directory (${PROD_APP_DIR}).`);
}
if (srcPath === dstPath) refuse("--from and --to are the same file.");

// 2. NODE_ENV.
if (process.env.NODE_ENV === "production") refuse("NODE_ENV=production.");

// 3. Explicit opt-in.
if (!CONFIRMED) {
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

const envPath = path.join(dstDir, ".env");
const env = parseEnvFile(envPath);
// An explicit SPREADSHEET_ID in the caller's environment overrides the file,
// exactly as dotenv behaves at boot.
const effectiveSheet = process.env.SPREADSHEET_ID || env.SPREADSHEET_ID || "";

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

// ---------------------------------------------------------------------------
// 5. OUTBOUND-EFFECT GATE.
//
// Scrubbing addresses out of the database is only half the job. The other half
// is the environment: a staging box holding production's Gmail app password can
// email a real driver the moment a code path fires, whatever the DB says. Both
// halves are required — one is the belt, one the braces.
// ---------------------------------------------------------------------------
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

if (!fs.existsSync(srcPath)) refuse(`source snapshot not found: ${srcPath}`);

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
const workPath = `${dstPath}.refresh-${stamp}.tmp`;
function rmWork() {
	for (const p of [workPath, `${workPath}-shm`, `${workPath}-wal`]) {
		try { fs.unlinkSync(p); } catch {}
	}
}

(async () => {
	log(`source: ${srcPath} (${human(fs.statSync(srcPath).size)})`);
	log(`target: ${dstPath}`);
	if (DRY_RUN) log("DRY RUN — the target will not be replaced.");

	// -- 1. materialize the source into the work file ------------------------
	if (/\.gz$/i.test(srcPath)) {
		log("decompressing snapshot…");
		await pipeline(fs.createReadStream(srcPath), zlib.createGunzip(), fs.createWriteStream(workPath));
	} else {
		// Copy rather than open-and-backup: the nightly snapshot has no writer,
		// so a byte copy is already consistent, and it is much faster.
		fs.copyFileSync(srcPath, workPath);
	}
	log(`working copy ${human(fs.statSync(workPath).size)}`);

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
	let sigs = 0;
	sigs += setCols("onboarding_documents", { signature_text: "REDACTED" });
	sigs += setCols("investor_onboarding_documents", { signature_text: "REDACTED", signature_image: "" });
	if (sigs) summary.push(`signatures: ${sigs} redacted`);

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
	// everyone believes is clean. Assert the two invariants that must hold.
	const leaks = [];
	{
		const check = new Database(workPath, { readonly: true });
		const one = (sql, label) => {
			try { return check.prepare(sql).get().c; } catch { warn(`post-check "${label}" skipped (table absent)`); return 0; }
		};
		const badMail = one(
			`SELECT COUNT(*) c FROM users WHERE COALESCE(email,'') <> '' AND email NOT LIKE '%@${MAIL_DOMAIN}'`,
			"users.email"
		);
		if (badMail) leaks.push(`${badMail} users.email row(s) still hold a routable address`);
		const sess = one("SELECT COUNT(*) c FROM sessions", "sessions");
		if (sess) leaks.push(`${sess} session row(s) survived`);
		const bank = one("SELECT COUNT(*) c FROM investor_payment_info WHERE COALESCE(account_number,'') <> ''", "investor_payment_info");
		if (bank) leaks.push(`${bank} investor bank account number(s) survived`);
		check.close();
	}
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
})().catch((e) => {
	rmWork();
	refuse(e && e.message ? e.message : String(e));
});
