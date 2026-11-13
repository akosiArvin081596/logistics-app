"use strict";

// ===========================================================================
// A driver's alerts: the rows his app's Alerts tab lists, and the Drivers page's
// read-only copy of them for a Super Admin ("Alerts sent").
//
//   alertRows(db, driverName)   the one read of them: what GET /api/driver/:driverName
//                               carries as `notifications`, newest first, ALERTS_LIMIT at most
//   GET /api/drivers-directory/:id/alerts-sent
//                               the same rows for the Driver account that Drivers page row
//                               names, as title, text and time only
//
// The route is Super Admin only: requireRole answers no session 401 and every other role
// 403 before anything is read. It marks nothing read and writes nothing. It has no
// switch: a Super Admin already reads these rows in the driver's own payload.
// ===========================================================================

const PATH = "/api/drivers-directory/:id/alerts-sent";
// The payload's own cap; the Drivers page says when a list reaches it.
const ALERTS_LIMIT = 100;
// A Drivers page row's id: a positive whole number, as the row's other routes take it.
const ROW_ID_RE = /^[1-9][0-9]{0,9}$/;

// Keyed as every writer keys a row: the name trimmed and lowercased. created_at is
// SQLite's UTC CURRENT_TIMESTAMP with no zone, which a browser reads as its own local
// time, so it goes out as ISO-8601 with Z.
function alertRows(db, driverName) {
	const key = String(driverName ?? "").trim().toLowerCase();
	return db.prepare(
		`SELECT id, type, title, body, metadata, read,
		        strftime('%Y-%m-%dT%H:%M:%SZ', created_at) AS createdAt
		 FROM notifications
		 WHERE driver_name = ?
		 ORDER BY id DESC
		 LIMIT ?`,
	).all(key, ALERTS_LIMIT);
}

// What the Drivers page shows of a row: the title and text his Alerts tab shows, and
// when. Never its type, metadata or read mark.
function sentView(row) {
	return { title: row.title, text: row.body, time: row.createdAt };
}

// deps: { requireRole, db, accountSpelling, logger }. accountSpelling(name) is server.js's
// findDriverAccountSpelling(): the driver_name the Driver account a name belongs to holds
// (the name his session carries), or null for no such account or two.
function mount(app, deps) {
	const d = deps || {};
	if (typeof d.requireRole !== "function") throw new Error("driver-alerts-sent: deps.requireRole is required");
	if (!d.db || typeof d.db.prepare !== "function") throw new Error("driver-alerts-sent: deps.db is required");
	if (typeof d.accountSpelling !== "function") throw new Error("driver-alerts-sent: deps.accountSpelling is required");
	const logger = d.logger || console;

	// Read by his account's own spelling, as every writer keys his rows, so the list is
	// the one his app shows even when the Drivers page row spells his name another way.
	app.get(PATH, d.requireRole("Super Admin"), (req, res) => {
		res.set("Cache-Control", "private, no-store");
		try {
			const id = typeof req.params.id === "string" ? req.params.id : "";
			if (!ROW_ID_RE.test(id)) return res.status(400).json({ error: "Invalid driver id", code: "INVALID_DRIVER_ID" });
			const row = d.db.prepare("SELECT id, driver_name FROM drivers_directory WHERE id = ?").get(Number(id));
			if (!row) return res.status(404).json({ error: "Driver not found", code: "DRIVER_NOT_FOUND" });
			const spelling = d.accountSpelling(row.driver_name);
			if (!spelling) return res.json({ linked: false });
			return res.json({ linked: true, alerts: alertRows(d.db, spelling).map(sentView), limit: ALERTS_LIMIT });
		} catch (err) {
			logger.error("[driver-alerts-sent] read failed:", err && err.code ? err.code : "ERROR");
			return res.status(500).json({ error: "This driver's alerts couldn't be loaded. Try again.", code: "READ_FAILED" });
		}
	});

	return { PATH };
}

module.exports = { PATH, ALERTS_LIMIT, alertRows, sentView, mount };
