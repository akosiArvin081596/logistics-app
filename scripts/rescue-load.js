/**
 * Look up the most-recent n8n execution that processed a given Load ID
 * and re-run its Gmail message through the live workflow. Intended for
 * dispatchers (or anyone) to re-extract a load whose sheet row came
 * through with incomplete data — e.g. an early Bison email that fell
 * through to the body-fallback path before patch-filter-pdf-attachments.js
 * was deployed.
 *
 * How it works:
 *   1. Pages through `/api/v1/executions?workflowId=...` looking for an
 *      Email Input whose subject contains the load number.
 *   2. Extracts the Gmail messageId from that execution.
 *   3. Delegates to scripts/replay-via-webhook-injection.js, which
 *      injects two temporary nodes (Webhook + Gmail get-message), fires
 *      them, waits for the new execution, restores the workflow, and
 *      prints what was extracted vs written to the sheet.
 *
 * The replay always uses the LATEST workflow state, so the
 * PDF-filter / Bison-hardcode / Addresses-Ready guard / completeness
 * gate / etc. all apply automatically. JOB DETAILS ENTRY runs in
 * appendOrUpdate mode keyed on Load ID, so the existing sheet row is
 * overwritten in place — no duplicate row.
 *
 * Run: N8N_API_KEY=... node scripts/rescue-load.js <loadId>
 *
 * Example: N8N_API_KEY=... node scripts/rescue-load.js 6962146
 */

const { spawn } = require('child_process');
const path = require('path');

const N8N_BASE = process.env.N8N_BASE_URL || 'https://sandhub.app.n8n.cloud';
const WORKFLOW_ID = process.env.N8N_WORKFLOW_ID || 'ydFgTSFpKTyyZbXW';
const API_KEY = process.env.N8N_API_KEY;
if (!API_KEY) { console.error('N8N_API_KEY env var required'); process.exit(1); }

const LOAD_ID = (process.argv[2] || '').trim();
if (!LOAD_ID) {
	console.error('Usage: N8N_API_KEY=... node scripts/rescue-load.js <loadId>');
	process.exit(1);
}

async function api(method, p) {
	const res = await fetch(`${N8N_BASE}/api/v1${p}`, {
		method,
		headers: { 'X-N8N-API-KEY': API_KEY },
	});
	const text = await res.text();
	if (!res.ok) throw new Error(`${method} ${p} → ${res.status}\n${text.slice(0, 400)}`);
	return text ? JSON.parse(text) : {};
}

(async () => {
	// Scan recent executions, find one whose Email Input subject matches the
	// Load ID. We page through up to 5 pages of 50 (250 most recent execs)
	// before giving up — covers ~2 weeks of activity for this workflow.
	console.log(`Searching n8n for executions matching Load ID ${LOAD_ID}...`);
	let messageId = null;
	let cursor = null;
	let pagesScanned = 0;
	const MAX_PAGES = 5;
	const PAGE_SIZE = 50;
	scan: while (pagesScanned < MAX_PAGES) {
		pagesScanned++;
		const cursorQs = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
		const list = await api('GET', `/executions?workflowId=${WORKFLOW_ID}&limit=${PAGE_SIZE}&includeData=false${cursorQs}`);
		for (const e of (list.data || [])) {
			const full = await api('GET', `/executions/${e.id}?includeData=true`).catch(() => null);
			if (!full) continue;
			const ei = full.data?.resultData?.runData?.['Email Input']?.[0]?.data?.main?.[0]?.[0]?.json;
			const subject = ei?.subject || '';
			if (subject.includes(LOAD_ID)) {
				messageId = ei?.id;
				console.log(`  → matched exec ${e.id} (${e.status}, ${e.startedAt.slice(0, 16)}): ${subject}`);
				console.log(`  → Gmail message: ${messageId}`);
				break scan;
			}
		}
		cursor = list.nextCursor;
		if (!cursor) break;
	}
	if (!messageId) {
		console.error(`No execution found matching Load ID ${LOAD_ID} in the last ${MAX_PAGES * PAGE_SIZE} runs.`);
		console.error('If the email is older than that, fetch the Gmail message ID manually and run scripts/replay-via-webhook-injection.js directly.');
		process.exit(2);
	}

	console.log('\nDelegating to scripts/replay-via-webhook-injection.js...\n');
	const replay = spawn(process.execPath, [path.join(__dirname, 'replay-via-webhook-injection.js'), messageId], {
		stdio: 'inherit',
		env: process.env,
	});
	replay.on('exit', code => process.exit(code ?? 0));
	replay.on('error', err => { console.error('Failed to spawn replay:', err.message); process.exit(1); });
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
