"use strict";
// The field maps of the two owner-operator documents: the agreement (Form OO-1)
// and the weekly settlement statement. Each only formats what the server passes;
// neither adds a figure. A term or line the agreement doesn't allow is refused
// here, at the last step before a PDF exists, with labels named and values never.
// lib/policy-field-maps.js registers both; lib/policy-renderer.js serves them only
// while their flags are on.

const { dayKeyDateText } = require("./invoice-header");
const {
	OO_FEE_MIN_BPS,
	OO_FEE_MAX_BPS,
	ooValidateFeeBps,
	ooValidateEscrowTerms,
	ooFeeCents,
	ooIsDayKey,
	ooIsWeekStart,
	ooWeekEnd,
} = require("./owner-operator");
const { OWNER_OPERATOR_AGREEMENT_TEXT: AGREEMENT, OWNER_OPERATOR_STATEMENT_TEXT: STATEMENT } = require("./owner-operator-agreement-text");

const said = (v) => (typeof v === "string" ? v.trim().slice(0, 200) : typeof v === "number" && Number.isFinite(v) ? String(v) : "");
const given = (v) => v !== undefined && v !== null && v !== "";
const wholeCents = (v) => Number.isInteger(v) && Math.abs(v) <= 10000000;
const own = (o, k) => Boolean(o) && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k);
const listOf = (v) => (Array.isArray(v) ? v : []);
const objectOf = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : null);

// "$1,234.56", "-$23.75"; "" for anything that isn't whole cents.
function ooMoneyText(cents) {
	if (!wholeCents(cents)) return "";
	const abs = Math.abs(cents);
	const dollars = Math.floor(abs / 100).toLocaleString("en-US");
	return `${cents < 0 ? "-" : ""}$${dollars}.${String(abs % 100).padStart(2, "0")}`;
}

// 1800 -> "18", 1850 -> "18.5", 1825 -> "18.25"; "" outside the fee range.
function ooFeePercentText(bps) {
	if (ooValidateFeeBps(bps)) return "";
	const whole = Math.floor(bps / 100);
	const part = String(bps % 100).padStart(2, "0").replace(/0+$/, "");
	return part ? `${whole}.${part}` : String(whole);
}

function refused(code, message, labels) {
	const e = new Error(message);
	e.code = code;
	e.labels = labels;
	return e;
}

// ---------------------------------------------------------------------------
// The agreement
// ---------------------------------------------------------------------------

// What must be set before he can sign: every term and party the agreement names.
// Only the unit number and a business name may be blank; an installment of 0
// prints as left blank, which Schedule C provides for.
const AGREEMENT_READY_LABELS = Object.freeze([
	"Agreement date", "Owner-operator name", "Owner-operator address", "Registered owner", "Lease start date",
	"Company fee percent", "Escrow weekly amount", "Escrow target", "Truck year", "Truck make", "Truck model",
	"Truck VIN", "Truck plate and state", "Truck ownership", "Weekly insurance", "Weekly ELD service",
	"Onboarding total", "Weekly installment", "Payment method", "Carrier signer name", "Carrier signer title", "Carrier date",
]);

// The terms as data: each value given is checked whatever the stage, so a wrong
// figure is refused rather than printed or dropped. Returns the labels in error.
function agreementTermErrors(data) {
	const bad = [];
	if (given(data.feeBps) && ooValidateFeeBps(data.feeBps)) bad.push("Company fee percent");
	if (given(data.escrowWeeklyCents) || given(data.escrowTargetCents)) {
		if (!given(data.escrowWeeklyCents) || !given(data.escrowTargetCents) ||
			ooValidateEscrowTerms({ targetCents: data.escrowTargetCents, weeklyCents: data.escrowWeeklyCents })) {
			bad.push("Escrow weekly amount", "Escrow target");
		}
	}
	for (const [key, label] of [["weeklyInsuranceCents", "Weekly insurance"], ["weeklyEldCents", "Weekly ELD service"],
		["installmentCents", "Weekly installment"], ["onboardingTotalCents", "Onboarding total"]]) {
		if (given(data[key]) && !(wholeCents(data[key]) && data[key] >= 0)) bad.push(label);
	}
	if (given(data.truckOwnership) && !own(AGREEMENT.OWNERSHIP, data.truckOwnership)) bad.push("Truck ownership");
	if (given(data.paymentMethod) && !own(AGREEMENT.PAYMENT_METHOD, data.paymentMethod)) bad.push("Payment method");
	const costs = data.onboardingCosts;
	if (given(costs)) {
		const rows = Array.isArray(costs) ? costs : null;
		const valid = rows && rows.length <= 20 && rows.every((c) => objectOf(c) && said(c.label) !== "" && wholeCents(c.cents) && c.cents > 0);
		if (!valid) bad.push("Onboarding costs");
		// The total is the server's; one that disagrees with the items it sums is refused.
		else if (wholeCents(data.onboardingTotalCents) && rows.reduce((s, c) => s + c.cents, 0) !== data.onboardingTotalCents) bad.push("Onboarding total");
	}
	return [...new Set(bad)];
}

