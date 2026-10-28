"use strict";

// The rules behind POST /api/users/:id/disable and /enable, and the one test of "enabled". Pure
// apart from otherEnabledSuperAdmins() (reads `db`) and accountDisableEnabled() (reads the
// server's environment); scripts/test-account-disable-rules.js covers every rule.

// NULL or '' is enabled, any other disabled_at is disabled, in SQL and in JS alike.
const ENABLED_SQL = "COALESCE(disabled_at, '') = ''";
const OTHER_ENABLED_SUPER_ADMINS_SQL =
	"SELECT COUNT(*) AS cnt FROM users WHERE role = 'Super Admin' AND id <> ? AND COALESCE(disabled_at, '') = ''";
// Drivers and Investors are left out: their work is keyed to names, not to the account.
const DISABLEABLE_ROLES = Object.freeze(["Super Admin", "Dispatcher"]);
const REASON_MAX = 200;
const DISABLED_MESSAGE = "This account is disabled. Contact your administrator.";
// The protected-account list in its unset state: { state, ids, isListedId(id) }.
const UNSET_LIST = Object.freeze({ state: "unset", ids: Object.freeze([]), isListedId: () => false });
// What a build that reads no protected-account setting hands the routes: every Super Admin is
// protected as with the list unset, and the refusal says the list isn't read, not that it isn't set.
const UNREAD_LIST = Object.freeze({ state: "unread", ids: Object.freeze([]), isListedId: () => false });

const SESSION_ENDED = Object.freeze({ status: 401, code: "SESSION_ENDED", error: "Your session has ended. Sign in again." });

// Flag: ACCOUNT_DISABLE_ENABLED (default off). It is read here, not beside server.js's other flags.
// On only when the server's environment sets ACCOUNT_DISABLE_ENABLED to exactly "true".
function accountDisableEnabled({ env } = process) {
	return !!env && env.ACCOUNT_DISABLE_ENABLED === "true";
}

function isDisabledRow(row) {
	return !!row && String(row.disabled_at ?? "") !== "";
}

function otherEnabledSuperAdmins(db, id) {
	return db.prepare(OTHER_ENABLED_SUPER_ADMINS_SQL).get(id).cnt;
}

// The account id a session names: a positive whole number stored as one, else null.
function sessionAccountId(user) {
	if (!user || typeof user !== "object") return null;
	return Number.isSafeInteger(user.id) && user.id > 0 ? user.id : null;
}

// Why a signed-in session no longer speaks for its account, or null when it does.
// `row` is the users row read by the session's id (null when there is none).
function sessionEndReason(user, row) {
	if (sessionAccountId(user) === null) return "no account id";
	if (!row) return "account not found";
	if (isDisabledRow(row)) return "disabled";
	if (row.role !== user.role) return "role changed";
	return null;
}

// Control characters and the line and paragraph separators, each read as a space.
function isBreakingChar(code) {
	return code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029;
}

// The optional reason as stored: one line, at most REASON_MAX characters.
function readReason(raw) {
	if (raw === undefined || raw === null) return { reason: null };
	if (typeof raw !== "string") return { refusal: { status: 400, code: "INVALID_REASON", error: "The reason must be text." } };
	const tooLong = { refusal: { status: 400, code: "REASON_TOO_LONG", error: `The reason can be at most ${REASON_MAX} characters.` } };
	// A cheap bound before the walk below: the body may be far larger than any reason.
	if (raw.length > REASON_MAX * 20) return tooLong;
	let flat = "";
	for (const ch of raw) flat += isBreakingChar(ch.codePointAt(0)) ? " " : ch;
	const text = flat.split(" ").filter(Boolean).join(" ");
	if (!text) return { reason: null };
	if (text.length > REASON_MAX) return tooLong;
	return { reason: text };
}

// Matched on id or username, as DELETE /api/users/:id matches self-deletion.
function isSelf(actor, target) {
	if (!actor || !target) return false;
	if (Number(actor.id) === Number(target.id)) return true;
	return !!actor.username && !!target.username &&
		String(actor.username).trim().toLowerCase() === String(target.username).trim().toLowerCase();
}

// Why the protected-account list refuses switching `target`, or null: "unset" or "unread" (disabling
// a Super Admin while the list is unset or not read at all), "invalid" (a list in any other state,
// for a Super Admin), or "listed" (a listed target, and an actor that is neither it nor another
// listed account).
function protectedRefusal({ listed, actor, target, disabling }) {
	const list = listed || UNSET_LIST;
	const superAdmin = target.role === "Super Admin";
	if (list.state === "unset" || list.state === "unread") return disabling && superAdmin ? list.state : null;
	if (list.state !== "valid") return superAdmin ? "invalid" : null;
	if (!list.isListedId(target.id)) return null;
	const actorId = sessionAccountId(actor);
	if (actorId !== null && (actorId === Number(target.id) || list.isListedId(actorId))) return null;
	return "listed";
}

function protectedMessage(why, target, disabling) {
	const verb = disabling ? "Disabling" : "Enabling";
	if (why === "unread") return "This server doesn't read a protected-account list yet, so a Super Admin account can't be disabled. Nothing was changed.";
	if (why === "unset") return "Disabling a Super Admin account waits until the server's protected-account list is set. Nothing was changed.";
	if (why === "invalid") return `${verb} a Super Admin account is paused: the server's protected-account list is misconfigured. Nothing was changed.`;
	return `${target.username} is a protected account: only another protected account can disable or enable it. Nothing was changed.`;
}

function refusal(status, code, error, tail) {
	return { refusal: { status, code, error, tail } };
}

