/**
 * Patches the "Dispatch v2 (Fixed)" n8n workflow so Bison-style emails
 * (no PDF, body-only extraction) write "Awaiting Rate Con" into the
 * Pickup Address / Drop-off Address columns instead of empty strings.
 *
 * Trigger: when Information Extractor / Email-Body Extractor returns null
 * for an address AND Details contains the "[NEEDS RATE CON]" marker
 * (the Build Email Context branch always prefixes that), the Normalize
 * Load Fields node now emits "Awaiting Rate Con" so the dispatcher sees
 * a clear flag in the Live Tracking / Active Loads view.
 *
 * Run:  N8N_API_KEY=... node scripts/patch-awaiting-ratecon.js
 */

const N8N_BASE = process.env.N8N_BASE_URL || 'https://sandhub.app.n8n.cloud';
const WORKFLOW_ID = process.env.N8N_WORKFLOW_ID || 'ydFgTSFpKTyyZbXW';
const API_KEY = process.env.N8N_API_KEY;
if (!API_KEY) { console.error('N8N_API_KEY env var required'); process.exit(1); }

const PICKUP_EXPR = "={{ $json.output['Pickup Address'] || (($json.output.Details || '').includes('[NEEDS RATE CON]') ? 'Awaiting Rate Con' : '') }}";
const DROPOFF_EXPR = "={{ $json.output['Drop-off Address'] || (($json.output.Details || '').includes('[NEEDS RATE CON]') ? 'Awaiting Rate Con' : '') }}";

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

(async () => {
	console.log('Fetching workflow…');
	const wf = await api('GET', `/workflows/${WORKFLOW_ID}`);
	const norm = wf.nodes.find(n => n.name === 'Normalize Load Fields');
	if (!norm) throw new Error('Normalize Load Fields node not found');

	const fields = norm.parameters.fields?.values || norm.parameters.assignments?.assignments || [];
	const findField = (name) => fields.find(f => (f.name || f.fieldName) === name);

	const pickup = findField("output['Pickup Address']");
	const dropoff = findField("output['Drop-off Address']");
	if (!pickup) throw new Error("output['Pickup Address'] field not found in Normalize Load Fields");
	if (!dropoff) throw new Error("output['Drop-off Address'] field not found in Normalize Load Fields");

	if (pickup.value === PICKUP_EXPR && dropoff.value === DROPOFF_EXPR) {
		console.log('Already patched. Nothing to do.');
		return;
	}

	pickup.value = PICKUP_EXPR;
	dropoff.value = DROPOFF_EXPR;

	const allowed = ['name', 'nodes', 'connections', 'settings', 'staticData'];
	const payload = {};
	for (const k of allowed) if (wf[k] !== undefined) payload[k] = wf[k];

	// n8n PUBLIC API (v1) workflow settings allowlist — strict.
	// binaryMode, callerPolicy, availableInMCP are NOT accepted here (internal API only).
	if (payload.settings) {
		const allowedSettings = ['saveExecutionProgress','saveManualExecutions','saveDataErrorExecution','saveDataSuccessExecution','executionTimeout','errorWorkflow','timezone','executionOrder'];
		const clean = {};
		for (const k of allowedSettings) if (payload.settings[k] !== undefined) clean[k] = payload.settings[k];
		payload.settings = clean;
	}

	console.log('Pushing patched workflow…');
	await api('PUT', `/workflows/${WORKFLOW_ID}`, payload);
	console.log('OK. Patched Pickup + Drop-off Address fallbacks. Active executions will pick up the change immediately.');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