// data: effectiveDate, fullName, businessName, address, startDate (printed dates
// and names); feeBps; escrowWeeklyCents, escrowTargetCents; truckYear, truckMake,
// truckModel, truckVin, truckPlate, truckPlateState, truckUnit, registeredOwner,
// truckOwnership ("own" | "lease"); weeklyInsuranceCents, weeklyEldCents;
// onboardingCosts [{ label, cents }], onboardingTotalCents, installmentCents (0:
// left blank); paymentMethod ("check" | "ach"); carrierSignerName,
// carrierSignerTitle, carrierSignedOn; signatureText, signatureImage, signedOn.
function ownerOperatorAgreementFields(input) {
	const data = objectOf(input) || {};
	const bad = agreementTermErrors(data);
	if (bad.length) {
		throw refused("OO_AGREEMENT_TERMS_INVALID",
			`"owner_operator_agreement" has a term that isn't valid: ${bad.join(", ")}. Nothing was produced.`, bad);
	}
	const signed = said(data.signatureText) !== "";
	const plateAndState = [said(data.truckPlate), said(data.truckPlateState)].filter(Boolean).join(", ");
	const business = said(data.businessName);
	const text = {
		"Agreement date": said(data.effectiveDate),
		"Owner-operator name": said(data.fullName),
		"Doing business as": business ? `, doing business as ${business}` : "",
		"Owner-operator address": said(data.address),
		"Registered owner": said(data.registeredOwner),
		"Lease start date": said(data.startDate),
		"Company fee percent": given(data.feeBps) ? ooFeePercentText(data.feeBps) : "",
		"Escrow weekly amount": given(data.escrowWeeklyCents) ? ooMoneyText(data.escrowWeeklyCents) : "",
		"Escrow target": given(data.escrowTargetCents) ? ooMoneyText(data.escrowTargetCents) : "",
		"Carrier signer name": said(data.carrierSignerName),
		"Carrier signer title": said(data.carrierSignerTitle),
		"Carrier date": said(data.carrierSignedOn),
		"Owner-operator signature": signed ? said(data.signatureText) : "",
		"Owner-operator printed name": signed ? said(data.fullName) : "",
		"Owner-operator date": signed ? said(data.signedOn) || said(data.effectiveDate) : "",
		"Truck year": said(data.truckYear),
		"Truck make": said(data.truckMake),
		"Truck model": said(data.truckModel),
		"Truck VIN": said(data.truckVin),
		"Truck plate and state": plateAndState,
		"Truck unit number": said(data.truckUnit),
		"Truck ownership": given(data.truckOwnership) ? AGREEMENT.OWNERSHIP[data.truckOwnership] : "",
		"Weekly insurance": given(data.weeklyInsuranceCents) ? ooMoneyText(data.weeklyInsuranceCents) : "",
		"Weekly ELD service": given(data.weeklyEldCents) ? ooMoneyText(data.weeklyEldCents) : "",
		"Onboarding total": given(data.onboardingTotalCents) ? ooMoneyText(data.onboardingTotalCents) : "",
		"Weekly installment": !given(data.installmentCents) ? "" : data.installmentCents > 0 ? ooMoneyText(data.installmentCents) : AGREEMENT.INSTALLMENT_UNSET,
		"Payment method": given(data.paymentMethod) ? AGREEMENT.PAYMENT_METHOD[data.paymentMethod] : "",
	};
	// He signs only a whole agreement: every term set and the Carrier's lines filled.
	if (signed) {
		const missing = AGREEMENT_READY_LABELS.filter((label) => text[label] === "");
		if (missing.length) {
			throw refused("OO_AGREEMENT_NOT_READY",
				`"owner_operator_agreement" can't be signed until these are set: ${missing.join(", ")}. Nothing was produced.`, missing);
		}
	}
	const costRows = listOf(data.onboardingCosts).map((c) => [said(c.label), ooMoneyText(c.cents)]);
	return {
		text,
		// Every slot is part of what he signs or names a signer; an empty one (the
		// blank form, his lines before he signs) is skipped by the fill assertion.
		requiredText: Object.keys(text),
		tableRows: [{ tbodyId: "oo-onboarding-costs", rows: costRows, cellCount: 2, emptyText: "(none)" }],
		signatureLabelForImage: "Owner-operator signature",
		signatureImage: signed ? data.signatureImage || null : null,
	};
}

