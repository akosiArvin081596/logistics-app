#!/usr/bin/env node
/**
 * PERSON EDIT HOLD (2026-10-22): the re-issued rate-con runners pass with
 * RATECON_PERSON_EDIT_HOLD_ENABLED on. The flag must only ever add holds, so every re-issue
 * case (delivered, invoiced, a closed month, a date that can't be placed, the Assigned Date
 * rules, the DVIR line) answers exactly as with the flag off.
 *
 * Each runner hands its lifted code a stand-in process.env, so a shell variable never reaches
 * it; each forwards RATECON_PERSON_EDIT_HOLD_ENABLED from its own environment into that
 * stand-in (PERSON_HOLD_ENV). This runs each one in a child process with it set to "true".
 *
 * Run: node scripts/test-reissue-runners-person-hold-on.js  # exits 1 on failure
 */
"use strict";

const path = require("path");
const { spawnSync } = require("child_process");

const RUNNERS = ["test-ratecon-reissue-hold.js", "test-reissue-assigned-date.js", "test-reissue-dvir-alert.js"];
const TIMEOUT_MS = Math.max(30000, Number(process.env.UNIT_TEST_TIMEOUT_MS) || 0);

let failures = 0;
for (const name of RUNNERS) {
	const file = path.join(__dirname, name);
	const r = spawnSync(process.execPath, [file], {
		env: { ...process.env, RATECON_PERSON_EDIT_HOLD_ENABLED: "true" },
		encoding: "utf8",
		timeout: TIMEOUT_MS,
		maxBuffer: 16 * 1024 * 1024,
	});
	const out = `${r.stdout || ""}${r.stderr || ""}`.trim().split("\n");
	const last = out[out.length - 1] || "";
	if (r.status === 0) {
		console.log(`ok   ${name} with RATECON_PERSON_EDIT_HOLD_ENABLED=true: ${last}`);
	} else {
		failures++;
		console.error(`FAIL ${name} with RATECON_PERSON_EDIT_HOLD_ENABLED=true (exit ${r.status}${r.error ? `, ${r.error.message}` : ""}):`);
		for (const line of out.filter((l) => /FAIL|Error/.test(l)).slice(0, 20)) console.error(`     ${line}`);
	}
}
console.log(`\ntest-reissue-runners-person-hold-on: ${RUNNERS.length - failures} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
