#!/usr/bin/env node
/**
 * STAGED n8n CHANGE — awaiting owner approval. Dry run by default; writes only
 * with BOTH `--apply` and `--i-really-mean-production`.
 *
 * WHAT IT CHANGES — one expression, in one node, in workflow ydFgTSFpKTyyZbXW
 * ("Dispatch v2 (Fixed)", 41 nodes, active):
 *
 *   node   Update Job Tracking (Distance)   (googleSheets, appendOrUpdate,
 *                                            mappingMode defineBelow, tab "Job Tracking")
 *   before "Details": "={{ $json.Details }}"
 *   after  "Details": "={{ $('JOB DETAILS ENTRY').item.json['Details'] }}"
 *
 * `Load ID` is untouched, as is every other node, connection and setting.
 *
 * WHY. Job Tracking's `Details` column is the COMMODITY and is dispatcher-visible
 * in ActiveLoadsTab. `JOB DETAILS ENTRY` writes the commodity there correctly;
 * this node then overwrote it with the ROUTE on every email-ingested load.
 * Proven on execution 2457, load 562787563:
 *     JOB DETAILS ENTRY  ->  "Empty CHEP Pallets, 33,556.15 lbs, 540 Units,
 *                             53' Dry Van Trailer Required"
 *     this node          ->  "Tulsa, OK, 74134 - Joplin, MO, 64803"
 * 324 of 344 populated production rows are route-shaped as a result, and the
 * original commodity is unrecoverable from the sheet.
 *
 * WHY THIS EXPRESSION AND NOT SOMETHING ELSE — three constraints, and only this
 * expression satisfies all three:
 *
 *  1. It must not be `$json.Details`, because that key means OPPOSITE things on
 *     the two branches feeding this node:
 *       Addresses Ready? #0 -> Distance via LogisX -> Update Job Details
 *         (Distance) -> here.  That node is `autoMapInputData`, which passes the
 *         item THROUGH, so $json is the /api/n8n/load-distance response body and
 *         $json.Details is the ROUTE.  <-- the bug
 *       Addresses Ready? #1 -> here directly.  $json is the normalized load item
 *         and $json.Details is the COMMODITY.  <-- already correct
 *  2. It must not be DELETED. Removing the key entirely leaves the node mapping
 *     only its own matching column, and — more importantly — the same instinct
 *     applied one step upstream (dropping top-level `Details` from
 *     /api/n8n/load-distance) makes the Job Details node write an EMPTY STRING
 *     and blank that column outright. That is the regression recorded from
 *     execution 2426. Writing the right value beats writing none.
 *  3. It must be correct on BOTH branches. `$('JOB DETAILS ENTRY').item.json`
 *     is the row that node just wrote to Job Tracking, so re-writing `Details`
 *     from it is idempotent — the cell ends up holding exactly what it already
 *     held. Verified available: that node's output item carries all 14 mapped
 *     columns including `Details` (execution 2457), and THIS node already
 *     resolves `['Load ID']` through the identical reference.
 *
 * ⚠️ Deploy the CLIENT side first. Three surfaces used to read Job Tracking
 * `Details` as a route; until they ship, a correct commodity in that column
 * mangles the driver's load-assigned notification. See the PR.
 *
 * SAFETY
 *  - Dry run prints the exact before/after and exits without touching anything.
 *  - Asserts node count, node presence, and the exact current expression before
 *    writing; any drift aborts.
 *  - PUT sends only {name,nodes,connections,settings,staticData} with `settings`
 *    filtered to the keys the public API accepts (n8n Cloud preserves the rest),
 *    and ALWAYS re-sends staticData — it holds the Gmail Trigger polling cursor,
 *    and dropping it makes the trigger reprocess old rate-con emails.
 *  - `--revert` puts the original expression back.
 *  - Reads the API key from N8N_API_KEY only. Never prints it.
 *
 * USAGE
 *   export N8N_API_KEY=$(jq -r '.n8n.api_key' ~/Documents/Credentials/credentials.json)
 *   node scripts/stage-n8n-details-fix.js                                  # dry run
 *   node scripts/stage-n8n-details-fix.js --apply --i-really-mean-production
 *   node scripts/stage-n8n-details-fix.js --revert --apply --i-really-mean-production
 */

const BASE = process.env.N8N_BASE_URL || "https://sandhub.app.n8n.cloud/api/v1";
const WORKFLOW_ID = "ydFgTSFpKTyyZbXW";
const NODE_NAME = "Update Job Tracking (Distance)";
const EXPECTED_NODE_COUNT = 41;

const CURRENT_EXPR = "={{ $json.Details }}";
const FIXED_EXPR = "={{ $('JOB DETAILS ENTRY').item.json['Details'] }}";

// The public API rejects unknown settings keys; n8n Cloud preserves the ones we
// drop (binaryMode / callerPolicy / availableInMCP), so this is not data loss.
const ALLOWED_SETTINGS = new Set([
	"executionOrder", "saveDataErrorExecution", "saveDataSuccessExecution",
	"saveManualExecutions", "saveExecutionProgress", "executionTimeout",
	"errorWorkflow", "timezone",
]);

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const CONFIRMED = args.includes("--i-really-mean-production");
const REVERT = args.includes("--revert");

