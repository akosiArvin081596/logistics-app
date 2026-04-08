const { BLUE, BLACK, GRAY, MARGIN, PAGE_W, createPdfDoc, checkPageSpace, drawBorderedTable } = require("./pdf-helpers");

/**
 * Generate the Commercial Vehicle Lease Agreement PDF with investor + vehicle data.
 * @param {Object} data
 * @returns {Promise<Buffer>}
 */
function generateVehicleLease(data) {
	const { doc, getBuffer } = createPdfDoc();
	const {
		legalName = "", dba = "", entityType = "", address = "",
		contactPerson = "", phone = "", email = "",
		effectiveDate = "", signatureText = "", signatureImage,
		signedAt = "", vehicles = [],
	} = data;

	const B = "Helvetica-Bold";
	const R = "Helvetica";
	const W = PAGE_W - 2 * MARGIN;

	function sectionHead(num, title) {
		checkPageSpace(doc, 35);
		doc.moveDown(0.6);
		doc.font(B).fontSize(10.5).fillColor(BLACK).text(`${num}. ${title}`);
		doc.moveDown(0.3);
		doc.font(R).fontSize(9.5);
	}

	function para(text) {
		checkPageSpace(doc, 20);
		doc.font(R).fontSize(9.5).fillColor(BLACK).text(text, { width: W, lineGap: 2 });
		doc.moveDown(0.3);
	}

	// ─── TITLE ───
	doc.font(B).fontSize(16).fillColor(BLACK)
		.text("COMMERCIAL VEHICLE\nLEASE AGREEMENT", { align: "center" });
	doc.moveDown(0.5);
	doc.font(R).fontSize(9.5).fillColor(GRAY)
		.text("LogisX Inc. — Investor Onboarding", { align: "center" });
	doc.moveDown(0.2);
	doc.font(R).fontSize(9).fillColor(GRAY)
		.text(`Effective Date: ${effectiveDate}`, { align: "center" });
	doc.fillColor(BLACK);
	doc.moveDown(1);

	// ─── PARTIES ───
	para(`This Commercial Vehicle Lease Agreement ("Lease" or "Agreement") is entered into as of ${effectiveDate}, by and between:`);
	doc.moveDown(0.2);
	doc.font(B).fontSize(9.5).text("LESSEE (Motor Carrier):", MARGIN, doc.y, { continued: true });
	doc.font(R).text(" LogisX Inc., USDOT #_______, MC #_______, 1234 Logistics Blvd, Dallas, TX 75201.");
	doc.moveDown(0.3);
	doc.font(B).fontSize(9.5).text("LESSOR (Vehicle Owner):", MARGIN, doc.y, { continued: true });
	doc.font(R).fillColor(BLUE).text(` ${legalName}${dba ? ` DBA ${dba}` : ""}`);
	doc.fillColor(BLACK);
	if (address) {
		doc.font(R).fontSize(9.5).text(`Address: `, MARGIN, doc.y, { continued: true });
		doc.fillColor(BLUE).text(address); doc.fillColor(BLACK);
	}
	if (phone) {
		doc.font(R).fontSize(9.5).text(`Phone: `, MARGIN, doc.y, { continued: true });
		doc.fillColor(BLUE).text(phone); doc.fillColor(BLACK);
	}
	if (email) {
		doc.font(R).fontSize(9.5).text(`Email: `, MARGIN, doc.y, { continued: true });
		doc.fillColor(BLUE).text(email); doc.fillColor(BLACK);
	}

	// ─── VEHICLE SCHEDULE (EXHIBIT A) ───
	doc.moveDown(0.8);
	doc.font(B).fontSize(11).text("EXHIBIT A — VEHICLE SCHEDULE", { align: "center" });
	doc.moveDown(0.5);

	if (vehicles.length > 0) {
		const colWidths = [30, 50, 90, 80, 120, 70, 70];
		const headerRow = [
			{ text: "#", bold: true },
			{ text: "Year", bold: true },
			{ text: "Make", bold: true },
			{ text: "Model", bold: true },
			{ text: "VIN", bold: true },
			{ text: "Plate", bold: true },
			{ text: "State", bold: true },
		];
		const dataRows = vehicles.map((v, i) => [
			String(i + 1),
			{ text: v.year || "—", blue: true },
			{ text: v.make || "—", blue: true },
			{ text: v.model || "—", blue: true },
			{ text: v.vin || "—", blue: true },
			{ text: v.licensePlate || "—", blue: true },
			{ text: v.titleState || "—", blue: true },
		]);
		drawBorderedTable(doc, { rows: [headerRow, ...dataRows], colWidths, fontSize: 8.5 });
	} else {
		para("No vehicles listed.");
	}

	// ─── LEASE TERMS ───
	sectionHead("1", "GRANT OF LEASE");
	para("1.1  The Lessor hereby leases to the Lessee, and the Lessee hereby leases from the Lessor, the commercial motor vehicle(s) described in Exhibit A (individually and collectively, the \"Vehicle\"), for use in the Lessee's transportation operations under the Lessee's operating authority.");
	para("1.2  The Lessee shall have exclusive possession, control, and use of the Vehicle during the term of this Lease, subject to the terms and conditions set forth herein.");

	sectionHead("2", "TERM");
	para("2.1  This Lease shall commence on the Effective Date and shall continue for a period of twelve (12) months, automatically renewing for successive twelve-month periods unless terminated by either party upon sixty (60) days' prior written notice.");
	para("2.2  This Lease may be terminated immediately by either party for material breach by the other party, subject to applicable cure periods.");

	sectionHead("3", "COMPENSATION AND PAYMENT");
	para("3.1  The Lessee shall compensate the Lessor in accordance with the revenue-sharing arrangement set forth in the Master Participation & Management Agreement between the parties.");
	para("3.2  All settlements shall be made on a Net-60 basis. The Lessee shall provide the Lessor with detailed settlement statements for each payment period.");
	para("3.3  The Lessee may deduct from the Lessor's compensation all applicable charges, including insurance premiums, maintenance fund contributions, dispatch fees, ELD costs, compliance fees, and any other charges agreed upon in writing.");

	sectionHead("4", "INSURANCE");
	para("4.1  The Lessee shall maintain, at its expense, commercial automobile liability insurance with combined single limits meeting or exceeding minimum FMCSA requirements.");
	para("4.2  The Lessee shall maintain cargo insurance as required by applicable regulations and shipper/broker requirements.");
	para("4.3  The Lessor shall be responsible for physical damage insurance (comprehensive and collision) on the Vehicle, unless otherwise agreed in writing.");
	para("4.4  Each party shall provide the other with certificates of insurance upon request.");

	sectionHead("5", "MAINTENANCE AND REPAIRS");
	para("5.1  The Lessee shall ensure that all maintenance and repairs necessary for the safe and lawful operation of the Vehicle are performed in a timely manner by qualified technicians.");
	para("5.2  The cost of routine maintenance and repairs shall be funded from the maintenance fund established for the Vehicle. Costs exceeding the maintenance fund balance may be deducted from future settlement payments.");
	para("5.3  The Lessor shall not perform or authorize any maintenance, repairs, or modifications to the Vehicle without the prior written consent of the Lessee.");

	sectionHead("6", "COMPLIANCE");
	para("6.1  During the term of this Lease, the Vehicle shall operate exclusively under the Lessee's USDOT number and operating authority.");
	para("6.2  The Lessee shall ensure that the Vehicle is properly registered, permitted, and in compliance with all applicable federal, state, and local regulations.");
	para("6.3  The Lessor represents and warrants that the Vehicle is free from any liens, encumbrances, or defects that would prevent its lawful operation, except as disclosed in writing to the Lessee.");

	sectionHead("7", "RETURN OF VEHICLE");
	para("7.1  Upon termination of this Lease, the Lessee shall return the Vehicle to the Lessor in the same condition as received, reasonable wear and tear excepted.");
	para("7.2  All outstanding financial obligations between the parties shall be settled within thirty (30) days of the termination date.");

	sectionHead("8", "GOVERNING LAW");
	para("This Lease shall be governed by and construed in accordance with the laws of the State of Texas and applicable federal transportation regulations.");

	// ─── SIGNATURE BLOCK ───
	doc.addPage();
	doc.font(B).fontSize(11).text("SIGNATURES", { align: "center" });
	doc.moveDown(1);
	doc.font(R).fontSize(9.5);
	doc.text("IN WITNESS WHEREOF, the parties have executed this Lease Agreement as of the Effective Date.");
	doc.moveDown(1.5);

	doc.font(B).fontSize(10).text("LESSEE — LogisX Inc.");
	doc.moveDown(0.5);
	doc.font(R).fontSize(9.5);
	doc.text("By: ___________________________________");
	doc.text("Name: Authorized Representative");
	doc.text("Title: CEO / Managing Director");
	doc.text(`Date: ${effectiveDate}`);
	doc.moveDown(1.5);

	doc.font(B).fontSize(10).text("LESSOR (Vehicle Owner)");
	doc.moveDown(0.5);
	doc.font(R).fontSize(9.5);
	if (signatureText) {
		doc.text("By: ").moveUp();
		doc.font(B).fillColor(BLUE).text(`   ${signatureText}`, { underline: true });
		doc.fillColor(BLACK).font(R);
	} else {
		doc.text("By: ___________________________________");
	}
	doc.text(`Name: ${legalName || "___________________________________"}`);
	doc.text(`Date: ${effectiveDate}`);
	if (signedAt) {
		doc.moveDown(0.3);
		doc.font(R).fontSize(8).fillColor(GRAY);
		doc.text(`Electronically signed on ${signedAt}`);
		doc.fillColor(BLACK);
	}

	if (signatureImage) {
		try {
			const sigBytes = Buffer.from(signatureImage.replace(/^data:image\/\w+;base64,/, ""), "base64");
			doc.image(sigBytes, doc.x, doc.y + 5, { width: 180, height: 50 });
		} catch { /* skip */ }
	}

	doc.end();
	return getBuffer();
}

module.exports = { generateVehicleLease };
