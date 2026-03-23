const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { google } = require("googleapis");
const path = require("path");
const bcrypt = require("bcryptjs");
const session = require("express-session");
const Database = require("better-sqlite3");
const SqliteStore = require("better-sqlite3-session-store")(session);

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.json({ limit: "1mb" }));

// ============================================================
// SQLite — Local database for app data (messages, users, expenses)
// ============================================================
const db = new Database(path.join(__dirname, "app.db"));
db.pragma("journal_mode = WAL");

db.exec(`
	CREATE TABLE IF NOT EXISTS messages (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		timestamp TEXT NOT NULL,
		"from" TEXT NOT NULL,
		"to" TEXT NOT NULL,
		message TEXT NOT NULL,
		load_id TEXT DEFAULT '',
		read INTEGER DEFAULT 0,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP
	)
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_from ON messages("from")`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_to ON messages("to")`);

db.exec(`
	CREATE TABLE IF NOT EXISTS users (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		username TEXT NOT NULL UNIQUE,
		password_hash TEXT NOT NULL,
		role TEXT NOT NULL CHECK(role IN ('Admin', 'Dispatcher', 'Driver', 'Investor')),
		driver_name TEXT DEFAULT '',
		email TEXT DEFAULT '',
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP
	)
`);

// Migrate: rebuild users table if CHECK constraint is outdated (missing Investor role)
try {
	db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('__test__', '__test__', 'Investor')").run();
	db.prepare("DELETE FROM users WHERE username = '__test__'").run();
} catch {
	db.exec(`
		ALTER TABLE users RENAME TO users_old;
		CREATE TABLE users (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			username TEXT NOT NULL UNIQUE,
			password_hash TEXT NOT NULL,
			role TEXT NOT NULL CHECK(role IN ('Admin', 'Dispatcher', 'Driver', 'Investor')),
			driver_name TEXT DEFAULT '',
			email TEXT DEFAULT '',
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		);
		INSERT INTO users SELECT * FROM users_old;
		DROP TABLE users_old;
	`);
}

db.exec(`
	CREATE TABLE IF NOT EXISTS expenses (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		timestamp TEXT NOT NULL,
		driver TEXT NOT NULL,
		load_id TEXT DEFAULT '',
		type TEXT NOT NULL,
		amount REAL NOT NULL,
		description TEXT DEFAULT '',
		date TEXT NOT NULL,
		photo_data TEXT DEFAULT '',
		status TEXT DEFAULT 'Pending',
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP
	)
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_expenses_driver ON expenses(driver)`);

db.exec(`
	CREATE TABLE IF NOT EXISTS investor_config (
		key TEXT PRIMARY KEY,
		value TEXT NOT NULL
	)
`);
// Seed default investor config if empty
const configCount = db.prepare("SELECT COUNT(*) AS cnt FROM investor_config").get().cnt;
if (configCount === 0) {
	const defaults = db.prepare("INSERT OR IGNORE INTO investor_config (key, value) VALUES (?, ?)");
	const seedMany = db.transaction((items) => {
		for (const [k, v] of items) defaults.run(k, v);
	});
	seedMany([
		["truck_purchase_price", "58000"],
		["truck_current_value", "21000"],
		["truck_title_status", "Clean"],
		["depreciation_years", "5"],
		["section_179_deduction", "30000"],
		["investor_payout_min", "2100"],
		["investor_payout_max", "3100"],
		["investor_split_pct", "35"],
		["blue_chip_brokers", "Pepsi,Coca-Cola,PepsiCo,Frito-Lay,Nestle,Procter & Gamble,Unilever,Walmart,Amazon,Target"],
	]);
}

// Session store in SQLite (persists across server restarts)
app.use(
	session({
		store: new SqliteStore({ client: db, expired: { clear: true, intervalMs: 3600000 } }),
		secret: "dispatch-logistics-2024",
		resave: false,
		saveUninitialized: false,
		cookie: { maxAge: 24 * 60 * 60 * 1000 },
	}),
);
app.use(express.static(path.join(__dirname, "public")));

// ============================================================
// CONFIGURATION — Update these values with your own
// ============================================================
const SPREADSHEET_ID = "1WCiMmcI7GuS4eFaG9PAop5CFtMKKtfla1sOAKxcEduI"; // From the sheet URL
const DEFAULT_SHEET = "Job Tracking"; // Default tab name
const KEY_FILE = "./service-account-key.json"; // Path to your service account JSON

// ============================================================
// Google Sheets Auth Setup (cached — created once, reused)
// ============================================================
const auth = new google.auth.GoogleAuth({
	keyFile: KEY_FILE,
	scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

let sheetsClient = null;
const sheetIdCache = new Map();

async function getSheets() {
	if (!sheetsClient) {
		const authClient = await auth.getClient();
		sheetsClient = google.sheets({ version: "v4", auth: authClient });
	}
	return sheetsClient;
}

async function getSheetId(sheets, sheetName) {
	if (sheetIdCache.has(sheetName)) return sheetIdCache.get(sheetName);
	const spreadsheet = await sheets.spreadsheets.get({
		spreadsheetId: SPREADSHEET_ID,
	});
	for (const s of spreadsheet.data.sheets) {
		sheetIdCache.set(s.properties.title, s.properties.sheetId);
	}
	return sheetIdCache.get(sheetName);
}

// ============================================================
// AUTH — Session-based authentication with roles (SQLite)
// ============================================================
// Roles: Admin (full access), Dispatcher (no delete), Driver (own data only, no rate/revenue)

function requireAuth(req, res, next) {
	if (!req.session.user)
		return res.status(401).json({ error: "Not authenticated" });
	next();
}

function requireRole(...roles) {
	return (req, res, next) => {
		if (!req.session.user)
			return res.status(401).json({ error: "Not authenticated" });
		if (!roles.includes(req.session.user.role))
			return res.status(403).json({ error: "Forbidden" });
		next();
	};
}

// Check if any users exist (for first-time setup)
app.get("/api/auth/setup-check", (req, res) => {
	const count = db.prepare("SELECT COUNT(*) AS cnt FROM users").get().cnt;
	res.json({ needsSetup: count === 0 });
});

// First-time setup — create initial admin account
app.post("/api/auth/setup", async (req, res) => {
	try {
		const count = db.prepare("SELECT COUNT(*) AS cnt FROM users").get().cnt;
		if (count > 0) {
			return res.status(400).json({ error: "Setup already completed" });
		}

		const { username, password, email } = req.body;
		if (!username || !password) {
			return res.status(400).json({ error: "Username and password required" });
		}

		const hash = await bcrypt.hash(password, 10);
		db.prepare(
			"INSERT INTO users (username, password_hash, role, driver_name, email) VALUES (?, ?, 'Admin', '', ?)",
		).run(username, hash, email || "");

		req.session.user = {
			username,
			role: "Admin",
			driverName: "",
			email: email || "",
		};

		res.json({ success: true, role: "Admin" });
	} catch (error) {
		console.error("Error during setup:", error.message);
		res.status(500).json({ error: error.message });
	}
});

// Login
app.post("/api/auth/login", async (req, res) => {
	try {
		const { username, password } = req.body;
		if (!username || !password) {
			return res.status(400).json({ error: "Username and password required" });
		}

		const user = db
			.prepare("SELECT * FROM users WHERE LOWER(username) = LOWER(?) OR LOWER(email) = LOWER(?)")
			.get(username.trim(), username.trim());

		if (!user) {
			return res.status(401).json({ error: "Invalid credentials" });
		}

		const valid = await bcrypt.compare(password, user.password_hash);
		if (!valid) {
			return res.status(401).json({ error: "Invalid credentials" });
		}

		req.session.user = {
			username: user.username,
			role: user.role,
			driverName: user.driver_name || "",
			email: user.email || "",
		};

		res.json({
			success: true,
			user: {
				username: user.username,
				role: user.role,
				driverName: user.driver_name || "",
			},
		});
	} catch (error) {
		console.error("Error during login:", error.message);
		res.status(500).json({ error: error.message });
	}
});

// Logout
app.post("/api/auth/logout", (req, res) => {
	req.session.destroy();
	res.json({ success: true });
});

// Get current session
app.get("/api/auth/session", (req, res) => {
	if (req.session.user) {
		res.json({ authenticated: true, user: req.session.user });
	} else {
		res.json({ authenticated: false });
	}
});

// Admin: create a new user
app.post("/api/users", requireRole("Admin"), async (req, res) => {
	try {
		const { username, password, role, driverName, email } = req.body;
		if (!username || !password || !role) {
			return res.status(400).json({ error: "Username, password, and role required" });
		}
		if (!["Admin", "Dispatcher", "Driver", "Investor"].includes(role)) {
			return res.status(400).json({ error: "Invalid role" });
		}

		const existing = db
			.prepare("SELECT id FROM users WHERE LOWER(username) = LOWER(?)")
			.get(username.trim());
		if (existing) {
			return res.status(400).json({ error: "Username already exists" });
		}

		const hash = await bcrypt.hash(password, 10);
		db.prepare(
			"INSERT INTO users (username, password_hash, role, driver_name, email) VALUES (?, ?, ?, ?, ?)",
		).run(username, hash, role, driverName || "", email || "");

		res.json({ success: true });
	} catch (error) {
		console.error("Error creating user:", error.message);
		res.status(500).json({ error: error.message });
	}
});

// Admin: list all users (without password hashes)
app.get("/api/users", requireRole("Admin"), (req, res) => {
	const users = db
		.prepare("SELECT id, username, role, driver_name, email, created_at FROM users")
		.all()
		.map((u) => ({
			id: u.id,
			Username: u.username,
			Role: u.role,
			DriverName: u.driver_name,
			Email: u.email,
			CreatedAt: u.created_at,
		}));
	res.json({ users });
});

// Admin: delete a user
app.delete("/api/users/:id", requireRole("Admin"), (req, res) => {
	const id = parseInt(req.params.id);
	db.prepare("DELETE FROM users WHERE id = ?").run(id);
	res.json({ success: true });
});

// ============================================================
// CRUD Endpoints (dynamic sheet tab via ?sheet= query param)
// ============================================================

// Helper to get sheet name from query or use default
function getSheetName(req) {
	return req.query.sheet || DEFAULT_SHEET;
}

// LIST TABS — Get all sheet tab names
app.get("/api/tabs", requireAuth, async (req, res) => {
	try {
		const sheets = await getSheets();
		const spreadsheet = await sheets.spreadsheets.get({
			spreadsheetId: SPREADSHEET_ID,
		});
		const tabs = spreadsheet.data.sheets.map((s) => {
			sheetIdCache.set(s.properties.title, s.properties.sheetId);
			return s.properties.title;
		});
		res.json({ tabs });
	} catch (error) {
		console.error("Error fetching tabs:", error.message);
		res.status(500).json({ error: error.message });
	}
});

// READ — Get rows from a sheet tab (supports pagination via ?page=&limit=)
app.get("/api/data", requireRole("Admin", "Dispatcher"), async (req, res) => {
	try {
		const sheetName = getSheetName(req);
		const page = Math.max(1, parseInt(req.query.page) || 1);
		const limit = Math.max(1, Math.min(200, parseInt(req.query.limit) || 50));

		const sheets = await getSheets();
		const response = await sheets.spreadsheets.values.get({
			spreadsheetId: SPREADSHEET_ID,
			range: `${sheetName}`,
		});

		const rows = response.data.values || [];
		if (rows.length === 0) {
			return res.json({ headers: [], data: [], sheet: sheetName, total: 0, page, limit, totalPages: 0 });
		}

		// First row = headers, rest = data
		const headers = rows[0];
		const allData = rows.slice(1).map((row, index) => {
			const obj = { _rowIndex: index + 2 }; // Sheet rows are 1-indexed, +1 for header
			headers.forEach((header, i) => {
				obj[header] = row[i] || "";
			});
			return obj;
		});

		const total = allData.length;
		const totalPages = Math.ceil(total / limit);
		const start = (page - 1) * limit;
		const data = allData.slice(start, start + limit);

		res.json({ headers, data, sheet: sheetName, total, page, limit, totalPages });
	} catch (error) {
		console.error("Error reading sheet:", error.message);
		res.status(500).json({ error: error.message });
	}
});

// CREATE — Append a new row
app.post("/api/data", requireRole("Admin", "Dispatcher"), async (req, res) => {
	try {
		const sheetName = getSheetName(req);
		const { values } = req.body; // values = array of cell values

		const sheets = await getSheets();
		const response = await sheets.spreadsheets.values.append({
			spreadsheetId: SPREADSHEET_ID,
			range: `${sheetName}`,
			valueInputOption: "USER_ENTERED",
			requestBody: {
				values: [values],
			},
		});

		res.json({
			success: true,
			updatedRange: response.data.updates.updatedRange,
		});
	} catch (error) {
		console.error("Error appending row:", error.message);
		res.status(500).json({ error: error.message });
	}
});

// UPDATE — Update a specific row
app.put("/api/data/:rowIndex", requireRole("Admin", "Dispatcher"), async (req, res) => {
	try {
		const sheetName = getSheetName(req);
		const rowIndex = parseInt(req.params.rowIndex);
		const { values } = req.body;

		const sheets = await getSheets();
		const response = await sheets.spreadsheets.values.update({
			spreadsheetId: SPREADSHEET_ID,
			range: `${sheetName}!A${rowIndex}`,
			valueInputOption: "USER_ENTERED",
			requestBody: {
				values: [values],
			},
		});

		res.json({
			success: true,
			updatedCells: response.data.updatedCells,
		});
	} catch (error) {
		console.error("Error updating row:", error.message);
		res.status(500).json({ error: error.message });
	}
});

// DELETE — Clear a row (shifts content up by deleting the row) — Admin only
app.delete("/api/data/:rowIndex", requireRole("Admin"), async (req, res) => {
	try {
		const sheetName = getSheetName(req);
		const rowIndex = parseInt(req.params.rowIndex);

		const sheets = await getSheets();
		const sheetId = await getSheetId(sheets, sheetName);

		// Delete the entire row so remaining rows shift up
		await sheets.spreadsheets.batchUpdate({
			spreadsheetId: SPREADSHEET_ID,
			requestBody: {
				requests: [
					{
						deleteDimension: {
							range: {
								sheetId: sheetId,
								dimension: "ROWS",
								startIndex: rowIndex - 1, // 0-indexed
								endIndex: rowIndex,
							},
						},
					},
				],
			},
		});

		res.json({ success: true });
	} catch (error) {
		console.error("Error deleting row:", error.message);
		res.status(500).json({ error: error.message });
	}
});

// ============================================================
// DASHBOARD — Aggregated data from multiple sheets
// ============================================================
app.get("/api/dashboard", requireRole("Admin", "Dispatcher"), async (req, res) => {
	try {
		const sheets = await getSheets();

		const response = await sheets.spreadsheets.values.batchGet({
			spreadsheetId: SPREADSHEET_ID,
			ranges: [
				"Job Tracking",
				"Carrier Database",
				"Payments Table",
				"Carrier History",
				"Job Summary Sheet",
			],
		});

		const rangeData = response.data.valueRanges || [];

		function parseSheet(valueRange) {
			const rows = (valueRange && valueRange.values) || [];
			if (rows.length === 0) return { headers: [], data: [] };
			const headers = rows[0];
			const data = rows.slice(1).map((row, idx) => {
				const obj = { _rowIndex: idx + 2 };
				headers.forEach((h, i) => {
					obj[h] = row[i] || "";
				});
				return obj;
			});
			return { headers, data };
		}

		function findCol(headers, regex) {
			return headers.find((h) => regex.test(h)) || null;
		}

		const jobTracking = parseSheet(rangeData[0]);
		const carrierDB = parseSheet(rangeData[1]);
		const payments = parseSheet(rangeData[2]);
		const carrierHistory = parseSheet(rangeData[3]);

		// Identify key columns
		const statusCol = findCol(jobTracking.headers, /status/i);
		const driverCol = findCol(jobTracking.headers, /driver/i);
		const loadIdCol = findCol(jobTracking.headers, /load.?id|job.?id/i);
		const delivDateCol = findCol(
			jobTracking.headers,
			/deliv|drop.?off.*date|completion.*date/i,
		);
		const rateCol = findCol(payments.headers, /rate|amount|total|pay/i);
		const payStatusCol = findCol(payments.headers, /pay.*status|status/i);
		const carrierDriverCol =
			findCol(carrierDB.headers, /driver/i) || carrierDB.headers[0];
		const truckCol = findCol(carrierDB.headers, /truck|unit|vehicle/i);

		// Status patterns
		const activeStatuses =
			/^(in transit|dispatched|assigned|picked up|at shipper|at receiver|loading|unloading)$/i;
		const completedStatuses = /^(delivered|completed|pod received)$/i;
		const unassignedStatuses =
			/^(unassigned|new|open|pending|available)$/i;

		// Filter jobs
		const activeJobs = jobTracking.data.filter(
			(r) => statusCol && activeStatuses.test((r[statusCol] || "").trim()),
		);
		const unassignedJobs = jobTracking.data.filter(
			(r) =>
				(statusCol &&
					unassignedStatuses.test((r[statusCol] || "").trim())) ||
				(driverCol && !(r[driverCol] || "").trim()),
		);
		const completedJobs = jobTracking.data.filter(
			(r) =>
				statusCol &&
				completedStatuses.test((r[statusCol] || "").trim()),
		);

		// Date boundaries
		const now = new Date();
		const weekStart = new Date(now);
		weekStart.setDate(
			now.getDate() - now.getDay() + (now.getDay() === 0 ? -6 : 1),
		);
		weekStart.setHours(0, 0, 0, 0);
		const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

		const completedThisWeek = completedJobs.filter((r) => {
			if (!delivDateCol) return false;
			const d = new Date(r[delivDateCol]);
			return !isNaN(d) && d >= weekStart && d <= now;
		}).length;

		const completedThisMonth = completedJobs.filter((r) => {
			if (!delivDateCol) return false;
			const d = new Date(r[delivDateCol]);
			return !isNaN(d) && d >= monthStart && d <= now;
		}).length;

		// Fleet utilization
		const totalTrucks = carrierDB.data.length;
		const activeDriverNames = new Set(
			activeJobs
				.map((r) => (driverCol ? (r[driverCol] || "").trim() : ""))
				.filter(Boolean),
		);
		const assignedTrucks = carrierDB.data.filter((r) =>
			activeDriverNames.has((r[carrierDriverCol] || "").trim()),
		).length;

		// Revenue
		function parseAmount(str) {
			return (
				parseFloat(String(str || "0").replace(/[$,]/g, "")) || 0
			);
		}
		let revTotal = 0,
			revPaid = 0,
			revPending = 0;
		payments.data.forEach((r) => {
			const amt = parseAmount(rateCol ? r[rateCol] : 0);
			revTotal += amt;
			const ps = payStatusCol
				? (r[payStatusCol] || "").trim().toLowerCase()
				: "";
			if (/^paid$/i.test(ps)) revPaid += amt;
			else revPending += amt;
		});

		// Driver list
		const driverList = [
			...new Set(
				carrierDB.data
					.map((r) => (r[carrierDriverCol] || "").trim())
					.filter(Boolean),
			),
		].sort();

		// Fleet details
		const fleet = carrierDB.data.map((r) => {
			const name = (r[carrierDriverCol] || "").trim();
			const currentLoad = activeJobs.find(
				(j) =>
					driverCol && (j[driverCol] || "").trim() === name,
			);
			const phoneCol = findCol(carrierDB.headers, /phone|contact/i);
			return {
				Driver: name,
				Truck: truckCol ? r[truckCol] || "" : "",
				Phone: phoneCol ? r[phoneCol] || "" : "",
				Status: currentLoad ? "On Load" : "Available",
				CurrentLoad: currentLoad
					? loadIdCol
						? currentLoad[loadIdCol]
						: ""
					: "",
				CompletedLoads: completedJobs.filter(
					(j) =>
						driverCol &&
						(j[driverCol] || "").trim() === name,
				).length,
			};
		});

		res.json({
			timestamp: new Date().toISOString(),
			kpis: {
				activeLoads: activeJobs.length,
				unassignedLoads: unassignedJobs.length,
				completedThisWeek,
				completedThisMonth,
				fleetUtilization: { assigned: assignedTrucks, total: totalTrucks },
				revenue: {
					total: Math.round(revTotal * 100) / 100,
					paid: Math.round(revPaid * 100) / 100,
					pending: Math.round(revPending * 100) / 100,
				},
			},
			unassignedJobs,
			jobTrackingHeaders: jobTracking.headers,
			activeJobs,
			fleet,
			drivers: driverList,
		});
	} catch (error) {
		console.error("Error building dashboard:", error.message);
		res.status(500).json({ error: error.message });
	}
});

// ============================================================
// DRIVER APP — Endpoints for the mobile driver application
// ============================================================

// Helper: parse sheet rows into { headers, data } with _rowIndex
function parseSheet(valueRange) {
	const rows = (valueRange && valueRange.values) || [];
	if (rows.length === 0) return { headers: [], data: [] };
	const headers = rows[0];
	const data = rows.slice(1).map((row, idx) => {
		const obj = { _rowIndex: idx + 2 };
		headers.forEach((h, i) => {
			obj[h] = row[i] || "";
		});
		return obj;
	});
	return { headers, data };
}

function findCol(headers, regex) {
	return headers.find((h) => regex.test(h)) || null;
}

// GET /api/driver/:driverName — All data for one driver (single batchGet)
app.get("/api/driver/:driverName", requireAuth, async (req, res) => {
	try {
		const driverName = decodeURIComponent(req.params.driverName).trim();

		// Drivers can only access their own data
		if (
			req.session.user.role === "Driver" &&
			req.session.user.driverName.toLowerCase() !== driverName.toLowerCase()
		) {
			return res.status(403).json({ error: "Forbidden" });
		}
		const sheets = await getSheets();

		const response = await sheets.spreadsheets.values.batchGet({
			spreadsheetId: SPREADSHEET_ID,
			ranges: ["Job Tracking", "Carrier Database"],
		});

		const rangeData = response.data.valueRanges || [];
		const jobTracking = parseSheet(rangeData[0]);
		const carrierDB = parseSheet(rangeData[1]);

		// Find driver column in Job Tracking
		const driverCol = findCol(jobTracking.headers, /driver/i);
		const carrierDriverCol =
			findCol(carrierDB.headers, /driver/i) || carrierDB.headers[0];

		// Filter loads for this driver
		const loads = driverCol
			? jobTracking.data.filter(
					(r) =>
						(r[driverCol] || "").trim().toLowerCase() ===
						driverName.toLowerCase(),
				)
			: [];

		// Find driver info from Carrier Database
		const driverInfo = carrierDB.data.find(
			(r) =>
				(r[carrierDriverCol] || "").trim().toLowerCase() ===
				driverName.toLowerCase(),
		);

		// Messages from SQLite (fast indexed query)
		const nameLower = driverName.toLowerCase();
		const driverMessages = db
			.prepare(
				`SELECT id, timestamp, "from", "to", message, load_id AS loadId, read
				 FROM messages
				 WHERE LOWER("from") = ? OR LOWER("to") = ?
				 ORDER BY id ASC`,
			)
			.all(nameLower, nameLower);

		// Expenses from SQLite
		const driverExpenses = db
			.prepare(
				`SELECT id, timestamp, driver, load_id AS loadId, type, amount,
				        description, date, photo_data AS photoData, status
				 FROM expenses
				 WHERE LOWER(driver) = ?
				 ORDER BY id DESC`,
			)
			.all(nameLower);

		// Strip rate/revenue columns for Driver role
		let filteredLoads = loads;
		let filteredHeaders = jobTracking.headers;
		if (req.session.user.role === "Driver") {
			const rateRegex = /rate|amount|revenue|pay|charge|price|cost/i;
			const hiddenCols = new Set(
				jobTracking.headers.filter((h) => rateRegex.test(h)),
			);
			filteredHeaders = jobTracking.headers.filter(
				(h) => !hiddenCols.has(h),
			);
			filteredLoads = loads.map((load) => {
				const cleaned = { ...load };
				hiddenCols.forEach((col) => delete cleaned[col]);
				return cleaned;
			});
		}

		// Build list of all driver names for recipient picker
		const carrierDriverNames = [
			...new Set(
				carrierDB.data
					.map((r) => (r[carrierDriverCol] || "").trim())
					.filter(Boolean),
			),
		].sort();

		res.json({
			loads: filteredLoads,
			driverInfo: driverInfo || null,
			messages: driverMessages,
			expenses: driverExpenses,
			drivers: carrierDriverNames,
			headers: {
				jobTracking: filteredHeaders,
				carrierDB: carrierDB.headers,
			},
		});
	} catch (error) {
		console.error("Error fetching driver data:", error.message);
		res.status(500).json({ error: error.message });
	}
});

// PUT /api/driver/status — Update load status + log to Status Logs
app.put("/api/driver/status", requireAuth, async (req, res) => {
	try {
		const { rowIndex, driverName, loadId, oldStatus, newStatus, values } =
			req.body;
		const sheets = await getSheets();

		// Update the Job Tracking row
		await sheets.spreadsheets.values.update({
			spreadsheetId: SPREADSHEET_ID,
			range: `Job Tracking!A${rowIndex}`,
			valueInputOption: "USER_ENTERED",
			requestBody: { values: [values] },
		});

		// Append log entry to Status Logs
		// Columns: Log ID | Job ID | Carrier Name | Date and Time | Status Update | Notes
		const now = new Date();
		const logId = `LOG-${now.getTime()}`;
		const dateTime = `${(now.getMonth() + 1).toString().padStart(2, "0")}/${now.getDate().toString().padStart(2, "0")}/${now.getFullYear()} ${now.getHours()}:${now.getMinutes().toString().padStart(2, "0")}:${now.getSeconds().toString().padStart(2, "0")}`;
		await sheets.spreadsheets.values.append({
			spreadsheetId: SPREADSHEET_ID,
			range: "Status Logs",
			valueInputOption: "USER_ENTERED",
			requestBody: {
				values: [[logId, loadId, driverName, dateTime, newStatus, `Changed from ${oldStatus}`]],
			},
		});

		res.json({ success: true });
	} catch (error) {
		console.error("Error updating driver status:", error.message);
		res.status(500).json({ error: error.message });
	}
});

// POST /api/messages — Send a new message
app.post("/api/messages", requireAuth, (req, res) => {
	try {
		const { from, to, message, loadId } = req.body;
		if (!from || !to || !message) {
			return res.status(400).json({ error: "from, to, and message required" });
		}

		const timestamp = new Date().toISOString();
		const result = db
			.prepare(
				`INSERT INTO messages (timestamp, "from", "to", message, load_id)
				 VALUES (?, ?, ?, ?, ?)`,
			)
			.run(timestamp, from, to, message, loadId || "");

		// Broadcast via Socket.IO for real-time delivery
		io.emit("new-message", {
			id: result.lastInsertRowid,
			timestamp,
			from,
			to,
			message,
			loadId: loadId || "",
		});

		res.json({ success: true, id: result.lastInsertRowid });
	} catch (error) {
		console.error("Error sending message:", error.message);
		res.status(500).json({ error: error.message });
	}
});

// PUT /api/messages/read — Mark messages as read
app.put("/api/messages/read", requireAuth, (req, res) => {
	try {
		const { messageIds } = req.body; // array of message IDs
		if (!messageIds || !messageIds.length) {
			return res.json({ success: true });
		}

		const placeholders = messageIds.map(() => "?").join(",");
		db.prepare(
			`UPDATE messages SET read = 1 WHERE id IN (${placeholders})`,
		).run(...messageIds);

		res.json({ success: true });
	} catch (error) {
		console.error("Error marking messages read:", error.message);
		res.status(500).json({ error: error.message });
	}
});

// GET /api/messages — All messages for dispatch view (Admin/Dispatcher)
app.get("/api/messages", requireRole("Admin", "Dispatcher"), (req, res) => {
	try {
		// Get all unique driver conversations (exclude Dispatch-to-Dispatch)
		const conversations = db
			.prepare(
				`SELECT
					CASE WHEN LOWER("from") = 'dispatch' THEN "to" ELSE "from" END AS driver,
					MAX(timestamp) AS lastTimestamp,
					SUM(CASE WHEN LOWER("to") = 'dispatch' AND read = 0 THEN 1 ELSE 0 END) AS unread
				 FROM messages
				 GROUP BY driver
				 ORDER BY lastTimestamp DESC`,
			)
			.all();

		res.json({ conversations });
	} catch (error) {
		console.error("Error fetching messages:", error.message);
		res.status(500).json({ error: error.message });
	}
});

// GET /api/messages/:driverName — Messages for a specific driver (Admin/Dispatcher)
app.get("/api/messages/:driverName", requireRole("Admin", "Dispatcher"), (req, res) => {
	try {
		const driverName = decodeURIComponent(req.params.driverName).trim();
		const nameLower = driverName.toLowerCase();
		const messages = db
			.prepare(
				`SELECT id, timestamp, "from", "to", message, load_id AS loadId, read
				 FROM messages
				 WHERE LOWER("from") = ? OR LOWER("to") = ?
				 ORDER BY id ASC`,
			)
			.all(nameLower, nameLower);

		res.json({ messages });
	} catch (error) {
		console.error("Error fetching driver messages:", error.message);
		res.status(500).json({ error: error.message });
	}
});

// POST /api/expenses — Log a new expense (SQLite)
app.post("/api/expenses", requireAuth, (req, res) => {
	try {
		const { driver, loadId, type, amount, description, date, photoData } =
			req.body;
		if (!driver || !type || !amount || !date) {
			return res.status(400).json({ error: "Missing required fields" });
		}

		const timestamp = new Date().toISOString();
		const result = db
			.prepare(
				`INSERT INTO expenses (timestamp, driver, load_id, type, amount, description, date, photo_data)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(timestamp, driver, loadId || "", type, amount, description || "", date, photoData || "");

		res.json({ success: true, id: result.lastInsertRowid });
	} catch (error) {
		console.error("Error logging expense:", error.message);
		res.status(500).json({ error: error.message });
	}
});

