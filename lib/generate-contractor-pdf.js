const PDFDocument = require("pdfkit");

const BLUE = "#1a56db";
const BLACK = "#1a1d27";
const GRAY = "#6b7280";
const MARGIN = 50;
const PAGE_W = 612; // Letter

/**
 * Generate the full Contractor Agreement PDF with driver data pre-filled.
 * @param {Object} data - { fullName, address, effectiveDate, signatureImage?, paymentMethod, checkName, bankName, bankAddress, bankPhone, bankRouting, bankAccount, bankAcctName, accountType }
 * @returns {Promise<Buffer>}
 */
function generateContractorAgreement(data) {
	return new Promise((resolve, reject) => {
		const doc = new PDFDocument({ size: "LETTER", margin: MARGIN, bufferPages: true });
		const chunks = [];
		doc.on("data", (c) => chunks.push(c));
		doc.on("end", () => resolve(Buffer.concat(chunks)));
		doc.on("error", reject);

		const {
			fullName = "", address = "", effectiveDate = "",
			signatureImage, paymentMethod = "", checkName = "",
			bankName = "", bankAddress = "", bankPhone = "",
			bankRouting = "", bankAccount = "", bankAcctName = "", accountType = "",
		} = data;

		const B = "Helvetica-Bold";
		const R = "Helvetica";

		// Helper: write text with mixed bold/regular segments
		// segments: [{text, bold?, blue?}, ...]
		function mixed(segments, opts = {}) {
			const baseOpts = { lineGap: 2, ...opts };
			segments.forEach((seg, i) => {
				doc.font(seg.bold ? B : R);
				if (seg.blue) doc.fillColor(BLUE); else doc.fillColor(BLACK);
				const continued = i < segments.length - 1;
				doc.text(seg.text, { ...baseOpts, continued });
			});
			doc.fillColor(BLACK);
		}

		function sectionHeader(num, title) {
			checkPageSpace(40);
			doc.moveDown(0.8);
			doc.font(B).fontSize(11).fillColor(BLACK);
			doc.text(`${num}. ${title}`);
			doc.moveDown(0.4);
			doc.font(R).fontSize(10);
		}

		function para(text, indent = 0) {
			doc.font(R).fontSize(10).fillColor(BLACK);
			doc.text(text, MARGIN + indent, doc.y, { width: PAGE_W - 2 * MARGIN - indent, lineGap: 2 });
		}

		function boldPara(label, text, indent = 0) {
			checkPageSpace(30);
			const x = MARGIN + indent;
			const w = PAGE_W - 2 * MARGIN - indent;
			doc.font(B).fontSize(10).fillColor(BLACK);
			doc.text(label, x, doc.y, { width: w, continued: true, lineGap: 2 });
			doc.font(R).text(` ${text}`, { width: w, lineGap: 2 });
		}

		function numberedItem(num, label, text, indent = 30) {
			checkPageSpace(30);
			const x = MARGIN + indent;
			const w = PAGE_W - 2 * MARGIN - indent;
			doc.font(R).fontSize(10).fillColor(BLACK);
			doc.text(`${num}. `, x, doc.y, { width: w, continued: true, lineGap: 2 });
			if (label) {
				doc.font(B).text(label, { continued: true });
				doc.font(R).text(` ${text}`, { width: w, lineGap: 2 });
			} else {
				doc.text(text, { width: w, lineGap: 2 });
			}
		}

		function letteredItem(letter, label, text, indent = 50) {
			checkPageSpace(25);
			const x = MARGIN + indent;
			const w = PAGE_W - 2 * MARGIN - indent;
			doc.font(R).fontSize(10).fillColor(BLACK);
			doc.text(`${letter}. `, x, doc.y, { width: w, continued: true, lineGap: 2 });
			if (label) {
				doc.font(B).text(label, { continued: true });
				doc.font(R).text(` ${text}`, { width: w, lineGap: 2 });
			} else {
				doc.text(text, { width: w, lineGap: 2 });
			}
		}

		function sigLine(label, value, x, y, lineW) {
			doc.font(R).fontSize(10).fillColor(BLACK);
			doc.text(label, x, y);
			const lineY = y + 14;
			doc.moveTo(x + 25, lineY).lineTo(x + 25 + lineW, lineY).strokeColor("#999").lineWidth(0.5).stroke();
			if (value) {
				doc.font(B).fontSize(11).fillColor(BLUE);
				doc.text(value, x + 28, y + 2);
				doc.fillColor(BLACK);
			}
		}

		function fillField(value) {
			if (!value) return "______________________________";
			return value;
		}

		function checkPageSpace(needed) {
			if (doc.y + needed > 720) doc.addPage();
		}

		// ====== PAGE 1 ======
		doc.font(B).fontSize(14).fillColor(BLACK);
		doc.text("INDEPENDENT CONTRACTOR AGREEMENT", { align: "center" });
		doc.moveDown(0.6);
		doc.font(R).fontSize(10);

		// Intro paragraph with driver data filled in blue
		mixed([
			{ text: 'This ' },
			{ text: 'Independent Contractor Service Agreement', bold: true },
			{ text: ' (the "' },
			{ text: 'Agreement', bold: true },
			{ text: '") is made and entered into effective as of ' },
			{ text: fillField(effectiveDate), bold: true, blue: !!effectiveDate },
			{ text: ' (the "' },
			{ text: 'Effective Date', bold: true },
			{ text: '"), by and between ' },
			{ text: 'LogisX Inc.', bold: true },
			{ text: ' (the "' },
			{ text: 'Company', bold: true },
			{ text: '" or "' },
			{ text: 'Recipient', bold: true },
			{ text: '"), a Texas corporation and authorized U.S. Motor Carrier operating under ' },
			{ text: 'USDOT# 4302683', bold: true },
			{ text: ', with its principal place of business located at ' },
			{ text: '4576 Research Forest Dr, Suite 200, The Woodlands, TX 77381', bold: true },
			{ text: ', and ' },
			{ text: fillField(fullName), bold: true, blue: !!fullName },
			{ text: ' (the "' },
			{ text: 'Contractor', bold: true },
			{ text: '"), an independent business entity with a primary address located at ' },
			{ text: fillField(address), bold: true, blue: !!address },
			{ text: '.' },
		]);

		// SECTION 1
		sectionHeader("1", "DESCRIPTION OF SERVICES & SCOPE OF WORK");
		mixed([
			{ text: 'The Contractor is engaged as an independent professional to provide ' },
			{ text: 'Commercial Motor Vehicle (CMV) Operation and Transportation Services', bold: true },
			{ text: '. By executing this Agreement, the Contractor warrants and represents the following:' },
		]);
		doc.moveDown(0.3);

		letteredItem("A", "Professional Expertise:", "The Contractor possesses the specialized skill, experience, and professional expertise necessary to operate CMVs safely and efficiently under the Company's motor carrier authority (USDOT# 4302683).");
		doc.moveDown(0.15);
		letteredItem("B", "Licensure & Certification:", "The Contractor holds a valid Commercial Driver's License (CDL) with all necessary endorsements and a current Medical Examiner's Certificate (Medical Card) as required by law.");
		doc.moveDown(0.15);
		letteredItem("C", "Mandatory Disclosure:", "The Contractor shall provide copies of all credentials to the Company upon request. The Contractor must immediately notify the Company, in writing, of any traffic person citations, license suspensions, revocations, or any medical condition that would disqualify them from operating a CMV under FMCSR.");
		doc.moveDown(0.15);
		letteredItem("D", "Regulatory Compliance:", "The Contractor shall perform all Services in strict accordance with the Federal Motor Carrier Safety Regulations (FMCSR), including but not limited to FMCSA \u00A7 395.3 Hours of Service (HOS), pre-and-post trip vehicle inspection requirements (DVIR), and mandatory drug/alcohol testing programs.");
		doc.moveDown(0.15);
		letteredItem("E", "Operational Result:", 'While the Contractor maintains the right to determine the specific "means and methods" of driving (e.g., route selection, fuel stops), the Contractor is contractually responsible for achieving the specific performance result: the safe, damage-free, and on-time pickup and delivery of cargo within the appointment windows provided by the Company or its customers.');
		doc.moveDown(0.15);
		letteredItem("F", "Drug & Alcohol Clearinghouse:", 'The Contractor consents to and shall remain in "Clear" status with the FMCSA Drug and Alcohol Clearinghouse. Any "Prohibited" status shall result in the immediate and automatic termination of this Agreement for cause.');

		// SECTION 2
		sectionHeader("2", "COMPENSATION, INVOICING, & TAX COMPLIANCE");
		para("The Company shall compensate the Contractor for Services rendered under the following strict terms and conditions:");
		doc.moveDown(0.3);

		numberedItem("1", "Daily Rate & Cycle Definition:", 'The Company shall pay the Contractor a flat rate of $250.00 per day. For the purposes of this Agreement, a "day" is strictly defined as the completion of one (1) USDOT 14-hour duty cycle as governed by FMCSA \u00A7 395.3. Partial cycles or "on-call" time not resulting in a dispatched movement do not constitute a "day" unless pre-approved in writing by the Company.');
		doc.moveDown(0.15);
		numberedItem("2", "Mandatory Invoicing:", 'All payments are strictly "Pay-by-Invoice." The Contractor must submit a professional, itemized invoice to the Company on a weekly basis. Each invoice must be accompanied by the documentation and payment election details specified in Exhibit A, including:');
		doc.moveDown(0.1);
		letteredItem("a", null, "Verified Electronic Logging Device (ELD) records or log-hour verification to ensure strict HOS compliance.");
		letteredItem("b", null, "Signed Bills of Lading (BOLs) or Proof of Delivery (POD) for all loads handled during the invoiced period.");
		doc.moveDown(0.15);
		numberedItem("3", "Payment Terms (Net 7):", "The Company shall remit payment to the Contractor via the method selected in Exhibit A within seven (7) calendar days (Net 7) from the date of receipt of a complete and undisputed invoice, including all required supporting documentation.");
		doc.moveDown(0.15);
		numberedItem("4", "Right to Offset:", 'The Company reserves the right to withhold or "offset" payments from any invoice to cover costs incurred due to the Contractor\'s negligence, including but not limited to: cargo claims, equipment damage, or fines/penalties resulting from the Contractor\'s HOS or safety violations.');
		doc.moveDown(0.15);
		numberedItem("5", "Independent Contractor (1099) Status:", "The Contractor is an independent business entity and not an employee of the Company.");
		doc.moveDown(0.1);
		letteredItem("a", "No Withholdings:", "The Company will not withhold any federal, state, or local income taxes, FICA, or unemployment taxes.");
		letteredItem("b", "Tax Responsibility:", "The Contractor is solely responsible for all self-employment taxes, 1099 filings, and mandatory business insurance.");
		letteredItem("c", "No Benefits:", "The Contractor is not eligible for, and hereby waives any claim to, worker's compensation, health insurance, paid time off, or any other employee fringe benefits.");
		doc.moveDown(0.15);
		numberedItem("6", "Business Expenses:", 'The Contractor shall bear all personal and business-related expenses incurred in the performance of the Services (e.g., cellular data for the LogisX platform, personal equipment, and travel) unless otherwise specified in the payment instructions within Exhibit A for a specific dispatch.');

		// SECTION 3
		sectionHeader("3", "PERFORMANCE STANDARDS & OPERATIONAL INTEGRITY");
		para('While the Contractor maintains the right to determine the specific "means and methods" of professional driving (e.g., fuel stops, rest locations, and specific routing), the Contractor agrees to adhere to the following Performance Standards to ensure the operational integrity of LogisX Inc. (USDOT# 4302683):');
		doc.moveDown(0.3);

		numberedItem("1", "Time-Critical Performance (On-Time Delivery):", 'The Contractor acknowledges that "time is of the essence." The Contractor shall ensure all pickups and deliveries are completed strictly within the appointment windows provided by the Company or its customers.');
		doc.moveDown(0.15);
		numberedItem("2", "Operational Result vs. Method:", "The Company's interest is solely in the result of the services (i.e., a safe, legal, and on-time delivery). The Contractor is responsible for calculating transit times, weather impacts, and HOS requirements to ensure this result is met without direct \"time management\" supervision from the Company.");
		doc.moveDown(0.15);
		numberedItem("3", "Material Breach for Delays:", "The Contractor acknowledges that consistent delays or failure to meet appointment windows causes irreparable harm to the Company's business reputation and contractual standing with shippers. Five (5) or more unexcused late arrivals within a thirty (30) day period may be considered a material breach of this Agreement, providing grounds for immediate termination.");
		doc.moveDown(0.15);
		numberedItem("4", "Safety & Technology Compliance:", "Performance includes strict, non-negotiable adherence to the LogisX Inc. Mobile Communications Policy (prohibiting handheld device use while in motion) and all applicable DOT safety standards.");
		doc.moveDown(0.15);
		numberedItem("5", "Communication Requirement:", 'While the Company does not manage the Contractor\'s hour-by-hour schedule, the Contractor agrees to provide "Status Updates" (e.g., Loaded, Unloaded, or Maintenance Delays) via the designated LogisX dispatch platform or electronic logging interface to ensure the Company can fulfill its tracking obligations to customers.');
		doc.moveDown(0.15);
		numberedItem("6", "Professional Conduct:", 'The Contractor shall conduct themselves in a professional manner at all shipper and receiver facilities. Any "Banned" status from a customer facility due to the Contractor\'s conduct shall be deemed a failure to perform the Services under this Agreement.');

		// SECTION 4
		sectionHeader("4", "INDEPENDENT CONTRACTOR STATUS & OPERATIONAL RESTRICTIONS");
		para("To ensure the protection of LogisX Inc. against labor board audits or misclassification claims, this section explicitly defines the \"Free Agent\" status of the Contractor.");
		doc.moveDown(0.3);

		numberedItem("1", "Result-Oriented Engagement:", "The Company's interest is strictly and solely in the final result of the Services: the safe, legal, and on-time delivery of cargo. The Company does not exercise \"time management,\" direct supervision, or control over the Contractor's specific driving techniques, gear shifting, braking methods, or personal rest schedules, provided the Contractor remains in compliance with FMCSR HOS regulations.");
		doc.moveDown(0.15);
		numberedItem("2", "Control of Means and Methods:", "The Contractor is a \"Free Agent\" and retains the absolute right to determine the specific \"means and methods\" of performance. This includes, but is not limited to, the selection of travel routes, fueling locations, and the order of non-appointment-based tasks, provided the Performance Objective (the delivery window) is met.");
		doc.moveDown(0.15);
		numberedItem("3", "Non-Exclusivity:", "This is a non-exclusive Agreement. The Contractor remains free to provide services to other motor carriers or entities, provided that such outside services do not create a conflict of interest or result in a violation of the Contractor's available HOS under the Company's USDOT authority.");
		doc.moveDown(0.15);
		numberedItem("4", 'No Employment "Tools of the Trade":', "The Contractor is responsible for providing their own \"tools of the trade,\" including but not limited to: mobile communication devices compatible with the LogisX platform, personal protective equipment (PPE), and any specialized navigational tools.");
		doc.moveDown(0.15);
		numberedItem("5", "Professional Conduct & Representation:", "While the Contractor is an independent entity, they acknowledge that while operating under the Company's USDOT# 4302683, their conduct reflects upon the Company's safety rating. The Contractor is responsible for their own professional conduct and agrees to interact with all third-party shippers, receivers, and law enforcement in a professional, law-abiding manner.");
		doc.moveDown(0.15);
		numberedItem("6", "No Authority to Bind:", "The Contractor has no authority to enter into contracts, incur debt, or make any legal representations on behalf of LogisX Inc. The Contractor shall at all times identify themselves to third parties as an Independent Contractor and not as an agent or employee of the Company.");

		// SECTION 5
		sectionHeader("5", "TERMINATION & SEPARATION OF PARTIES");
		para("To maintain a true Independent Contractor relationship under labor standards, the right to terminate must be balanced. While the Company requires \"Immediate Termination\" for safety and performance to protect its USDOT# 4302683, the \"At-Will\" nature for both parties reinforces that this is a business-to-business arrangement, not an employment contract.");
		doc.moveDown(0.3);

		numberedItem("1", "Standard Termination:", "Either Party may terminate this Agreement at any time, for any reason or no reason, upon fourteen (14) days' written notice to the other Party. This notice period allows for the orderly completion of any outstanding dispatches and final invoicing.");
		doc.moveDown(0.15);
		numberedItem("2", "Company's Right to Immediate Termination for Cause:", "Notwithstanding the standard notice period, the Company reserves the absolute right to terminate this Agreement immediately and without prior notice for \"Cause.\" For the purposes of protecting the Company's motor carrier authority and contractual obligations, \"Cause\" includes, but is not limited to:");
		doc.moveDown(0.1);
		letteredItem("a", "Performance Failure:", 'Any unexcused failure to meet delivery windows or "Performance Objectives" as defined in Section 3.');
		letteredItem("b", "Safety & Compliance Violations:", 'Any violation of the LogisX Inc. Mobile Communications Policy, failure of a drug/alcohol test, or any "Prohibited" status in the FMCSA Clearinghouse.');
		letteredItem("c", "Loss of Eligibility:", "Suspension, revocation, or expiration of the Contractor's CDL or Medical Examiner's Certificate.");
		letteredItem("d", "Risk to Authority:", "Any action or omission by the Contractor that jeopardizes the Company's DOT Safety Rating, insurance standing, or primary customer contracts.");
		letteredItem("e", "Criminal Conduct:", "Any arrest or conviction for a felony or serious traffic violation (as defined by FMCSR) while performing Services.");
		doc.moveDown(0.15);
		numberedItem("3", "Contractor's Right to Terminate:", "The Contractor may terminate this Agreement if the Company fails to remit payment within the Net 7 terms defined in Section 2, provided the Contractor gives written notice of the default and a seven (7) day cure period.");
		doc.moveDown(0.15);
		numberedItem("4", "Post-Termination Obligations:", "Upon termination, regardless of the reason, the Contractor shall:");
		doc.moveDown(0.1);
		letteredItem("a", null, "Immediately return any Company-owned property, access keys, or sensitive shipping documents.");
		letteredItem("b", null, "Provide all final ELD logs and signed Bills of Lading (BOLs) required for final invoicing.");
		letteredItem("c", null, "Cease representing themselves as an active provider for LogisX Inc. (USDOT# 4302683).");
		doc.moveDown(0.15);
		numberedItem("5", "Final Settlement:", "The Company shall process the final invoice within seven (7) days of receiving all required closing documentation and a final verified log-out from the LogisX platform.");

		// SECTION 6
		sectionHeader("6", "CONFIDENTIALITY, NON-SOLICITATION, & TRADE SECRET PROTECTION");
		para("The Contractor acknowledges that during the course of providing Services, they will have access to \"Confidential Information\" which is the exclusive property of LogisX Inc. This Confidential Information includes, but is not limited to, the internal architecture and functional logic of the LogisX Platform, proprietary pricing structures, specific shipper and broker identities, contractual terms with third-party customers, and internal operational strategies. The Contractor agrees to maintain the absolute secrecy of this information and shall not, at any time during or after the termination of this Agreement, disclose, divulge, or make use of such information for personal gain or for the benefit of any third-party competitor.");
		doc.moveDown(0.4);
		para("Furthermore, the Contractor acknowledges that the Company has invested significant resources into developing its customer base and specialized logistics network. To protect these legitimate business interests, the Contractor agrees that for a period of twelve (12) months following the termination of this Agreement for any reason, they shall not, directly or indirectly, solicit, interfere with, or attempt to divert any customer, shipper, or broker of the Company with whom the Contractor had contact or became aware of through this engagement. Any attempt to \"back-door\" the Company by providing transportation services directly to these customers or through a competing motor carrier within this restricted period shall be considered a material breach of this Agreement. This provision shall survive the termination of the Agreement and remains enforceable to the maximum extent permitted under Texas law.");

		// SECTION 7
		sectionHeader("7", "INDEMNIFICATION, LIABILITY SHIELD, & DEFENSE OF CLAIMS");
		para("The Contractor acknowledges that as an independent business entity, they assume full responsibility for the risks associated with the performance of the Services. To the fullest extent permitted by Texas law, the Contractor agrees to indemnify, defend, and hold harmless LogisX Inc., its parent companies, subsidiaries, officers, directors, and employees from and against any and all claims, demands, causes of action, losses, damages, liabilities, judgments, settlements, and expenses\u2014including, without limitation, reasonable attorney's fees and court costs\u2014arising out of or resulting from the Contractor's performance under this Agreement.");
		doc.moveDown(0.4);
		para("This indemnification obligation specifically covers, but is not limited to, any third-party claims for personal injury, wrongful death, or property damage resulting from vehicle accidents, cargo loss or damage, or the Contractor's failure to strictly comply with Federal Motor Carrier Safety Regulations (FMCSR). The Contractor further agrees to indemnify the Company for any fines, penalties, or assessments levied by the FMCSA, Department of Transportation (DOT), or any state regulatory body that result from the Contractor's operational violations or negligence while operating under the Company's motor carrier authority (USDOT# 4302683).");
		doc.moveDown(0.4);
		para("The Company shall not be liable to the Contractor for any indirect, incidental, special, or consequential damages, including loss of profits or business interruption, arising from the termination of this Agreement or any dispatch delays. This Section 7 shall survive the expiration or termination of this Agreement and shall remain in full force and effect regarding any incident occurring during the term of the Contractor's engagement.");

		// SECTION 8
		sectionHeader("8", "FORCE MAJEURE & EXCUSABLE DELAY");
		para("Neither Party shall be liable for any failure or delay in the performance of its obligations under this Agreement\u2014specifically regarding the \"On-Time Delivery\" requirements\u2014to the extent that such failure or delay is caused by a Force Majeure Event. A Force Majeure Event is strictly defined as an occurrence beyond the reasonable control of the affected Party that could not have been avoided by the exercise of due diligence, including but not limited to: acts of God (severe weather, floods, earthquakes), declared war, acts of terrorism, civil unrest, or mandatory government-ordered shutdowns or road closures.");
		doc.moveDown(0.4);
		para("To invoke this clause, the Contractor must provide immediate verbal and written notice to the Company's dispatch or management as soon as the Force Majeure Event becomes apparent, detailing the nature of the event and the expected duration of the delay. The Contractor is not excused from performance due to \"predictable\" operational challenges, including but not limited to: routine heavy traffic, preventable mechanical breakdowns of the Contractor's equipment, lack of available HOS due to poor trip planning, or personal illness.");
		doc.moveDown(0.4);
		para("The Company reserves the right to reassign any dispatch affected by a Force Majeure Event to another carrier or contractor if the delay exceeds four (4) hours, in order to mitigate damages to the Company's customers. In such an event, the Contractor shall only be entitled to pro-rated compensation for the portion of the 14-hour cycle actually completed, provided the cargo remains secure and the Company's interests are protected. Consistent reliance on Force Majeure for standard operational delays shall be scrutinized and may result in the immediate termination of this Agreement under the Performance Guidelines of Section 3.");

		// SECTION 9
		sectionHeader("9", "MANDATORY ARBITRATION & WAIVER OF CLASS ACTION");
		doc.font(B).fontSize(10);
		para("In lieu of formal court proceedings, the Parties agree that any and all disputes, claims, or controversies arising out of or relating to this Agreement\u2014including its formation, breach, termination, or the Independent Contractor status of the Contractor\u2014shall be resolved exclusively through Binding Arbitration. This Agreement to arbitrate is governed by the Federal Arbitration Act (9 U.S.C. \u00A7\u00A7 1-16) and shall be conducted by the American Arbitration Association (AAA) or a mutually agreed-upon private ADR (Alternative Dispute Resolution) firm under their respective Commercial Arbitration Rules.");
		doc.moveDown(0.4);
		doc.font(B).fontSize(10);
		para("The arbitration shall take place in Montgomery County, Texas, and shall be presided over by a single, neutral arbitrator with at least ten (10) years of experience in transportation and logistics law. The arbitrator's decision shall be final and binding, and judgment upon the award rendered by the arbitrator may be entered in any court having jurisdiction thereof. The Parties shall split the administrative costs and arbitrator's fees equally, though each Party shall bear its own attorney's fees and legal costs unless the arbitrator awards such fees to the prevailing Party under a specific statutory right.");
		doc.moveDown(0.4);
		doc.font(B).fontSize(10);
		para("Class Action Waiver: The Contractor and the Company agree that any arbitration shall be conducted in their individual capacities only and not as a class action or other representative action. The Parties expressly waive their right to file a class action or seek relief on a class basis. Furthermore, the Parties hereby waive their right to a jury trial for any dispute covered by this Agreement.");
		doc.moveDown(0.4);
		doc.font(R).fontSize(10);
		para("Nothing in this Section 9 shall prevent either Party from seeking a temporary restraining order or preliminary injunction in a court of competent jurisdiction to protect Confidential Information or to enforce the Non-Solicitation provisions of Section 6 pending the appointment of an arbitrator.");

		// GOVERNING LAW
		checkPageSpace(60);
		doc.moveDown(0.8);
		doc.font(B).fontSize(11).text("8. GOVERNING LAW", MARGIN);
		doc.moveDown(0.3);
		doc.font(R).fontSize(10);
		mixed([
			{ text: "This Agreement shall be governed by and construed in accordance with the laws of the " },
			{ text: "State of Texas", bold: true },
			{ text: ". Any legal actions shall be filed in Montgomery County, Texas." },
		]);

		// SIGNATORIES
		checkPageSpace(200);
		doc.moveDown(1);
		doc.moveTo(MARGIN, doc.y).lineTo(PAGE_W - MARGIN, doc.y).strokeColor("#999").lineWidth(0.5).stroke();
		doc.moveDown(0.5);
		doc.font(B).fontSize(11).text("SIGNATORIES", MARGIN);
		doc.moveDown(0.5);
		doc.font(B).fontSize(10).text("RECIPIENT: LogisX Inc.", MARGIN);
		doc.moveDown(0.4);

		// Company signature line
		const compY = doc.y;
		doc.font(R).fontSize(10).text("By:", MARGIN, compY);
		doc.moveTo(MARGIN + 20, compY + 12).lineTo(250, compY + 12).stroke();
		doc.font(R).fontSize(10).text("Date:", 300, compY);
		doc.moveTo(330, compY + 12).lineTo(480, compY + 12).stroke();
		// Pre-fill company
		doc.font(B).fontSize(11).fillColor(BLUE).text("Deshorn King", MARGIN + 22, compY - 1);
		doc.fillColor(BLACK);
		doc.font(R).fontSize(9).text(effectiveDate || "", 332, compY);
		doc.y = compY + 18;
		doc.font(B).fontSize(10).text("Deshorn King, CEO", MARGIN);
		doc.moveDown(0.6);

		// Contractor signature
		doc.font(B).fontSize(10).text("CONTRACTOR:", MARGIN);
		doc.moveDown(0.4);
		const ctY = doc.y;
		doc.font(R).fontSize(10).text("By:", MARGIN, ctY);
		doc.moveTo(MARGIN + 20, ctY + 12).lineTo(250, ctY + 12).stroke();
		doc.font(R).fontSize(10).text("Date:", 300, ctY);
		doc.moveTo(330, ctY + 12).lineTo(480, ctY + 12).stroke();
		// Fill contractor name
		if (fullName) {
			doc.font(B).fontSize(11).fillColor(BLUE).text(fullName, MARGIN + 22, ctY - 1);
			doc.fillColor(BLACK);
		}
		doc.font(R).fontSize(9).text(effectiveDate || "", 332, ctY);
		doc.y = ctY + 20;

		// Embed drawn signature if available
		if (signatureImage) {
			try {
				const sigBuf = Buffer.from(signatureImage.replace(/^data:image\/\w+;base64,/, ""), "base64");
				doc.image(sigBuf, MARGIN + 100, ctY - 15, { width: 140, height: 40 });
			} catch { /* skip if image fails */ }
		}

		doc.moveDown(0.6);
		// Print name
		doc.font(B).fontSize(10).text("[Print Name]:", MARGIN, doc.y, { continued: true });
		doc.font(R).text(" " + (fullName || "______________________________"));

		// ====== EXHIBIT A ======
		doc.addPage();
		doc.font(B).fontSize(11).text("EXHIBIT A: PAYMENT SELECTION & INVOICE REQUIREMENTS", MARGIN);
		doc.moveDown(0.5);
		doc.font(R).fontSize(10);
		mixed([
			{ text: "This " },
			{ text: "Exhibit A", bold: true },
			{ text: " is incorporated into and made a part of the " },
			{ text: "Independent Contractor Service Agreement", bold: true },
			{ text: " dated " },
			{ text: fillField(effectiveDate), bold: true, blue: !!effectiveDate },
			{ text: ", between " },
			{ text: "LogisX Inc. (USDOT# 4302683)", bold: true },
			{ text: " and the " },
			{ text: "Contractor", bold: true },
			{ text: ". As referenced in " },
			{ text: "Section 2 (Compensation, Invoicing, & Tax Compliance)", bold: true },
			{ text: ", the Contractor hereby elects the following method of payment:" },
		]);

		doc.moveDown(0.6);
		doc.moveTo(MARGIN, doc.y).lineTo(PAGE_W - MARGIN, doc.y).strokeColor("#999").lineWidth(0.5).stroke();
		doc.moveDown(0.4);
		doc.font(R).fontSize(10).text("PAYMENT METHOD SELECTION", MARGIN);
		doc.moveDown(0.5);

		// Payment method checkboxes
		const checkMark = paymentMethod === "check" ? "[X]" : "[ ]";
		const achMark = paymentMethod === "ach" ? "[X]" : "[ ]";
		doc.font(B).fontSize(10);
		doc.text(`${checkMark} Check`, MARGIN, doc.y, { continued: true });
		doc.font(R).text("  Name on Account: ", { continued: true });
		doc.font(B).fillColor(BLUE).text(checkName || "_______________________________________________");
		doc.fillColor(BLACK);
		doc.moveDown(0.4);
		doc.font(B).text(`${achMark} Direct Deposit (ACH)`, MARGIN, doc.y, { continued: true });
		doc.font(R).text("  Name of Bank:");
		doc.font(B).fillColor(BLUE).text(bankName || "_______________________________________________", MARGIN);
		doc.fillColor(BLACK);

		// Banking details (page 9 content)
		doc.moveDown(0.6);
		const bankFields = [
			["Bank Address:", bankAddress],
			["Bank Phone #:", bankPhone],
			["Bank Routing #:", bankRouting],
			["Bank Account #:", bankAccount],
			["Name(s) on Acct:", bankAcctName],
			["Type of Account (Checking/Savings):", accountType],
		];
		for (const [label, value] of bankFields) {
			doc.font(B).fontSize(10).fillColor(BLACK).text(label, MARGIN, doc.y, { continued: true });
			doc.font(R).fillColor(BLUE).text(" " + (value || "_______________________________________________"));
			doc.fillColor(BLACK);
			doc.moveDown(0.2);
		}

		// Mandatory invoice acknowledgment
		doc.moveDown(0.5);
		doc.moveTo(MARGIN, doc.y).lineTo(PAGE_W - MARGIN, doc.y).strokeColor("#999").lineWidth(0.5).stroke();
		doc.moveDown(0.3);
		doc.font(R).fontSize(10);
		mixed([
			{ text: "MANDATORY INVOICE ACKNOWLEDGMENT", bold: true },
			{ text: " By signing below, the Contractor acknowledges and agrees to the following administrative requirements to ensure timely payment processing under the " },
			{ text: "Net 7", bold: true },
			{ text: " terms:" },
		]);
		doc.moveDown(0.3);

		numberedItem("1", "Submission Requirement:", "In order to receive any payment from LogisX Inc., all Independent Contractors MUST sign and submit a professional work invoice detailing the specific dates of service and the 14-hour cycles completed.");
		doc.moveDown(0.1);
		numberedItem("2", "Supporting Documentation:", "No invoice will be considered \"received\" or \"complete\" for payment purposes until it is accompanied by the required ELD logs and signed Proof of Delivery (POD) documents as stipulated in the main Agreement.");
		doc.moveDown(0.1);
		numberedItem("3", "Accuracy:", "The Contractor is responsible for the accuracy of the banking or mailing information provided above. LogisX Inc. is not liable for delays or losses resulting from incorrect account details provided by the Contractor.");

		// Final contractor signature
		doc.moveDown(0.8);
		const finalSigY = doc.y;
		doc.font(B).fontSize(10).text("CONTRACTOR SIGNATURE:", MARGIN, finalSigY);
		doc.moveTo(MARGIN + 160, finalSigY + 12).lineTo(450, finalSigY + 12).stroke();
		if (fullName) {
			doc.font(B).fontSize(11).fillColor(BLUE).text(fullName, MARGIN + 165, finalSigY - 1);
			doc.fillColor(BLACK);
		}
		if (signatureImage) {
			try {
				const sigBuf2 = Buffer.from(signatureImage.replace(/^data:image\/\w+;base64,/, ""), "base64");
				doc.image(sigBuf2, MARGIN + 280, finalSigY - 15, { width: 130, height: 35 });
			} catch { /* skip */ }
		}
		doc.moveDown(0.6);
		doc.font(B).fontSize(10).fillColor(BLACK).text("DATE:", MARGIN, doc.y, { continued: true });
		doc.font(R).fillColor(BLUE).text(" " + (effectiveDate || "_______________"));
		doc.fillColor(BLACK);

		doc.end();
	});
}

module.exports = { generateContractorAgreement };
