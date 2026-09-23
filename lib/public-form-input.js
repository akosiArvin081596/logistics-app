// ============================================================
// Input checks for the unauthenticated public forms
// ============================================================
// POST /api/public/apply, POST /api/public/investor-apply, the anonymous
// investor preview and the token-gated investor onboarding routes all take
// their input from anyone on the internet. These checks run at the boundary,
// before a value reaches SQLite, a PDF render or an outbound email.
//
// Pure: no network, no database, no filesystem. Every checker is total -- it
// never throws -- and answers { ok: true, value } or
// { ok: false, reason, message }: `message` is safe to show the applicant,
// `reason` is a stable machine-readable code for the response body and logs.
//
// ONE implementation for every public route. The same rule hand-copied into
// each route is how copies drift apart (see "Fixing one copy of a duplicated
// rule only resets the drift clock" in CLAUDE.md).

"use strict";

// ------------------------------------------------------------
// Scalar fields
// ------------------------------------------------------------

const SCALAR_MESSAGE = "Some of the submitted details are invalid. Please review the form and try again.";

// Every value a route binds into SQL, or reads as text, must be ONE scalar:
// a string, a finite number, or absent. The database driver gives arrays and
// objects a meaning other than "one value", and a required-field check such
// as `!field` lets an empty array or object through. Checked before the first
// statement runs.
function isScalar(v) {
	return v === undefined || v === null || typeof v === "string" ||
		(typeof v === "number" && Number.isFinite(v));
}

// `names` are the fields of `source` that must be scalar. A missing or
// non-object source has no fields, so it passes; required-ness stays the
// caller's check.
function checkPublicScalars(source, names) {
	const obj = source !== null && typeof source === "object" ? source : {};
	for (const name of names) {
		if (!isScalar(obj[name])) return { ok: false, reason: "not_scalar", field: name, message: SCALAR_MESSAGE };
	}
	return { ok: true, value: obj };
}

// ------------------------------------------------------------
// Email
// ------------------------------------------------------------

// RFC 5321 caps a forward-path at 256 octets including its angle brackets,
// which leaves 254 for the address itself. Checked BEFORE the pattern below
// ever runs, so no attacker-sized value reaches a regular expression.
const EMAIL_MAX_LENGTH = 254;

// What an address may contain -- printable ASCII, and only these characters:
//   local part:    letters, digits, "." and the RFC 5322 atext symbols, less
//                  "?", "#" and "%", which carry meaning inside a mailto: link
//                  (the admin notification links the address);
//   domain labels: letters, digits and "-", as DNS host names allow.
// Everything else is refused: whitespace (so CR and LF), control characters,
// the address-list and header syntax a mail library acts on
// (, ; < > ( ) [ ] \ : "), and every non-ASCII character. ASCII-only is what
// makes the value that passes the value that is mailed: a mail library may
// rewrite non-ASCII (Unicode full stops, internationalized domains), and
// invisible or bidirectional characters can make an address display as a
// different one.
const EMAIL_LOCAL_CHARS = "A-Za-z0-9!$&'*+/=^_`{|}~.-";
const EMAIL_LABEL_CHARS = "A-Za-z0-9-";

// local@label.label[.label...]
//
// LINEAR BY CONSTRUCTION. Every quantifier is a single character class; the
// local part cannot contain "@", so it ends at the only "@" there is; and the
// class inside the repeated domain label excludes the "." that begins each
// repetition. Any input can therefore be split exactly one way, and a failed
// match gives a backtracking engine nothing to explore. Keep it that way: do
// not let two adjacent quantifiers accept the same character.
const EMAIL_RE = new RegExp(
	`^[${EMAIL_LOCAL_CHARS}]+@[${EMAIL_LABEL_CHARS}]+(?:\\.[${EMAIL_LABEL_CHARS}]+)+$`
);

const EMAIL_MESSAGES = {
	invalid: "Please provide a valid email address.",
	multiple: "Please enter a single email address.",
	too_long: `That email address is too long (${EMAIL_MAX_LENGTH} characters at most).`,
};

