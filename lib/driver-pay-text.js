"use strict";
// The investor-facing wording of a driver's pay at more than one daily rate,
// for the payout statement PDF (lib/payout-statement.js): one segment per rate,
// in day order, "1 day x $280 + 18 days x $320". Under the daily-rate rule
// (lib/driver-rate-only.js) a driver can be paid at two rates in one month, his
// rate having changed on a date; the server sends the segments ({ days, rate })
// with the figure, and this only formats them.
//
// The portal's copy is client/src/lib/driverPay.js driverPayBasis(), and the
// two must say the same, character for character
// (scripts/test-driver-pay-two-rates.mjs). Every investor-facing text is listed
// in docs/investor-portal-copy.md. This file is part of the statement template
// (STATEMENT_TEMPLATE_FILES in server.js): changing it re-renders every stored
// statement on its next download.
//
// Pure: no network, DB or filesystem.

function rateSegmentsText(rates) {
	return (Array.isArray(rates) ? rates : []).map((s) => {
		const days = Number(s && s.days) || 0;
		return `${days} day${days === 1 ? "" : "s"} x $${Number(s && s.rate) || 0}`;
	}).join(" + ");
}

module.exports = { rateSegmentsText };