// ============================================================
// INVESTOR — Financial & Investor View (Read-Only)
// ============================================================

// GET /api/investor — Aggregated financial data for investor view
app.get("/api/investor", requireRole("Admin", "Investor"), async (req, res) => {
	try {
		const sheets = await getSheets();

		const response = await sheets.spreadsheets.values.batchGet({
			spreadsheetId: SPREADSHEET_ID,
			ranges: ["Job Tracking", "Payments Table", "Carrier Database"],
		});

		const rangeData = response.data.valueRanges || [];
		const jobTracking = parseSheet(rangeData[0]);
		const payments = parseSheet(rangeData[1]);
		const carrierDB = parseSheet(rangeData[2]);

		// Load investor config from SQLite
		const configRows = db.prepare("SELECT key, value FROM investor_config").all();
		const config = {};
		configRows.forEach((r) => (config[r.key] = r.value));

		// ---- Production Performance ----
		const rateCol = findCol(payments.headers, /rate|amount|total|pay/i);
		const payStatusCol = findCol(payments.headers, /pay.*status|status/i);
		const dateCol = findCol(payments.headers, /date/i);

		let totalRevenue = 0;
		let paidRevenue = 0;
		const monthlyRevenue = {};

		payments.data.forEach((r) => {
			const amt =
				parseFloat(String(rateCol ? r[rateCol] : "0").replace(/[$,]/g, "")) || 0;
			totalRevenue += amt;
			const ps = payStatusCol ? (r[payStatusCol] || "").trim() : "";
			if (/^paid$/i.test(ps)) paidRevenue += amt;

			// Group by month
			if (dateCol && r[dateCol]) {
				const d = new Date(r[dateCol]);
				if (!isNaN(d)) {
					const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
					monthlyRevenue[key] = (monthlyRevenue[key] || 0) + amt;
				}
			}
		});

		// Calculate operating days (from earliest to latest payment date)
		let earliestDate = null;
		let latestDate = null;
		payments.data.forEach((r) => {
			if (dateCol && r[dateCol]) {
				const d = new Date(r[dateCol]);
				if (!isNaN(d)) {
					if (!earliestDate || d < earliestDate) earliestDate = d;
					if (!latestDate || d > latestDate) latestDate = d;
				}
			}
		});
		const operatingDays =
			earliestDate && latestDate
				? Math.max(1, Math.ceil((latestDate - earliestDate) / (1000 * 60 * 60 * 24)))
				: 1;
		const avgDailyRevenue = totalRevenue / operatingDays;

		// Monthly revenue sorted
		const monthlyData = Object.entries(monthlyRevenue)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([month, amount]) => ({ month, amount: Math.round(amount) }));

		// ---- Asset Security ----
		const purchasePrice = parseFloat(config.truck_purchase_price) || 58000;
		const currentValue = parseFloat(config.truck_current_value) || 21000;
		const titleStatus = config.truck_title_status || "Clean";
		const depreciationYears = parseInt(config.depreciation_years) || 5;
		const annualDepreciation = purchasePrice / depreciationYears;

		// Total trucks in fleet
		const totalTrucks = carrierDB.data.length;

		// ---- Tax Shield ----
		const section179 = parseFloat(config.section_179_deduction) || 30000;
		const atRiskCapital = Math.max(0, purchasePrice - section179);

		// ---- Recession-Proof Metrics ----
		const blueChipList = (config.blue_chip_brokers || "")
			.split(",")
			.map((s) => s.trim().toLowerCase())
			.filter(Boolean);

		const brokerCol = findCol(jobTracking.headers, /broker|shipper|customer|client/i);
		const statusCol = findCol(jobTracking.headers, /status/i);

		let totalJobs = jobTracking.data.length;
		let blueChipJobs = 0;
		const brokerCounts = {};

		// Extract broker name — handles JSON objects like {"Name":"C.H. Robinson","Email":"..."}
		function parseBrokerName(raw) {
			const val = (raw || "").trim();
			if (!val) return "";
			if (val.startsWith("{")) {
				try {
					const obj = JSON.parse(val);
					return (obj.Name || obj.name || Object.values(obj)[0] || "").trim();
				} catch {
					return val;
				}
			}
			return val;
		}

		jobTracking.data.forEach((r) => {
			const broker = parseBrokerName(brokerCol ? r[brokerCol] : "");
			if (broker) {
				brokerCounts[broker] = (brokerCounts[broker] || 0) + 1;
				if (blueChipList.some((bc) => broker.toLowerCase().includes(bc))) {
					blueChipJobs++;
				}
			}
		});

		// Top brokers by volume
		const topBrokers = Object.entries(brokerCounts)
			.sort(([, a], [, b]) => b - a)
			.slice(0, 10)
			.map(([name, count]) => ({
				name,
				count,
				isBlueChip: blueChipList.some((bc) => name.toLowerCase().includes(bc)),
			}));

		// Completed jobs count
		const completedStatuses = /^(delivered|completed|pod received)$/i;
		const completedJobs = statusCol
			? jobTracking.data.filter((r) =>
					completedStatuses.test((r[statusCol] || "").trim()),
				).length
			: 0;

		// Investor payout range
		const payoutMin = parseFloat(config.investor_payout_min) || 2100;
		const payoutMax = parseFloat(config.investor_payout_max) || 3100;
		const splitPct = parseFloat(config.investor_split_pct) || 35;

		res.json({
			production: {
				totalRevenue: Math.round(totalRevenue),
				paidRevenue: Math.round(paidRevenue),
				pendingRevenue: Math.round(totalRevenue - paidRevenue),
				avgDailyRevenue: Math.round(avgDailyRevenue),
				operatingDays,
				monthlyData,
				payoutRange: { min: payoutMin, max: payoutMax },
				investorSplitPct: splitPct,
				totalJobs,
				completedJobs,
			},
			asset: {
				purchasePrice,
				currentValue,
				titleStatus,
				depreciationYears,
				annualDepreciation: Math.round(annualDepreciation),
				totalTrucks,
			},
			taxShield: {
				section179,
				atRiskCapital,
				writeOffPct: Math.round((section179 / purchasePrice) * 100),
			},
			recessionProof: {
				totalJobs,
				blueChipJobs,
				blueChipPct: totalJobs > 0 ? Math.round((blueChipJobs / totalJobs) * 100) : 0,
				topBrokers,
			},
			config,
		});
	} catch (error) {
		console.error("Error building investor data:", error.message);
		res.status(500).json({ error: error.message });
	}
});

