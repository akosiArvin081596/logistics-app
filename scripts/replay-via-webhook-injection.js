/**
 * Replays a single Gmail message through the PRODUCTION n8n workflow by
 * temporarily injecting two nodes (a Webhook trigger + a Gmail "get
 * message") that pipe directly into the existing Email Input node. After
 * the replay completes, removes the injected nodes and restores the
 * workflow.
 *
 * Why this approach: n8n cloud credentials are scoped to the workflow
 * they were configured in, so a separate temp workflow can't use the
 * production Gmail OAuth. Injecting into the production workflow itself
 * is the only programmatic way without UI access.
 *
 * Safety:
 *  - Full backup written to scripts/.wf-backup-<ts>.json BEFORE injection
 *  - Restore is attempted in a finally block (even on error)
 *  - If restore fails, you can manually re-PUT the backup with:
 *      curl -X PUT -H "X-N8N-API-KEY: $KEY" -H "Content-Type: application/json" \
 *        --data @scripts/.wf-backup-<ts>.json \
 *        https://sandhub.app.n8n.cloud/api/v1/workflows/ydFgTSFpKTyyZbXW
 *
 * Usage: N8N_API_KEY=... node scripts/replay-via-webhook-injection.js [messageId]
 *  default messageId = 19df41c0f90151db (RE: Bison #6942913, exec 2067)
 */

const fs = require('fs');
const path = require('path');

const N8N_BASE = process.env.N8N_BASE_URL || 'https://sandhub.app.n8n.cloud';
const WORKFLOW_ID = process.env.N8N_WORKFLOW_ID || 'ydFgTSFpKTyyZbXW';
const API_KEY = process.env.N8N_API_KEY;
if (!API_KEY) { console.error('N8N_API_KEY env var required'); process.exit(1); }

const TARGET_MSG = process.argv[2] || '19df41c0f90151db';
const GMAIL_CRED = { gmailOAuth2: { id: 'oymS9U543xCU6JOB', name: 'Gmail account 7' } };

