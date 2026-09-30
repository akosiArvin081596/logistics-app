#!/usr/bin/env node
/**
 * A driver application's SSN is masked to its last four DIGITS wherever it is
 * shown: the application PDF (GET /api/applications/:id/pdf) and the admin
 * Applications list (ApplicationsView.vue maskSSN).
 *
 * /apply stores an SSN as typed, and some are stored with a trailing space
 * ("123-45-6789 "). Both places used to take the last four CHARACTERS, so the
 * PDF printed "***-**-789". The PDF now uses lib/pii-mask.js maskSsn(), the
 * rule every masked API payload already uses, and the list reduces to digits
 * first the same way.
 *
 * Plain node, no server: the route is read as source, the Vue function is
 * lifted and run.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const piiMask = require("../lib/pii-mask");

const ROOT = path.join(__dirname, "..");
const SERVER = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const VIEW = fs.readFileSync(path.join(ROOT, "client/src/views/ApplicationsView.vue"), "utf8");

let pass = 0;
const failures = [];
function t(ok, label) {
	if (ok) pass++;
	else failures.push(label);
}

const CASES = [
	["dashes", "123-45-6789", "***-**-6789"],
	["dashes and a trailing space", "123-45-6789 ", "***-**-6789"],
	["bare digits", "123456789", "***-**-6789"],
	["spaces inside", "123 45 6789", "***-**-6789"],
	["fewer than four digits", "12", "***-**-****"],
];

// 1. The PDF route masks through the shared helper.
const start = SERVER.indexOf('app.get("/api/applications/:id/pdf"');
t(start > 0, "the application PDF route is found");
const route = SERVER.slice(start, SERVER.indexOf("\napp.", start + 1));
t(/field\("SSN", app\.ssn \? piiMask\.maskSsn\(app\.ssn\) : "N\/A"\)/.test(route), "the PDF's SSN line uses piiMask.maskSsn()");
t(!/ssn\.slice\(-4\)/.test(route), "the PDF route takes no last-four-characters slice of the SSN");
for (const [label, input, want] of CASES) {
	t(piiMask.maskSsn(input) === want, `maskSsn, ${label}: ${want}`);
}

// 2. The admin list's own copy agrees.
const fnStart = VIEW.indexOf("function maskSSN(");
t(fnStart > 0, "ApplicationsView.vue maskSSN is found");
const fnSrc = VIEW.slice(fnStart, VIEW.indexOf("\n}\n", fnStart) + 2);
const maskSSN = new Function(`${fnSrc}; return maskSSN;`)();
for (const [label, input, want] of CASES) {
	t(maskSSN(input) === want, `ApplicationsView maskSSN, ${label}: ${want}`);
}
t(maskSSN("") === "***-**-****" && maskSSN(null) === "***-**-****", "ApplicationsView maskSSN, empty: a full mask");

// 3. Sabotage control: the old last-four-characters rule is caught.
const OLD = (ssn) => (!ssn || ssn.length < 4 ? "***-**-****" : "***-**-" + ssn.slice(-4));
t(OLD("123-45-6789 ") !== "***-**-6789", "control: the old rule prints three digits for a trailing space, so the cases above would catch it");

if (failures.length) {
	for (const f of failures) console.error(`FAIL  ${f}`);
	console.error(`\n${pass} passed, ${failures.length} failed`);
	process.exit(1);
}
console.log(`all ${pass} assertions passed`);
