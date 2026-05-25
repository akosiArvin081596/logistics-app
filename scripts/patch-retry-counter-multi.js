/**
 * Fixes the LlamaParse polling loop's "Retry Counter" Code node so it
 * tracks EVERY still-pending job, not just the first.
 *
 * Bug: the node read `$input.first().json.id` and returned a single item.
 * When more than one LlamaParse job was still PENDING in a poll cycle,
 * every item past the first was silently dropped from the loop — that
 * job never got polled again, its markdown never fetched. This is the
 * same class of bug that orphaned the rate-con PDF in the PNG-derail
 * case (see patch-filter-pdf-attachments.js), one layer deeper.
 *
 * Today it's dormant because the PDF filter guarantees a single PDF (so
 * a single job) enters the loop. This patch is insurance for the day a
 * broker sends two real PDFs in one email (rate-con + addendum) — both
 * jobs now stay in the loop until each resolves.
 *
 * Fix: map over `$input.all()`, incrementing the per-job retry counter
 * in workflow static data for each item independently. Downstream nodes
 * already handle multiple items correctly:
 *   - "Check Retry Limit" (IF) routes each item to TRUE/FALSE per-item.
 *   - "Wait 30s (Parsing)" waits once and passes all items through.
 *   - "Parse Status Router" (Switch) routes each item by status.
 * So no other node needs to change.
 *
 * Multi-PDF note: if two PDFs both parse to quality-passing markdown,
 * each flows through Information Extractor → JOB DETAILS ENTRY, which is
 * appendOrUpdate keyed on Load ID — the second write overwrites the
 * first (last-wins). For rate-con + addendum that's usually the intended
 * result; a junk second PDF is filtered out earlier by the
 * "Markdown Quality OK?" gate. Out of scope to dedup here.
 *
 * Idempotent: detects the `$input.all()` form and skips. Backs up first.
 *
 * Run: N8N_API_KEY=... node scripts/patch-retry-counter-multi.js
 */

const fs = require('fs');
const path = require('path');

const N8N_BASE = process.env.N8N_BASE_URL || 'https://sandhub.app.n8n.cloud';
const WORKFLOW_ID = process.env.N8N_WORKFLOW_ID || 'ydFgTSFpKTyyZbXW';
const API_KEY = process.env.N8N_API_KEY;
if (!API_KEY) { console.error('N8N_API_KEY env var required'); process.exit(1); }

const NEW_CODE = `const staticData = $getWorkflowStaticData('global');
// Track EVERY still-pending job, not just the first — otherwise any
// item past index 0 is silently dropped from the polling loop.
return $input.all().map(item => {
  const jobId = item.json.id;
  const key = \`llamaparse_retry_\${jobId}\`;
  staticData[key] = (staticData[key] || 0) + 1;
  const count = staticData[key];
  const exceeded = count > 10;
  if (exceeded) { delete staticData[key]; }
  return { json: { ...item.json, retryCount: count, retryExceeded: exceeded } };
});`;

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

	const node = wf.nodes.find(n => n.name === 'Retry Counter');
	if (!node) throw new Error('Retry Counter node not found');
	if (node.type !== 'n8n-nodes-base.code') throw new Error('Retry Counter is not a Code node (got ' + node.type + ')');

	const current = node.parameters?.jsCode || '';
	if (current.includes('$input.all()')) {
		console.log('Already patched ($input.all() present). Nothing to do.');
		return;
	}
	if (!current.includes('$input.first()')) {
		throw new Error('Unexpected Retry Counter code — neither $input.all() nor $input.first() found. Refusing to patch blind.');
	}

	const backupPath = path.join(__dirname, `.wf-backup-${Date.now()}.json`);
	fs.writeFileSync(backupPath, JSON.stringify(wf, null, 2));
	console.log('Backup saved to', backupPath);

	node.parameters.jsCode = NEW_CODE;

	console.log('Pushing patched workflow…');
	await api('PUT', `/workflows/${WORKFLOW_ID}`, buildPutPayload(wf));
	console.log('OK — Retry Counter now tracks all pending jobs via $input.all().');
	console.log('Single-PDF behavior is unchanged; multi-PDF emails no longer drop pending jobs.');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
