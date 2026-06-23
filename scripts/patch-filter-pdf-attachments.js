/**
 * Patches the "Dispatch v2 (Fixed)" n8n workflow so the Prepare Attachment
 * Data node ignores non-PDF binaries before they reach LlamaParse.
 *
 * Bug (proven via exec 2121 on 2026-05-22, Bison Transport Order #6977471):
 * Bison emails carry both an inline signature PNG (e.g. image001.png, ~8 KB)
 * and the actual rate-con PDF (e.g. 6977471.pdf, ~35 KB). The Set node here
 * grabbed every binary key with no MIME filter, so both files went into the
 * LlamaParse upload + polling chain. The polling loop's Retry Counter Code
 * node uses $input.first().json.id and silently drops every item past the
 * first — so the small PNG (cache-hit, returns "NO_CONTENT_HERE.") wins the
 * race through Get Markdown and the actual PDF is orphaned. Markdown-quality
 * check then fails and the body-fallback path leaves most columns empty.
 *
 * Fix: filter binaries to application/pdf only. The upstream "Has Attachments?"
 * IF node already checks for PDF presence specifically, so when this node
 * executes the filtered array is guaranteed non-empty — no new guard IF
 * needed. Emails with non-PDF attachments only already route to the FALSE
 * branch (Get Thread Messages → thread-PDF-lookup → body fallback).
 *
 * NOT fixed by this patch: the underlying $input.first() bug in Retry
 * Counter. It is sidestepped because only one item ever enters the loop.
 * A future Bison email carrying TWO PDFs (rate-con + addendum) would still
 * drop the second — out of scope here, but flagged for the next maintainer.
 *
 * Idempotent (re-running detects the patched expression and skips).
 * Backs up the unmodified workflow to scripts/.wf-backup-<ts>.json before PUT.
 *
 * Run: N8N_API_KEY=... node scripts/patch-filter-pdf-attachments.js
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

const TARGET_VALUE =
	"={{ Object.entries($('Email Input').item.binary || {}).filter(([_, b]) => b && b.mimeType === 'application/pdf').map(([k]) => k) }}";

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

	const node = wf.nodes.find(n => n.name === 'Prepare Attachment Data');
	if (!node) throw new Error('Prepare Attachment Data node not found');

	const assignments = node.parameters.assignments?.assignments || [];
	const entry = assignments.find(a => a.name === '=attachments');
	if (!entry) throw new Error("Assignment '=attachments' not found in Prepare Attachment Data");

	if (entry.value === TARGET_VALUE) {
		console.log('Already patched. Nothing to do.');
		return;
	}

	const backupPath = path.join(__dirname, `.wf-backup-${Date.now()}.json`);
	fs.writeFileSync(backupPath, JSON.stringify(wf, null, 2));
	console.log('Backup saved to', backupPath);

	console.log('  was:', entry.value.slice(0, 120));
	entry.value = TARGET_VALUE;
	console.log('  now:', entry.value.slice(0, 120));

	console.log('Pushing patched workflow…');
	await api('PUT', `/workflows/${WORKFLOW_ID}`, buildPutPayload(wf));
	console.log('OK — Prepare Attachment Data now filters binaries to application/pdf only.');
	console.log('Active executions will pick up the change on the next trigger.');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
