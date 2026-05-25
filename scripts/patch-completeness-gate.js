/**
 * Adds a "Critical Fields Complete?" gate so emails only get marked read
 * in Gmail when the workflow actually extracted the rate (Payment). If
 * Rate is empty — i.e. the PDF parse failed and body-fallback was the
 * only thing that ran — the email stays unread so the Gmail trigger
 * re-fires on the next poll and retries the extraction. Stops the
 * silent partial-write pattern (load row gets created with empty
 * Payment, no one notices for hours).
 *
 * Why Rate as the canary: it's only ever present in the rate-con PDF,
 * never in the email body. So Rate present ⟺ PDF parsed successfully.
 * Bison's hardcode fallback fills addresses with "500 Bell Avenue" /
 * "Awaiting Rate Con", but never Rate — so checking addresses would be
 * fooled by the hardcodes. Rate alone is the discriminator.
 *
 * Topology change:
 *   BEFORE
 *     Google Drive               -> Mark Read (Processing)   [premature]
 *     Extract from Email Body[0] -> Mark Read (No Attachment) [premature]
 *     Update Job Tracking (Dist) -> Mark Read (Processing)
 *
 *   AFTER
 *     Google Drive               -> (terminator — drive upload is a side effect, not a "done" signal)
 *     Extract from Email Body[0] -> Normalize Load Fields    [kept]
 *     Update Job Tracking (Dist) -> Critical Fields Complete?
 *                                    -> [TRUE]  Mark Read (Processing)
 *                                    -> [FALSE] (terminator — email stays unread, Gmail retriggers)
 *
 * Mark Read (No Attachment) becomes orphaned (no inbound edges) but
 * stays in the workflow so the patch is reversible. Mark Read (Failed)
 * is untouched — actual extraction errors still mark read so the email
 * doesn't retry forever on truly bad inputs.
 *
 * Idempotent: detects the existing "Critical Fields Complete?" node and
 * skips. Backs up the unmodified workflow to .wf-backup-<ts>.json.
 *
 * Run: N8N_API_KEY=... node scripts/patch-completeness-gate.js
 */

const fs = require('fs');
const path = require('path');

const N8N_BASE = process.env.N8N_BASE_URL || 'https://sandhub.app.n8n.cloud';
const WORKFLOW_ID = process.env.N8N_WORKFLOW_ID || 'ydFgTSFpKTyyZbXW';
const API_KEY = process.env.N8N_API_KEY;
if (!API_KEY) { console.error('N8N_API_KEY env var required'); process.exit(1); }

const GATE_NODE_NAME = 'Critical Fields Complete?';

function uuid() {
	return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
		const r = Math.random() * 16 | 0;
		return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
	});
}

async function api(method, p, body) {
	const res = await fetch(`${N8N_BASE}/api/v1${p}`, {
		method,
		headers: { 'X-N8N-API-KEY': API_KEY, 'Content-Type': 'application/json' },
		body: body ? JSON.stringify(body) : undefined,
	});
	const text = await res.text();
	if (!res.ok) throw new Error(`${method} ${p} → ${res.status}\n${text.slice(0, 600)}`);
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

	if (wf.nodes.some(n => n.name === GATE_NODE_NAME)) {
		console.log(`"${GATE_NODE_NAME}" already present — nothing to do.`);
		return;
	}

	// Verify required existing nodes
	const ujt = wf.nodes.find(n => n.name === 'Update Job Tracking (Distance)');
	const mrp = wf.nodes.find(n => n.name === 'Mark Read (Processing)');
	const gd  = wf.nodes.find(n => n.name === 'Google Drive');
	const eeb = wf.nodes.find(n => n.name === 'Extract from Email Body');
	const norm = wf.nodes.find(n => n.name === 'Normalize Load Fields');
	if (!ujt)  throw new Error('Update Job Tracking (Distance) node not found');
	if (!mrp)  throw new Error('Mark Read (Processing) node not found');
	if (!gd)   throw new Error('Google Drive node not found');
	if (!eeb)  throw new Error('Extract from Email Body node not found');
	if (!norm) throw new Error('Normalize Load Fields node not found');

	// Backup
	const backupPath = path.join(__dirname, `.wf-backup-${Date.now()}.json`);
	fs.writeFileSync(backupPath, JSON.stringify(wf, null, 2));
	console.log('Backup saved to', backupPath);

	// 1) Build the gate IF node, positioned between Update Job Tracking (Distance) and Mark Read (Processing)
	const gateNode = {
		id: uuid(),
		name: GATE_NODE_NAME,
		type: 'n8n-nodes-base.if',
		typeVersion: 2.2,
		position: [ujt.position[0] + 224, ujt.position[1]],
		parameters: {
			conditions: {
				options: { caseSensitive: false, leftValue: '', typeValidation: 'loose', version: 2 },
				conditions: [
					{
						id: uuid(),
						leftValue: "={{ ($('Normalize Load Fields').item.json.output.Rate || '').toString().trim() }}",
						rightValue: '',
						operator: { type: 'string', operation: 'notEmpty', singleValue: true },
					},
				],
				combinator: 'and',
			},
			options: {},
		},
	};
	wf.nodes.push(gateNode);

	// 2) Remove Google Drive → Mark Read (Processing) (premature mark-read on PDF upload)
	const gdConn = wf.connections['Google Drive'];
	if (gdConn?.main) {
		gdConn.main = gdConn.main.map(branch => branch.filter(e => e.node !== 'Mark Read (Processing)'));
		// If the only edge was the removed one, the branch is now empty — fine.
	}

	// 3) Remove Extract from Email Body[0] → Mark Read (No Attachment) (premature mark-read on body extraction)
	//    Keep [0] → Normalize Load Fields; keep [1] → Send Failure Alert.
	const eebConn = wf.connections['Extract from Email Body'];
	if (eebConn?.main?.[0]) {
		eebConn.main[0] = eebConn.main[0].filter(e => e.node !== 'Mark Read (No Attachment)');
	}

	// 4) Redirect Update Job Tracking (Distance) → Mark Read (Processing) through the gate
	wf.connections['Update Job Tracking (Distance)'] = wf.connections['Update Job Tracking (Distance)'] || { main: [[]] };
	wf.connections['Update Job Tracking (Distance)'].main = wf.connections['Update Job Tracking (Distance)'].main.map(branch =>
		branch.map(e => e.node === 'Mark Read (Processing)' ? { ...e, node: GATE_NODE_NAME } : e)
	);

	// 5) Wire the gate: TRUE → Mark Read (Processing), FALSE → terminator
	wf.connections[GATE_NODE_NAME] = {
		main: [
			[{ node: 'Mark Read (Processing)', type: 'main', index: 0 }],
			[],
		],
	};

	console.log('Pushing patched workflow…');
	await api('PUT', `/workflows/${WORKFLOW_ID}`, buildPutPayload(wf));
	console.log('OK — completeness gate installed.');
	console.log('  Update Job Tracking (Distance) → "Critical Fields Complete?"');
	console.log('    [TRUE]  → Mark Read (Processing)');
	console.log('    [FALSE] → email stays unread, Gmail retriggers next poll');
	console.log('  Google Drive → Mark Read edge: REMOVED');
	console.log('  Extract from Email Body[0] → Mark Read (No Attachment) edge: REMOVED');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
