/**
 * Patches the live "Dispatch v2 (Fixed)" n8n workflow so that when a Bison-
 * style email arrives WITHOUT a PDF attachment, n8n searches the same
 * Gmail thread for an earlier message that DID include a PDF (typically
 * the rate confirmation), and processes THAT through the existing
 * LlamaParse → Information Extractor → Sheet pipeline.
 *
 * Flow change:
 *
 *   BEFORE
 *     Has Attachments?[false] -> Build Email Context -> Extract from Email Body
 *
 *   AFTER
 *     Has Attachments?[false] -> Get Thread Messages -> Pick Thread PDF
 *                                -> Thread Has PDF?[true]  -> Download Thread PDF Msg
 *                                                            -> Prep Thread PDF Item
 *                                                            -> (Google Drive, LlamaParse Upload) [parallel]
 *                                -> Thread Has PDF?[false] -> Build Email Context (existing fallback)
 *
 * Idempotent: detects existing patch via node name and bails out.
 * Backs up current workflow to scripts/.wf-backup-<timestamp>.json before PUT.
 *
 * Run: N8N_API_KEY=... node scripts/patch-thread-pdf-lookup.js
 */

const fs = require('fs');
const path = require('path');

const N8N_BASE = process.env.N8N_BASE_URL || 'https://sandhub.app.n8n.cloud';
const WORKFLOW_ID = process.env.N8N_WORKFLOW_ID || 'ydFgTSFpKTyyZbXW';
const API_KEY = process.env.N8N_API_KEY;
if (!API_KEY) { console.error('N8N_API_KEY env var required'); process.exit(1); }

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

function uuid() {
	return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
		const r = Math.random() * 16 | 0;
		return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
	});
}

const PICK_PDF_CODE = `// Scan all messages in the thread for a PDF attachment. Skip the trigger
// email (it's the one with no PDF that brought us here). Prefer the OLDEST
// PDF in the thread (rate cons typically arrive before the tracking request).
const thread = $input.first().json;
const messages = Array.isArray(thread.messages) ? thread.messages : [];
const currentMsgId = $('Email Input').first().json.id;

function flattenParts(payload) {
  const out = [];
  function walk(p) {
    if (!p) return;
    out.push(p);
    if (Array.isArray(p.parts)) p.parts.forEach(walk);
  }
  walk(payload);
  return out;
}

const candidates = [];
for (const msg of messages) {
  if (!msg || msg.id === currentMsgId) continue;
  const parts = flattenParts(msg.payload);
  const pdfPart = parts.find(p => p && p.mimeType === 'application/pdf' && p.body && p.body.attachmentId);
  if (!pdfPart) continue;
  candidates.push({
    pdfMessageId: msg.id,
    pdfAttachmentId: pdfPart.body.attachmentId,
    pdfFilename: pdfPart.filename || 'attachment.pdf',
    internalDate: Number(msg.internalDate || 0),
  });
}

if (candidates.length === 0) return [{ json: { found: false } }];

candidates.sort((a, b) => a.internalDate - b.internalDate);
const pick = candidates[0];
return [{ json: { found: true, pdfMessageId: pick.pdfMessageId, pdfAttachmentId: pick.pdfAttachmentId, pdfFilename: pick.pdfFilename, fromTrace: '[Thread-Sourced Rate Con] ' + pick.pdfFilename } }];
`;

const PREP_THREAD_PDF_CODE = `// The previous Gmail node downloaded the thread message with attachments.
// Reshape the item so it matches what "Merge Attachment + Email" produces,
// so it can flow directly into Google Drive + LlamaParse Upload.
const dl = $input.first();
const binaries = dl.binary || {};
const pdfKey = Object.keys(binaries).find(k => binaries[k] && binaries[k].mimeType === 'application/pdf');
if (!pdfKey) throw new Error('Thread PDF download produced no PDF binary');

const email = $('Email Input').first().json;

return [{
  json: {
    ...email,
    attachments: pdfKey,
    _threadSourcedPdf: true,
  },
  binary: { [pdfKey]: binaries[pdfKey] },
}];
`;

