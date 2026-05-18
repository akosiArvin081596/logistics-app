/**
 * Patches "Dispatch v2 (Fixed)":
 *
 * Problem: the AI Agent (distance/payment calculator) crashes with
 * "Model output doesn't fit required format" whenever Pickup or Drop-off
 * Address is "Awaiting Rate Con" or empty — because the LLM can't route
 * between placeholder strings. The Structured Output Parser then throws,
 * leaving the execution in error state even though the sheet row was
 * already written correctly.
 *
 * Fix: insert an IF node ("Addresses Ready?") between JOB DETAILS ENTRY
 * and AI Agent:
 *   - branch 0 (true)  → AI Agent (both addresses are real)
 *   - branch 1 (false) → Update Job Tracking (Distance) directly,
 *                         passing through the existing row JSON unchanged
 *                         so the execution finishes cleanly without
 *                         populating distance/payment (correct — we don't
 *                         know them yet).
 *
 * Also cleans up any leftover "Replay Webhook" / "Replay Get Email" nodes
 * from the replay tooling so the workflow stays tidy.
 *
 * Run:  N8N_API_KEY=... node scripts/patch-agent-guard.js
 */

const N8N_BASE = process.env.N8N_BASE_URL || 'https://sandhub.app.n8n.cloud';
const WORKFLOW_ID = process.env.N8N_WORKFLOW_ID || 'ydFgTSFpKTyyZbXW';
const API_KEY = process.env.N8N_API_KEY;
if (!API_KEY) { console.error('N8N_API_KEY env var required'); process.exit(1); }

const REPLAY_NODE_NAMES = ['Replay Webhook', 'Replay Get Email'];
const GUARD_NODE_NAME = 'Addresses Ready?';

function uuid() {
	return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
		const r = Math.random() * 16 | 0;
		return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
	});
}

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

	// --- 1. Remove leftover replay nodes ---
	const beforeCount = wf.nodes.length;
	wf.nodes = wf.nodes.filter(n => !REPLAY_NODE_NAMES.includes(n.name));
	for (const name of REPLAY_NODE_NAMES) delete wf.connections[name];
	// Remove any inbound edges pointing at replay nodes
	for (const [src, conn] of Object.entries(wf.connections)) {
		for (const [type, branches] of Object.entries(conn)) {
			conn[type] = branches.map(branch =>
				branch.filter(edge => !REPLAY_NODE_NAMES.includes(edge.node))
			);
		}
	}
	const removedReplay = beforeCount - wf.nodes.length;
	console.log(`Removed ${removedReplay} leftover replay node(s).`);

	// --- 2. Idempotency: skip if guard already installed ---
	if (wf.nodes.some(n => n.name === GUARD_NODE_NAME)) {
		console.log('"Addresses Ready?" guard already present — skipping node insertion.');
	} else {
		// Find the nodes we need to rewire
		const jobEntry = wf.nodes.find(n => n.name === 'JOB DETAILS ENTRY');
		const agentNode = wf.nodes.find(n => n.name === 'AI Agent');
		const updateTracking = wf.nodes.find(n => n.name === 'Update Job Tracking (Distance)');
		if (!jobEntry) throw new Error('JOB DETAILS ENTRY node not found');
		if (!agentNode) throw new Error('AI Agent node not found');
		if (!updateTracking) throw new Error('Update Job Tracking (Distance) node not found');

		// Place the guard between JOB DETAILS ENTRY and AI Agent (horizontally midpoint)
		const guardPos = [
			Math.round((jobEntry.position[0] + agentNode.position[0]) / 2),
			jobEntry.position[1],
		];

		const guardNode = {
			id: uuid(),
			name: GUARD_NODE_NAME,
			type: 'n8n-nodes-base.if',
			typeVersion: 2.2,
			position: guardPos,
			parameters: {
				conditions: {
					options: {
						caseSensitive: false,
						leftValue: '',
						typeValidation: 'loose',
						version: 2,
					},
					conditions: [
						{
							id: uuid(),
							leftValue: "={{ $json['Pickup Address'] }}",
							rightValue: 'Awaiting Rate Con',
							operator: { type: 'string', operation: 'notEquals' },
						},
						{
							id: uuid(),
							leftValue: "={{ $json['Pickup Address'] }}",
							rightValue: '',
							operator: { type: 'string', operation: 'notEmpty', singleValue: true },
						},
						{
							id: uuid(),
							leftValue: "={{ $json['Drop-off Address'] }}",
							rightValue: 'Awaiting Rate Con',
							operator: { type: 'string', operation: 'notEquals' },
						},
						{
							id: uuid(),
							leftValue: "={{ $json['Drop-off Address'] }}",
							rightValue: '',
							operator: { type: 'string', operation: 'notEmpty', singleValue: true },
						},
					],
					combinator: 'and',
				},
				options: {},
			},
		};

		wf.nodes.push(guardNode);

		// Rewire: JOB DETAILS ENTRY → guard (was → AI Agent)
		// (keep any other outputs of JOB DETAILS ENTRY intact)
		const jeConn = wf.connections['JOB DETAILS ENTRY'];
		if (jeConn?.main) {
			jeConn.main = jeConn.main.map(branch =>
				branch.map(edge => edge.node === 'AI Agent'
					? { ...edge, node: GUARD_NODE_NAME }
					: edge
				)
			);
		}

		// Guard branch 0 (true — addresses valid) → AI Agent
		// Guard branch 1 (false — awaiting rate con) → Update Job Tracking (Distance)
		wf.connections[GUARD_NODE_NAME] = {
			main: [
				[{ node: 'AI Agent', type: 'main', index: 0 }],
				[{ node: 'Update Job Tracking (Distance)', type: 'main', index: 0 }],
			],
		};

		console.log('"Addresses Ready?" guard node inserted between JOB DETAILS ENTRY and AI Agent.');
		console.log('  branch 0 (true)  → AI Agent');
		console.log('  branch 1 (false) → Update Job Tracking (Distance)');
	}

	console.log('Pushing patched workflow…');
	await api('PUT', `/workflows/${WORKFLOW_ID}`, buildPutPayload(wf));
	console.log('Done.');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