// The acting account as read in the same step: still in the store, enabled, a Super Admin.
function actorStillValid({ actorLive, actorRow }) {
	return actorLive === true && !!actorRow && !isDisabledRow(actorRow) && actorRow.role === "Super Admin";
}

// A disable, judged on facts read in one synchronous step. Refusals come before
// "unchanged", so a refused actor never learns the account's state.
function disableDecision({ flagOn, actor, actorLive, actorRow, target, otherEnabled, listed }) {
	if (!flagOn) return refusal(403, "ACCOUNT_DISABLE_OFF", "Disabling accounts is turned off on this server. Nothing was changed.", "the switch is off");
	if (isSelf(actor, target)) {
		return refusal(409, "CANNOT_DISABLE_SELF", "You cannot disable your own account. Ask another Super Admin to do it.", "an account cannot disable itself");
	}
	if (!DISABLEABLE_ROLES.includes(target.role)) {
		return refusal(409, "ROLE_NOT_DISABLEABLE", `${target.role} accounts can't be disabled. Only Super Admin and Dispatcher accounts can be.`,
			`a ${target.role} account`);
	}
	const why = protectedRefusal({ listed, actor, target, disabling: true });
	if (why) return refusal(403, "PROTECTED_ACCOUNT", protectedMessage(why, target, true), `a protected account (${why})`);
	if (target.role === "Super Admin" && !isDisabledRow(target) && !(otherEnabled > 0)) {
		return refusal(409, "LAST_SUPER_ADMIN", `Cannot disable ${target.username}: no other enabled Super Admin account would be left.`,
			"no other enabled Super Admin would be left");
	}
	if (!actorStillValid({ actorLive, actorRow })) return { refusal: { ...SESSION_ENDED, tail: "the acting session has ended" } };
	if (isDisabledRow(target)) return { unchanged: true };
	return { ok: true };
}

// An enable. Never gated by the switch, so an account disabled while it was on
// can be enabled after it goes off.
function enableDecision({ actor, actorLive, actorRow, target, listed }) {
	const why = protectedRefusal({ listed, actor, target, disabling: false });
	if (why) return refusal(403, "PROTECTED_ACCOUNT", protectedMessage(why, target, false), `a protected account (${why})`);
	if (!actorStillValid({ actorLive, actorRow })) return { refusal: { ...SESSION_ENDED, tail: "the acting session has ended" } };
	if (!isDisabledRow(target)) return { unchanged: true };
	return { ok: true };
}

function escapeHtml(s) {
	return String(s ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function clockText(at, timeZone) {
	return new Date(at).toLocaleString("en-US", {
		timeZone, year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
	});
}

const P = 'style="margin:0 0 12px;line-height:1.6;color:#334155"';

// The admin email for one disable or enable. It holds no address: the caller
// sends it to ADMIN_NOTIFY_EMAIL alone, never to the account.
function switchNotice({ kind, target, actor, reason, at, timeZone }) {
	const verb = kind === "disable" ? "disabled" : "enabled";
	const who = `<b>${escapeHtml(target.username)}</b> (account #${Number(target.id)}, ${escapeHtml(target.role)})`;
	const by = `${escapeHtml(actor && actor.username)} (account #${Number(actor && actor.id)})`;
	const lines = [`<p ${P}>${who} was ${verb} by ${by} on ${escapeHtml(clockText(at, timeZone))}.</p>`];
	if (reason) lines.push(`<p ${P}>Reason given: ${escapeHtml(reason)}</p>`);
	lines.push(kind === "disable"
		? `<p ${P}>Its sessions were ended and it can't sign in until a Super Admin enables it again on the Users page.</p>`
		: `<p ${P}>It can sign in again with its password.</p>`);
	return {
		subject: `LogisX: account ${target.username} ${verb}`,
		heading: `Account ${verb}`,
		bodyHtml: lines.join("\n"),
	};
}

// The admin email for a refused sign-in to a disabled account (the password was right).
function disabledSignInNotice({ account, at, timeZone }) {
	const who = `<b>${escapeHtml(account.username)}</b> (account #${Number(account.id)}, ${escapeHtml(account.role)})`;
	return {
		subject: `LogisX: sign-in to the disabled account ${account.username} refused`,
		heading: "Sign-in to a disabled account",
		bodyHtml: [
			`<p ${P}>Someone signed in to ${who} with its correct password on ${escapeHtml(clockText(at, timeZone))}. The account is disabled, so the sign-in was refused.</p>`,
			`<p ${P}>At most one such email is sent an hour for each account.</p>`,
		].join("\n"),
	};
}

// At most one notice per key per `everyMs`. In memory, so a restart may repeat one.
function noticeWindow(everyMs) {
	const sentAt = new Map();
	return {
		allow(key, now = Date.now()) {
			const last = sentAt.get(key);
			if (last !== undefined && now - last < everyMs) return false;
			if (sentAt.size > 500) {
				for (const [k, t] of sentAt) if (now - t >= everyMs) sentAt.delete(k);
			}
			sentAt.set(key, now);
			return true;
		},
	};
}

module.exports = {
	ENABLED_SQL,
	OTHER_ENABLED_SUPER_ADMINS_SQL,
	DISABLEABLE_ROLES,
	REASON_MAX,
	DISABLED_MESSAGE,
	UNSET_LIST,
	UNREAD_LIST,
	accountDisableEnabled,
	isDisabledRow,
	otherEnabledSuperAdmins,
	sessionAccountId,
	sessionEndReason,
	readReason,
	protectedRefusal,
	disableDecision,
	enableDecision,
	switchNotice,
	disabledSignInNotice,
	noticeWindow,
};
