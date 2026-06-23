/**
 * Sets up an error-alert workflow for "Dispatch v2 (Fixed)" so a silent
 * regression like 2026-06-22's (n8n executions errored for hours before
 * anyone noticed) can't happen again.
 *
 * What this does:
 *  1. Creates (or detects existing) workflow "Dispatch v2 Error Alert":
 *       Error Trigger -> Gmail Send (to ALERT_RECIPIENT)
 *     Reuses the Gmail OAuth credential that "Dispatch v2 (Fixed)" already
 *     uses (id `oymS9U543xCU6JOB`). Email body contains workflow name,
 *     failing node, error message, and a clickable link to the n8n exec.
 *  2. Activates the alert workflow.
 *  3. PATCHes "Dispatch v2 (Fixed)"'s `settings.errorWorkflow` to point at it.
 *
 * Idempotent: re-running detects the alert workflow by name, re-activates if
 * needed, and only PATCHes the main workflow if the errorWorkflow link is
 * missing/stale. No duplicate workflows are created.
 *
 * Run:
 *   N8N_API_KEY=... node scripts/setup-n8n-error-alert.js
 *
 * Override the recipient (default arvin.edubas15@gmail.com):
 *   N8N_API_KEY=... ALERT_RECIPIENT=ops@example.com node scripts/setup-n8n-error-alert.js
 */

const crypto = require('crypto');

const N8N_BASE = process.env.N8N_BASE_URL || 'https://sandhub.app.n8n.cloud';
const MAIN_WORKFLOW_ID = process.env.N8N_WORKFLOW_ID || 'ydFgTSFpKTyyZbXW';
const API_KEY = process.env.N8N_API_KEY;
if (!API_KEY) { console.error('N8N_API_KEY env var required'); process.exit(1); }

const ALERT_WORKFLOW_NAME = 'Dispatch v2 Error Alert';
const ALERT_RECIPIENT = process.env.ALERT_RECIPIENT || 'arvin.edubas15@gmail.com';
const GMAIL_CRED = { gmailOAuth2: { id: 'oymS9U543xCU6JOB', name: 'Gmail account 7' } };

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

function buildAlertWorkflow() {
	const subject =
		'=🚨 n8n error: {{ $json.workflow.name }} at "{{ $json.execution.lastNodeExecuted || \'unknown node\' }}"';
	const body = [
		'=A node failed in n8n.',
		'',
		'Workflow : {{ $json.workflow.name }}',
		'Node     : {{ $json.execution.lastNodeExecuted || \'unknown\' }}',
		'Error    : {{ ($json.execution.error && $json.execution.error.message) || \'(no message)\' }}',
		'Mode     : {{ $json.execution.mode }}',
		'Started  : {{ $json.execution.startedAt }}',
		'Exec ID  : {{ $json.execution.id }}',
		'',
		'Open exec: {{ $json.executionUrl || $json.execution.url }}',
		'',
		'-- automated alert from Dispatch v2 Error Alert workflow',
	].join('\n');

	return {
		name: ALERT_WORKFLOW_NAME,
		nodes: [
			{
				parameters: {},
				type: 'n8n-nodes-base.errorTrigger',
				typeVersion: 1,
				position: [200, 200],
				id: crypto.randomUUID(),
				name: 'Error Trigger',
			},
			{
				parameters: {
					sendTo: ALERT_RECIPIENT,
					subject,
					emailType: 'text',
					message: body,
					options: {
						appendAttribution: false,
					},
				},
				type: 'n8n-nodes-base.gmail',
				typeVersion: 2.1,
				position: [440, 200],
				id: crypto.randomUUID(),
				name: 'Send Alert Email',
				credentials: GMAIL_CRED,
			},
		],
		connections: {
			'Error Trigger': { main: [[{ node: 'Send Alert Email', type: 'main', index: 0 }]] },
		},
		settings: { executionOrder: 'v1' },
	};
}

(async () => {
	console.log('Looking for existing alert workflow…');
	const list = await api('GET', '/workflows?limit=200');
	const existing = (list.data || list).find(w => w.name === ALERT_WORKFLOW_NAME);

	let alertId;
	if (existing) {
		alertId = existing.id;
		console.log(`Found existing alert workflow: ${alertId} (active=${existing.active})`);
	} else {
		console.log('Creating alert workflow…');
		const created = await api('POST', '/workflows', buildAlertWorkflow());
		alertId = created.id;
		console.log(`Created alert workflow: ${alertId}`);
	}

	console.log('Activating alert workflow…');
	try {
		await api('POST', `/workflows/${alertId}/activate`);
		console.log('  active.');
	} catch (e) {
		// Already-active or trigger-not-poll-able workflows can throw a harmless error.
		console.log(`  (activate said: ${e.message.split('\n')[0]} — likely already active)`);
	}

	console.log('Reading main workflow to link errorWorkflow…');
	const main = await api('GET', `/workflows/${MAIN_WORKFLOW_ID}`);
	const currentLink = main.settings && main.settings.errorWorkflow;
	if (currentLink === alertId) {
		console.log('Main workflow already references this alert workflow. Nothing to do.');
	} else {
		main.settings = { ...(main.settings || {}), errorWorkflow: alertId };
		console.log(`Linking errorWorkflow → ${alertId} (was: ${currentLink || 'unset'})…`);
		await api('PUT', `/workflows/${MAIN_WORKFLOW_ID}`, buildPutPayload(main));
		console.log('  OK.');
	}

	console.log('\nDone.');
	console.log(`Future errors in "${main.name}" will email ${ALERT_RECIPIENT}.`);
	console.log(`Test it: trigger any node error in Dispatch v2 (e.g. revoke a credential temporarily).`);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
