const { BLUE, BLACK, GRAY, MARGIN, PAGE_W, createPdfDoc, checkPageSpace } = require("./pdf-helpers");

const B = "Helvetica-Bold";
const R = "Helvetica";
const W = PAGE_W - 2 * MARGIN;

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function sectionTitle(doc, text) {
	checkPageSpace(doc, 30);
	doc.moveDown(0.6);
	doc.font(B).fontSize(12).fillColor(BLACK).text(text, MARGIN, doc.y, { width: W, align: "center" });
	doc.moveDown(0.5);
}

function articleHeader(doc, text) {
	checkPageSpace(doc, 30);
	doc.moveDown(0.7);
	doc.font(B).fontSize(12).fillColor(BLACK).text(text, MARGIN, doc.y, { width: W });
	doc.moveDown(0.4);
}

function subHeader(doc, text) {
	checkPageSpace(doc, 25);
	doc.moveDown(0.3);
	doc.font(B).fontSize(10).fillColor(BLACK).text(text, MARGIN, doc.y, { width: W, lineGap: 2 });
	doc.moveDown(0.2);
}

function para(doc, text, indent) {
	const ind = indent || 0;
	doc.font(R).fontSize(10).fillColor(BLACK)
		.text(text, MARGIN + ind, doc.y, { width: W - ind, lineGap: 2 });
}

function paraBlue(doc, text, indent) {
	const ind = indent || 0;
	doc.font(R).fontSize(10).fillColor(BLUE)
		.text(text, MARGIN + ind, doc.y, { width: W - ind, lineGap: 2 });
	doc.fillColor(BLACK);
}

function bullet(doc, text, indent) {
	const ind = indent || 20;
	checkPageSpace(doc, 25);
	doc.font(R).fontSize(10).fillColor(BLACK);
	doc.text("\u2022  " + text, MARGIN + ind, doc.y, { width: W - ind, lineGap: 2 });
	doc.moveDown(0.15);
}

function bulletBold(doc, label, text, indent) {
	const ind = indent || 20;
	checkPageSpace(doc, 25);
	doc.font(R).fontSize(10).fillColor(BLACK);
	doc.text("\u2022  ", MARGIN + ind, doc.y, { width: W - ind, continued: true, lineGap: 2 });
	doc.font(B).text(label, { continued: true });
	doc.font(R).text(" " + text, { width: W - ind, lineGap: 2 });
	doc.moveDown(0.15);
}

function subBullet(doc, text, indent) {
	const ind = indent || 40;
	checkPageSpace(doc, 20);
	doc.font(R).fontSize(10).fillColor(BLACK);
	doc.text("-  " + text, MARGIN + ind, doc.y, { width: W - ind, lineGap: 2 });
	doc.moveDown(0.1);
}

function definition(doc, term, body) {
	checkPageSpace(doc, 30);
	doc.font(B).fontSize(10).fillColor(BLACK)
		.text(term + ": ", MARGIN, doc.y, { width: W, continued: true, lineGap: 2 });
	doc.font(R).text(body, { width: W, lineGap: 2 });
	doc.moveDown(0.3);
}

function sigLine(doc, x, y, lineWidth) {
	doc.moveTo(x, y).lineTo(x + lineWidth, y).strokeColor("#999").lineWidth(0.5).stroke();
}

function blankField(value, placeholder) {
	return value || placeholder || "______________________________";
}

/* ------------------------------------------------------------------ */
/*  Main generator                                                     */
/* ------------------------------------------------------------------ */

/**
 * Generate the Master Participation & Management Agreement PDF (11 pages).
 * All static legal text is rendered via pdfkit; dynamic fields are filled
 * from the supplied data object.
 *
 * @param {Object} data
 * @param {string} data.legalName
 * @param {string} [data.dba]
 * @param {string} [data.entityType]
 * @param {string} [data.address]
 * @param {string} [data.contactPerson]
 * @param {string} [data.contactTitle]
 * @param {string} [data.phone]
 * @param {string} [data.email]
 * @param {string} [data.einSsn]
 * @param {string} [data.effectiveDate]
 * @param {string} [data.signatureText]
 * @param {string} [data.signatureImage] - base64 PNG data-URL
 * @param {string} [data.signedAt]
 * @param {Array<Object>} [data.vehicles] - each: { year, make, model, vin, mileage, titleState, liens, registeredOwner }
 * @returns {Promise<Buffer>}
 */
