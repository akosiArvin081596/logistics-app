/**
 * Patches the production "Dispatch v2" n8n workflow to add a Gemini Vision
 * fallback when LlamaParse fails the markdown-quality check. The Bison
 * rate-confirmation PDF format returns ~15 chars of garbage from LlamaParse
 * ("# Bison\n\n# SUSA"), which causes the workflow to fall through to
 * email-body extraction — and Bison emails carry no addresses in the body,
 * so we end up storing empty pickup/dropoff. Gemini 2.5 Flash on the same
 * PDF extracts every field cleanly.
 *
 * What this script injects:
 *   1. "Prepare PDF for Gemini" (Code) — pulls the PDF binary from
 *      Split Attachments and emits { pdf_base64: <base64> }.
 *   2. "Gemini PDF Fallback" (HTTP Request) — POSTs the base64 to
 *      app.logisx.com/api/n8n/extract-pdf-via-gemini with the webhook
 *      secret header. Has continueErrorOutput so HTTP failures route to
 *      the existing email-body fallback instead of killing the run.
 *   3. "Gemini Got Load Number?" (IF) — true if output.Load Number is non-
 *      empty. True → Normalize Load Fields. False → Build Email Context.
 *
 * Rewiring:
 *   Markdown Quality OK? FALSE was: → Build Email Context
 *                          becomes: → Prepare PDF for Gemini
 *   New: Prepare PDF for Gemini → Gemini PDF Fallback
 *   New: Gemini PDF Fallback (success) → Gemini Got Load Number?
 *        Gemini PDF Fallback (error)   → Build Email Context
 *   New: Gemini Got Load Number? TRUE  → Normalize Load Fields
 *                                FALSE → Build Email Context
 *
 * Idempotent: if the new nodes already exist, exit cleanly.
 *
 * Run:
 *   N8N_API_KEY=... LOGISX_WEBHOOK_SECRET=... \
 *     node scripts/patch-gemini-pdf-fallback.js
 *
 * Environment overrides (optional):
 *   N8N_BASE_URL       default https://sandhub.app.n8n.cloud
 *   N8N_WORKFLOW_ID    default ydFgTSFpKTyyZbXW
 *   LOGISX_BASE_URL    default https://app.logisx.com
 */

const N8N_BASE = process.env.N8N_BASE_URL || 'https://sandhub.app.n8n.cloud';
const WORKFLOW_ID = process.env.N8N_WORKFLOW_ID || 'ydFgTSFpKTyyZbXW';
const LOGISX_BASE = process.env.LOGISX_BASE_URL || 'https://app.logisx.com';
const API_KEY = process.env.N8N_API_KEY;
const WEBHOOK_SECRET = process.env.LOGISX_WEBHOOK_SECRET;

if (!API_KEY) { console.error('N8N_API_KEY env var required'); process.exit(1); }
if (!WEBHOOK_SECRET) { console.error('LOGISX_WEBHOOK_SECRET env var required (production N8N_WEBHOOK_SECRET from .env)'); process.exit(1); }

const PREPARE_NODE = 'Prepare PDF for Gemini';
const GEMINI_NODE = 'Gemini PDF Fallback';
const CHECK_NODE = 'Gemini Got Load Number?';

function uuid() {
	return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
		const r = Math.random() * 16 | 0;
		return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
	});
}

async function api(method, path, body) {
	const res = await fetch(`${N8N_BASE}/api/v1${path}`, {
		method,
		headers: { 'X-N8N-API-KEY': API_KEY, 'Content-Type': 'application/json' },
		body: body ? JSON.stringify(body) : undefined,
	});
	const text = await res.text();
	if (!res.ok) throw new Error(`${method} ${path} → ${res.status}\n${text.slice(0, 500)}`);
	return text ? JSON.parse(text) : {};
}

function buildPutPayload(wf) {
	const payload = { name: wf.name, nodes: wf.nodes, connections: wf.connections };
	if (wf.staticData !== undefined) payload.staticData = wf.staticData;
	if (wf.settings) {
		// n8n PUBLIC API v1 settings allowlist — strict.
		const allowed = ['saveExecutionProgress','saveManualExecutions','saveDataErrorExecution','saveDataSuccessExecution','executionTimeout','errorWorkflow','timezone','executionOrder'];
		const clean = {};
		for (const k of allowed) if (wf.settings[k] !== undefined) clean[k] = wf.settings[k];
		payload.settings = clean;
	}
	return payload;
}

