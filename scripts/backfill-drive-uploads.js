/**
 * Backfills the rate-cons that "Dispatch v2 (Fixed)" processed between
 * 2026-06-12 and 2026-06-20 but never archived to Google Drive (root cause
 * documented in scripts/patch-restore-drive-upload.js).
 *
 * The first attempt (mark all unread and let the Gmail Trigger re-fire) did
 * not work: n8n's Gmail Trigger watermarks by internalDate, so re-flipping
 * old messages to unread does not surface them in subsequent polls.
 *
 * Strategy: temporarily inject a side branch into Dispatch v2 (Fixed) that
 *   1. Fetches each affected message via the Gmail node (downloadAttachments)
 *   2. Picks the PDF binary key (skips inline image attachments)
 *   3. Uploads to the Rate Confirmations folder with the canonical name
 *      "Subject: <original subject>", matching the pattern produced by the
 *      existing Google Drive nodes.
 * Then REVERT to the pre-injection workflow state.
 *
 * Why inject into the live workflow instead of a fresh one: n8n Cloud scopes
 * credentials to specific workflows (a fresh workflow gets "Node does not
 * have access to the credential"). Dispatch v2 already owns BOTH the Gmail
 * OAuth and Google Drive OAuth credentials, so injected nodes inherit them.
 *
 * The side branch is fully isolated from the existing graph:
 *   [Backfill Webhook] -> [Backfill Emit IDs] -> [Backfill Gmail Get]
 *     -> [Backfill Pick PDF] -> [Backfill Drive Upload]
 *
 * Safety:
 *   - Full pre-injection backup written to scripts/.wf-backup-<ts>.json
 *   - Single PUT to inject, single PUT to revert
 *   - On any failure between inject and revert, we still PUT the backup
 *     back. If even revert fails, the backup file is the manual fallback.
 *
 * Run: N8N_API_KEY=... node scripts/backfill-drive-uploads.js
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const N8N_BASE = process.env.N8N_BASE_URL || 'https://sandhub.app.n8n.cloud';
const WORKFLOW_ID = process.env.N8N_WORKFLOW_ID || 'ydFgTSFpKTyyZbXW';
const API_KEY = process.env.N8N_API_KEY;
if (!API_KEY) { console.error('N8N_API_KEY env var required'); process.exit(1); }

const GMAIL_CRED = { id: 'oymS9U543xCU6JOB', name: 'Gmail account 7' };
const DRIVE_CRED = { id: 'LWs9Q4WpDRQzSqQp', name: 'Google Drive account' };
const RATECON_FOLDER_ID = '1VAMgB8xQe50xs-PuX-WW3yL6Hom2xetL';

const MESSAGES = [
	{ id: '19ecc46d75f88a22', subj: 'Booked Load #: 557021462' },
	{ id: '19ecce4b5c4fef3c', subj: 'Booked Load #: 557118348' },
	{ id: '19ed1f1f8e62a861', subj: 'Booked Load #: 556354570' },
	{ id: '19ed5ad81597751a', subj: 'Booked Load #: 557479091' },
	{ id: '19edb50cd3b80b16', subj: 'Bison Transport Order #7017039' },
	{ id: '19ee1ace8a735df1', subj: 'Navisphere Carrier Load Confirmation - Load 557972072' },
	{ id: '19ee1ac9d807ea65', subj: 'Booked Load #: 557972072' },
	{ id: '19ee1afe4c3cd9da', subj: 'Navisphere Carrier Load Confirmation - Load 556782314' },
	{ id: '19ee1af6d0cd98ef', subj: 'Booked Load #: 556782314' },
];

const TEMP_NODES = ['Backfill Webhook', 'Backfill Emit IDs', 'Backfill Gmail Get', 'Backfill Pick PDF', 'Backfill Drive Upload'];

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

function injectNodes(wf, webhookPath) {
	const ids = MESSAGES.map(m => m.id);
	const offX = 100, offY = 2600, dx = 220;
	const pickPdfCode = `
const out = [];
for (const it of $input.all()) {
  const bin = it.binary || {};
  const j = it.json || {};
  const pdfKey = Object.keys(bin).find(k => (bin[k] && bin[k].mimeType === 'application/pdf'));
  if (!pdfKey) continue;
  const subjectRaw = (j.headers && j.headers.subject) || j.subject || '';
  const cleanSubject = String(subjectRaw).replace(/^Subject:\\s*/i, '').trim();
  out.push({
    json: { attachments: pdfKey, driveName: 'Subject: ' + cleanSubject },
    binary: bin,
  });
}
return out;
`.trim();

	const newNodes = [
		{
			parameters: { httpMethod: 'POST', path: webhookPath, responseMode: 'onReceived', options: {} },
			type: 'n8n-nodes-base.webhook', typeVersion: 2,
			position: [offX, offY], id: crypto.randomUUID(), name: TEMP_NODES[0],
		},
		{
			parameters: { jsCode: `return ${JSON.stringify(ids)}.map(id => ({ json: { messageId: id } }));` },
			type: 'n8n-nodes-base.code', typeVersion: 2,
			position: [offX + dx, offY], id: crypto.randomUUID(), name: TEMP_NODES[1],
		},
		{
			parameters: {
				resource: 'message',
				operation: 'get',
				messageId: '={{ $json.messageId }}',
				simple: false,
				options: { downloadAttachments: true },
			},
			type: 'n8n-nodes-base.gmail', typeVersion: 2.1,
			position: [offX + dx * 2, offY], id: crypto.randomUUID(), name: TEMP_NODES[2],
			credentials: { gmailOAuth2: GMAIL_CRED }, continueOnFail: true,
		},
		{
			parameters: { jsCode: pickPdfCode },
			type: 'n8n-nodes-base.code', typeVersion: 2,
			position: [offX + dx * 3, offY], id: crypto.randomUUID(), name: TEMP_NODES[3],
		},
		{
			parameters: {
				inputDataFieldName: '={{ $json.attachments }}',
				name: '={{ $json.driveName }}',
				driveId: { __rl: true, value: 'My Drive', mode: 'list', cachedResultName: 'My Drive', cachedResultUrl: 'https://drive.google.com/drive/my-drive' },
				folderId: { __rl: true, value: RATECON_FOLDER_ID, mode: 'list', cachedResultName: 'Rate Confirmations', cachedResultUrl: `https://drive.google.com/drive/folders/${RATECON_FOLDER_ID}` },
				options: {},
			},
			type: 'n8n-nodes-base.googleDrive', typeVersion: 3,
			position: [offX + dx * 4, offY], id: crypto.randomUUID(), name: TEMP_NODES[4],
			credentials: { googleDriveOAuth2Api: DRIVE_CRED }, continueOnFail: true,
		},
	];
	const out = JSON.parse(JSON.stringify(wf));
	out.nodes = [...out.nodes, ...newNodes];
	out.connections = { ...out.connections };
	out.connections[TEMP_NODES[0]] = { main: [[{ node: TEMP_NODES[1], type: 'main', index: 0 }]] };
	out.connections[TEMP_NODES[1]] = { main: [[{ node: TEMP_NODES[2], type: 'main', index: 0 }]] };
	out.connections[TEMP_NODES[2]] = { main: [[{ node: TEMP_NODES[3], type: 'main', index: 0 }]] };
	out.connections[TEMP_NODES[3]] = { main: [[{ node: TEMP_NODES[4], type: 'main', index: 0 }]] };
	return out;
}

