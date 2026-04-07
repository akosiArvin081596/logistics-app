const PDFDocument = require("pdfkit");

const BLUE = "#1a56db";
const BLACK = "#1a1d27";
const GRAY = "#6b7280";
const MARGIN = 50;
const PAGE_W = 612;

function generateServiceInvoice(data) {
	return new Promise((resolve, reject) => {
		const doc = new PDFDocument({ size: "LETTER", margin: MARGIN, bufferPages: true });
		const chunks = [];
		doc.on("data", (c) => chunks.push(c));
		doc.on("end", () => resolve(Buffer.concat(chunks)));
		doc.on("error", reject);

		const {
			fullName = "", address = "", phone = "", effectiveDate = "",
			signatureImage, bankName = "", accountType = "",
		} = data;
		const B = "Helvetica-Bold";
		const R = "Helvetica";
		const IT = "Helvetica-Oblique";
		const W = PAGE_W - 2 * MARGIN;

		function field(label, value, x, y) {
			doc.font(B).fontSize(10).fillColor(BLACK).text(label, x, y, { continued: true });
			if (value) {
				doc.font(R).fillColor(BLUE).text(" " + value);
			} else {
				doc.font(R).fillColor(BLACK).text(" _________________________________");
			}
			doc.fillColor(BLACK);
		}

		function drawTable(headers, rows, colWidths, startY) {
			let y = startY;
			const totalW = colWidths.reduce((a, b) => a + b, 0);
			// Header row
			doc.rect(MARGIN, y, totalW, 20).fill("#f0f0f0").stroke();
			let x = MARGIN;
			headers.forEach((h, i) => {
				doc.font(B).fontSize(9).fillColor(BLACK).text(h, x + 4, y + 5, { width: colWidths[i] - 8 });
				x += colWidths[i];
			});
			y += 20;
			// Data rows
			rows.forEach(row => {
				if (y > 700) { doc.addPage(); y = 60; }
				x = MARGIN;
				doc.rect(MARGIN, y, totalW, 22).stroke();
				row.forEach((cell, i) => {
					const isBlue = typeof cell === "object" && cell.blue;
					const text = typeof cell === "object" ? cell.text : cell;
					doc.font(R).fontSize(9).fillColor(isBlue ? BLUE : BLACK);
					doc.text(text, x + 4, y + 6, { width: colWidths[i] - 8 });
					x += colWidths[i];
				});
				y += 22;
			});
			doc.fillColor(BLACK);
			return y;
		}

		// ====== PAGE 1 ======
		doc.font(B).fontSize(18).fillColor(BLACK).text("WEEKLY SERVICE INVOICE", MARGIN);
		doc.moveDown(0.6);

		// FROM section
		doc.font(B).fontSize(10).text("FROM (Contracted Service Provider):", MARGIN);
		doc.moveDown(0.3);
		field("Name:", fullName, MARGIN, doc.y);
		doc.moveDown(0.4);
		field("Business Name:", "", MARGIN, doc.y);
		const addrY = doc.y - 14;
		field("Address:", address, MARGIN + 250, addrY);
		field("Phone:", phone, MARGIN, doc.y);
		doc.moveDown(0.6);

		// BILL TO
		doc.font(B).fontSize(10).text("BILL TO:", MARGIN);
		doc.moveDown(0.2);
		doc.font(B).text("LogisX Inc.", MARGIN);
		doc.font(R).fontSize(10).text("4576 Research Forest Dr, Suite 200", MARGIN);
		doc.text("The Woodlands, TX 77381");
		doc.moveDown(0.3);
		doc.font(B).text("USDOT# 4302683");
		doc.moveDown(0.5);

		// Invoice header table
		doc.moveTo(MARGIN, doc.y).lineTo(PAGE_W - MARGIN, doc.y).strokeColor("#999").lineWidth(0.5).stroke();
		doc.moveDown(0.3);

		const invHeaders = ["Invoice Number", "Submission Date", "Submission Time"];
		const invCols = [180, 180, 152];
		const invRow = [
			"INV-2026-____",
			"Friday, " + (effectiveDate || "________"),
			"MUST BE BEFORE\n6:00 PM",
		];
		let tableEnd = drawTable(invHeaders, [invRow], invCols, doc.y);
		doc.y = tableEnd + 10;

		doc.moveTo(MARGIN, doc.y).lineTo(PAGE_W - MARGIN, doc.y).strokeColor("#999").lineWidth(0.5).stroke();
		doc.moveDown(0.5);

		// Service summary
		doc.font(B).fontSize(12).text("LOGISTICS SERVICE SUMMARY", MARGIN);
		doc.moveDown(0.2);
		doc.font(IT).fontSize(10).text("Billing Period: [Saturday Date] to [Current Friday Date]", MARGIN);
		doc.moveDown(0.4);

		const days = ["Saturday", "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
		const svcHeaders = ["Date of Service", "Load / BOL #", "14-Hour Duty Cycle Status", "Daily Rate", "Total"];
		const svcCols = [95, 95, 140, 70, 60];
		const svcRows = days.map(day => [
			day, "", "[ ] Completed / [ ] N/A", "$250.00", "$",
		]);
		// Add total row
		svcRows.push([{ text: "TOTAL DUE", blue: false }, "", "", "", "$"]);
		tableEnd = drawTable(svcHeaders, svcRows, svcCols, doc.y);
		doc.y = tableEnd + 10;

		// ====== PAGE 2 — Mandatory Attachments ======
		doc.moveDown(0.3);
		doc.moveTo(MARGIN, doc.y).lineTo(PAGE_W - MARGIN, doc.y).strokeColor("#999").lineWidth(0.5).stroke();
		doc.moveDown(0.5);

		doc.font(B).fontSize(12).text("MANDATORY ATTACHMENTS FOR PAYMENT VERIFICATION", MARGIN);
		doc.moveDown(0.4);
		doc.font(IT).fontSize(10).fillColor(BLACK);
		doc.text("Per Section 5.02 of the Service Agreement, this invoice will NOT be processed if any items are missing:", MARGIN, doc.y, { width: W });
		doc.moveDown(0.4);

		const attachments = [
			["Verified ELD Data:", "Full logs for every 14-hour cycle claimed above."],
			["Signed Bills of Lading (BOL):", "Proof of delivery for every load listed."],
			["Daily Vehicle Inspection Reports (DVIR):", "Post-trip inspections for the week."],
			["Fuel Receipts:", "All original receipts for the billing period."],
		];
		attachments.forEach(([ label, text], i) => {
			doc.font(R).fontSize(10).text(`${i + 1}. [ ] `, MARGIN + 20, doc.y, { width: W - 20, continued: true });
			doc.font(B).text(label, { continued: true });
			doc.font(R).text(" " + text, { width: W - 20, lineGap: 2 });
			doc.moveDown(0.25);
		});

		// ====== PAGE 3 — Payment Instructions + Signature ======
		doc.addPage();
		doc.font(B).fontSize(12).text("PAYMENT INSTRUCTIONS", MARGIN);
		doc.moveDown(0.5);
		doc.font(IT).fontSize(10).text("Payment will be remitted within ", MARGIN, doc.y, { width: W, continued: true });
		doc.font(B).text("7 calendar days", { continued: true });
		doc.font(IT).text(" of Monday verification via the method on file.", { width: W });
		doc.moveDown(0.5);

		// Bank info
		doc.font(R).fontSize(10);
		doc.text("\u2022  ", MARGIN + 20, doc.y, { continued: true });
		doc.font(B).text("Bank on File:", { continued: true });
		if (bankName) {
			doc.font(R).fillColor(BLUE).text(" " + bankName);
		} else {
			doc.font(R).text(" __________________________");
		}
		doc.fillColor(BLACK);
		doc.moveDown(0.2);
		doc.text("\u2022  ", MARGIN + 20, doc.y, { continued: true });
		doc.font(B).text("Account Type:", { continued: true });
		if (accountType) {
			doc.font(R).fillColor(BLUE).text(" " + accountType);
		} else {
			doc.font(R).text(" [ ] Checking / [ ] Savings");
		}
		doc.fillColor(BLACK);
		doc.moveDown(0.8);

		// Certification
		doc.moveTo(MARGIN, doc.y).lineTo(PAGE_W - MARGIN, doc.y).strokeColor("#999").lineWidth(0.5).stroke();
		doc.moveDown(0.4);
		doc.font(B).fontSize(10).text("PROVIDER CERTIFICATION:", MARGIN, doc.y, { width: W, continued: true });
		doc.font(R).text(" I certify that the services listed above were performed personally or by my authorized agents in full compliance with ", { continued: true });
		doc.font(B).text("USDOT HOS", { continued: true });
		doc.font(R).text(" regulations and ", { continued: true });
		doc.font(B).text("LogisX Inc.", { continued: true });
		doc.font(R).text(" safety policies. I acknowledge that any equipment damage or fines incurred during this period may be offset against this settlement.", { width: W, lineGap: 2 });
		doc.moveDown(0.8);

		// Signature
		const sigY = doc.y;
		doc.font(B).fontSize(10).fillColor(BLACK).text("Signature:", MARGIN, sigY);
		doc.moveTo(MARGIN + 65, sigY + 12).lineTo(320, sigY + 12).strokeColor("#999").lineWidth(0.5).stroke();
		doc.font(B).text("Date:", 340, sigY);
		doc.moveTo(370, sigY + 12).lineTo(500, sigY + 12).stroke();

		if (fullName) {
			doc.font(B).fontSize(11).fillColor(BLUE).text(fullName, MARGIN + 70, sigY - 1);
			doc.fillColor(BLACK);
		}
		if (effectiveDate) {
			doc.font(R).fontSize(9).fillColor(BLUE).text(effectiveDate, 375, sigY);
			doc.fillColor(BLACK);
		}
		if (signatureImage) {
			try {
				const sigBuf = Buffer.from(signatureImage.replace(/^data:image\/\w+;base64,/, ""), "base64");
				doc.image(sigBuf, MARGIN + 130, sigY - 18, { width: 130, height: 35 });
			} catch { /* skip */ }
		}

		doc.end();
	});
}

module.exports = { generateServiceInvoice };
