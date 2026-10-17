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
 * The injected webhook is not an open endpoint:
 *  - it requires the n8n Header Auth credential N8N_REPLAY_CREDENTIAL_ID,
 *    and the script presents its value (N8N_REPLAY_SECRET) in the
 *    x-replay-secret header;
 *  - its path is a random UUID, new for every run;
 *  - it answers at once with no workflow output (responseMode
 *    onReceived), so the reply never carries load data.
 * It refuses to inject while the workflow has unpublished edits: its PUT
 * would publish them.
 *
 * Safety:
 *  - Backup of the workflow as the restore sends it, written BEFORE
 *    injection to N8N_BACKUP_DIR (default ~/LogisX-replica/n8n-backups),
 *    mode 600. It holds node parameters, so it never goes in the repo.
 *  - Restore is attempted in a finally block (even on error)
 *  - Neither PUT sends staticData, so the Gmail trigger's poll state is
 *    never rolled back to the snapshot
 *  - If restore fails, you can manually re-PUT the backup with:
 *      curl -X PUT -H "X-N8N-API-KEY: $KEY" -H "Content-Type: application/json" \
 *        --data @<backup file> \
 *        "$N8N_BASE_URL/api/v1/workflows/$N8N_WORKFLOW_ID"
 *
 * Setup, once, in the n8n UI (n8n Cloud doesn't show an API-created
 * credential to the workflow owner): a Header Auth credential named
 * "LogisX replay", header name x-replay-secret, value a long random string.
 * N8N_REPLAY_CREDENTIAL_ID is its id (/home/credentials/<id>), and
 * N8N_REPLAY_SECRET the same value.
 *
 * Usage: N8N_BASE_URL=... N8N_WORKFLOW_ID=... N8N_GMAIL_CREDENTIAL_ID=... \
 *        N8N_REPLAY_CREDENTIAL_ID=... N8N_REPLAY_SECRET=... N8N_API_KEY=... \
 *          node scripts/replay-via-webhook-injection.js <messageId>
 *  No defaults: without N8N_BASE_URL, N8N_WORKFLOW_ID, N8N_GMAIL_CREDENTIAL_ID (the
 *  n8n Gmail credential the injected Gmail node uses), N8N_REPLAY_CREDENTIAL_ID and
 *  N8N_REPLAY_SECRET (the credential the injected webhook requires, and its value)
 *  or the Gmail message ID it exits 2, before any network call.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { requireN8nSettings, requireN8nGmailCredential, requireN8nReplayAuth } = require('./lib/n8n-settings');

const INJECTED_NAMES = ['Replay Webhook', 'Replay Get Email'];
const REPLAY_HEADER = 'x-replay-secret';
const REPLAY_CREDENTIAL_NAME = 'LogisX replay';
const POLL_MS = 10000;

// A fresh path for every run: 122 random bits, so it can't be guessed while
// the node is live.
function newWebhookPath() {
	return crypto.randomUUID();
}

// The PUT body: never staticData, which holds the Gmail trigger's poll state.
function buildPutPayload(wf) {
	const payload = { name: wf.name, nodes: wf.nodes, connections: wf.connections };
	if (wf.settings) {
		const allowed = ['saveExecutionProgress','saveManualExecutions','saveDataErrorExecution','saveDataSuccessExecution','executionTimeout','errorWorkflow','timezone','executionOrder'];
		const clean = {};
		for (const k of allowed) if (wf.settings[k] !== undefined) clean[k] = wf.settings[k];
		payload.settings = clean;
	}
	return payload;
}

// True when the saved draft differs from the published version: a PUT
// publishes the draft, so injecting would publish those edits too.
function hasUnpublishedEdits(wf) {
	const pub = wf.activeVersion;
	if (!pub || !Array.isArray(pub.nodes)) return false;
	return JSON.stringify(pub.nodes) !== JSON.stringify(wf.nodes) || JSON.stringify(pub.connections) !== JSON.stringify(wf.connections);
}

function buildReplayNodes({ emailInput, messageId, gmailCredential, replayCredentialId, webhookPath }) {
	const replayWebhook = {
		id: crypto.randomUUID(),
		name: 'Replay Webhook',
		type: 'n8n-nodes-base.webhook',
		typeVersion: 2,
		position: [emailInput.position[0] - 448, emailInput.position[1] + 200],
		parameters: { httpMethod: 'POST', path: webhookPath, authentication: 'headerAuth', responseMode: 'onReceived', options: {} },
		credentials: { httpHeaderAuth: { id: replayCredentialId, name: REPLAY_CREDENTIAL_NAME } },
		webhookId: crypto.randomUUID(),
	};
	const replayGet = {
		id: crypto.randomUUID(),
		name: 'Replay Get Email',
		type: 'n8n-nodes-base.gmail',
		typeVersion: 2.1,
		position: [emailInput.position[0] - 224, emailInput.position[1] + 200],
		parameters: { operation: 'get', messageId, simple: false, options: { downloadAttachments: true } },
		credentials: { gmailOAuth2: gmailCredential },
	};
	return [replayWebhook, replayGet];
}

