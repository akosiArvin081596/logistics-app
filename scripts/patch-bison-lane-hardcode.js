/**
 * Reverts the Gemini Vision PDF-fallback experiment and replaces it with the
 * simpler rule Deshorn actually asked for: when the broker is Bison and the
 * rate-con extraction comes back empty, use the dedicated Ames IA → Grand
 * Prairie TX lane.
 *
 * Why we pivoted: the Gemini path worked at the server endpoint (verified
 * with curl), but n8n Cloud's filesystem-v2 binary storage made the
 * binary-passthrough between nodes brittle — the Code node kept getting
 * back the literal placeholder string "filesystem-v2" instead of the PDF
 * bytes. Deshorn's lane is contractually fixed for the foreseeable future,
 * so a 2-line conditional in Normalize Load Fields covers the whole class.
 *
 * What this script does:
 *   1. Removes 4 nodes added by scripts/patch-gemini-pdf-fallback.js:
 *      Cache PDF Base64, Prepare PDF for Gemini, Gemini PDF Fallback,
 *      Gemini Got Load Number?
 *   2. Restores the original wiring:
 *      Merge Attachment + Email → LlamaParse Upload
 *      Markdown Quality OK? FALSE → Build Email Context
 *   3. Updates Normalize Load Fields so Pickup Address and Drop-off
 *      Address fall back to the Bison lane when broker email ends with
 *      bisontransport.com and the extracted address is empty. The
 *      "Awaiting Rate Con" fallback for non-Bison [NEEDS RATE CON] emails
 *      stays in place (preserves the previous patch-awaiting-ratecon.js
 *      behavior).
 *
 * Idempotent: re-running detects the current state and skips no-ops.
 *
 * Run:
 *   N8N_API_KEY=… node scripts/patch-bison-lane-hardcode.js
 */

const N8N_BASE = process.env.N8N_BASE_URL || 'https://sandhub.app.n8n.cloud';
const WORKFLOW_ID = process.env.N8N_WORKFLOW_ID || 'ydFgTSFpKTyyZbXW';
const API_KEY = process.env.N8N_API_KEY;
if (!API_KEY) { console.error('N8N_API_KEY env var required'); process.exit(1); }

const NODES_TO_REMOVE = [
	'Cache PDF Base64',
	'Prepare PDF for Gemini',
	'Gemini PDF Fallback',
	'Gemini Got Load Number?',
];

const BISON_PICKUP = '500 Bell Avenue, Ames, IA 50010';
const BISON_DROPOFF = '2930 114th Street, Grand Prairie, TX 75050';

// Bison-aware Pickup/Drop-off Address expressions.
// Priority:
//   1. Extracted address — whatever Information Extractor or Email-Body
//      Extractor produced. Always wins, so future Bison rate-cons that
//      DO specify addresses (in the email body or extractable PDF) auto-
//      capture with no override.
//   2. Dedicated-lane default — applies ONLY when ALL THREE hold:
//        a) Broker email is *@bisontransport.com (this carrier's only
//           dedicated-lane broker today).
//        b) The email content mentions "Barilla" (current contract
//           customer). Filters out non-Barilla Bison loads.
//        c) The direction-specific city name appears in the email content
//           ("AMES" for pickup, "GRAND PRAIRIE" for drop-off). Filters
//           out a future Barilla lane with a different origin or
//           destination — each direction is checked independently, so the
//           wrong default never silently overrides a real new lane.
//      All three checks combined mean a new Bison Barilla lane to/from
//      different cities falls through to "Awaiting Rate Con" for manual
//      review rather than silently using stale defaults.
//   3. "Awaiting Rate Con" placeholder for [NEEDS RATE CON] emails that
//      don't match the dedicated lane.
//   4. Empty (LlamaParse-OK path with no extraction issue).
//
// All keyword matches are case-insensitive and scan the same combined
// haystack (Details + Drop-off Company + Pickup Notes + Delivery Notes).
const HAYSTACK =
	"(($json.output.Details || '') + ' ' + " +
	"($json.output['Drop-off Company Information'] || '') + ' ' + " +
	"($json.output['Pickup Notes/Instructions'] || '') + ' ' + " +
	"($json.output['Delivery Notes/Instructions'] || ''))";

const BISON_CHECK = "($json.output['Broker Email'] || '').toLowerCase().endsWith('bisontransport.com')";
const BARILLA_CHECK = "/barilla/i.test(" + HAYSTACK + ")";
const AMES_CHECK = "/ames/i.test(" + HAYSTACK + ")";
const GRAND_PRAIRIE_CHECK = "/grand\\s*prairie/i.test(" + HAYSTACK + ")";

const PICKUP_EXPR =
	"={{ $json.output['Pickup Address'] " +
	"|| ((" + BISON_CHECK + " && " + BARILLA_CHECK + " && " + AMES_CHECK + ") ? '" + BISON_PICKUP + "' : '') " +
	"|| (($json.output.Details || '').includes('[NEEDS RATE CON]') ? 'Awaiting Rate Con' : '') }}";

