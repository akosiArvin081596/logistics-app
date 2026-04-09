// Main policy renderer. Loads an HTML template, lets its own scripts execute
// (important for service-invoice.html which generates 7 day rows dynamically),
// then fills all <input> values and checkbox states via DOM manipulation inside
// the Puppeteer page context, then exports to PDF.
//
// Unified path for all 5 driver docs — no cheerio, no static substitution,
// one code path that handles both static and JS-generated DOM trees.

const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");
const { getBrowser } = require("./pdf-browser");
const POLICY_FIELD_MAPS = require("./policy-field-maps");

const TEMPLATE_DIR = path.join(__dirname, "..", "onboarding-templates", "policy");

const DOC_FILES = {
	contractor_agreement: "contractor-agreement.html",
	equipment_policy: "equipment-policy.html",
	mobile_policy: "mobile-policy.html",
	substance_policy: "substance-policy.html",
	service_invoice: "service-invoice.html",
	// Investor docs — HTML templates will land when user finishes drafting
	master_agreement: "master-agreement.html",
	vehicle_lease: "vehicle-lease.html",
};

async function renderPolicy(docKey, data = {}) {
	const fileName = DOC_FILES[docKey];
	if (!fileName) throw new Error(`Unknown onboarding doc: ${docKey}`);
	const filePath = path.join(TEMPLATE_DIR, fileName);
	if (!fs.existsSync(filePath)) throw new Error(`Template missing: ${filePath}`);

	const html = fs.readFileSync(filePath, "utf-8");
	const mapper = POLICY_FIELD_MAPS[docKey];
	if (!mapper) throw new Error(`No field map registered for: ${docKey}`);
	const fields = mapper(data);

	const browser = await getBrowser();
	const page = await browser.newPage();
	try {
		// Use setContent so we don't need a running HTTP server to serve the template.
		await page.setContent(html, { waitUntil: "networkidle0", timeout: 30000 });

		// Wait for Google Fonts to finish loading before rendering.
		// Without this, the first render uses Arial fallback and the text looks wrong.
		await page.evaluateHandle(() => document.fonts.ready);

		// Let any template scripts run their work (service-invoice.html generates 7 rows)
		// then populate every field. All DOM work happens inside the browser context.
		await page.evaluate((fields) => {
			const { text, checkboxesById, checkboxesByLabel, dayCompletedByIndex, signatureImage } = fields;

			// --- 1. Fill text inputs by aria-label (and optionally swap in signature image) ---
			if (text) {
				for (const [label, value] of Object.entries(text)) {
					const el = document.querySelector(`[aria-label="${CSS.escape(label)}"]`);
					if (!el) continue;

					const isSignature = /signature/i.test(label) && !/printed name/i.test(label) && !/signature and date/i.test(label);
					if (isSignature && signatureImage) {
						// Replace input with an <img> so the drawn signature renders in-place
						const img = document.createElement("img");
						img.src = signatureImage;
						img.alt = "Signature";
						img.style.cssText =
							"max-height:40px; display:inline-block; vertical-align:middle; padding:0 4px; border-bottom:1px solid #000;";
						el.replaceWith(img);
					} else if (el.tagName === "INPUT") {
						// Set both the attribute AND the value property so the rendered PDF
						// shows the value regardless of how Chromium decides to paint it.
						el.setAttribute("value", value == null ? "" : String(value));
						el.value = value == null ? "" : String(value);
					} else {
						el.textContent = value == null ? "" : String(value);
					}
				}
			}

			// --- 2. Checkboxes by element id (contractor agreement payment method) ---
			if (checkboxesById) {
				for (const [id, checked] of Object.entries(checkboxesById)) {
					const el = document.getElementById(id);
					if (!el) continue;
					if (checked) {
						el.setAttribute("checked", "checked");
						el.checked = true;
					} else {
						el.removeAttribute("checked");
						el.checked = false;
					}
				}
			}

			// --- 3. Checkboxes by aria-label (service invoice compliance + account type) ---
			if (checkboxesByLabel) {
				for (const [label, checked] of Object.entries(checkboxesByLabel)) {
					const el = document.querySelector(`input[type="checkbox"][aria-label="${CSS.escape(label)}"]`);
					if (!el) continue;
					if (checked) {
						el.setAttribute("checked", "checked");
						el.checked = true;
					} else {
						el.removeAttribute("checked");
						el.checked = false;
					}
				}
			}

			// --- 4. Per-day completed/N-A checkboxes (service invoice only) ---
			// The template script creates them with data-row="0"..."6".
			if (dayCompletedByIndex && Array.isArray(dayCompletedByIndex)) {
				dayCompletedByIndex.forEach((row, i) => {
					const completed = document.querySelector(`input.completed[data-row="${i}"]`);
					if (completed) {
						if (row.completed) {
							completed.setAttribute("checked", "checked");
							completed.checked = true;
						} else {
							completed.removeAttribute("checked");
							completed.checked = false;
						}
					}
					const na = document.querySelector(`input.na[data-row="${i}"]`);
					if (na) {
						if (row.na) {
							na.setAttribute("checked", "checked");
							na.checked = true;
						} else {
							na.removeAttribute("checked");
							na.checked = false;
						}
					}
				});
			}
		}, fields);

		const pdf = await page.pdf({
			format: "Letter",
			printBackground: true,
			// HTML uses @page { margin: 1in } so Puppeteer's own margin is 0.
			margin: { top: 0, bottom: 0, left: 0, right: 0 },
			preferCSSPageSize: true,
		});
		// Puppeteer >=22 returns a Uint8Array, not a Buffer. Express's res.send()
		// JSON-serializes Uint8Arrays (checks Buffer.isBuffer() which returns false).
		// Always wrap so both res.send and fs.writeFileSync receive a proper Buffer.
		return Buffer.from(pdf);
	} finally {
		await page.close().catch(() => {});
	}
}

module.exports = { renderPolicy };
