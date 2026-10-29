"use strict";
// Sign-ins: which account a typed name signs in to, and the audit rows sign-ins
// and sign-outs leave. server.js builds one createSignIn() object beside
// POST /api/auth/login and hands it to the login and logout routes.
//
// findSignInAccount(db, text, { uniqueEmail }) answers { account, by, candidates }:
//   uniqueEmail false (NAMED_LOGINS_ENABLED off): the first row whose username
//     or email matches, the lookup the login route always made;
//   uniqueEmail true: a username match wins; otherwise an email signs in only
//     when exactly one account has it. An email on several accounts gives
//     `candidates` (their ids) and no account.
// `by` is "username" or "email". Matching folds ASCII case (SQLite LOWER()).
//
// The rows (SIGN_IN_AUDIT_ENABLED): `login`, `logout` and `login_refused`, each
// naming the account signed in to, never the session the browser already had.
// Refusals go through logAuditRefusal(), one row a minute per account and code.
// A Super Admin's or Dispatcher's IP and browser go in sign_in_network, keyed to
// the audit row and deleted after SIGN_IN_NETWORK_RETENTION_DAYS; audit rows are
// never edited or deleted, so they hold neither.

const SHARED_LOGIN_USERNAMES = Object.freeze(["super_admin"]);
const STAFF_ROLES = Object.freeze(["Super Admin", "Dispatcher"]);
const SIGN_IN_ACTIONS = Object.freeze(["login", "logout", "login_refused"]);
const SIGN_IN_NETWORK_RETENTION_DAYS = 90;
// A refusal that names no single account (an email on several).
const NO_ACCOUNT_ACTOR = Object.freeze({ id: 0, username: "(several accounts)", role: "(none)" });

// The logins more than one person has used: a row by one names the login, not
// the person. client/src/utils/sharedLogin.js keeps the same list.
function isSharedLoginName(name) {
	return SHARED_LOGIN_USERNAMES.includes(String(name == null ? "" : name).trim().toLowerCase());
}

function findSignInAccount(db, text, { uniqueEmail = false } = {}) {
	const none = { account: null, by: null, candidates: null };
	if (!uniqueEmail) {
		const account = db
			.prepare("SELECT * FROM users WHERE LOWER(username) = LOWER(?) OR LOWER(email) = LOWER(?)")
			.get(text, text);
		if (!account) return none;
		const byUsername = db.prepare("SELECT LOWER(?) = LOWER(?) AS same").get(String(account.username), text).same === 1;
		return { account, by: byUsername ? "username" : "email", candidates: null };
	}
	// An empty name is no account's: it would otherwise match every blank email.
	if (typeof text !== "string" || !text) return none;
	const byUsername = db.prepare("SELECT * FROM users WHERE LOWER(username) = LOWER(?) ORDER BY id LIMIT 1").get(text);
	if (byUsername) return { account: byUsername, by: "username", candidates: null };
	const ids = db.prepare("SELECT id FROM users WHERE LOWER(email) = LOWER(?) ORDER BY id").all(text).map((r) => r.id);
	if (ids.length > 1) return { account: null, by: "email", candidates: ids };
	if (ids.length === 1) {
		const account = db.prepare("SELECT * FROM users WHERE id = ?").get(ids[0]);
		if (account) return { account, by: "email", candidates: null };
	}
	return none;
}

function ensureSignInNetworkTable(db) {
	db.exec(`CREATE TABLE IF NOT EXISTS sign_in_network (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		audit_id INTEGER NOT NULL,
		user_id INTEGER NOT NULL,
		at TEXT NOT NULL,
		ip TEXT NOT NULL DEFAULT '',
		ip_source TEXT NOT NULL DEFAULT '',
		user_agent TEXT NOT NULL DEFAULT ''
	)`);
	db.exec("CREATE INDEX IF NOT EXISTS idx_sign_in_network_at ON sign_in_network(at)");
	db.exec("CREATE INDEX IF NOT EXISTS idx_sign_in_network_audit ON sign_in_network(audit_id)");
}

// Deletes the network records older than the retention window. `at` is always
// an ISO-8601 Z string, so the cutoff compares as text. Returns the count.
function purgeSignInNetwork(db, now = new Date()) {
	const cutoff = new Date(now.getTime() - SIGN_IN_NETWORK_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
	return db.prepare("DELETE FROM sign_in_network WHERE at < ?").run(cutoff).changes;
}

// The sign-in rows, newest first, each with the IP and browser kept for it (null
// once purged, and for an account that is not staff). For a Super Admin route.
function listSignIns(db, { userId = null, limit = 100 } = {}) {
	const n = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 500);
	const actions = SIGN_IN_ACTIONS.map(() => "?").join(", ");
	const byUser = userId === null || userId === undefined ? "" : " AND a.user_id = ?";
	const args = byUser ? [...SIGN_IN_ACTIONS, Number(userId), n] : [...SIGN_IN_ACTIONS, n];
	return db.prepare(
		`SELECT a.id, a.timestamp, a.user_id, a.username, a.role, a.action, a.entity_id, a.details,
		        n.ip, n.ip_source, n.user_agent
		   FROM audit_trail a LEFT JOIN sign_in_network n ON n.audit_id = a.id
		  WHERE a.action IN (${actions})${byUser}
		  ORDER BY a.id DESC LIMIT ?`,
	).all(...args).map((r) => ({
		auditId: r.id,
		at: r.timestamp,
		userId: r.user_id,
		username: r.username,
		role: r.role,
		action: r.action,
		details: r.details || "",
		sharedLogin: isSharedLoginName(r.username),
		network: r.ip === null || r.ip === undefined ? null : { ip: r.ip, ipSource: r.ip_source, userAgent: r.user_agent },
	}));
}