// PUT /api/investor/config — Admin: update investor config
app.put("/api/investor/config", requireRole("Admin"), (req, res) => {
	try {
		const updates = req.body; // { key: value, ... }
		const stmt = db.prepare(
			"INSERT OR REPLACE INTO investor_config (key, value) VALUES (?, ?)",
		);
		const updateMany = db.transaction((entries) => {
			for (const [k, v] of entries) stmt.run(k, String(v));
		});
		updateMany(Object.entries(updates));
		res.json({ success: true });
	} catch (error) {
		console.error("Error updating investor config:", error.message);
		res.status(500).json({ error: error.message });
	}
});

// ============================================================
// Socket.IO — Real-time messaging + live reload
// ============================================================
io.on("connection", (socket) => {
	socket.on("register", (name) => {
		if (name) socket.join(name.trim().toLowerCase());
	});
});

// Live reload: broadcast to all clients when server restarts (via --watch)
setTimeout(() => io.emit("reload"), 500);

// ============================================================
// Start Server
// ============================================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
	console.log(`Server running at http://localhost:${PORT}`);
	console.log(`API endpoints:`);
	console.log(`  GET    /api/tabs           — List sheet tabs`);
	console.log(`  GET    /api/data           — Read all rows`);
	console.log(`  POST   /api/data           — Add a new row`);
	console.log(`  PUT    /api/data/:row      — Update a row`);
	console.log(`  DELETE /api/data/:row      — Delete a row`);
	console.log(`  GET    /api/dashboard      — Aggregated dashboard data`);
	console.log(`  GET    /api/driver/:name  — Driver-specific data`);
	console.log(`  PUT    /api/driver/status — Update load status`);
	console.log(`  POST   /api/messages      — Send a message`);
	console.log(`  PUT    /api/messages/read — Mark messages read`);
	console.log(`  POST   /api/expenses      — Log an expense`);

	// Pre-warm: verify connection + cache auth client and sheet IDs
	try {
		const sheets = await getSheets();
		const spreadsheet = await sheets.spreadsheets.get({
			spreadsheetId: SPREADSHEET_ID,
		});
		const tabs = spreadsheet.data.sheets.map((s) => {
			sheetIdCache.set(s.properties.title, s.properties.sheetId);
			return s.properties.title;
		});
		console.log(`Google Sheets connected — ${tabs.length} tabs cached`);
	} catch (error) {
		console.error(`Google Sheets connection FAILED: ${error.message}`);
	}
});