async function trigger(webhookPath) {
	const url = `${N8N_BASE}/webhook/${webhookPath}`;
	console.log('  POST', url);
	const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
	const text = await res.text();
	if (!res.ok) throw new Error(`webhook trigger → ${res.status}\n${text.slice(0, 500)}`);
	console.log('  response:', text.slice(0, 200));
}

async function revert(backupPath) {
	console.log('  Restoring pre-injection workflow from', backupPath);
	const original = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
	await api('PUT', `/workflows/${WORKFLOW_ID}`, buildPutPayload(original));
	console.log('  REVERT OK — Dispatch v2 (Fixed) is back to its pre-injection state.');
}

(async () => {
	const webhookPath = `bf-${crypto.randomUUID().slice(0, 8)}`;

	console.log(`Will fetch ${MESSAGES.length} Gmail messages and upload their PDFs to Drive:`);
	MESSAGES.forEach((m, i) => console.log(`  ${i+1}. ${m.id}  ${m.subj}`));

	console.log('\n[1/6] Fetching current workflow…');
	const original = await api('GET', `/workflows/${WORKFLOW_ID}`);
	const backupPath = path.join(__dirname, `.wf-backup-${Date.now()}-pre-backfill.json`);
	fs.writeFileSync(backupPath, JSON.stringify(original, null, 2));
	console.log('  backup saved to', backupPath);

	for (const n of TEMP_NODES) {
		if (original.nodes.find(x => x.name === n)) {
			throw new Error(`Workflow already contains temp node '${n}' from a prior aborted run — clean it up in the n8n UI before retrying.`);
		}
	}

	console.log('[2/6] Injecting backfill side branch (5 nodes)…');
	const modified = injectNodes(original, webhookPath);
	await api('PUT', `/workflows/${WORKFLOW_ID}`, buildPutPayload(modified));

	let backfillStarted = false;
	try {
		console.log('[3/6] Waiting 6 s for webhook registration…');
		await new Promise(r => setTimeout(r, 6000));

		console.log('[4/6] Triggering webhook…');
		await trigger(webhookPath);
		backfillStarted = true;

		console.log('[5/6] Waiting 30 s for fetch+upload to finish…');
		await new Promise(r => setTimeout(r, 30000));
		const ex = await api('GET', `/executions?workflowId=${WORKFLOW_ID}&includeData=true&limit=6`);
		const list = ex.data || ex;
		const ours = list.find(e => {
			const rd = e.data && e.data.resultData;
			const rn = rd && rd.runData;
			return rn && rn[TEMP_NODES[0]];
		});
		if (!ours) {
			console.warn('  Could not find backfill execution in recent list. Check the n8n UI.');
		} else {
			console.log('  exec', ours.id, '| status=' + ours.status, '| stopped=' + ours.stoppedAt);
			const rd = ours.data && ours.data.resultData || {};
			const rn = rd.runData || {};
			for (const nodeName of [TEMP_NODES[2], TEMP_NODES[3], TEMP_NODES[4]]) {
				const runs = rn[nodeName] || [];
				const totalItems = runs.reduce((sum, r) => sum + ((r.data && r.data.main && r.data.main[0]) ? r.data.main[0].length : 0), 0);
				const errs = runs.flatMap(r => r.error ? [r.error.message] : []);
				console.log('   ', nodeName, '| runs=' + runs.length, '| items=' + totalItems + (errs.length ? ' | ERRS=' + errs.join(' | ') : ''));
			}
			// Show uploaded file names
			const driveRuns = rn[TEMP_NODES[4]] || [];
			const uploaded = [];
			for (const r of driveRuns) {
				const items = (r.data && r.data.main && r.data.main[0]) || [];
				for (const it of items) {
					const j = it.json || {};
					if (j.id && j.name) uploaded.push({ id: j.id, name: j.name });
				}
			}
			console.log(`   Files uploaded: ${uploaded.length}`);
			uploaded.forEach((f, i) => console.log(`     ${i+1}. ${f.name}  (driveId=${f.id})`));
		}
	} catch (e) {
		console.error('\n  >>> Trigger/inspection failed:', e.message);
		console.error('  >>> Reverting anyway so Dispatch v2 returns to clean state.');
	}

	console.log('\n[6/6] Reverting injection…');
	try {
		await revert(backupPath);
	} catch (e) {
		console.error('  >>> REVERT FAILED:', e.message);
		console.error('  >>> Manually restore the workflow from', backupPath, 'via the n8n UI import.');
		process.exit(2);
	}

	if (backfillStarted) {
		console.log('\nDone.');
		console.log('Verify: node scripts/diag-ratecon-folder.js 7017039');
	}
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
