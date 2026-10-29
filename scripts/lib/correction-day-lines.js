// The live correction day lines of one driver, for the scripts that check
// whether a day is already paid (server.js, the CORRECTION LINES section: only a
// live day line, waiting or on an invoice, holds its day; rate and amount lines
// hold none). A database without invoice_correction_lines (an older copy, a
// hand-built test database) has no line; a table that exists but cannot be read
// throws, so the script stops rather than read it as empty.

"use strict";

// [{ id, day, name }] for the driver whose normalized name is driverKey.
function correctionDayLines(db, driverKey, normalizeDriverName) {
	if (!driverKey) return [];
	const present = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'invoice_correction_lines'").get();
	if (!present) return [];
	return db.prepare(`SELECT c.id, c.line_date, c.source_invoice_number, s.driver AS source_driver
		FROM invoice_correction_lines c LEFT JOIN invoices s ON s.id = c.source_invoice_id
		WHERE c.kind = 'day' AND c.voided_at = '' ORDER BY c.id`).all()
		.filter((r) => normalizeDriverName(r.source_driver || "") === driverKey)
		.map((r) => ({ id: r.id, day: r.line_date, name: `correction line ${r.id} (to ${r.source_invoice_number})` }));
}

module.exports = { correctionDayLines };
