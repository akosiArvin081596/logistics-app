// ScanKit.io document-scanning API client.
//
// Single point of contact with api.scankit.io. Every other module in the app
// talks to ScanKit through this adapter so a future API change ripples through
// one file. Auth is an `Authorization: Bearer` header; the retry/backoff and
// 15s timeout mirror the Routemate (lib/routemate-client.js) + Gemini OCR
// patterns in server.js.
//
// Unlike the Routemate client, the success body here is BINARY (a JPEG or a
// PDF) and JSON is returned only on error — so we read an arrayBuffer on 2xx
// and parse JSON only to surface a useful error code/message.
//
// Spec reference: https://api.scankit.io/swagger.yaml (OpenAPI 3.0.0).
// Endpoint: POST /scan/crop (multipart/form-data). Credit-billed; ScanKit
// charges no credits on 4xx errors.

const DEFAULT_BASE_URL = "https://api.scankit.io";
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_RETRIES = 2;

const VALID_FILTERS = new Set(["original", "flat", "white"]);
const VALID_OCR_LANGS = new Set(["eng", "deu"]);

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

// Map a ScanKit HTTP status to a stable, caller-friendly error code so the
// server endpoint can translate failures without sniffing status numbers.
function codeForStatus(status) {
	switch (status) {
		case 400: return "SCANKIT_BAD_INPUT";
		case 402: return "SCANKIT_NO_CREDITS";
		case 403: return "SCANKIT_AUTH";
		case 429: return "SCANKIT_RATE_LIMIT";
		default: return "SCANKIT_ERROR";
	}
}

// POST /scan/crop — crop + deskew + lighting-correct a document photo.
// Returns { buffer, contentType, ext }. On 2xx the buffer is the processed
// JPEG (default) or a searchable PDF with an OCR text layer (when returnPdf is
// true). Throws an Error with .status and .code after retries are exhausted
// (or immediately on a non-429 4xx).
async function cropDocument({ apiKey, baseUrl } = {}, imageBuffer, opts = {}) {
	if (!apiKey) {
		const err = new Error("ScanKit API key not configured");
		err.code = "SCANKIT_NO_KEY";
		throw err;
	}
	if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
		const err = new Error("ScanKit requires a non-empty image buffer");
		err.code = "SCANKIT_BAD_INPUT";
		throw err;
	}

	const {
		outputWidth = 1536,
		filter = "white",
		segmentCount = 9,
		returnPdf = false,
		ocrLang = "eng",
	} = opts;

	// Clamp/whitelist every option — these flow from request bodies upstream.
	const safeFilter = VALID_FILTERS.has(filter) ? filter : "white";
	const safeLang = VALID_OCR_LANGS.has(ocrLang) ? ocrLang : "eng";
	const safeWidth = Math.min(2048, Math.max(512, Number(outputWidth) || 1536));
	const safeSegments = Math.min(50, Math.max(1, Number(segmentCount) || 9));

	const url = `${baseUrl || DEFAULT_BASE_URL}/scan/crop`;
	let lastErr = null;

	for (let attempt = 0; attempt <= DEFAULT_RETRIES; attempt++) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
		try {
			// Build a fresh multipart body each attempt — a consumed FormData body
			// can't be re-sent on retry. We deliberately do NOT set Content-Type:
			// fetch derives the multipart boundary from the FormData itself.
			const form = new FormData();
			form.append("file", new Blob([imageBuffer], { type: "image/jpeg" }), "scan.jpg");
			form.append("output_width", String(safeWidth));
			form.append("filter", safeFilter);
			form.append("segment_count", String(safeSegments));
			form.append("return_pdf", String(!!returnPdf));
			if (returnPdf) form.append("ocr_lang", safeLang);

			const resp = await fetch(url, {
				method: "POST",
				headers: { Authorization: `Bearer ${apiKey}` },
				body: form,
				signal: controller.signal,
			});

			if (!resp.ok) {
				// Errors are JSON: { errors: [{ code, title }] }.
				let detail = "";
				try {
					const body = await resp.json();
					const first = body && Array.isArray(body.errors) && body.errors[0];
					detail = (first && (first.title || first.code)) || "";
				} catch {
					detail = await resp.text().catch(() => "");
				}
				const err = new Error(`ScanKit ${resp.status}: ${String(detail).slice(0, 200)}`);
				err.status = resp.status;
				err.code = codeForStatus(resp.status);
				// Fail fast on 4xx (bad input / no credits / auth). Retry 429 + 5xx.
				if (resp.status >= 400 && resp.status < 500 && resp.status !== 429) throw err;
				lastErr = err;
				await sleep(500 * Math.pow(2, attempt));
				continue;
			}

			const contentType = (resp.headers.get("content-type") || "").toLowerCase();
			const isPdf = contentType.includes("pdf");
			const buffer = Buffer.from(await resp.arrayBuffer());
			if (!buffer.length) {
				const err = new Error("ScanKit returned an empty body");
				err.code = "SCANKIT_ERROR";
				throw err;
			}
			return {
				buffer,
				contentType: isPdf ? "application/pdf" : "image/jpeg",
				ext: isPdf ? ".pdf" : ".jpg",
			};
		} catch (err) {
			lastErr = err;
			// Never retry our own guard errors or a fail-fast 4xx.
			if (err.code === "SCANKIT_NO_KEY" || err.code === "SCANKIT_BAD_INPUT") throw err;
			if (err.status && err.status >= 400 && err.status < 500 && err.status !== 429) throw err;
			await sleep(500 * Math.pow(2, attempt));
		} finally {
			clearTimeout(timer);
		}
	}
	throw lastErr || new Error("ScanKit request failed");
}

module.exports = { cropDocument };
