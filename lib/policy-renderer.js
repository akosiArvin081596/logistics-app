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

// Brand logo embedded as a data URI so the rendered PDF is self-contained
// (Puppeteer setContent has no base URL, and we want dev/prod parity).
// Source of truth: <repo-root>/logo.png — the canonical invoice logo
// supplied by the client.
const LOGO_PATH = path.join(__dirname, "..", "logo.png");
const LOGO_DATA_URI = fs.existsSync(LOGO_PATH)
	? `data:image/png;base64,${fs.readFileSync(LOGO_PATH).toString("base64")}`
	: "";

const DOC_FILES = {
	contractor_agreement: "contractor-agreement.html",
	equipment_policy: "equipment-policy.html",
	mobile_policy: "mobile-policy.html",
	substance_policy: "substance-policy.html",
	service_invoice: "service-invoice.html",
	service_invoice_owner_op: "service-invoice-owner-op.html",
	service_invoice_manual: "service-invoice-manual.html",
	// Investor docs — HTML templates will land when user finishes drafting
	master_agreement: "master-agreement.html",
	vehicle_lease: "vehicle-lease.html",
};

async function renderPolicy(docKey, data = {}) {
	const fileName = DOC_FILES[docKey];
	if (!fileName) throw new Error(`Unknown onboarding doc: ${docKey}`);
	const filePath = path.join(TEMPLATE_DIR, fileName);
	if (!fs.existsSync(filePath)) throw new Error(`Template missing: ${filePath}`);

	let html = fs.readFileSync(filePath, "utf-8");
	html = html.replace(/\{\{LOGO_SRC\}\}/g, LOGO_DATA_URI);
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
			const {
				text,
				checkboxesById,
				checkboxesByLabel,
				dayCompletedByIndex,
				signatureImage,
				signatureLabelForImage,
			} = fields;

			// --- 1. Fill text inputs by aria-label ---
			// Signature image replacement is EXPLICIT — only the label matching
			// `signatureLabelForImage` gets the drawn image. Every other signature
			// slot (counter-signer name, recipient, manager, lessor) stays as typed
			// text so the drawn signature doesn't end up on both sides of a contract.
			if (text) {
				for (const [label, value] of Object.entries(text)) {
					const el = document.querySelector(`[aria-label="${CSS.escape(label)}"]`);
					if (!el) continue;

					const shouldEmbedImage =
						signatureImage &&
						signatureLabelForImage &&
						label === signatureLabelForImage;

					if (shouldEmbedImage) {
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

			// --- 4b. Hide adjustment row when there's no adjustment ---
			// Templates include a [data-show-when-adjusted] row that holds the
			// "ADMIN ADJUSTMENT: +$X" line. The text-fill loop above leaves the
			// inner amount cell empty when adjustment is 0; without this step the
			// label row would render with blank cells.
			document.querySelectorAll('[data-show-when-adjusted]').forEach((row) => {
				const amt = row.querySelector('[aria-label="Adjustment amount"]');
				const amtText = (amt && amt.textContent || '').trim();
				if (!amtText) row.style.display = 'none';
			});
		}, fields);

		// --- 5a. Clone table rows (owner-op loads/expenses, manual line items) ---
		// Each target tbody ships with a single template <tr>; we replace it with
		// one row per item in the data array. Empty arrays render a placeholder
		// row so the table doesn't look broken. Legacy loadsRows/expensesRows
		// keys map to the owner-op template's fixed tbody ids; mappers can also
		// pass a generic fields.tableRows = [{ tbodyId, rows, cellCount, emptyText }]
		// (used by service_invoice_manual for its line-item + deduction tables).
		const tableFills = [];
		if (fields.loadsRows !== undefined) {
			tableFills.push({ tbodyId: "loads-rows", rows: fields.loadsRows, cellCount: 3, emptyText: "(no completed loads this week)" });
		}
		if (fields.expensesRows !== undefined) {
			tableFills.push({ tbodyId: "expenses-rows", rows: fields.expensesRows, cellCount: 4, emptyText: "(no fuel or maintenance expenses this week)" });
		}
		if (Array.isArray(fields.tableRows)) tableFills.push(...fields.tableRows);
		if (tableFills.length) {
			await page.evaluate((tables) => {
				function fillTbody(tbodyId, rows, cellCount, emptyText) {
					const tbody = document.getElementById(tbodyId);
					if (!tbody) return;
					const template = tbody.querySelector("tr");
					if (!template) return;
					tbody.innerHTML = "";
					if (!rows || rows.length === 0) {
						const tr = document.createElement("tr");
						tr.className = "empty-row";
						const td = document.createElement("td");
						td.setAttribute("colspan", String(cellCount));
						td.textContent = emptyText;
						tr.appendChild(td);
						tbody.appendChild(tr);
						return;
					}
					rows.forEach((row) => {
						const tr = template.cloneNode(true);
						const cells = tr.querySelectorAll("td .cell-text");
						cells.forEach((span, j) => {
							span.textContent = row[j] == null ? "" : String(row[j]);
						});
						tbody.appendChild(tr);
					});
				}
				for (const t of tables) {
					fillTbody(t.tbodyId, t.rows, t.cellCount, t.emptyText);
				}
			}, tableFills);
		}

		// --- 5b. Clone vehicle rows for Exhibit A (master_agreement with 2+ trucks) ---
		if (fields.vehicles && fields.vehicles.length > 1) {
			await page.evaluate((vehicles) => {
				// Find the Exhibit A vehicle table — it's the table with a <th> containing "Year"
				const tables = document.querySelectorAll("table");
				let vehicleTable = null;
				for (const t of tables) {
					const th = t.querySelector("th");
					if (th && /year/i.test(th.textContent)) { vehicleTable = t; break; }
				}
				if (!vehicleTable) return;
				const tbody = vehicleTable.querySelector("tbody");
				if (!tbody) return;
				const templateRow = tbody.querySelector("tr");
				if (!templateRow) return;

				// Vehicles[0] is already filled by the text field mapper.
				// Clone a new row for each additional vehicle.
				for (let i = 1; i < vehicles.length; i++) {
					const v = vehicles[i];
					const row = templateRow.cloneNode(true);
					const cells = row.querySelectorAll("td");
					// Order matches template: Year, Make, Model, VIN
					const vals = [v.year, v.make, v.model, v.vin];
					cells.forEach((td, j) => {
						const input = td.querySelector("input");
						if (input && vals[j] != null) {
							input.setAttribute("value", String(vals[j]));
							input.value = String(vals[j]);
							// Remove aria-label to avoid duplicate slot matching
							input.removeAttribute("aria-label");
						}
					});
					tbody.appendChild(row);
				}
			}, fields.vehicles);
		}

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