function emailRefusal(reason) {
	return { ok: false, reason, message: EMAIL_MESSAGES[reason] };
}

// One well-formed address, or a refusal. The value is validated exactly as
// given -- it is not trimmed or rewritten -- so the string that passed is the
// string the caller stores and mails to.
function checkPublicEmail(raw) {
	// O(1) gates first: type, then length.
	if (typeof raw !== "string" || raw.length === 0) return emailRefusal("invalid");
	if (raw.length > EMAIL_MAX_LENGTH) return emailRefusal("too_long");
	// A list gets its own message: the applicant typed two addresses, and
	// "invalid" would not tell them what to change.
	if (raw.includes(",") || raw.includes(";") || raw.indexOf("@") !== raw.lastIndexOf("@")) {
		return emailRefusal("multiple");
	}
	if (!EMAIL_RE.test(raw)) return emailRefusal("invalid");
	return { ok: true, value: raw };
}

// ------------------------------------------------------------
// Vehicles
// ------------------------------------------------------------

// The /invest wizard caps fleet size at 20; this leaves headroom while still
// bounding how many rows a single request can push into the rendered lease
// documents and the notification email.
const VEHICLES_MAX = 50;
// Longest text a single vehicle field may carry (a VIN is 17 characters).
const VEHICLE_FIELD_MAX_LENGTH = 500;
// The wizard's two number inputs. Every other field is text.
const VEHICLE_NUMBER_FIELDS = new Set(["year", "purchasePrice"]);

const VEHICLE_MESSAGES = {
	not_a_list: "Vehicle details are invalid. Please review your vehicles and submit again.",
	entry: "Vehicle details are invalid. Please review your vehicles and submit again.",
	field: "Vehicle details are invalid. Please review your vehicles and submit again.",
	too_many: `A maximum of ${VEHICLES_MAX} vehicles can be submitted.`,
};

function vehicleRefusal(reason, index) {
	const out = { ok: false, reason, message: VEHICLE_MESSAGES[reason] };
	if (index !== undefined) out.index = index;
	return out;
}

function isPlainObject(v) {
	return v !== null && typeof v === "object" && Object.prototype.toString.call(v) === "[object Object]";
}

// What a vehicle field may hold: bounded text, or null (every consumer reads
// null as blank, `v.year || ""`). Numbers only where the wizard sends them;
// the documents treat every other field as text (a VIN is sliced, for one).
function isVehicleFieldValue(key, x) {
	if (x === null) return true;
	if (typeof x === "string") return x.length <= VEHICLE_FIELD_MAX_LENGTH;
	return typeof x === "number" && Number.isFinite(x) && VEHICLE_NUMBER_FIELDS.has(key);
}

// A list of vehicle objects, or a refusal. null/undefined mean "no vehicles".
// Each entry must be a plain object whose fields pass isVehicleFieldValue();
// the list is returned unchanged when it passes, so a valid submission behaves
// exactly as it did before this check existed.
function checkPublicVehicles(raw) {
	if (raw === undefined || raw === null) return { ok: true, value: [] };
	if (!Array.isArray(raw)) return vehicleRefusal("not_a_list");
	if (raw.length > VEHICLES_MAX) return vehicleRefusal("too_many");
	for (let i = 0; i < raw.length; i++) {
		const v = raw[i];
		if (!isPlainObject(v)) return vehicleRefusal("entry", i);
		for (const key of Object.keys(v)) {
			if (!isVehicleFieldValue(key, v[key])) return vehicleRefusal("field", i);
		}
	}
	return { ok: true, value: raw };
}

module.exports = {
	EMAIL_MAX_LENGTH,
	EMAIL_RE,
	VEHICLES_MAX,
	VEHICLE_FIELD_MAX_LENGTH,
	checkPublicEmail,
	checkPublicVehicles,
	checkPublicScalars,
};
