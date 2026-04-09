const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");
const fs = require("fs");
const path = require("path");

/**
 * Generate the Master Participation & Management Agreement PDF.
 * Uses the original 11-page PDF template and overlays investor data + signature.
 * @param {Object} data
 * @returns {Promise<Buffer>}
 */
async function generateMasterAgreement(data) {
	const {
		legalName = "", dba = "", entityType = "", address = "",
		contactPerson = "", contactTitle = "", phone = "", email = "",
		einSsn = "", effectiveDate = "", signatureText = "", signatureImage,
		signedAt = "",
	} = data;

	const templatePath = path.join(__dirname, "..", "uploads", "onboarding-templates", "investor", "MASTER PARTICIPATION & MANAGEMENT AGREEMENT.pdf");
	if (!fs.existsSync(templatePath)) {
		throw new Error("Master Agreement template not found");
	}

	const templateBytes = fs.readFileSync(templatePath);
	const pdfDoc = await PDFDocument.load(templateBytes);
	const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
	const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
	const blue = rgb(0.1, 0.34, 0.86);

	const pages = pdfDoc.getPages();
	const lastPage = pages[pages.length - 1];

	// Signature page overlay — Participant section
	// The signature page has blank lines for:
	// Participant Name, Signature, Date, Printed Name, Title
	const sigPageY = {
		participantSig: 420,   // "By:" signature line
		participantName: 390,  // Printed name
		participantTitle: 370, // Title
		participantDate: 420,  // Date next to signature
		// Manager section (pre-filled with Deshorn King)
		managerSig: 530,
		managerName: 500,
		managerDate: 530,
	};

	// Manager signature (pre-filled)
	lastPage.drawText("Deshorn King", { x: 120, y: sigPageY.managerSig, size: 11, font: fontBold, color: blue });
	lastPage.drawText(effectiveDate || new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }), { x: 400, y: sigPageY.managerDate, size: 9, font, color: blue });
	lastPage.drawText("Deshorn King", { x: 120, y: sigPageY.managerName, size: 10, font, color: blue });
	lastPage.drawText("CEO / Managing Member", { x: 120, y: sigPageY.managerName - 15, size: 9, font, color: blue });

	// Participant signature
	if (signatureText) {
		lastPage.drawText(signatureText, { x: 120, y: sigPageY.participantSig, size: 11, font: fontBold, color: blue });
		lastPage.drawText(effectiveDate || new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }), { x: 400, y: sigPageY.participantDate, size: 9, font, color: blue });
		lastPage.drawText(signatureText, { x: 120, y: sigPageY.participantName, size: 10, font, color: blue });
		if (contactTitle) {
			lastPage.drawText(contactTitle, { x: 120, y: sigPageY.participantTitle, size: 9, font, color: blue });
		}
	}

	// Embed drawn signature image
	if (signatureImage) {
		try {
			const sigBytes = Buffer.from(signatureImage.replace(/^data:image\/\w+;base64,/, ""), "base64");
			const sigImg = await pdfDoc.embedPng(sigBytes);
			const nameW = signatureText ? fontBold.widthOfTextAtSize(signatureText, 11) : 0;
			lastPage.drawImage(sigImg, { x: 120 + nameW + 10, y: sigPageY.participantSig - 10, width: 130, height: 35 });
		} catch { /* skip */ }
	}

	// Participant info block (below signatures or in designated area)
	const infoY = sigPageY.participantTitle - 30;
	const participantLabel = legalName + (dba ? ` (DBA: ${dba})` : "") + (entityType ? ` — ${entityType}` : "");
	if (participantLabel) {
		lastPage.drawText(participantLabel, { x: 72, y: infoY, size: 9, font: fontBold, color: blue });
	}
	if (address) {
		lastPage.drawText(address, { x: 72, y: infoY - 14, size: 9, font, color: blue });
	}
	const contactLine = [contactPerson, phone, email].filter(Boolean).join(" | ");
	if (contactLine) {
		lastPage.drawText(contactLine, { x: 72, y: infoY - 28, size: 8, font, color: blue });
	}
	if (einSsn) {
		lastPage.drawText(`EIN/SSN: ${einSsn}`, { x: 72, y: infoY - 42, size: 8, font, color: blue });
	}

	const pdfBytes = await pdfDoc.save();
	return Buffer.from(pdfBytes);
}

module.exports = { generateMasterAgreement };
