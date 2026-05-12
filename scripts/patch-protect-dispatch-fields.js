/**
 * Patches the "Dispatch v2 (Fixed)" n8n workflow to stop the JOB DETAILS
 * ENTRY node from writing Driver to the Google Sheet.
 *
 * Why: rate-con PDFs almost never contain a driver name — the extractor
 * returns null, n8n converts that to "" (empty string), and n8n's
 * appendOrUpdate over USER_ENTERED writes blank back to the sheet,
 * wiping any driver assignment that LogisX dispatch had set in between.
 *
 * Verified via exec 2067 (RE: Bison Transport Order #6942913, May 4):
 * the sheet write payload included Driver: "", which over-wrote
 * whatever driver was assigned to #6942913 at that moment.
 *
 * Driver assignments are owned by LogisX dispatch (POST /api/dispatch)
 * — n8n should not touch that column on update. We leave it in the
 * "appended" (new-row) case only because then the column is set to
 * empty anyway and we're not destroying prior state.
 *
 * Fix: remove the Driver field from columns.value AND from the schema
 * removed:false entries. Idempotent + backed up.
 *
 * Run: N8N_API_KEY=... node scripts/patch-protect-dispatch-fields.js
 */

const fs = require('fs');
const path = require('path');

const N8N_BASE = process.env.N8N_BASE_URL || 'https://sandhub.app.n8n.cloud';
const WORKFLOW_ID = process.env.N8N_WORKFLOW_ID || 'ydFgTSFpKTyyZbXW';
const API_KEY = process.env.N8N_API_KEY;
if (!API_KEY) { console.error('N8N_API_KEY env var required'); process.exit(1); }

const PROTECTED_FIELDS = ['Driver'];

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

(async () => {
	console.log('Fetching workflow…');
	const wf = await api('GET', `/workflows/${WORKFLOW_ID}`);
	const node = wf.nodes.find(n => n.name === 'JOB DETAILS ENTRY');
	if (!node) throw new Error('JOB DETAILS ENTRY node not found');

	const cols = node.parameters.columns;
	if (!cols || !cols.value) throw new Error('JOB DETAILS ENTRY has no columns.value');

	let removed = 0;
	for (const f of PROTECTED_FIELDS) {
		if (cols.value[f] !== undefined) {
			delete cols.value[f];
			removed++;
			console.log('  removed column mapping:', f);
		}
		// Mark schema entry as removed so the n8n UI hides it too
		if (Array.isArray(cols.schema)) {
			const s = cols.schema.find(x => x.id === f);
			if (s) { s.removed = true; s.display = false; }
		}
	}

	if (removed === 0) {
		console.log('Already patched. Nothing to do.');
		return;
	}

	const backupPath = path.join(__dirname, `.wf-backup-${Date.now()}.json`);
	fs.writeFileSync(backupPath, JSON.stringify(wf, null, 2));
	console.log('Backup saved to', backupPath);

	const payload = { name: wf.name, nodes: wf.nodes, connections: wf.connections };
	if (wf.staticData !== undefined) payload.staticData = wf.staticData;
	if (wf.settings) {
		const allowed = ['saveExecutionProgress','saveManualExecutions','saveDataErrorExecution','saveDataSuccessExecution','executionTimeout','errorWorkflow','timezone','executionOrder'];
		const clean = {};
		for (const k of allowed) if (wf.settings[k] !== undefined) clean[k] = wf.settings[k];
		payload.settings = clean;
	}

	console.log('Pushing patched workflow…');
	await api('PUT', `/workflows/${WORKFLOW_ID}`, payload);
	console.log('OK — JOB DETAILS ENTRY no longer writes:', PROTECTED_FIELDS.join(', '));
	console.log('LogisX dispatch (POST /api/dispatch) owns these columns now.');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
