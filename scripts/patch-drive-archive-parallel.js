/**
 * Re-wires the `Google Drive (Archive)` node from SERIAL to PARALLEL in the
 * live "Dispatch v2 (Fixed)" n8n workflow.
 *
 * Bug context (regression from scripts/patch-restore-drive-upload.js, deployed
 * 2026-06-20 ~14:11Z): that patch inserted Archive BETWEEN
 *   `Merge Attachment + Email` → `LlamaParse Upload`
 * The Google Drive node's output is Drive API metadata, which replaced the
 * email payload. `LlamaParse Upload` then reads `$json.attachments` → undefined
 * → crash. Every broker email with an attachment has errored since.
 *
 * Fix: rewire so Archive runs in PARALLEL off Merge Attachment + Email,
 * terminating in itself. LlamaParse Upload then reads the raw merge payload
 * unmodified, identical to the pre-patch shape but with archival now happening
 * on a side branch. Branch 1 (no-attachments thread-fetch path) is already
 * wired this exact way — that's our reference shape.
 *
 *   BEFORE
 *     Merge Attachment + Email → [Google Drive (Archive)]
 *     Google Drive (Archive)   → [LlamaParse Upload]
 *
 *   AFTER
 *     Merge Attachment + Email → [Google Drive (Archive), LlamaParse Upload]
 *     Google Drive (Archive)   → []        (terminates)
 *
 * Idempotent (re-running detects the parallel wiring and skips).
 * Backs up the unmodified workflow to scripts/.wf-backup-<ts>.json before PUT.
 * Connections-only mutation — no node additions / removals / position changes,
 * so the existing Google Drive (Archive) node identity, parameters, and
 * credentials are preserved.
 *
 * Run: N8N_API_KEY=... node scripts/patch-drive-archive-parallel.js
 *
 * REQUIRED follow-up — smoke-test the live pipeline AFTER patching:
 *   N8N_API_KEY=... node scripts/n8n-smoke-test.js
 * Replays a known-good email and asserts the sheet-write step ran.
 */

const fs = require('fs');
const path = require('path');

const N8N_BASE = process.env.N8N_BASE_URL || 'https://sandhub.app.n8n.cloud';
const WORKFLOW_ID = process.env.N8N_WORKFLOW_ID || 'ydFgTSFpKTyyZbXW';
const API_KEY = process.env.N8N_API_KEY;
if (!API_KEY) { console.error('N8N_API_KEY env var required'); process.exit(1); }

const MERGE_NODE = 'Merge Attachment + Email';
const ARCHIVE_NODE = 'Google Drive (Archive)';
const PARSER_NODE = 'LlamaParse Upload';

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

function targetsOf(conn) {
	return ((conn && conn.main && conn.main[0]) || []).map(e => e.node);
}

(async () => {
	console.log('Fetching workflow…');
	const wf = await api('GET', `/workflows/${WORKFLOW_ID}`);

	if (!wf.nodes.find(n => n.name === ARCHIVE_NODE)) {
		throw new Error(`Node '${ARCHIVE_NODE}' is not in the workflow — nothing to rewire. Was the prior patch reverted?`);
	}

	const mergeOut = targetsOf(wf.connections[MERGE_NODE]);
	const archiveOut = targetsOf(wf.connections[ARCHIVE_NODE]);

	const hasArchive = mergeOut.includes(ARCHIVE_NODE);
	const hasParser = mergeOut.includes(PARSER_NODE);

	if (hasArchive && hasParser && archiveOut.length === 0) {
		console.log('Already in PARALLEL wiring. Nothing to do.');
		return;
	}

	const isBrokenSerial =
		mergeOut.length === 1 &&
		hasArchive &&
		archiveOut.length === 1 &&
		archiveOut[0] === PARSER_NODE;

	if (!isBrokenSerial) {
		console.error(`Unexpected workflow shape — refusing to mutate.`);
		console.error(`  ${MERGE_NODE} → ${JSON.stringify(mergeOut)}`);
		console.error(`  ${ARCHIVE_NODE} → ${JSON.stringify(archiveOut)}`);
		throw new Error('Aborting — inspect the workflow manually before patching.');
	}

	const backupPath = path.join(__dirname, `.wf-backup-${Date.now()}.json`);
	fs.writeFileSync(backupPath, JSON.stringify(wf, null, 2));
	console.log('Backup saved to', backupPath);

	wf.connections[MERGE_NODE] = {
		main: [[
			{ node: ARCHIVE_NODE, type: 'main', index: 0 },
			{ node: PARSER_NODE, type: 'main', index: 0 },
		]],
	};
	wf.connections[ARCHIVE_NODE] = { main: [[]] };

	console.log(`Rewired: ${MERGE_NODE} → [${ARCHIVE_NODE}, ${PARSER_NODE}] (parallel)`);
	console.log(`         ${ARCHIVE_NODE} → []  (terminates)`);

	console.log('Pushing patched workflow…');
	await api('PUT', `/workflows/${WORKFLOW_ID}`, buildPutPayload(wf));
	console.log('OK — broker emails with attachments will now reach LlamaParse Upload again.');
	console.log('     Drive archival continues on a side branch.');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
