/**
 * Hardens the "Dispatch v2 (Fixed)" n8n workflow against the load-7035474
 * failure class (July 2026): a Bison "RE: Tracking Update" courtesy email
 * re-ran the body-only extraction path and its appendOrUpdate CLOBBERED the
 * complete row written by the real rate-con five days earlier (wiped
 * Payment + both addresses -> dashboard showed NEEDS REVIEW).
 *
 * Three changes, each independently idempotent:
 *
 * 1. "Is Tracking Update?" entry filter (after Email Input):
 *    mail from loadupdate@bisontransport.com, or subject containing
 *    "tracking update for bison order", is marked read and dropped before
 *    any extraction. Bison's tracking bot never sends rate cons; those
 *    threads were the direct cause of the clobber (execs 2267/2269).
 *
 * 2. No-clobber guard on the body-only branch (after Extract from Email
 *    Body): look up the existing Job Tracking row by Load ID; if it already
 *    has a non-empty "  Payment  ", STOP - a body-only (rate-less)
 *    extraction must never overwrite a row the PDF path completed.
 *    Fail-open: lookup errors or no-match continue to the normal write, so
 *    new loads are unaffected. The PDF path (which extracts Rate) still
 *    updates unconditionally - rate-con revisions keep working.
 *
 * 3. LlamaParse Upload fail-open: onError=continueErrorOutput routed to
 *    Build Email Context. On 7/1 five C.H. Robinson rate-con emails died at
 *    LlamaParse Upload ("Your request is invalid...") and produced NO row at
 *    all (execs 2271-2284). With this, an upload failure degrades to a
 *    body-only NEEDS-REVIEW row instead of silent data loss.
 *
 * Backs up the unmodified workflow to .wf-backup-<ts>.json (repo root).
 * Run:  N8N_API_KEY=... node scripts/patch-dispatch-hardening.js [--dry]
 */

const fs = require('fs');
const path = require('path');

const N8N_BASE = process.env.N8N_BASE_URL || 'https://sandhub.app.n8n.cloud';
const WORKFLOW_ID = process.env.N8N_WORKFLOW_ID || 'ydFgTSFpKTyyZbXW';
const API_KEY = process.env.N8N_API_KEY;
const DRY = process.argv.includes('--dry');
if (!API_KEY) { console.error('N8N_API_KEY env var required'); process.exit(1); }

async function api(method, p, body) {
	const res = await fetch(`${N8N_BASE}/api/v1${p}`, {
		method,
		headers: { 'X-N8N-API-KEY': API_KEY, 'Content-Type': 'application/json' },
		body: body ? JSON.stringify(body) : undefined,
	});
	const text = await res.text();
	if (!res.ok) throw new Error(`${method} ${p} -> ${res.status}\n${text.slice(0, 500)}`);
	return text ? JSON.parse(text) : {};
}

function uuid() {
	return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
		const r = (Math.random() * 16) | 0;
		return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
	});
}

const getNode = (wf, name) => wf.nodes.find((n) => n.name === name);
const mustGet = (wf, name) => {
	const n = getNode(wf, name);
	if (!n) throw new Error(`Anchor node "${name}" not found - workflow shape changed, aborting.`);
	return n;
};

