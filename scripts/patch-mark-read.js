/**
 * Patches "Dispatch v2 (Fixed)": connects Update Job Tracking (Distance)
 * → Mark Read (Processing) so successfully-processed PDF emails are
 * marked as read in Gmail when the workflow finishes.
 *
 * Root cause: the PDF success path had no terminal Mark Read node.
 * Only the body-fallback path (Mark Read (No Attachment)) marked emails
 * as read. Every email processed via the PDF path (CH Robinson etc.)
 * remained UNREAD after a successful execution, causing the Gmail trigger
 * to re-fire on the same email on the next poll cycle — potentially
 * writing duplicate rows.
 *
 * After this patch the full success path ends:
 *   AI Agent → Update Job Details (Distance) → Update Job Tracking (Distance)
 *     → Mark Read (Processing)
 * The bypass path (Addresses Ready? branch1) also reaches Update Job Tracking
 * and therefore also gets marked read automatically.
 *
 * Run: N8N_API_KEY=... node scripts/patch-mark-read.js
 */

const N8N_BASE = process.env.N8N_BASE_URL || 'https://sandhub.app.n8n.cloud';
const WORKFLOW_ID = process.env.N8N_WORKFLOW_ID || 'ydFgTSFpKTyyZbXW';
const API_KEY = process.env.N8N_API_KEY;
if (!API_KEY) { console.error('N8N_API_KEY env var required'); process.exit(1); }

async function api(method, path, body) {
	const res = await fetch(`${N8N_BASE}/api/v1${path}`, {
		method,
		headers: { 'X-N8N-API-KEY': API_KEY, 'Content-Type': 'application/json' },
		body: body ? JSON.stringify(body) : undefined,
	});
	const text = await res.text();
	if (!res.ok) throw new Error(`${method} ${path} → ${res.status}\n${text.slice(0, 600)}`);
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
	console.log('Fetching workflow…');
	const wf = await api('GET', `/workflows/${WORKFLOW_ID}`);

	// Verify required nodes exist
	const updateTracking = wf.nodes.find(n => n.name === 'Update Job Tracking (Distance)');
	const markRead = wf.nodes.find(n => n.name === 'Mark Read (Processing)');
	if (!updateTracking) throw new Error('"Update Job Tracking (Distance)" node not found');
	if (!markRead) throw new Error('"Mark Read (Processing)" node not found');

	// Check if connection already exists
	const existing = wf.connections['Update Job Tracking (Distance)'];
	if (existing?.main?.[0]?.some(e => e.node === 'Mark Read (Processing)')) {
		console.log('Connection already exists — nothing to do.');
		return;
	}

	// Add the connection
	if (!wf.connections['Update Job Tracking (Distance)']) {
		wf.connections['Update Job Tracking (Distance)'] = { main: [[]] };
	}
	if (!wf.connections['Update Job Tracking (Distance)'].main) {
		wf.connections['Update Job Tracking (Distance)'].main = [[]];
	}
	if (!wf.connections['Update Job Tracking (Distance)'].main[0]) {
		wf.connections['Update Job Tracking (Distance)'].main[0] = [];
	}
	wf.connections['Update Job Tracking (Distance)'].main[0].push({
		node: 'Mark Read (Processing)',
		type: 'main',
		index: 0,
	});

	console.log('Added: Update Job Tracking (Distance) → Mark Read (Processing)');
	console.log('Pushing patched workflow…');
	await api('PUT', `/workflows/${WORKFLOW_ID}`, buildPutPayload(wf));
	console.log('Done. All future PDF-path executions will mark emails as read.');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