// ---------------------------------------------------------------------------
// The weekly settlement statement
// ---------------------------------------------------------------------------

const LOAD_KINDS = ["load", "load_change"];
const RECEIPT_KINDS = ["receipt", "receipt_change"];
const CHARGE_KINDS = ["weekly", "one_time", "deductible"];
const ESCROW_KINDS = ["escrow", "escrow_use", "escrow_return"];
// Lines the totals carry rather than a table: the fee, the carry and the installment.
const SUMMARY_KINDS = ["fee", "carry_in", "installment"];

const dateOf = (day) => (ooIsDayKey(day) ? dayKeyDateText(day) : "");

// The fee rules: the company percentage is the split, shown as its one fee line,
// exactly the signed fee on that week's load pay; any other fee only from the
// signed agreement's schedule, which can list only what the form lists, and
// never dated before the week it is settled in.
function statementFeeError(data, lines) {
	const feeLines = lines.filter((l) => l.kind === "fee");
	if (feeLines.length > 1 || feeLines.some((l) => l.ref !== "fee")) {
		return refused("OO_STATEMENT_FEE_INVALID", "\"owner_operator_settlement\" has a fee line that isn't the company fee. Nothing was produced.", ["Company fee"]);
	}
	const fee = feeLines[0];
	if (fee) {
		const totals = objectOf(data.totals) || {};
		const split = !ooValidateFeeBps(data.feeBps) && wholeCents(fee.baseCents) && wholeCents(fee.cents) &&
			fee.cents === -ooFeeCents(fee.baseCents, data.feeBps) && (!given(totals.loadCents) || totals.loadCents === fee.baseCents);
		if (!split) {
			return refused("OO_STATEMENT_FEE_INVALID",
				`"owner_operator_settlement" has a company fee that isn't the signed fee (${OO_FEE_MIN_BPS / 100}% to ${OO_FEE_MAX_BPS / 100}%) on the week's load pay. Nothing was produced.`,
				["Company fee"]);
		}
	}
	const formFees = new Set(AGREEMENT.FEE_SCHEDULE.map((f) => f.key));
	const signedFees = new Set(listOf(data.feeSchedule).map((f) => (objectOf(f) ? f.key : f)).filter((k) => typeof k === "string" && formFees.has(k)));
	for (const line of lines) {
		if (!given(line.scheduleFee)) continue;
		if (line.kind !== "one_time" || !signedFees.has(line.scheduleFee)) {
			return refused("OO_STATEMENT_FEE_NOT_ON_SCHEDULE",
				"\"owner_operator_settlement\" has a fee that isn't on the signed agreement's schedule. Nothing was produced.", ["Weekly and one-time charges"]);
		}
		if (!ooIsWeekStart(data.weekStart) || !ooIsDayKey(line.lineDate) || line.lineDate < data.weekStart) {
			return refused("OO_STATEMENT_FEE_BACKDATED",
				"\"owner_operator_settlement\" has a fee dated before its settlement week. Nothing was produced.", ["Weekly and one-time charges"]);
		}
	}
	return null;
}

