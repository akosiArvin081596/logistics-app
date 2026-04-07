const PDFDocument = require("pdfkit");

const BLUE = "#1a56db";
const BLACK = "#1a1d27";
const MARGIN = 50;
const PAGE_W = 612;

function generateMobilePolicy(data) {
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

		// ====== PAGE 1 ======
		doc.font(B).fontSize(16).fillColor(BLACK);
		doc.text("MOBILE COMMUNICATIONS POLICY", { align: "center" });
		doc.moveDown(0.8);

		// Paragraph 1
		doc.font(B).fontSize(10).fillColor(BLACK);
		doc.text("LogisX Inc.", MARGIN, doc.y, { width: W, continued: true, lineGap: 2 });
		doc.font(R).text(" is committed to giving drivers information on safe operation of CMVs. ", { continued: true });
		doc.font(B).text("LogisX Inc.", { continued: true });
		doc.font(R).text(" expects all drivers to use or refrain from using mobile or electronic devices according to the circumstances of their environment. ", { continued: true });
		doc.font(B).text("LogisX Inc.", { continued: true });
		doc.font(R).text(" and its drivers cannot control the actions of other drivers on the road, but we want to be observant so that we can avoid adverse safety events whenever reasonably possible.", { width: W, lineGap: 2 });
		doc.moveDown(0.5);

		// Paragraph 2
		doc.font(R).fontSize(10);
		doc.text("It is ", MARGIN, doc.y, { width: W, continued: true, lineGap: 2 });
		doc.font(B).text("LogisX Inc.\u2019s", { continued: true });
		doc.font(R).text(" policy that a CMV driver, while a commercial motor vehicle is in motion (i.e., when it is moving forward or temporarily stationary because of traffic, traffic control devices, or other momentary delays), may not hold a mobile device to make a call, or enter commands by pressing more than a single button; nor may a CMV driver view or send text messages.", { width: W, lineGap: 2 });
		doc.moveDown(0.5);

		// Paragraph 3
		doc.font(R).fontSize(10);
		doc.text("CMV drivers who use a mobile phone while driving can only use a device in ", MARGIN, doc.y, { width: W, continued: true, lineGap: 2 });
		doc.font(B).text("hands-free mode", { continued: true });
		doc.font(R).text(" which is in close proximity. Hands-free mode can include Bluetooth or other enabled devices which are worn on the head or neck and operated by touch control or voice control. If you have questions about whether your hands-free device is sufficient to meet ", { continued: true });
		doc.font(B).text("LogisX Inc.\u2019s", { continued: true });
		doc.font(R).text(" policy, please check with your supervisor.", { width: W, lineGap: 2 });
		doc.moveDown(0.5);

		// Paragraph 4
		doc.font(R).fontSize(10);
		doc.text("A mounted phone is acceptable if it is mounted within a ", MARGIN, doc.y, { width: W, continued: true, lineGap: 2 });
		doc.font(B).text("relaxed arm\u2019s reach", { continued: true });
		doc.font(R).text(" of the driver. To comply with this policy, a driver must have his or her mobile telephone located where he/she is able to initiate, answer, or terminate a call by touching a ", { continued: true });
		doc.font(B).text("single button", { continued: true });
		doc.font(R).text(" and without having to press another button to hear the caller. The driver must be in the seated driving position and properly restrained by a seat belt. Drivers are not in compliance if they unsafely reach for a mobile phone, even if they intend to use the hands-free function.", { width: W, lineGap: 2 });
		doc.moveDown(0.7);

		// Definitions
		doc.font(B).fontSize(13).text("Definitions", MARGIN);
		doc.moveDown(0.4);

		// Bullet 1
		const bx = MARGIN + 20;
		const bw = W - 20;
		doc.font(R).fontSize(10).text("\u2022  ", bx, doc.y, { width: bw, continued: true });
		doc.font(B).text("\u201CUse\u201D of a hand-held mobile telephone:", { continued: true });
		doc.font(R).text(" Using at least one hand to hold a mobile phone to make a call; dialing a mobile phone by pressing more than a single button; or reaching for a mobile phone in a manner that requires a driver to maneuver so that he or she is no longer in a seated driving position, restrained by a seat belt.", { width: bw, lineGap: 2 });
		doc.moveDown(0.3);

		// Bullet 2
		doc.font(R).fontSize(10).text("\u2022  ", bx, doc.y, { width: bw, continued: true });
		doc.font(B).text("\u201CText messages\u201D:", { continued: true });
		doc.font(R).text(" Manually entering text (words) into, or reading text from, an electronic device. Texting includes (but is not limited to) short message services, emailing, instant messaging, a command or request to access a Web page, pressing more than a single button to initiate or terminate a call, or engaging in any other form of electronic text retrieval or entry.", { width: bw, lineGap: 2 });

		// Certification line
		doc.moveDown(1);
		doc.moveTo(MARGIN, doc.y).lineTo(PAGE_W - MARGIN, doc.y).strokeColor("#999").lineWidth(0.5).stroke();
		doc.moveDown(0.4);
		doc.font(R).fontSize(10);
		doc.text("By my signature below, I certify that I have read the above policies and agree to abide by them while I am an employee or contract driver for ", MARGIN, doc.y, { width: W, continued: true, lineGap: 2 });
		doc.font(B).text("LogisX Inc.", { width: W, lineGap: 2 });

		// ====== PAGE 2 — Receipt ======
		doc.addPage();

		doc.font(B).fontSize(11).fillColor(BLACK);
		doc.text("Receipt of LogisX Inc. Mobile Communication Policy", MARGIN);
		doc.moveDown(0.5);

		doc.font(R).fontSize(10);
		doc.text("I, ", MARGIN, doc.y, { width: W, continued: true, lineGap: 2 });
		if (fullName) {
			doc.font(B).fillColor(BLUE).text(fullName, { continued: true });
			doc.fillColor(BLACK);
		} else {
			doc.text("_____________________", { continued: true });
		}
		doc.font(R).text(", have received a copy of ", { continued: true });
		doc.font(B).text("LogisX Inc.\u2019s", { continued: true });
		doc.font(R).text(" Mobile Communication Policy (revision April 2025).", { width: W, lineGap: 2 });
		doc.moveDown(1);

		// Driver signature line
		const sigY = doc.y;
		doc.font(B).fontSize(10).fillColor(BLACK).text("Driver/Associate Signature:", MARGIN, sigY);
		doc.moveTo(MARGIN + 170, sigY + 12).lineTo(370, sigY + 12).strokeColor("#999").lineWidth(0.5).stroke();
		doc.font(B).text("Date:", 390, sigY);
		doc.moveTo(420, sigY + 12).lineTo(530, sigY + 12).stroke();

		if (fullName) {
			doc.font(B).fontSize(11).fillColor(BLUE).text(fullName, MARGIN + 175, sigY - 1);
			doc.fillColor(BLACK);
		}
		if (effectiveDate) {
			doc.font(R).fontSize(9).fillColor(BLUE).text(effectiveDate, 425, sigY);
			doc.fillColor(BLACK);
		}
		if (signatureImage) {
			try {
				const sigBuf = Buffer.from(signatureImage.replace(/^data:image\/\w+;base64,/, ""), "base64");
				doc.image(sigBuf, MARGIN + 220, sigY - 18, { width: 120, height: 35 });
			} catch { /* skip */ }
		}

		// Received by line (Deshorn King, CEO)
		doc.moveDown(1.5);
		const recY = doc.y;
		doc.font(B).fontSize(10).fillColor(BLACK).text("Received by Signature:", MARGIN, recY);
		doc.moveTo(MARGIN + 150, recY + 12).lineTo(350, recY + 12).strokeColor("#999").lineWidth(0.5).stroke();
		doc.font(B).text("Title:", 370, recY);
		doc.moveTo(400, recY + 12).lineTo(530, recY + 12).stroke();

		// Pre-fill company receiver
		doc.font(B).fontSize(11).fillColor(BLUE).text("Deshorn King", MARGIN + 155, recY - 1);
		doc.font(R).fontSize(9).text("CEO", 405, recY);
		doc.fillColor(BLACK);

		doc.moveDown(1);
		doc.font(B).fontSize(10).text("LogisX Inc.", MARGIN);

		doc.end();
	});
}

module.exports = { generateMobilePolicy };
