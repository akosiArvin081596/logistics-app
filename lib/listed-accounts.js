"use strict";

// ===========================================================================
// A list of account ids named in one server setting, read strictly.
//
// RATECON_PDF_VIEWER_IDS is the first user: the accounts that may open rate-con
// files inside the app, and the accounts whose password, role and email only
// they (or another listed account) may change. The setting lives only in the
// server's environment, so nobody can edit it from the app.
//
// THREE STATES, never guessed between:
//   unset   — the variable is absent. Callers keep the behaviour they had
//             before the list existed; the server logs one warning per start.
//   valid   — every entry is an account id: a positive whole number written
//             in plain digits ("1", "1,7", "1, 7"), at most MAX_IDS of them.
//   invalid — set, but anything else: empty, blank, a username, "1.0", "01",
//             "+1", a stray comma, too many entries. Callers refuse everyone
//             (fail closed); the server logs one error per start. The error
//             names the entry's position, never its text.
//
// WHO IS LISTED. Only the signed-in account's id counts, read as a positive
// whole number (sessionAccountId()); a username never does. A session without
// a usable id is "no-id", which callers refuse with "sign in again".
//
// Pure: no database, no environment read, no I/O. scripts/test-listed-accounts.js
// covers every rule.
// ===========================================================================

const MAX_IDS = 50;
// Nine digits at most: always a safe integer, and far above any account id.
const ID_RE = /^[1-9][0-9]{0,8}$/;

function sessionAccountId(user) {
	if (!user || typeof user !== "object") return null;
	const raw = user.id;
	if (typeof raw === "number") return Number.isSafeInteger(raw) && raw > 0 ? raw : null;
	if (typeof raw === "string") {
		const t = raw.trim();
		return ID_RE.test(t) ? Number(t) : null;
	}
	return null;
}

function targetAccountId(id) {
	if (typeof id === "number") return Number.isSafeInteger(id) && id > 0 ? id : null;
	if (typeof id === "string" && ID_RE.test(id.trim())) return Number(id.trim());
	return null;
}

function build(state, ids, problem) {
	const set = new Set(ids);
	const list = {
		state,
		ids: Object.freeze([...set]),
		problem,
		// "unset" | "invalid" | "no-id" | "listed" | "unlisted"
		verdict(user) {
			if (state === "unset") return "unset";
			if (state === "invalid") return "invalid";
			const id = sessionAccountId(user);
			if (id === null) return "no-id";
			return set.has(id) ? "listed" : "unlisted";
		},
		isListedId(id) {
			const n = targetAccountId(id);
			return state === "valid" && n !== null && set.has(n);
		},
		// A password, role or email change on `targetId`, or its removal, asked
		// for by the signed-in `actor`. null when it may go ahead; otherwise why
		// it may not:
		//   "listed"  — the target is listed, and the actor is neither the
		//               target itself nor another listed account;
		//   "invalid" — the list is set but invalid, and the target is a Super
		//               Admin: no one can be shown to be allowed.
		// An unset list protects nobody (the behaviour before the list existed).
		protectedChangeRefusal({ actor, targetId, targetRole }) {
			if (state === "unset") return null;
			if (state === "invalid") return targetRole === "Super Admin" ? "invalid" : null;
			const target = targetAccountId(targetId);
			if (target === null || !set.has(target)) return null;
			const actorId = sessionAccountId(actor);
			if (actorId !== null && (actorId === target || set.has(actorId))) return null;
			return "listed";
		},
	};
	return Object.freeze(list);
}

function parseListedAccountIds(raw) {
	if (raw === undefined || raw === null) return build("unset", [], "");
	const text = String(raw);
	if (!text.trim()) return build("invalid", [], "it is set but holds no account id");
	const parts = text.split(",");
	if (parts.length > MAX_IDS) return build("invalid", [], `it holds more than ${MAX_IDS} entries`);
	const ids = [];
	for (let i = 0; i < parts.length; i++) {
		const t = parts[i].trim();
		if (!ID_RE.test(t)) return build("invalid", [], `entry ${i + 1} is not an account id (a positive whole number)`);
		ids.push(Number(t));
	}
	return build("valid", ids, "");
}

// Parsed once, at start-up, so each message is logged once per start.
function fromSetting(name, raw, logger, { unsetMeans = "", invalidMeans = "" } = {}) {
	const list = parseListedAccountIds(raw);
	const log = logger || console;
	if (list.state === "unset") log.warn(`[${name}] is not set${unsetMeans ? `: ${unsetMeans}` : ""}`);
	else if (list.state === "invalid") log.error(`[${name}] is set but invalid (${list.problem})${invalidMeans ? `: ${invalidMeans}` : ""}`);
	return list;
}

module.exports = { parseListedAccountIds, fromSetting, sessionAccountId, MAX_IDS };