function receiptDetails(line) {
	const parts = [];
	if (said(line.place)) parts.push(said(line.place));
	if (typeof line.gallons === "number" && Number.isFinite(line.gallons) && line.gallons > 0) parts.push(`${line.gallons} gal`);
	const notice = [said(line.agency), said(line.noticeNumber) ? `notice ${said(line.noticeNumber)}` : ""].filter(Boolean).join(", ");
	if (notice) parts.push(notice);
	if (line.filedByOffice === true) parts.push(STATEMENT.FILED_BY_OFFICE);
	if (line.pendingReview === true) parts.push(STATEMENT.PENDING_REVIEW);
	return parts.join("; ");
}

// data: settlementNumber ("S-…"), weekStart and weekEnd (day keys), issuedOn (day
// key), ownerOperatorName, businessName, truckUnit, feeBps, feeSchedule (the
// signed agreement's [{ key }]); lines (owner_operator_settlement_lines rows:
// kind, ref, lineDate, label, cents, baseCents, plus from, to, late, receiptType,
// place, gallons, agency, noticeNumber, filedByOffice, pendingReview,
// scheduleFee); held [{ date, label, reason }]; onboarding { beforeCents,
// installmentCents, leftCents, items [{ date, label, cents }] }; escrow
// { beforeCents, thisWeekCents, afterCents } while escrow is on; totals
// { loadCents, carriedInCents, netCents, payableCents, carriedOutCents };
// bankOnFile (already masked). Every figure is the server's.
function ownerOperatorSettlementFields(input) {
	const data = objectOf(input) || {};
	const lines = listOf(data.lines).filter((l) => objectOf(l) && typeof l.kind === "string");
	const totals = objectOf(data.totals) || {};
	const onboarding = objectOf(data.onboarding) || {};
	const escrow = objectOf(data.escrow);
	if ((given(data.weekStart) && !ooIsWeekStart(data.weekStart)) || (given(data.weekEnd) && data.weekEnd !== ooWeekEnd(data.weekStart))) {
		throw refused("OO_STATEMENT_WEEK_INVALID", "\"owner_operator_settlement\" has a week that isn't Saturday to Friday. Nothing was produced.", ["Week start", "Week end"]);
	}
	// A figure that isn't whole cents is refused, never printed blank.
	const figures = [
		["Lines", ...lines.flatMap((l) => [l.cents, ...(given(l.baseCents) ? [l.baseCents] : [])])],
		["Total load pay", totals.loadCents], ["Balance carried in", totals.carriedInCents], ["Net settlement", totals.netCents],
		["Amount paid", totals.payableCents], ["Balance carried out", totals.carriedOutCents],
		["Onboarding balance before", onboarding.beforeCents], ["Onboarding installment", onboarding.installmentCents],
		["Onboarding balance left", onboarding.leftCents],
		["Onboarding items", ...listOf(onboarding.items).map((i) => (objectOf(i) ? i.cents : NaN))],
		...(escrow ? [["Escrow balance before", escrow.beforeCents], ["Escrow this week", escrow.thisWeekCents], ["Escrow balance after", escrow.afterCents]] : []),
	];
	const notCents = figures.filter(([label, ...values]) => values.some((v) => (label === "Lines" || label === "Onboarding items" ? !wholeCents(v) : given(v) && !wholeCents(v))))
		.map(([label]) => label);
	if (notCents.length) {
		throw refused("OO_STATEMENT_FIGURE_INVALID", `"owner_operator_settlement" has a figure that isn't whole cents: ${notCents.join(", ")}. Nothing was produced.`, notCents);
	}
	const feeError = statementFeeError(data, lines);
	if (feeError) throw feeError;
	const money = (v) => (given(v) ? ooMoneyText(v) : "");
	const of = (kinds) => lines.filter((l) => kinds.includes(l.kind));
	const fee = lines.find((l) => l.kind === "fee");

	const loadRows = of(LOAD_KINDS).map((l) => [
		dateOf(l.lineDate),
		l.late === true ? `${said(l.label)} (${STATEMENT.LATE})` : said(l.label),
		said(l.from),
		said(l.to),
		ooMoneyText(l.cents),
	]);
	const receiptRows = of(RECEIPT_KINDS).map((l) => [dateOf(l.lineDate), said(l.receiptType) || said(l.label), receiptDetails(l), ooMoneyText(l.cents)]);
	const chargeRows = of(CHARGE_KINDS).map((l) => [
		dateOf(l.lineDate),
		given(l.scheduleFee) ? `${said(l.label)} (${STATEMENT.SCHEDULE_FEE})` : said(l.label),
		ooMoneyText(l.cents),
	]);
	const escrowRows = of(ESCROW_KINDS).map((l) => [dateOf(l.lineDate), said(l.label), ooMoneyText(l.cents)]);
	const heldRows = listOf(data.held).filter(objectOf).map((h) => [
		dateOf(h.date),
		said(h.label),
		own(STATEMENT.HELD, h.reason) ? STATEMENT.HELD[h.reason] : STATEMENT.HELD_OTHER,
	]);
	const onboardingRows = listOf(onboarding.items).filter(objectOf).map((i) => [dateOf(i.date), said(i.label), ooMoneyText(i.cents)]);
	const unknown = lines.filter((l) => ![...LOAD_KINDS, ...RECEIPT_KINDS, ...CHARGE_KINDS, ...ESCROW_KINDS, ...SUMMARY_KINDS].includes(l.kind));
	if (unknown.length) {
		throw refused("OO_STATEMENT_LINE_INVALID", "\"owner_operator_settlement\" has a line of a kind it can't show. Nothing was produced.", ["Lines"]);
	}

	const text = {
		"Settlement number": said(data.settlementNumber),
		"Week start": dateOf(data.weekStart),
		"Week end": dateOf(data.weekEnd),
		"Issue date": dateOf(data.issuedOn),
		"Owner-operator name": said(data.ownerOperatorName),
		"Business name": said(data.businessName),
		"Truck unit": said(data.truckUnit),
		"Total load pay": money(totals.loadCents),
		"Company fee line": fee ? `${STATEMENT.COMPANY_FEE} (${ooFeePercentText(data.feeBps)}% of ${ooMoneyText(fee.baseCents)})` : "",
		"Company fee amount": fee ? ooMoneyText(fee.cents) : "",
		"Onboarding balance before": money(onboarding.beforeCents),
		"Onboarding installment": money(onboarding.installmentCents),
		"Onboarding balance left": money(onboarding.leftCents),
		"Escrow balance before": escrow ? money(escrow.beforeCents) : "",
		"Escrow this week": escrow ? money(escrow.thisWeekCents) : "",
		"Escrow balance after": escrow ? money(escrow.afterCents) : "",
		"Balance carried in": money(totals.carriedInCents),
		"Net settlement": money(totals.netCents),
		"Amount paid": money(totals.payableCents),
		"Balance carried out": money(totals.carriedOutCents),
		"Bank on file": said(data.bankOnFile),
	};
	return {
		text,
		requiredText: Object.keys(text),
		tableRows: [
			{ tbodyId: "oo-loads", rows: loadRows, cellCount: 5, emptyText: "(no loads this week)" },
			{ tbodyId: "oo-receipts", rows: receiptRows, cellCount: 4, emptyText: "(no charge-backs this week)" },
			{ tbodyId: "oo-charges", rows: chargeRows, cellCount: 3, emptyText: "(no weekly or one-time charges this week)" },
			{ tbodyId: "oo-held", rows: heldRows, cellCount: 3, emptyText: "(none)" },
			{ tbodyId: "oo-onboarding-items", rows: onboardingRows, cellCount: 3, emptyText: "(listed on the first settlement)" },
			{ tbodyId: "oo-escrow-lines", rows: escrowRows, cellCount: 3, emptyText: "(no escrow movement this week)" },
		],
		signatureLabelForImage: null,
		signatureImage: null,
	};
}

module.exports = {
	AGREEMENT_READY_LABELS,
	ooMoneyText,
	ooFeePercentText,
	ownerOperatorAgreementFields,
	ownerOperatorSettlementFields,
};