(async () => {
	console.log('Fetching workflow…');
	const wf = await api('GET', `/workflows/${WORKFLOW_ID}`);

	if (wf.nodes.find(n => n.name === 'Get Thread Messages')) {
		console.log('Thread-lookup nodes already present — nothing to do.');
		return;
	}

	// Backup
	const backupPath = path.join(__dirname, `.wf-backup-${Date.now()}.json`);
	fs.writeFileSync(backupPath, JSON.stringify(wf, null, 2));
	console.log('Backup saved to', backupPath);

	// Reference positions to lay out the new branch on the canvas
	const hasAttachments = wf.nodes.find(n => n.name === 'Has Attachments?');
	const buildCtx = wf.nodes.find(n => n.name === 'Build Email Context');
	const googleDrive = wf.nodes.find(n => n.name === 'Google Drive');
	const llamaUpload = wf.nodes.find(n => n.name === 'LlamaParse Upload');
	if (!hasAttachments || !buildCtx || !googleDrive || !llamaUpload) {
		throw new Error('Required existing nodes not found — refusing to patch.');
	}

	const baseX = hasAttachments.position[0] + 224;
	const branchY = hasAttachments.position[1] + 350; // below the FALSE branch

	const getThread = {
		parameters: {
			resource: 'thread',
			operation: 'get',
			threadId: "={{ $('Email Input').item.json.threadId }}",
			returnAll: true,
			simple: false,
			options: {},
		},
		type: 'n8n-nodes-base.gmail',
		typeVersion: 2.1,
		position: [baseX, branchY],
		id: uuid(),
		name: 'Get Thread Messages',
		credentials: GMAIL_CRED,
	};

	const pickPdf = {
		parameters: { jsCode: PICK_PDF_CODE },
		type: 'n8n-nodes-base.code',
		typeVersion: 2,
		position: [baseX + 224, branchY],
		id: uuid(),
		name: 'Pick Thread PDF',
	};

	const hasPdf = {
		parameters: {
			conditions: {
				options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
				conditions: [{
					id: uuid(),
					leftValue: '={{ $json.found }}',
					rightValue: true,
					operator: { type: 'boolean', operation: 'true', singleValue: true },
				}],
				combinator: 'and',
			},
			options: {},
		},
		type: 'n8n-nodes-base.if',
		typeVersion: 2.2,
		position: [baseX + 448, branchY],
		id: uuid(),
		name: 'Thread Has PDF?',
	};

	const dlThreadMsg = {
		parameters: {
			operation: 'get',
			messageId: '={{ $json.pdfMessageId }}',
			simple: false,
			options: { downloadAttachments: true },
		},
		type: 'n8n-nodes-base.gmail',
		typeVersion: 2.1,
		position: [baseX + 672, branchY],
		id: uuid(),
		name: 'Download Thread PDF Msg',
		credentials: GMAIL_CRED,
	};

	const prepItem = {
		parameters: { jsCode: PREP_THREAD_PDF_CODE },
		type: 'n8n-nodes-base.code',
		typeVersion: 2,
		position: [baseX + 896, branchY],
		id: uuid(),
		name: 'Prep Thread PDF Item',
	};

	// Insert new nodes
	wf.nodes.push(getThread, pickPdf, hasPdf, dlThreadMsg, prepItem);

	// Rewire connections
	// Remove the existing Has Attachments?[1] -> Build Email Context, replace with Has Attachments?[1] -> Get Thread Messages
	wf.connections['Has Attachments?'] = wf.connections['Has Attachments?'] || { main: [[], []] };
	while (wf.connections['Has Attachments?'].main.length < 2) wf.connections['Has Attachments?'].main.push([]);
	wf.connections['Has Attachments?'].main[1] = [{ node: 'Get Thread Messages', type: 'main', index: 0 }];

	wf.connections['Get Thread Messages'] = { main: [[{ node: 'Pick Thread PDF', type: 'main', index: 0 }]] };
	wf.connections['Pick Thread PDF']    = { main: [[{ node: 'Thread Has PDF?', type: 'main', index: 0 }]] };
	wf.connections['Thread Has PDF?']    = {
		main: [
			[{ node: 'Download Thread PDF Msg', type: 'main', index: 0 }],
			[{ node: 'Build Email Context',     type: 'main', index: 0 }],  // FALSE = fall back to existing email-body path
		],
	};
	wf.connections['Download Thread PDF Msg'] = { main: [[{ node: 'Prep Thread PDF Item', type: 'main', index: 0 }]] };
	wf.connections['Prep Thread PDF Item']    = {
		main: [[
			{ node: 'Google Drive',     type: 'main', index: 0 },
			{ node: 'LlamaParse Upload', type: 'main', index: 0 },
		]],
	};

	// Build PUT payload with strict public-API allowlist
	const payload = {
		name: wf.name,
		nodes: wf.nodes,
		connections: wf.connections,
	};
	if (wf.staticData !== undefined) payload.staticData = wf.staticData;
	if (wf.settings) {
		const allowed = ['saveExecutionProgress','saveManualExecutions','saveDataErrorExecution','saveDataSuccessExecution','executionTimeout','errorWorkflow','timezone','executionOrder'];
		const clean = {};
		for (const k of allowed) if (wf.settings[k] !== undefined) clean[k] = wf.settings[k];
		payload.settings = clean;
	}

	console.log('Pushing patched workflow…');
	await api('PUT', `/workflows/${WORKFLOW_ID}`, payload);
	console.log('OK — thread-PDF lookup branch live. New nodes:');
	console.log('  Get Thread Messages → Pick Thread PDF → Thread Has PDF?');
	console.log('  (TRUE)  → Download Thread PDF Msg → Prep Thread PDF Item → Google Drive + LlamaParse Upload');
	console.log('  (FALSE) → Build Email Context (existing fallback)');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
