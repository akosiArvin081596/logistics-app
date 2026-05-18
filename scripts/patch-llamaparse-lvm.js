/**
 * Patches the "Dispatch v2 (Fixed)" n8n workflow so the LlamaParse Upload
 * node uses vision-LLM mode (parse_mode=parse_page_with_lvm).
 *
 * Why: image-only / scanned rate-con PDFs (Bison Transport order #6970978
 * on 2026-05-18) come back as ~15 chars of header text because the default
 * cheap text-extract mode doesn't OCR images. Quality validation then
 * rightly rejects the parse and the workflow falls back to body-only
 * extraction — which loses pickup/dropoff addresses and rate.
 *
 * Vision-LLM mode handles both text and image PDFs at higher credit cost
 * (~15 credits/page vs ~1). The existing "Markdown Quality OK?" + body
 * fallback chain stays in place as a safety net.
 *
 * Run:  N8N_API_KEY=... node scripts/patch-llamaparse-lvm.js
 */

const N8N_BASE = process.env.N8N_BASE_URL || 'https://sandhub.app.n8n.cloud';
const WORKFLOW_ID = process.env.N8N_WORKFLOW_ID || 'ydFgTSFpKTyyZbXW';
const API_KEY = process.env.N8N_API_KEY;
if (!API_KEY) { console.error('N8N_API_KEY env var required'); process.exit(1); }

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

(async () => {
	console.log('Fetching workflow…');
	const wf = await api('GET', `/workflows/${WORKFLOW_ID}`);
	const upload = wf.nodes.find(n => n.name === 'LlamaParse Upload');
	if (!upload) throw new Error('LlamaParse Upload node not found');

	const params = upload.parameters.bodyParameters?.parameters || [];
	const ensureField = (name, value) => {
		const existing = params.find(p => p.name === name);
		if (existing) {
			existing.value = value;
			existing.parameterType = existing.parameterType || 'formData';
		} else {
			params.push({ parameterType: 'formData', name, value });
		}
	};

	ensureField('parse_mode', 'parse_page_with_lvm');
	// Belt-and-suspenders: ensure OCR is on for any image regions the LVM
	// pipeline still defers to OCR for. Default is already on but make it explicit.
	ensureField('disable_ocr', 'false');

	upload.parameters.bodyParameters = upload.parameters.bodyParameters || {};
	upload.parameters.bodyParameters.parameters = params;

	const allowed = ['name', 'nodes', 'connections', 'settings', 'staticData'];
	const payload = {};
	for (const k of allowed) if (wf[k] !== undefined) payload[k] = wf[k];

	if (payload.settings) {
		const allowedSettings = ['saveExecutionProgress','saveManualExecutions','saveDataErrorExecution','saveDataSuccessExecution','executionTimeout','errorWorkflow','timezone','executionOrder'];
		const clean = {};
		for (const k of allowedSettings) if (payload.settings[k] !== undefined) clean[k] = payload.settings[k];
		payload.settings = clean;
	}

	console.log('Pushing patched workflow…');
	await api('PUT', `/workflows/${WORKFLOW_ID}`, payload);
	console.log('OK. LlamaParse Upload now uses parse_mode=parse_page_with_lvm.');
	console.log('Active executions will pick up the change on the next trigger.');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
