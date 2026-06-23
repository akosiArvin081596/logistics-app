/**
 * Restores the Google Drive archival step that was lost in the 2026-05-28
 * LlamaParse refactor of the "Dispatch v2 (Fixed)" n8n workflow.
 *
 * Bug: in the refactor, branch 0 of `Has Attachments?` (the common path — email
 * arrives WITH a PDF attached) was rewired to go straight from
 * `Merge Attachment + Email` → `LlamaParse Upload`, with no Drive step.
 * Only branch 1 (no-attachments fallback, where the workflow has to dig the
 * PDF out of earlier messages in the thread) still calls Google Drive.
 *
 * Effect: every fresh broker rate-con (Bison, CHRobinson, Navisphere…)
 * landed in LlamaParse but was never archived. LogisX's "Draft Bison Invoice"
 * route can't find the PDF and returns 422.
 *
 * Fix: insert a clone of the existing Google Drive node — same folder
 * (Rate Confirmations, 1VAMgB8xQe50xs-PuX-WW3yL6Hom2xetL), same credentials,
 * same filename/inputDataField expressions — between
 * `Merge Attachment + Email` and `LlamaParse Upload`.
 * Renamed `Google Drive (Archive)` to avoid the existing node's name collision.
 *
 * Idempotent: re-running detects the patched node and skips.
 * Backs up the unmodified workflow to scripts/.wf-backup-<ts>.json before PUT.
 *
 * Run: N8N_API_KEY=... node scripts/patch-restore-drive-upload.js
 *
 * REQUIRED follow-up — smoke-test the live pipeline AFTER patching:
 *   N8N_API_KEY=... node scripts/n8n-smoke-test.js
 * Replays a known-good email through the live workflow and asserts the
 * sheet-write step ran. Would have caught the 2026-06-22 serial-wiring
 * regression (this script's original sin) in ~60 seconds.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const N8N_BASE = process.env.N8N_BASE_URL || 'https://sandhub.app.n8n.cloud';
const WORKFLOW_ID = process.env.N8N_WORKFLOW_ID || 'ydFgTSFpKTyyZbXW';
const API_KEY = process.env.N8N_API_KEY;
if (!API_KEY) { console.error('N8N_API_KEY env var required'); process.exit(1); }

const NEW_NODE_NAME = 'Google Drive (Archive)';
const SOURCE_NODE = 'Merge Attachment + Email';
const TARGET_NODE = 'LlamaParse Upload';
const EXISTING_DRIVE_NODE = 'Google Drive';

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

	if (wf.nodes.find(n => n.name === NEW_NODE_NAME)) {
		console.log(`Already patched (${NEW_NODE_NAME} present). Nothing to do.`);
		return;
	}

	const existingDrive = wf.nodes.find(n => n.name === EXISTING_DRIVE_NODE);
	if (!existingDrive) throw new Error(`Source template node '${EXISTING_DRIVE_NODE}' not found — cannot clone its config`);

	const source = wf.nodes.find(n => n.name === SOURCE_NODE);
	const target = wf.nodes.find(n => n.name === TARGET_NODE);
	if (!source) throw new Error(`Source node '${SOURCE_NODE}' not found`);
	if (!target) throw new Error(`Target node '${TARGET_NODE}' not found`);

	const conns = wf.connections[SOURCE_NODE];
	if (!conns || !conns.main || !conns.main[0] || !conns.main[0].some(e => e.node === TARGET_NODE)) {
		throw new Error(`Expected connection ${SOURCE_NODE} → ${TARGET_NODE} not found — workflow shape changed`);
	}

	const newNode = {
		parameters: JSON.parse(JSON.stringify(existingDrive.parameters)),
		type: existingDrive.type,
		typeVersion: existingDrive.typeVersion,
		position: [source.position[0] + 112, source.position[1] + 96],
		id: crypto.randomUUID(),
		name: NEW_NODE_NAME,
		executeOnce: false,
		credentials: JSON.parse(JSON.stringify(existingDrive.credentials || {})),
	};

	const backupPath = path.join(__dirname, `.wf-backup-${Date.now()}.json`);
	fs.writeFileSync(backupPath, JSON.stringify(wf, null, 2));
	console.log('Backup saved to', backupPath);

	wf.nodes.push(newNode);
	console.log(`Added node: ${NEW_NODE_NAME} @ [${newNode.position.join(',')}], id=${newNode.id}`);

	conns.main[0] = conns.main[0].map(e =>
		e.node === TARGET_NODE ? { node: NEW_NODE_NAME, type: 'main', index: 0 } : e,
	);
	wf.connections[NEW_NODE_NAME] = {
		main: [[{ node: TARGET_NODE, type: 'main', index: 0 }]],
	};
	console.log(`Rewired: ${SOURCE_NODE} → ${NEW_NODE_NAME} → ${TARGET_NODE}`);

	console.log('Pushing patched workflow…');
	await api('PUT', `/workflows/${WORKFLOW_ID}`, buildPutPayload(wf));
	console.log('OK — fresh-email attachments will now be archived to the Rate Confirmations Drive folder.');
	console.log('Active executions will pick up the change on the next trigger (every minute).');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
