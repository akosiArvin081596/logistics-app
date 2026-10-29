#!/usr/bin/env node
// Read-only report for the named Super Admin logins (lib/sign-in.js), in ids
// and counts only: no username, email, name, IP or browser is printed.
//
//   --mode=before-flags    before SIGN_IN_AUDIT_ENABLED or NAMED_LOGINS_ENABLED
//                          goes on: the Super Admins (id, created, last sign-in,
//                          must change password), emails on more than one
//                          account, names that are one account's username and
//                          another's email, usernames that differ only in case,
//                          the sign-in rows to expect a day, the audit volume,
//                          the rows that would read "shared login", and the
//                          existing rows the POST /api/users change touches.
//   --mode=before-disable  the checks before the shared login (--shared, default
//                          1) is disabled, for the named accounts (--named=7,8):
//                          C1 each named account is a Super Admin, enabled, has
//                             changed its password and signed in within 7 days
//                          C2 a Super Admin other than the shared login signed in
//                             within 7 days (C1 implies it)
//                          C3 the shared login has no sign-in in 14 days
//                             (last_login_at and `login` rows)
//                          C4 the shared login's live sessions (reported; the
//                             disable ends them)
//                          C5 at least two enabled Super Admins remain after it
//                          C6 the reset script finds each named account
//                             (resolveTarget(), as its dry run does)
//
//   node scripts/shared-login-report.js --db=app.db --mode=before-flags [--json]
//   node scripts/shared-login-report.js --db=app.db --mode=before-disable --named=7,8 [--shared=1] [--json]
//
// The database is opened read-only. Exit 0; before-disable exits 1 when a
// check fails; 2 on a refused argument.

"use strict";

const fs = require("fs");
const { resolveTarget } = require("./reset-super-admin-password.js");

const DAY_MS = 24 * 60 * 60 * 1000;
const STAFF_ROLES = ["Super Admin", "Dispatcher"];
const SHARED_LOGIN_USERNAME = "super_admin";

function refuse(msg) {
	console.error(`REFUSED: ${msg}`);
	process.exit(2);
}

function parseArgs(argv) {
	const out = {};
	for (const a of argv) {
		const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
		if (!m) refuse(`unknown argument ${JSON.stringify(a)}`);
		out[m[1]] = m[2] === undefined ? true : m[2];
	}
	return out;
}

