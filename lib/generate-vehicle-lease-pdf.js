const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");
const fs = require("fs");
const path = require("path");

/**
 * Generate the Commercial Vehicle Lease Agreement PDF.
 * Uses the original 11-page PDF template and overlays investor data + vehicle info + signature.
 * @param {Object} data
 * @returns {Promise<Buffer>}
 */
async function generateVehicleLease(data) {
	const {
		legalName = "", dba = "", entityType = "", address = "",
		contactPerson = "", phone = "", email = "",
		effectiveDate = "", signatureText = "", signatureImage,
		signedAt = "", vehicles = [],
	} = data;

	const templatePath = path.join(__dirname, "..", "uploads", "onboarding-templates", "investor", "COMMERCIAL VEHICLE LEASE AGREEMENT_ Investor onboarding .pdf");
	if (!fs.existsSync(templatePath)) {
		throw new Error("Vehicle Lease template not found");
	}

	const templateBytes = fs.readFileSync(templatePath);
	const pdfDoc = await PDFDocument.load(templateBytes);
	const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
	const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
	const blue = rgb(0.1, 0.34, 0.86);

	const pages = pdfDoc.getPages();
	const lastPage = pages[pages.length - 1];

	// Signature page overlay
	const sigPageY = {
		lessorSig: 530,
		lessorName: 500,
		lessorDate: 530,
		lesseeSig: 420,
		lesseeName: 390,
		lesseeTitle: 370,
		lesseeDate: 420,
	};

	// Lessor (LogisX) — pre-filled
	lastPage.drawText("Deshorn King", { x: 120, y: sigPageY.lessorSig, size: 11, font: fontBold, color: blue });
	lastPage.drawText(effectiveDate || new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }), { x: 400, y: sigPageY.lessorDate, size: 9, font, color: blue });
	lastPage.drawText("Deshorn King, CEO", { x: 120, y: sigPageY.lessorName, size: 10, font, color: blue });

	// Lessee (Investor) signature
	if (signatureText) {
		lastPage.drawText(signatureText, { x: 120, y: sigPageY.lesseeSig, size: 11, font: fontBold, color: blue });
		lastPage.drawText(effectiveDate || new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }), { x: 400, y: sigPageY.lesseeDate, size: 9, font, color: blue });
		lastPage.drawText(signatureText, { x: 120, y: sigPageY.lesseeName, size: 10, font, color: blue });
	}

	// Embed drawn signature image
	if (signatureImage) {
		try {
			const sigBytes = Buffer.from(signatureImage.replace(/^data:image\/\w+;base64,/, ""), "base64");
			const sigImg = await pdfDoc.embedPng(sigBytes);
			const nameW = signatureText ? fontBold.widthOfTextAtSize(signatureText, 11) : 0;
			lastPage.drawImage(sigImg, { x: 120 + nameW + 10, y: sigPageY.lesseeSig - 10, width: 130, height: 35 });
		} catch { /* skip */ }
	}

	// Lessee info block
	const infoY = sigPageY.lesseeTitle - 30;
	const label = legalName + (dba ? ` (DBA: ${dba})` : "") + (entityType ? ` — ${entityType}` : "");
	if (label) lastPage.drawText(label, { x: 72, y: infoY, size: 9, font: fontBold, color: blue });
	if (address) lastPage.drawText(address, { x: 72, y: infoY - 14, size: 9, font, color: blue });
	const contact = [contactPerson, phone, email].filter(Boolean).join(" | ");
	if (contact) lastPage.drawText(contact, { x: 72, y: infoY - 28, size: 8, font, color: blue });

	// Vehicle schedule — add as a new page (Exhibit A)
	if (vehicles.length > 0) {
		const vPage = pdfDoc.addPage([612, 792]);
		let y = 740;
		vPage.drawText("EXHIBIT A — VEHICLE SCHEDULE", { x: 72, y, size: 14, font: fontBold });
		y -= 25;
		vPage.drawText(`Effective Date: ${effectiveDate}`, { x: 72, y, size: 10, font, color: blue });
		y -= 30;

		// Table header
		const cols = [72, 162, 252, 312, 402, 492];
		const headers = ["Vehicle", "VIN", "Year", "License Plate", "Title State", "Mileage"];
		headers.forEach((h, i) => vPage.drawText(h, { x: cols[i], y, size: 8, font: fontBold }));
		y -= 5;
		vPage.drawLine({ start: { x: 72, y }, end: { x: 540, y }, thickness: 0.5 });
		y -= 15;

		vehicles.forEach((v, idx) => {
			if (y < 80) {
				// Would need a new page for many vehicles — simplified for now
				return;
			}
			vPage.drawText(`${v.make || ""} ${v.model || ""}`.trim(), { x: cols[0], y, size: 8, font });
			vPage.drawText(v.vin || "", { x: cols[1], y, size: 8, font });
			vPage.drawText(String(v.year || ""), { x: cols[2], y, size: 8, font });
			vPage.drawText(v.licensePlate || "", { x: cols[3], y, size: 8, font });
			vPage.drawText(v.titleState || "", { x: cols[4], y, size: 8, font });
			vPage.drawText(v.mileage || "", { x: cols[5], y, size: 8, font });
			y -= 18;
		});
	}

	const pdfBytes = await pdfDoc.save();
	return Buffer.from(pdfBytes);
}

module.exports = { generateVehicleLease };
