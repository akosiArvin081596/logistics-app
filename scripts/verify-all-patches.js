/**
 * Verifies the live state of ALL n8n workflow patches in one shot.
 *
 * Checks:
 *   1. LlamaParse LVM mode (parse_page_with_lvm)
 *   2. "Addresses Ready?" guard node + connections
 *   3. Mark Read after PDF success path
 *   4. Thread PDF lookup branch (Get Thread Messages etc.)
 *   5. Bison lane hardcode in Normalize Load Fields
 *   6. Driver field removed from JOB DETAILS ENTRY
 *   7. Replay nodes absent (clean)
 *
 * Run: N8N_API_KEY=... node scripts/verify-all-patches.js
 */

const N8N_BASE = process.env.N8N_BASE_URL || 'https://sandhub.app.n8n.cloud';
const WORKFLOW_ID = process.env.N8N_WORKFLOW_ID || 'ydFgTSFpKTyyZbXW';
const API_KEY = process.env.N8N_API_KEY;
if (!API_KEY) { console.error('N8N_API_KEY env var required'); process.exit(1); }

async function api(method, path) {
	const res = await fetch(`${N8N_BASE}/api/v1${path}`, {
		method,
		headers: { 'X-N8N-API-KEY': API_KEY },
	});
	const text = await res.text();
	if (!res.ok) throw new Error(`${method} ${path} → ${res.status}\n${text.slice(0, 600)}`);
	return text ? JSON.parse(text) : {};
}

function pass(msg) { console.log('  ✓ ' + msg); }
function fail(msg) { console.log('  ✗ ' + msg); }
function header(msg) { console.log('\n' + msg); }

