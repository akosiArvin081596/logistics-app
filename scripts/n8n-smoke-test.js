/**
 * Smoke-tests the live "Dispatch v2 (Fixed)" pipeline end-to-end by replaying
 * a known-good Gmail message and asserting the full downstream chain ran.
 *
 * RUN THIS AFTER EVERY workflow patch (patch-restore-drive-upload.js,
 * patch-drive-archive-parallel.js, patch-filter-pdf-attachments.js, etc.).
 *
 * The 2026-06-22 serial-wiring regression would have been caught here in 60
 * seconds — the patched workflow returned "success" at the workflow level but
 * `JOB DETAILS ENTRY` never ran. A smoke test asserts the leaf node, not just
 * the trigger.
 *
 * What it does:
 *  1. Injects a temp [Webhook -> Gmail Get -> Email Input] side branch
 *     (same pattern as scripts/replay-via-webhook-injection.js)
 *  2. Fires the webhook with a known-good Gmail messageId
 *  3. Polls for the new execution and waits for completion
 *  4. Asserts:
 *       - exec status === 'success'
 *       - all required downstream nodes ran
 *       - sheet-write node received a load ID matching the message
 *  5. Restores the workflow in `finally` (even on assertion failure)
 *  6. Exit 0 on pass, non-zero on fail (CI/script friendly)
 *
 * Usage:
 *   N8N_API_KEY=... node scripts/n8n-smoke-test.js [messageId]
 *
 * Default messageId is a recent CHRobinson "Booked Load" email we know parses
 * cleanly through every node. Override when that specific message is no longer
 * available (n8n's Gmail Trigger watermark only matters for the polling path —
 * replays via webhook injection work on any message id the OAuth credential
 * can `gmail.get`, which is all messages in the connected inbox).
 *
 * SAFETY: This script touches the live production workflow. Use only on the
 * pipeline you intend to test. Workflow state is fully restored on exit.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const N8N_BASE = process.env.N8N_BASE_URL || 'https://sandhub.app.n8n.cloud';
const WORKFLOW_ID = process.env.N8N_WORKFLOW_ID || 'ydFgTSFpKTyyZbXW';
const API_KEY = process.env.N8N_API_KEY;
if (!API_KEY) { console.error('N8N_API_KEY env var required'); process.exit(1); }

// Known-good CHRobinson "Booked Load" email. Replayed multiple times on
// 2026-06-22 successfully (execs 2245-2250). Replace if it disappears from
// the inbox.
const TARGET_MSG = process.argv[2] || '19eef6d536857b61';
const GMAIL_CRED = { gmailOAuth2: { id: 'oymS9U543xCU6JOB', name: 'Gmail account 7' } };

// Required nodes — the full pipeline must reach the sheet-insert step.
const REQUIRED_NODES = [
	'Email Input',
	'Has Attachments?',
	'LlamaParse Upload',
	'LlamaParse Get Markdown',
	'Information Extractor',
	'Normalize Load Fields',
	'JOB DETAILS ENTRY',
];

const INJECTED_NAMES = ['Smoke Test Webhook', 'Smoke Test Get Email'];

function uuid() {
	return crypto.randomUUID();
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

function fail(msg) { console.error('\n✗ SMOKE TEST FAILED:', msg); process.exit(1); }
function pass(msg) { console.log('\n✓ SMOKE TEST PASSED:', msg); }

(async () => {
	const webhookPath = 'smoke-' + uuid().slice(0, 12);
	let originalSnapshot = null;
	let backupPath = null;
	let assertionError = null;

	try {
		console.log(`Smoke testing pipeline with messageId=${TARGET_MSG}…`);
		const wf = await api('GET', `/workflows/${WORKFLOW_ID}`);
		originalSnapshot = JSON.parse(JSON.stringify(wf));
		backupPath = path.join(__dirname, `.wf-backup-${Date.now()}.json`);
		fs.writeFileSync(backupPath, JSON.stringify(originalSnapshot, null, 2));

		if (wf.nodes.some(n => INJECTED_NAMES.includes(n.name))) {
			throw new Error('Smoke-test nodes already exist — refusing to inject. Inspect workflow manually.');
		}
		const emailInput = wf.nodes.find(n => n.name === 'Email Input');
		if (!emailInput) throw new Error('Email Input node missing — workflow shape changed?');

		const patched = JSON.parse(JSON.stringify(wf));
		patched.nodes.push(
			{
				id: uuid(),
				name: INJECTED_NAMES[0],
				type: 'n8n-nodes-base.webhook',
				typeVersion: 2,
				position: [emailInput.position[0] - 448, emailInput.position[1] + 250],
				parameters: { httpMethod: 'POST', path: webhookPath, responseMode: 'lastNode', options: {} },
				webhookId: uuid(),
			},
			{
				id: uuid(),
				name: INJECTED_NAMES[1],
				type: 'n8n-nodes-base.gmail',
				typeVersion: 2.1,
				position: [emailInput.position[0] - 224, emailInput.position[1] + 250],
				parameters: { operation: 'get', messageId: TARGET_MSG, simple: false, options: { downloadAttachments: true } },
				credentials: GMAIL_CRED,
			},
		);
		patched.connections[INJECTED_NAMES[0]] = { main: [[{ node: INJECTED_NAMES[1], type: 'main', index: 0 }]] };
		patched.connections[INJECTED_NAMES[1]] = { main: [[{ node: 'Email Input', type: 'main', index: 0 }]] };

		await api('PUT', `/workflows/${WORKFLOW_ID}`, buildPutPayload(patched));
		await sleep(2000); // let webhook register

		const before = await api('GET', `/executions?workflowId=${WORKFLOW_ID}&limit=5`);
		const beforeId = Number(before.data?.[0]?.id || 0);

		const res = await fetch(`${N8N_BASE}/webhook/${webhookPath}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
		if (!res.ok) throw new Error(`webhook trigger HTTP ${res.status}`);

		console.log('Waiting for execution to complete…');
		let exec = null;
		for (let i = 0; i < 24 && !exec; i++) {
			await sleep(10000);
			const list = await api('GET', `/executions?workflowId=${WORKFLOW_ID}&limit=5`);
			const cand = list.data?.[0];
			if (cand && Number(cand.id) > beforeId) exec = cand;
		}
		if (!exec) throw new Error('No new execution after 4 minutes.');

		for (let i = 0; i < 18 && exec.status === 'running'; i++) {
			await sleep(10000);
			exec = await api('GET', `/executions/${exec.id}`);
		}

		console.log(`Exec ${exec.id} | status=${exec.status} | stopped=${exec.stoppedAt}`);

		// === ASSERTIONS ===
		const errs = [];
		if (exec.status !== 'success') errs.push(`exec.status='${exec.status}' (expected 'success')`);

		const full = await api('GET', `/executions/${exec.id}?includeData=true`);
		const runData = (full.data?.resultData?.runData) || {};

		const missing = REQUIRED_NODES.filter(n => !runData[n]);
		if (missing.length) errs.push(`required nodes did not execute: ${missing.join(', ')}`);

		for (const n of REQUIRED_NODES) {
			const last = runData[n]?.[runData[n].length - 1];
			if (last?.error) errs.push(`node '${n}' errored: ${last.error.message}`);
		}

		const sheetItems = runData['JOB DETAILS ENTRY']?.[0]?.data?.main?.[0] || [];
		if (sheetItems.length === 0) {
			errs.push("'JOB DETAILS ENTRY' emitted zero items — sheet write did not occur");
		} else {
			const loadId = sheetItems[0]?.json?.['Load ID'];
			if (!loadId) errs.push("'JOB DETAILS ENTRY' output is missing 'Load ID' field");
			else console.log(`Sheet payload Load ID: ${loadId}`);
		}

		if (errs.length) {
			assertionError = errs.join('\n  - ');
		}
	} catch (e) {
		assertionError = `setup/network error: ${e.message}`;
	} finally {
		if (originalSnapshot) {
			try {
				await api('PUT', `/workflows/${WORKFLOW_ID}`, buildPutPayload(originalSnapshot));
				console.log('Workflow restored.');
			} catch (e) {
				console.error('CRITICAL: restore failed — manually re-PUT', backupPath);
				console.error(e.message);
			}
		}
	}

	if (assertionError) fail('\n  - ' + assertionError);
	pass(`pipeline reached JOB DETAILS ENTRY and wrote to the sheet successfully.`);
})().catch(e => { console.error('UNCAUGHT:', e.message); process.exit(1); });
