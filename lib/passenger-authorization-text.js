"use strict";
// The fixed wording of the passenger authorization form (Form PA-1), in one
// place: what the form prints, and the review note that must never print on it.
//
// Who uses it:
//   lib/policy-field-maps.js  passenger_authorization prints VALIDITY_NOTICE and
//                             AGE_STATEMENT; the template prints "Form PA-1
//                             (October 2026)" as FORM_VERSION and FORM_DATE
//                             (scripts/test-passenger-authorization-form.js
//                             pins the two equal)
//   REVIEW_NOTE               shown to the Super Admin before the company
//                             countersigns and sent with the sample form; the
//                             same runner checks the template never carries it
//
// Pure: no I/O and no requires.

const PASSENGER_AUTHORIZATION_TEXT = Object.freeze({
	FORM_VERSION: "PA-1",
	FORM_DATE: "October 2026",
	// The form is a carrier's authorization only once the company has signed it.
	VALIDITY_NOTICE: Object.freeze({
		pending: "NOT VALID UNTIL SIGNED FOR LOGISX INC.",
		authorized: "AUTHORIZED BY LOGISX INC.",
	}),
	AGE_STATEMENT: Object.freeze({
		adult: "18 or older",
		minor: "Under 18 and older than 10; a parent or legal guardian signs below",
	}),
	// Never printed on the form: nobody should sign a page saying it is unreviewed.
	REVIEW_NOTE: "LogisX Inc. recommends that its lawyer or insurance provider review this form before it is used.",
});

module.exports = { PASSENGER_AUTHORIZATION_TEXT };