(async () => {
	console.log('Fetching workflow…');
	const wf = await api('GET', `/workflows/${WORKFLOW_ID}`);
	const nodes = wf.nodes;
	const conn = wf.connections;
	let allOk = true;

	function find(name) { return nodes.find(n => n.name === name); }
	function hasEdge(from, to) {
		const c = conn[from];
		if (!c?.main) return false;
		return c.main.some(branch => branch.some(e => e.node === to));
	}
	function check(condition, okMsg, failMsg) {
		if (condition) { pass(okMsg); } else { fail(failMsg); allOk = false; }
	}

	// 1. LlamaParse LVM
	header('1. LlamaParse LVM mode');
	const llama = find('LlamaParse Upload');
	if (!llama) { fail('LlamaParse Upload node not found'); allOk = false; } else {
		const params = llama.parameters.bodyParameters?.parameters || [];
		const pm = params.find(p => p.name === 'parse_mode');
		check(pm?.value === 'parse_page_with_lvm', 'parse_mode = parse_page_with_lvm', 'parse_mode not set to parse_page_with_lvm (got: ' + (pm?.value || 'none') + ')');
	}

	// 2. Addresses Ready? guard
	header('2. Addresses Ready? guard');
	const guard = find('Addresses Ready?');
	check(!!guard, '"Addresses Ready?" node present', '"Addresses Ready?" node MISSING');
	if (guard) {
		check(hasEdge('JOB DETAILS ENTRY', 'Addresses Ready?'), 'JOB DETAILS ENTRY → Addresses Ready?', 'JOB DETAILS ENTRY does NOT point to Addresses Ready?');
		check(hasEdge('Addresses Ready?', 'AI Agent'), 'Addresses Ready?[0] → AI Agent', 'Addresses Ready? does NOT connect to AI Agent');
		const falseEdge = conn['Addresses Ready?']?.main?.[1]?.some(e => e.node === 'Update Job Tracking (Distance)');
		check(falseEdge, 'Addresses Ready?[1] → Update Job Tracking (Distance)', 'Addresses Ready? FALSE branch does NOT go to Update Job Tracking (Distance)');
	}

	// 3. Mark Read after PDF path (direct OR through the completeness gate)
	header('3. Mark Read on PDF success path');
	const direct = hasEdge('Update Job Tracking (Distance)', 'Mark Read (Processing)');
	const viaGate = hasEdge('Update Job Tracking (Distance)', 'Critical Fields Complete?')
		&& hasEdge('Critical Fields Complete?', 'Mark Read (Processing)');
	check(direct || viaGate,
		viaGate ? 'Update Job Tracking → Critical Fields Complete? → Mark Read (Processing)' : 'Update Job Tracking (Distance) → Mark Read (Processing)',
		'Update Job Tracking (Distance) does NOT reach Mark Read (Processing)');

	// 4. Thread PDF lookup
	header('4. Thread PDF lookup branch');
	check(!!find('Get Thread Messages'), '"Get Thread Messages" node present', '"Get Thread Messages" node MISSING — patch-thread-pdf-lookup.js not applied');
	check(!!find('Pick Thread PDF'), '"Pick Thread PDF" node present', '"Pick Thread PDF" node MISSING');
	check(!!find('Thread Has PDF?'), '"Thread Has PDF?" node present', '"Thread Has PDF?" node MISSING');
	check(!!find('Download Thread PDF Msg'), '"Download Thread PDF Msg" node present', '"Download Thread PDF Msg" node MISSING');
	check(!!find('Prep Thread PDF Item'), '"Prep Thread PDF Item" node present', '"Prep Thread PDF Item" node MISSING');
	if (find('Get Thread Messages')) {
		const hasAttach = conn['Has Attachments?'];
		const falseGoesThread = hasAttach?.main?.[1]?.some(e => e.node === 'Get Thread Messages');
		check(falseGoesThread, 'Has Attachments?[false] → Get Thread Messages', 'Has Attachments?[false] does NOT route to Get Thread Messages');
	}

	// 5. Bison lane hardcode
	header('5. Bison lane hardcode in Normalize Load Fields');
	const norm = find('Normalize Load Fields');
	if (!norm) { fail('Normalize Load Fields node not found'); allOk = false; } else {
		const fields = norm.parameters.fields?.values || norm.parameters.assignments?.assignments || [];
		const pickup = fields.find(f => (f.name || f.fieldName) === "output['Pickup Address']");
		const dropoff = fields.find(f => (f.name || f.fieldName) === "output['Drop-off Address']");
		const pickupHasBison = pickup?.value?.includes('bisontransport.com');
		const dropoffHasBison = dropoff?.value?.includes('bisontransport.com');
		check(pickupHasBison, 'Pickup Address has Bison lane fallback', 'Pickup Address has NO Bison lane fallback (check patch-bison-lane-hardcode.js)');
		check(dropoffHasBison, 'Drop-off Address has Bison lane fallback', 'Drop-off Address has NO Bison lane fallback');
		const pickupHasCity = pickup?.value?.includes('ames') || pickup?.value?.includes('Ames');
		check(pickupHasCity, 'Pickup fallback includes city keyword check (Ames)', 'Pickup fallback missing city keyword check');
	}

	// 6. Driver field removed from JOB DETAILS ENTRY
	header('6. Driver field NOT written by JOB DETAILS ENTRY');
	const jde = find('JOB DETAILS ENTRY');
	if (!jde) { fail('JOB DETAILS ENTRY node not found'); allOk = false; } else {
		const cols = jde.parameters.columns;
		const hasDriver = cols?.value?.Driver !== undefined && cols?.value?.Driver !== '';
		check(!hasDriver, 'Driver column removed from JOB DETAILS ENTRY write', 'Driver column still present in JOB DETAILS ENTRY — will overwrite dispatcher assignments');
	}

	// 7. No replay nodes
	header('7. Replay nodes cleaned up');
	const replay = nodes.filter(n => n.name === 'Replay Webhook' || n.name === 'Replay Get Email');
	check(replay.length === 0, 'No leftover replay nodes (' + nodes.length + ' total nodes)', 'Replay nodes still present: ' + replay.map(n => n.name).join(', '));

	// 8. Prepare Attachment Data filters to PDFs only
	header('8. Prepare Attachment Data filters to PDFs only');
	const prep = find('Prepare Attachment Data');
	if (!prep) { fail('Prepare Attachment Data node not found'); allOk = false; } else {
		const a = prep.parameters.assignments?.assignments || [];
		const entry = a.find(x => x.name === '=attachments');
		const v = entry?.value || '';
		check(
			v.includes("mimeType === 'application/pdf'") || v.includes('mimeType === "application/pdf"'),
			'attachments expression filters by application/pdf',
			'attachments expression does NOT filter by PDF MIME (got: ' + v.slice(0, 120) + ')'
		);
	}

	// 9. Completeness gate — Mark Read only fires when Rate is populated
	header('9. Completeness gate before Mark Read (Processing)');
	const gate = find('Critical Fields Complete?');
	check(!!gate, '"Critical Fields Complete?" node present', '"Critical Fields Complete?" node MISSING — patch-completeness-gate.js not applied');
	if (gate) {
		const condV = gate.parameters?.conditions?.conditions?.[0]?.leftValue || '';
		check(condV.includes('output.Rate') || condV.includes("output['Rate']"),
			'gate condition references Normalize Load Fields output.Rate',
			'gate condition does NOT reference output.Rate (got: ' + condV.slice(0, 100) + ')'
		);
		check(hasEdge('Update Job Tracking (Distance)', 'Critical Fields Complete?'),
			'Update Job Tracking (Distance) → Critical Fields Complete?',
			'Update Job Tracking (Distance) does NOT route through the gate');
		check(hasEdge('Critical Fields Complete?', 'Mark Read (Processing)'),
			'Critical Fields Complete?[TRUE] → Mark Read (Processing)',
			'Gate TRUE branch does NOT reach Mark Read (Processing)');
		check(!hasEdge('Google Drive', 'Mark Read (Processing)'),
			'Google Drive → Mark Read (Processing) edge removed',
			'Google Drive still directly marks email read (premature)');
		check(!hasEdge('Extract from Email Body', 'Mark Read (No Attachment)'),
			'Extract from Email Body → Mark Read (No Attachment) edge removed',
			'Extract from Email Body still directly marks email read (premature)');
	}

	// 10. Retry Counter tracks all pending jobs (no $input.first() drop)
	header('10. Retry Counter handles all pending LlamaParse jobs');
	const rc = find('Retry Counter');
	if (!rc) { fail('Retry Counter node not found'); allOk = false; } else {
		const code = rc.parameters?.jsCode || '';
		check(code.includes('$input.all()'),
			'Retry Counter maps over $input.all()',
			'Retry Counter still uses $input.first() — pending jobs past the first are dropped');
	}


	// Summary
	console.log('\n' + (allOk ? '=== ALL CHECKS PASSED ===' : '=== SOME CHECKS FAILED — see above ==='));
	process.exit(allOk ? 0 : 1);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
