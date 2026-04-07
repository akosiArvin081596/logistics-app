const PDFDocument = require("pdfkit");

// Shared constants across all PDF generators
const BLUE = "#1a56db";
const BLACK = "#1a1d27";
const GRAY = "#6b7280";
const MARGIN = 50;
const PAGE_W = 612;

/**
 * Create a PDFDocument that resolves to a Buffer.
 * @returns {{ doc: PDFDocument, getBuffer: () => Promise<Buffer> }}
 */
function createPdfDoc(options = {}) {
	const doc = new PDFDocument({ size: "LETTER", margin: MARGIN, bufferPages: true, ...options });
	const chunks = [];
	doc.on("data", (c) => chunks.push(c));
	const bufferPromise = new Promise((resolve, reject) => {
		doc.on("end", () => resolve(Buffer.concat(chunks)));
		doc.on("error", reject);
	});
	return { doc, getBuffer: () => bufferPromise };
}

/**
 * Draw a bordered table with rows and columns.
 * @param {PDFDocument} doc
 * @param {Object} options
 * @param {Array<Array<{text: string, bold?: boolean, blue?: boolean}|string>>} options.rows - Array of row arrays
 * @param {Array<number>} options.colWidths - Width for each column
 * @param {Object} [options.headerRow] - If provided, first row is rendered as header with background
 * @param {number} [options.x] - Left x position (default MARGIN + 10)
 * @param {number} [options.fontSize] - Font size (default 9.5)
 * @param {number} [options.cellPadding] - Vertical padding added to text height (default 10)
 * @param {number} [options.textInsetX] - Horizontal text offset from cell edge (default 5)
 * @param {number} [options.textInsetY] - Vertical text offset from cell top (default 4)
 * @param {number} [options.pageBreakY] - Y threshold to trigger page break (default 660)
 * @param {number} [options.minRowHeight] - Minimum row height (default 20)
 */
function drawBorderedTable(doc, options) {
	const {
		rows,
		colWidths,
		x: startX = MARGIN + 10,
		fontSize = 9.5,
		cellPadding = 10,
		textInsetX = 5,
		textInsetY = 4,
		pageBreakY = 660,
		minRowHeight = 20,
	} = options;

	const B = "Helvetica-Bold";
	const R = "Helvetica";
	const totalWidth = colWidths.reduce((a, b) => a + b, 0);

	rows.forEach((row) => {
		if (doc.y > pageBreakY) doc.addPage();
		const rowY = doc.y;

		// Calculate row height from tallest cell
		let maxH = minRowHeight;
		row.forEach((cell, i) => {
			const cellText = typeof cell === "object" ? cell.text : cell;
			const isBold = typeof cell === "object" && cell.bold;
			doc.font(isBold ? B : R).fontSize(fontSize);
			const h = doc.heightOfString(cellText, { width: colWidths[i] - textInsetX * 2 }) + cellPadding;
			if (h > maxH) maxH = h;
		});

		// Draw cell borders
		let cellX = startX;
		colWidths.forEach((w) => {
			doc.rect(cellX, rowY, w, maxH).stroke();
			cellX += w;
		});

		// Draw cell text
		cellX = startX;
		row.forEach((cell, i) => {
			const cellText = typeof cell === "object" ? cell.text : cell;
			const isBold = typeof cell === "object" && cell.bold;
			const isBlue = typeof cell === "object" && cell.blue;
			const align = typeof cell === "object" && cell.align ? cell.align : undefined;

			doc.font(isBold ? B : R).fontSize(fontSize);
			doc.fillColor(isBlue ? BLUE : BLACK);
			doc.text(cellText, cellX + textInsetX, rowY + textInsetY, {
				width: colWidths[i] - textInsetX * 2,
				lineGap: 1.5,
				align,
			});
			cellX += colWidths[i];
		});

		doc.fillColor(BLACK);
		doc.y = rowY + maxH;
	});
}

/**
 * Check if there's enough space on the page, add new page if not.
 */
function checkPageSpace(doc, needed, threshold = 720) {
	if (doc.y + needed > threshold) doc.addPage();
}

module.exports = {
	BLUE, BLACK, GRAY, MARGIN, PAGE_W,
	createPdfDoc,
	drawBorderedTable,
	checkPageSpace,
};
