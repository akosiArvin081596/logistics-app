// Per-doc mappings from the data object the old generators used to receive
// into { text, checkboxes, signatureImage, days } descriptors the renderer
// understands. All text fields are keyed by the `aria-label` attribute of the
// corresponding <input> in the HTML template. Checkboxes are keyed by either
// `aria-label` (for service invoice) or `id` (for contractor agreement).
//
// Adding a new field = add a line here + add a corresponding <input> in the HTML.

const COMPANY = {
	recipientName: "Arvin Edubas",
	recipientTitle: "CEO, LogisX Inc.",
};

const POLICY_FIELD_MAPS = {
	// --- Equipment Policy (simplest doc) ---
	equipment_policy(data) {
		return {
			text: {
				"Full name": data.fullName || "",
				"Provider signature": data.signatureText || "",
				Date: data.effectiveDate || "",
			},
			signatureImage: data.signatureImage || null,
		};
	},

	// --- Mobile Policy ---
	mobile_policy(data) {
		return {
			text: {
				"Full name": data.fullName || "",
				"Driver signature": data.signatureText || "",
				"Driver date": data.effectiveDate || "",
				"Received by signature": COMPANY.recipientName,
				"Received by title": COMPANY.recipientTitle,
			},
			signatureImage: data.signatureImage || null,
		};
	},

	// --- Substance Policy ---
	substance_policy(data) {
		return {
			text: {
				"Driver/Associate name": data.fullName || "",
				Name: data.fullName || "",
				// Substance policy combines signature + date into one field
				"Driver signature and date": data.signatureText
					? `${data.signatureText} — ${data.effectiveDate || ""}`
					: "",
				"Approved by": COMPANY.recipientName,
				"Received by signature": COMPANY.recipientName,
			},
			signatureImage: data.signatureImage || null,
		};
	},

	// --- Contractor Agreement (heaviest doc: banking + checkboxes) ---
	contractor_agreement(data) {
		return {
			text: {
				"Effective date": data.effectiveDate || "",
				"Contractor name": data.fullName || "",
				"Contractor address": data.address || "",
				"Recipient signature": COMPANY.recipientName,
				"Recipient date": data.effectiveDate || "",
				"Contractor signature": data.signatureText || "",
				"Contractor date": data.effectiveDate || "",
				"Contractor printed name": data.fullName || "",
				"Exhibit A agreement date": data.effectiveDate || "",
				"Check: Name on account": data.checkName || "",
				"ACH: Name of bank": data.bankName || "",
				"Bank address": data.bankAddress || "",
				"Bank phone number": data.bankPhone || "",
				"Bank routing number": data.bankRouting || "",
				"Bank account number": data.bankAccount || "",
				"Names on account": data.bankAcctName || "",
				"Type of account": data.accountType || "",
				Date: data.effectiveDate || "",
			},
			checkboxesById: {
				"pay-check": data.paymentMethod === "check",
				"pay-ach": data.paymentMethod === "ach",
			},
			signatureImage: data.signatureImage || null,
		};
	},

	// --- Weekly Service Invoice (dynamic day rows) ---
	// The HTML template's own <script> generates 7 day rows (Saturday–Friday) on load.
	// The renderer lets that script run first, then fills the aria-labels via page.evaluate.
	// data.days is expected to be a map: { Saturday: {loadBol, total}, Sunday: {...}, ... }
	service_invoice(data) {
		const days = data.days || {};
		const dayText = {};
		for (const dayName of [
			"Saturday",
			"Sunday",
			"Monday",
			"Tuesday",
			"Wednesday",
			"Thursday",
			"Friday",
		]) {
			const row = days[dayName] || {};
			dayText[`${dayName} Load/BOL number`] = row.loadBol || "";
			dayText[`${dayName} total`] = row.total != null ? Number(row.total).toFixed(2) : "";
		}
		const totalDueNum =
			typeof data.totalDue === "number" ? data.totalDue : parseFloat(data.totalDue || 0);
		return {
			text: {
				"Business name": data.businessName || data.driverName || "",
				"Provider name": data.driverName || "",
				"Provider address": data.providerAddress || "",
				"Provider phone": data.providerPhone || "",
				"Invoice number suffix": data.invoiceNumberSuffix || "",
				"Submission date": data.submissionDate || "",
				"Provider signature": data.driverName || "",
				"Signature date": data.signatureDate || data.submissionDate || "",
				"Total due": totalDueNum ? totalDueNum.toFixed(2) : "",
				"Bank on file": data.bankOnFile || "",
				...dayText,
			},
			checkboxesByLabel: {
				Checking: data.accountType === "checking",
				Savings: data.accountType === "savings",
				"Verified ELD Data": !!data.hasEldData,
				"Signed Bills of Lading": !!data.hasBol,
				"Daily Vehicle Inspection Reports": !!data.hasDvir,
				"Fuel Receipts": !!data.hasFuelReceipts,
			},
			// Per-day "Completed" checkboxes — rendered by the template script.
			// Renderer sets these via DOM after the script runs.
			dayCompletedByIndex: (() => {
				const order = [
					"Saturday",
					"Sunday",
					"Monday",
					"Tuesday",
					"Wednesday",
					"Thursday",
					"Friday",
				];
				return order.map((name) => {
					const row = days[name] || {};
					return { completed: !!row.completed, na: !!row.na };
				});
			})(),
			signatureImage: data.signatureImage || null,
		};
	},
};

module.exports = POLICY_FIELD_MAPS;