const want = REVERT ? CURRENT_EXPR : FIXED_EXPR;
const from = REVERT ? FIXED_EXPR : CURRENT_EXPR;

const KEY = process.env.N8N_API_KEY;
if (!KEY) {
	console.error("N8N_API_KEY is not set. Load it into the env; never paste it on the command line.");
	process.exit(2);
}

async function api(path, init = {}) {
	const res = await fetch(BASE + path, {
		...init,
		headers: { "X-N8N-API-KEY": KEY, "Content-Type": "application/json", ...(init.headers || {}) },
	});
	const text = await res.text();
	if (!res.ok) throw new Error(`${init.method || "GET"} ${path} -> ${res.status}: ${text.slice(0, 400)}`);
	return text ? JSON.parse(text) : null;
}

(async () => {
	console.log(`Workflow ${WORKFLOW_ID} @ ${BASE}`);
	const wf = await api(`/workflows/${WORKFLOW_ID}`);

	console.log(`  name        : ${wf.name}`);
	console.log(`  active      : ${wf.active}`);
	console.log(`  nodes       : ${wf.nodes.length}`);

	if (wf.nodes.length !== EXPECTED_NODE_COUNT) {
		console.error(`\nABORT: expected ${EXPECTED_NODE_COUNT} nodes, found ${wf.nodes.length}. The workflow changed; re-read it before applying.`);
		process.exit(1);
	}

	const node = wf.nodes.find((n) => n.name === NODE_NAME);
	if (!node) {
		console.error(`\nABORT: node "${NODE_NAME}" not found.`);
		process.exit(1);
	}

	const map = node.parameters?.columns?.value || {};
	const actual = map.Details;
	console.log(`\n  node        : ${NODE_NAME}`);
	console.log(`  operation   : ${node.parameters?.operation}  (mappingMode ${node.parameters?.columns?.mappingMode})`);
	console.log(`  sheet       : ${node.parameters?.sheetName?.cachedResultName}`);
	console.log(`  matching    : ${JSON.stringify(node.parameters?.columns?.matchingColumns)}`);
	console.log(`\n  mapped columns:`);
	for (const [k, v] of Object.entries(map)) console.log(`    ${JSON.stringify(k)}: ${JSON.stringify(v)}`);

	if (actual === want) {
		console.log(`\nNo change needed — "Details" already reads:\n    ${want}`);
		process.exit(0);
	}
	if (actual !== from) {
		console.error(`\nABORT: "Details" is not the expression this script knows how to change.`);
		console.error(`  expected: ${JSON.stringify(from)}`);
		console.error(`  actual  : ${JSON.stringify(actual)}`);
		process.exit(1);
	}

	console.log(`\n  CHANGE (Details only; every other key untouched):`);
	console.log(`    -  ${JSON.stringify(actual)}`);
	console.log(`    +  ${JSON.stringify(want)}`);

	if (!APPLY || !CONFIRMED) {
		console.log(`\nDRY RUN — nothing written.`);
		console.log(`To apply: node scripts/stage-n8n-details-fix.js --apply --i-really-mean-production`);
		process.exit(0);
	}

	// ---- write -------------------------------------------------------------
	const nodes = wf.nodes.map((n) =>
		n.name !== NODE_NAME ? n : {
			...n,
			parameters: {
				...n.parameters,
				columns: { ...n.parameters.columns, value: { ...map, Details: want } },
			},
		}
	);

	const settings = {};
	for (const [k, v] of Object.entries(wf.settings || {})) if (ALLOWED_SETTINGS.has(k)) settings[k] = v;

	const body = {
		name: wf.name,
		nodes,
		connections: wf.connections,
		settings,
		// Holds "node:Gmail Trigger" — the polling cursor. Dropping it makes the
		// trigger reprocess already-ingested rate-con emails.
		staticData: wf.staticData,
	};

	await api(`/workflows/${WORKFLOW_ID}`, { method: "PUT", body: JSON.stringify(body) });

	// ---- post-flight: read it back -----------------------------------------
	const after = await api(`/workflows/${WORKFLOW_ID}`);
	const afterNode = after.nodes.find((n) => n.name === NODE_NAME);
	const afterExpr = afterNode?.parameters?.columns?.value?.Details;
	const cursorSame = JSON.stringify(after.staticData) === JSON.stringify(wf.staticData);

	console.log(`\nPOST-FLIGHT`);
	console.log(`  nodes            : ${after.nodes.length} (was ${wf.nodes.length})`);
	console.log(`  active           : ${after.active} (was ${wf.active})`);
	console.log(`  Details expr     : ${JSON.stringify(afterExpr)}`);
	console.log(`  Load ID expr     : ${JSON.stringify(afterNode?.parameters?.columns?.value?.["Load ID"])}`);
	console.log(`  staticData same  : ${cursorSame}`);

	const ok = afterExpr === want && after.nodes.length === wf.nodes.length && after.active === wf.active && cursorSame;
	console.log(ok ? "\nOK — applied and verified." : "\n*** VERIFY FAILED — inspect the workflow now. ***");
	process.exit(ok ? 0 : 1);
})().catch((e) => {
	console.error("\nERROR:", e.message);
	process.exit(1);
});