const DROPOFF_EXPR =
	"={{ $json.output['Drop-off Address'] " +
	"|| ((" + BISON_CHECK + " && " + BARILLA_CHECK + " && " + GRAND_PRAIRIE_CHECK + ") ? '" + BISON_DROPOFF + "' : '') " +
	"|| (($json.output.Details || '').includes('[NEEDS RATE CON]') ? 'Awaiting Rate Con' : '') }}";

async function api(method, path, body) {
	const res = await fetch(`${N8N_BASE}/api/v1${path}`, {
		method,
		headers: { 'X-N8N-API-KEY': API_KEY, 'Content-Type': 'application/json' },
		body: body ? JSON.stringify(body) : undefined,
	});
	const text = await res.text();
	if (!res.ok) throw new Error(`${method} ${path} → ${res.status}\n${text.slice(0, 500)}`);
	return text ? JSON.parse(text) : {};
}

function buildPutPayload(wf) {
	const payload = { name: wf.name, nodes: wf.nodes, connections: wf.connections };
	if (wf.staticData !== undefined) payload.staticData = wf.staticData;
	if (wf.settings) {
		const allowed = ['saveExecutionProgress','saveManualExecutions','saveDataErrorExecution','saveDataSuccessExecution','executionTimeout','errorWorkflow','timezone','executionOrder'];
		const clean = {};
		for (const k of allowed) if (wf.settings[k] !== undefined) clean[k] = wf.settings[k];
		payload.settings = clean;
	}
	return payload;
}

(async () => {
	console.log('Fetching workflow...');
	const wf = await api('GET', `/workflows/${WORKFLOW_ID}`);

	let mutated = false;

	// 1) Remove the 4 Gemini-fallback nodes (if present) and their connections.
	const removed = [];
	wf.nodes = wf.nodes.filter(n => {
		if (NODES_TO_REMOVE.includes(n.name)) { removed.push(n.name); return false; }
		return true;
	});
	for (const name of NODES_TO_REMOVE) {
		if (wf.connections[name]) { delete wf.connections[name]; mutated = true; }
	}
	if (removed.length) {
		console.log('Removed nodes:', removed.join(', '));
		mutated = true;
	}

	// 2) Restore original wiring.
	const mergeConn = wf.connections['Merge Attachment + Email'];
	const mergeWantsLlama =
		JSON.stringify(mergeConn) === JSON.stringify({ main: [[{ node: 'LlamaParse Upload', type: 'main', index: 0 }]] });
	if (!mergeWantsLlama) {
		wf.connections['Merge Attachment + Email'] = {
			main: [[{ node: 'LlamaParse Upload', type: 'main', index: 0 }]],
		};
		console.log('Restored Merge Attachment + Email → LlamaParse Upload.');
		mutated = true;
	}

	const router = wf.nodes.find(n => n.name === 'Markdown Quality OK?');
	if (router) {
		const original = {
			main: [
				[{ node: 'Information Extractor', type: 'main', index: 0 }],
				[{ node: 'Build Email Context', type: 'main', index: 0 }],
			],
		};
		if (JSON.stringify(wf.connections['Markdown Quality OK?']) !== JSON.stringify(original)) {
			wf.connections['Markdown Quality OK?'] = original;
			console.log('Restored Markdown Quality OK? FALSE → Build Email Context.');
			mutated = true;
		}
	}

	// 3) Update Normalize Load Fields Pickup/Drop-off expressions.
	const norm = wf.nodes.find(n => n.name === 'Normalize Load Fields');
	if (!norm) throw new Error('Normalize Load Fields node not found.');
	const fields = norm.parameters.fields?.values || norm.parameters.assignments?.assignments || [];
	const findField = (name) => fields.find(f => (f.name || f.fieldName) === name);
	const pickup = findField("output['Pickup Address']");
	const dropoff = findField("output['Drop-off Address']");
	if (!pickup || !dropoff) {
		throw new Error('Pickup/Drop-off Address fields not found in Normalize Load Fields.');
	}
	if (pickup.value !== PICKUP_EXPR) {
		pickup.value = PICKUP_EXPR;
		console.log('Updated Pickup Address expression with Bison lane fallback.');
		mutated = true;
	}
	if (dropoff.value !== DROPOFF_EXPR) {
		dropoff.value = DROPOFF_EXPR;
		console.log('Updated Drop-off Address expression with Bison lane fallback.');
		mutated = true;
	}

	if (!mutated) {
		console.log('Workflow already in target state. Nothing to do.');
		return;
	}

	console.log('Pushing patched workflow...');
	await api('PUT', `/workflows/${WORKFLOW_ID}`, buildPutPayload(wf));
	console.log('OK. Active executions will pick up the change immediately.');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
