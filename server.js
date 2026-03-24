require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { google } = require("googleapis");
const path = require("path");
const bcrypt = require("bcryptjs");
const session = require("express-session");
const Database = require("better-sqlite3");
const SqliteStore = require("better-sqlite3-session-store")(session);
const geolib = require("geolib");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.json({ limit: "5mb" }));

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

// Migrate: add gallons + odometer columns to expenses table (fuel tracking)
try {
	db.prepare("SELECT gallons FROM expenses LIMIT 1").get();
} catch {
	db.exec(`ALTER TABLE expenses ADD COLUMN gallons REAL DEFAULT 0`);
	db.exec(`ALTER TABLE expenses ADD COLUMN odometer REAL DEFAULT 0`);
}

// Maintenance sinking fund: tracks $800/mo reserve contributions + PM services
db.exec(`
	CREATE TABLE IF NOT EXISTS maintenance_fund (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		type TEXT NOT NULL CHECK(type IN ('contribution', 'service')),
		amount REAL NOT NULL,
		description TEXT DEFAULT '',
		truck TEXT DEFAULT '',
		date TEXT NOT NULL,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP
	)
`);

// Compliance fees: 2290, Registration, IFTA quarterly, etc.
db.exec(`
	CREATE TABLE IF NOT EXISTS compliance_fees (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		type TEXT NOT NULL,
		amount REAL NOT NULL,
		description TEXT DEFAULT '',
		truck TEXT DEFAULT '',
		due_date TEXT NOT NULL,
		paid_date TEXT DEFAULT '',
		status TEXT DEFAULT 'Pending' CHECK(status IN ('Pending', 'Paid')),
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP
	)
`);

db.exec(`
	CREATE TABLE IF NOT EXISTS documents (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		load_id TEXT NOT NULL,
		driver TEXT NOT NULL,
		type TEXT NOT NULL,
		file_name TEXT NOT NULL,
		drive_file_id TEXT DEFAULT '',
		drive_url TEXT DEFAULT '',
		uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
	)
`);

db.exec(`
	CREATE TABLE IF NOT EXISTS driver_locations (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		driver TEXT NOT NULL,
		latitude REAL NOT NULL,
		longitude REAL NOT NULL,
		accuracy REAL DEFAULT 0,
		speed REAL DEFAULT 0,
		heading REAL DEFAULT 0,
		timestamp TEXT NOT NULL,
		load_id TEXT DEFAULT ''
	)
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_locations_driver ON driver_locations(driver)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_locations_ts ON driver_locations(timestamp)`);

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
		["maintenance_fund_monthly", "800"],
		["fuel_savings_target_pct", "15"],
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
// Serve Vue SPA build (client/dist) if it exists, otherwise fall back to public/
const fs = require("fs");
const clientDistPath = path.join(__dirname, "client", "dist");
const publicPath = path.join(__dirname, "public");
if (fs.existsSync(clientDistPath)) {
	app.use(express.static(clientDistPath));
} else {
	app.use(express.static(publicPath));
}

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
	scopes: [
		"https://www.googleapis.com/auth/spreadsheets",
		"https://www.googleapis.com/auth/drive.file",
	],
});

let sheetsClient = null;
let driveClient = null;
const sheetIdCache = new Map();
const DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID || "";

async function getSheets() {
	if (!sheetsClient) {
		const authClient = await auth.getClient();
		sheetsClient = google.sheets({ version: "v4", auth: authClient });
	}
	return sheetsClient;
}