// The request that fires the injected webhook: the credential's header, no body data.
function replayRequest(secret) {
	return { method: 'POST', headers: { 'Content-Type': 'application/json', [REPLAY_HEADER]: secret }, body: '{}' };
}

function backupDir(env = process.env) {
	const named = String(env.N8N_BACKUP_DIR ?? '').trim();
	return named || path.join(os.homedir(), 'LogisX-replica', 'n8n-backups');
}

async function main() {
	const { base: N8N_BASE, workflowId: WORKFLOW_ID } = requireN8nSettings('replay-via-webhook-injection.js');
	const GMAIL_CREDENTIAL_ID = requireN8nGmailCredential('replay-via-webhook-injection.js');
	const { credentialId: REPLAY_CREDENTIAL_ID, secret: REPLAY_SECRET } = requireN8nReplayAuth('replay-via-webhook-injection.js');
	const API_KEY = process.env.N8N_API_KEY;
	if (!API_KEY) { console.error('N8N_API_KEY env var required'); process.exit(1); }

	const TARGET_MSG = (process.argv[2] || '').trim();
	if (!TARGET_MSG) {
		console.error('replay-via-webhook-injection.js: name the Gmail message to replay. Usage: ... node scripts/replay-via-webhook-injection.js <messageId>. There is no default.');
		process.exit(2);
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

	const webhookPath = newWebhookPath();
	let restored = false;
	let originalSnapshot = null;
	let backupPath = null;

	try {
		console.log('Fetching production workflow…');
		const wf = await api('GET', `/workflows/${WORKFLOW_ID}`);

		// Make sure nothing left over from a prior crashed run
		if (wf.nodes.some(n => INJECTED_NAMES.includes(n.name))) {
			throw new Error('Replay nodes already exist — refusing to inject again. Inspect workflow manually.');
		}
		if (hasUnpublishedEdits(wf)) {
			throw new Error('The workflow has unpublished edits; injecting would publish them. Publish or discard them in n8n first.');
		}

		const emailInput = wf.nodes.find(n => n.name === 'Email Input');
		if (!emailInput) throw new Error('Email Input node missing — refusing to inject.');

		originalSnapshot = JSON.parse(JSON.stringify(wf));
		const dir = backupDir();
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		backupPath = path.join(dir, `wf-backup-${Date.now()}.json`);
		fs.writeFileSync(backupPath, JSON.stringify(buildPutPayload(originalSnapshot), null, 2), { mode: 0o600 });
		console.log('Backup written:', backupPath);

		// The credential's label as the workflow's own Gmail nodes carry it; n8n
		// resolves a node's credential by id, so the id stands in when none does.
		const sameCredential = wf.nodes.find(n => n.credentials?.gmailOAuth2?.id === GMAIL_CREDENTIAL_ID);
		const gmailCredentialName = sameCredential?.credentials.gmailOAuth2.name || GMAIL_CREDENTIAL_ID;

		const [replayWebhook, replayGet] = buildReplayNodes({
			emailInput,
			messageId: TARGET_MSG,
			gmailCredential: { id: GMAIL_CREDENTIAL_ID, name: gmailCredentialName },
			replayCredentialId: REPLAY_CREDENTIAL_ID,
			webhookPath,
		});

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

		console.log('Firing replay webhook…');
		const res = await fetch(`${N8N_BASE}/webhook/${webhookPath}`, replayRequest(REPLAY_SECRET));
		console.log('Webhook status:', res.status);
		if (!res.ok) throw new Error(`The replay webhook answered ${res.status}; check that N8N_REPLAY_SECRET matches the credential.`);

		console.log('Polling for new execution (up to ~3 min)…');
		let exec = null;
		for (let i = 0; i < 18 && !exec; i++) {
			const list = await api('GET', `/executions?workflowId=${WORKFLOW_ID}&limit=5&includeData=false`);
			const cand = list.data?.[0];
			if (cand && Number(cand.id) > Number(lastId)) { exec = cand; break; }
			process.stdout.write('.');
			await sleep(POLL_MS);
		}
		console.log('');

		if (!exec) throw new Error('No new execution detected.');
		console.log('New exec:', exec.id, '| status:', exec.status, '| started:', exec.startedAt);

		// Wait for completion
		for (let i = 0; i < 30 && exec.status === 'running'; i++) {
			await sleep(POLL_MS);
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
}

if (require.main === module) main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });

module.exports = { INJECTED_NAMES, REPLAY_HEADER, newWebhookPath, buildPutPayload, hasUnpublishedEdits, buildReplayNodes, replayRequest, backupDir };