// The object the login and logout routes use. Nothing here throws into a route.
function createSignIn({
	db, logAudit, logAuditRefusal, networkEvidence,
	auditEnabled = false, uniqueEmail = false, logger = console, now = () => Date.now(),
}) {
	const audit = !!auditEnabled;
	const unknownLog = { count: 0, loggedAt: 0 };
	const actor = (account) => ({ session: { user: { id: account.id, username: account.username, role: account.role } } });
	const isStaff = (account) => !!account && STAFF_ROLES.includes(account.role);

	// Runs `write` (a logAudit() or logAuditRefusal() call) and answers the id of
	// the row it added for this action and account, or 0 when it added none (a
	// refusal folded into an earlier row, a failed write). Both writers are
	// synchronous and return nothing, so the row is the one past the highest id
	// read just before; checking its action and account keeps a row another
	// process wrote meanwhile from being taken for it.
	function writeAndFind(write, action, account) {
		let before = null;
		try { before = db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM audit_trail").get().id; } catch { before = null; }
		write();
		if (before === null) return 0;
		const row = db.prepare("SELECT id FROM audit_trail WHERE id > ? AND action = ? AND user_id = ? ORDER BY id DESC LIMIT 1")
			.get(before, action, account.id);
		return row ? row.id : 0;
	}

	// A Super Admin's or Dispatcher's IP and browser, keyed to the audit row.
	function keepNetwork(req, account, auditId) {
		if (!auditId) return;
		try {
			const ev = (networkEvidence && networkEvidence(req)) || {};
			db.prepare("INSERT INTO sign_in_network (audit_id, user_id, at, ip, ip_source, user_agent) VALUES (?, ?, ?, ?, ?, ?)")
				.run(auditId, account.id, new Date(now()).toISOString(), String(ev.ip || ""), String(ev.ipSource || ""), String(ev.userAgent || ""));
		} catch (err) {
			logger.error("sign-in network record failed:", err.message);
		}
	}

	return {
		auditEnabled: audit,
		uniqueEmail: !!uniqueEmail,
		find: (text) => findSignInAccount(db, text, { uniqueEmail: !!uniqueEmail }),
		// A `login` or `logout` row, never coalesced: real use bounds them.
		record(req, action, account, details) {
			if (!audit || !account) return;
			try {
				const write = () => logAudit(actor(account), action, "user", account.id, details);
				if (!isStaff(account)) return void write();
				keepNetwork(req, account, writeAndFind(write, action, account));
			} catch (err) {
				logger.error("sign-in audit failed:", err.message);
			}
		},
		// A `login_refused` row under the account (or, with none, the
		// several-accounts actor), the code appended as every refusal's is.
		refuse(req, action, account, code, details) {
			if (!audit) return;
			try {
				const who = account ? actor(account) : { session: { user: { ...NO_ACCOUNT_ACTOR } } };
				const write = () => logAuditRefusal(who, action, "user", account ? account.id : "", `${details} [${code}]`, code);
				if (!isStaff(account)) return void write();
				keepNetwork(req, account, writeAndFind(write, action, account));
			} catch (err) {
				logger.error("sign-in refusal audit failed:", err.message);
			}
		},
		// A name no account has: no row (there is no one to attribute it to), one
		// log line a minute with the running count. The typed name is not logged.
		unknown() {
			if (!audit) return;
			unknownLog.count++;
			const t = now();
			if (!unknownLog.loggedAt || t - unknownLog.loggedAt > 60000) {
				unknownLog.loggedAt = t;
				logger.warn(`[sign-in] ${unknownLog.count} sign-in attempt(s) for a name no account has, since this server started.`);
			}
		},
	};
}

module.exports = {
	SHARED_LOGIN_USERNAMES,
	STAFF_ROLES,
	SIGN_IN_ACTIONS,
	SIGN_IN_NETWORK_RETENTION_DAYS,
	isSharedLoginName,
	findSignInAccount,
	ensureSignInNetworkTable,
	purgeSignInNetwork,
	listSignIns,
	createSignIn,
};