const hasTable = (db, t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
const hasColumn = (db, t, c) => hasTable(db, t) && db.prepare(`PRAGMA table_info("${t}")`).all().some((r) => r.name === c);
const col = (db, c, fallback) => (hasColumn(db, "users", c) ? c : fallback);

// Each stored session's account, role, sign-in instant and expiry, from its
// JSON (connect-style: the cookie's expiry less its max age is the sign-in).
function sessions(db) {
	if (!hasTable(db, "sessions")) return [];
	const out = [];
	for (const row of db.prepare("SELECT sess FROM sessions").all()) {
		let s;
		try { s = JSON.parse(row.sess); } catch { continue; }
		const expires = Date.parse(s?.cookie?.expires || "");
		const maxAge = Number(s?.cookie?.originalMaxAge);
		out.push({
			userId: Number(s?.user?.id) || null,
			role: String(s?.user?.role || ""),
			signedInAt: Number.isFinite(expires) && Number.isFinite(maxAge) ? expires - maxAge : null,
			expires: Number.isFinite(expires) ? expires : null,
		});
	}
	return out;
}

// Ids of the staff accounts among `rows`; the others are counted, not listed.
function staffIdsAndRoles(rows) {
	const byRole = {};
	for (const r of rows) byRole[r.role] = (byRole[r.role] || 0) + 1;
	return { accounts: rows.length, byRole, staffIds: rows.filter((r) => STAFF_ROLES.includes(r.role)).map((r) => r.id).sort((a, b) => a - b) };
}

function count(db, table, where, ...args) {
	if (!hasTable(db, table)) return null;
	return db.prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE ${where}`).get(...args).n;
}

function beforeFlags(db, now) {
	const created = hasColumn(db, "users", "created_at") ? "strftime('%Y-%m-%dT%H:%M:%SZ', created_at)" : "NULL";
	const superAdmins = db.prepare(
		`SELECT id, ${created} AS created, COALESCE(${col(db, "last_login_at", "''")}, '') AS last,
		        COALESCE(${col(db, "must_change_password", "0")}, 0) AS mcp
		   FROM users WHERE role = 'Super Admin' ORDER BY id`,
	).all().map((r) => ({ id: r.id, created: r.created || null, lastSignIn: r.last || null, mustChangePassword: !!r.mcp }));

	const sharedEmailRows = db.prepare(
		`SELECT u.id, u.role FROM users u
		  WHERE COALESCE(u.email, '') <> ''
		    AND EXISTS (SELECT 1 FROM users o WHERE o.id <> u.id AND LOWER(o.email) = LOWER(u.email))`,
	).all();
	const sharedEmailGroups = db.prepare(
		"SELECT COUNT(*) AS n FROM (SELECT LOWER(email) FROM users WHERE COALESCE(email, '') <> '' GROUP BY LOWER(email) HAVING COUNT(*) > 1)",
	).get().n;
	const usernameIsEmail = db.prepare(
		`SELECT a.id AS aid, a.role AS arole, b.id AS bid, b.role AS brole FROM users a
		   JOIN users b ON b.id <> a.id AND COALESCE(b.email, '') <> '' AND LOWER(a.username) = LOWER(b.email)`,
	).all();
	const caseVariantRows = db.prepare(
		`SELECT u.id, u.role FROM users u
		  WHERE EXISTS (SELECT 1 FROM users o WHERE o.id <> u.id AND LOWER(o.username) = LOWER(u.username))`,
	).all();

	const since = now - DAY_MS;
	const recent = sessions(db).filter((s) => s.signedInAt !== null && s.signedInAt >= since);
	const signInsByRole = {};
	for (const s of recent) signInsByRole[s.role || "(none)"] = (signInsByRole[s.role || "(none)"] || 0) + 1;
	const audit30 = count(db, "audit_trail", "timestamp >= ?", new Date(now - 30 * DAY_MS).toISOString());

	const sharedWhere = (c) => `LOWER(TRIM(COALESCE(${c}, ''))) = ?`;
	const sharedRows = {
		audit_trail: count(db, "audit_trail", sharedWhere("username"), SHARED_LOGIN_USERNAME),
		audit_trail_without_account_id: count(db, "audit_trail", `user_id = 0 AND ${sharedWhere("username")}`, SHARED_LOGIN_USERNAME),
		"invoices.created_by": hasColumn(db, "invoices", "created_by") ? count(db, "invoices", sharedWhere("created_by"), SHARED_LOGIN_USERNAME) : null,
		"investor_payout_basis.created_by": hasColumn(db, "investor_payout_basis", "created_by")
			? count(db, "investor_payout_basis", sharedWhere("created_by"), SHARED_LOGIN_USERNAME) : null,
		"investor_payout_basis.updated_by": hasColumn(db, "investor_payout_basis", "updated_by")
			? count(db, "investor_payout_basis", sharedWhere("updated_by"), SHARED_LOGIN_USERNAME) : null,
		"load_status_history.actor": hasColumn(db, "load_status_history", "actor")
			? count(db, "load_status_history", sharedWhere("actor"), SHARED_LOGIN_USERNAME) : null,
	};

	return {
		mode: "before-flags",
		superAdmins,
		sharedEmails: { groups: sharedEmailGroups, ...staffIdsAndRoles(sharedEmailRows) },
		usernameIsAnothersEmail: {
			pairs: usernameIsEmail.length,
			staffIds: [...new Set(usernameIsEmail.flatMap((p) => [
				...(STAFF_ROLES.includes(p.arole) ? [p.aid] : []), ...(STAFF_ROLES.includes(p.brole) ? [p.bid] : []),
			]))].sort((a, b) => a - b),
		},
		usernamesDifferingOnlyInCase: staffIdsAndRoles(caseVariantRows),
		expectedSignInRowsPerDay: { sessionsStartedLast24h: recent.length, byRole: signInsByRole, staffNetworkRecords: recent.filter((s) => STAFF_ROLES.includes(s.role)).length },
		auditRowsPerDayLast30Days: audit30 === null ? null : Math.round((audit30 / 30) * 10) / 10,
		sharedLoginRows: sharedRows,
		existingRowsThePostChangeTouches: 0,
	};
}

function beforeDisable(db, now, named, shared) {
	const disabledCol = hasColumn(db, "users", "disabled_at");
	const lastCol = col(db, "last_login_at", "''");
	const mcpCol = col(db, "must_change_password", "0");
	const account = (id) => db.prepare(
		`SELECT id, role, COALESCE(${mcpCol}, 0) AS mcp, COALESCE(${lastCol}, '') AS last${disabledCol ? ", COALESCE(disabled_at, '') AS disabled" : ", '' AS disabled"}
		   FROM users WHERE id = ?`,
	).get(id) || null;
	const enabledSuperAdmins = db.prepare(
		`SELECT id FROM users WHERE role = 'Super Admin'${disabledCol ? " AND COALESCE(disabled_at, '') = ''" : ""} ORDER BY id`,
	).all().map((r) => r.id);
	// The newest sign-in on record: last_login_at, or a `login` row.
	const lastSignIn = (id) => {
		const a = account(id);
		const stamps = [a && a.last ? Date.parse(a.last) : NaN];
		if (hasTable(db, "audit_trail")) {
			const r = db.prepare("SELECT MAX(timestamp) AS t FROM audit_trail WHERE action = 'login' AND user_id = ?").get(id);
			stamps.push(r && r.t ? Date.parse(r.t) : NaN);
		}
		const ok = stamps.filter(Number.isFinite);
		return ok.length ? Math.max(...ok) : null;
	};
	const within = (ms, days) => ms !== null && ms >= now - days * DAY_MS;
	const days = (ms) => (ms === null ? null : Math.floor((now - ms) / DAY_MS));

	const c1 = named.map((id) => {
		const a = account(id);
		const signed = lastSignIn(id);
		const r = {
			id,
			superAdmin: !!a && a.role === "Super Admin",
			enabled: !!a && !a.disabled,
			passwordChanged: !!a && !a.mcp,
			lastSignInDaysAgo: days(signed),
		};
		r.pass = r.superAdmin && r.enabled && r.passwordChanged && within(signed, 7);
		return r;
	});
	const othersRecent = enabledSuperAdmins.filter((id) => id !== shared && within(lastSignIn(id), 7));
	const sharedSigned = lastSignIn(shared);
	const sharedLive = sessions(db).filter((s) => s.userId === shared && s.expires !== null && s.expires > now).length;
	const remaining = enabledSuperAdmins.filter((id) => id !== shared);
	const c6 = named.map((id) => ({ id, found: !resolveTarget(db, { id }).error }));

	const checks = {
		C1: { pass: c1.length > 0 && c1.every((r) => r.pass), accounts: c1 },
		C2: { pass: othersRecent.length > 0, superAdminIds: othersRecent },
		C3: { pass: !within(sharedSigned, 14), sharedId: shared, lastSignInDaysAgo: days(sharedSigned) },
		C4: { pass: true, info: true, sharedId: shared, liveSessions: sharedLive },
		C5: { pass: remaining.length >= 2, enabledSuperAdminsAfter: remaining.length, superAdminIds: remaining },
		C6: { pass: c6.length > 0 && c6.every((r) => r.found), accounts: c6 },
	};
	return { mode: "before-disable", named, sharedId: shared, disableColumn: disabledCol, checks, pass: Object.values(checks).every((c) => c.pass) };
}

function printText(out) {
	const lines = [];
	if (out.mode === "before-flags") {
		lines.push("Super Admins (id, created, last sign-in, must change password):");
		for (const s of out.superAdmins) lines.push(`  #${s.id}  created ${s.created || "?"}  last sign-in ${s.lastSignIn || "never"}  must change: ${s.mustChangePassword ? "yes" : "no"}`);
		const se = out.sharedEmails;
		lines.push(`Emails on more than one account: ${se.groups} email(s), ${se.accounts} account(s) ${JSON.stringify(se.byRole)}; staff ids: ${se.staffIds.join(", ") || "none"}`);
		lines.push(`Names that are one account's username and another's email: ${out.usernameIsAnothersEmail.pairs}; staff ids: ${out.usernameIsAnothersEmail.staffIds.join(", ") || "none"}`);
		const cv = out.usernamesDifferingOnlyInCase;
		lines.push(`Usernames that differ only in case: ${cv.accounts} account(s) ${JSON.stringify(cv.byRole)}; staff ids: ${cv.staffIds.join(", ") || "none"}`);
		const e = out.expectedSignInRowsPerDay;
		lines.push(`Sign-in rows to expect a day (sessions started in the last 24 h): ${e.sessionsStartedLast24h} ${JSON.stringify(e.byRole)}; network records: ${e.staffNetworkRecords}`);
		lines.push(`audit_trail rows a day over the last 30 days: ${out.auditRowsPerDayLast30Days === null ? "no audit_trail table" : out.auditRowsPerDayLast30Days}`);
		lines.push("Rows that would read \"shared login\":");
		for (const [k, v] of Object.entries(out.sharedLoginRows)) lines.push(`  ${k}: ${v === null ? "no such table or column" : v}`);
		lines.push(`Existing rows the POST /api/users change touches: ${out.existingRowsThePostChangeTouches}`);
	} else {
		const c = out.checks;
		const mark = (k) => (c[k].info ? "INFO" : c[k].pass ? "PASS" : "FAIL");
		lines.push(`Named accounts: ${out.named.map((id) => `#${id}`).join(", ")}; shared login: #${out.sharedId}${out.disableColumn ? "" : " (no disable column here: every account counts as enabled)"}`);
		for (const r of c.C1.accounts) {
			lines.push(`C1 ${r.pass ? "PASS" : "FAIL"}  #${r.id}: ${r.superAdmin ? "Super Admin" : "NOT a Super Admin"}, ${r.enabled ? "enabled" : "DISABLED"}, ${r.passwordChanged ? "password changed" : "MUST CHANGE PASSWORD"}, last sign-in ${r.lastSignInDaysAgo === null ? "never" : `${r.lastSignInDaysAgo} day(s) ago`}`);
		}
		lines.push(`C2 ${mark("C2")}  Super Admins other than #${out.sharedId} signed in within 7 days: ${c.C2.superAdminIds.map((id) => `#${id}`).join(", ") || "none"}`);
		lines.push(`C3 ${mark("C3")}  #${out.sharedId} last sign-in: ${c.C3.lastSignInDaysAgo === null ? "never" : `${c.C3.lastSignInDaysAgo} day(s) ago`} (needs none in 14 days)`);
		lines.push(`C4 ${mark("C4")}  #${out.sharedId} live sessions the disable ends: ${c.C4.liveSessions}`);
		lines.push(`C5 ${mark("C5")}  enabled Super Admins after the disable: ${c.C5.enabledSuperAdminsAfter} (${c.C5.superAdminIds.map((id) => `#${id}`).join(", ") || "none"})`);
		lines.push(`C6 ${mark("C6")}  the reset script finds: ${c.C6.accounts.map((r) => `#${r.id} ${r.found ? "yes" : "NO"}`).join(", ")}`);
		lines.push(out.pass ? "All checks pass." : "A check failed: do not disable the shared login yet.");
	}
	console.log(lines.join("\n"));
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	if (typeof args.db !== "string" || !args.db) refuse("--db=<path> is required");
	if (!fs.existsSync(args.db)) refuse("the database file does not exist");
	const mode = args.mode;
	if (mode !== "before-flags" && mode !== "before-disable") refuse("--mode must be before-flags or before-disable");
	let named = [];
	let shared = 1;
	if (mode === "before-disable") {
		if (typeof args.named !== "string" || !/^\d+(,\d+)*$/.test(args.named)) refuse("--named=<id>[,<id>] (account ids) is required");
		named = [...new Set(args.named.split(",").map(Number))];
		if (args.shared !== undefined) {
			if (typeof args.shared !== "string" || !/^\d+$/.test(args.shared)) refuse("--shared must be an account id");
			shared = Number(args.shared);
		}
		if (named.includes(shared)) refuse("the shared login cannot be one of the named accounts");
	}
	const Database = require("better-sqlite3");
	const db = new Database(args.db, { readonly: true, fileMustExist: true });
	let out;
	try {
		const now = Date.now();
		out = mode === "before-flags" ? beforeFlags(db, now) : beforeDisable(db, now, named, shared);
		out.at = new Date(now).toISOString();
	} finally {
		db.close();
	}
	if (args.json === true) console.log(JSON.stringify(out, null, 2));
	else printText(out);
	if (mode === "before-disable" && !out.pass) process.exit(1);
}

main();
