// lib/pii-mask.js — pure masking helpers for government ids and bank numbers.
// No network, no DB, no fs (same shape as lib/receipt-gallons-recovery.js).
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS
//
// The app already "masked" SSNs and account numbers — but only in Vue. The
// server sent the full value and the browser hid it behind a reveal toggle
// (DriverTable.vue's `showSsn`, InvestorTable.vue's `showAcctNum`). That is a
// CSS-grade control: the plaintext is in the JSON, in the network tab, in the
// browser cache, and in any HAR anyone ever attaches to a bug report.
//
// It matters here specifically because `super_admin` is a SHARED login. You
// cannot tell which person read a value, so the only real lever is to stop
// shipping it ambiently and make each full read a deliberate, audited act.
//
// ---------------------------------------------------------------------------
// TWO RULES THAT LOOK LIKE STYLE AND ARE NOT
//
//   1. MASK LENGTH IS FIXED, never proportional to the input. A mask that
//      renders one character per hidden digit republishes the length, which for
//      a bank account number is a real narrowing of the search space. SSNs are
//      always 9 digits so `***-**-1234` leaks nothing and stays readable; every
//      variable-length value gets a constant four bullets instead.
//
//   2. MASKING IS IDEMPOTENT. `maskSsn(maskSsn(x)) === maskSsn(x)`. Several
//      client components mask again on top of whatever the API returns, and a
//      double-mask would eat the last four digits that make the value useful
//      for support ("is this the account ending 1234?"). isMasked() is what
//      makes that safe, and it is also the guard that stops a masked value
//      being mistaken for a real one by a future writer.
"use strict";

// U+2022 BULLET. Matches the character InvestorTable.vue / InvestorApplyView.vue
// already render, so masked values look identical wherever they surface.
const BULLET = "•";
const MASK_RUN = BULLET.repeat(4);

// Any character we ever emit as a mask. Used by isMasked() so that a value
// which has already been through here is never re-masked.
const MASK_CHARS = /[*•]/;

function str(v) {
	if (v === null || v === undefined) return "";
	return String(v);
}

/** True when the value already carries mask characters. Makes masking idempotent. */
function isMasked(v) {
	return MASK_CHARS.test(str(v));
}

/** Last 4 DIGITS (not characters) — bank/tax ids are digit-identified even when
 *  stored with dashes or spaces. Returns "" when there are fewer than 4. */
function last4(v) {
	const digits = str(v).replace(/\D/g, "");
	return digits.length >= 4 ? digits.slice(-4) : "";
}

/**
 * SSN → `***-**-1234`. Keeps the familiar shape so an operator can still tell
 * at a glance that the field holds an SSN and not something else.
 * Unknown/short input degrades to a full mask rather than leaking what it has.
 */
function maskSsn(v) {
	const s = str(v);
	if (!s) return "";
	if (isMasked(s)) return s;
	const l4 = last4(s);
	return l4 ? `***-**-${l4}` : "***-**-****";
}

/**
 * EIN *or* SSN — `investors.ein_ssn` / `investor_applications.ein_ssn` hold
 * either, and which one it is depends on entity type. Deliberately does NOT
 * impose the `XX-XXXXXXX` EIN shape: rendering an SSN in EIN punctuation is a
 * quiet misstatement of what the record contains.
 */
function maskTaxId(v) {
	const s = str(v);
	if (!s) return "";
	if (isMasked(s)) return s;
	const l4 = last4(s);
	return l4 ? `${MASK_RUN}${l4}` : MASK_RUN;
}

/** Bank account number → `••••1234`. Fixed-width mask: account length varies
 *  and is itself a hint, so it is not republished. */
function maskAccount(v) {
	const s = str(v);
	if (!s) return "";
	if (isMasked(s)) return s;
	const l4 = last4(s);
	return l4 ? `${MASK_RUN}${l4}` : MASK_RUN;
}

/**
 * ABA routing number → `••••1234`.
 *
 * Routing numbers are printed on every cheque and are widely published, so this
 * is not secrecy for its own sake: routing + account together are what
 * authorizes an ACH debit, and this app stores them in the same row. Masking
 * only the account number — which is what the investor-application email did —
 * hands over half a credential and calls it redacted.
 */
function maskRouting(v) {
	return maskAccount(v);
}

/** Driver's licence number → `••••1234`. */
function maskLicense(v) {
	return maskAccount(v);
}

/**
 * Returns a NEW object with the named fields masked (never mutates its input —
 * the caller's row is frequently the same object a later write reads from).
 *
 * `spec` maps field name → one of the mask function names, e.g.
 *   maskFields(row, { ssn: "ssn", bank_account: "account" })
 *
 * A field absent from the object is left absent rather than added as "", so a
 * masked row keeps the same shape as the row it came from and `SELECT`ed
 * columns do not silently gain keys.
 */
const MASKERS = {
	ssn: maskSsn,
	taxId: maskTaxId,
	account: maskAccount,
	routing: maskRouting,
	license: maskLicense,
};

function maskFields(obj, spec) {
	if (!obj || typeof obj !== "object") return obj;
	const out = { ...obj };
	for (const [field, kind] of Object.entries(spec || {})) {
		if (!Object.prototype.hasOwnProperty.call(out, field)) continue;
		const fn = MASKERS[kind];
		if (!fn) continue;
		out[field] = fn(out[field]);
	}
	return out;
}

/**
 * Column-name → mask kind, for generic sweeps over rows whose shape is not
 * known ahead of time (the Super Admin DB browser reads `SELECT *` from an
 * arbitrary table, so it cannot carry a per-table spec).
 *
 * Matched on the EXACT lowercased column name, never a substring: a substring
 * rule matching /account/ would also hit `account_type` ("checking") and
 * `bank_acct_name`, and masking a name or an account type is noise that trains
 * people to ignore the mask.
 */
const SENSITIVE_COLUMNS = {
	ssn: "ssn",
	ein_ssn: "taxId",
	tin: "taxId",
	account_number: "account",
	bank_account: "account",
	routing_number: "routing",
	bank_routing: "routing",
	drivers_license: "license",
};

/** Mask any known-sensitive column on an arbitrary row. Returns a new object. */
function maskUnknownRow(row) {
	if (!row || typeof row !== "object") return row;
	const spec = {};
	for (const key of Object.keys(row)) {
		const kind = SENSITIVE_COLUMNS[String(key).toLowerCase()];
		if (kind) spec[key] = kind;
	}
	return Object.keys(spec).length ? maskFields(row, spec) : row;
}

module.exports = {
	isMasked,
	last4,
	maskSsn,
	maskTaxId,
	maskAccount,
	maskRouting,
	maskLicense,
	maskFields,
	maskUnknownRow,
	SENSITIVE_COLUMNS,
};