async function getDrive() {
	if (!driveClient) {
		const authClient = await auth.getClient();
		driveClient = google.drive({ version: "v3", auth: authClient });
	}
	return driveClient;
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
// Admin: update a user's role, driverName, or email
app.put("/api/users/:id", requireRole("Admin"), async (req, res) => {
	try {
		const id = parseInt(req.params.id);
		const { role, driverName, email, password } = req.body;

		const user = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
		if (!user) return res.status(404).json({ error: "User not found" });

		const updates = [];
		const params = [];

		if (role && ["Admin", "Dispatcher", "Driver", "Investor"].includes(role)) {
			updates.push("role = ?");
			params.push(role);
		}
		if (driverName !== undefined) {
			updates.push("driver_name = ?");
			params.push(driverName);
		}
		if (email !== undefined) {
			updates.push("email = ?");
			params.push(email);
		}
		if (password) {
			const bcrypt = await import("bcryptjs");
			const hash = await bcrypt.hash(password, 10);
			updates.push("password_hash = ?");
			params.push(hash);
		}

		if (updates.length === 0) {
			return res.status(400).json({ error: "No valid fields to update" });
		}

		params.push(id);
		db.prepare(`UPDATE users SET ${updates.join(", ")} WHERE id = ?`).run(...params);

		res.json({ success: true });
	} catch (error) {
		console.error("Error updating user:", error.message);
		res.status(500).json({ error: error.message });
	}
});

app.delete("/api/users/:id", requireRole("Admin"), (req, res) => {
	const id = parseInt(req.params.id);
	db.prepare("DELETE FROM users WHERE id = ?").run(id);
	res.json({ success: true });
});

// Debug: check what the driver endpoint returns (first 2 loads)
app.get("/api/debug/driver-view/:driverName", async (req, res) => {
	try {
		const driverName = decodeURIComponent(req.params.driverName).trim();
		const sheets = await getSheets();
		const response = await sheets.spreadsheets.values.batchGet({
			spreadsheetId: SPREADSHEET_ID,
			ranges: ["Job Tracking"],
		});
		const rangeData = response.data.valueRanges || [];
		const rows = (rangeData[0] && rangeData[0].values) || [];
		if (rows.length === 0) return res.json({ error: "No data" });
		const headers = rows[0];
		const driverCol = headers.find((h) => /driver/i.test(h)) || null;
		const rateRegex = /rate|amount|revenue|pay|charge|price|cost/i;
		const filteredHeaders = headers.filter((h) => !rateRegex.test(h));
		const driverColIdx = driverCol ? headers.indexOf(driverCol) : -1;
		const matching = rows.slice(1).filter((r) => driverColIdx >= 0 && (r[driverColIdx] || "").trim().toLowerCase() === driverName.toLowerCase());
		const sample = matching.slice(0, 2).map((row) => {
			const obj = {};
			filteredHeaders.forEach((h) => {
				const i = headers.indexOf(h);
				obj[h] = row[i] || "";
			});
			return obj;
		});
		res.json({ filteredHeaders, sampleLoads: sample });
	} catch (error) {
		res.status(500).json({ error: error.message });
	}
});

// Debug: analyze empty rows for a driver
app.get("/api/debug/driver-empty/:driverName", async (req, res) => {
	try {
		const driverName = decodeURIComponent(req.params.driverName).trim();
		const sheets = await getSheets();
		const response = await sheets.spreadsheets.values.get({
			spreadsheetId: SPREADSHEET_ID,
			range: "Job Tracking",
		});
		const rows = response.data.values || [];
		if (rows.length < 2) return res.json({ error: "No data" });
		const headers = rows[0];
		const driverIdx = headers.findIndex((h) => /driver/i.test(h));
		const loadIdIdx = headers.findIndex((h) => /load.?id|job.?id/i.test(h));
		const detailsIdx = headers.findIndex((h) => /details/i.test(h));
		const statusIdx = headers.findIndex((h) => /status/i.test(h));

		let totalForDriver = 0;
		let emptyLoadId = 0;
		let emptyDetails = 0;
		let emptyBoth = 0;
		const emptySamples = [];

		rows.slice(1).forEach((row, idx) => {
			if (driverIdx < 0) return;
			if ((row[driverIdx] || "").trim().toLowerCase() !== driverName.toLowerCase()) return;
			totalForDriver++;
			const lid = (row[loadIdIdx] || "").trim();
			const det = (row[detailsIdx] || "").trim();
			const st = (row[statusIdx] || "").trim();
			if (!lid) emptyLoadId++;
			if (!det) emptyDetails++;
			if (!lid && !det) {
				emptyBoth++;
				if (emptySamples.length < 5) {
					const obj = { _rowIndex: idx + 2 };
					headers.forEach((h, i) => { obj[h] = row[i] || ""; });
					emptySamples.push(obj);
				}
			}
		});

		res.json({
			driver: driverName,
			totalForDriver,
			emptyLoadId,
			emptyDetails,
			emptyBoth,
			emptySamples,
		});
	} catch (error) {
		res.status(500).json({ error: error.message });
	}
});

// Debug: sample row data to inspect column formats
app.get("/api/debug/sample-row", async (req, res) => {
	try {
		const sheets = await getSheets();
		const response = await sheets.spreadsheets.values.get({
			spreadsheetId: SPREADSHEET_ID,
			range: "Job Tracking!A1:W3",
		});
		const rows = response.data.values || [];
		if (rows.length < 2) return res.json({ error: "No data" });
		const headers = rows[0];
		const samples = rows.slice(1).map((row) => {
			const obj = {};
			headers.forEach((h, i) => { obj[h] = row[i] || ""; });
			return obj;
		});
		res.json({ headers, samples });
	} catch (error) {
		res.status(500).json({ error: error.message });
	}
});

// Debug: check driver load matching
app.get("/api/debug/driver-loads/:driverName", async (req, res) => {
	try {
		const driverName = decodeURIComponent(req.params.driverName).trim();
		const sheets = await getSheets();
		const response = await sheets.spreadsheets.values.get({
			spreadsheetId: SPREADSHEET_ID,
			range: "Job Tracking",
		});
		const rows = (response.data.values) || [];
		if (rows.length === 0) return res.json({ error: "No data" });
		const headers = rows[0];
		const driverCol = headers.find((h) => /driver/i.test(h)) || null;
		const totalRows = rows.length - 1;
		const matchingRows = driverCol
			? rows.slice(1).filter((r) => {
				const idx = headers.indexOf(driverCol);
				return (r[idx] || "").trim().toLowerCase() === driverName.toLowerCase();
			}).length
			: 0;
		res.json({
			headers,
			driverCol,
			driverColIndex: driverCol ? headers.indexOf(driverCol) : null,
			totalRows,
			matchingRows,
			searchedFor: driverName,
			sampleDriverValues: rows.slice(1, 6).map((r) => driverCol ? r[headers.indexOf(driverCol)] || "" : "N/A"),
		});
	} catch (error) {
		res.status(500).json({ error: error.message });
	}
});

// Debug: check a user's role/driverName without auth (read-only, no sensitive data)
app.get("/api/debug/user/:username", (req, res) => {
	const username = decodeURIComponent(req.params.username).trim();
	const user = db
		.prepare("SELECT id, username, role, driver_name, email, created_at FROM users WHERE LOWER(username) = ?")
		.get(username.toLowerCase());
	if (!user) return res.status(404).json({ error: "User not found" });
	res.json({
		id: user.id,
		username: user.username,
		role: user.role,
		driverName: user.driver_name || "",
		email: user.email || "",
		createdAt: user.created_at,
	});
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

// POST /api/dispatch — Assign driver to a load and notify via Socket.IO
app.post("/api/dispatch", requireRole("Admin", "Dispatcher"), async (req, res) => {
	try {
		const { rowIndex, driver, loadId, values } = req.body;
		if (!rowIndex || !driver || !values) {
			return res.status(400).json({ error: "rowIndex, driver, and values required" });
		}

		const sheets = await getSheets();
		await sheets.spreadsheets.values.update({
			spreadsheetId: SPREADSHEET_ID,
			range: `Job Tracking!A${rowIndex}`,
			valueInputOption: "USER_ENTERED",
			requestBody: { values: [values] },
		});

		// Notify the driver in real-time
		io.to(driver.trim().toLowerCase()).emit("load-assigned", { loadId, rowIndex });

		res.json({ success: true });
	} catch (error) {
		console.error("Error dispatching load:", error.message);
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

		// Notify dispatch in real-time
		io.to("dispatch").emit("status-updated", { loadId, driverName, newStatus });

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
		if (!loadId) {
			return res.status(400).json({ error: "loadId is required" });
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
		// Group conversations by driver + load
		const conversations = db
			.prepare(
				`SELECT
					CASE WHEN LOWER("from") = 'dispatch' THEN "to" ELSE "from" END AS driver,
					load_id AS loadId,
					MAX(timestamp) AS lastTimestamp,
					SUM(CASE WHEN LOWER("to") = 'dispatch' AND read = 0 THEN 1 ELSE 0 END) AS unread
				 FROM messages
				 GROUP BY driver, load_id
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
		const loadId = req.query.loadId || "";

		let messages;
		if (loadId) {
			messages = db
				.prepare(
					`SELECT id, timestamp, "from", "to", message, load_id AS loadId, read
					 FROM messages
					 WHERE (LOWER("from") = ? OR LOWER("to") = ?) AND load_id = ?
					 ORDER BY id ASC`,
				)
				.all(nameLower, nameLower, loadId);
		} else {
			messages = db
				.prepare(
					`SELECT id, timestamp, "from", "to", message, load_id AS loadId, read
					 FROM messages
					 WHERE LOWER("from") = ? OR LOWER("to") = ?
					 ORDER BY id ASC`,
				)
				.all(nameLower, nameLower);
		}

		res.json({ messages });
	} catch (error) {
		console.error("Error fetching driver messages:", error.message);
		res.status(500).json({ error: error.message });
	}
});

// POST /api/expenses — Log a new expense (SQLite)
app.post("/api/expenses", requireAuth, (req, res) => {
	try {
		const { driver, loadId, type, amount, description, date, photoData, gallons, odometer } =
			req.body;
		if (!driver || !type || !amount || !date) {
			return res.status(400).json({ error: "Missing required fields" });
		}

		const timestamp = new Date().toISOString();
		const result = db
			.prepare(
				`INSERT INTO expenses (timestamp, driver, load_id, type, amount, description, date, photo_data, gallons, odometer)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(timestamp, driver, loadId || "", type, amount, description || "", date, photoData || "",
				parseFloat(gallons) || 0, parseFloat(odometer) || 0);

		res.json({ success: true, id: result.lastInsertRowid });
	} catch (error) {
		console.error("Error logging expense:", error.message);
		res.status(500).json({ error: error.message });
	}
});

// POST /api/documents/upload — Upload POD/BOL document to Google Drive
app.post("/api/documents/upload", requireAuth, async (req, res) => {
	try {
		const { loadId, rowIndex, type, photoData, driverName } = req.body;
		if (!loadId || !rowIndex || !type || !photoData) {
			return res.status(400).json({ error: "loadId, rowIndex, type, and photoData required" });
		}

		const fileName = `${loadId}_${type}.jpg`;
		let driveFileId = "";
		let driveUrl = "";

		// Upload to Google Drive if folder configured
		if (DRIVE_FOLDER_ID) {
			const drive = await getDrive();
			const base64Data = photoData.replace(/^data:image\/\w+;base64,/, "");
			const buffer = Buffer.from(base64Data, "base64");
			const { Readable } = require("stream");

			const driveResponse = await drive.files.create({
				requestBody: {
					name: fileName,
					parents: [DRIVE_FOLDER_ID],
				},
				media: {
					mimeType: "image/jpeg",
					body: Readable.from(buffer),
				},
				fields: "id, webViewLink",
			});

			driveFileId = driveResponse.data.id || "";
			driveUrl = driveResponse.data.webViewLink || "";
		}

		// Update "POD Uploaded" column in Google Sheet
		const sheets = await getSheets();
		const headerResp = await sheets.spreadsheets.values.get({
			spreadsheetId: SPREADSHEET_ID,
			range: "Job Tracking!1:1",
		});
		const headers = (headerResp.data.values || [[]])[0];
		const podColIdx = headers.findIndex((h) => /pod.*upload/i.test(h));

		if (podColIdx >= 0) {
			const colLetter = String.fromCharCode(65 + podColIdx);
			await sheets.spreadsheets.values.update({
				spreadsheetId: SPREADSHEET_ID,
				range: `Job Tracking!${colLetter}${rowIndex}`,
				valueInputOption: "USER_ENTERED",
				requestBody: { values: [["Yes"]] },
			});
		}

		// Store metadata in SQLite
		db.prepare(
			`INSERT INTO documents (load_id, driver, type, file_name, drive_file_id, drive_url)
			 VALUES (?, ?, ?, ?, ?, ?)`
		).run(loadId, driverName || "", type, fileName, driveFileId, driveUrl);

		// Notify dispatch
		io.to("dispatch").emit("pod-uploaded", { loadId, driverName, driveUrl });

		res.json({ success: true, driveUrl });
	} catch (error) {
		console.error("Error uploading document:", error.message);
		res.status(500).json({ error: error.message });
	}
});

// ============================================================
// GPS TRACKING & GEOFENCING
// ============================================================

const GEOFENCE_RADIUS = 500; // meters

function checkGeofence(lat, lng, loadData, headers) {
	// Look for lat/lng columns for origin and destination
	const originLatCol = headers.find((h) => /origin.*lat|pickup.*lat|shipper.*lat/i.test(h));
	const originLngCol = headers.find((h) => /origin.*l(on|ng)|pickup.*l(on|ng)|shipper.*l(on|ng)/i.test(h));
	const destLatCol = headers.find((h) => /dest.*lat|drop.*lat|receiver.*lat|delivery.*lat/i.test(h));
	const destLngCol = headers.find((h) => /dest.*l(on|ng)|drop.*l(on|ng)|receiver.*l(on|ng)|delivery.*l(on|ng)/i.test(h));

	const triggers = [];

	if (originLatCol && originLngCol) {
		const oLat = parseFloat(loadData[originLatCol]);
		const oLng = parseFloat(loadData[originLngCol]);
		if (!isNaN(oLat) && !isNaN(oLng)) {
			if (geolib.isPointWithinRadius({ latitude: lat, longitude: lng }, { latitude: oLat, longitude: oLng }, GEOFENCE_RADIUS)) {
				triggers.push("At Shipper");
			}
		}
	}

	if (destLatCol && destLngCol) {
		const dLat = parseFloat(loadData[destLatCol]);
		const dLng = parseFloat(loadData[destLngCol]);
		if (!isNaN(dLat) && !isNaN(dLng)) {
			if (geolib.isPointWithinRadius({ latitude: lat, longitude: lng }, { latitude: dLat, longitude: dLng }, GEOFENCE_RADIUS)) {
				triggers.push("At Receiver");
			}
		}
	}

	return triggers;
}

// POST /api/location — Driver reports location
app.post("/api/location", requireAuth, async (req, res) => {
	try {
		const { latitude, longitude, accuracy, speed, heading, loadId } = req.body;
		const driverName = req.session?.user?.driverName || req.session?.user?.username || "";
		if (!latitude || !longitude) {
			return res.status(400).json({ error: "latitude and longitude required" });
		}

		const timestamp = new Date().toISOString();
		db.prepare(
			`INSERT INTO driver_locations (driver, latitude, longitude, accuracy, speed, heading, timestamp, load_id)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
		).run(driverName, latitude, longitude, accuracy || 0, speed || 0, heading || 0, timestamp, loadId || "");

		// Broadcast to dispatch
		io.to("dispatch").emit("location-update", {
			driver: driverName,
			latitude, longitude,
			speed: speed || 0,
			loadId: loadId || "",
			timestamp,
		});

		// Geofence check if loadId is provided
		let geofenceTriggered = null;
		if (loadId) {
			try {
				const sheets = await getSheets();
				const headerResp = await sheets.spreadsheets.values.get({
					spreadsheetId: SPREADSHEET_ID,
					range: "Job Tracking!1:1",
				});
				const headers = (headerResp.data.values || [[]])[0];

				// Find the load row
				const dataResp = await sheets.spreadsheets.values.get({
					spreadsheetId: SPREADSHEET_ID,
					range: "Job Tracking",
				});
				const rows = dataResp.data.values || [];
				for (let i = 1; i < rows.length; i++) {
					const loadObj = {};
					headers.forEach((h, idx) => { loadObj[h] = rows[i][idx] || ""; });
					const loadIdCol = headers.find((h) => /load.?id|job.?id/i.test(h));
					if (loadIdCol && loadObj[loadIdCol] === loadId) {
						const triggers = checkGeofence(latitude, longitude, loadObj, headers);
						if (triggers.length > 0) {
							geofenceTriggered = triggers[0];
							const statusCol = headers.find((h) => /^status$/i.test(h));
							const currentStatus = statusCol ? (loadObj[statusCol] || "").toLowerCase() : "";

							// Guard: only auto-update if status is a valid predecessor
							const canUpdate =
								(geofenceTriggered === "At Shipper" && /^(dispatched|assigned)$/i.test(currentStatus)) ||
								(geofenceTriggered === "At Receiver" && /^(in transit)$/i.test(currentStatus));

							if (canUpdate && statusCol) {
								// Update status in sheet
								const statusColIdx = headers.indexOf(statusCol);
								const colLetter = String.fromCharCode(65 + (statusColIdx % 26));
								await sheets.spreadsheets.values.update({
									spreadsheetId: SPREADSHEET_ID,
									range: `Job Tracking!${colLetter}${i + 1}`,
									valueInputOption: "USER_ENTERED",
									requestBody: { values: [[geofenceTriggered]] },
								});

								// Log to Status Logs
								const now = new Date();
								const logId = `LOG-${now.getTime()}`;
								const dateTime = `${(now.getMonth() + 1).toString().padStart(2, "0")}/${now.getDate().toString().padStart(2, "0")}/${now.getFullYear()} ${now.getHours()}:${now.getMinutes().toString().padStart(2, "0")}:${now.getSeconds().toString().padStart(2, "0")}`;
								await sheets.spreadsheets.values.append({
									spreadsheetId: SPREADSHEET_ID,
									range: "Status Logs",
									valueInputOption: "USER_ENTERED",
									requestBody: {
										values: [[logId, loadId, driverName, dateTime, geofenceTriggered, `Auto-triggered by geofence (was ${currentStatus})`]],
									},
								});
							}

							io.to(driverName.trim().toLowerCase()).emit("geofence-trigger", {
								loadId,
								status: geofenceTriggered,
							});
							io.to("dispatch").emit("geofence-trigger", {
								loadId,
								driver: driverName,
								status: geofenceTriggered,
							});
						}
						break;
					}
				}
			} catch (geoErr) {
				console.error("Geofence check error:", geoErr.message);
			}
		}

		res.json({ success: true, geofenceTriggered });
	} catch (error) {
		console.error("Error storing location:", error.message);
		res.status(500).json({ error: error.message });
	}
});

// GET /api/locations/latest — Latest position per active driver with ETA
app.get("/api/locations/latest", requireRole("Admin", "Dispatcher"), async (req, res) => {
	try {
		const locations = db.prepare(
			`SELECT dl.driver, dl.latitude, dl.longitude, dl.speed, dl.heading, dl.timestamp, dl.load_id AS loadId
			 FROM driver_locations dl
			 INNER JOIN (SELECT driver, MAX(id) AS max_id FROM driver_locations GROUP BY driver) latest
			 ON dl.id = latest.max_id
			 WHERE dl.timestamp > datetime('now', '-1 hour')`
		).all();

		// Enrich with ETA data from sheet
		try {
			const sheets = await getSheets();
			const headerResp = await sheets.spreadsheets.values.get({
				spreadsheetId: SPREADSHEET_ID,
				range: "Job Tracking!1:1",
			});
			const headers = (headerResp.data.values || [[]])[0];
			const dataResp = await sheets.spreadsheets.values.get({
				spreadsheetId: SPREADSHEET_ID,
				range: "Job Tracking",
			});
			const rows = dataResp.data.values || [];

			const loadIdCol = headers.find((h) => /load.?id|job.?id/i.test(h));
			const destLatCol = headers.find((h) => /dest.*lat|drop.*lat|receiver.*lat|delivery.*lat/i.test(h));
			const destLngCol = headers.find((h) => /dest.*l(on|ng)|drop.*l(on|ng)|receiver.*l(on|ng)|delivery.*l(on|ng)/i.test(h));
			const deliveryTimeCol = headers.find((h) => /delivery.*time|drop.*time|delivery.*date|drop.*date/i.test(h));

			if (loadIdCol) {
				// Build load lookup
				const loadMap = {};
				for (let i = 1; i < rows.length; i++) {
					const obj = {};
					headers.forEach((h, idx) => { obj[h] = rows[i][idx] || ""; });
					const lid = obj[loadIdCol];
					if (lid) loadMap[lid] = obj;
				}

				const DEFAULT_SPEED_MPS = 24.587; // ~55 mph in m/s

				for (const loc of locations) {
					loc.etaStatus = "unknown";
					loc.etaMinutes = null;
					if (!loc.loadId || !loadMap[loc.loadId]) continue;
					const load = loadMap[loc.loadId];

					if (destLatCol && destLngCol) {
						const dLat = parseFloat(load[destLatCol]);
						const dLng = parseFloat(load[destLngCol]);
						if (!isNaN(dLat) && !isNaN(dLng)) {
							const distMeters = geolib.getDistance(
								{ latitude: loc.latitude, longitude: loc.longitude },
								{ latitude: dLat, longitude: dLng }
							);
							const speed = loc.speed > 1 ? loc.speed : DEFAULT_SPEED_MPS;
							const etaSeconds = distMeters / speed;
							loc.etaMinutes = Math.round(etaSeconds / 60);

							// Compare against scheduled delivery time
							if (deliveryTimeCol && load[deliveryTimeCol]) {
								try {
									const scheduled = new Date(load[deliveryTimeCol]);
									if (!isNaN(scheduled)) {
										const arrival = new Date(Date.now() + etaSeconds * 1000);
										loc.etaStatus = arrival <= scheduled ? "on-time" : "delayed";
									}
								} catch { /* ignore parse error */ }
							}
						}
					}
				}
			}
		} catch (etaErr) {
			console.error("ETA enrichment error:", etaErr.message);
			// Still return locations without ETA
		}

		res.json({ locations });
	} catch (error) {
		console.error("Error fetching locations:", error.message);
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
// EXPENSE & MAINTENANCE TRACKING
// ============================================================

// GET /api/expenses/fuel-analytics — Fuel cost analytics + compliance
app.get("/api/expenses/fuel-analytics", requireRole("Admin", "Dispatcher"), (req, res) => {
	try {
		const config = {};
		db.prepare("SELECT key, value FROM investor_config").all()
			.forEach((r) => (config[r.key] = r.value));
		const savingsTarget = parseFloat(config.fuel_savings_target_pct) || 15;

		// All fuel expenses
		const fuelExpenses = db.prepare(
			`SELECT * FROM expenses WHERE LOWER(type) = 'fuel' ORDER BY date DESC`
		).all();

		const totalFuelSpend = fuelExpenses.reduce((s, e) => s + (e.amount || 0), 0);
		const totalGallons = fuelExpenses.reduce((s, e) => s + (e.gallons || 0), 0);
		const avgCostPerGallon = totalGallons > 0 ? totalFuelSpend / totalGallons : 0;

		// Odometer-based cost per mile
		const withOdometer = fuelExpenses.filter((e) => e.odometer > 0);
		let costPerMile = 0;
		if (withOdometer.length >= 2) {
			const sorted = [...withOdometer].sort((a, b) => a.odometer - b.odometer);
			const totalMiles = sorted[sorted.length - 1].odometer - sorted[0].odometer;
			const milesSpend = sorted.reduce((s, e) => s + (e.amount || 0), 0);
			costPerMile = totalMiles > 0 ? milesSpend / totalMiles : 0;
		}

		// Monthly breakdown
		const monthly = {};
		fuelExpenses.forEach((e) => {
			const month = (e.date || "").substring(0, 7);
			if (!month) return;
			if (!monthly[month]) monthly[month] = { spend: 0, gallons: 0, count: 0 };
			monthly[month].spend += e.amount || 0;
			monthly[month].gallons += e.gallons || 0;
			monthly[month].count++;
		});
		const monthlyData = Object.entries(monthly)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([month, d]) => ({
				month,
				spend: Math.round(d.spend),
				gallons: Math.round(d.gallons * 10) / 10,
				avgPerGallon: d.gallons > 0 ? Math.round((d.spend / d.gallons) * 100) / 100 : 0,
			}));

		// Per-driver breakdown
		const byDriver = {};
		fuelExpenses.forEach((e) => {
			if (!byDriver[e.driver]) byDriver[e.driver] = { spend: 0, gallons: 0 };
			byDriver[e.driver].spend += e.amount || 0;
			byDriver[e.driver].gallons += e.gallons || 0;
		});

		// National avg diesel ~$3.80/gal as baseline
		const nationalAvg = 3.80;
		const actualAvg = avgCostPerGallon || nationalAvg;
		const savingsVsNational = nationalAvg > 0
			? Math.round(((nationalAvg - actualAvg) / nationalAvg) * 10000) / 100
			: 0;

		res.json({
			totalFuelSpend: Math.round(totalFuelSpend),
			totalGallons: Math.round(totalGallons * 10) / 10,
			avgCostPerGallon: Math.round(avgCostPerGallon * 100) / 100,
			costPerMile: Math.round(costPerMile * 100) / 100,
			savingsTarget,
			savingsVsNational,
			onTarget: savingsVsNational >= savingsTarget,
			monthlyData,
			byDriver,
			recentFills: fuelExpenses.slice(0, 20).map((e) => ({
				id: e.id, driver: e.driver, amount: e.amount,
				gallons: e.gallons, odometer: e.odometer,
				date: e.date, loadId: e.load_id,
			})),
		});
	} catch (error) {
		console.error("Error fetching fuel analytics:", error.message);
		res.status(500).json({ error: error.message });
	}
});

// GET /api/maintenance-fund — Fund balance, contributions, and service history
app.get("/api/maintenance-fund", requireRole("Admin", "Dispatcher"), (req, res) => {
	try {
		const config = {};
		db.prepare("SELECT key, value FROM investor_config").all()
			.forEach((r) => (config[r.key] = r.value));
		const monthlyTarget = parseFloat(config.maintenance_fund_monthly) || 800;

		const entries = db.prepare(
			`SELECT * FROM maintenance_fund ORDER BY date DESC`
		).all();

		const contributions = entries.filter((e) => e.type === "contribution");
		const services = entries.filter((e) => e.type === "service");

		const totalContributed = contributions.reduce((s, e) => s + e.amount, 0);
		const totalSpent = services.reduce((s, e) => s + e.amount, 0);
		const balance = totalContributed - totalSpent;

		// Monthly contribution tracking
		const monthlyContribs = {};
		contributions.forEach((e) => {
			const month = (e.date || "").substring(0, 7);
			if (!month) return;
			monthlyContribs[month] = (monthlyContribs[month] || 0) + e.amount;
		});

		// How many months have met target
		const monthsMet = Object.values(monthlyContribs).filter((v) => v >= monthlyTarget).length;
		const totalMonths = Object.keys(monthlyContribs).length || 1;

		res.json({
			monthlyTarget,
			balance: Math.round(balance),
			totalContributed: Math.round(totalContributed),
			totalSpent: Math.round(totalSpent),
			complianceRate: Math.round((monthsMet / totalMonths) * 100),
			entries: entries.map((e) => ({
				id: e.id, type: e.type, amount: e.amount,
				description: e.description, truck: e.truck,
				date: e.date,
			})),
		});
	} catch (error) {
		console.error("Error fetching maintenance fund:", error.message);
		res.status(500).json({ error: error.message });
	}
});

// POST /api/maintenance-fund — Add contribution or service entry
app.post("/api/maintenance-fund", requireRole("Admin", "Dispatcher"), (req, res) => {
	try {
		const { type, amount, description, truck, date } = req.body;
		if (!type || !amount || !date) {
			return res.status(400).json({ error: "type, amount, and date required" });
		}
		if (!["contribution", "service"].includes(type)) {
			return res.status(400).json({ error: "type must be 'contribution' or 'service'" });
		}

		const result = db.prepare(
			`INSERT INTO maintenance_fund (type, amount, description, truck, date) VALUES (?, ?, ?, ?, ?)`
		).run(type, parseFloat(amount), description || "", truck || "", date);

		res.json({ success: true, id: result.lastInsertRowid });
	} catch (error) {
		console.error("Error adding maintenance fund entry:", error.message);
		res.status(500).json({ error: error.message });
	}
});

// GET /api/compliance/fees — Track 2290, Registration, IFTA fees
app.get("/api/compliance/fees", requireRole("Admin", "Dispatcher"), (req, res) => {
	try {
		const fees = db.prepare(
			`SELECT * FROM compliance_fees ORDER BY due_date DESC`
		).all();

		const totalDue = fees.filter((f) => f.status === "Pending").reduce((s, f) => s + f.amount, 0);
		const totalPaid = fees.filter((f) => f.status === "Paid").reduce((s, f) => s + f.amount, 0);

		res.json({
			fees: fees.map((f) => ({
				id: f.id, type: f.type, amount: f.amount,
				description: f.description, truck: f.truck,
				dueDate: f.due_date, paidDate: f.paid_date,
				status: f.status,
			})),
			totalDue: Math.round(totalDue),
			totalPaid: Math.round(totalPaid),
		});
	} catch (error) {
		console.error("Error fetching compliance fees:", error.message);
		res.status(500).json({ error: error.message });
	}
});

// POST /api/compliance/fees — Add a compliance fee
app.post("/api/compliance/fees", requireRole("Admin", "Dispatcher"), (req, res) => {
	try {
		const { type, amount, description, truck, dueDate, paidDate, status } = req.body;
		if (!type || !amount || !dueDate) {
			return res.status(400).json({ error: "type, amount, and dueDate required" });
		}

		const result = db.prepare(
			`INSERT INTO compliance_fees (type, amount, description, truck, due_date, paid_date, status)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`
		).run(type, parseFloat(amount), description || "", truck || "",
			dueDate, paidDate || "", status || "Pending");

		res.json({ success: true, id: result.lastInsertRowid });
	} catch (error) {
		console.error("Error adding compliance fee:", error.message);
		res.status(500).json({ error: error.message });
	}
});

// PUT /api/compliance/fees/:id — Mark fee as paid
app.put("/api/compliance/fees/:id", requireRole("Admin", "Dispatcher"), (req, res) => {
	try {
		const { paidDate } = req.body;
		db.prepare(
			`UPDATE compliance_fees SET status = 'Paid', paid_date = ? WHERE id = ?`
		).run(paidDate || new Date().toISOString().split("T")[0], req.params.id);

		res.json({ success: true });
	} catch (error) {
		console.error("Error updating compliance fee:", error.message);
		res.status(500).json({ error: error.message });
	}
});

// GET /api/compliance/ifta — Calculate miles per state from GPS data
app.get("/api/compliance/ifta", requireRole("Admin", "Dispatcher"), (req, res) => {
	try {
		const { start, end } = req.query;
		const startDate = start || new Date(new Date().getFullYear(), new Date().getMonth() - 2, 1).toISOString();
		const endDate = end || new Date().toISOString();

		// Get all location points in the date range, ordered by driver and timestamp
		const locations = db.prepare(
			`SELECT driver, latitude, longitude, speed, timestamp, load_id
			 FROM driver_locations
			 WHERE timestamp >= ? AND timestamp <= ?
			 ORDER BY driver, timestamp ASC`
		).all(startDate, endDate);

		// Group by driver
		const byDriver = {};
		locations.forEach((loc) => {
			if (!byDriver[loc.driver]) byDriver[loc.driver] = [];
			byDriver[loc.driver].push(loc);
		});

		// Calculate miles per state per driver
		const stateMileage = {};
		let totalMiles = 0;

		for (const [driver, points] of Object.entries(byDriver)) {
			for (let i = 1; i < points.length; i++) {
				const prev = points[i - 1];
				const curr = points[i];

				// Skip if points are too far apart in time (>30 min = likely separate trips)
				const timeDiff = new Date(curr.timestamp) - new Date(prev.timestamp);
				if (timeDiff > 30 * 60 * 1000) continue;

				const distMeters = geolib.getDistance(
					{ latitude: prev.latitude, longitude: prev.longitude },
					{ latitude: curr.latitude, longitude: curr.longitude }
				);
				const miles = distMeters * 0.000621371;

				// Skip unreasonable distances (GPS drift)
				if (miles > 50) continue;

				// Determine state from midpoint
				const midLat = (prev.latitude + curr.latitude) / 2;
				const midLng = (prev.longitude + curr.longitude) / 2;
				const state = getStateFromCoords(midLat, midLng);

				if (!stateMileage[state]) stateMileage[state] = { miles: 0, drivers: new Set() };
				stateMileage[state].miles += miles;
				stateMileage[state].drivers.add(driver);
				totalMiles += miles;
			}
		}

		const stateData = Object.entries(stateMileage)
			.map(([state, d]) => ({
				state,
				miles: Math.round(d.miles),
				pct: totalMiles > 0 ? Math.round((d.miles / totalMiles) * 100) : 0,
				drivers: [...d.drivers],
			}))
			.sort((a, b) => b.miles - a.miles);

		res.json({
			totalMiles: Math.round(totalMiles),
			startDate,
			endDate,
			states: stateData,
			driverCount: Object.keys(byDriver).length,
		});
	} catch (error) {
		console.error("Error calculating IFTA mileage:", error.message);
		res.status(500).json({ error: error.message });
	}
});

// Simple lat/lng to US state lookup using bounding boxes
function getStateFromCoords(lat, lng) {
	// Simplified state boundaries (approximate bounding boxes, checked in order of likely usage)
	const states = [
		{ name: "TX", minLat: 25.84, maxLat: 36.5, minLng: -106.65, maxLng: -93.51 },
		{ name: "OK", minLat: 33.62, maxLat: 37.0, minLng: -103.0, maxLng: -94.43 },
		{ name: "LA", minLat: 28.93, maxLat: 33.02, minLng: -94.04, maxLng: -88.82 },
		{ name: "AR", minLat: 33.0, maxLat: 36.5, minLng: -94.62, maxLng: -89.64 },
		{ name: "NM", minLat: 31.33, maxLat: 37.0, minLng: -109.05, maxLng: -103.0 },
		{ name: "MS", minLat: 30.17, maxLat: 35.0, minLng: -91.66, maxLng: -88.1 },
		{ name: "AL", minLat: 30.22, maxLat: 35.01, minLng: -88.47, maxLng: -84.89 },
		{ name: "TN", minLat: 34.98, maxLat: 36.68, minLng: -90.31, maxLng: -81.65 },
		{ name: "GA", minLat: 30.36, maxLat: 35.0, minLng: -85.61, maxLng: -80.84 },
		{ name: "FL", minLat: 24.52, maxLat: 31.0, minLng: -87.63, maxLng: -80.03 },
		{ name: "MO", minLat: 35.99, maxLat: 40.61, minLng: -95.77, maxLng: -89.1 },
		{ name: "KS", minLat: 36.99, maxLat: 40.0, minLng: -102.05, maxLng: -94.59 },
		{ name: "CO", minLat: 36.99, maxLat: 41.0, minLng: -109.05, maxLng: -102.04 },
		{ name: "AZ", minLat: 31.33, maxLat: 37.0, minLng: -114.82, maxLng: -109.04 },
		{ name: "CA", minLat: 32.53, maxLat: 42.01, minLng: -124.41, maxLng: -114.13 },
		{ name: "NV", minLat: 35.0, maxLat: 42.0, minLng: -120.01, maxLng: -114.04 },
		{ name: "IL", minLat: 36.97, maxLat: 42.51, minLng: -91.51, maxLng: -87.02 },
		{ name: "IN", minLat: 37.77, maxLat: 41.76, minLng: -88.1, maxLng: -84.78 },
		{ name: "OH", minLat: 38.4, maxLat: 42.33, minLng: -84.82, maxLng: -80.52 },
		{ name: "PA", minLat: 39.72, maxLat: 42.27, minLng: -80.52, maxLng: -74.69 },
		{ name: "NY", minLat: 40.5, maxLat: 45.01, minLng: -79.76, maxLng: -71.86 },
		{ name: "NC", minLat: 33.84, maxLat: 36.59, minLng: -84.32, maxLng: -75.46 },
		{ name: "SC", minLat: 32.03, maxLat: 35.22, minLng: -83.35, maxLng: -78.54 },
		{ name: "VA", minLat: 36.54, maxLat: 39.47, minLng: -83.68, maxLng: -75.24 },
	];
	for (const s of states) {
		if (lat >= s.minLat && lat <= s.maxLat && lng >= s.minLng && lng <= s.maxLng) {
			return s.name;
		}
	}
	return "Other";
}

// ============================================================
// SPA Catch-All — Serve Vue app for all non-API routes
// ============================================================
app.get("*", (req, res) => {
	const spaIndex = path.join(clientDistPath, "index.html");
	if (fs.existsSync(spaIndex)) {
		res.sendFile(spaIndex);
	} else {
		res.sendFile(path.join(publicPath, "index.html"));
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