(async () => {
	console.log('Fetching workflow...');
	const wf = await api('GET', `/workflows/${WORKFLOW_ID}`);

	const router = wf.nodes.find(n => n.name === 'Markdown Quality OK?');
	if (!router) throw new Error('"Markdown Quality OK?" node not found — refusing to patch.');
	const normalize = wf.nodes.find(n => n.name === 'Normalize Load Fields');
	if (!normalize) throw new Error('"Normalize Load Fields" node not found.');
	const buildEmailCtx = wf.nodes.find(n => n.name === 'Build Email Context');
	if (!buildEmailCtx) throw new Error('"Build Email Context" node not found.');
	const split = wf.nodes.find(n => n.name === 'Split Attachments');
	if (!split) throw new Error('"Split Attachments" node not found.');

	if (wf.nodes.some(n => [PREPARE_NODE, GEMINI_NODE, CHECK_NODE].includes(n.name))) {
		console.log('Gemini fallback nodes already present. Nothing to do.');
		return;
	}

	const [rx, ry] = router.position;
	const prepareNode = {
		id: uuid(),
		name: PREPARE_NODE,
		type: 'n8n-nodes-base.code',
		typeVersion: 2,
		position: [rx + 224, ry + 360],
		parameters: {
			jsCode: [
				"// Pull the PDF binary that LlamaParse already had access to and",
				"// emit it as a base64 string the LogisX server endpoint can post",
				"// to Gemini Vision.",
				"const split = $('Split Attachments').item;",
				"const binKey = split.json.attachments;",
				"const bin = split.binary && split.binary[binKey];",
				"if (!bin || !bin.data) {",
				"  throw new Error('No PDF binary on Split Attachments item — Gemini fallback cannot run.');",
				"}",
				"return [{ json: { pdf_base64: bin.data } }];",
			].join('\n'),
		},
	};

	const geminiNode = {
		id: uuid(),
		name: GEMINI_NODE,
		type: 'n8n-nodes-base.httpRequest',
		typeVersion: 4.2,
		position: [rx + 448, ry + 360],
		// continueErrorOutput → second output fires on HTTP failure so the
		// workflow can fall back to email-body extraction instead of dying.
		onError: 'continueErrorOutput',
		parameters: {
			method: 'POST',
			url: `${LOGISX_BASE}/api/n8n/extract-pdf-via-gemini`,
			sendHeaders: true,
			headerParameters: {
				parameters: [
					{ name: 'x-webhook-secret', value: WEBHOOK_SECRET },
					{ name: 'Content-Type', value: 'application/json' },
				],
			},
			sendBody: true,
			contentType: 'json',
			specifyBody: 'json',
			jsonBody: '={{ JSON.stringify({ pdf_base64: $json.pdf_base64 }) }}',
			options: {
				timeout: 60000,
				response: { response: { responseFormat: 'json' } },
			},
		},
	};

	const checkNode = {
		id: uuid(),
		name: CHECK_NODE,
		type: 'n8n-nodes-base.if',
		typeVersion: 2.2,
		position: [rx + 672, ry + 360],
		parameters: {
			conditions: {
				options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
				conditions: [
					{
						id: uuid(),
						leftValue: "={{ ($json.output && $json.output['Load Number'] || '').toString().trim() }}",
						rightValue: '',
						operator: { type: 'string', operation: 'notEmpty', singleValue: true },
					},
				],
				combinator: 'and',
			},
			options: {},
		},
	};

	wf.nodes.push(prepareNode, geminiNode, checkNode);

	// Rewire: FALSE branch of Markdown Quality OK? — was Build Email Context,
	// now goes through the Gemini fallback chain first.
	wf.connections['Markdown Quality OK?'] = {
		main: [
			[{ node: 'Information Extractor', type: 'main', index: 0 }],
			[{ node: PREPARE_NODE, type: 'main', index: 0 }],
		],
	};

	wf.connections[PREPARE_NODE] = {
		main: [[{ node: GEMINI_NODE, type: 'main', index: 0 }]],
	};

	// Gemini HTTP Request: success → check Load Number, error → Build Email Context
	wf.connections[GEMINI_NODE] = {
		main: [
			[{ node: CHECK_NODE, type: 'main', index: 0 }],
			[{ node: 'Build Email Context', type: 'main', index: 0 }],
		],
	};

	wf.connections[CHECK_NODE] = {
		main: [
			[{ node: 'Normalize Load Fields', type: 'main', index: 0 }],
			[{ node: 'Build Email Context', type: 'main', index: 0 }],
		],
	};

	console.log(`Pushing patched workflow with 3 new nodes (${PREPARE_NODE} → ${GEMINI_NODE} → ${CHECK_NODE})...`);
	await api('PUT', `/workflows/${WORKFLOW_ID}`, buildPutPayload(wf));
	console.log('OK. Active executions will pick up the change immediately.');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
