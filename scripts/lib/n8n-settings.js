// The n8n instance and workflow an n8n script talks to: N8N_BASE_URL (the
// instance, e.g. https://<name>.app.n8n.cloud; the scripts add /api/v1) and
// N8N_WORKFLOW_ID. Neither has a default. A script run without them used to
// reach the live instance and the live ingestion workflow; now it stops, exit
// 2 with one line naming what is missing, before any network call.
//
// Pure apart from requireN8nSettings(), which ends the process.
// scripts/test-no-production-defaults.js runs every script that uses it.
"use strict";

const N8N_SETTINGS = Object.freeze(["N8N_BASE_URL", "N8N_WORKFLOW_ID"]);

// { base, workflowId, missing }: each value trimmed, "" when unset or blank,
// and `missing` the names of the empty ones.
function readN8nSettings(env) {
	const values = Object.fromEntries(N8N_SETTINGS.map((name) => [name, String((env && env[name]) ?? "").trim()]));
	return {
		base: values.N8N_BASE_URL,
		workflowId: values.N8N_WORKFLOW_ID,
		missing: N8N_SETTINGS.filter((name) => !values[name]),
	};
}

// The settings, or exit 2 with one line on stderr naming each missing one.
function requireN8nSettings(script, env = process.env) {
	const s = readN8nSettings(env);
	if (s.missing.length) {
		console.error(
			`${script}: ${s.missing.join(" and ")} ${s.missing.length === 1 ? "is" : "are"} not set; ` +
			"name the n8n instance (N8N_BASE_URL) and workflow (N8N_WORKFLOW_ID) to use. There is no default.",
		);
		process.exit(2);
	}
	return { base: s.base, workflowId: s.workflowId };
}

module.exports = { N8N_SETTINGS, readN8nSettings, requireN8nSettings };
