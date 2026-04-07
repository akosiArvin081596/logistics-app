const PDFDocument = require("pdfkit");

const BLUE = "#1a56db";
const BLACK = "#1a1d27";
const MARGIN = 50;
const PAGE_W = 612;

function generateEquipmentPolicy(data) {
	return new Promise((resolve, reject) => {
		const doc = new PDFDocument({ size: "LETTER", margin: MARGIN, bufferPages: true });
		const chunks = [];
		doc.on("data", (c) => chunks.push(c));
		doc.on("end", () => resolve(Buffer.concat(chunks)));
		doc.on("error", reject);

		const { fullName = "", effectiveDate = "", signatureImage } = data;
		const B = "Helvetica-Bold";
		const R = "Helvetica";
		const W = PAGE_W - 2 * MARGIN;

		function sectionHeader(text) {
			if (doc.y > 680) doc.addPage();
			doc.moveDown(0.8);
			doc.font(B).fontSize(13).fillColor(BLACK).text(text, MARGIN, doc.y, { width: W });
			doc.moveDown(0.4);
		}

		function para(text) {
			doc.font(R).fontSize(10).fillColor(BLACK).text(text, MARGIN, doc.y, { width: W, lineGap: 2 });
		}

		function bullet(label, text) {
			if (doc.y > 700) doc.addPage();
			const x = MARGIN + 20;
			const w = W - 20;
			doc.font(R).fontSize(10).fillColor(BLACK);
			doc.text("\u2022  ", x, doc.y, { width: w, continued: true });
			if (label) {
				doc.font(B).text(label, { continued: true });
				doc.font(R).text(` ${text}`, { width: w, lineGap: 2 });
			} else {
				doc.text(text, { width: w, lineGap: 2 });
			}
			doc.moveDown(0.2);
		}

		// ====== PAGE 1 ======
		doc.font(B).fontSize(16).fillColor(BLACK);
		doc.text("LOGISX INC. EQUIPMENT USE AND CARE POLICY", { align: "center" });
		doc.moveDown(0.8);

		// Section 1
		sectionHeader("1. PURPOSE AND SCOPE");
		doc.font(R).fontSize(10).fillColor(BLACK);
		doc.text("This policy outlines the standards for the use, care, and preservation of commercial motor vehicle (CMV) equipment, including tractors and trailers, owned by ", MARGIN, doc.y, { width: W, continued: true, lineGap: 2 });
		doc.font(B).text("LogisX Inc.", { continued: true });
		doc.font(R).text(' (the "Company") and utilized by the ', { continued: true });
		doc.font(B).text("Contracted Service Provider", { continued: true });
		doc.font(R).text(" (the \"Provider\"). As an independent business entity, the Provider is granted access to Company equipment solely to facilitate the safe and prompt transport of cargo for Carrier\u2019s customers.", { width: W, lineGap: 2 });

		// Section 2
		sectionHeader("2. STANDARDS OF PROFESSIONAL CARE");
		doc.font(R).fontSize(10);
		doc.text("The Provider is expected to maintain all Company property in a safe and prudent manner. While the Company remains responsible for standard \"wear and tear\" resulting from normal, legal operation, the Provider shall be held ", MARGIN, doc.y, { width: W, continued: true, lineGap: 2 });
		doc.font(B).text("personally and financially liable", { continued: true });
		doc.font(R).text(" for any damage, destruction, or loss of equipment value resulting from:", { width: W, lineGap: 2 });
		doc.moveDown(0.3);

		bullet("Negligence or Recklessness:", "Operating the equipment in a manner that ignores standard safety protocols or results in avoidable damage (e.g., low-clearance strikes or \"high-hooking\" trailers).");
		bullet("Unauthorized Personal Use:", "Utilizing the equipment for any purpose outside the specific scope of an active dispatch.");
		bullet("Failure to Secure Assets:", "Loss or theft of equipment due to the Provider\u2019s failure to properly lock the cab or secure the trailer in a safe location.");
		bullet("Interior Destruction:", "Damage to the interior of the tractor cab, including but not limited to smoking, vaping, or unauthorized modifications.");

		// Section 3
		sectionHeader("3. MANDATORY INSPECTION AND COMPLIANCE");
		doc.font(R).fontSize(10);
		doc.text("To ensure compliance with ", MARGIN, doc.y, { width: W, continued: true, lineGap: 2 });
		doc.font(B).text("Texas DPS", { continued: true });
		doc.font(R).text(" and ", { continued: true });
		doc.font(B).text("FMCSR \u00A7 396", { continued: true });
		doc.font(R).text(", the Provider must strictly adhere to the following regime:", { width: W, lineGap: 2 });
		doc.moveDown(0.3);

		bullet("Pre-and-Post Trip Inspections (DVIR):", "The Provider must perform and document a full safety inspection before and after every trip to ensure the equipment is in good and safe operating condition.");
		bullet("Immediate Defect Reporting:", "If the Provider identifies a mechanical issue, they must immediately submit an Equipment Fix Request via the LogisX platform.");
		bullet("Baseline Condition:", "The Provider must report any pre-existing damage before taking possession of a unit. Failure to report damage at the start of a cycle constitutes an admission that the equipment was received in \"zero defect\" condition.");

		// Section 4
		sectionHeader("4. FINANCIAL ACCOUNTABILITY AND SETTLEMENTS");
		doc.font(R).fontSize(10);
		doc.text("In the event of equipment damage determined to be the result of the Provider\u2019s negligence, ", MARGIN, doc.y, { width: W, continued: true, lineGap: 2 });
		doc.font(B).text("LogisX Inc.", { continued: true });
		doc.font(R).text(" reserves the right to:", { width: W, lineGap: 2 });
		doc.moveDown(0.3);

		bullet("Assessment of Repair Costs:", "Charge the Provider for the full cost of repairs, parts, and labor required to return the unit to service.");
		bullet("Right to Set-Off:", "Deduct the cost of such repairs or applicable insurance deductibles from the Provider\u2019s settlement.");
		bullet("Indemnification:", "The Provider agrees to indemnify the Company for any fines or penalties paid by the Carrier due to the Provider\u2019s failure to maintain equipment status or legal load weights.");

		// Section 5
		sectionHeader("5. PROHIBITED ACTS");
		para("The following acts are deemed a material breach of this policy and the Independent Contractor Service Agreement:");
		doc.moveDown(0.3);

		bullet(null, "Modifying or tampering with ELD hardware, speed governors, or engine sensors.");
		bullet(null, "Abandoning equipment at any location other than a Company-designated terminal or authorized customer facility.");
		bullet(null, "Permitting unauthorized passengers in the Tractor without prior written permission and verified insurance coverage.");

		// ====== ACKNOWLEDGMENT ======
		if (doc.y > 580) doc.addPage();
		doc.moveDown(1);
		doc.moveTo(MARGIN, doc.y).lineTo(PAGE_W - MARGIN, doc.y).strokeColor("#999").lineWidth(0.5).stroke();
		doc.moveDown(0.6);

		doc.font(B).fontSize(13).fillColor(BLACK).text("ACKNOWLEDGMENT OF RECEIPT", MARGIN);
		doc.moveDown(0.5);
		doc.font(R).fontSize(10);
		doc.text("I, ", MARGIN, doc.y, { width: W, continued: true, lineGap: 2 });
		if (fullName) {
			doc.font(B).fillColor(BLUE).text(fullName, { continued: true });
			doc.fillColor(BLACK);
		} else {
			doc.text("______________________________", { continued: true });
		}
		doc.font(R).text(", have read and understand the ", { continued: true });
		doc.font(B).text("LogisX Inc. Equipment Use and Care Policy", { continued: true });
		doc.font(R).text(". I acknowledge my status as a ", { continued: true });
		doc.font(B).text("Contracted Service Provider", { continued: true });
		doc.font(R).text(" and agree to the standards of care and financial responsibilities outlined above.", { width: W, lineGap: 2 });

		doc.moveDown(1);
		// Signature line
		const sigY = doc.y;
		doc.font(B).fontSize(10).fillColor(BLACK).text("Provider Signature:", MARGIN, sigY);
		doc.moveTo(MARGIN + 120, sigY + 12).lineTo(350, sigY + 12).strokeColor("#999").lineWidth(0.5).stroke();
		doc.font(B).text("Date:", 370, sigY);
		doc.moveTo(400, sigY + 12).lineTo(520, sigY + 12).stroke();

		// Fill signature
		if (fullName) {
			doc.font(B).fontSize(11).fillColor(BLUE).text(fullName, MARGIN + 125, sigY - 1);
			doc.fillColor(BLACK);
		}
		if (effectiveDate) {
			doc.font(R).fontSize(9).fillColor(BLUE).text(effectiveDate, 405, sigY);
			doc.fillColor(BLACK);
		}
		if (signatureImage) {
			try {
				const sigBuf = Buffer.from(signatureImage.replace(/^data:image\/\w+;base64,/, ""), "base64");
				doc.image(sigBuf, MARGIN + 180, sigY - 18, { width: 130, height: 35 });
			} catch { /* skip */ }
		}

		doc.end();
	});
}

module.exports = { generateEquipmentPolicy };
