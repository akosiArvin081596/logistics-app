"use strict";

// Where the driver app shows the training videos, from the onboarding status alone
// (DRIVER_TRAINING_VIDEOS_ENABLED; server.js puts the answer on the driver payload).
// No record means an older account in the normal app; an unknown status shows nothing.
// Pure: no network, database or file access.
const PLACEMENT_BY_STATUS = Object.freeze({ documents_signed: "onboarding", fully_onboarded: "kit" });

function trainingVideoPlacement(status) {
	if (status === null || status === undefined) return "kit";
	return Object.prototype.hasOwnProperty.call(PLACEMENT_BY_STATUS, status) ? PLACEMENT_BY_STATUS[status] : null;
}

module.exports = { trainingVideoPlacement, PLACEMENT_BY_STATUS };