async function generateMasterAgreement(data) {
	const {
		legalName = "", dba = "", entityType = "", address = "",
		contactPerson = "", contactTitle = "", phone = "", email = "",
		einSsn = "", effectiveDate = "", signatureText = "", signatureImage,
		signedAt = "", vehicles = [],
	} = data;

	const { doc, getBuffer } = createPdfDoc();

	/* ================================================================ */
	/*  PAGE 1                                                          */
	/* ================================================================ */

	doc.font(B).fontSize(15).fillColor(BLACK);
	doc.text("MASTER PARTICIPATION &", { align: "center" });
	doc.text("MANAGEMENT AGREEMENT", { align: "center" });
	doc.moveDown(0.8);

	// Opening paragraph
	doc.font(R).fontSize(10).fillColor(BLACK);
	doc.text('THIS MASTER PARTICIPATION & MANAGEMENT AGREEMENT (the "Agreement") is entered into and made effective as of the date of the final signature below (the "Effective Date"), by and between ', MARGIN, doc.y, { width: W, continued: true, lineGap: 2 });
	doc.font(B).text("LogisX Inc.", { continued: true });
	doc.font(R).text(", a Texas corporation, having its principal place of business at ", { continued: true });
	doc.font(B).text("4576 Research Forest Dr, Suite 200, The Woodlands, TX 77381", { continued: true });
	doc.font(R).text(' (the "Manager"), and the individual or entity identified on the signature page of this Agreement (the "Participant").', { width: W, lineGap: 2 });
	doc.moveDown(0.6);

	// RECITALS
	sectionTitle(doc, "RECITALS");

	bulletBold(doc, "Managerial Authority and Regulatory Status:", "The Manager is a professional logistics and motor carrier entity, maintaining all requisite federal and state regulatory authorizations, including USDOT# 4302683, and possesses the operational infrastructure and administrative capacity to manage commercial freight operations in strict accordance with Federal Motor Carrier Safety Regulations (FMCSR) and applicable Texas statutes.");

	bulletBold(doc, "Operational and Technical Oversight:", 'The Manager provides comprehensive fleet management services, including the utilization of third-party electronic logging devices (ELD), real-time telemetry, and data-driven route optimization software to oversee the operational lifecycle and safety compliance of the Asset.');

	bulletBold(doc, "Asset Contribution for Managed Services:", 'The Participant is the legal and beneficial owner of the heavy-duty commercial transportation equipment (the "Asset"), as specifically described by Vehicle Identification Number (VIN) and specification in Exhibit A, and desires to entrust the exclusive operational management and deployment of said Asset to the Manager.');

	bulletBold(doc, "Variable-Yield Production Model:", "The Parties expressly acknowledge and agree that this Agreement is predicated on a Variable-Yield Production Model, wherein the Participant's financial return is derived solely from the active and successful revenue generation produced by the Asset.");

	bulletBold(doc, "Absence of Guaranteed Yield or Debt Service:", 'The Manager assumes no obligation for fixed monthly disbursements, guaranteed minimum returns, or debt service payments; no yield shall accrue, nor shall any payment be owed, during periods in which the Asset is non-operational due to mechanical failure, required maintenance, market volatility, or the unavailability of qualified labor.');

	bulletBold(doc, "Governing Law and Commercial Bailment:", "This Agreement is intended to be governed by the laws of the State of Texas, specifically regarding the principles of commercial bailment, management services, and independent contractor relationships.");

	bulletBold(doc, "Sophisticated Party Intent:", "The Parties enter into this Agreement as sophisticated business entities seeking a mutually beneficial management arrangement based strictly on the professional utilization and performance of the Asset.");

	// ARTICLE 1
	articleHeader(doc, "ARTICLE 1: DEFINITIONS");
	para(doc, "The following terms, when used in this Agreement, shall have the meanings set forth below:");
	doc.moveDown(0.4);

	/* ================================================================ */
	/*  PAGE 2 — Definitions continued                                  */
	/* ================================================================ */

	definition(doc, '"The Asset"', 'Refers to the specific heavy-duty commercial transportation equipment, including any tractor(s) or power unit(s), owned by the Participant and identified by Vehicle Identification Number (VIN) and technical specifications in Exhibit A.');

	definition(doc, '"Gross Revenue"', "The total monetary compensation received by the Manager from shippers, brokers, or third-party logistics providers for the transportation of freight specifically attributed to the operation of the Asset.");

	// Priority Expenses
	doc.font(B).fontSize(10).fillColor(BLACK)
		.text('"Priority Expenses": ', MARGIN, doc.y, { width: W, continued: true, lineGap: 2 });
	doc.font(R).text("The direct operational costs associated with the Asset's production which must be satisfied prior to any profit distribution. These include:", { width: W, lineGap: 2 });
	doc.moveDown(0.15);

	subBullet(doc, "Contracted Labor: A flat-rate daily driver compensation fee of $250.00 per completed 14-hour duty cycle.");
	subBullet(doc, "Operating Supplies: All variable fuel and diesel exhaust fluid (DEF) costs incurred during dispatched miles.");
	subBullet(doc, "Fixed Insurance Overhead: Pro-rated monthly premiums for Commercial Auto Liability, Cargo, and Physical Damage insurance.");
	subBullet(doc, "Regulatory and Compliance Fees: Monthly subscription costs for Electronic Logging Devices (ELD), telemetry services, and pro-rated Federal Heavy Vehicle Use Tax (Form 2290).");
	doc.moveDown(0.3);

	definition(doc, '"Net Operating Income (NOI)"', "The residual funds remaining after all Priority Expenses and Maintenance Reserve deductions have been subtracted from the Gross Revenue.");

	definition(doc, '"Maintenance Reserve"', 'A recurring monthly capital allocation, as specified in the Fee Schedule, held by the Manager to fund the ongoing operational readiness of the Asset. This reserve is utilized for preventative maintenance, tires, glass, and minor mechanical repairs required to keep the Asset in a "Fit for Service" status.');

	definition(doc, '"Settlement Period"', 'The defined accounting and disbursement window, adhering to a "Net-60" cycle. Under this schedule, Gross Revenue generated in a specific calendar month is reconciled and settled on the last Friday of the following calendar month to account for standard industry accounts receivable aging.');

	definition(doc, '"Variable-Yield Participation"', "The performance-based compensation model wherein the Participant and Manager split the NOI in accordance with the percentages defined in Article 3.");

	definition(doc, '"Operational Downtime"', "Any period during which the Asset is not actively generating revenue due to mechanical failure, driver unavailability, required inspections, or lack of freight volume.");

	/* ================================================================ */
	/*  ARTICLE 2                                                       */
	/* ================================================================ */

	articleHeader(doc, "ARTICLE 2: SCOPE OF RELATIONSHIP");

	/* ================================================================ */
	/*  PAGE 3 — Article 2 body                                         */
	/* ================================================================ */

	subHeader(doc, "2.1 Nature of the Relationship.");
	para(doc, 'This Agreement establishes a business-to-business (B2B) management services relationship between the Manager and the Participant. The Participant enters this Agreement as an independent asset owner and not as an employee, partner, or joint venturer of the Manager. The Participant shall remain solely responsible for all federal, state, and local tax liabilities arising from their share of the Net Operating Income (NOI), for which the Manager will issue an Internal Revenue Service (IRS) Form 1099 annually.');
	doc.moveDown(0.3);

	subHeader(doc, "2.2 Asset Ownership and Bailment.");
	para(doc, "Legal title and beneficial ownership of the Asset shall remain exclusively with the Participant at all times. This Agreement constitutes an asset-only contribution for the exclusive operational use of the Manager's fleet. Possession of the Asset by the Manager is for the limited purpose of commercial freight management under the principles of a commercial bailment for mutual benefit.");
	doc.moveDown(0.3);

	subHeader(doc, "2.3 Grant of Exclusive Operational Control.");
	para(doc, "The Participant hereby grants the Manager absolute and irrevocable authority to manage, dispatch, and operate the Asset for the duration of the Term. This grant of authority includes, but is not limited to:");
	doc.moveDown(0.15);

	bulletBold(doc, "Driver Management:", "The Manager maintains the sole and exclusive right to recruit, screen, qualify, and assign drivers to the Asset under the Manager's USDOT# 4302683.");
	bulletBold(doc, "Freight and Lane Optimization:", "The Manager shall have full autonomy in the selection of all freight, shipping lanes, and customers, utilizing the Manager's proprietary route optimization software and technology stack to maximize Asset utilization.");
	bulletBold(doc, "Regulatory Compliance Oversight:", "The Manager shall oversee all safety and compliance requirements in accordance with the Federal Motor Carrier Safety Administration (FMCSA).");
	doc.moveDown(0.2);

	subHeader(doc, "2.4 Limited Power of Attorney.");
	para(doc, "To facilitate the seamless integration of the Asset into the Manager's commercial fleet, the Participant hereby appoints the Manager as its Attorney-in-Fact. This limited power of attorney specifically empowers the Manager to perform the following acts on behalf of the Participant:");
	doc.moveDown(0.15);

	bulletBold(doc, "Registration and Licensing:", "Apply for and obtain International Registration Plan (IRP) apportioned plates and cab cards.");
	bulletBold(doc, "Tax Filings:", "Execute and file International Fuel Tax Agreement (IFTA) returns and IRS Form 2290 (Heavy Highway Vehicle Use Tax).");
	bulletBold(doc, "Permitting:", "Secure all necessary state and federal permits required for the legal operation of the Asset in interstate commerce.");
	doc.moveDown(0.2);

	subHeader(doc, "2.5 Launch Capital and Regulatory Costs.");
	para(doc, 'The Manager is expressly authorized to pre-fund and subsequently deduct all initial costs associated with the procurement of base plates, apportioned registration, regulatory permits, and mandatory inspections from the Asset\'s Gross Revenue. These costs shall be categorized as "Fixed Overhead" or "Launch Capital" and shall be reconciled during the initial Settlement Periods.');
	doc.moveDown(0.3);

	subHeader(doc, "2.6: LIMITED LICENSE TO TECHNOLOGY STACK");

	/* ================================================================ */
	/*  PAGE 4 — 2.6 sub-sections                                      */
	/* ================================================================ */

	doc.moveDown(0.2);
	subHeader(doc, "2.6.1 Grant of Non-Exclusive License.");
	para(doc, 'For the duration of the Term, the Manager hereby grants to the Participant a limited, non-exclusive, non-transferable, and royalty-free license to utilize the Manager\'s proprietary technology stack. This includes access to real-time telemetry, electronic logging device (ELD) interfaces, and data-driven route optimization reports solely for the purpose of monitoring the performance and production of the Asset.');
	doc.moveDown(0.3);

	subHeader(doc, "2.6.2 Intellectual Property Ownership.");
	para(doc, 'The Participant expressly acknowledges and agrees that the Manager (or its third-party providers) retains all right, title, and interest in and to the technology stack, including all software, algorithms, data structures, and proprietary "LogisX" interfaces. This Agreement does not constitute a sale of software or a transfer of any intellectual property rights to the Participant.');
	doc.moveDown(0.3);

	subHeader(doc, "2.6.3 Prohibited Use.");
	para(doc, "The Participant shall not, and shall not permit any third party to:");
	doc.moveDown(0.15);
	bullet(doc, "Reverse engineer, decompile, or attempt to derive the source code of the Manager's technology;");
	bullet(doc, "Utilize the Manager's route optimization data for any equipment not covered under this Agreement;");
	bullet(doc, 'Sublicense or "white-label" the technology for use in external logistics operations.');
	doc.moveDown(0.2);

	subHeader(doc, "2.6.4 Termination of Access.");
	para(doc, "Upon the termination of this Agreement for any reason, the Participant's license to the technology stack shall immediately cease. The Participant shall immediately return or delete any proprietary software or access credentials provided by the Manager.");

	/* ================================================================ */
	/*  ARTICLE 3                                                       */
	/* ================================================================ */

	articleHeader(doc, "ARTICLE 3: SETTLEMENT AND DISBURSEMENTS");

	subHeader(doc, "3.1 Performance-Based Contingency.");
	para(doc, 'The Participant expressly acknowledges and agrees that all disbursements under this Agreement are strictly contingent upon the active operational status and revenue-generating performance of the Asset. No "debt service," guaranteed yield, or interest shall accrue or be owed to the Participant during periods of Operational Downtime, including but not limited to mechanical failure, scheduled or unscheduled maintenance, driver unavailability, or adverse market conditions.');
	doc.moveDown(0.3);

	subHeader(doc, '3.2 Priority of Payments (The "Waterfall").');
	para(doc, "To determine the Net Operating Income (NOI) available for distribution, the Manager shall apply a strict priority of payments to the Gross Revenue. The following Priority Expenses shall be deducted in full before any profit participation is calculated:");
	doc.moveDown(0.15);

	bulletBold(doc, "Direct Operational Labor:", "A fixed daily driver compensation rate of $250.00 per 14-hour duty cycle.");
	bulletBold(doc, "Variable Operating Supplies:", "All actual costs for fuel and diesel exhaust fluid (DEF) utilized during dispatched operations.");

	/* ================================================================ */
	/*  PAGE 5 — 3.2 continued + 3.3-3.6                               */
	/* ================================================================ */

	bulletBold(doc, "Fixed Operational Overhead:", "Pro-rated monthly allocations for commercial insurance (Liability, Cargo, and Physical Damage), ELD compliance subscriptions, and proprietary software licensing.");
	bulletBold(doc, "Mandatory Reserves:", 'A non-refundable monthly Maintenance Reserve of $800.00 to ensure the Asset\'s ongoing "Fit for Service" status, and a $300.00 Contingency Buffer to protect against unexpected operational liabilities.');
	bulletBold(doc, "Regulatory Compliance:", "Pro-rated assessments for Federal Highway Use Tax (IRS Form 2290), IRP apportioned registration, and required state permitting.");
	doc.moveDown(0.2);

	subHeader(doc, "3.3 Revenue Participation and Method of Payment.");
	para(doc, "Upon the final determination of the monthly NOI, the remaining funds shall be distributed according to a 50/50 split:");
	doc.moveDown(0.15);

	bulletBold(doc, "Participant Distribution (50%):", "Remitted to the Participant as a professional return on the contributed Asset.");
	bulletBold(doc, "Managerial Distribution (50%):", "Retained by the Manager as compensation for comprehensive fleet administration, scaling, and logistics management.");
	bulletBold(doc, "Payment Execution (Schedule A):", "All disbursements shall be issued to the Participant via the electronic payment method and banking instructions designated in the attached Schedule A (Payment & Banking Election Form). The Participant is responsible for maintaining the accuracy of the information in Schedule A to avoid processing delays.");
	doc.moveDown(0.2);

	subHeader(doc, "3.4 Settlement Cycle (Net-60).");
	para(doc, 'Reconciliation and disbursements shall adhere to a "Net-60" accounting window to accommodate standard industry receivable aging and the verification of all operational debits. Revenue generated within a specific calendar month shall be settled and paid on the last Friday of the subsequent calendar month (e.g., January production is settled and paid on the last Friday of February).');
	doc.moveDown(0.3);

	subHeader(doc, '3.5 Transparency and Reporting ("Birth-to-Death" Log).');
	para(doc, 'To provide the Participant with full operational visibility, each disbursement shall be accompanied by an itemized Monthly Settlement Statement. This statement shall provide a comprehensive "birth-to-death" financial log, including:');
	doc.moveDown(0.15);

	bullet(doc, "Total Gross Revenue per individual load.");
	bullet(doc, "An itemized breakdown of all Priority Expenses and Reserve allocations.");
	bullet(doc, "Verification of active duty cycles and ELD-supported production data.");
	doc.moveDown(0.2);

	subHeader(doc, "3.6 Finality of Settlement.");
	para(doc, "The Participant shall have forty-five (45) days from the date of the Settlement Statement to notify the Manager in writing of any discrepancies. Failure to provide written notice within this window shall constitute an absolute waiver of any claims regarding the accuracy of that specific Settlement Period.");

	/* ================================================================ */
	/*  ARTICLE 4                                                       */
	/* ================================================================ */

	articleHeader(doc, "ARTICLE 4: TERM, RENEWAL, AND EXIT STRATEGY");

	subHeader(doc, "4.01 Initial Term and Commencement.");
	para(doc, 'This Agreement shall commence on the Effective Date and shall remain in full force and effect for an initial period of one (1) year (the "Initial Term").');
	doc.moveDown(0.3);

	/* ================================================================ */
	/*  PAGE 6 — 4.02 - 4.05                                           */
	/* ================================================================ */

	subHeader(doc, "4.02 Automatic Successive Renewal.");
	para(doc, 'Upon the expiration of the Initial Term, this Agreement shall automatically renew for successive one (1) year periods (each a "Renewal Term") unless either Party provides formal written notice of non-renewal to the other Party at least thirty (30) days prior to the expiration of the then-current term.');
	doc.moveDown(0.3);

	subHeader(doc, "4.03 Termination for Convenience.");
	para(doc, "Either Party may terminate this Agreement without cause or penalty by providing thirty (30) days' prior written notice to the other Party. In the event of such termination:");
	doc.moveDown(0.15);

	bullet(doc, "The Participant remains entitled to their designated share of Net Operating Income (NOI) generated up to the physical date the Asset is officially decommissioned from the Manager's fleet.");
	bullet(doc, "All final disbursements remain subject to the Net-60 settlement cycle to ensure all trailing operational expenses, tolling, and regulatory chargebacks are reconciled.");
	bullet(doc, "The Participant shall cooperate fully with the Manager to ensure the timely removal of all Company-provided placards, ELD hardware, and regulatory decals.");
	doc.moveDown(0.2);

	subHeader(doc, "4.04 Termination for Material Breach or Safety Deficit.");
	para(doc, "The Manager reserves the right to terminate this Agreement immediately upon written notice under the following conditions:");
	doc.moveDown(0.15);

	bulletBold(doc, "Mechanical Instability:", "The Asset is deemed mechanically unsound, unsafe, or fails to meet Texas Department of Public Safety (DPS) or FMCSR roadworthiness standards.");
	bulletBold(doc, "Regulatory/Insurance Failure:", "The Asset becomes uninsurable at standard market rates or loses its apportioned registration status.");
	bulletBold(doc, "Operational Interference:", "The Participant, or its agents, interferes with the Exclusive Operational Control of the Manager, including unauthorized communication with assigned drivers or attempts to influence dispatch and routing.");
	bulletBold(doc, "Abandonment:", "Any attempt by the Participant to physically reclaim the Asset while under an active freight dispatch.");
	doc.moveDown(0.2);

	subHeader(doc, "4.05 Post-Termination Obligations.");
	para(doc, "Termination of this Agreement shall not release either Party from any liability which at the time of termination has already accrued, or which thereafter may accrue in respect to any act or omission prior to termination.");

	/* ================================================================ */
	/*  ARTICLE 5                                                       */
	/* ================================================================ */

	articleHeader(doc, "ARTICLE 5: LIABILITY, INSURANCE, AND RISK OF LOSS");

	subHeader(doc, "5.01 Primary Operational Insurance.");
	para(doc, "During the term of active dispatch, the Manager shall procure and maintain, as a Priority Expense, Commercial Automobile Liability and Cargo Insurance in such amounts as are required by the Federal Motor Carrier Safety Administration (FMCSA) and the Texas Department of Transportation (TxDOT). The Manager's obligation to provide such coverage is strictly limited to periods when the Asset is being operated in the furtherance of the Manager's business under USDOT# 4302683.");
	doc.moveDown(0.3);

	subHeader(doc, "5.02 Participant's Insurance Obligations.");
	para(doc, "The Participant shall, at its sole cost and expense, maintain Physical Damage Insurance (Comprehensive and Collision) covering the Asset for its full insurable value.");
	doc.moveDown(0.15);

	/* ================================================================ */
	/*  PAGE 7 — 5.02 continued + 5.03 - 5.05                          */
	/* ================================================================ */

	bulletBold(doc, "Non-Trucking Liability:", "The Participant is further responsible for maintaining Non-Trucking Liability (Bobtail) insurance for all periods during which the Asset is not under active dispatch by the Manager.");
	bulletBold(doc, "Proof of Coverage:", "The Participant shall provide the Manager with Certificates of Insurance naming LogisX Inc. as an Additional Insured and Loss Payee, as applicable, providing at least thirty (30) days' notice of cancellation.");
	doc.moveDown(0.2);

	subHeader(doc, "5.03 Limitation of Managerial Liability.");
	para(doc, "The Participant expressly acknowledges and agrees that the Manager shall not be liable, financially or otherwise, for:");
	doc.moveDown(0.15);

	bulletBold(doc, "Asset Depreciation:", "Any reduction in the market value of the Asset resulting from high-mileage utilization or market fluctuations.");
	bulletBold(doc, "Mechanical Wear and Tear:", "Component failures, engine degradation, or repairs resulting from standard operational use.");
	bulletBold(doc, "Uncovered Losses:", 'Any loss or damage to the Asset that is not expressly covered by the Manager\'s primary liability policy, including but not limited to acts of God or mechanical "breakdown".');
	doc.moveDown(0.2);

	subHeader(doc, "5.04 Indemnification by Participant.");
	para(doc, "The Participant agrees to indemnify, defend, and hold harmless LogisX Inc., its officers, and directors from and against any and all claims, damages, or legal expenses arising from:");
	doc.moveDown(0.15);

	bulletBold(doc, "Title and Liens:", "The Participant's failure to maintain clear legal title or satisfy any underlying debt service or liens associated with the Asset.");
	bulletBold(doc, "Pre-existing Defects:", "Latent or patent mechanical defects existing at the time of the Asset's contribution to the fleet.");
	bulletBold(doc, "Participant Negligence:", "Any acts or omissions by the Participant or its agents that jeopardize the Manager's regulatory standing or safety rating.");
	doc.moveDown(0.2);

	subHeader(doc, "5.05 Deductible Responsibility.");
	para(doc, "In the event of a covered loss under the Manager's insurance policies, the Participant shall be responsible for the payment of any applicable deductibles, which shall be treated as a Priority Expense and deducted from the Net Operating Income (NOI) or the Maintenance Reserve.");

	/* ================================================================ */
	/*  ARTICLE 6                                                       */
	/* ================================================================ */

	articleHeader(doc, "ARTICLE 6: FORCE MAJEURE AND OPERATIONAL DISRUPTION");

	subHeader(doc, "6.01 Definition of Force Majeure.");
	para(doc, "Neither Party shall be liable for any delay or failure to perform its obligations under this Agreement (excluding the Participant's obligation to maintain Physical Damage Insurance or the Manager's obligation to remit settled NOI) if such delay or failure is caused by a Force Majeure Event. A Force Majeure Event refers to any cause beyond the reasonable control of the affected Party, including, but not limited to:");
	doc.moveDown(0.15);

	bullet(doc, "Acts of God, flood, fire, earthquake, or explosion;");
	bullet(doc, "War, invasion, hostilities (whether war is declared or not), terrorist threats, or acts;");
	bullet(doc, "Government-mandated lockdowns, national or regional emergencies, or pandemics;");

	/* ================================================================ */
	/*  PAGE 8 — 6.01 continued + 6.02 - 6.04                          */
	/* ================================================================ */

	bullet(doc, "Strikes, labor stoppages, or slowdowns; and");
	bullet(doc, "Material disruptions to national fuel supplies or the interstate highway system.");
	doc.moveDown(0.2);

	subHeader(doc, "6.02 Notice of Delay.");
	para(doc, "The Party whose performance is affected by a Force Majeure Event shall give written notice to the other Party within five (5) business days of the commencement of the event, stating the period of time the occurrence is expected to continue and the specific obligations affected.");
	doc.moveDown(0.3);

	subHeader(doc, "6.03 Market-Driven Suspension.");
	para(doc, 'In addition to the above, the Parties acknowledge that the commercial transportation industry is subject to extreme volatility in fuel prices and freight market spot rates. The Manager reserves the right to temporarily suspend operations (Grounding) of the Asset if current market conditions render the continued operation of the Asset mathematically non-profitable for the fleet. During such a suspension, no Priority Expenses (excluding Fixed Overhead) shall accrue, and no "debt service" or participation yield shall be owed to the Participant.');
	doc.moveDown(0.3);

	subHeader(doc, "6.04 Termination During Force Majeure.");
	para(doc, "If a Force Majeure Event or Market-Driven Suspension continues for a period of more than sixty (60) consecutive days, either Party may terminate this Agreement upon written notice, subject to the final reconciliation and settlement of any outstanding NOI.");

	/* ================================================================ */
	/*  ARTICLE 7                                                       */
	/* ================================================================ */

	articleHeader(doc, "ARTICLE 7: GOVERNING LAW, DISPUTE RESOLUTION, AND MISCELLANEOUS PROVISIONS");

	subHeader(doc, "7.01 Governing Law.");
	para(doc, "This Agreement, and all claims or causes of action (whether in contract, tort, or statute) that may be based upon, arise out of, or relate to this Agreement, shall be governed by, and enforced in accordance with, the internal laws of the State of Texas, including its statutes of limitations, without regard to any borrowing statute or conflict of laws principles that would result in the application of the laws of a different jurisdiction.");
	doc.moveDown(0.3);

	subHeader(doc, "7.02 Mandatory Binding Arbitration.");
	para(doc, "Any dispute, controversy, or claim arising out of or relating to this Agreement, or the breach, termination, or invalidity thereof, shall be settled by final and binding arbitration administered by the American Arbitration Association (AAA) in accordance with its Commercial Arbitration Rules.");
	doc.moveDown(0.15);

	bulletBold(doc, "Venue:", "The place of arbitration shall be Montgomery County, Texas.");
	bulletBold(doc, "Authority:", "The arbitrator shall have the power to rule on his or her own jurisdiction, including any objections with respect to the existence, scope, or validity of the arbitration agreement or to the arbitrability of any claim or counterclaim.");
	bulletBold(doc, "Judgment:", "The award rendered by the arbitrator shall be final, and judgment may be entered upon it in any court having jurisdiction thereof.");
	doc.moveDown(0.2);

	/* ================================================================ */
	/*  PAGE 9 — 7.03 - 7.06 + Signatures                              */
	/* ================================================================ */

	subHeader(doc, "7.03 Waiver of Jury Trial and Class Actions.");
	doc.font(B).fontSize(10).fillColor(BLACK);
	doc.text("THE PARTIES HEREBY IRREVOCABLY WAIVE, TO THE FULLEST EXTENT PERMITTED BY APPLICABLE LAW, ANY RIGHT THEY MAY HAVE TO A TRIAL BY JURY IN ANY LEGAL PROCEEDING DIRECTLY OR INDIRECTLY ARISING OUT OF OR RELATING TO THIS AGREEMENT.", MARGIN, doc.y, { width: W, lineGap: 2 });
	doc.font(R).fontSize(10);
	doc.text(" Furthermore, the Parties agree that any arbitration shall be conducted in their individual capacities only and not as a class action or other representative action, and the Parties expressly waive their right to file a class action or seek relief on a class basis.", MARGIN, doc.y, { width: W, lineGap: 2 });
	doc.moveDown(0.3);

	subHeader(doc, "7.04 Prevailing Party Attorney's Fees.");
	para(doc, "In the event that any Party institutes any legal suit, action, or proceeding (including arbitration) against the other Party arising out of or relating to this Agreement, the prevailing Party in the suit, action, or proceeding shall be entitled to receive, in addition to all other damages to which it may be entitled, the costs incurred by such Party in conducting the suit, action, or proceeding, including reasonable attorneys' fees and expenses and court costs.");
	doc.moveDown(0.3);

	subHeader(doc, "7.05 Severability.");
	para(doc, "If any term or provision of this Agreement is found by a court of competent jurisdiction to be invalid, illegal, or unenforceable, such invalidity, illegality, or unenforceability shall not affect any other term or provision of this Agreement or invalidate or render unenforceable such term or provision in any other jurisdiction.");
	doc.moveDown(0.3);

	subHeader(doc, "7.06 Entire Agreement.");
	para(doc, "This Agreement, including Exhibit A and Schedule A, constitutes the sole and entire agreement of the Parties with respect to the subject matter contained herein, and supersedes all prior and contemporaneous understandings, agreements, representations, and warranties, both written and oral, with respect to such subject matter. No amendment to or modification of this Agreement is effective unless it is in writing and signed by an authorized representative of each Party.");

	/* ================================================================ */
	/*  SIGNATURE BLOCK                                                 */
	/* ================================================================ */

	checkPageSpace(doc, 220);
	doc.moveDown(1);
	doc.moveTo(MARGIN, doc.y).lineTo(PAGE_W - MARGIN, doc.y).strokeColor("#999").lineWidth(0.5).stroke();
	doc.moveDown(0.6);

	doc.font(B).fontSize(12).fillColor(BLACK).text("IN WITNESS WHEREOF", { align: "center" });
	doc.moveDown(0.3);
	doc.font(R).fontSize(10).fillColor(BLACK)
		.text("the Parties have executed this Agreement as of the Effective Date.", { align: "center", width: W });
	doc.moveDown(0.8);

	// --- MANAGER signature ---
	doc.font(B).fontSize(11).fillColor(BLACK).text('MANAGER: LogisX Inc.', MARGIN);
	doc.moveDown(0.5);

	const mgrSigY = doc.y;
	doc.font(R).fontSize(10).text("By:", MARGIN, mgrSigY);
	sigLine(doc, MARGIN + 25, mgrSigY + 12, 200);
	doc.font(R).fontSize(10).text("Date:", 320, mgrSigY);
	sigLine(doc, 350, mgrSigY + 12, 160);

	// Pre-fill manager
	doc.font(B).fontSize(11).fillColor(BLUE).text("Deshorn King", MARGIN + 28, mgrSigY - 1);
	doc.fillColor(BLACK);
	const dateStr = effectiveDate || new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
	doc.font(R).fontSize(9).fillColor(BLUE).text(dateStr, 355, mgrSigY);
	doc.fillColor(BLACK);

	doc.y = mgrSigY + 20;
	doc.font(R).fontSize(10).text("Printed Name:", MARGIN, doc.y);
	sigLine(doc, MARGIN + 90, doc.y + 12, 135);
	doc.font(B).fontSize(10).fillColor(BLUE).text("Deshorn King", MARGIN + 93, doc.y - 1);
	doc.fillColor(BLACK);

	doc.moveDown(0.3);
	doc.font(R).fontSize(10).text("Title:", MARGIN, doc.y);
	sigLine(doc, MARGIN + 40, doc.y + 12, 185);
	doc.font(R).fontSize(10).fillColor(BLUE).text("CEO / Managing Member", MARGIN + 43, doc.y - 1);
	doc.fillColor(BLACK);
	doc.moveDown(1);

	// --- PARTICIPANT signature ---
	doc.font(B).fontSize(11).fillColor(BLACK).text("PARTICIPANT:", MARGIN);
	doc.moveDown(0.5);

	const ptSigY = doc.y;
	doc.font(R).fontSize(10).text("By:", MARGIN, ptSigY);
	sigLine(doc, MARGIN + 25, ptSigY + 12, 200);
	doc.font(R).fontSize(10).text("Date:", 320, ptSigY);
	sigLine(doc, 350, ptSigY + 12, 160);

	// Fill participant signature
	if (signatureText) {
		doc.font(B).fontSize(11).fillColor(BLUE).text(signatureText, MARGIN + 28, ptSigY - 1);
		doc.fillColor(BLACK);
	}
	doc.font(R).fontSize(9).fillColor(BLUE).text(dateStr, 355, ptSigY);
	doc.fillColor(BLACK);

	// Embed drawn signature image next to text
	if (signatureImage) {
		try {
			const sigBuf = Buffer.from(signatureImage.replace(/^data:image\/\w+;base64,/, ""), "base64");
			const sigImgX = signatureText
				? MARGIN + 28 + doc.font(B).fontSize(11).widthOfString(signatureText) + 10
				: MARGIN + 28;
			doc.image(sigBuf, sigImgX, ptSigY - 15, { width: 130, height: 35 });
		} catch { /* skip if image fails */ }
	}

	doc.y = ptSigY + 20;
	doc.font(R).fontSize(10).text("Printed Name:", MARGIN, doc.y);
	sigLine(doc, MARGIN + 90, doc.y + 12, 135);
	if (signatureText) {
		doc.font(B).fontSize(10).fillColor(BLUE).text(signatureText, MARGIN + 93, doc.y - 1);
		doc.fillColor(BLACK);
	}

	doc.moveDown(0.3);
	doc.font(R).fontSize(10).text("Title:", MARGIN, doc.y);
	sigLine(doc, MARGIN + 40, doc.y + 12, 185);
	if (contactTitle) {
		doc.font(R).fontSize(10).fillColor(BLUE).text(contactTitle, MARGIN + 43, doc.y - 1);
		doc.fillColor(BLACK);
	}

	// Participant info block
	doc.moveDown(0.8);
	const participantLabel = legalName + (dba ? ` (DBA: ${dba})` : "") + (entityType ? ` \u2014 ${entityType}` : "");
	if (participantLabel) {
		doc.font(B).fontSize(9).fillColor(BLUE).text(participantLabel, MARGIN);
	}
	if (address) {
		doc.font(R).fontSize(9).fillColor(BLUE).text(address, MARGIN);
	}
	const contactLine = [contactPerson, phone, email].filter(Boolean).join(" | ");
	if (contactLine) {
		doc.font(R).fontSize(8).fillColor(BLUE).text(contactLine, MARGIN);
	}
	if (einSsn) {
		doc.font(R).fontSize(8).fillColor(BLUE).text("EIN/SSN: " + einSsn, MARGIN);
	}
	doc.fillColor(BLACK);

	/* ================================================================ */
	/*  EXHIBIT A — ASSET SPECIFICATION & CONDITION REPORT              */
	/* ================================================================ */

	doc.addPage();

	doc.font(B).fontSize(14).fillColor(BLACK);
	doc.text("EXHIBIT A", { align: "center" });
	doc.font(B).fontSize(12);
	doc.text("ASSET SPECIFICATION & CONDITION REPORT", { align: "center" });
	doc.moveDown(0.5);

	doc.font(R).fontSize(10).fillColor(BLACK);
	doc.text("This Exhibit is incorporated into and made part of the Master Participation & Management Agreement.", MARGIN, doc.y, { width: W, lineGap: 2 });
	doc.moveDown(0.6);

	// I. Vehicle Identification
	doc.font(B).fontSize(11).text("I. VEHICLE IDENTIFICATION", MARGIN);
	doc.moveDown(0.4);

	// Vehicle table
	const colWidths = [60, 80, 80, 280];
	const tableX = MARGIN + 10;
	const tableW = colWidths.reduce((a, b) => a + b, 0);
	const rowH = 22;

	// Header row
	const headerY = doc.y;
	let cellX = tableX;
	const headers = ["Year", "Make", "Model", "VIN (Vehicle Identification Number)"];
	doc.font(B).fontSize(9).fillColor(BLACK);
	colWidths.forEach((cw, i) => {
		doc.rect(cellX, headerY, cw, rowH).stroke();
		doc.text(headers[i], cellX + 5, headerY + 6, { width: cw - 10 });
		cellX += cw;
	});
	doc.y = headerY + rowH;

	// Vehicle rows
	const vehicleList = vehicles.length > 0 ? vehicles : [{ year: "", make: "", model: "", vin: "" }];
	vehicleList.forEach((v) => {
		const ry = doc.y;
		cellX = tableX;
		const vals = [
			String(v.year || ""),
			v.make || "",
			v.model || "",
			v.vin || "",
		];
		doc.font(R).fontSize(9).fillColor(BLUE);
		colWidths.forEach((cw, i) => {
			doc.rect(cellX, ry, cw, rowH).strokeColor("#000").stroke();
			doc.text(vals[i], cellX + 5, ry + 6, { width: cw - 10 });
			cellX += cw;
		});
		doc.fillColor(BLACK);
		doc.y = ry + rowH;
	});
	doc.moveDown(0.6);

	// II. Regulatory & Compliance Data
	doc.font(B).fontSize(11).fillColor(BLACK).text("II. REGULATORY & COMPLIANCE DATA", MARGIN);
	doc.moveDown(0.3);

	const firstVehicle = vehicles[0] || {};

	bulletBold(doc, "Current Mileage:", blankField(firstVehicle.mileage, "________________"));
	bulletBold(doc, "Title State:", blankField(firstVehicle.titleState, "________________"));
	bulletBold(doc, "Existing Liens (if any):", blankField(firstVehicle.liens, "________________"));
	bulletBold(doc, "Registered Owner:", blankField(firstVehicle.registeredOwner || legalName, "________________"));
	doc.moveDown(0.5);

	// III. Ancillary Equipment Included
	doc.font(B).fontSize(11).fillColor(BLACK).text("III. ANCILLARY EQUIPMENT INCLUDED", MARGIN);
	doc.moveDown(0.3);

	const checkItems = [
		"[ ] ELD Hardware installed? (Make/Model): ________________",
		"[ ] Telematics/GPS installed? ___________________________",
		"[ ] Dashcam System? __________________________________",
		"[ ] Sleeper Berthing/Inverter? __________________________",
		"[ ] Auxiliary Power Unit? __________________________",
	];
	checkItems.forEach((item) => {
		bullet(doc, item);
	});
	doc.moveDown(0.5);

	// IV. Owner Acknowledgment of Condition
	doc.font(B).fontSize(11).fillColor(BLACK).text("IV. OWNER ACKNOWLEDGMENT OF CONDITION", MARGIN);
	doc.moveDown(0.3);

	para(doc, 'The Participant hereby certifies that the Asset is in "Good and Safe" operating condition, free of known major mechanical defects, and meets all FMCSA and Texas DPS roadworthiness standards as of the date of delivery to the Manager.');
	doc.moveDown(0.6);

	// Exhibit A signature
	const exSigY = doc.y;
	doc.font(R).fontSize(10).fillColor(BLACK).text("Participant Signature:", MARGIN, exSigY);
	sigLine(doc, MARGIN + 130, exSigY + 12, 180);
	doc.font(R).fontSize(10).text("Date:", 380, exSigY);
	sigLine(doc, 410, exSigY + 12, 110);

	if (signatureText) {
		doc.font(B).fontSize(11).fillColor(BLUE).text(signatureText, MARGIN + 135, exSigY - 1);
		doc.fillColor(BLACK);
	}
	doc.font(R).fontSize(9).fillColor(BLUE).text(dateStr, 415, exSigY);
	doc.fillColor(BLACK);

	if (signatureImage) {
		try {
			const sigBuf2 = Buffer.from(signatureImage.replace(/^data:image\/\w+;base64,/, ""), "base64");
			doc.image(sigBuf2, MARGIN + 200, exSigY - 15, { width: 100, height: 30 });
		} catch { /* skip */ }
	}

	/* ================================================================ */
	/*  SCHEDULE A — DISBURSEMENT & BANKING ELECTION FORM               */
	/* ================================================================ */

	doc.addPage();

	doc.font(B).fontSize(14).fillColor(BLACK);
	doc.text("SCHEDULE A", { align: "center" });
	doc.font(B).fontSize(12);
	doc.text("DISBURSEMENT & BANKING ELECTION FORM", { align: "center" });
	doc.moveDown(0.5);

	doc.font(R).fontSize(10).fillColor(BLACK);
	doc.text("This Schedule defines the method and destination for all NOI Payouts.", MARGIN, doc.y, { width: W, lineGap: 2 });
	doc.moveDown(0.6);

	// I. Revenue Recipient Information
	doc.font(B).fontSize(11).text("I. REVENUE RECIPIENT INFORMATION", MARGIN);
	doc.moveDown(0.3);

	doc.font(R).fontSize(10).fillColor(BLACK);
	doc.text("\u2022  Legal Name (as it appears on W-9): ", MARGIN + 20, doc.y, { width: W - 20, continued: true, lineGap: 2 });
	doc.font(B).fillColor(BLUE).text(blankField(legalName), { width: W - 20, lineGap: 2 });
	doc.fillColor(BLACK);
	doc.moveDown(0.15);

	doc.font(R).fontSize(10).fillColor(BLACK);
	doc.text("\u2022  Tax ID / SSN: ", MARGIN + 20, doc.y, { width: W - 20, continued: true, lineGap: 2 });
	doc.font(B).fillColor(BLUE).text(blankField(einSsn), { width: W - 20, lineGap: 2 });
	doc.fillColor(BLACK);
	doc.moveDown(0.15);

	doc.font(R).fontSize(10).fillColor(BLACK);
	doc.text("\u2022  Email for Settlement Statements: ", MARGIN + 20, doc.y, { width: W - 20, continued: true, lineGap: 2 });
	doc.font(B).fillColor(BLUE).text(blankField(email), { width: W - 20, lineGap: 2 });
	doc.fillColor(BLACK);
	doc.moveDown(0.5);

	// II. Banking Instructions
	doc.font(B).fontSize(11).fillColor(BLACK).text("II. BANKING INSTRUCTIONS (ACH/DIRECT DEPOSIT)", MARGIN);
	doc.moveDown(0.3);

	const bankingFields = [
		"Bank Name: __________________________________________",
		"Account Type: [ ] Business Checking  [ ] Personal Checking  [ ] Savings",
		"Routing Number (9 Digits): ____________________________",
		"Account Number: _____________________________________",
	];
	bankingFields.forEach((field) => {
		bullet(doc, field);
	});
	doc.moveDown(0.5);

	// III. Settlement Acknowledgment
	doc.font(B).fontSize(11).fillColor(BLACK).text("III. SETTLEMENT ACKNOWLEDGMENT", MARGIN);
	doc.moveDown(0.3);

	para(doc, "The Participant acknowledges that all disbursements follow the Net-60 Settlement Cycle (e.g., revenue from the 1st through the 31st of Month A is disbursed on the last Friday of Month B). The Participant is responsible for notifying the Manager of any changes to banking information at least ten (10) business days prior to a scheduled settlement.");
	doc.moveDown(0.8);

	// Schedule A signature
	const schSigY = doc.y;
	doc.font(R).fontSize(10).fillColor(BLACK).text("Participant Signature:", MARGIN, schSigY);
	sigLine(doc, MARGIN + 130, schSigY + 12, 180);
	doc.font(R).fontSize(10).text("Date:", 380, schSigY);
	sigLine(doc, 410, schSigY + 12, 110);

	if (signatureText) {
		doc.font(B).fontSize(11).fillColor(BLUE).text(signatureText, MARGIN + 135, schSigY - 1);
		doc.fillColor(BLACK);
	}
	doc.font(R).fontSize(9).fillColor(BLUE).text(dateStr, 415, schSigY);
	doc.fillColor(BLACK);

	if (signatureImage) {
		try {
			const sigBuf3 = Buffer.from(signatureImage.replace(/^data:image\/\w+;base64,/, ""), "base64");
			doc.image(sigBuf3, MARGIN + 200, schSigY - 15, { width: 100, height: 30 });
		} catch { /* skip */ }
	}

	doc.end();
	return getBuffer();
}

module.exports = { generateMasterAgreement };
