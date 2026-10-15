"use strict";
// The one rule for a new password, shared by POST /api/auth/change-password
// (a user's own change) and PUT /api/users/:id (an admin's reset). Before B21
// only change-password checked anything: the admin reset took any non-empty
// value, and a non-string one reached bcrypt and answered a 500 with bcrypt's
// own error text.
//
// newPasswordRefusal(value) answers null for an acceptable password, otherwise
// the 400 body to send: { code: "PASSWORD_WEAK", error, failed? }. The order,
// wording and `failed` list are change-password's, unchanged, and mirror the
// client's checklist (ChangePasswordModal.vue / ChangePasswordView.vue):
//   - text, at least 8 characters  (a non-string counts as too short)
//   - at most 200 characters        (checked before any pattern runs)
//   - an uppercase letter, a lowercase letter, a number and a symbol
// Never echoes the value. No network, database or filesystem.

const MIN_LENGTH = 8;
const MAX_LENGTH = 200;
const SYMBOL_RE = /[!@#$%^&*()_+\-=[\]{};:'",.<>?/\\|`~]/;
const LABELS = {
	uppercase: "an uppercase letter",
	lowercase: "a lowercase letter",
	digit: "a number",
	symbol: "a symbol (!@#$ etc.)",
};

function newPasswordRefusal(value) {
	if (typeof value !== "string" || value.length < MIN_LENGTH) {
		return { code: "PASSWORD_WEAK", error: "New password must be at least 8 characters", failed: ["length"] };
	}
	if (value.length > MAX_LENGTH) {
		return { code: "PASSWORD_WEAK", error: "New password is too long", failed: ["length"] };
	}
	const failed = [];
	if (!/[A-Z]/.test(value)) failed.push("uppercase");
	if (!/[a-z]/.test(value)) failed.push("lowercase");
	if (!/\d/.test(value)) failed.push("digit");
	if (!SYMBOL_RE.test(value)) failed.push("symbol");
	if (failed.length > 0) {
		return { code: "PASSWORD_WEAK", error: `Password must include ${failed.map((f) => LABELS[f]).join(", ")}.`, failed };
	}
	return null;
}

module.exports = { MIN_LENGTH, MAX_LENGTH, newPasswordRefusal };
