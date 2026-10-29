"use strict";
// The payout statement's template hash: part of every stored statement's cache
// key (statementFingerprint() in server.js). Any byte change to one of the files
// below changes the computed value, and every stored statement then re-renders
// and re-issues on its next download.
//
// PINS keeps the stored statements when an edit is proven to render the same:
// it maps the new computed value to the hash those statements were filed under.
// Each entry is added in a reviewed PR that says why the new bytes render the
// same, and it covers those exact bytes only, so any later edit falls outside it.
// Without an entry, an edit re-issues every statement, as before.
//
// The files are read against the app root, never through the caller's require()
// or the working directory, so the value is the same from any file that loads
// this one. This file is not one of the hashed files and never becomes one, so
// adding a PINS entry can't move the value it pins.
//
// Reads the five files only: no network, DB or environment.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const APP_ROOT = path.join(__dirname, "..");

// Everything that can change the printed page:
//   payout-statement.js: the layout itself.
//   broker-invoice.js: its money and date formatting and the seller block,
//     which payout-statement.js reuses.
//   pdf-browser.js: page format, margins, the fonts wait and Chromium's launch
//     arguments, each of which changes the rendered bytes.
//   lease-payout-text.js and driver-pay-text.js: wording the statement prints.
// The specifier text is part of the digest, so it must stay exactly as written.
const STATEMENT_TEMPLATE_FILES = Object.freeze([
	"./lib/payout-statement.js",
	"./lib/broker-invoice.js",
	"./lib/pdf-browser.js",
	"./lib/lease-payout-text.js",
	"./lib/driver-pay-text.js",
]);

// computed hash -> the hash the stored statements were filed under.
const PINS = Object.freeze({
	// lib/pdf-browser.js gains Chromium's controls, each off unless set: off, the launch is the same
	// (scripts/test-chromium-launch.js §1); on, pages render the same text and fonts (test-pdf-cold-start.js).
	"a1180b742cf9": "cba159821377",
});

// Sorted so the value is the same on every machine. Each file adds its
// specifier and byte length as well as its bytes, so swapping two files'
// contents can't give the same digest. Throws if a file can't be read.
function computeStatementTemplateHash() {
	const h = crypto.createHash("sha256");
	for (const spec of [...STATEMENT_TEMPLATE_FILES].sort()) {
		const buf = fs.readFileSync(path.join(APP_ROOT, spec));
		h.update(spec).update("\0").update(String(buf.length)).update("\0").update(buf).update("\0");
	}
	return h.digest("hex").slice(0, 12);
}

function effectiveStatementTemplateHash() {
	const computed = computeStatementTemplateHash();
	return Object.hasOwn(PINS, computed) ? PINS[computed] : computed;
}

module.exports = { STATEMENT_TEMPLATE_FILES, PINS, computeStatementTemplateHash, effectiveStatementTemplateHash };