const INJECTED_NAMES = ['Replay Webhook', 'Replay Get Email'];

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

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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
	const webhookPath = 'replay-' + uuid().slice(0, 12);
	let restored = false;
	let originalSnapshot = null;
	let backupPath = null;

	try {
		console.log('Fetching production workflow…');
		const wf = await api('GET', `/workflows/${WORKFLOW_ID}`);
		originalSnapshot = JSON.parse(JSON.stringify(wf));

		backupPath = path.join(__dirname, `.wf-backup-${Date.now()}.json`);
		fs.writeFileSync(backupPath, JSON.stringify(originalSnapshot, null, 2));
		console.log('Backup written:', backupPath);

		// Make sure nothing left over from a prior crashed run
		if (wf.nodes.some(n => INJECTED_NAMES.includes(n.name))) {
			throw new Error('Replay nodes already exist — refusing to inject again. Inspect workflow manually.');
		}

		const emailInput = wf.nodes.find(n => n.name === 'Email Input');
		if (!emailInput) throw new Error('Email Input node missing — refusing to inject.');

		const replayWebhook = {
			id: uuid(),
			name: 'Replay Webhook',
			type: 'n8n-nodes-base.webhook',
			typeVersion: 2,
			position: [emailInput.position[0] - 448, emailInput.position[1] + 200],
			parameters: { httpMethod: 'POST', path: webhookPath, responseMode: 'lastNode', options: {} },
			webhookId: uuid(),
		};
		const replayGet = {
			id: uuid(),
			name: 'Replay Get Email',
			type: 'n8n-nodes-base.gmail',
			typeVersion: 2.1,
			position: [emailInput.position[0] - 224, emailInput.position[1] + 200],
			parameters: { operation: 'get', messageId: TARGET_MSG, simple: false, options: { downloadAttachments: true } },
			credentials: GMAIL_CRED,
		};

		// Inject + wire to Email Input
		const patched = JSON.parse(JSON.stringify(wf));
		patched.nodes.push(replayWebhook, replayGet);
		patched.connections['Replay Webhook'] = { main: [[{ node: 'Replay Get Email', type: 'main', index: 0 }]] };
		patched.connections['Replay Get Email'] = { main: [[{ node: 'Email Input', type: 'main', index: 0 }]] };

		console.log('Injecting replay nodes…');
		await api('PUT', `/workflows/${WORKFLOW_ID}`, buildPutPayload(patched));

		// Snapshot current exec list so we know what's "new"
		const before = await api('GET', `/executions?workflowId=${WORKFLOW_ID}&limit=5&includeData=false`);
		const lastId = before.data?.[0]?.id || 0;
		console.log('Latest production exec before replay:', lastId);

		const url = `${N8N_BASE}/webhook/${webhookPath}`;
		console.log('Firing replay webhook:', url);
		const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
		console.log('Webhook status:', res.status);
		console.log('Webhook body:', (await res.text()).slice(0, 300));

		console.log('Polling for new execution (up to ~3 min)…');
		let exec = null;
		for (let i = 0; i < 18 && !exec; i++) {
			await sleep(10000);
			const list = await api('GET', `/executions?workflowId=${WORKFLOW_ID}&limit=5&includeData=false`);
			const cand = list.data?.[0];
			if (cand && Number(cand.id) > Number(lastId)) { exec = cand; break; }
			process.stdout.write('.');
		}
		console.log('');

		if (!exec) throw new Error('No new execution detected.');
		console.log('New exec:', exec.id, '| status:', exec.status, '| started:', exec.startedAt);

		// Wait for completion
		for (let i = 0; i < 30 && exec.status === 'running'; i++) {
			await sleep(10000);
			exec = await api('GET', `/executions/${exec.id}?includeData=false`);
			process.stdout.write('.');
		}
		console.log('');
		console.log('Final status:', exec.status, '| stopped:', exec.stoppedAt);

		// Inspect the run
		const full = await api('GET', `/executions/${exec.id}?includeData=true`);
		const runData = full.data?.resultData?.runData || {};
		const ran = Object.keys(runData);

		console.log();
		console.log('=== NODE EXECUTION CHECK ===');
		for (const cp of [
			'Email Input',
			'Has Attachments?',
			'Get Thread Messages',
			'Pick Thread PDF',
			'Thread Has PDF?',
			'Download Thread PDF Msg',
			'Prep Thread PDF Item',
			'LlamaParse Upload',
			'LlamaParse Get Markdown',
			'Markdown Quality OK?',
			'Information Extractor',
			'Normalize Load Fields',
			'JOB DETAILS ENTRY',
			'Extract from Email Body',
		]) console.log(`  ${ran.includes(cp) ? '✓' : '·'} ${cp}`);

		console.log();
		const pickOut = runData['Pick Thread PDF']?.[0]?.data?.main?.[0]?.[0]?.json;
		if (pickOut) console.log('Pick Thread PDF:', JSON.stringify(pickOut));

		const ext = runData['Information Extractor']?.[0]?.data?.main?.[0]?.[0]?.json?.output;
		if (ext) {
			console.log('Information Extractor:');
			console.log('  Load Number     :', JSON.stringify(ext['Load Number']));
			console.log('  Pickup Address  :', JSON.stringify(ext['Pickup Address']));
			console.log('  Drop-off Address:', JSON.stringify(ext['Drop-off Address']));
			console.log('  Driver Name     :', JSON.stringify(ext['Driver Name']));
		}

		const sheet = runData['JOB DETAILS ENTRY']?.[0]?.data?.main?.[0]?.[0]?.json;
		if (sheet) {
			console.log('Sheet write payload:');
			for (const k of Object.keys(sheet)) console.log(`  ${k.padEnd(22)}: ${JSON.stringify(sheet[k]).slice(0, 100)}`);
			console.log('Driver in payload?', Object.keys(sheet).includes('Driver') ? 'YES (regression!)' : 'NO ✓ (protected)');
		}
	} finally {
		// Restore — ALWAYS
		if (originalSnapshot && !restored) {
			try {
				console.log();
				console.log('Restoring production workflow from snapshot…');
				await api('PUT', `/workflows/${WORKFLOW_ID}`, buildPutPayload(originalSnapshot));
				restored = true;
				console.log('Restored OK.');
			} catch (e) {
				console.error('!!! RESTORE FAILED:', e.message);
				console.error('!!! Production workflow is in a patched state. Manual restore:');
				console.error('!!!   PUT /api/v1/workflows/' + WORKFLOW_ID + ' with body from', backupPath);
			}
		}
	}
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
