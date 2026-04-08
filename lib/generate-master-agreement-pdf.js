const { BLUE, BLACK, GRAY, MARGIN, PAGE_W, createPdfDoc, checkPageSpace } = require("./pdf-helpers");

/**
 * Generate the Master Participation & Management Agreement PDF with investor data.
 * @param {Object} data
 * @returns {Promise<Buffer>}
 */
function generateMasterAgreement(data) {
	const { doc, getBuffer } = createPdfDoc();
	const {
		legalName = "", dba = "", entityType = "", address = "",
		contactPerson = "", contactTitle = "", phone = "", email = "",
		einSsn = "", effectiveDate = "", signatureText = "", signatureImage,
	} = data;

	const B = "Helvetica-Bold";
	const R = "Helvetica";
	const W = PAGE_W - 2 * MARGIN;

	function heading(text) {
		checkPageSpace(doc, 30);
		doc.moveDown(0.6);
		doc.font(B).fontSize(11).fillColor(BLACK).text(text, { align: "center" });
		doc.moveDown(0.4);
	}

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

	function field(label, value) {
		checkPageSpace(doc, 18);
		doc.font(B).fontSize(9.5).fillColor(BLACK)
			.text(label, MARGIN, doc.y, { width: W, continued: true });
		doc.font(R).fillColor(BLUE).text(` ${value || "_______________"}`, { width: W });
		doc.fillColor(BLACK);
	}

	// ─── TITLE ───
	doc.font(B).fontSize(16).fillColor(BLACK)
		.text("MASTER PARTICIPATION &\nMANAGEMENT AGREEMENT", { align: "center" });
	doc.moveDown(0.5);
	doc.font(R).fontSize(9.5).fillColor(GRAY)
		.text("LogisX Inc. — Investor Onboarding", { align: "center" });
	doc.moveDown(0.2);
	doc.font(R).fontSize(9).fillColor(GRAY)
		.text(`Effective Date: ${effectiveDate}`, { align: "center" });
	doc.fillColor(BLACK);

	// ─── PARTIES ───
	heading("PARTIES TO THIS AGREEMENT");
	para(`This Master Participation & Management Agreement ("Agreement") is entered into as of ${effectiveDate}, by and between:`);
	doc.moveDown(0.2);
	doc.font(B).fontSize(9.5).text("COMPANY:", MARGIN, doc.y, { continued: true });
	doc.font(R).text(" LogisX Inc., a Texas Corporation, with its principal place of business at 1234 Logistics Blvd, Dallas, TX 75201.");
	doc.moveDown(0.3);
	doc.font(B).fontSize(9.5).text("PARTICIPANT / INVESTOR:", MARGIN, doc.y, { continued: true });
	doc.font(R).fillColor(BLUE).text(` ${legalName}${dba ? ` DBA ${dba}` : ""}${entityType ? ` (${entityType})` : ""}`);
	doc.fillColor(BLACK);
	if (address) { field("Address:", address); }
	if (contactPerson) { field("Contact:", `${contactPerson}${contactTitle ? `, ${contactTitle}` : ""}`); }
	if (phone) { field("Phone:", phone); }
	if (email) { field("Email:", email); }
	if (einSsn) { field("EIN/SSN:", einSsn); }

	// ─── RECITALS ───
	heading("RECITALS");
	para("WHEREAS, the Company operates a fleet management and logistics business providing trucking and transportation services throughout the United States;");
	para("WHEREAS, the Participant desires to participate in the Company's fleet operations by contributing one or more commercial motor vehicles to be managed, operated, and maintained under the Company's authority;");
	para("WHEREAS, the parties wish to set forth their respective rights, obligations, and financial arrangements in connection with such participation;");
	para("NOW, THEREFORE, in consideration of the mutual covenants contained herein, and for other good and valuable consideration, the receipt and sufficiency of which are hereby acknowledged, the parties agree as follows:");

	// ─── SECTIONS ───
	sectionHead("1", "SCOPE OF AGREEMENT");
	para("1.1  The Company agrees to manage, operate, dispatch, and maintain the Participant's vehicle(s) as listed in Exhibit A, attached hereto and incorporated by reference.");
	para("1.2  The Company shall provide dispatching services, load procurement, driver management, compliance oversight, insurance coverage coordination, and all administrative functions necessary for the lawful and profitable operation of the vehicle(s).");
	para("1.3  The Participant acknowledges that the Company operates under its own USDOT authority and MC number, and all vehicles contributed shall operate exclusively under the Company's authority during the term of this Agreement.");

	sectionHead("2", "TERM AND TERMINATION");
	para("2.1  This Agreement shall commence on the Effective Date and continue for an initial term of twelve (12) months, automatically renewing for successive twelve-month periods unless either party provides sixty (60) days written notice of non-renewal.");
	para("2.2  Either party may terminate this Agreement for cause upon thirty (30) days written notice if the other party commits a material breach that remains uncured after such notice period.");
	para("2.3  Upon termination, all outstanding financial obligations shall be settled within thirty (30) days, and the Company shall return the vehicle(s) in the condition received, reasonable wear and tear excepted.");

	sectionHead("3", "FINANCIAL TERMS");
	para("3.1  Revenue Distribution: The Company shall distribute to the Participant a share of the gross revenue generated by the Participant's vehicle(s), as determined by the rate schedule in effect at the time of each settlement.");
	para("3.2  Settlement Cycle: Settlements shall be processed on a Net-60 basis, meaning the Participant shall receive payment within sixty (60) calendar days following the completion of each revenue period.");
	para("3.3  Deductions: The Company may deduct from the Participant's share all applicable fees, including but not limited to: dispatch fees, insurance premiums, maintenance fund contributions, compliance fees, ELD subscriptions, fuel card balances, and any other agreed-upon charges.");
	para("3.4  Financial Reporting: The Company shall provide the Participant with monthly revenue and expense reports accessible through the Company's digital investor portal.");

	sectionHead("4", "VEHICLE MANAGEMENT");
	para("4.1  The Company shall be responsible for all operational decisions regarding the deployment, routing, and scheduling of the vehicle(s).");
	para("4.2  The Company shall maintain a maintenance fund for each vehicle, funded by monthly contributions deducted from the Participant's revenue share.");
	para("4.3  All maintenance, repairs, and inspections shall be performed by Company-approved service providers and documented in the Company's fleet management system.");
	para("4.4  The Company shall ensure all vehicles remain compliant with federal and state regulations, including but not limited to FMCSA, DOT, and applicable state transportation authority requirements.");

	sectionHead("5", "INSURANCE AND LIABILITY");
	para("5.1  The Company shall maintain commercial auto liability insurance, cargo insurance, and all other insurance required by law and by shippers/brokers, at levels meeting or exceeding minimum regulatory requirements.");
	para("5.2  The Participant shall be responsible for maintaining physical damage (comprehensive and collision) insurance on the vehicle(s) unless otherwise agreed in writing.");
	para("5.3  Neither party shall be liable to the other for any indirect, incidental, consequential, or punitive damages arising out of or related to this Agreement.");

	sectionHead("6", "CONFIDENTIALITY");
	para("6.1  Each party agrees to maintain the confidentiality of all non-public information received from the other party in connection with this Agreement, including but not limited to financial data, customer information, and operational procedures.");
	para("6.2  This obligation shall survive termination of this Agreement for a period of two (2) years.");

	sectionHead("7", "GOVERNING LAW AND DISPUTE RESOLUTION");
	para("7.1  This Agreement shall be governed by and construed in accordance with the laws of the State of Texas, without regard to its conflict of laws provisions.");
	para("7.2  Any dispute arising out of or relating to this Agreement shall first be submitted to mediation. If mediation is unsuccessful, the dispute shall be resolved by binding arbitration in Dallas, Texas, in accordance with the rules of the American Arbitration Association.");

	sectionHead("8", "ENTIRE AGREEMENT");
	para("8.1  This Agreement, together with all Exhibits attached hereto, constitutes the entire agreement between the parties with respect to the subject matter hereof and supersedes all prior agreements, understandings, negotiations, and discussions, whether oral or written.");
	para("8.2  This Agreement may not be amended except by a written instrument signed by both parties.");

	// ─── SIGNATURE BLOCK ───
	doc.addPage();
	doc.font(B).fontSize(11).text("SIGNATURES", { align: "center" });
	doc.moveDown(1);

	doc.font(R).fontSize(9.5);
	doc.text("IN WITNESS WHEREOF, the parties have executed this Agreement as of the Effective Date.");
	doc.moveDown(1.5);

	doc.font(B).fontSize(10).text("COMPANY — LogisX Inc.");
	doc.moveDown(0.5);
	doc.font(R).fontSize(9.5);
	doc.text("By: ___________________________________");
	doc.text("Name: Authorized Representative");
	doc.text("Title: CEO / Managing Director");
	doc.text(`Date: ${effectiveDate}`);
	doc.moveDown(1.5);

	doc.font(B).fontSize(10).text("PARTICIPANT / INVESTOR");
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
	doc.text(`Title: ${contactTitle || "___________________________________"}`);
	doc.text(`Date: ${effectiveDate}`);

	if (signatureImage) {
		try {
			const sigBytes = Buffer.from(signatureImage.replace(/^data:image\/\w+;base64,/, ""), "base64");
			doc.image(sigBytes, doc.x, doc.y + 5, { width: 180, height: 50 });
		} catch { /* skip */ }
	}

	doc.end();
	return getBuffer();
}

module.exports = { generateMasterAgreement };
