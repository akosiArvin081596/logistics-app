const { BLUE, BLACK, MARGIN, PAGE_W, createPdfDoc } = require("./pdf-helpers");

const GRAY = "#6b7280";
const LIGHT_GRAY = "#d1d5db";
const W = PAGE_W - 2 * MARGIN; // usable width

/**
 * Generate a W-9 form PDF that faithfully reproduces the IRS layout
 * with investor data pre-filled.
 * @param {Object} data
 * @returns {Promise<Buffer>}
 */
function generateW9(data) {
	const { doc, getBuffer } = createPdfDoc({ margin: 36 });
	const {
		legalName = "", dba = "", entityType = "",
		address = "", einSsn = "",
		taxClassification = "",
		effectiveDate = "", signatureText = "", signatureImage,
		signedAt = "",
	} = data;

	const B = "Helvetica-Bold";
	const R = "Helvetica";
	const BI = "Helvetica-BoldOblique";
	const LM = 40; // left margin
	const RM = PAGE_W - 40; // right margin
	const FW = RM - LM; // full width

	// ─── HEADER ───
	doc.rect(LM, 36, FW, 75).lineWidth(1.5).stroke("#000");

	// Left column: Form info
	doc.font(R).fontSize(7).fillColor(BLACK);
	doc.text("Form", LM + 6, 40, { width: 55 });
	doc.font(B).fontSize(22).text("W-9", LM + 6, 48, { width: 55 });
	doc.font(R).fontSize(6.5);
	doc.text("(Rev. October 2018)", LM + 4, 74, { width: 60 });
	doc.text("Department of the Treasury", LM + 4, 82, { width: 62 });
	doc.text("Internal Revenue Service", LM + 4, 89, { width: 62 });

	// Separator line
	doc.moveTo(LM + 68, 36).lineTo(LM + 68, 111).lineWidth(0.5).stroke("#000");

	// Center: Title
	doc.font(B).fontSize(12).fillColor(BLACK);
	doc.text("Request for Taxpayer", LM + 78, 42, { width: 320, align: "center" });
	doc.text("Identification Number and Certification", LM + 78, 56, { width: 320, align: "center" });
	doc.font(BI).fontSize(8);
	doc.text("Go to www.irs.gov/FormW9 for instructions and the latest information.", LM + 78, 74, { width: 320, align: "center" });

	// Right separator
	doc.moveTo(RM - 100, 36).lineTo(RM - 100, 111).lineWidth(0.5).stroke("#000");

	// Right column: Give to requester
	doc.font(R).fontSize(7).fillColor(BLACK);
	doc.text("Give Form to the", RM - 95, 45, { width: 90, align: "center" });
	doc.text("requester. Do not", RM - 95, 54, { width: 90, align: "center" });
	doc.text("send to the IRS.", RM - 95, 63, { width: 90, align: "center" });

	let y = 118;

	// ─── LINE 1: Name ───
	doc.font(R).fontSize(7).fillColor(BLACK);
	doc.text("1  Name (as shown on your income tax return). Name is required on this line; do not leave this line blank.", LM + 4, y);
	y += 10;
	doc.rect(LM, y, FW, 20).lineWidth(0.5).stroke(LIGHT_GRAY);
	if (legalName) {
		doc.font(B).fontSize(10).fillColor(BLUE);
		doc.text(legalName, LM + 6, y + 5, { width: FW - 12 });
	}
	doc.fillColor(BLACK);
	y += 22;

	// ─── LINE 2: Business name / DBA ───
	doc.font(R).fontSize(7);
	doc.text("2  Business name/disregarded entity name, if different from above", LM + 4, y);
	y += 10;
	doc.rect(LM, y, FW, 20).lineWidth(0.5).stroke(LIGHT_GRAY);
	if (dba) {
		doc.font(R).fontSize(10).fillColor(BLUE);
		doc.text(dba, LM + 6, y + 5, { width: FW - 12 });
	}
	doc.fillColor(BLACK);
	y += 22;

	// ─── LINE 3: Federal tax classification ───
	doc.font(R).fontSize(7);
	doc.text("3  Check appropriate box for federal tax classification of the person whose name is entered on line 1. Check only the following seven boxes.", LM + 4, y);
	y += 12;

	const checkboxes = [
		{ label: "Individual/sole proprietor or single-member LLC", value: "Sole Prop", x: LM + 6 },
		{ label: "C Corporation", value: "C-Corp", x: LM + 6 },
		{ label: "S Corporation", value: "S-Corp", x: LM + 100 },
		{ label: "Partnership", value: "Partnership", x: LM + 190 },
		{ label: "Trust/estate", value: "Trust", x: LM + 270 },
	];

	// Individual / sole prop (first row)
	const cb0 = checkboxes[0];
	doc.rect(cb0.x, y, 8, 8).lineWidth(0.5).stroke("#000");
	if (entityType === cb0.value) {
		doc.font(B).fontSize(9).fillColor(BLUE).text("X", cb0.x + 1, y - 1);
		doc.fillColor(BLACK);
	}
	doc.font(R).fontSize(7).fillColor(BLACK);
	doc.text(cb0.label, cb0.x + 12, y + 1);
	y += 14;

	// Row 2: C-Corp, S-Corp, Partnership, Trust/estate
	const row2 = checkboxes.slice(1);
	row2.forEach(cb => {
		doc.rect(cb.x, y, 8, 8).lineWidth(0.5).stroke("#000");
		if (entityType === cb.value) {
			doc.font(B).fontSize(9).fillColor(BLUE).text("X", cb.x + 1, y - 1);
			doc.fillColor(BLACK);
		}
		doc.font(R).fontSize(7).fillColor(BLACK);
		doc.text(cb.label, cb.x + 12, y + 1);
	});

	// LLC checkbox
	const llcX = LM + 350;
	doc.rect(llcX, y, 8, 8).lineWidth(0.5).stroke("#000");
	if (entityType === "LLC") {
		doc.font(B).fontSize(9).fillColor(BLUE).text("X", llcX + 1, y - 1);
		doc.fillColor(BLACK);
	}
	doc.font(R).fontSize(7).fillColor(BLACK);
	doc.text("Limited liability company. Enter the tax classification (C=C corporation, S=S corporation, P=Partnership) >", llcX + 12, y + 1, { width: 170 });

	// Tax classification letter
	if (entityType === "LLC" && taxClassification) {
		const tcMap = { "C-Corp": "C", "S-Corp": "S", "Partnership": "P", "Individual/LLC": "P" };
		const letter = tcMap[taxClassification] || "";
		if (letter) {
			doc.font(B).fontSize(10).fillColor(BLUE);
			doc.text(letter, RM - 20, y + 1);
			doc.fillColor(BLACK);
		}
	}

	y += 20;

	// Other checkbox
	doc.rect(LM + 6, y, 8, 8).lineWidth(0.5).stroke("#000");
	if (entityType === "Other") {
		doc.font(B).fontSize(9).fillColor(BLUE).text("X", LM + 7, y - 1);
		doc.fillColor(BLACK);
	}
	doc.font(R).fontSize(7).fillColor(BLACK);
	doc.text("Other (see instructions) >", LM + 18, y + 1);

	y += 16;

	// ─── LINE 4: Exemptions ───
	doc.font(R).fontSize(7);
	doc.text("4  Exemptions (codes apply only to certain entities, not individuals; see instructions on page 3):", LM + 4, y);
	y += 10;
	doc.rect(LM, y, FW, 20).lineWidth(0.5).stroke(LIGHT_GRAY);
	doc.font(R).fontSize(6.5);
	doc.text("Exempt payee code (if any) ________", LM + 6, y + 3);
	doc.text("Exemption from FATCA reporting code (if any) ________", LM + 6, y + 12);
	doc.text("(Applies to accounts maintained outside the U.S.)", RM - 200, y + 12, { width: 200, align: "right" });
	y += 22;

	// ─── LINE 5: Address ───
	doc.font(R).fontSize(7);
	doc.text("5  Address (number, street, and apt. or suite no.) See instructions.", LM + 4, y);
	y += 10;
	doc.rect(LM, y, FW, 20).lineWidth(0.5).stroke(LIGHT_GRAY);
	if (address) {
		const parts = address.split(",").map(s => s.trim());
		doc.font(R).fontSize(9).fillColor(BLUE);
		doc.text(parts[0] || address, LM + 6, y + 5, { width: FW - 12 });
		doc.fillColor(BLACK);
	}
	y += 22;

	// ─── LINE 6: City, state, ZIP ───
	doc.font(R).fontSize(7);
	doc.text("6  City, state, and ZIP code", LM + 4, y);
	y += 10;
	doc.rect(LM, y, FW, 20).lineWidth(0.5).stroke(LIGHT_GRAY);
	if (address) {
		const parts = address.split(",").map(s => s.trim());
		if (parts.length > 1) {
			doc.font(R).fontSize(9).fillColor(BLUE);
			doc.text(parts.slice(1).join(", "), LM + 6, y + 5, { width: FW - 12 });
			doc.fillColor(BLACK);
		}
	}
	y += 22;

	// ─── LINE 7: Account numbers ───
	doc.font(R).fontSize(7);
	doc.text("7  List account number(s) here (optional)", LM + 4, y);
	y += 10;
	doc.rect(LM, y, FW, 20).lineWidth(0.5).stroke(LIGHT_GRAY);
	y += 26;

	// ─── PART I: TIN ───
	doc.rect(LM, y, FW, 16).fill("#e5e7eb").stroke("#000");
	doc.font(B).fontSize(9).fillColor(BLACK);
	doc.text("Part I", LM + 6, y + 3);
	doc.text("Taxpayer Identification Number (TIN)", LM + 50, y + 3);
	y += 18;

	doc.font(R).fontSize(7);
	doc.text("Enter your TIN in the appropriate box. The TIN provided must match the name given on line 1 to avoid backup withholding.", LM + 4, y, { width: 300 });
	y += 10;

	// SSN boxes
	doc.font(B).fontSize(8);
	doc.text("Social security number", RM - 200, y);
	y += 10;
	const ssnY = y;
	const ssnStartX = RM - 200;
	// Draw 9 boxes for SSN
	for (let i = 0; i < 9; i++) {
		const bx = ssnStartX + i * 22 + (i >= 3 ? 6 : 0) + (i >= 5 ? 6 : 0);
		doc.rect(bx, ssnY, 20, 18).lineWidth(0.5).stroke("#000");
	}
	// Dashes
	doc.font(B).fontSize(14);
	doc.text("–", ssnStartX + 64, ssnY + 1);
	doc.text("–", ssnStartX + 108, ssnY + 1);

	y += 24;

	doc.font(R).fontSize(7).text("or", LM + 4, y);
	y += 10;

	// EIN boxes
	doc.font(B).fontSize(8);
	doc.text("Employer identification number", RM - 200, y);
	y += 10;
	const einY = y;
	const einStartX = RM - 200;
	for (let i = 0; i < 9; i++) {
		const bx = einStartX + i * 22 + (i >= 2 ? 6 : 0);
		doc.rect(bx, einY, 20, 18).lineWidth(0.5).stroke("#000");
		// Fill in digits
		if (einSsn) {
			const digits = einSsn.replace(/\D/g, "");
			if (digits[i]) {
				doc.font(B).fontSize(12).fillColor(BLUE);
				doc.text(digits[i], bx + 5, einY + 2);
				doc.fillColor(BLACK);
			}
		}
	}
	// Dash
	doc.font(B).fontSize(14).fillColor(BLACK);
	doc.text("–", einStartX + 42, einY + 1);

	y += 26;

	// ─── PART II: Certification ───
	doc.rect(LM, y, FW, 16).fill("#e5e7eb").stroke("#000");
	doc.font(B).fontSize(9).fillColor(BLACK);
	doc.text("Part II", LM + 6, y + 3);
	doc.text("Certification", LM + 50, y + 3);
	y += 18;

	doc.font(R).fontSize(7).fillColor(BLACK);
	doc.text("Under penalties of perjury, I certify that:", LM + 4, y, { width: FW - 8 });
	y += 10;

	const certItems = [
		"1. The number shown on this form is my correct taxpayer identification number (or I am waiting for a number to be issued to me); and",
		"2. I am not subject to backup withholding because: (a) I am exempt from backup withholding, or (b) I have not been notified by the Internal Revenue Service (IRS) that I am subject to backup withholding as a result of a failure to report all interest or dividends, or (c) the IRS has notified me that I am no longer subject to backup withholding; and",
		"3. I am a U.S. citizen or other U.S. person (defined below); and",
		"4. The FATCA code(s) entered on this form (if any) indicating that I am exempt from FATCA reporting is correct.",
	];

	certItems.forEach(item => {
		doc.font(R).fontSize(6.5).fillColor(BLACK);
		doc.text(item, LM + 10, y, { width: FW - 20, lineGap: 1 });
		y = doc.y + 2;
	});

	y += 4;
	doc.font(B).fontSize(7);
	doc.text("Certification instructions.", LM + 4, y, { continued: true });
	doc.font(R).text(" You must cross out item 2 above if you have been notified by the IRS that you are currently subject to backup withholding because you have failed to report all interest and dividends on your tax return.");
	y = doc.y + 8;

	// ─── SIGNATURE LINE ───
	doc.moveTo(LM, y).lineTo(RM, y).lineWidth(1).stroke("#000");
	y += 4;

	doc.font(B).fontSize(8);
	doc.text("Sign", LM + 4, y);
	doc.text("Here", LM + 4, y + 10);

	const sigFieldX = LM + 40;
	const sigFieldW = (RM - sigFieldX) * 0.65;
	const dateFieldX = sigFieldX + sigFieldW + 10;
	const dateFieldW = RM - dateFieldX;

	// Signature field
	doc.font(R).fontSize(7);
	doc.text("Signature of", sigFieldX, y);
	doc.text("U.S. person >", sigFieldX, y + 8);
	y += 18;
	doc.moveTo(sigFieldX, y + 14).lineTo(sigFieldX + sigFieldW, y + 14).lineWidth(0.5).stroke("#000");

	if (signatureText) {
		const byW = doc.font(B).fontSize(10).widthOfString(signatureText);
		doc.font(B).fontSize(10).fillColor(BLUE);
		doc.text(signatureText, sigFieldX + 4, y + 2);
		doc.fillColor(BLACK);
		if (signatureImage) {
			try {
				const sigBytes = Buffer.from(signatureImage.replace(/^data:image\/\w+;base64,/, ""), "base64");
				doc.image(sigBytes, sigFieldX + byW + 14, y - 8, { width: 120, height: 35 });
			} catch { /* skip */ }
		}
	}

	// Date field
	doc.font(R).fontSize(7).fillColor(BLACK);
	doc.text("Date >", dateFieldX, y - 18);
	doc.moveTo(dateFieldX, y + 14).lineTo(RM, y + 14).lineWidth(0.5).stroke("#000");
	if (effectiveDate) {
		doc.font(R).fontSize(9).fillColor(BLUE);
		doc.text(effectiveDate, dateFieldX + 4, y + 2);
		doc.fillColor(BLACK);
	}

	y += 20;
	if (signedAt) {
		doc.font(R).fontSize(6.5).fillColor(GRAY);
		doc.text(`Electronically signed on ${signedAt}`, sigFieldX, y);
		doc.fillColor(BLACK);
	}

	// ─── FOOTER ───
	y += 16;
	doc.moveTo(LM, y).lineTo(RM, y).lineWidth(0.5).stroke(LIGHT_GRAY);
	y += 6;
	doc.font(R).fontSize(6).fillColor(GRAY);
	doc.text("Cat. No. 10231X", LM + 4, y);
	doc.text("Form W-9 (Rev. 10-2018)", RM - 120, y, { width: 120, align: "right" });

	doc.end();
	return getBuffer();
}

module.exports = { generateW9 };
