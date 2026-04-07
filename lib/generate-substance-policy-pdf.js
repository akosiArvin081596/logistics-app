const PDFDocument = require("pdfkit");

const BLUE = "#1a56db";
const BLACK = "#1a1d27";
const GRAY = "#6b7280";
const MARGIN = 50;
const PAGE_W = 612;

function generateSubstancePolicy(data) {
	return new Promise((resolve, reject) => {
		const doc = new PDFDocument({ size: "LETTER", margin: MARGIN, bufferPages: true });
		const chunks = [];
		doc.on("data", (c) => chunks.push(c));
		doc.on("end", () => resolve(Buffer.concat(chunks)));
		doc.on("error", reject);

		const { fullName = "", effectiveDate = "", signatureImage } = data;
		const B = "Helvetica-Bold";
		const R = "Helvetica";
		const BI = "Helvetica-BoldOblique";
		const IT = "Helvetica-Oblique";
		const W = PAGE_W - 2 * MARGIN;
		const fs = 9.5; // smaller font for dense content

		function title() {
			doc.font(B).fontSize(14).fillColor(BLACK).text("CONTROLLED SUBSTANCE POLICY AND PROCEDURE", { align: "center" });
			doc.moveDown(0.6);
		}

		function para(text) { doc.font(R).fontSize(fs).fillColor(BLACK).text(text, MARGIN, doc.y, { width: W, lineGap: 1.5 }); }
		function paraBold(text) { doc.font(B).fontSize(fs).fillColor(BLACK).text(text, MARGIN, doc.y, { width: W, lineGap: 1.5 }); }

		function numberedItem(num, text, indent = 30) {
			if (doc.y > 710) doc.addPage();
			doc.font(R).fontSize(fs).fillColor(BLACK).text(`${num}. ${text}`, MARGIN + indent, doc.y, { width: W - indent, lineGap: 1.5 });
			doc.moveDown(0.15);
		}

		function tableRow(cells, y, colWidths, bold) {
			let x = MARGIN + 20;
			cells.forEach((cell, i) => {
				doc.font(bold ? B : R).fontSize(fs).fillColor(BLACK);
				doc.text(cell, x, y, { width: colWidths[i] - 5, lineGap: 1 });
				x += colWidths[i];
			});
		}

		// ====== PAGE 1 ======
		title();

		para("LogisX Inc. is committed to upholding safe workplace free of drug and alcohol misuse. Any location in which LogisX Inc. conducts business, whether on LogisX Inc. owned property, in LogisX Inc. owned or leased vehicle(s), a customer\u2019s place of business, or any location at which the business of LogisX Inc. is conducted, is designated a drug and alcohol-free workplace.");
		doc.moveDown(0.4);

		doc.font(R).fontSize(fs).text("This policy follows DOT and FMCSA regulations found in ", MARGIN, doc.y, { width: W, continued: true, lineGap: 1.5 });
		doc.font(B).text("49 CFR Parts 40 and 382", { continued: true });
		doc.font(R).text(". If you have questions about this controlled substances and alcohol testing policy, contact the designated LogisX Inc. representative to answer questions about this policy. LogisX Inc. has appointed, as its designee:", { width: W, lineGap: 1.5 });
		doc.moveDown(0.5);

		// Designee info (simple indented block, no box)
		doc.moveDown(0.3);
		const infoX = MARGIN + 40;
		doc.font(B).fontSize(fs).text("NAME:", infoX, doc.y, { continued: true, width: 80 });
		doc.font(R).text("Leslie M. Johnson");
		doc.font(B).text("LOCATION:", infoX, doc.y, { continued: true, width: 80 });
		doc.font(R).text("Conroe, TX 77301");
		doc.font(B).text("PHONE:", infoX, doc.y, { continued: true, width: 80 });
		doc.font(R).text("321-848-3437");
		doc.moveDown(0.4);

		para("All drivers who operate Commercial Motor Vehicles (CMV) which require a Commercial Driver\u2019s License are subject to controlled substances and alcohol testing. This policy applies to all LogisX Inc. employee drivers or leased/contracted drivers and all other persons who perform Safety Sensitive Functions or operate under the US DOT Motor Carrier Authority of LogisX Inc.. Any person performing a safety sensitive function is deemed to have consented to all controlled substance testing as mandated by any State or jurisdiction in the enforcement of 49 CFR Part 382.");
		doc.moveDown(0.4);

		para("Controlled Substance Testing includes, but may not be limited to, the following substances: Marijuana, Opiates, Amphetamines, Methamphetamines, Cocaine, Heroin, Phencyclidine, and MDMA/Ecstasy. Many types of prescribed pharmaceuticals are prohibited substances. Please check with your designated LogisX Inc. representative for information if you are taking a prescription medication which may be prohibited. All DOT controlled substance testing and alcohol documentation, including questions asked and information provided by the designated LogisX Inc. LLC representative are CONFIDENTIAL and will be maintained in a PRIVATE and CONFIDENTIAL manner at LogisX Inc.");
		doc.moveDown(0.4);

		para("The definition of driver Safety Sensitive Function is found at 49 CFR Section 382.107 (attached) Safety sensitive function means: all times from the time a driver begins to work or is required to be ready to work until the time he/she is relieved from work and all responsibility for performing work has concluded. LogisX Inc. has determined that for ease of understanding, it considers all driver personnel Safety Sensitive Function workdays to include One Hour prior to beginning the workday.");
		doc.moveDown(0.4);

		paraBold("Safety Sensitive Functions shall include:");
		doc.moveDown(0.2);
		numberedItem("1", "All times at an employer or shipper plant, terminal, facility, or other property, or on any public property, waiting to be dispatched, unless the driver has been relieved from duty by the employer;");
		numberedItem("2", "All times inspection equipment as required by 49 CFR Sections 392.7 and 392.8, or otherwise inspecting, servicing, or conditioning any commercial motor vehicle at any time;");
		numberedItem("3", "All times spent at the driving controls of a commercial motor vehicle in operation;");
		numberedItem("4", "All times, other than driving time, in or upon a commercial motor vehicle except time spent resting in a sleeper berth, (requirements for sleeper berth are found at 49 CFR Section 393.76);");
		numberedItem("5", "All times loading or unloading a vehicle, supervising or assisting in the loading or unloading, attending a vehicle being loaded or unloaded, remaining in readiness to operate the vehicle or in giving or receiving receipts for shipments loaded or unloaded; and");
		numberedItem("6", "All times repairing, obtaining assistance, or remaining in attendance upon a disabled vehicle.");

		// ====== PAGE 2 — Prohibited Conduct ======
		doc.addPage();
		title();

		paraBold("Prohibited Conduct:");
		doc.moveDown(0.2);
		doc.font(R).fontSize(fs).text("Driver Conduct that is prohibited is found at ", MARGIN, doc.y, { width: W, continued: true, lineGap: 1.5 });
		doc.font(B).text("49 CFR Part 382, Subpart B", { continued: true });
		doc.font(R).text(" (Table 1) and includes the following:", { width: W, lineGap: 1.5 });
		doc.moveDown(0.3);

		// Table 1
		paraBold("Table 1");
		doc.moveDown(0.2);
		const t1 = [
			["382.201", "No driver shall report for duty requiring the performance of a safety sensitive function with an alcohol concentration of 0.04 or greater."],
			["382.205", "No driver shall use alcohol while performing a safety sensitive function."],
			["382.207", "No driver required to take a post-accident alcohol test under 49 CFR 382.209 shall use alcohol for 8 hours following the accident."],
			["382.211", "No driver shall refuse to submit any required alcohol or controlled substances test."],
			["382.213", "No driver shall report for duty requiring the performance of a safety sensitive function when the driver uses controlled substances, except when the use is pursuant to the instructions of a licensed medical practitioner, as defined in 49 CFR 382.107."],
			["382.215", "No driver shall report for duty or remain on duty requiring the performance of a safety sensitive function if the driver tests positive for controlled substances."],
		];
		t1.forEach(([code, text]) => {
			if (doc.y > 680) doc.addPage();
			const rowY = doc.y;
			doc.font(B).fontSize(fs).text(code, MARGIN + 20, rowY, { width: 55 });
			doc.font(R).fontSize(fs).text(text, MARGIN + 75, rowY, { width: W - 95, lineGap: 1.5 });
			doc.moveDown(0.3);
		});

		doc.moveDown(0.4);
		doc.font(R).fontSize(fs).text("The circumstances which prompt driver testing are incorporated herein and found at ", MARGIN, doc.y, { width: W, continued: true, lineGap: 1.5 });
		doc.font(B).text("49 CFR Part 382 Subpart C", { continued: true });
		doc.font(R).text(" (Table 2):", { width: W, lineGap: 1.5 });
		doc.moveDown(0.3);

		// Table 2
		paraBold("Table 2");
		doc.moveDown(0.2);
		const t2y = doc.y;
		const t2cols = [240, 240];
		const t2rows = [
			["382.301 Pre-employment testing", "382.307 Reasonable Suspicion testing"],
			["382.303 Post-Accident testing", "382.309 Return to Duty testing"],
			["382.305 Random testing, per the prevailing rate as required by U.S. DOT", "382.311 Follow-Up testing"],
		];
		let rowY = t2y;
		t2rows.forEach(row => {
			const leftH = doc.heightOfString(row[0], { width: t2cols[0] - 10, font: B, fontSize: fs });
			const rightH = doc.heightOfString(row[1], { width: t2cols[1] - 10, font: B, fontSize: fs });
			doc.font(B).fontSize(fs).text(row[0], MARGIN + 20, rowY, { width: t2cols[0] - 10 });
			doc.font(B).fontSize(fs).text(row[1], MARGIN + 20 + t2cols[0], rowY, { width: t2cols[1] - 10 });
			rowY += Math.max(leftH, rightH) + 6;
		});
		doc.y = rowY + 5;

		doc.moveDown(0.3);
		para("No driver tested under the provisions of subpart C of this part (Section 382) and found to have an alcohol concentration of 0.02 or greater, but less than 0.04 shall perform or continue to perform safety sensitive functions, including driving a commercial motor vehicle, nor shall he/she be permitted to perform or continue to perform safety sensitive functions, until the start of the driver\u2019s next regularly schedule duty period, but in any event not less than 24 hours following administration of the test. Any alcohol test result with a concentration of 0.02 or above is subject to disciplinary review by LogisX Inc.");
		doc.moveDown(0.4);

		para("All definitions, regulations and procedures used to test for controlled substances and alcohol, to protect the integrity of the testing process, safeguard test validity, and ensure results are attributed to the correct driver, are found in 49 CFR Parts 40 and 382. They are incorporated into this policy by reference and attached, hereto.");
		doc.moveDown(0.4);

		para("The Federal Motor Carrier Safety Regulations specify that when a driver is involved in an accident, he/she must submit to post-accident drug and alcohol testing as soon as reasonably possible, whenever there is a human fatality, or when the driver is issued a citation by law enforcement, AND there is bodily injury of a person requiring immediate medical treatment away from the scene, or there is disabling damage to a motor vehicle involved in the accident requiring a tow from the scene. (49 CFR Part 382.303) You must contact your designated LogisX Inc. representative as soon as reasonably possible after an accident if you have a question about whether post-accident testing is required. Drivers required by a scene commander or legal authority at the accident scene, to undergo post-accident testing following an accident must comply regardless of the above definitions. Failure to do so constitutes a refusal to test. Where not otherwise commanded by law enforcement, LogisX Inc. will require said driver to submit to post accident screening as required by 49 CFR Part 382.303.");
		doc.moveDown(0.4);

		para("Refusal to submit to required controlled substance or alcohol testing is in direct violation of Federal Motor Carrier Safety Regulations and the policy set forth by LogisX Inc. No excuse, when instructed to report for or submit to testing, is acceptable. Failure to be available for testing will be construed as a refusal to test. In accord with the Federal Motor Carrier Safety Regulations, a refusal to test is equivalent to a positive test result. A positive test result is subject to disciplinary review by LogisX Inc.");
		doc.moveDown(0.4);

		// Table 3 — Refusal definitions
		doc.font(R).fontSize(fs).text("Refusal of a driver to submit to an alcohol or controlled substances test is defined in ", MARGIN, doc.y, { width: W, continued: true, lineGap: 1.5 });
		doc.font(B).text("49 CFR 382.107", { continued: true });
		doc.font(R).text(" (Table 3):", { width: W, lineGap: 1.5 });
		doc.moveDown(0.3);

		paraBold("Table 3");
		doc.moveDown(0.1);
		para("To refuse to submit (to an alcohol or controlled substances test) means that a driver:");
		doc.moveDown(0.2);
		const t3items = [
			"Fails to appear for any test (except a Pre-employment test) within a reasonable time, as determined by the employer, consistent with applicable DOT agency regulations, after being directed to do so by the employer.",
			"Fails to remain at the testing site until the testing proceeds are complete.",
			"Fails to provide a urine specimen for any drug test required by this part or DOT agency regulations.",
			"(In the case of a directly observed or monitored collection in a drug test,) fails to permit the observation or monitoring of the driver\u2019s provision of a specimen;",
			"Fails to provide a sufficient amount of urine specimen when directed, and it has been determined that there was no adequate medical explanation for the failure;",
			"Fails or declines to take a second test the employer or the collector has directed the driver to take;",
			"Fails to undergo a medical examination or evaluation, as directed by the MRO as part of the verification process, or as directed by the DER under 49 CFR 40.193(d).",
			"Fails to cooperate with any part of the testing process (e.g., refuse to empty pockets when so directed by the collector, behave in a confrontational way that disrupts the collection process); or",
			"Is reported by the MRO as having a verified adulterated or substituted test result.",
		];
		t3items.forEach((text, i) => numberedItem(String(i + 1), text));

		doc.moveDown(0.3);
		doc.font(B).fontSize(fs).text("Note:", MARGIN, doc.y, { width: W, continued: true });
		doc.font(R).text(' In reference to item 1 for the FMCSA: "Immediate" means that the employer shall ensure the driver ceases to perform the safety sensitive function and proceeds to the testing site as soon as possible.', { width: W, lineGap: 1.5 });

		// ====== PAGE — Consequences + Search + Approval ======
		doc.addPage();
		title();

		doc.font(R).fontSize(fs).text("The consequences for violators of Subpart B are incorporated and found in ", MARGIN, doc.y, { width: W, continued: true, lineGap: 1.5 });
		doc.font(B).text("49 CFR Part 382 Subpart E", { continued: true });
		doc.font(R).text(" (Table 4):", { width: W, lineGap: 1.5 });
		doc.moveDown(0.3);

		paraBold("Table 4");
		doc.moveDown(0.2);
		const t4 = [
			"All CDL drivers will be removed from any safety sensitive position.",
			"The driver must see a Substance Abuse Professional to ever drive again, anywhere.",
			"The driver must take a Return to Duty test with a Negative result and/or an Alcohol test with results below 0.02.",
		];
		t4.forEach(text => { para(text); doc.moveDown(0.15); });

		doc.moveDown(0.4);
		paraBold("Search and Seizure:");
		doc.moveDown(0.2);
		para("LogisX Inc. has the right to conduct an on the spot search and inspection of personnel on company property, their personal property and effects, to include, but not be limited to: Lockers, baggage, offices, desks, tool boxes, clothing, personal storage containers, medicine containers, and vehicles to determine if such personnel may be using, possessing, selling, distributing, concealing, manufacturing, dispensing or transporting any controlled substance.");
		doc.moveDown(0.4);

		para("In the event a driver presents signs of being under the influence of a controlled substance or alcohol, he/she will be taken to a DOT collection site for testing. Reasonable suspicion screening will be conducted when signs of being under the influence are personally observed and can be reasonably articulated as to what behaviors are being observed. This is known as a \u201CContemporaneous and Articulable\u201D policy. Documentation must be completed by LogisX Inc. as a witness report. At least one witness to the behaviors presented must be a trained supervisor.");
		doc.moveDown(0.4);

		para("A positive controlled substance or alcohol test will result in immediate removal from all safety sensitive functions. The driver will receive referral information to qualified substance abuse professionals in their domiciled area. LogisX Inc. reserves the right to discipline or immediately terminate the employment or contract of any driver following a positive drug or alcohol test.");
		doc.moveDown(0.6);

		doc.font(BI).fontSize(fs).fillColor("#c0392b").text("This policy was written in April 2025", { align: "center" });
		doc.fillColor(BLACK);
		doc.moveDown(1);

		// Intervening section
		doc.font(B).fontSize(14).text("CONTROLLED SUBSTANCE POLICY AND PROCEDURE", { align: "center" });
		doc.moveDown(0.6);
		doc.font(B).fontSize(11).text("Intervening when a drug or alcohol problem is suspected", MARGIN, doc.y, { underline: true, align: "center", width: W });
		doc.moveDown(0.5);
		para("LogisX Inc., requests that any signs or symptoms of drug use or alcohol abuse be reported to the to the LogisX Inc. DER noted in our Business Roles and Responsibilities.");
		doc.moveDown(0.5);
		para("Schedules of Controlled Substance Policy");
		doc.moveDown(1);
		// Approved by line
		doc.moveTo(MARGIN, doc.y).lineTo(MARGIN + 200, doc.y).strokeColor("#999").lineWidth(0.5).stroke();
		doc.moveDown(0.2);
		doc.font(R).fontSize(fs).text("Approved by", MARGIN);

		// ====== PAGE 5 — Receipt ======
		doc.addPage();
		doc.font(B).fontSize(12).fillColor(BLACK).text("Receipt of LogisX Inc.", { align: "center" });
		doc.font(R).fontSize(10).text("Controlled Substance Policies/Procedures and Appendix A", { align: "center" });
		doc.moveDown(1.5);

		doc.font(R).fontSize(10).text("Driver/Associate Name:", MARGIN);
		doc.moveDown(0.5);
		if (fullName) {
			doc.font(B).fillColor(BLUE).text(fullName, MARGIN);
			doc.fillColor(BLACK);
		}
		doc.moveDown(1);

		doc.font(R).fontSize(10).text("I, ", MARGIN, doc.y, { width: W, continued: true, lineGap: 2 });
		if (fullName) {
			doc.font(B).fillColor(BLUE).text(fullName, { continued: true });
			doc.fillColor(BLACK);
		}
		doc.font(R).text(", have received a copy of LogisX Inc. - Controlled Substance Policies and Procedures and Appendix A ", { continued: true });
		doc.font(IT).text("(revision April 2025).", { width: W, lineGap: 2 });
		doc.moveDown(0.5);

		para("I understand Controlled Substance testing is initiated under the following circumstances: Pre-employment Testing at the onset of employment; Random testing as selected by a third-party administrator, Post Accident Testing per FMCSA guidelines, or Reasonable Suspicion Testing (\u00A7382.303(d)).");
		doc.moveDown(1.5);

		// Driver signature
		const sigY = doc.y;
		doc.font(R).fontSize(10).fillColor(BLACK).text("Driver Signature", MARGIN, sigY);
		doc.moveTo(MARGIN + 100, sigY + 2).lineTo(300, sigY + 2).strokeColor("#999").lineWidth(0.5).stroke();
		doc.text("Date", 320, sigY);
		doc.moveTo(350, sigY + 2).lineTo(480, sigY + 2).stroke();

		if (fullName) {
			doc.font(B).fontSize(11).fillColor(BLUE).text(fullName, MARGIN + 105, sigY - 12);
			doc.fillColor(BLACK);
		}
		if (effectiveDate) {
			doc.font(R).fontSize(9).fillColor(BLUE).text(effectiveDate, 355, sigY - 10);
			doc.fillColor(BLACK);
		}
		if (signatureImage) {
			try {
				const sigBuf = Buffer.from(signatureImage.replace(/^data:image\/\w+;base64,/, ""), "base64");
				doc.image(sigBuf, MARGIN + 150, sigY - 25, { width: 120, height: 35 });
			} catch { /* skip */ }
		}

		// Received by
		doc.moveDown(3);
		const recY = doc.y;
		doc.font(R).fontSize(10).fillColor(BLACK).text("Received by Signature", MARGIN, recY);
		doc.moveTo(MARGIN + 140, recY + 2).lineTo(350, recY + 2).strokeColor("#999").lineWidth(0.5).stroke();
		doc.font(B).fontSize(11).fillColor(BLUE).text("Deshorn King", MARGIN + 145, recY - 12);
		doc.fillColor(BLACK);

		doc.moveDown(2);
		doc.font(B).fontSize(10).text("LogisX Inc.", PAGE_W - MARGIN - 80, doc.y, { align: "right" });

		doc.end();
	});
}

module.exports = { generateSubstancePolicy };