(async () => {
	console.log(`Fetching workflow ${WORKFLOW_ID}...`);
	const wf = await api('GET', `/workflows/${WORKFLOW_ID}`);
	const pristine = JSON.stringify(wf, null, 2); // snapshot before any mutation
	const changes = [];

	// ---------------------------------------------------------------- change 1
	if (getNode(wf, 'Is Tracking Update?')) {
		console.log('[1] entry filter already present - skipping');
	} else {
		const emailInput = mustGet(wf, 'Email Input');
		const markReadProcessing = mustGet(wf, 'Mark Read (Processing)');
		mustGet(wf, 'Has Attachments?');

		const filterNode = {
			id: uuid(),
			name: 'Is Tracking Update?',
			type: 'n8n-nodes-base.if',
			typeVersion: 2.2,
			position: [emailInput.position[0] + 180, emailInput.position[1] - 140],
			parameters: {
				conditions: {
					options: { caseSensitive: false, leftValue: '', typeValidation: 'loose', version: 2 },
					combinator: 'or',
					conditions: [
						{
							id: uuid(),
							leftValue: "={{ ((($json.from || {}).text) || (($json.headers || {}).from) || '').toLowerCase() }}",
							rightValue: 'loadupdate@bisontransport.com',
							operator: { type: 'string', operation: 'contains' },
						},
						{
							id: uuid(),
							leftValue: "={{ (($json.subject || '') + ' ' + (($json.headers || {}).subject || '')).toLowerCase() }}",
							rightValue: 'tracking update for bison order',
							operator: { type: 'string', operation: 'contains' },
						},
					],
				},
				options: {},
			},
		};
		// Marks the tracking email read using its own item (no cross-node refs).
		const markTracking = {
			id: uuid(),
			name: 'Mark Read (Tracking Update)',
			type: 'n8n-nodes-base.gmail',
			typeVersion: 2.1,
			position: [filterNode.position[0] + 200, filterNode.position[1] - 120],
			parameters: { operation: 'markAsRead', messageId: '={{ $json.id }}' },
			credentials: JSON.parse(JSON.stringify(markReadProcessing.credentials)),
		};
		wf.nodes.push(filterNode, markTracking);

		// Email Input used to feed Has Attachments? directly; route through the filter.
		wf.connections['Email Input'] = { main: [[{ node: 'Is Tracking Update?', type: 'main', index: 0 }]] };
		wf.connections['Is Tracking Update?'] = {
			main: [
				[{ node: 'Mark Read (Tracking Update)', type: 'main', index: 0 }], // TRUE: drop
				[{ node: 'Has Attachments?', type: 'main', index: 0 }],            // FALSE: normal flow
			],
		};
		changes.push('1: Email Input -> Is Tracking Update? -> (mark read | Has Attachments?)');
	}

	// ---------------------------------------------------------------- change 2
	if (getNode(wf, 'Lookup Existing Row')) {
		console.log('[2] no-clobber guard already present - skipping');
	} else {
		const extract = mustGet(wf, 'Extract from Email Body');
		const jde = mustGet(wf, 'JOB DETAILS ENTRY');
		mustGet(wf, 'Normalize Load Fields');

		const lookup = {
			id: uuid(),
			name: 'Lookup Existing Row',
			type: 'n8n-nodes-base.googleSheets',
			typeVersion: jde.typeVersion,
			position: [extract.position[0] + 200, extract.position[1] + 160],
			// Fail-open: an errored or empty lookup must never block a load write.
			alwaysOutputData: true,
			onError: 'continueRegularOutput',
			parameters: {
				operation: 'read',
				documentId: JSON.parse(JSON.stringify(jde.parameters.documentId)),
				sheetName: JSON.parse(JSON.stringify(jde.parameters.sheetName)),
				filtersUI: {
					values: [
						{
							lookupColumn: 'Load ID',
							lookupValue: "={{ $json.output['Load Number'] || '__NO_LOAD_ID__' }}",
						},
					],
				},
				combineFilters: 'AND',
				options: {},
			},
			credentials: JSON.parse(JSON.stringify(jde.credentials)),
		};
		const guard = {
			id: uuid(),
			name: 'Row Already Has Payment?',
			type: 'n8n-nodes-base.if',
			typeVersion: 2.2,
			position: [lookup.position[0] + 200, lookup.position[1]],
			parameters: {
				conditions: {
					options: { caseSensitive: false, leftValue: '', typeValidation: 'loose', version: 2 },
					combinator: 'and',
					conditions: [
						{
							id: uuid(),
							leftValue: "={{ (($json || {})['  Payment  '] || '').toString().trim() }}",
							rightValue: '',
							operator: { type: 'string', operation: 'notEmpty', singleValue: true },
						},
					],
				},
				options: {},
			},
		};
		// The guard's items are sheet rows; re-emit the extractor output so
		// Normalize Load Fields sees the same shape it always has.
		const restore = {
			id: uuid(),
			name: 'Restore Extraction',
			type: 'n8n-nodes-base.code',
			typeVersion: 2,
			position: [guard.position[0] + 200, guard.position[1] + 120],
			parameters: { jsCode: "return $('Extract from Email Body').all();" },
		};
		wf.nodes.push(lookup, guard, restore);

		const extractConns = wf.connections['Extract from Email Body'];
		if (!extractConns || !extractConns.main || !extractConns.main[0]) {
			throw new Error('Extract from Email Body has no main[0] connection - aborting.');
		}
		extractConns.main[0] = [{ node: 'Lookup Existing Row', type: 'main', index: 0 }];
		wf.connections['Lookup Existing Row'] = { main: [[{ node: 'Row Already Has Payment?', type: 'main', index: 0 }]] };
		wf.connections['Row Already Has Payment?'] = {
			main: [
				[], // TRUE: row is complete - stop, protect it (email stays unread, same as the completeness gate)
				[{ node: 'Restore Extraction', type: 'main', index: 0 }],
			],
		};
		wf.connections['Restore Extraction'] = { main: [[{ node: 'Normalize Load Fields', type: 'main', index: 0 }]] };
		changes.push('2: Extract from Email Body -> Lookup Existing Row -> Row Already Has Payment? -> (stop | Restore Extraction -> Normalize)');
	}

	// ---------------------------------------------------------------- change 3
	const llama = mustGet(wf, 'LlamaParse Upload');
	if (llama.onError === 'continueErrorOutput') {
		console.log('[3] LlamaParse fail-open already present - skipping');
	} else {
		mustGet(wf, 'Build Email Context');
		llama.onError = 'continueErrorOutput';
		const lconn = wf.connections['LlamaParse Upload'] || { main: [[]] };
		lconn.main = lconn.main || [[]];
		while (lconn.main.length < 2) lconn.main.push([]);
		lconn.main[1] = [{ node: 'Build Email Context', type: 'main', index: 0 }];
		wf.connections['LlamaParse Upload'] = lconn;
		changes.push('3: LlamaParse Upload error output -> Build Email Context (body-only fallback instead of dead run)');
	}

	if (!changes.length) { console.log('Nothing to do.'); return; }
	console.log('\nPlanned changes:');
	changes.forEach((c) => console.log('  - ' + c));

	if (DRY) { console.log('\n--dry: not pushing. Re-run without --dry to apply.'); return; }

	const backup = path.join(__dirname, `.wf-backup-${Date.now()}.json`);
	fs.writeFileSync(backup, pristine);
	console.log(`\nBackup (pre-patch state) written to ${backup}`);

	const payload = {};
	for (const k of ['name', 'nodes', 'connections', 'settings', 'staticData']) {
		if (wf[k] !== undefined) payload[k] = wf[k];
	}
	if (payload.settings) {
		const allowed = ['saveExecutionProgress', 'saveManualExecutions', 'saveDataErrorExecution', 'saveDataSuccessExecution', 'executionTimeout', 'errorWorkflow', 'timezone', 'executionOrder'];
		const clean = {};
		for (const k of allowed) if (payload.settings[k] !== undefined) clean[k] = payload.settings[k];
		payload.settings = clean;
	}

	console.log('Pushing patched workflow...');
	await api('PUT', `/workflows/${WORKFLOW_ID}`, payload);
	console.log('OK - applied. New executions pick this up immediately.');
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
