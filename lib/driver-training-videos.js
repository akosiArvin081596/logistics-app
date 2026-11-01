"use strict";

// Where the driver app shows the training videos, from the onboarding status alone.
// No record means an older account in the normal app; anything else unknown shows nothing.
const PLACEMENT_BY_STATUS = Object.freeze({ documents_signed: "onboarding", fully_onboarded: "kit" });

function trainingVideoPlacement(status) {
	if (status === null || status === undefined) return "kit";
	// The lookup would turn a non-string (["documents_signed"]) into a status.
	if (typeof status !== "string") return null;
	return Object.prototype.hasOwnProperty.call(PLACEMENT_BY_STATUS, status) ? PLACEMENT_BY_STATUS[status] : null;
}

module.exports = { trainingVideoPlacement, PLACEMENT_BY_STATUS };
