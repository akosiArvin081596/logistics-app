"use strict";
// The fixed wording of the owner-operator agreement (Form OO-1) and its weekly
// settlement statement, in one place: what each prints, the lists the agreement
// fixes, and the review note that must never print on the form.
//
// Who uses it:
//   lib/owner-operator-templates.js  the two field maps print the wording below
//   onboarding-templates/policy/owner-operator-agreement.html and
//   owner-operator-settlement.html   carry DRAFT_MARKER, the form version and the
//                                    charge-back list as static text;
//                                    scripts/test-owner-operator-templates.js pins
//                                    each equal and checks REVIEW_NOTE never prints
//   CHARGE_BACK_CATEGORIES           the categories a charge validates against
//                                    (ooValidateCharge()'s `categories`)
//   FEE_SCHEDULE                     the fees with no carrier cost behind them that
//                                    the signed agreement lists
//
// The agreement is the lawyer packet's draft text. Counsel's final text replaces
// it, and DRAFT_MARKER with it, before any owner-operator signs.
//
// Pure: no I/O and no requires.

const OWNER_OPERATOR_AGREEMENT_TEXT = Object.freeze({
	FORM_VERSION: "OO-1",
	FORM_DATE: "October 2026",
	// Printed at the top of every page: nobody signs a draft.
	DRAFT_MARKER: "DRAFT FOR LEGAL REVIEW: NOT FOR SIGNATURE",
	// Section 6(a)'s list, in its order. Item 9 ("[other items, each listed]") is a
	// placeholder for counsel, not a category: nothing may be charged under it.
	CHARGE_BACK_CATEGORIES: Object.freeze([
		Object.freeze({ key: "fuel", text: "fuel bought on the Carrier's account (through the Carrier's fuel app or a fuel card);" }),
		Object.freeze({ key: "tolls", text: "tolls, and toll violation or administrative fees;" }),
		Object.freeze({ key: "repairs", text: "repairs, tires, maintenance and roadside service;" }),
		Object.freeze({ key: "insurance", text: "the Equipment's insurance, at the weekly amount in Schedule B, and deductibles under Section 9;" }),
		Object.freeze({ key: "eld", text: "ELD service, at the weekly amount in Schedule B;" }),
		Object.freeze({ key: "taxes_permits", text: "heavy vehicle use tax (Form 2290), apportioned registration and plates (IRP), permits, and IFTA fuel tax for the Equipment's miles;" }),
		Object.freeze({ key: "ready_for_service", text: "lettering and the other costs in Schedule C to make the Equipment ready for service;" }),
		Object.freeze({ key: "cash_advance", text: "cash advances the Owner-Operator asks for in writing;" }),
	]),
	// Section 3: the company percentage is the split and the Carrier's only fee, so
	// the draft lists no other fee. A fee added here needs the agreement's wording
	// for it in the same change.
	FEE_SCHEDULE: Object.freeze([]),
	ONLY_FEE_SENTENCE: "The company fee is the Carrier's only fee or commission; the charge-backs in Section 6 are costs passed through at the amount the Carrier paid, not fees.",
	OWNERSHIP: Object.freeze({ own: "Owned", lease: "Leased" }),
	// Schedule D's two choices; the keys are the contractor agreement's stored ones.
	PAYMENT_METHOD: Object.freeze({
		check: "Check",
		ach: "Direct deposit to the account the Owner-Operator gives on the Carrier's standard payment form",
	}),
	// Schedule C's own words for an installment the Carrier left unset.
	INSTALLMENT_UNSET: "(left blank)",
	// Never printed on the form: shown to the Super Admin and sent with the sample.
	REVIEW_NOTE: "Draft for legal review, not legal advice: counsel's final text replaces this agreement before any owner-operator signs.",
});

const OWNER_OPERATOR_STATEMENT_TEXT = Object.freeze({
	DRAFT_MARKER: "DRAFT FOR REVIEW: NOT A FINAL STATEMENT",
	COMPANY_FEE: "Company fee",
	SCHEDULE_FEE: "fee",
	LATE: "late",
	FILED_BY_OFFICE: "filed by the office",
	PENDING_REVIEW: "pending review",
	// Items listed on the statement and neither deducted nor paid until resolved.
	HELD: Object.freeze({
		investor_ledger: "On an investor's ledger, not paid",
		waiting_for_approval: "Waiting for approval, not deducted",
		toll_without_notice: "Toll without its notice, waiting for approval, not deducted",
		possible_duplicate: "Possible duplicate, not deducted",
		plate_mismatch: "Plate doesn't match the truck, not deducted",
	}),
	HELD_OTHER: "Held for review, not deducted or paid",
});

module.exports = { OWNER_OPERATOR_AGREEMENT_TEXT, OWNER_OPERATOR_STATEMENT_TEXT };
