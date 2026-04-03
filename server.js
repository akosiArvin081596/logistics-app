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
const PDFDocument = require("pdfkit");
const compression = require("compression");

// Convert 0-based column index to spreadsheet letter (0=A, 25=Z, 26=AA, etc.)
function colLetter(idx) {
	let result = "";
	let n = idx;
	while (n >= 0) {
		result = String.fromCharCode(65 + (n % 26)) + result;
		n = Math.floor(n / 26) - 1;
	}
	return result;
}

const app = express();
app.disable('etag');
const server = http.createServer(app);
const io = new Server(server);
app.use(compression());
app.use(express.json({ limit: "20mb" }));
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

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
	CREATE TABLE IF NOT EXISTS notifications (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		driver_name TEXT NOT NULL,
		type TEXT NOT NULL,
		title TEXT NOT NULL,
		body TEXT DEFAULT '',
		metadata TEXT DEFAULT '{}',
		read INTEGER DEFAULT 0,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP
	)
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_notifications_driver ON notifications(driver_name)`);

const insertNotification = db.prepare(
	`INSERT INTO notifications (driver_name, type, title, body, metadata) VALUES (?, ?, ?, ?, ?)`
);

db.exec(`
	CREATE TABLE IF NOT EXISTS dispatch_notifications (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		type TEXT NOT NULL,
		title TEXT NOT NULL,
		body TEXT DEFAULT '',
		metadata TEXT DEFAULT '{}',
		read INTEGER DEFAULT 0,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP
	)
`);

const insertDispatchNotification = db.prepare(
	`INSERT INTO dispatch_notifications (type, title, body, metadata) VALUES (?, ?, ?, ?)`
);

db.exec(`
	CREATE TABLE IF NOT EXISTS load_responses (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		load_id TEXT NOT NULL,
		row_index INTEGER NOT NULL,
		driver_name TEXT NOT NULL,
		response TEXT NOT NULL CHECK(response IN ('accepted', 'declined')),
		responded_at DATETIME DEFAULT CURRENT_TIMESTAMP
	)
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_load_responses_driver ON load_responses(driver_name)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_load_responses_load ON load_responses(load_id, driver_name)`);

const insertLoadResponse = db.prepare(
	`INSERT INTO load_responses (load_id, row_index, driver_name, response) VALUES (?, ?, ?, ?)`
);

db.exec(`
	CREATE TABLE IF NOT EXISTS users (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		username TEXT NOT NULL UNIQUE,
		password_hash TEXT NOT NULL,
		role TEXT NOT NULL CHECK(role IN ('Super Admin', 'Dispatcher', 'Driver', 'Investor')),
		driver_name TEXT DEFAULT '',
		email TEXT DEFAULT '',
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP
	)
`);

// Migrate: rebuild users table if CHECK constraint is outdated
try {
	db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('__test_sa__', '__test__', 'Super Admin')").run();
	db.prepare("DELETE FROM users WHERE username = '__test_sa__'").run();
} catch {
	db.exec(`
		ALTER TABLE users RENAME TO users_old;
		CREATE TABLE users (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			username TEXT NOT NULL UNIQUE,
			password_hash TEXT NOT NULL,
			role TEXT NOT NULL CHECK(role IN ('Super Admin', 'Dispatcher', 'Driver', 'Investor')),
			driver_name TEXT DEFAULT '',
			email TEXT DEFAULT '',
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		);
		INSERT INTO users SELECT id, username, password_hash,
			CASE role WHEN 'Admin' THEN 'Super Admin' ELSE role END,
			driver_name, email, created_at FROM users_old;
		DROP TABLE users_old;
	`);
	// Clear sessions so users re-login with updated roles
	try { db.exec("DELETE FROM sessions"); } catch {}
}

// Migrate: add full_name column if not present
try {
	db.exec("ALTER TABLE users ADD COLUMN full_name TEXT NOT NULL DEFAULT ''");
} catch { /* column already exists */ }
try {
	db.exec("ALTER TABLE users ADD COLUMN company_name TEXT NOT NULL DEFAULT ''");
} catch { /* column already exists */ }

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
	CREATE TABLE IF NOT EXISTS trucks (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		unit_number TEXT NOT NULL UNIQUE,
		make TEXT DEFAULT '',
		model TEXT DEFAULT '',
		year INTEGER DEFAULT 0,
		vin TEXT DEFAULT '',
		license_plate TEXT DEFAULT '',
		status TEXT NOT NULL DEFAULT 'Active' CHECK(status IN ('Active','Inactive','Maintenance')),
		assigned_driver TEXT DEFAULT '',
		notes TEXT DEFAULT '',
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP
	)
`);

// Migration: trucks table — add owner_id, photo, fixed costs, OOS status (rename-recreate if needed)
try { db.prepare("SELECT owner_id FROM trucks LIMIT 1").get(); }
catch { db.exec(`ALTER TABLE trucks ADD COLUMN owner_id INTEGER DEFAULT 0`); }

try { db.prepare("SELECT photo FROM trucks LIMIT 1").get(); }
catch {
	// Full recreate to add new columns AND update CHECK constraint to include OOS
	db.exec(`
		BEGIN TRANSACTION;
		CREATE TABLE trucks_new (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			unit_number TEXT NOT NULL UNIQUE,
			make TEXT DEFAULT '',
			model TEXT DEFAULT '',
			year INTEGER DEFAULT 0,
			vin TEXT DEFAULT '',
			license_plate TEXT DEFAULT '',
			status TEXT NOT NULL DEFAULT 'Active' CHECK(status IN ('Active','Inactive','Maintenance','OOS')),
			assigned_driver TEXT DEFAULT '',
			notes TEXT DEFAULT '',
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			owner_id INTEGER DEFAULT 0,
			photo TEXT DEFAULT '',
			insurance_monthly REAL DEFAULT 0,
			eld_monthly REAL DEFAULT 0,
			hvut_annual REAL DEFAULT 0,
			irp_annual REAL DEFAULT 0,
			admin_fee_pct REAL DEFAULT 50
		);
		INSERT INTO trucks_new (id, unit_number, make, model, year, vin, license_plate, status, assigned_driver, notes, created_at, owner_id)
			SELECT id, unit_number, make, model, year, vin, license_plate, status, assigned_driver, notes, created_at, owner_id FROM trucks;
		DROP TABLE trucks;
		ALTER TABLE trucks_new RENAME TO trucks;
		COMMIT;
	`);
}

// Migration: add driver_pay_daily to trucks
try { db.exec("ALTER TABLE trucks ADD COLUMN driver_pay_daily REAL DEFAULT 0"); } catch {}

// Migration: add per-truck business config columns
try { db.exec("ALTER TABLE trucks ADD COLUMN purchase_price REAL DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE trucks ADD COLUMN title_status TEXT DEFAULT 'Clean'"); } catch {}
// Note: maintenance_fund_monthly already added via rename-recreate if needed;
// safe ALTER in case column doesn't exist yet on this instance
try { db.prepare("SELECT maintenance_fund_monthly FROM trucks LIMIT 1").get(); }
catch { try { db.exec("ALTER TABLE trucks ADD COLUMN maintenance_fund_monthly REAL DEFAULT 0"); } catch {} }

// Migration: add asset_ref to messages (for "Share Asset" in chat)
try { db.exec("ALTER TABLE messages ADD COLUMN asset_ref TEXT DEFAULT ''"); } catch {}

// Legal documents table (per-truck legal files)
db.exec(`
	CREATE TABLE IF NOT EXISTS legal_documents (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		truck_id INTEGER NOT NULL,
		unit_number TEXT NOT NULL,
		doc_type TEXT NOT NULL DEFAULT 'Other',
		file_name TEXT NOT NULL,
		file_url TEXT DEFAULT '',
		notes TEXT DEFAULT '',
		uploaded_by TEXT DEFAULT '',
		uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
	)
`);

// Migration: messages attachment columns
try { db.prepare("SELECT attachment_url FROM messages LIMIT 1").get(); }
catch {
	db.exec(`ALTER TABLE messages ADD COLUMN attachment_url TEXT DEFAULT ''`);
	db.exec(`ALTER TABLE messages ADD COLUMN attachment_type TEXT DEFAULT ''`);
}

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

// Migrate: add ocr_text column to documents table
try {
	db.prepare("SELECT ocr_text FROM documents LIMIT 1").get();
} catch {
	db.exec(`ALTER TABLE documents ADD COLUMN ocr_text TEXT DEFAULT ''`);
}

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
db.exec(`CREATE INDEX IF NOT EXISTS idx_locations_load_id ON driver_locations(load_id)`);

db.exec(`
	CREATE TABLE IF NOT EXISTS investor_config (
		key TEXT PRIMARY KEY,
		value TEXT NOT NULL
	)
`);
// Migration: add owner_id to investor_config (composite key)
try { db.prepare("SELECT owner_id FROM investor_config LIMIT 1").get(); }
catch {
	db.exec(`
		ALTER TABLE investor_config RENAME TO investor_config_old;
		CREATE TABLE investor_config (
			owner_id INTEGER DEFAULT 0,
			key TEXT NOT NULL,
			value TEXT NOT NULL,
			PRIMARY KEY(owner_id, key)
		);
		INSERT INTO investor_config (owner_id, key, value) SELECT 0, key, value FROM investor_config_old;
		DROP TABLE investor_config_old;
	`);
}
// Seed default investor config if empty
const configCount = db.prepare("SELECT COUNT(*) AS cnt FROM investor_config WHERE owner_id = 0").get().cnt;
if (configCount === 0) {
	const defaults = db.prepare("INSERT OR IGNORE INTO investor_config (owner_id, key, value) VALUES (0, ?, ?)");
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
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || "";

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
// Auto-sync Driver users ↔ Carrier Database Google Sheet
// ============================================================
async function syncDriverToCarrierSheet(driverName, opts = {}) {
	const { oldName, email, companyName, action } = opts;
	try {
		const sheets = await getSheets();
		const resp = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: "Carrier Database" });
		const rows = resp.data.values || [];
		if (rows.length === 0) return;
		const headers = rows[0];
		const driverIdx = headers.findIndex(h => /driver/i.test(h));
		const carrierIdx = headers.findIndex(h => /carrier/i.test(h));
		const emailIdx = headers.findIndex(h => /email/i.test(h));
		const trucksIdx = headers.findIndex(h => /truck/i.test(h));
		const di = driverIdx !== -1 ? driverIdx : 0;

		// Find existing row by name
		const searchName = (oldName || driverName || "").trim().toLowerCase();
		let foundRow = -1;
		for (let i = 1; i < rows.length; i++) {
			if ((rows[i][di] || "").trim().toLowerCase() === searchName) { foundRow = i; break; }
		}

		// Get assigned truck unit number
		const truck = driverName ? db.prepare("SELECT unit_number FROM trucks WHERE LOWER(assigned_driver) = LOWER(?)").get(driverName.trim()) : null;
		const truckUnit = truck ? truck.unit_number : "";

		if (action === "add") {
			if (foundRow !== -1) return; // already exists
			const newRow = new Array(headers.length).fill("");
			if (di !== -1) newRow[di] = driverName;
			if (carrierIdx !== -1) newRow[carrierIdx] = companyName || "";
			if (emailIdx !== -1) newRow[emailIdx] = email || "";
			if (trucksIdx !== -1) newRow[trucksIdx] = truckUnit;
			await sheets.spreadsheets.values.append({
				spreadsheetId: SPREADSHEET_ID, range: "Carrier Database",
				valueInputOption: "USER_ENTERED", requestBody: { values: [newRow] },
			});
		} else if (action === "update") {
			if (foundRow === -1) {
				// Row doesn't exist yet — add it
				return syncDriverToCarrierSheet(driverName, { ...opts, action: "add" });
			}
			const row = rows[foundRow];
			// Preserve existing values, only update fields we manage
			if (di !== -1) row[di] = driverName;
			if (carrierIdx !== -1 && companyName !== undefined) row[carrierIdx] = companyName;
			if (emailIdx !== -1 && email !== undefined) row[emailIdx] = email;
			if (trucksIdx !== -1) row[trucksIdx] = truckUnit;
			await sheets.spreadsheets.values.update({
				spreadsheetId: SPREADSHEET_ID, range: `Carrier Database!A${foundRow + 1}`,
				valueInputOption: "USER_ENTERED", requestBody: { values: [row] },
			});
		} else if (action === "delete") {
			if (foundRow === -1) return; // nothing to delete
			const sheetId = await getSheetId(sheets, "Carrier Database");
			await sheets.spreadsheets.batchUpdate({
				spreadsheetId: SPREADSHEET_ID,
				requestBody: { requests: [{ deleteDimension: { range: { sheetId, dimension: "ROWS", startIndex: foundRow, endIndex: foundRow + 1 } } }] },
			});
		}
	} catch (err) {
		console.error("syncDriverToCarrierSheet error:", err.message);
	}
}

// ============================================================
// AUTH — Session-based authentication with roles (SQLite)
// ============================================================
// Roles: Super Admin (full access), Admin (dispatch, no broker/financial), Driver (own data only, no rate/revenue), Investor (financial view)

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
			"INSERT INTO users (username, password_hash, role, driver_name, email) VALUES (?, ?, 'Super Admin', '', ?)",
		).run(username, hash, email || "");

		const newUser = db.prepare("SELECT id FROM users WHERE LOWER(username) = LOWER(?)").get(username);
		req.session.user = {
			id: newUser ? newUser.id : 0,
			username,
			role: "Super Admin",
			driverName: "",
			email: email || "",
			fullName: "",
			companyName: "",
		};

		res.json({ success: true, role: "Super Admin" });
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
			id: user.id,
			username: user.username,
			role: user.role,
			driverName: user.driver_name || "",
			email: user.email || "",
			fullName: user.full_name || "",
			companyName: user.company_name || "",
		};

		res.json({
			success: true,
			user: {
				id: user.id,
				username: user.username,
				role: user.role,
				driverName: user.driver_name || "",
				companyName: user.company_name || "",
				fullName: user.full_name || "",
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
app.post("/api/users", requireRole("Super Admin"), async (req, res) => {
	try {
		const { username, password, role, driverName, email, fullName, companyName } = req.body;
		if (!username || !password || !role) {
			return res.status(400).json({ error: "Username, password, and role required" });
		}
		if (!["Super Admin", "Dispatcher", "Driver", "Investor"].includes(role)) {
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
			"INSERT INTO users (username, password_hash, role, driver_name, email, full_name, company_name) VALUES (?, ?, ?, ?, ?, ?, ?)",
		).run(username, hash, role, driverName || "", email || "", fullName || "", companyName || "");

		// Auto-sync driver to Carrier Database sheet
		if (role === "Driver" && driverName) {
			syncDriverToCarrierSheet(driverName, { email, companyName, action: "add" });
		}

		res.json({ success: true });
	} catch (error) {
		console.error("Error creating user:", error.message);
		res.status(500).json({ error: error.message });
	}
});

// Admin: list all users (without password hashes)
app.get("/api/users", requireRole("Super Admin"), (req, res) => {
	const users = db
		.prepare("SELECT id, username, role, driver_name, email, full_name, company_name, created_at FROM users")
		.all()
		.map((u) => ({
			id: u.id,
			Username: u.username,
			Role: u.role,
			DriverName: u.driver_name,
			Email: u.email,
			FullName: u.full_name,
			CompanyName: u.company_name,
			CreatedAt: u.created_at,
		}));
	res.json({ users });
});

// Admin: delete a user
// Admin: update a user's role, driverName, or email
app.put("/api/users/:id", requireRole("Super Admin"), async (req, res) => {
	try {
		const id = parseInt(req.params.id);
		const { role, driverName, email, password, fullName, companyName } = req.body;

		const user = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
		if (!user) return res.status(404).json({ error: "User not found" });

		const updates = [];
		const params = [];

		if (role && ["Super Admin", "Dispatcher", "Driver", "Investor"].includes(role)) {
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
		if (fullName !== undefined) {
			updates.push("full_name = ?");
			params.push(fullName);
		}
		if (companyName !== undefined) {
			updates.push("company_name = ?");
			params.push(companyName);
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

		// Cascade driver name rename across all tables
		if (driverName !== undefined && driverName !== (user.driver_name || "")) {
			const oldName = (user.driver_name || "").trim().toLowerCase();
			const newName = driverName.trim();
			if (oldName && newName) {
				db.prepare("UPDATE expenses SET driver = ? WHERE LOWER(driver) = ?").run(newName, oldName);
				db.prepare(`UPDATE messages SET "from" = ? WHERE LOWER("from") = ?`).run(newName, oldName);
				db.prepare(`UPDATE messages SET "to" = ? WHERE LOWER("to") = ?`).run(newName, oldName);
				db.prepare("UPDATE notifications SET driver_name = ? WHERE LOWER(driver_name) = ?").run(newName, oldName);
				db.prepare("UPDATE driver_locations SET driver = ? WHERE LOWER(driver) = ?").run(newName, oldName);
				db.prepare("UPDATE load_responses SET driver_name = ? WHERE LOWER(driver_name) = ?").run(newName, oldName);
				db.prepare("UPDATE trucks SET assigned_driver = ? WHERE LOWER(assigned_driver) = ?").run(newName, oldName);
				db.prepare("UPDATE documents SET driver = ? WHERE LOWER(driver) = ?").run(newName, oldName);
			}
			// Sync renamed driver to Carrier Database sheet
			syncDriverToCarrierSheet(driverName, { oldName: user.driver_name, email: email !== undefined ? email : user.email, companyName: companyName !== undefined ? companyName : user.company_name, action: "update" });
		} else if (user.role === "Driver" && user.driver_name && (email !== undefined || companyName !== undefined)) {
			// Name didn't change but email/company did
			syncDriverToCarrierSheet(user.driver_name, { email: email !== undefined ? email : user.email, companyName: companyName !== undefined ? companyName : user.company_name, action: "update" });
		}

		res.json({ success: true });
	} catch (error) {
		console.error("Error updating user:", error.message);
		res.status(500).json({ error: error.message });
	}
});

// Download SQLite database file (Super Admin only)
app.get("/api/db/download", requireRole("Super Admin"), (req, res) => {
	// Backup to a temp file to capture WAL contents
	const fs = require("fs");
	const tmpPath = path.join(__dirname, "app_backup.db");
	db.backup(tmpPath).then(() => {
		res.download(tmpPath, "app.db", () => {
			try { fs.unlinkSync(tmpPath); } catch {}
		});
	}).catch((err) => {
		res.status(500).json({ error: err.message });
	});
});

// Database diagnosis — list tables and query any table (Super Admin only)
app.get("/api/db/tables", requireRole("Super Admin"), (req, res) => {
	const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
	const result = {};
	for (const { name } of tables) {
		const count = db.prepare(`SELECT COUNT(*) as count FROM "${name}"`).get();
		result[name] = count.count;
	}
	res.json({ tables: result });
});

app.get("/api/db/query/:table", requireRole("Super Admin"), (req, res) => {
	const table = req.params.table;
	// Validate table name exists to prevent injection
	const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
	if (!exists) return res.status(404).json({ error: "Table not found" });
	const limit = Math.min(parseInt(req.query.limit) || 100, 500);
	const offset = parseInt(req.query.offset) || 0;
	const rows = db.prepare(`SELECT * FROM "${table}" LIMIT ? OFFSET ?`).all(limit, offset);
	const count = db.prepare(`SELECT COUNT(*) as total FROM "${table}"`).get();
	res.json({ table, total: count.total, limit, offset, rows });
});

app.delete("/api/users/:id", requireRole("Super Admin"), (req, res) => {
	const id = parseInt(req.params.id);
	const user = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
	if (!user) return res.status(404).json({ error: "User not found" });
	const name = (user.driver_name || user.username || "").trim().toLowerCase();
	if (name) {
		db.prepare("DELETE FROM expenses WHERE LOWER(driver) = ?").run(name);
		db.prepare(`DELETE FROM messages WHERE LOWER("from") = ? OR LOWER("to") = ?`).run(name, name);
		db.prepare("DELETE FROM notifications WHERE LOWER(driver_name) = ?").run(name);
		db.prepare("DELETE FROM driver_locations WHERE LOWER(driver) = ?").run(name);
		db.prepare("DELETE FROM load_responses WHERE LOWER(driver_name) = ?").run(name);
		db.prepare("DELETE FROM documents WHERE LOWER(driver) = ?").run(name);
		db.prepare("UPDATE trucks SET assigned_driver = '' WHERE LOWER(assigned_driver) = ?").run(name);
	}
	if (user.role === "Investor") {
		db.prepare("UPDATE trucks SET owner_id = 0 WHERE owner_id = ?").run(id);
		db.prepare("DELETE FROM investor_config WHERE owner_id = ?").run(id);
	}
	// Sync: remove driver from Carrier Database sheet
	if (user.role === "Driver" && user.driver_name) {
		syncDriverToCarrierSheet(user.driver_name, { action: "delete" });
	}
	db.prepare("DELETE FROM users WHERE id = ?").run(id);
	res.json({ success: true });
});

// List investor users (for owner dropdown)
app.get("/api/users/investors", requireRole("Super Admin", "Dispatcher"), (req, res) => {
	const investors = db
		.prepare("SELECT id, username FROM users WHERE role = 'Investor' ORDER BY username ASC")
		.all();
	res.json({ investors });
});

// Truck Database: list all trucks (Investor sees only their own)
app.get("/api/trucks", requireRole("Super Admin", "Dispatcher", "Investor"), (req, res) => {
	const user = req.session.user;
	let rows;
	if (user.role === "Investor") {
		rows = db.prepare("SELECT * FROM trucks WHERE owner_id = ? ORDER BY unit_number ASC").all(user.id);
	} else {
		rows = db.prepare("SELECT * FROM trucks ORDER BY unit_number ASC").all();
	}
	const trucks = rows.map((t) => ({
		id: t.id,
		UnitNumber: t.unit_number,
		Make: t.make,
		Model: t.model,
		Year: t.year,
		VIN: t.vin,
		LicensePlate: t.license_plate,
		Status: t.status,
		AssignedDriver: t.assigned_driver,
		OwnerId: t.owner_id || 0,
		Notes: t.notes,
		CreatedAt: t.created_at,
		Photo: t.photo || '',
		InsuranceMonthly: t.insurance_monthly || 0,
		EldMonthly: t.eld_monthly || 0,
		HvutAnnual: t.hvut_annual || 0,
		IrpAnnual: t.irp_annual || 0,
		AdminFeePct: t.admin_fee_pct ?? 50,
		DriverPayDaily: t.driver_pay_daily || 0,
		PurchasePrice: t.purchase_price || 0,
		TitleStatus: t.title_status || 'Clean',
		MaintenanceFundMonthly: t.maintenance_fund_monthly || 0,
	}));
	res.json({ trucks });
});

// Truck Database: add a new truck
app.post("/api/trucks", requireRole("Super Admin"), (req, res) => {
	try {
		const { unitNumber, make, model, year, vin, licensePlate, status, assignedDriver, notes, ownerId, driverPayDaily, purchasePrice, titleStatus, maintenanceFundMonthly } = req.body;
		if (!unitNumber || !unitNumber.trim()) {
			return res.status(400).json({ error: "Unit number is required" });
		}
		const existing = db.prepare("SELECT id FROM trucks WHERE LOWER(unit_number) = LOWER(?)").get(unitNumber.trim());
		if (existing) {
			return res.status(400).json({ error: "Unit number already exists" });
		}
		const validStatus = ["Active", "Inactive", "Maintenance", "OOS"].includes(status) ? status : "Active";
		// 1:1 driver constraint — unassign driver from any other truck first
		if (assignedDriver && assignedDriver.trim()) {
			db.prepare("UPDATE trucks SET assigned_driver = '' WHERE LOWER(assigned_driver) = LOWER(?) AND unit_number != ?")
				.run(assignedDriver.trim(), unitNumber.trim());
		}
		const result = db.prepare(
			"INSERT INTO trucks (unit_number, make, model, year, vin, license_plate, status, assigned_driver, notes, owner_id, driver_pay_daily, purchase_price, title_status, maintenance_fund_monthly) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
		).run(unitNumber.trim(), make || "", model || "", parseInt(year) || 0, vin || "", licensePlate || "", validStatus, assignedDriver || "", notes || "", parseInt(ownerId) || 0, parseFloat(driverPayDaily) || 0, parseFloat(purchasePrice) || 0, titleStatus || "Clean", parseFloat(maintenanceFundMonthly) || 0);
		res.json({ success: true, id: result.lastInsertRowid });
	} catch (error) {
		console.error("Error creating truck:", error.message);
		res.status(500).json({ error: error.message });
	}
});

// Truck Database: update a truck
app.put("/api/trucks/:id", requireRole("Super Admin"), (req, res) => {
	try {
		const id = parseInt(req.params.id);
		const truck = db.prepare("SELECT * FROM trucks WHERE id = ?").get(id);
		if (!truck) return res.status(404).json({ error: "Truck not found" });

		const { unitNumber, make, model, year, vin, licensePlate, status, assignedDriver, notes, ownerId,
			photo, insuranceMonthly, eldMonthly, hvutAnnual, irpAnnual, adminFeePct, driverPayDaily,
			purchasePrice, titleStatus, maintenanceFundMonthly } = req.body;
		const updates = [];
		const params = [];

		if (unitNumber !== undefined) {
			const conflict = db.prepare("SELECT id FROM trucks WHERE LOWER(unit_number) = LOWER(?) AND id != ?").get(unitNumber.trim(), id);
			if (conflict) return res.status(400).json({ error: "Unit number already exists" });
			updates.push("unit_number = ?"); params.push(unitNumber.trim());
		}
		if (make !== undefined) { updates.push("make = ?"); params.push(make); }
		if (model !== undefined) { updates.push("model = ?"); params.push(model); }
		if (year !== undefined) { updates.push("year = ?"); params.push(parseInt(year) || 0); }
		if (vin !== undefined) { updates.push("vin = ?"); params.push(vin); }
		if (licensePlate !== undefined) { updates.push("license_plate = ?"); params.push(licensePlate); }
		if (status !== undefined && ["Active", "Inactive", "Maintenance", "OOS"].includes(status)) {
			updates.push("status = ?"); params.push(status);
		}
		if (assignedDriver !== undefined) {
			// 1:1 driver constraint — unassign from any other truck first
			if (assignedDriver && assignedDriver.trim()) {
				db.prepare("UPDATE trucks SET assigned_driver = '' WHERE LOWER(assigned_driver) = LOWER(?) AND id != ?")
					.run(assignedDriver.trim(), id);
			}
			updates.push("assigned_driver = ?"); params.push(assignedDriver);
		}
		if (ownerId !== undefined) { updates.push("owner_id = ?"); params.push(parseInt(ownerId) || 0); }
		if (notes !== undefined) { updates.push("notes = ?"); params.push(notes); }
		if (photo !== undefined) { updates.push("photo = ?"); params.push(photo); }
		if (insuranceMonthly !== undefined) { updates.push("insurance_monthly = ?"); params.push(parseFloat(insuranceMonthly) || 0); }
		if (eldMonthly !== undefined) { updates.push("eld_monthly = ?"); params.push(parseFloat(eldMonthly) || 0); }
		if (hvutAnnual !== undefined) { updates.push("hvut_annual = ?"); params.push(parseFloat(hvutAnnual) || 0); }
		if (irpAnnual !== undefined) { updates.push("irp_annual = ?"); params.push(parseFloat(irpAnnual) || 0); }
		if (adminFeePct !== undefined) { updates.push("admin_fee_pct = ?"); params.push(parseFloat(adminFeePct) ?? 50); }
		if (driverPayDaily !== undefined) { updates.push("driver_pay_daily = ?"); params.push(parseFloat(driverPayDaily) || 0); }
		if (purchasePrice !== undefined) { updates.push("purchase_price = ?"); params.push(parseFloat(purchasePrice) || 0); }
		if (titleStatus !== undefined) { updates.push("title_status = ?"); params.push(titleStatus || "Clean"); }
		if (maintenanceFundMonthly !== undefined) { updates.push("maintenance_fund_monthly = ?"); params.push(parseFloat(maintenanceFundMonthly) || 0); }

		if (updates.length === 0) return res.status(400).json({ error: "No valid fields to update" });
		params.push(id);
		db.prepare(`UPDATE trucks SET ${updates.join(", ")} WHERE id = ?`).run(...params);
		// Sync truck assignment to Carrier Database sheet
		if (assignedDriver !== undefined) {
			const oldDriver = truck.assigned_driver;
			if (assignedDriver && assignedDriver.trim()) {
				syncDriverToCarrierSheet(assignedDriver.trim(), { action: "update" });
			}
			if (oldDriver && oldDriver.trim() && oldDriver.trim().toLowerCase() !== (assignedDriver || "").trim().toLowerCase()) {
				syncDriverToCarrierSheet(oldDriver.trim(), { action: "update" });
			}
		}
		res.json({ success: true });
	} catch (error) {
		console.error("Error updating truck:", error.message);
		res.status(500).json({ error: error.message });
	}
});

// Truck Database: delete a truck
app.delete("/api/trucks/:id", requireRole("Super Admin"), (req, res) => {
	const id = parseInt(req.params.id);
	const truck = db.prepare("SELECT * FROM trucks WHERE id = ?").get(id);
	if (!truck) return res.status(404).json({ error: "Truck not found" });
	const unit = (truck.unit_number || "").trim().toLowerCase();
	if (unit) {
		db.prepare("DELETE FROM legal_documents WHERE truck_id = ?").run(id);
		db.prepare("DELETE FROM maintenance_fund WHERE LOWER(truck) = ?").run(unit);
		db.prepare("DELETE FROM compliance_fees WHERE LOWER(truck) = ?").run(unit);
	}
	db.prepare("DELETE FROM trucks WHERE id = ?").run(id);
	res.json({ success: true });
});

// Admin: bulk-rename a misspelled driver name in Job Tracking sheet
app.put("/api/admin/fix-driver-name", requireRole("Super Admin"), async (req, res) => {
	try {
		const { oldName, newName } = req.body;
		if (!oldName || !newName) return res.status(400).json({ error: "oldName and newName required" });

		const sheets = await getSheets();
		const resp = await sheets.spreadsheets.values.get({
			spreadsheetId: SPREADSHEET_ID,
			range: "Job Tracking",
		});
		const rows = resp.data.values || [];
		if (rows.length === 0) return res.json({ fixed: 0 });

		const headers = rows[0];
		const driverColIdx = headers.findIndex((h) => /driver/i.test(h));
		if (driverColIdx === -1) return res.status(400).json({ error: "Driver column not found" });

		const colLtr = String.fromCharCode(65 + driverColIdx);
		const updates = [];
		for (let i = 1; i < rows.length; i++) {
			if ((rows[i][driverColIdx] || "").trim().toLowerCase() === oldName.trim().toLowerCase()) {
				updates.push({
					range: `Job Tracking!${colLtr}${i + 1}`,
					values: [[newName.trim()]],
				});
			}
		}

		// Also fix Carrier Database sheet
		const carrierResp = await sheets.spreadsheets.values.get({
			spreadsheetId: SPREADSHEET_ID,
			range: "Carrier Database",
		});
		const carrierRows = carrierResp.data.values || [];
		if (carrierRows.length > 0) {
			const carrierHeaders = carrierRows[0];
			const carrierDriverIdx = carrierHeaders.findIndex((h) => /driver/i.test(h));
			if (carrierDriverIdx === -1 && carrierHeaders.length > 0) {
				// Fall back to first column if no driver header
			}
			const cIdx = carrierDriverIdx !== -1 ? carrierDriverIdx : 0;
			const cColLtr = String.fromCharCode(65 + cIdx);
			for (let i = 1; i < carrierRows.length; i++) {
				if ((carrierRows[i][cIdx] || "").trim().toLowerCase() === oldName.trim().toLowerCase()) {
					updates.push({
						range: `Carrier Database!${cColLtr}${i + 1}`,
						values: [[newName.trim()]],
					});
				}
			}
		}

		if (updates.length > 0) {
			await sheets.spreadsheets.values.batchUpdate({
				spreadsheetId: SPREADSHEET_ID,
				requestBody: { valueInputOption: "USER_ENTERED", data: updates },
			});
		}

		// Also fix SQLite tables
		const oldLower = oldName.trim().toLowerCase();
		const newLower = newName.trim().toLowerCase();
		const sqlFixes = {};
		sqlFixes.notifications = db.prepare("UPDATE notifications SET driver_name = ? WHERE driver_name = ?").run(newLower, oldLower).changes;
		sqlFixes.expenses = db.prepare("UPDATE expenses SET driver = ? WHERE LOWER(driver) = ?").run(newName.trim(), oldLower).changes;
		sqlFixes.load_responses = db.prepare("UPDATE load_responses SET driver_name = ? WHERE driver_name = ?").run(newLower, oldLower).changes;
		sqlFixes.messages_from = db.prepare("UPDATE messages SET \"from\" = ? WHERE LOWER(\"from\") = ?").run(newName.trim(), oldLower).changes;
		sqlFixes.messages_to = db.prepare("UPDATE messages SET \"to\" = ? WHERE LOWER(\"to\") = ?").run(newName.trim(), oldLower).changes;
		sqlFixes.users = db.prepare("UPDATE users SET driver_name = ? WHERE LOWER(driver_name) = ?").run(newName.trim(), oldLower).changes;
		sqlFixes.dispatch_notif_title = db.prepare("UPDATE dispatch_notifications SET title = REPLACE(title, ?, ?) WHERE title LIKE ?").run(oldName.trim(), newName.trim(), `%${oldName.trim()}%`).changes;
		sqlFixes.dispatch_notif_body = db.prepare("UPDATE dispatch_notifications SET body = REPLACE(body, ?, ?) WHERE body LIKE ?").run(oldName.trim(), newName.trim(), `%${oldName.trim()}%`).changes;

		res.json({ fixed: updates.length, oldName, newName, sqlite: sqlFixes });
	} catch (error) {
		console.error("Error fixing driver name:", error.message);
		res.status(500).json({ error: error.message });
	}
});

// Admin: scan for duplicate load IDs in Job Tracking
app.get("/api/admin/scan-duplicates", requireRole("Super Admin"), async (req, res) => {
	try {
		const sheets = await getSheets();
		const resp = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: "Job Tracking" });
		const rows = resp.data.values || [];
		if (rows.length < 2) return res.json({ total: 0, dangerous: 0, groups: [] });

		const headers = rows[0];
		const loadIdIdx = headers.findIndex((h) => /load.?id|job.?id/i.test(h));
		const statusIdx = headers.findIndex((h) => /status/i.test(h));
		const driverIdx = headers.findIndex((h) => /^driver$/i.test(h));
		const oLatIdx = headers.findIndex((h) => /origin.*lat/i.test(h));

		const byId = {};
		for (let i = 1; i < rows.length; i++) {
			const rawId = (rows[i][loadIdIdx] || "").trim();
			if (!rawId) continue;
			const norm = rawId.replace(/^#/, "");
			if (!byId[norm]) byId[norm] = [];
			byId[norm].push({
				row: i + 1,
				rawId,
				status: (rows[i][statusIdx] || "").trim() || "(empty)",
				driver: (rows[i][driverIdx] || "").trim() || "(no driver)",
				oLat: (rows[i][oLatIdx] || "").trim() || "",
			});
		}

		const groups = Object.entries(byId)
			.filter(([, r]) => r.length > 1)
			.map(([loadId, rws]) => {
				const statuses = new Set(rws.map((r) => r.status.toLowerCase()));
				const dangerous = statuses.size > 1;
				return { loadId, dangerous, rows: rws };
			})
			.sort((a, b) => (b.dangerous ? 1 : 0) - (a.dangerous ? 1 : 0));

		res.json({ total: groups.length, dangerous: groups.filter((g) => g.dangerous).length, groups });
	} catch (error) {
		res.status(500).json({ error: error.message });
	}
});

// Admin: scan for driver name mismatches across Carrier DB, Job Tracking, and SQLite
app.get("/api/admin/scan-driver-mismatches", requireRole("Super Admin"), async (req, res) => {
	try {
		const sheets = await getSheets();
		const resp = await sheets.spreadsheets.values.batchGet({
			spreadsheetId: SPREADSHEET_ID,
			ranges: ["Job Tracking", "Carrier Database"],
		});
		const rangeData = resp.data.valueRanges || [];
		const jtRows = (rangeData[0]?.values || []);
		const cdRows = (rangeData[1]?.values || []);

		const jtHeaders = jtRows[0] || [];
		const cdHeaders = cdRows[0] || [];
		const jtDriverIdx = jtHeaders.findIndex((h) => /^driver$/i.test(h));
		const cdDriverIdx = cdHeaders.findIndex((h) => /driver/i.test(h));
		if (cdDriverIdx === -1) cdHeaders[0]; // fallback

		// Collect names from each source
		const carrierNames = new Map();
		cdRows.slice(1).forEach((r) => {
			const name = (r[cdDriverIdx !== -1 ? cdDriverIdx : 0] || "").trim();
			if (name) carrierNames.set(name.toLowerCase(), name);
		});

		const sheetNames = new Map();
		jtRows.slice(1).forEach((r) => {
			const name = (r[jtDriverIdx] || "").trim();
			if (!name) return;
			const key = name.toLowerCase();
			if (!sheetNames.has(key)) sheetNames.set(key, { canonical: name, count: 0, variants: new Set() });
			sheetNames.get(key).count++;
			sheetNames.get(key).variants.add(name);
		});

		const users = db.prepare("SELECT username, driver_name, role FROM users WHERE role = 'Driver'").all();
		const userMap = new Map();
		users.forEach((u) => {
			if (u.driver_name) userMap.set(u.driver_name.toLowerCase(), { username: u.username, driverName: u.driver_name });
		});

		// Cross-reference
		const allKeys = new Set([...carrierNames.keys(), ...sheetNames.keys(), ...userMap.keys()]);
		const mismatches = [];
		for (const key of allKeys) {
			const carrier = carrierNames.get(key);
			const sheet = sheetNames.get(key);
			const user = userMap.get(key);
			const issues = [];

			if (carrier && sheet && carrier !== sheet.canonical) issues.push(`Case mismatch: Carrier "${carrier}" vs Sheet "${sheet.canonical}"`);
			if (sheet && !user) issues.push("No driver user account");
			if (carrier && !user) issues.push("In Carrier DB but no user account");
			if (user && !carrier) issues.push("Has user account but not in Carrier DB");
			if (sheet && sheet.variants.size > 1) issues.push(`Multiple variants in sheet: ${[...sheet.variants].join(", ")}`);

			if (issues.length > 0) {
				mismatches.push({
					name: carrier || sheet?.canonical || user?.driverName || key,
					carrierName: carrier || null,
					sheetName: sheet?.canonical || null,
					sheetCount: sheet?.count || 0,
					userAccount: user?.username || null,
					userDriverName: user?.driverName || null,
					issues,
				});
			}
		}

		res.json({ mismatches });
	} catch (error) {
		res.status(500).json({ error: error.message });
	}
});

// Admin: scan SQLite tables for orphaned driver names
app.get("/api/admin/scan-orphans", requireRole("Super Admin"), async (req, res) => {
	try {
		const users = db.prepare("SELECT driver_name FROM users WHERE role = 'Driver' AND driver_name != ''").all();
		const knownNames = new Set(users.map((u) => u.driver_name.toLowerCase()));

		const tables = [
			{ name: "notifications", col: "driver_name", query: "SELECT driver_name AS name, COUNT(*) AS count FROM notifications GROUP BY driver_name" },
			{ name: "expenses", col: "driver", query: "SELECT driver AS name, COUNT(*) AS count FROM expenses GROUP BY driver" },
			{ name: "messages_from", col: "from", query: 'SELECT "from" AS name, COUNT(*) AS count FROM messages GROUP BY "from"' },
			{ name: "messages_to", col: "to", query: 'SELECT "to" AS name, COUNT(*) AS count FROM messages GROUP BY "to"' },
			{ name: "load_responses", col: "driver_name", query: "SELECT driver_name AS name, COUNT(*) AS count FROM load_responses GROUP BY driver_name" },
			{ name: "dispatch_notifications", col: "title", query: "SELECT 'dispatch' AS name, COUNT(*) AS count FROM dispatch_notifications" },
		];

		const orphans = [];
		for (const t of tables) {
			if (t.name === "dispatch_notifications") continue; // title-based, skip
			const rows = db.prepare(t.query).all();
			const orphaned = rows.filter((r) => r.name && !knownNames.has(r.name.toLowerCase()));
			if (orphaned.length > 0) {
				orphans.push({ table: t.name, column: t.col, records: orphaned });
			}
		}

		res.json({ orphans, knownDrivers: users.map((u) => u.driver_name) });
	} catch (error) {
		res.status(500).json({ error: error.message });
	}
});

// Admin: batch delete specific rows from a sheet (for removing stale duplicates)
app.post("/api/admin/remove-rows", requireRole("Super Admin"), async (req, res) => {
	try {
		const { sheet, rowIndices } = req.body;
		if (!sheet || !rowIndices || !rowIndices.length) {
			return res.status(400).json({ error: "sheet and rowIndices required" });
		}

		const sheets = await getSheets();
		const sheetId = await getSheetId(sheets, sheet);

		// Sort descending so deletions don't shift indices
		const sorted = [...rowIndices].sort((a, b) => b - a);
		const requests = sorted.map((rowIndex) => ({
			deleteDimension: {
				range: { sheetId, dimension: "ROWS", startIndex: rowIndex - 1, endIndex: rowIndex },
			},
		}));

		await sheets.spreadsheets.batchUpdate({
			spreadsheetId: SPREADSHEET_ID,
			requestBody: { requests },
		});

		res.json({ deleted: sorted.length });
	} catch (error) {
		console.error("Error removing rows:", error.message);
		res.status(500).json({ error: error.message });
	}
});

// Admin: scan for stale load_ids in driver_locations (GPS tagged to wrong load)
app.get("/api/admin/scan-stale-locations", requireRole("Super Admin"), async (req, res) => {
	try {
		// Get all location groups from SQLite
		const locGroups = db.prepare(
			`SELECT driver, load_id, COUNT(*) AS pings,
			        MIN(timestamp) AS firstPing, MAX(timestamp) AS lastPing,
			        AVG(latitude) AS avgLat, AVG(longitude) AS avgLng
			 FROM driver_locations
			 WHERE load_id != ''
			 GROUP BY driver, load_id`
		).all();

		if (locGroups.length === 0) return res.json({ issues: [] });

		// Fetch Job Tracking from Google Sheets
		const sheets = await getSheets();
		const resp = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: "Job Tracking" });
		const rows = resp.data.values || [];
		if (rows.length < 2) return res.json({ issues: [] });

		const headers = rows[0];
		const loadIdIdx = headers.findIndex((h) => /load.?id|job.?id/i.test(h));
		const statusIdx = headers.findIndex((h) => /status/i.test(h));
		const driverIdx = headers.findIndex((h) => /^driver$/i.test(h));
		const oLatIdx = headers.findIndex((h) => /origin.*lat/i.test(h));
		const oLngIdx = headers.findIndex((h) => /origin.*l(on|ng)/i.test(h));
		const dLatIdx = headers.findIndex((h) => /dest.*lat/i.test(h));
		const dLngIdx = headers.findIndex((h) => /dest.*l(on|ng)/i.test(h));
		const detailsIdx = headers.findIndex((h) => /^details$/i.test(h));

		// Build sheet lookup: loadId → { status, driver, origin, dest, details }
		const sheetLoads = {};
		const activeRe = /^(assigned|dispatched|at shipper|loading|in transit|at receiver|unloading)$/i;
		const driverActiveLoads = {}; // driver → most recent active loadId from sheet
		for (let i = 1; i < rows.length; i++) {
			const lid = (rows[i][loadIdIdx] || "").trim().replace(/^#/, "");
			if (!lid) continue;
			const status = (rows[i][statusIdx] || "").trim();
			const driver = (rows[i][driverIdx] || "").trim();
			const oLat = parseFloat(rows[i][oLatIdx] || "");
			const oLng = parseFloat(rows[i][oLngIdx] || "");
			const dLat = parseFloat(rows[i][dLatIdx] || "");
			const dLng = parseFloat(rows[i][dLngIdx] || "");
			const details = (rows[i][detailsIdx] || "").trim();
			sheetLoads[lid] = { status: status || "(empty)", driver, oLat, oLng, dLat, dLng, details };
			if (driver && activeRe.test(status)) {
				driverActiveLoads[driver.toLowerCase()] = lid;
			}
		}

		const issues = [];
		for (const group of locGroups) {
			const problems = [];
			const sheetLoad = sheetLoads[group.load_id];
			const activeLoad = driverActiveLoads[(group.driver || "").toLowerCase()];

			// Check 1: load_id doesn't exist in sheet
			if (!sheetLoad) {
				problems.push("Load ID not found in Google Sheets");
			} else {
				// Check 2: GPS coordinates far from both origin and dest
				if (!isNaN(sheetLoad.oLat) && !isNaN(sheetLoad.dLat) && group.avgLat) {
					const distToOrigin = geolib.getDistance(
						{ latitude: group.avgLat, longitude: group.avgLng },
						{ latitude: sheetLoad.oLat, longitude: sheetLoad.oLng }
					);
					const distToDest = geolib.getDistance(
						{ latitude: group.avgLat, longitude: group.avgLng },
						{ latitude: sheetLoad.dLat, longitude: sheetLoad.dLng }
					);
					const minDist = Math.min(distToOrigin, distToDest);
					if (minDist > 500000) { // > 500km from both origin and dest
						problems.push(`GPS avg (${group.avgLat.toFixed(4)}, ${group.avgLng.toFixed(4)}) is ${Math.round(minDist / 1000)}km from nearest load point`);
					}
				}
			}

			// Check 3: driver has a different active load in the sheet
			if (activeLoad && activeLoad !== group.load_id) {
				const activeDetails = sheetLoads[activeLoad]?.details || "";
				problems.push(`Driver's active load in sheet is ${activeLoad}${activeDetails ? " (" + activeDetails + ")" : ""}`);
			}

			if (problems.length > 0) {
				issues.push({
					driver: group.driver,
					sqliteLoadId: group.load_id,
					pings: group.pings,
					firstPing: group.firstPing,
					lastPing: group.lastPing,
					avgLat: group.avgLat ? +group.avgLat.toFixed(5) : null,
					avgLng: group.avgLng ? +group.avgLng.toFixed(5) : null,
					sheetStatus: sheetLoad?.status || "not found",
					sheetDetails: sheetLoad?.details || "",
					suggestedLoadId: activeLoad || null,
					suggestedDetails: activeLoad && sheetLoads[activeLoad] ? sheetLoads[activeLoad].details : "",
					problems,
				});
			}
		}

		res.json({ issues });
	} catch (error) {
		console.error("Error scanning stale locations:", error.message);
		res.status(500).json({ error: error.message });
	}
});

// Admin: fix stale load_id in driver_locations
app.post("/api/admin/fix-stale-locations", requireRole("Super Admin"), async (req, res) => {
	try {
		const { driver, oldLoadId, newLoadId } = req.body;
		if (!driver || !oldLoadId || !newLoadId) {
			return res.status(400).json({ error: "driver, oldLoadId, and newLoadId required" });
		}
		const result = db.prepare(
			"UPDATE driver_locations SET load_id = ? WHERE driver = ? AND load_id = ?"
		).run(newLoadId, driver, oldLoadId);
		res.json({ updated: result.changes });
	} catch (error) {
		console.error("Error fixing stale locations:", error.message);
		res.status(500).json({ error: error.message });
	}
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
app.get("/api/data", requireRole("Super Admin", "Dispatcher"), async (req, res) => {
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
		let allData = rows.slice(1).map((row, index) => {
			const obj = { _rowIndex: index + 2 }; // Sheet rows are 1-indexed, +1 for header
			headers.forEach((header, i) => {
				obj[header] = row[i] || "";
			});
			return obj;
		});

		// Deduplicate loads by Load ID (keep most advanced status)
		let duplicates = [];
		if (sheetName === "Job Tracking") {
			const result = deduplicateLoads(allData, headers, true);
			allData = result.data;
			duplicates = result.duplicates;
		}

		// Search filter
		const search = (req.query.search || "").trim().toLowerCase();
		if (search) {
			allData = allData.filter((row) =>
				headers.some((h) => (row[h] || "").toLowerCase().includes(search)),
			);
		}

		const total = allData.length;
		const totalPages = Math.ceil(total / limit);
		const start = (page - 1) * limit;
		let data = allData.slice(start, start + limit);

		// Sanitize broker contact data for non-Admin roles
		if (req.session.user.role !== "Super Admin") {
			data = sanitizeBrokerColumns(headers, data);
		}

		res.json({ headers, data, sheet: sheetName, total, page, limit, totalPages, duplicates });
	} catch (error) {
		console.error("Error reading sheet:", error.message);
		res.status(500).json({ error: error.message });
	}
});

// CREATE — Append a new row
app.post("/api/data", requireRole("Super Admin", "Dispatcher"), async (req, res) => {
	try {
		const sheetName = getSheetName(req);
		const { values } = req.body; // values = array of cell values

		const sheets = await getSheets();

		// Check for duplicate Load ID in Job Tracking
		let warning = "";
		if (sheetName === "Job Tracking") {
			try {
				const headerResp = await sheets.spreadsheets.values.get({
					spreadsheetId: SPREADSHEET_ID,
					range: "Job Tracking!1:1",
				});
				const hdrs = (headerResp.data.values || [[]])[0];
				const lidIdx = hdrs.findIndex((h) => /load.?id|job.?id/i.test(h));
				if (lidIdx >= 0 && values[lidIdx]) {
					const newLid = values[lidIdx].trim().toLowerCase().replace(/^#/, "");
					if (newLid) {
						const allResp = await sheets.spreadsheets.values.get({
							spreadsheetId: SPREADSHEET_ID,
							range: "Job Tracking",
						});
						const allRows = allResp.data.values || [];
						for (let i = 1; i < allRows.length; i++) {
							const existing = (allRows[i][lidIdx] || "").trim().toLowerCase().replace(/^#/, "");
							if (existing === newLid) {
								warning = `Load ID '${values[lidIdx]}' already exists (row ${i + 1}). A duplicate entry will be created.`;
								break;
							}
						}
					}
				}
			} catch { /* non-critical */ }
		}

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
			...(warning && { warning }),
		});
	} catch (error) {
		console.error("Error appending row:", error.message);
		res.status(500).json({ error: error.message });
	}
});

// UPDATE — Update a specific row
app.put("/api/data/:rowIndex", requireRole("Super Admin", "Dispatcher"), async (req, res) => {
	try {
		const sheetName = getSheetName(req);
		const rowIndex = parseInt(req.params.rowIndex);
		const { values } = req.body;

		const sheets = await getSheets();

		// For non-Admin users, preserve original broker/phone column values
		// so sanitized data doesn't overwrite the full JSON
		if (req.session.user.role !== "Super Admin") {
			const headerRes = await sheets.spreadsheets.values.get({
				spreadsheetId: SPREADSHEET_ID,
				range: `${sheetName}!1:1`,
			});
			const headers = (headerRes.data.values && headerRes.data.values[0]) || [];
			const currentRowRes = await sheets.spreadsheets.values.get({
				spreadsheetId: SPREADSHEET_ID,
				range: `${sheetName}!A${rowIndex}`,
			});
			const currentValues = (currentRowRes.data.values && currentRowRes.data.values[0]) || [];
			headers.forEach((h, i) => {
				if (/broker|phone|contact/i.test(h) && currentValues[i] && i < values.length) {
					values[i] = currentValues[i];
				}
			});
		}

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
app.post("/api/dispatch", requireRole("Super Admin", "Dispatcher"), async (req, res) => {
	try {
		const { rowIndex, driver: rawDriver, loadId, origin, destination } = req.body;
		if (!rowIndex || !rawDriver) {
			return res.status(400).json({ error: "rowIndex and driver required" });
		}

		// Normalize driver name against users table to prevent misspelling mismatches
		const userMatch = db.prepare("SELECT driver_name FROM users WHERE LOWER(driver_name) = LOWER(?) AND role = 'Driver'").get(rawDriver.trim());
		const driver = userMatch ? userMatch.driver_name : rawDriver.trim();

		const sheets = await getSheets();
		const headerResp = await sheets.spreadsheets.values.get({
			spreadsheetId: SPREADSHEET_ID,
			range: "Job Tracking!1:1",
		});
		const headers = (headerResp.data.values || [[]])[0];
		const driverColIdx = headers.findIndex((h) => /driver/i.test(h));
		const statusColIdx = headers.findIndex((h) => /status/i.test(h));

		if (driverColIdx === -1) {
			return res.status(400).json({ error: "Driver column not found" });
		}

		// Update driver cell
		await sheets.spreadsheets.values.update({
			spreadsheetId: SPREADSHEET_ID,
			range: `Job Tracking!${colLetter(driverColIdx)}${rowIndex}`,
			valueInputOption: "USER_ENTERED",
			requestBody: { values: [[driver]] },
		});

		// Update status cell to Dispatched
		if (statusColIdx !== -1) {
			await sheets.spreadsheets.values.update({
				spreadsheetId: SPREADSHEET_ID,
				range: `Job Tracking!${colLetter(statusColIdx)}${rowIndex}`,
				valueInputOption: "USER_ENTERED",
				requestBody: { values: [["Dispatched"]] },
			});
		}

		// Log to Status Logs
		const now = new Date();
		const logId = `LOG-${now.getTime()}`;
		const dateTime = `${(now.getMonth() + 1).toString().padStart(2, "0")}/${now.getDate().toString().padStart(2, "0")}/${now.getFullYear()} ${now.getHours()}:${now.getMinutes().toString().padStart(2, "0")}:${now.getSeconds().toString().padStart(2, "0")}`;
		await sheets.spreadsheets.values.append({
			spreadsheetId: SPREADSHEET_ID,
			range: "Status Logs",
			valueInputOption: "USER_ENTERED",
			requestBody: {
				values: [[logId, loadId || "", driver, dateTime, "Dispatched", `Assigned to ${driver}`]],
			},
		});

		// Persist notification and notify the driver in real-time
		const route = [origin, destination].filter(Boolean).join(' → ') || '';
		const notifResult = insertNotification.run(
			driver.trim().toLowerCase(), 'load-assigned',
			`New Load Assigned: ${loadId || 'Load'}`,
			route,
			JSON.stringify({ loadId, rowIndex, origin: origin || '', destination: destination || '' })
		);
		io.to(driver.trim().toLowerCase()).emit("load-assigned", { loadId, rowIndex, origin: origin || '', destination: destination || '', notificationId: notifResult.lastInsertRowid });

		// Notify dispatch team
		insertDispatchNotification.run(
			'load-assigned',
			`Assigned ${driver} to Load ${loadId || 'N/A'}`,
			route,
			JSON.stringify({ loadId, driver, rowIndex })
		);
		io.to("dispatch").emit("dispatch-notification", {
			type: 'load-assigned',
			title: `Assigned ${driver} to Load ${loadId || 'N/A'}`,
			body: route,
		});

		// Clear stale load_responses so driver gets a fresh Accept/Decline prompt
		if (loadId) {
			db.prepare("DELETE FROM load_responses WHERE load_id = ? AND driver_name = ?")
				.run(loadId, driver.trim().toLowerCase());
		}

		res.json({ success: true });
	} catch (error) {
		console.error("Error dispatching load:", error.message);
		res.status(500).json({ error: error.message });
	}
});

// POST /api/dispatch/reassign — Reassign a load to a different driver
app.post("/api/dispatch/reassign", requireRole("Super Admin", "Dispatcher"), async (req, res) => {
	try {
		const { rowIndex, newDriver, loadId, oldDriver } = req.body;
		if (!rowIndex || !newDriver) {
			return res.status(400).json({ error: "rowIndex and newDriver required" });
		}

		const sheets = await getSheets();
		const headerResp = await sheets.spreadsheets.values.get({
			spreadsheetId: SPREADSHEET_ID,
			range: "Job Tracking!1:1",
		});
		const headers = (headerResp.data.values || [[]])[0];
		const driverCol = headers.findIndex((h) => /driver/i.test(h));
		if (driverCol === -1) {
			return res.status(400).json({ error: "Driver column not found" });
		}

		// Update driver cell
		const driverColLetter = colLetter(driverCol);
		await sheets.spreadsheets.values.update({
			spreadsheetId: SPREADSHEET_ID,
			range: `Job Tracking!${driverColLetter}${rowIndex}`,
			valueInputOption: "USER_ENTERED",
			requestBody: { values: [[newDriver]] },
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
				values: [[logId, loadId || "", newDriver, dateTime, "Reassigned", `Reassigned from ${oldDriver || "unknown"} to ${newDriver}`]],
			},
		});

		// Notify new driver
		insertNotification.run(
			newDriver.trim().toLowerCase(), 'load-assigned',
			`Load Reassigned: ${loadId || 'Load'}`,
			`Previously assigned to ${oldDriver || 'another driver'}`,
			JSON.stringify({ loadId, rowIndex })
		);
		io.to(newDriver.trim().toLowerCase()).emit("load-assigned", { loadId, rowIndex });

		// Notify old driver
		if (oldDriver) {
			insertNotification.run(
				oldDriver.trim().toLowerCase(), 'load-assigned',
				`Load Removed: ${loadId || 'Load'}`,
				`Reassigned to ${newDriver}`,
				JSON.stringify({ loadId, rowIndex })
			);
		}

		// Notify dispatch team
		insertDispatchNotification.run(
			'load-reassigned',
			`Reassigned Load ${loadId || 'N/A'} to ${newDriver}`,
			`Previously ${oldDriver || 'unknown'}`,
			JSON.stringify({ loadId, newDriver, oldDriver, rowIndex })
		);
		io.to("dispatch").emit("dispatch-notification", {
			type: 'load-reassigned',
			title: `Reassigned Load ${loadId || 'N/A'} to ${newDriver}`,
			body: `Previously ${oldDriver || 'unknown'}`,
		});

		// Clear stale load_responses for new driver
		if (loadId && newDriver) {
			db.prepare("DELETE FROM load_responses WHERE load_id = ? AND driver_name = ?")
				.run(loadId, newDriver.trim().toLowerCase());
		}

		res.json({ success: true });
	} catch (error) {
		console.error("Error reassigning load:", error.message);
		res.status(500).json({ error: error.message });
	}
});

// POST /api/dispatch/cancel — Cancel a load assignment (set back to Unassigned)
app.post("/api/dispatch/cancel", requireRole("Super Admin", "Dispatcher"), async (req, res) => {
	try {
		const { rowIndex, loadId, driver } = req.body;
		if (!rowIndex) {
			return res.status(400).json({ error: "rowIndex required" });
		}

		const sheets = await getSheets();
		const headerResp = await sheets.spreadsheets.values.get({
			spreadsheetId: SPREADSHEET_ID,
			range: "Job Tracking!1:1",
		});
		const headers = (headerResp.data.values || [[]])[0];
		const driverColIdx = headers.findIndex((h) => /driver/i.test(h));
		const statusColIdx = headers.findIndex((h) => /status/i.test(h));

		// Clear driver and set status to Unassigned
		const requests = [];
		if (driverColIdx !== -1) {
			await sheets.spreadsheets.values.update({
				spreadsheetId: SPREADSHEET_ID,
				range: `Job Tracking!${colLetter(driverColIdx)}${rowIndex}`,
				valueInputOption: "USER_ENTERED",
				requestBody: { values: [[""]] },
			});
		}
		if (statusColIdx !== -1) {
			await sheets.spreadsheets.values.update({
				spreadsheetId: SPREADSHEET_ID,
				range: `Job Tracking!${colLetter(statusColIdx)}${rowIndex}`,
				valueInputOption: "USER_ENTERED",
				requestBody: { values: [["Unassigned"]] },
			});
		}

		// Log to Status Logs
		const now = new Date();
		const logId = `LOG-${now.getTime()}`;
		const dateTime = `${(now.getMonth() + 1).toString().padStart(2, "0")}/${now.getDate().toString().padStart(2, "0")}/${now.getFullYear()} ${now.getHours()}:${now.getMinutes().toString().padStart(2, "0")}:${now.getSeconds().toString().padStart(2, "0")}`;
		await sheets.spreadsheets.values.append({
			spreadsheetId: SPREADSHEET_ID,
			range: "Status Logs",
			valueInputOption: "USER_ENTERED",
			requestBody: {
				values: [[logId, loadId || "", driver || "", dateTime, "Unassigned", `Assignment cancelled (was ${driver || "unknown"})`]],
			},
		});

		// Notify driver
		if (driver) {
			const cancelNotif = insertNotification.run(
				driver.trim().toLowerCase(), 'load-assigned',
				`Load Cancelled: ${loadId || 'Load'}`,
				'Your assignment has been cancelled by dispatch',
				JSON.stringify({ loadId, rowIndex })
			);
			io.to(driver.trim().toLowerCase()).emit("load-cancelled", {
				loadId,
				rowIndex,
				notificationId: cancelNotif.lastInsertRowid,
			});
		}

		// Notify dispatch team
		insertDispatchNotification.run(
			'load-cancelled',
			`Cancelled Load ${loadId || 'N/A'}`,
			`Was assigned to ${driver || 'unknown'}`,
			JSON.stringify({ loadId, driver, rowIndex })
		);
		io.to("dispatch").emit("dispatch-notification", {
			type: 'load-cancelled',
			title: `Cancelled Load ${loadId || 'N/A'}`,
			body: `Was assigned to ${driver || 'unknown'}`,
		});

		res.json({ success: true });
	} catch (error) {
		console.error("Error cancelling load:", error.message);
		res.status(500).json({ error: error.message });
	}
});

// POST /api/driver/respond — Driver accepts or declines a load assignment
app.post("/api/driver/respond", requireAuth, async (req, res) => {
	try {
		const { loadId, rowIndex, response, driverName } = req.body;
		if (!loadId || !rowIndex || !response || !driverName) {
			return res.status(400).json({ error: "loadId, rowIndex, response, and driverName required" });
		}
		if (!["accepted", "declined"].includes(response)) {
			return res.status(400).json({ error: "response must be 'accepted' or 'declined'" });
		}

		// Check for duplicate response (scoped to load_id + driver + rowIndex)
		const existing = db.prepare(
			`SELECT id, response FROM load_responses WHERE load_id = ? AND driver_name = ? AND row_index = ? ORDER BY responded_at DESC LIMIT 1`
		).get(loadId, driverName.trim().toLowerCase(), rowIndex);
		if (existing && existing.response === response && response === "accepted") {
			return res.status(409).json({ error: "You have already accepted this load" });
		}

		// Insert response
		insertLoadResponse.run(loadId, rowIndex, driverName.trim().toLowerCase(), response);

		const sheets = await getSheets();
		const now = new Date();
		const logId = `LOG-${now.getTime()}`;
		const dateTime = `${(now.getMonth() + 1).toString().padStart(2, "0")}/${now.getDate().toString().padStart(2, "0")}/${now.getFullYear()} ${now.getHours()}:${now.getMinutes().toString().padStart(2, "0")}:${now.getSeconds().toString().padStart(2, "0")}`;

		if (response === "accepted") {
			// Update Job Status to "Assigned" in the sheet
			const headerResp2 = await sheets.spreadsheets.values.get({
				spreadsheetId: SPREADSHEET_ID,
				range: "Job Tracking!1:1",
			});
			const headers2 = (headerResp2.data.values || [[]])[0];
			const statusColIdx2 = headers2.findIndex((h) => /status/i.test(h));
			if (statusColIdx2 !== -1) {
				await sheets.spreadsheets.values.update({
					spreadsheetId: SPREADSHEET_ID,
					range: `Job Tracking!${String.fromCharCode(65 + statusColIdx2)}${rowIndex}`,
					valueInputOption: "USER_ENTERED",
					requestBody: { values: [["Assigned"]] },
				});
			}

			// Log to Status Logs
			await sheets.spreadsheets.values.append({
				spreadsheetId: SPREADSHEET_ID,
				range: "Status Logs",
				valueInputOption: "USER_ENTERED",
				requestBody: {
					values: [[logId, loadId, driverName, dateTime, "Assigned", "Driver confirmed assignment"]],
				},
			});

			// Notify dispatch
			insertDispatchNotification.run(
				'load-accepted',
				`${driverName} accepted Load ${loadId}`,
				`Driver confirmed assignment`,
				JSON.stringify({ loadId, driverName, rowIndex })
			);
			io.to("dispatch").emit("load-accepted", { loadId, driverName, rowIndex });
			io.to("dispatch").emit("dispatch-notification", {
				type: 'load-accepted',
				title: `${driverName} accepted Load ${loadId}`,
				body: `Driver confirmed assignment`,
			});
		} else {
			// Decline: clear driver and set Unassigned
			const headerResp = await sheets.spreadsheets.values.get({
				spreadsheetId: SPREADSHEET_ID,
				range: "Job Tracking!1:1",
			});
			const headers = (headerResp.data.values || [[]])[0];
			const driverColIdx = headers.findIndex((h) => /^driver$/i.test(h));
			const statusColIdx = headers.findIndex((h) => /status/i.test(h));

			if (driverColIdx !== -1) {
				await sheets.spreadsheets.values.update({
					spreadsheetId: SPREADSHEET_ID,
					range: `Job Tracking!${colLetter(driverColIdx)}${rowIndex}`,
					valueInputOption: "USER_ENTERED",
					requestBody: { values: [[""]] },
				});
			}
			if (statusColIdx !== -1) {
				await sheets.spreadsheets.values.update({
					spreadsheetId: SPREADSHEET_ID,
					range: `Job Tracking!${colLetter(statusColIdx)}${rowIndex}`,
					valueInputOption: "USER_ENTERED",
					requestBody: { values: [["Unassigned"]] },
				});
			}

			// Log to Status Logs
			await sheets.spreadsheets.values.append({
				spreadsheetId: SPREADSHEET_ID,
				range: "Status Logs",
				valueInputOption: "USER_ENTERED",
				requestBody: {
					values: [[logId, loadId, driverName, dateTime, "Unassigned", "Driver declined assignment"]],
				},
			});

			// Notify dispatch
			insertDispatchNotification.run(
				'load-declined',
				`${driverName} declined Load ${loadId}`,
				`Load returned to Job Board`,
				JSON.stringify({ loadId, driverName, rowIndex })
			);
			io.to("dispatch").emit("load-declined", { loadId, driverName, rowIndex });
			io.to("dispatch").emit("dispatch-notification", {
				type: 'load-declined',
				title: `${driverName} declined Load ${loadId}`,
				body: `Load returned to Job Board`,
			});
		}

		res.json({ success: true, response });
	} catch (error) {
		console.error("Error responding to load:", error.message);
		res.status(500).json({ error: error.message });
	}
});

// DELETE — Clear a row (shifts content up by deleting the row) — Admin only
app.delete("/api/data/:rowIndex", requireRole("Super Admin"), async (req, res) => {
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
app.get("/api/dashboard", requireRole("Super Admin", "Dispatcher"), async (req, res) => {
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
		jobTracking.data = deduplicateLoads(jobTracking.data, jobTracking.headers);
		const carrierDB = parseSheet(rangeData[1]);
		const payments = parseSheet(rangeData[2]);
		const carrierHistory = parseSheet(rangeData[3]);
		const jobSummary = parseSheet(rangeData[4]);

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
		const unassignedJobs = jobTracking.data.filter((r) => {
			const lid = loadIdCol ? (r[loadIdCol] || "").trim() : "";
			if (!lid) return false; // skip rows with no Load ID
			const status = statusCol ? (r[statusCol] || "").trim() : "";
			const hasDriver = driverCol ? !!(r[driverCol] || "").trim() : true;
			return unassignedStatuses.test(status) || !status || !hasDriver;
		});
		const completedJobs = jobTracking.data.filter(
			(r) =>
				statusCol &&
				completedStatuses.test((r[statusCol] || "").trim()),
		);

		// Also pull completed loads from Job Summary Sheet
		const summaryStatusCol = findCol(jobSummary.headers, /status/i);
		const summaryLoadIdCol = findCol(jobSummary.headers, /load.?id|job.?id/i);
		const summaryCompletedJobs = jobSummary.data.filter(
			(r) => summaryStatusCol && completedStatuses.test((r[summaryStatusCol] || "").trim()),
		);

		// Merge, de-duplicate by load ID (Job Tracking takes priority)
		const existingLoadIds = new Set(
			completedJobs
				.map((r) => (loadIdCol ? (r[loadIdCol] || "").trim().toLowerCase() : ""))
				.filter(Boolean),
		);
		const extraCompleted = summaryCompletedJobs.filter((r) => {
			const id = summaryLoadIdCol ? (r[summaryLoadIdCol] || "").trim().toLowerCase() : "";
			return id && !existingLoadIds.has(id);
		});
		const allCompletedJobs = [...completedJobs, ...extraCompleted];

		// Date boundaries
		const now = new Date();
		const weekStart = new Date(now);
		weekStart.setDate(
			now.getDate() - now.getDay() + (now.getDay() === 0 ? -6 : 1),
		);
		weekStart.setHours(0, 0, 0, 0);
		const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

		// Find delivery date column across both sheets
		const summaryDelivDateCol = findCol(jobSummary.headers, /deliv|drop.?off.*date|completion.*date/i);

		const completedThisWeek = allCompletedJobs.filter((r) => {
			const dCol = r[delivDateCol] != null ? delivDateCol : summaryDelivDateCol;
			if (!dCol) return false;
			const d = new Date(r[dCol]);
			return !isNaN(d) && d >= weekStart && d <= now;
		}).length;

		const completedThisMonth = allCompletedJobs.filter((r) => {
			const dCol = r[delivDateCol] != null ? delivDateCol : summaryDelivDateCol;
			if (!dCol) return false;
			const d = new Date(r[dCol]);
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

		// Driver list (case-insensitive dedup to prevent misspelling duplicates)
		const driverMap = new Map();
		carrierDB.data.forEach((r) => {
			const name = (r[carrierDriverCol] || "").trim();
			if (name && !driverMap.has(name.toLowerCase())) driverMap.set(name.toLowerCase(), name);
		});
		const driverList = [...driverMap.values()].sort();

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
				CompletedLoads: allCompletedJobs.filter((j) => {
					const jDriverCol = driverCol || findCol(jobSummary.headers, /driver/i);
					return jDriverCol && (j[jDriverCol] || "").trim() === name;
				}).length,
			};
		});

		// Sanitize broker contact data for non-Admin roles
		const respUnassigned = req.session.user.role !== "Super Admin"
			? sanitizeBrokerColumns(jobTracking.headers, unassignedJobs)
			: unassignedJobs;
		const respActive = req.session.user.role !== "Super Admin"
			? sanitizeBrokerColumns(jobTracking.headers, activeJobs)
			: activeJobs;
		// Merge headers from both sheets for completed loads display
		const completedHeaders = [...new Set([...jobTracking.headers, ...jobSummary.headers])];
		const respCompleted = req.session.user.role !== "Super Admin"
			? sanitizeBrokerColumns(completedHeaders, allCompletedJobs)
			: allCompletedJobs;

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
			unassignedJobs: respUnassigned,
			jobTrackingHeaders: jobTracking.headers,
			completedHeaders,
			activeJobs: respActive,
			completedJobs: respCompleted,
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

// Status hierarchy for smart deduplication (higher = more advanced)
const STATUS_RANK = {
	'': 0, unassigned: 1, dispatched: 2, assigned: 3, 'at shipper': 4,
	loading: 5, 'in transit': 6, unloading: 7, 'at receiver': 8,
	delivered: 9, 'pod received': 10, completed: 11,
};

// Helper: remove duplicate load IDs, keeping the row with the most advanced status
function deduplicateLoads(data, headers, returnDuplicates = false) {
	const loadIdCol = headers.find((h) => /load.?id|job.?id/i.test(h));
	if (!loadIdCol) return returnDuplicates ? { data, duplicates: [] } : data;
	const statusCol = headers.find((h) => /^(job.?)?status$/i.test(h));
	const seen = new Map();
	for (let i = 0; i < data.length; i++) {
		const lid = (data[i][loadIdCol] || "").trim().toLowerCase().replace(/^#/, "");
		if (!lid) continue;
		if (seen.has(lid)) seen.get(lid).push(i);
		else seen.set(lid, [i]);
	}
	// Collect ALL indices for load IDs that have duplicates
	const dupSet = new Set();
	for (const [, indices] of seen) {
		if (indices.length > 1) {
			for (const idx of indices) dupSet.add(idx);
		}
	}
	if (dupSet.size === 0) return returnDuplicates ? { data, duplicates: [] } : data;
	const filtered = data.filter((_, i) => !dupSet.has(i));
	if (!returnDuplicates) return filtered;
	return { data: filtered, duplicates: data.filter((_, i) => dupSet.has(i)) };
}

function sanitizeBrokerContact(value) {
	if (!value || typeof value !== "string") return value;
	const trimmed = value.trim();
	if (!trimmed.startsWith("{")) return value;
	try {
		const parsed = JSON.parse(trimmed);
		return JSON.stringify({ Name: parsed.Name || parsed.name || "" });
	} catch {
		return value;
	}
}

function sanitizeBrokerColumns(headers, rows) {
	const brokerCol = (headers || []).find((h) => /broker/i.test(h)) || null;
	const phoneCol = (headers || []).find((h) => /phone|contact/i.test(h)) || null;
	if (!brokerCol && !phoneCol) return rows;
	return rows.map((row) => {
		const cleaned = { ...row };
		if (brokerCol && cleaned[brokerCol]) {
			cleaned[brokerCol] = sanitizeBrokerContact(cleaned[brokerCol]);
		}
		if (phoneCol && cleaned[phoneCol]) {
			const val = (cleaned[phoneCol] || "").trim();
			if (val.startsWith("{")) {
				cleaned[phoneCol] = sanitizeBrokerContact(val);
			} else {
				cleaned[phoneCol] = "";
			}
		}
		return cleaned;
	});
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
		jobTracking.data = deduplicateLoads(jobTracking.data, jobTracking.headers);
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

		// Notifications from SQLite
		const driverNotifications = db
			.prepare(
				`SELECT id, type, title, body, metadata, read, created_at AS createdAt
				 FROM notifications
				 WHERE driver_name = ?
				 ORDER BY id DESC
				 LIMIT 100`,
			)
			.all(nameLower);

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

		// Count uploaded documents per load (total + POD-specific)
		const loadIdCol = findCol(jobTracking.headers, /load.?id|job.?id/i);
		const loadIds = loads
			.map((l) => (loadIdCol ? l[loadIdCol] : ""))
			.filter(Boolean);
		const docCounts = {};
		const podCounts = {};
		if (loadIds.length) {
			const placeholders = loadIds.map(() => "?").join(",");
			const docs = db
				.prepare(
					`SELECT load_id, COUNT(*) as count, SUM(CASE WHEN type = 'POD' THEN 1 ELSE 0 END) as pod_count FROM documents WHERE load_id IN (${placeholders}) GROUP BY load_id`,
				)
				.all(...loadIds);
			docs.forEach((d) => {
				docCounts[d.load_id] = d.count;
				podCounts[d.load_id] = d.pod_count;
			});
		}
		loads.forEach((load) => {
			const lid = loadIdCol ? load[loadIdCol] : "";
			load._docCount = docCounts[lid] || 0;
			load._podCount = podCounts[lid] || 0;
		});

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

		// Sanitize broker contact data for non-Admin roles
		if (req.session.user.role !== "Super Admin") {
			filteredLoads = sanitizeBrokerColumns(filteredHeaders, filteredLoads);
		}

		// Attach _accepted flag from load_responses
		const acceptedRows = db.prepare(
			`SELECT load_id FROM load_responses WHERE driver_name = ? AND response = 'accepted'`
		).all(nameLower);
		const acceptedSet = new Set(acceptedRows.map(r => r.load_id));
		const acceptLoadIdCol = jobTracking.headers.find((h) => /load.?id|job.?id/i.test(h));
		filteredLoads.forEach((load) => {
			const lid = acceptLoadIdCol ? (load[acceptLoadIdCol] || "") : "";
			load._accepted = acceptedSet.has(lid);
		});

		// Build list of all driver names for recipient picker
		const carrierDriverNames = [
			...new Set(
				carrierDB.data
					.map((r) => (r[carrierDriverCol] || "").trim())
					.filter(Boolean),
			),
		].sort();

		// Assigned truck from SQLite
		const assignedTruck = db.prepare(
			`SELECT unit_number, make, model, year, vin, license_plate, status, photo
			 FROM trucks WHERE LOWER(assigned_driver) = ?`
		).get(nameLower) || null;

		res.json({
			loads: filteredLoads,
			driverInfo: driverInfo || null,
			truck: assignedTruck,
			messages: driverMessages,
			notifications: driverNotifications,
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
		const { rowIndex, driverName, loadId, newStatus } = req.body;
		const sheets = await getSheets();

		// Read headers to find the status and date columns dynamically
		const headerRes = await sheets.spreadsheets.values.get({
			spreadsheetId: SPREADSHEET_ID,
			range: "Job Tracking!1:1",
		});
		const headers = (headerRes.data.values || [])[0] || [];

		const statusIdx = headers.findIndex((h) => /status/i.test(h));
		const dateIdx = headers.findIndex((h) => /status.*update.*date|update.*date/i.test(h));

		if (statusIdx === -1) {
			return res.status(400).json({ error: "Status column not found in sheet" });
		}

		// Enforce one active job at a time: block transition to "At Shipper" if another load is active
		if (/^at shipper$/i.test(newStatus)) {
			const driverCol = headers.findIndex((h) => /driver/i.test(h));
			if (driverCol !== -1) {
				const allRows = await sheets.spreadsheets.values.get({
					spreadsheetId: SPREADSHEET_ID,
					range: "Job Tracking",
				});
				const allData = (allRows.data.values || []).slice(1);
				const activeRe = /^(at shipper|loading|in transit|at receiver)$/i;
				const hasActive = allData.some((row, i) => {
					const rIdx = i + 2;
					if (rIdx === rowIndex) return false;
					const drv = (row[driverCol] || "").trim().toLowerCase();
					const sts = (row[statusIdx] || "").trim();
					return drv === driverName.toLowerCase() && activeRe.test(sts);
				});
				if (hasActive) {
					return res.status(409).json({
						error: "You already have an active job. Complete it before starting another.",
					});
				}
			}
		}

		// Read current row to get old status for logging
		const rowRes = await sheets.spreadsheets.values.get({
			spreadsheetId: SPREADSHEET_ID,
			range: `Job Tracking!A${rowIndex}:${colLetter(headers.length - 1)}${rowIndex}`,
		});
		const currentRow = (rowRes.data.values || [])[0] || [];
		const oldStatus = currentRow[statusIdx] || "";

		// Build batch update for status column + date column
		const now = new Date();
		const dateTime = `${(now.getMonth() + 1).toString().padStart(2, "0")}/${now.getDate().toString().padStart(2, "0")}/${now.getFullYear()} ${now.getHours()}:${now.getMinutes().toString().padStart(2, "0")}:${now.getSeconds().toString().padStart(2, "0")}`;
		const updateData = [
			{ range: `Job Tracking!${colLetter(statusIdx)}${rowIndex}`, values: [[newStatus]] },
		];
		if (dateIdx !== -1) {
			updateData.push({ range: `Job Tracking!${colLetter(dateIdx)}${rowIndex}`, values: [[dateTime]] });
		}

		await sheets.spreadsheets.values.batchUpdate({
			spreadsheetId: SPREADSHEET_ID,
			requestBody: {
				valueInputOption: "USER_ENTERED",
				data: updateData,
			},
		});

		// Append log entry to Status Logs
		const logId = `LOG-${now.getTime()}`;
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
		insertDispatchNotification.run(
			'status-updated',
			`${driverName}: ${newStatus}`,
			`Load ${loadId}`,
			JSON.stringify({ loadId, driverName, newStatus })
		);
		io.to("dispatch").emit("dispatch-notification", {
			type: 'status-updated',
			title: `${driverName}: ${newStatus}`,
			body: `Load ${loadId}`,
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
		const { from, to, message, loadId, attachmentUrl, attachmentType, assetRef } = req.body;
		if (!from || !to || (!message && !attachmentUrl && !assetRef)) {
			return res.status(400).json({ error: "from, to, and message required" });
		}

		const timestamp = new Date().toISOString();
		const result = db
			.prepare(
				`INSERT INTO messages (timestamp, "from", "to", message, load_id, attachment_url, attachment_type, asset_ref)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(timestamp, from, to, message || "", loadId || "", attachmentUrl || "", attachmentType || "", assetRef || "");

		// Persist notification for recipient
		const msgNotif = insertNotification.run(
			to.trim().toLowerCase(), 'message',
			`New message from ${from}`,
			message.length > 100 ? message.substring(0, 100) + '...' : message,
			JSON.stringify({ from, to, loadId: loadId || '' })
		);

		// Broadcast via Socket.IO for real-time delivery
		io.emit("new-message", {
			id: result.lastInsertRowid,
			notificationId: msgNotif.lastInsertRowid,
			timestamp,
			from,
			to,
			message,
			loadId: loadId || "",
			attachment_url: attachmentUrl || "",
			attachment_type: attachmentType || "",
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

// PUT /api/notifications/read — Mark notifications as read
app.put("/api/notifications/read", requireAuth, (req, res) => {
	try {
		const { ids } = req.body;
		if (!ids || !ids.length) return res.json({ success: true });
		const placeholders = ids.map(() => "?").join(",");
		db.prepare(`UPDATE notifications SET read = 1 WHERE id IN (${placeholders})`).run(...ids);
		res.json({ success: true });
	} catch (error) {
		console.error("Error marking notifications read:", error.message);
		res.status(500).json({ error: error.message });
	}
});

// GET /api/dispatch-notifications — Fetch dispatch notifications
app.get("/api/dispatch-notifications", requireRole("Super Admin", "Dispatcher"), (req, res) => {
	try {
		const notifications = db.prepare(
			`SELECT id, type, title, body, metadata, read, created_at AS createdAt
			 FROM dispatch_notifications ORDER BY id DESC LIMIT 200`
		).all();
		const unreadCount = db.prepare(
			`SELECT COUNT(*) AS count FROM dispatch_notifications WHERE read = 0`
		).get().count;
		res.json({ notifications, unreadCount });
	} catch (error) {
		res.status(500).json({ error: error.message });
	}
});

// PUT /api/dispatch-notifications/read — Mark dispatch notifications as read
app.put("/api/dispatch-notifications/read", requireRole("Super Admin", "Dispatcher"), (req, res) => {
	try {
		const { ids } = req.body;
		if (ids && ids.length) {
			const placeholders = ids.map(() => "?").join(",");
			db.prepare(`UPDATE dispatch_notifications SET read = 1 WHERE id IN (${placeholders})`).run(...ids);
		} else {
			db.prepare(`UPDATE dispatch_notifications SET read = 1 WHERE read = 0`).run();
		}
		res.json({ success: true });
	} catch (error) {
		res.status(500).json({ error: error.message });
	}
});

// GET /api/investor/messages — Investor's own message thread with dispatch
app.get("/api/investor/messages", requireRole("Super Admin", "Investor"), (req, res) => {
	try {
		const user = req.session.user;
		const name = user.username.trim().toLowerCase();
		const messages = db.prepare(
			`SELECT id, timestamp, "from", "to", message, load_id AS loadId, read, attachment_url, attachment_type, asset_ref
			 FROM messages
			 WHERE LOWER("from") = ? OR LOWER("to") = ?
			 ORDER BY id ASC`
		).all(name, name);
		// Mark messages to this investor as read
		db.prepare(`UPDATE messages SET read = 1 WHERE LOWER("to") = ? AND read = 0`).run(name);
		res.json({ messages });
	} catch (err) {
		console.error("Error fetching investor messages:", err.message);
		res.status(500).json({ error: err.message });
	}
});

// GET /api/messages — All messages for dispatch view (Admin/Dispatcher)
app.get("/api/messages", requireRole("Super Admin", "Dispatcher"), (req, res) => {
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
app.get("/api/messages/:driverName", requireRole("Super Admin", "Dispatcher"), (req, res) => {
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
		const VALID_EXPENSE_TYPES = ['Fuel', 'Repair', 'Maintenance', 'Wear & Tear', 'Toll', 'Food', 'Other'];
		if (!VALID_EXPENSE_TYPES.includes(type)) {
			return res.status(400).json({ error: "Invalid expense type" });
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

// Helper: convert image buffer(s) to PDF buffer (supports multi-page)
function imageToPdf(imageBuffers) {
	const buffers = Array.isArray(imageBuffers) ? imageBuffers : [imageBuffers];
	return new Promise((resolve, reject) => {
		const doc = new PDFDocument({ autoFirstPage: false });
		const chunks = [];
		doc.on("data", (chunk) => chunks.push(chunk));
		doc.on("end", () => resolve(Buffer.concat(chunks)));
		doc.on("error", reject);
		for (const buf of buffers) {
			const img = doc.openImage(buf);
			doc.addPage({ size: [img.width, img.height] });
			doc.image(img, 0, 0);
		}
		doc.end();
	});
}

// Helper: OCR text extraction for receipts
async function extractReceiptText(imageBuffer) {
	try {
		const Tesseract = require("tesseract.js");
		const {
			data: { text },
		} = await Tesseract.recognize(imageBuffer, "eng");
		return text.trim();
	} catch (err) {
		console.error("OCR failed:", err.message);
		return "";
	}
}

// GET /api/documents/:loadId — Fetch all documents for a load
app.get("/api/documents/:loadId", requireAuth, (req, res) => {
	try {
		const loadId = decodeURIComponent(req.params.loadId);
		const docs = db
			.prepare(
				`SELECT id, load_id, driver, type, file_name, drive_file_id, drive_url, uploaded_at, ocr_text
				 FROM documents WHERE load_id = ? ORDER BY uploaded_at DESC`,
			)
			.all(loadId);
		res.json({ documents: docs });
	} catch (error) {
		console.error("Error fetching documents:", error.message);
		res.status(500).json({ error: error.message });
	}
});

// GET /api/legal-documents — Legal docs for investor's trucks
app.get("/api/legal-documents", requireRole("Super Admin", "Investor"), (req, res) => {
	try {
		const user = req.session.user;
		const isSuperAdmin = user.role === "Super Admin";
		const truckId = req.query.truckId ? parseInt(req.query.truckId) : null;
		let docs;
		if (isSuperAdmin) {
			if (truckId) {
				docs = db.prepare(`SELECT ld.*, t.make, t.model FROM legal_documents ld LEFT JOIN trucks t ON t.id = ld.truck_id WHERE ld.truck_id = ? ORDER BY ld.uploaded_at DESC`).all(truckId);
			} else {
				docs = db.prepare(`SELECT ld.*, t.make, t.model FROM legal_documents ld LEFT JOIN trucks t ON t.id = ld.truck_id ORDER BY ld.uploaded_at DESC`).all();
			}
		} else {
			const owned = db.prepare("SELECT id FROM trucks WHERE owner_id = ?").all(user.id).map(t => t.id);
			if (owned.length === 0) return res.json({ documents: [] });
			const ph = owned.map(() => '?').join(',');
			const baseQ = `SELECT ld.*, t.make, t.model FROM legal_documents ld LEFT JOIN trucks t ON t.id = ld.truck_id WHERE ld.truck_id IN (${ph})`;
			docs = truckId && owned.includes(truckId)
				? db.prepare(baseQ + ' AND ld.truck_id = ? ORDER BY ld.uploaded_at DESC').all(...owned, truckId)
				: db.prepare(baseQ + ' ORDER BY ld.uploaded_at DESC').all(...owned);
		}
		res.json({ documents: docs });
	} catch (err) {
		console.error("Error fetching legal documents:", err.message);
		res.status(500).json({ error: err.message });
	}
});

// POST /api/legal-documents/upload — Super Admin uploads a legal doc per truck
app.post("/api/legal-documents/upload", requireRole("Super Admin"), async (req, res) => {
	try {
		const { truckId, unitNumber, docType, fileData, fileName, notes } = req.body;
		if (!truckId || !fileData || !fileName) {
			return res.status(400).json({ error: "truckId, fileData, and fileName are required" });
		}
		if (fileData.length > 13_500_000) {
			return res.status(400).json({ error: "File too large (max 10MB)" });
		}
		const validTypes = ['Vehicle Title','Registration','Insurance COI','Lease Agreement','Maintenance Records','Other'];
		const safeType = validTypes.includes(docType) ? docType : 'Other';
		const ext = require("path").extname(fileName) || '.pdf';
		const safeName = `${(unitNumber||'truck').replace(/[^a-zA-Z0-9]/g,'_')}_${safeType.replace(/\s+/g,'_')}_${Date.now()}${ext}`;
		const legalDir = require("path").join(__dirname, "uploads", "legal");
		if (!require("fs").existsSync(legalDir)) require("fs").mkdirSync(legalDir, { recursive: true });
		const base64 = fileData.replace(/^data:[^;]+;base64,/, "");
		require("fs").writeFileSync(require("path").join(legalDir, safeName), Buffer.from(base64, "base64"));
		const fileUrl = `/uploads/legal/${safeName}`;
		const result = db.prepare(
			`INSERT INTO legal_documents (truck_id, unit_number, doc_type, file_name, file_url, notes, uploaded_by) VALUES (?,?,?,?,?,?,?)`
		).run(parseInt(truckId), unitNumber || '', safeType, fileName, fileUrl, notes || '', req.session.user.username);
		res.json({ success: true, id: result.lastInsertRowid, fileUrl });
	} catch (err) {
		console.error("Legal doc upload error:", err.message);
		res.status(500).json({ error: err.message });
	}
});

// DELETE /api/legal-documents/:id — Super Admin removes a legal doc
app.delete("/api/legal-documents/:id", requireRole("Super Admin"), (req, res) => {
	try {
		const id = parseInt(req.params.id);
		const doc = db.prepare("SELECT * FROM legal_documents WHERE id = ?").get(id);
		if (!doc) return res.status(404).json({ error: "Document not found" });
		if (doc.file_url) {
			const filePath = require("path").join(__dirname, doc.file_url);
			try { require("fs").unlinkSync(filePath); } catch { /* file may already be gone */ }
		}
		db.prepare("DELETE FROM legal_documents WHERE id = ?").run(id);
		res.json({ success: true });
	} catch (err) {
		res.status(500).json({ error: err.message });
	}
});

// POST /api/chat/attachment — Upload file for chat message
app.post("/api/chat/attachment", requireAuth, async (req, res) => {
	try {
		const { fileData, fileName, mimeType } = req.body;
		if (!fileData || !fileName) return res.status(400).json({ error: "fileData and fileName required" });
		if (fileData.length > 13_500_000) return res.status(400).json({ error: "File too large (max 10MB)" });
		const attachmentType = (mimeType || '').startsWith('image/') ? 'image' : (mimeType === 'application/pdf' ? 'pdf' : 'other');
		const ext = require("path").extname(fileName) || (attachmentType === 'image' ? '.jpg' : '.bin');
		const safeName = `chat_${Date.now()}_${Math.random().toString(36).slice(2,7)}${ext}`;
		const chatDir = require("path").join(__dirname, "uploads", "chat");
		if (!require("fs").existsSync(chatDir)) require("fs").mkdirSync(chatDir, { recursive: true });
		const base64 = fileData.replace(/^data:[^;]+;base64,/, "");
		require("fs").writeFileSync(require("path").join(chatDir, safeName), Buffer.from(base64, "base64"));
		res.json({ success: true, fileUrl: `/uploads/chat/${safeName}`, attachmentType });
	} catch (err) {
		console.error("Chat attachment error:", err.message);
		res.status(500).json({ error: err.message });
	}
});

// GET /api/investor/documents — All documents for the investor's drivers
app.get("/api/investor/documents", requireRole("Super Admin", "Investor"), async (req, res) => {
	try {
		const user = req.session.user;
		const isSuperAdmin = user.role === "Super Admin";
		let docs;
		if (isSuperAdmin) {
			docs = db.prepare(
				`SELECT id, load_id, driver, type, file_name, drive_url, uploaded_at
				 FROM documents ORDER BY uploaded_at DESC LIMIT 500`
			).all();
		} else {
			const ownedTrucks = db.prepare(
				"SELECT assigned_driver FROM trucks WHERE owner_id = ? AND assigned_driver != ''"
			).all(user.id);
			if (ownedTrucks.length === 0) return res.json({ documents: [] });
			const drivers = ownedTrucks.map(t => t.assigned_driver.trim().toLowerCase());
			const placeholders = drivers.map(() => '?').join(',');
			docs = db.prepare(
				`SELECT id, load_id, driver, type, file_name, drive_url, uploaded_at
				 FROM documents WHERE LOWER(driver) IN (${placeholders})
				 ORDER BY uploaded_at DESC LIMIT 500`
			).all(...drivers);
		}
		res.json({ documents: docs });
	} catch (err) {
		console.error("Error fetching investor documents:", err.message);
		res.status(500).json({ error: err.message });
	}
});

// GET /api/investor/tax-csv — Download tax shield data as CSV
app.get("/api/investor/tax-csv", requireRole("Super Admin", "Investor"), async (req, res) => {
	try {
		const user = req.session.user;
		const isSuperAdmin = user.role === "Super Admin";

		// Pull investor config for purchase price
		const globalCfg = db.prepare("SELECT key, value FROM investor_config WHERE owner_id = 0").all();
		const config = {};
		globalCfg.forEach(r => (config[r.key] = r.value));
		if (!isSuperAdmin) {
			const investorCfg = db.prepare("SELECT key, value FROM investor_config WHERE owner_id = ?").all(user.id);
			investorCfg.forEach(r => (config[r.key] = r.value));
		}
		const purchasePrice = parseFloat(config.purchase_price) || 58000;
		const totalTrucks = isSuperAdmin
			? db.prepare("SELECT COUNT(*) AS cnt FROM trucks").get().cnt
			: db.prepare("SELECT COUNT(*) AS cnt FROM trucks WHERE owner_id = ?").get(user.id).cnt;
		const totalPurchasePrice = purchasePrice * totalTrucks;
		const totalStartupExpenses = 5000 * totalTrucks;
		const section179 = purchasePrice;
		const annualDepreciation = purchasePrice;

		// Net revenue
		let netRevenueToDate = 0;
		try {
			const sheets = await getSheets();
			const rng = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: "Job Tracking" });
			const jt = parseSheet({ data: { values: rng.data.values } });
			const jtRateCol = findCol(jt.headers, /rate|amount|revenue|pay|charge|price|cost/i);
			const jtDriverCol = findCol(jt.headers, /driver/i);
			let totalRevenue = 0;
			let driverSet = null;
			if (!isSuperAdmin) {
				const owned = db.prepare("SELECT assigned_driver FROM trucks WHERE owner_id = ? AND assigned_driver != ''").all(user.id);
				driverSet = new Set(owned.map(t => t.assigned_driver.trim().toLowerCase()));
			}
			jt.data.forEach(r => {
				if (driverSet && jtDriverCol) {
					const d = (r[jtDriverCol] || "").trim().toLowerCase();
					if (!driverSet.has(d)) return;
				}
				if (jtRateCol) totalRevenue += parseFloat(String(r[jtRateCol] || "0").replace(/[$,]/g, "")) || 0;
			});
			const expClause = isSuperAdmin
				? db.prepare("SELECT COALESCE(SUM(amount),0) AS t FROM expenses").get().t
				: (() => {
					const drivers = db.prepare("SELECT assigned_driver FROM trucks WHERE owner_id = ? AND assigned_driver != ''").all(user.id).map(t => t.assigned_driver.trim().toLowerCase());
					if (!drivers.length) return 0;
					const ph = drivers.map(() => "?").join(",");
					return db.prepare(`SELECT COALESCE(SUM(amount),0) AS t FROM expenses WHERE LOWER(driver) IN (${ph})`).get(...drivers).t;
				})();
			netRevenueToDate = Math.round(totalRevenue - expClause);
		} catch { /* if sheets fail, use 0 */ }

		const atRiskCapital = Math.max(0, (totalPurchasePrice + totalStartupExpenses) - netRevenueToDate);
		const today = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
		const ownerLabel = isSuperAdmin ? "All Investors" : user.username;

		const rows = [
			["LogisX Tax Shield Summary"],
			["Generated", today],
			["Investor", ownerLabel],
			[""],
			["Field", "Value"],
			["Purchase Price (per truck)", `$${purchasePrice.toLocaleString("en-US")}`],
			["Total Trucks", totalTrucks],
			["Total Fleet Purchase Price", `$${totalPurchasePrice.toLocaleString("en-US")}`],
			["Startup Expenses (est. $5,000/truck)", `$${totalStartupExpenses.toLocaleString("en-US")}`],
			["Section 179 Deduction (100%)", `$${section179.toLocaleString("en-US")}`],
			["Annual Depreciation (Year 1)", `$${annualDepreciation.toLocaleString("en-US")}`],
			["Write-Off Percentage", "100%"],
			["Net Revenue to Date", `$${netRevenueToDate.toLocaleString("en-US")}`],
			["At-Risk Capital Remaining", `$${atRiskCapital.toLocaleString("en-US")}`],
			[""],
			["Note", "Section 179 allows 100% first-year deduction of qualifying business property."],
			["Disclaimer", "Consult a licensed tax professional before filing."],
		];

		const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\r\n");
		const filename = `tax-shield-${user.username}-${new Date().toISOString().slice(0, 10)}.csv`;
		res.setHeader("Content-Type", "text/csv");
		res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
		res.send(csv);
	} catch (err) {
		console.error("Tax CSV error:", err.message);
		res.status(500).json({ error: err.message });
	}
});

// GET /api/investor/report — Generate PDF performance report
app.get("/api/investor/report", requireRole("Super Admin", "Investor"), async (req, res) => {
	try {
		// Re-use the investor data by making an internal call
		const user = req.session.user;
		const isSuperAdmin = user.role === "Super Admin";

		// Fetch the same investor data inline (mirrors /api/investor logic summary)
		const sheets = await getSheets();
		const response = await sheets.spreadsheets.values.batchGet({
			spreadsheetId: SPREADSHEET_ID,
			ranges: ["Job Tracking", "Payments Table"],
		});
		const rangeData = response.data.valueRanges || [];
		const jobTracking = parseSheet(rangeData[0]);
		jobTracking.data = deduplicateLoads(jobTracking.data, jobTracking.headers);
		const payments = parseSheet(rangeData[1]);

		let investorDriverSet = null;
		if (!isSuperAdmin) {
			const ownedTrucks = db.prepare("SELECT assigned_driver FROM trucks WHERE owner_id = ? AND assigned_driver != ''").all(user.id);
			investorDriverSet = new Set(ownedTrucks.map(t => t.assigned_driver.trim().toLowerCase()));
		}

		const globalCfg = db.prepare("SELECT key, value FROM investor_config WHERE owner_id = 0").all();
		const config = {};
		globalCfg.forEach(r => (config[r.key] = r.value));
		if (!isSuperAdmin) {
			db.prepare("SELECT key, value FROM investor_config WHERE owner_id = ?").all(user.id)
				.forEach(r => (config[r.key] = r.value));
		}

		// Date range filter (RFD-26)
		const filterStart = req.query.start ? new Date(req.query.start) : null;
		const filterEnd = req.query.end ? new Date(req.query.end + 'T23:59:59') : null;

		const driverCol = findCol(jobTracking.headers, /^driver$/i);
		const jtDateColR = findCol(jobTracking.headers, /status.*update.*date|completion.*date|assigned.*date/i) || findCol(jobTracking.headers, /date/i);
		const filteredJobData = (investorDriverSet
			? jobTracking.data.filter(r => {
				const d = driverCol ? (r[driverCol] || "").trim().toLowerCase() : "";
				return d && investorDriverSet.has(d);
			}) : jobTracking.data
		).filter(r => {
			if (!filterStart && !filterEnd) return true;
			const d = jtDateColR ? new Date(r[jtDateColR]) : null;
			if (!d || isNaN(d)) return false;
			if (filterStart && d < filterStart) return false;
			if (filterEnd && d > filterEnd) return false;
			return true;
		});

		const rateCol = findCol(payments.headers, /rate|amount|total|pay/i);
		const payStatusCol = findCol(payments.headers, /pay.*status|status/i);
		const payLoadIdCol = findCol(payments.headers, /load.?id|job.?id/i);
		const jobLoadIdCol = findCol(jobTracking.headers, /load.?id|job.?id/i);
		const investorLoadIds = investorDriverSet && jobLoadIdCol
			? new Set(filteredJobData.map(r => (r[jobLoadIdCol] || "").trim().toLowerCase()).filter(Boolean))
			: null;
		const filteredPayments = investorDriverSet
			? payments.data.filter(r => {
				if (payLoadIdCol && investorLoadIds) {
					const lid = (r[payLoadIdCol] || "").trim().toLowerCase();
					if (lid && investorLoadIds.has(lid)) return true;
				}
				return false;
			}) : payments.data;

		const jtRateCol2 = findCol(jobTracking.headers, /payment|rate|amount|revenue/i);
		const jtDateCol2 = findCol(jobTracking.headers, /status.*update.*date|completion.*date|assigned.*date/i) || findCol(jobTracking.headers, /date/i);
		const paymentsHaveDates2 = filteredPayments.some(r => findCol(payments.headers, /date/i) && r[findCol(payments.headers, /date/i)]);

		let totalRevenue = 0, paidRevenue = 0;
		filteredPayments.forEach(r => {
			const amt = parseFloat(String(rateCol ? r[rateCol] : "0").replace(/[$,]/g, "")) || 0;
			totalRevenue += amt;
			const ps = payStatusCol ? (r[payStatusCol] || "").trim() : "";
			if (/^paid$/i.test(ps)) paidRevenue += amt;
		});
		if (!paymentsHaveDates2 && paidRevenue === 0) {
			filteredJobData.forEach(r => {
				paidRevenue += parseFloat(String((r[jtRateCol2] || "0")).replace(/[$,]/g, "")) || 0;
			});
		}

		const purchasePrice = parseFloat(config.truck_purchase_price) || 58000;
		const ownedTrucks2 = isSuperAdmin
			? db.prepare("SELECT * FROM trucks").all()
			: db.prepare("SELECT * FROM trucks WHERE owner_id = ?").all(user.id);
		const totalTrucks = ownedTrucks2.length || 1;
		const totalPurchasePrice = purchasePrice * totalTrucks;
		const totalStartupExpenses = 5000 * totalTrucks;
		const currentValue = Math.round(purchasePrice * 0.80);

		let totalExpenses = 0;
		let fuelExpenses = 0, maintenanceExpenses = 0, complianceExpenses = 0, otherExpenses = 0;
		const dateWhereExp = filterStart ? ` AND date >= '${filterStart.toISOString().slice(0,10)}'` : '';
		const dateWhereExpEnd = filterEnd ? ` AND date <= '${filterEnd.toISOString().slice(0,10)}'` : '';
		if (investorDriverSet && investorDriverSet.size > 0) {
			const driverList = [...investorDriverSet];
			const ph = driverList.map(() => '?').join(',');
			// Itemized expenses by type
			const expRows = db.prepare(`SELECT LOWER(type) AS t, COALESCE(SUM(amount),0) AS total FROM expenses WHERE LOWER(driver) IN (${ph})${dateWhereExp}${dateWhereExpEnd} GROUP BY LOWER(type)`).all(...driverList);
			expRows.forEach(r => {
				if (/fuel/i.test(r.t)) fuelExpenses += r.total;
				else if (/maint|repair|tire|oil/i.test(r.t)) maintenanceExpenses += r.total;
				else otherExpenses += r.total;
				totalExpenses += r.total;
			});
			const maintTotal = (db.prepare(`SELECT COALESCE(SUM(mf.amount),0) AS t FROM maintenance_fund mf INNER JOIN trucks t ON LOWER(mf.truck)=LOWER(t.unit_number) WHERE t.owner_id=?`).get(user.id)).t;
			maintenanceExpenses += maintTotal;
			totalExpenses += maintTotal;
			const compTotal = (db.prepare(`SELECT COALESCE(SUM(cf.amount),0) AS t FROM compliance_fees cf INNER JOIN trucks t ON LOWER(cf.truck)=LOWER(t.unit_number) WHERE t.owner_id=? AND cf.status='Paid'`).get(user.id)).t;
			complianceExpenses += compTotal;
			totalExpenses += compTotal;
		}
		const netRevenueToDate = Math.round(totalRevenue - totalExpenses);
		const netCashFlow = totalRevenue - totalExpenses;
		const ownerEarnings = netCashFlow * 0.5;

		// Monthly revenue from Job Tracking
		const monthlyRevenue2 = {};
		if (jtDateCol2 && jtRateCol2) {
			filteredJobData.forEach(r => {
				const amt = parseFloat(String((r[jtRateCol2] || "0")).replace(/[$,]/g, "")) || 0;
				if (!amt) return;
				const d = new Date(r[jtDateCol2]);
				if (!isNaN(d)) {
					const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
					monthlyRevenue2[key] = (monthlyRevenue2[key] || 0) + amt;
				}
			});
		}
		const monthlyData2 = Object.entries(monthlyRevenue2)
			.sort(([a],[b]) => a.localeCompare(b))
			.map(([month, amount]) => ({ month, amount: Math.round(amount) }));

		const completedStatuses = /^(delivered|completed|pod received)$/i;
		const statusCol2 = findCol(jobTracking.headers, /status/i);
		const completedJobs = statusCol2 ? filteredJobData.filter(r => completedStatuses.test((r[statusCol2]||"").trim())).length : 0;

		// Build PDF
		const PDFDocument = require("pdfkit");
		const doc = new PDFDocument({ margin: 50, size: "LETTER" });
		const chunks = [];
		doc.on("data", c => chunks.push(c));

		const fmt = n => "$" + Number(n||0).toLocaleString("en-US", { maximumFractionDigits: 0 });
		const dateStr = new Date().toLocaleDateString("en-US", { weekday:"long", year:"numeric", month:"long", day:"numeric" });
		const investorName = isSuperAdmin ? "Super Admin" : user.username;
		const periodStr = filterStart || filterEnd
			? `Period: ${filterStart ? filterStart.toLocaleDateString("en-US") : "All"} – ${filterEnd ? filterEnd.toLocaleDateString("en-US") : "Today"}`
			: "All-time";

		// ── Header
		doc.rect(0, 0, doc.page.width, 80).fill("#0f3460");
		doc.fillColor("#ffffff").fontSize(22).font("Helvetica-Bold")
			.text(`${investorName} — Asset Dashboard`, 50, 18);
		doc.fontSize(10).font("Helvetica").fillColor("rgba(255,255,255,0.7)")
			.text(`Performance Report  ·  ${dateStr}`, 50, 45);
		doc.fontSize(9).fillColor("rgba(255,255,255,0.5)")
			.text(periodStr, 50, 62);
		doc.moveDown(3).fillColor("#000000");

		// ── Helper: section header
		const sectionHeader = (title) => {
			doc.moveDown(0.5)
				.rect(50, doc.y, doc.page.width - 100, 22).fill("#e8f4fd")
				.fillColor("#0f3460").fontSize(11).font("Helvetica-Bold")
				.text(title, 58, doc.y - 17)
				.fillColor("#333333").font("Helvetica").fontSize(10)
				.moveDown(0.8);
		};

		// ── Helper: two-column KPI row
		const kpiRow = (label, value, label2, value2) => {
			const y = doc.y;
			doc.font("Helvetica-Bold").fontSize(9).fillColor("#666").text(label.toUpperCase(), 50, y, { width: 200 });
			doc.font("Helvetica-Bold").fontSize(13).fillColor("#0f3460").text(value, 50, y + 11, { width: 200 });
			if (label2) {
				doc.font("Helvetica-Bold").fontSize(9).fillColor("#666").text(label2.toUpperCase(), 280, y, { width: 200 });
				doc.font("Helvetica-Bold").fontSize(13).fillColor("#0f3460").text(value2 || "—", 280, y + 11, { width: 200 });
			}
			doc.moveDown(1.8);
		};

		// ── Production
		sectionHeader("Production Performance");
		kpiRow("Total Revenue", fmt(totalRevenue), "Paid / Collected", fmt(paidRevenue));
		kpiRow("Completed Loads", String(completedJobs), "Total Jobs", String(filteredJobData.length));

		// ── Asset
		sectionHeader("Asset Security");
		kpiRow("Purchase Price (per truck)", fmt(purchasePrice), "Current Market Value (80%)", fmt(currentValue));
		kpiRow("Fleet Size", String(totalTrucks), "Total Purchase Price", fmt(totalPurchasePrice));
		kpiRow("Title Status", config.truck_title_status || "Clean", "Depreciation", "100% Year 1 (Sec. 179)");

		// ── Cash Flow
		sectionHeader("Cash Flow & Projections");
		kpiRow("Net Cash Flow", fmt(netCashFlow), "Owner Earnings (50%)", fmt(ownerEarnings));
		kpiRow("Total Expenses", fmt(totalExpenses), "Net Revenue To Date", fmt(netRevenueToDate));
		const totalInv = totalPurchasePrice + totalStartupExpenses;
		const recPct = totalInv > 0 ? Math.min(100, (netRevenueToDate / totalInv * 100)).toFixed(1) : "0";
		kpiRow("Total Investment", fmt(totalInv), "Payoff Progress", `${recPct}%`);
		const roiPct = totalRevenue > 0 ? (netRevenueToDate / totalRevenue * 100).toFixed(1) : "0";
		kpiRow("Business ROI", `${roiPct}%`, "Section 179 Deduction", fmt(purchasePrice));

		// ── P&L Statement (RFD-26)
		sectionHeader("Income Statement (Profit & Loss)");
		const plLines = [
			{ label: "Gross Revenue", value: fmt(totalRevenue), indent: false, bold: true },
			{ label: "  Fuel Expenses", value: `(${fmt(fuelExpenses)})`, indent: true, bold: false },
			{ label: "  Maintenance & Repairs", value: `(${fmt(maintenanceExpenses)})`, indent: true, bold: false },
			{ label: "  Compliance / Regulatory", value: `(${fmt(complianceExpenses)})`, indent: true, bold: false },
			{ label: "  Other Expenses", value: `(${fmt(otherExpenses)})`, indent: true, bold: false },
			{ label: "Total Expenses", value: `(${fmt(totalExpenses)})`, indent: false, bold: false },
			{ label: "Net Profit", value: fmt(netCashFlow), indent: false, bold: true },
			{ label: "Investor Payout (50%)", value: fmt(ownerEarnings), indent: false, bold: true },
		];
		const plX = 50, plW = doc.page.width - 100;
		plLines.forEach((line, i) => {
			if (i === plLines.length - 3) { // separator before net profit
				doc.moveTo(plX, doc.y).lineTo(plX + plW, doc.y).strokeColor("#cccccc").stroke();
				doc.moveDown(0.3);
			}
			const y = doc.y;
			doc.font(line.bold ? "Helvetica-Bold" : "Helvetica").fontSize(10).fillColor(line.indent ? "#555555" : "#000000")
				.text(line.label, plX + (line.indent ? 15 : 0), y, { width: plW - 80 })
				.font(line.bold ? "Helvetica-Bold" : "Helvetica").fillColor(line.bold ? "#0f3460" : "#333333")
				.text(line.value, plX + plW - 80, y, { width: 80, align: "right" });
			doc.moveDown(0.6);
		});
		doc.moveDown(0.5);

		// ── Monthly Revenue Table
		if (monthlyData2.length > 0) {
			sectionHeader("Monthly Revenue");
			const colW = [120, 100];
			const tableX = 50;
			let ty = doc.y;
			doc.rect(tableX, ty, colW[0] + colW[1], 18).fill("#e8f4fd");
			doc.fillColor("#0f3460").font("Helvetica-Bold").fontSize(9)
				.text("Month", tableX + 5, ty + 5, { width: colW[0] })
				.text("Revenue", tableX + colW[0] + 5, ty + 5, { width: colW[1] });
			ty += 18;
			monthlyData2.forEach((m, i) => {
				if (ty > doc.page.height - 100) { doc.addPage(); ty = 50; }
				doc.rect(tableX, ty, colW[0] + colW[1], 16).fill(i % 2 === 0 ? "#ffffff" : "#f8f9fa");
				doc.fillColor("#333333").font("Helvetica").fontSize(9)
					.text(m.month, tableX + 5, ty + 4, { width: colW[0] })
					.text(fmt(m.amount), tableX + colW[0] + 5, ty + 4, { width: colW[1] });
				ty += 16;
			});
			doc.y = ty + 10;
		}

		// ── Per-Truck
		if (ownedTrucks2.length > 0) {
			sectionHeader("Fleet Breakdown");
			ownedTrucks2.forEach(t => {
				kpiRow(
					`Unit ${t.unit_number}`,
					`${t.make||""} ${t.model||""}`.trim() || "—",
					"Driver",
					t.assigned_driver || "Unassigned"
				);
			});
		}

		// ── Footer
		doc.on("pageAdded", () => {
			doc.rect(0, doc.page.height - 30, doc.page.width, 30).fill("#f0f0f0");
			doc.fillColor("#999").fontSize(8).font("Helvetica")
				.text(`Generated by LogisX  ·  ${dateStr}`, 50, doc.page.height - 20);
		});
		doc.rect(0, doc.page.height - 30, doc.page.width, 30).fill("#f0f0f0");
		doc.fillColor("#999").fontSize(8).font("Helvetica")
			.text(`Generated by LogisX  ·  ${dateStr}`, 50, doc.page.height - 20);

		doc.end();
		await new Promise(resolve => doc.on("end", resolve));

		const pdfBuffer = Buffer.concat(chunks);
		const fileName = `${investorName.replace(/\s+/g,"_")}_Report_${new Date().toISOString().slice(0,10)}.pdf`;
		res.setHeader("Content-Type", "application/pdf");
		res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
		res.send(pdfBuffer);
	} catch (err) {
		console.error("Report generation error:", err.message);
		res.status(500).json({ error: "Failed to generate report" });
	}
});

// POST /api/documents/upload — Upload document (images → PDF, or direct file)
app.post("/api/documents/upload", requireAuth, async (req, res) => {
	try {
		const { loadId, rowIndex, photoData, driverName, fileType, fileName: clientFileName } = req.body;
		const docType = req.body.docType || req.body.type || "POD";
		if (!loadId || !rowIndex || !photoData) {
			return res
				.status(400)
				.json({ error: "Please select a file before uploading." });
		}

		const timestamp = Date.now();
		let fileBuffer;
		let fileName;
		let driveUrl = "";

		if (fileType === 'document') {
			// Direct document upload (PDF, Word, etc.) — no image conversion
			const base64 = (typeof photoData === 'string' ? photoData : '').replace(/^data:[^;]+;base64,/, "");
			fileBuffer = Buffer.from(base64, "base64");
			const ext = clientFileName ? path.extname(clientFileName) : '.pdf';
			fileName = `${loadId}_${docType}_${timestamp}${ext}`;
		} else {
			// Image upload — convert to multi-page PDF
			const photoArray = Array.isArray(photoData) ? photoData : [photoData];
			const imageBuffers = photoArray.map(p => {
				const base64 = p.replace(/^data:image\/\w+;base64,/, "");
				return Buffer.from(base64, "base64");
			});
			try {
				fileBuffer = await imageToPdf(imageBuffers);
			} catch (pdfErr) {
				console.error("Image-to-PDF error:", pdfErr.message);
				return res.status(400).json({ error: "The photo could not be processed. Please try taking a new photo." });
			}
			fileName = `${loadId}_${docType}_${timestamp}.pdf`;
		}

		// Save to local disk
		try {
			const uploadsDir = path.join(__dirname, "uploads");
			if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
			fs.writeFileSync(path.join(uploadsDir, fileName), fileBuffer);
			driveUrl = `/uploads/${fileName}`;
		} catch (localErr) {
			console.error("Local file save error:", localErr.message);
			return res.status(500).json({ error: "Could not save the document. Please try again." });
		}

		// Mark sheet column only for POD uploads (non-critical — don't block upload)
		if (docType === "POD") {
			try {
				const sheets = await getSheets();
				const headerResp = await sheets.spreadsheets.values.get({
					spreadsheetId: SPREADSHEET_ID,
					range: "Job Tracking!1:1",
				});
				const headers = (headerResp.data.values || [[]])[0];
				const podColIdx = headers.findIndex((h) =>
					/pod.*upload|^documents$/i.test(h),
				);
				if (podColIdx >= 0) {
					const podColLetter = colLetter(podColIdx);
					await sheets.spreadsheets.values.update({
						spreadsheetId: SPREADSHEET_ID,
						range: `Job Tracking!${podColLetter}${rowIndex}`,
						valueInputOption: "USER_ENTERED",
						requestBody: { values: [["Yes"]] },
					});
				}
			} catch (sheetErr) {
				console.error("Sheet POD column update error (non-critical):", sheetErr.message);
			}
		}

		// OCR for receipts (images only)
		let ocrText = "";
		if (docType === "Receipt" && fileType !== 'document') {
			const photoArray = Array.isArray(photoData) ? photoData : [photoData];
			const firstBuf = Buffer.from(photoArray[0].replace(/^data:image\/\w+;base64,/, ""), "base64");
			ocrText = await extractReceiptText(firstBuf);
		}

		// Store metadata in SQLite
		try {
			db.prepare(
				`INSERT INTO documents (load_id, driver, type, file_name, drive_file_id, drive_url, ocr_text)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			).run(
				loadId,
				driverName || "",
				docType,
				fileName,
				"",
				driveUrl,
				ocrText,
			);
		} catch (dbErr) {
			console.error("SQLite insert error:", dbErr.message);
			return res.status(500).json({ error: "Document was uploaded but could not be saved. Please try again." });
		}

		// Notify dispatch
		io.to("dispatch").emit("pod-uploaded", {
			loadId,
			driverName,
			driveUrl,
			docType,
		});
		insertDispatchNotification.run(
			'pod-uploaded',
			`${docType} uploaded by ${driverName || 'driver'}`,
			`Load ${loadId}`,
			JSON.stringify({ loadId, driverName, docType })
		);
		io.to("dispatch").emit("dispatch-notification", {
			type: 'pod-uploaded',
			title: `${docType} uploaded by ${driverName || 'driver'}`,
			body: `Load ${loadId}`,
		});

		res.json({ success: true, driveUrl, ocrText });
	} catch (error) {
		console.error("Error uploading document:", error.message);
		res.status(500).json({ error: "Something went wrong. Please try again or contact dispatch." });
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
		let distanceWarning = null;
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
					const rowStatusCol = headers.find((h) => /status/i.test(h));
					const rowStatus = rowStatusCol ? (loadObj[rowStatusCol] || "").trim().toLowerCase() : "";
					// Skip completed/delivered rows to avoid matching stale duplicates
					if (/^(delivered|completed|pod received|canceled)$/i.test(rowStatus)) continue;
					if (loadIdCol && loadObj[loadIdCol] === loadId) {
						const triggers = checkGeofence(latitude, longitude, loadObj, headers);
						if (triggers.length > 0) {
							geofenceTriggered = triggers[0];
							const statusCol = headers.find((h) => /status/i.test(h));
							const currentStatus = statusCol ? (loadObj[statusCol] || "").toLowerCase() : "";

							// Guard: only auto-update if status is a valid predecessor
							const canUpdate =
								(geofenceTriggered === "At Shipper" && /^(dispatched|assigned)$/i.test(currentStatus)) ||
								(geofenceTriggered === "At Receiver" && /^(in transit)$/i.test(currentStatus));

							if (canUpdate && statusCol) {
								// Update status in sheet
								const statusColIdx = headers.indexOf(statusCol);
								const statusColLetter = colLetter(statusColIdx);
								await sheets.spreadsheets.values.update({
									spreadsheetId: SPREADSHEET_ID,
									range: `Job Tracking!${statusColLetter}${i + 1}`,
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
								const geoNotif = insertNotification.run(
									driverName.trim().toLowerCase(), 'geofence',
									`Geofence: ${geofenceTriggered}`,
									`Load ${loadId}`,
									JSON.stringify({ loadId, status: geofenceTriggered })
								);
								io.to(driverName.trim().toLowerCase()).emit("geofence-trigger", {
									loadId,
									status: geofenceTriggered,
									notificationId: geoNotif.lastInsertRowid,
								});
								io.to("dispatch").emit("geofence-trigger", {
									loadId,
									driver: driverName,
									status: geofenceTriggered,
								});
								insertDispatchNotification.run(
									'geofence',
									`${driverName}: ${geofenceTriggered}`,
									`Load ${loadId} — auto-triggered by geofence`,
									JSON.stringify({ loadId, driverName, status: geofenceTriggered })
								);
								io.to("dispatch").emit("dispatch-notification", {
									type: 'geofence',
									title: `${driverName}: ${geofenceTriggered}`,
									body: `Load ${loadId} — auto-triggered by geofence`,
								});
							}
						}

						// Distance warning — check if driver is far from relevant point
						const warnStatusCol = headers.find((h) => /status/i.test(h));
						const warnStatus = warnStatusCol ? (loadObj[warnStatusCol] || "").toLowerCase() : "";
						const originLatCol = headers.find((h) => /origin.*lat|pickup.*lat|shipper.*lat/i.test(h));
						const originLngCol = headers.find((h) => /origin.*l(on|ng)|pickup.*l(on|ng)|shipper.*l(on|ng)/i.test(h));
						const destLatCol = headers.find((h) => /dest.*lat|drop.*lat|receiver.*lat|delivery.*lat/i.test(h));
						const destLngCol = headers.find((h) => /dest.*l(on|ng)|drop.*l(on|ng)|receiver.*l(on|ng)|delivery.*l(on|ng)/i.test(h));
						const originCityCol = headers.find((h) => /origin|pickup.*city|shipper.*city/i.test(h) && !/lat|lng|lon/i.test(h));
						const destCityCol = headers.find((h) => (/dest|drop.*city|receiver.*city|delivery.*city|consignee.*city/i.test(h)) && !/lat|lng|lon/i.test(h));
						const FAR_THRESHOLD = 500000; // 500 km

						const notPickedUp = /^(dispatched|assigned|)$/i.test(warnStatus);
						const inTransit = /^(in transit)$/i.test(warnStatus);

						if (notPickedUp && originLatCol && originLngCol) {
							const oLat = parseFloat(loadObj[originLatCol]);
							const oLng = parseFloat(loadObj[originLngCol]);
							if (!isNaN(oLat) && !isNaN(oLng)) {
								const dist = geolib.getDistance({ latitude, longitude }, { latitude: oLat, longitude: oLng });
								if (dist > FAR_THRESHOLD) {
									const distMiles = Math.round(dist / 1609.34);
									const pickupName = originCityCol ? (loadObj[originCityCol] || "") : "";
									distanceWarning = {
										type: "far-from-pickup",
										distanceMiles: distMiles,
										targetLat: oLat,
										targetLng: oLng,
										targetName: pickupName || "Pickup Location",
										message: `You are ${distMiles.toLocaleString()} miles from pickup${pickupName ? " (" + pickupName + ")" : ""}. Please verify your route.`,
									};
								}
							}
						} else if (inTransit && destLatCol && destLngCol) {
							const dLat = parseFloat(loadObj[destLatCol]);
							const dLng = parseFloat(loadObj[destLngCol]);
							if (!isNaN(dLat) && !isNaN(dLng)) {
								const dist = geolib.getDistance({ latitude, longitude }, { latitude: dLat, longitude: dLng });
								if (dist > FAR_THRESHOLD) {
									const distMiles = Math.round(dist / 1609.34);
									const deliveryName = destCityCol ? (loadObj[destCityCol] || "") : "";
									distanceWarning = {
										type: "far-from-delivery",
										distanceMiles: distMiles,
										targetLat: dLat,
										targetLng: dLng,
										targetName: deliveryName || "Delivery Location",
										message: `You are ${distMiles.toLocaleString()} miles from delivery${deliveryName ? " (" + deliveryName + ")" : ""}. Please verify your route.`,
									};
								}
							}
						}

						break;
					}
				}
			} catch (geoErr) {
				console.error("Geofence check error:", geoErr.message);
			}
		}

		res.json({ success: true, geofenceTriggered, distanceWarning });
	} catch (error) {
		console.error("Error storing location:", error.message);
		res.status(500).json({ error: error.message });
	}
});

// GET /api/locations/latest — Latest position per active driver with ETA
app.get("/api/locations/latest", requireRole("Super Admin", "Dispatcher"), async (req, res) => {
	try {
		// Get latest GPS position per driver (no time filter — show all)
		const gpsLocations = db.prepare(
			`SELECT dl.driver, dl.latitude, dl.longitude, dl.speed, dl.heading, dl.timestamp, dl.load_id AS loadId
			 FROM driver_locations dl
			 INNER JOIN (SELECT driver, MAX(id) AS max_id FROM driver_locations GROUP BY driver) latest
			 ON dl.id = latest.max_id`
		).all();

		// Get all drivers from Carrier Database to include those who never reported GPS
		let allDriverNames = [];
		try {
			const sheets = await getSheets();
			const carrierResp = await sheets.spreadsheets.values.get({
				spreadsheetId: SPREADSHEET_ID,
				range: "Carrier Database",
			});
			const cRows = carrierResp.data.values || [];
			if (cRows.length > 1) {
				const cHeaders = cRows[0];
				const driverCol = cHeaders.find((h) => /driver/i.test(h)) || cHeaders[0];
				const driverColIdx = cHeaders.indexOf(driverCol);
				for (let i = 1; i < cRows.length; i++) {
					const name = (cRows[i][driverColIdx] || "").trim();
					if (name) allDriverNames.push(name);
				}
			}
		} catch { /* silent */ }

		// Merge: GPS drivers + carrier drivers with no GPS
		const carrierSet = new Set(allDriverNames.map(n => n.toLowerCase()));
		const gpsMap = {};
		for (const loc of gpsLocations) gpsMap[loc.driver.toLowerCase()] = loc;

		const locations = [];
		const seen = new Set();
		for (const loc of gpsLocations) {
			if (!carrierSet.has(loc.driver.toLowerCase())) continue; // skip non-drivers (e.g. admin)
			locations.push(loc);
			seen.add(loc.driver.toLowerCase());
		}
		for (const name of allDriverNames) {
			if (!seen.has(name.toLowerCase())) {
				locations.push({
					driver: name,
					latitude: null,
					longitude: null,
					speed: 0,
					heading: 0,
					timestamp: null,
					loadId: '',
					noGps: true,
				});
				seen.add(name.toLowerCase());
			}
		}

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
			const originLatCol = headers.find((h) => /origin.*lat|pickup.*lat|shipper.*lat/i.test(h));
			const originLngCol = headers.find((h) => /origin.*l(on|ng)|pickup.*l(on|ng)|shipper.*l(on|ng)/i.test(h));
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

				// Build map of each driver's active loads from the sheet
				// Used to override stale load_ids and provide load details in the panel
				const statusCol = headers.find((h) => /status/i.test(h));
				const driverCol = headers.find((h) => /^driver$/i.test(h));
				const detailsCol = headers.find((h) => /^details$/i.test(h));
				const pickupAddrCol = headers.find((h) => /pickup.*addr|origin.*addr|shipper.*addr/i.test(h));
				const dropoffAddrCol = headers.find((h) => /drop.*addr|dest.*addr|receiver.*addr|delivery.*addr/i.test(h));
				const activeRe = /^(assigned|dispatched|at shipper|loading|in transit|at receiver|unloading)$/i;
				const workingRe = /^(assigned|at shipper|loading|in transit|at receiver)$/i;
				const driverActiveLoadMap = {};   // driver → first active loadId (for override, includes dispatched)
				const driverActiveLoadsMap = {};  // driver → working loads for panel (matches driver app's Active tab)
				if (statusCol && driverCol && loadIdCol) {
					for (let i = 1; i < rows.length; i++) {
						const obj = {};
						headers.forEach((h, idx) => { obj[h] = rows[i][idx] || ""; });
						const name = (obj[driverCol] || "").trim();
						const status = (obj[statusCol] || "").trim();
						const lid = (obj[loadIdCol] || "").trim().replace(/^#/, "");
						if (!name || !lid) continue;
						const key = name.toLowerCase();
						if (activeRe.test(status)) {
							driverActiveLoadMap[key] = lid;
						}
						if (workingRe.test(status)) {
							if (!driverActiveLoadsMap[key]) driverActiveLoadsMap[key] = [];
							const entry = { loadId: lid, status, details: detailsCol ? (obj[detailsCol] || "") : "" };
							if (pickupAddrCol) entry.pickupAddress = obj[pickupAddrCol] || "";
							if (dropoffAddrCol) entry.dropoffAddress = obj[dropoffAddrCol] || "";
							if (originLatCol && originLngCol) {
								const oLat = parseFloat(obj[originLatCol]);
								const oLng = parseFloat(obj[originLngCol]);
								if (!isNaN(oLat) && !isNaN(oLng)) { entry.originLat = oLat; entry.originLng = oLng; }
							}
							if (destLatCol && destLngCol) {
								const dLat = parseFloat(obj[destLatCol]);
								const dLng = parseFloat(obj[destLngCol]);
								if (!isNaN(dLat) && !isNaN(dLng)) { entry.destLat = dLat; entry.destLng = dLng; }
							}
							driverActiveLoadsMap[key].push(entry);
						}
					}
				}

				const DEFAULT_SPEED_MPS = 24.587; // ~55 mph in m/s

				for (const loc of locations) {
					loc.etaStatus = "unknown";
					loc.etaMinutes = null;

					// Attach all active loads for this driver
					const driverKey = (loc.driver || "").toLowerCase();
					loc.activeLoads = driverActiveLoadsMap[driverKey] || [];

					// Override stale load_id: prefer the driver's active load from Google Sheets
					const sheetActiveLoad = driverActiveLoadMap[driverKey];
					if (sheetActiveLoad && loc.loadId !== sheetActiveLoad && loadMap[sheetActiveLoad]) {
						loc.loadId = sheetActiveLoad;
					}

					if (!loc.loadId || !loadMap[loc.loadId]) continue;
					const load = loadMap[loc.loadId];

					// Attach origin coordinates
					if (originLatCol && originLngCol) {
						const oLat = parseFloat(load[originLatCol]);
						const oLng = parseFloat(load[originLngCol]);
						if (!isNaN(oLat) && !isNaN(oLng)) {
							loc.originLat = oLat;
							loc.originLng = oLng;
						}
					}

					if (destLatCol && destLngCol) {
						const dLat = parseFloat(load[destLatCol]);
						const dLng = parseFloat(load[destLngCol]);
						if (!isNaN(dLat) && !isNaN(dLng)) {
							loc.destLat = dLat;
							loc.destLng = dLng;
							if (loc.latitude == null || loc.longitude == null) continue;
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

// GET /api/load/:loadId — Look up a specific load from Job Tracking sheet
app.get("/api/load/:loadId", requireRole("Super Admin", "Dispatcher"), async (req, res) => {
	try {
		const { loadId } = req.params;
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
		if (!loadIdCol) {
			return res.status(404).json({ error: "No load ID column found in sheet" });
		}

		for (let i = 1; i < rows.length; i++) {
			const obj = {};
			headers.forEach((h, idx) => { obj[h] = rows[i][idx] || ""; });
			if (obj[loadIdCol] === loadId) {
				obj._rowIndex = i + 1;
				return res.json({ load: obj });
			}
		}

		res.status(404).json({ error: `Load ${loadId} not found` });
	} catch (error) {
		console.error("Error fetching load:", error.message);
		res.status(500).json({ error: error.message });
	}
});

// PUT /api/load/:loadId — Update specific fields of a load by load ID
app.put("/api/load/:loadId", requireRole("Super Admin", "Dispatcher"), async (req, res) => {
	try {
		const { loadId } = req.params;
		const updates = req.body; // { "Column Name": "value", ... }
		if (!updates || Object.keys(updates).length === 0) {
			return res.status(400).json({ error: "Request body with column updates required" });
		}

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
		if (!loadIdCol) {
			return res.status(404).json({ error: "No load ID column found in sheet" });
		}

		// Check for new columns that don't exist yet
		const newCols = Object.keys(updates).filter((k) => !headers.includes(k));
		if (newCols.length > 0) {
			headers.push(...newCols);
			await sheets.spreadsheets.values.update({
				spreadsheetId: SPREADSHEET_ID,
				range: `Job Tracking!A1`,
				valueInputOption: "USER_ENTERED",
				requestBody: { values: [headers] },
			});
		}

		for (let i = 1; i < rows.length; i++) {
			const obj = {};
			headers.forEach((h, idx) => { obj[h] = rows[i][idx] || ""; });
			if (obj[loadIdCol] === loadId) {
				// Apply updates to the row
				const updatedRow = headers.map((h, idx) => {
					if (updates.hasOwnProperty(h)) return updates[h];
					return rows[i][idx] || "";
				});

				await sheets.spreadsheets.values.update({
					spreadsheetId: SPREADSHEET_ID,
					range: `Job Tracking!A${i + 1}`,
					valueInputOption: "USER_ENTERED",
					requestBody: { values: [updatedRow] },
				});

				// Return updated load
				const result = {};
				headers.forEach((h, idx) => { result[h] = updatedRow[idx]; });
				result._rowIndex = i + 1;
				return res.json({ success: true, load: result });
			}
		}

		res.status(404).json({ error: `Load ${loadId} not found` });
	} catch (error) {
		console.error("Error updating load:", error.message);
		res.status(500).json({ error: error.message });
	}
});

// Decode Google Maps encoded polyline to [{latitude, longitude}] array
function decodePolyline(encoded) {
	const points = [];
	let index = 0, lat = 0, lng = 0;
	while (index < encoded.length) {
		let b, shift = 0, result = 0;
		do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
		lat += (result & 1) ? ~(result >> 1) : (result >> 1);
		shift = 0; result = 0;
		do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
		lng += (result & 1) ? ~(result >> 1) : (result >> 1);
		points.push({ latitude: lat / 1e5, longitude: lng / 1e5 });
	}
	return points;
}

// Reverse geocode coordinates to a formatted address using Google Geocoding API
async function geocodeReverse(lat, lng) {
	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 5000);
		const resp = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${GOOGLE_MAPS_API_KEY}`, { signal: controller.signal });
		clearTimeout(timeout);
		if (!resp.ok) return null;
		const data = await resp.json();
		if (data.status !== "OK" || !data.results || data.results.length === 0) return null;
		return data.results[0].formatted_address || null;
	} catch {
		return null;
	}
}

// Route cache: TTL-based in-memory cache for Google Routes API results
const routeCache = new Map();
const ROUTE_CACHE_TTL = 15 * 60 * 1000; // 15 minutes
const ROUTE_CACHE_MAX = 500;

function routeCacheKey(from, to) {
	// Round to 3 decimal places (~111m precision) to group nearby positions
	return `${from.latitude.toFixed(3)},${from.longitude.toFixed(3)}>${to.latitude.toFixed(3)},${to.longitude.toFixed(3)}`;
}

// Get driving route between two points using Google Routes API
async function getRoute(from, to, retries = 2) {
	if (!from || !to) return null;
	// Skip impossible routes (e.g. cross-ocean) — max ~5000 km straight-line
	const distM = geolib.getDistance(from, to);
	if (distM > 5000000) return null;

	// Check cache before calling API
	const cacheKey = routeCacheKey(from, to);
	const cached = routeCache.get(cacheKey);
	if (cached && Date.now() - cached.time < ROUTE_CACHE_TTL) {
		return cached.result;
	}

	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 10000);
			const resp = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Goog-Api-Key": GOOGLE_MAPS_API_KEY,
					"X-Goog-FieldMask": "routes.polyline,routes.legs.distanceMeters,routes.legs.duration",
				},
				body: JSON.stringify({
					origin: { location: { latLng: { latitude: from.latitude, longitude: from.longitude } } },
					destination: { location: { latLng: { latitude: to.latitude, longitude: to.longitude } } },
					travelMode: "DRIVE",
				}),
				signal: controller.signal,
			});
			clearTimeout(timeout);
			if (!resp.ok) {
				const errText = await resp.text();
				console.error(`Routes API HTTP error (attempt ${attempt + 1}): ${resp.status} — ${errText}`);
				if (attempt < retries) { await new Promise(r => setTimeout(r, 500 * (attempt + 1))); continue; }
				routeCache.set(cacheKey, { result: null, time: Date.now() });
				if (routeCache.size > ROUTE_CACHE_MAX) routeCache.delete(routeCache.keys().next().value);
				return null;
			}
			const data = await resp.json();
			if (!data.routes || data.routes.length === 0) {
				routeCache.set(cacheKey, { result: null, time: Date.now() });
				if (routeCache.size > ROUTE_CACHE_MAX) routeCache.delete(routeCache.keys().next().value);
				return null;
			}
			const route = data.routes[0];
			const leg = route.legs[0];
			const durationSec = parseInt((leg.duration || "0s").replace("s", ""), 10);
			const result = {
				points: decodePolyline(route.polyline.encodedPolyline),
				distanceMiles: Math.round(leg.distanceMeters / 160.934) / 10,
				durationMin: Math.round(durationSec / 60),
			};
			routeCache.set(cacheKey, { result, time: Date.now() });
			if (routeCache.size > ROUTE_CACHE_MAX) routeCache.delete(routeCache.keys().next().value);
			return result;
		} catch (err) {
			console.error(`Routes API error (attempt ${attempt + 1}/${retries + 1}):`, err.message);
			if (attempt < retries) { await new Promise(r => setTimeout(r, 500 * (attempt + 1))); continue; }
			return null;
		}
	}
	return null;
}

// Snap GPS points to roads using Google Roads API
async function snapToRoads(points) {
	if (!points || points.length < 2) return null;
	try {
		const BATCH_SIZE = 100;
		let allSnapped = [];
		for (let i = 0; i < points.length; i += BATCH_SIZE - 1) {
			const batch = points.slice(i, i + BATCH_SIZE);
			if (batch.length < 2) break;
			const path = batch.map(p => `${p.latitude},${p.longitude}`).join("|");
			const url = `https://roads.googleapis.com/v1/snapToRoads?path=${encodeURIComponent(path)}&interpolate=true&key=${GOOGLE_MAPS_API_KEY}`;
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 8000);
			const resp = await fetch(url, { signal: controller.signal });
			clearTimeout(timeout);
			if (!resp.ok) {
				console.error(`Roads API error: ${resp.status}`);
				return null;
			}
			const data = await resp.json();
			if (!data.snappedPoints || data.snappedPoints.length === 0) return null;
			for (const pt of data.snappedPoints) {
				allSnapped.push({ latitude: pt.location.latitude, longitude: pt.location.longitude });
			}
		}
		return allSnapped.length >= 2 ? allSnapped : null;
	} catch (err) {
		console.error("Roads API snap error:", err.message);
		return null;
	}
}

// GET /api/locations/trail — GPS trail for a specific driver/load
app.get("/api/locations/trail", requireRole("Super Admin", "Dispatcher"), async (req, res) => {
	try {
		const { driver, loadId } = req.query;
		if (!driver) {
			return res.status(400).json({ error: "driver query param required" });
		}

		// Query location history
		let rawPoints;
		if (loadId) {
			rawPoints = db.prepare(
				`SELECT latitude, longitude, speed, timestamp
				 FROM driver_locations
				 WHERE driver = ? AND load_id = ?
				 ORDER BY timestamp ASC`
			).all(driver, loadId);
		} else {
			rawPoints = db.prepare(
				`SELECT latitude, longitude, speed, timestamp
				 FROM driver_locations
				 WHERE driver = ? AND timestamp > datetime('now', '-24 hours')
				 ORDER BY timestamp ASC`
			).all(driver);
		}

		// Simplify: skip consecutive points < 10m apart, always keep first and last
		const simplified = [];
		for (let i = 0; i < rawPoints.length; i++) {
			if (i === 0 || i === rawPoints.length - 1) {
				simplified.push(rawPoints[i]);
				continue;
			}
			const prev = simplified[simplified.length - 1];
			const dist = geolib.getDistance(
				{ latitude: prev.latitude, longitude: prev.longitude },
				{ latitude: rawPoints[i].latitude, longitude: rawPoints[i].longitude }
			);
			if (dist >= 10) {
				simplified.push(rawPoints[i]);
			}
		}

		// Cap at 2000 points
		const trail = simplified.length > 2000 ? simplified.slice(-2000) : simplified;

		// Look up origin/destination from sheet
		let origin = null;
		let destination = null;
		if (loadId) {
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
				const originLatCol = headers.find((h) => /origin.*lat|pickup.*lat|shipper.*lat/i.test(h));
				const originLngCol = headers.find((h) => /origin.*l(on|ng)|pickup.*l(on|ng)|shipper.*l(on|ng)/i.test(h));
				const destLatCol = headers.find((h) => /dest.*lat|drop.*lat|receiver.*lat|delivery.*lat/i.test(h));
				const destLngCol = headers.find((h) => /dest.*l(on|ng)|drop.*l(on|ng)|receiver.*l(on|ng)|delivery.*l(on|ng)/i.test(h));

				// Find address/city columns for origin and destination
				const originAddrCol = headers.find((h) => /origin|pickup|shipper/i.test(h) && !/lat|lng|lon/i.test(h));
				const destAddrCol = headers.find((h) => /dest|drop|receiver|delivery/i.test(h) && !/lat|lng|lon|date|time|appt|eta/i.test(h));

				if (loadIdCol) {
					const statusCol = headers.find((h) => /status/i.test(h));
					const completedRe = /^(delivered|completed|pod received|canceled)$/i;
					// Collect all matching rows, prefer active over completed
					let bestMatch = null;
					for (let i = 1; i < rows.length; i++) {
						const obj = {};
						headers.forEach((h, idx) => { obj[h] = rows[i][idx] || ""; });
						const lid = (obj[loadIdCol] || "").trim().replace(/^#/, "");
						if (lid === loadId || obj[loadIdCol] === loadId) {
							const status = statusCol ? (obj[statusCol] || "").trim() : "";
							if (!completedRe.test(status)) {
								bestMatch = obj;
								break; // Active row found — use it
							}
							if (!bestMatch) bestMatch = obj; // Fallback to first match
						}
					}
					if (bestMatch) {
						if (originLatCol && originLngCol) {
							const oLat = parseFloat(bestMatch[originLatCol]);
							const oLng = parseFloat(bestMatch[originLngCol]);
							if (!isNaN(oLat) && !isNaN(oLng)) origin = { latitude: oLat, longitude: oLng };
						}
						if (destLatCol && destLngCol) {
							const dLat = parseFloat(bestMatch[destLatCol]);
							const dLng = parseFloat(bestMatch[destLngCol]);
							if (!isNaN(dLat) && !isNaN(dLng)) destination = { latitude: dLat, longitude: dLng };
						}
						if (origin && originAddrCol) origin.address = bestMatch[originAddrCol] || "";
						if (destination && destAddrCol) destination.address = bestMatch[destAddrCol] || "";
					}
				}
			} catch (sheetErr) {
				console.error("Trail sheet lookup error:", sheetErr.message);
			}
		}

		// Geocode addresses if missing from sheet data
		if (origin && !origin.address) origin.address = await geocodeReverse(origin.latitude, origin.longitude) || "";
		if (destination && !destination.address) destination.address = await geocodeReverse(destination.latitude, destination.longitude) || "";

		// Get planned route from driver's current position to destination
		let route = null;
		if (destination) {
			const currentPos = trail.length > 0
				? { latitude: trail[trail.length - 1].latitude, longitude: trail[trail.length - 1].longitude }
				: origin;
			if (currentPos) {
				route = await getRoute(currentPos, destination);
			}
			// Fallback: route from origin to destination if driver position route fails
			if (!route && origin) {
				route = await getRoute(origin, destination);
			}
		}

		res.json({
			trail,
			route: route ? route.points : null,
			distanceMiles: route ? route.distanceMiles : null,
			etaMinutes: route ? route.durationMin : null,
			origin,
			destination,
		});
	} catch (error) {
		console.error("Error fetching trail:", error.message);
		res.status(500).json({ error: error.message });
	}
});

// GET /api/route — Lightweight rerouting: get driving route between two points
app.get("/api/route", requireRole("Super Admin", "Dispatcher", "Driver"), async (req, res) => {
	res.set('Cache-Control', 'private, max-age=300');
	try {
		const { fromLat, fromLng, toLat, toLng } = req.query;
		if (!fromLat || !fromLng || !toLat || !toLng) {
			return res.status(400).json({ error: "fromLat, fromLng, toLat, toLng required" });
		}
		const from = { latitude: parseFloat(fromLat), longitude: parseFloat(fromLng) };
		const to = { latitude: parseFloat(toLat), longitude: parseFloat(toLng) };
		const route = await getRoute(from, to);
		if (!route) {
			// Return empty route instead of 500 (e.g. cross-ocean routes OSRM can't compute)
			const distMiles = Math.round(geolib.getDistance(from, to) / 160.934) / 10;
			return res.json({ route: null, distanceMiles: distMiles, etaMinutes: null, fallback: true });
		}
		res.json({
			route: route.points,
			distanceMiles: route.distanceMiles,
			etaMinutes: route.durationMin,
		});
	} catch (error) {
		console.error("Error computing route:", error.message);
		res.status(500).json({ error: error.message });
	}
});

// GET /api/config/maps-key — expose Google Maps API key for client-side map rendering
app.get("/api/config/maps-key", requireAuth, (req, res) => {
	res.json({ key: GOOGLE_MAPS_API_KEY });
});

// GET /api/geocode — reverse geocode via Google Geocoding API
app.get("/api/geocode", requireAuth, async (req, res) => {
	const { lat, lng } = req.query;
	if (!lat || !lng) return res.status(400).json({ error: "lat and lng required" });
	try {
		const resp = await fetch(
			`https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${GOOGLE_MAPS_API_KEY}`
		);
		if (!resp.ok) return res.json({ status: "ERROR", results: [] });
		const data = await resp.json();
		if (data.status !== "OK" || !data.results || data.results.length === 0)
			return res.json({ status: "OK", results: [] });
		const r = data.results[0];
		const comp = r.address_components || [];
		res.json({
			status: "OK",
			results: [{
				formatted_address: r.formatted_address,
				address_components: [
					{ long_name: (comp.find(c => c.types.includes("locality")) || {}).long_name || "", types: ["locality"] },
					{ short_name: (comp.find(c => c.types.includes("administrative_area_level_1")) || {}).short_name || "", types: ["administrative_area_level_1"] },
				],
			}],
		});
	} catch {
		res.json({ status: "ERROR", results: [] });
	}
});

// GET /api/geocode/search — Forward geocode via Google Places API (New)
app.get("/api/geocode/search", requireAuth, async (req, res) => {
	const { q } = req.query;
	if (!q || q.trim().length < 3) return res.json({ results: [] });
	try {
		const resp = await fetch("https://places.googleapis.com/v1/places:searchText", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Goog-Api-Key": GOOGLE_MAPS_API_KEY,
				"X-Goog-FieldMask": "places.displayName,places.formattedAddress,places.location",
			},
			body: JSON.stringify({ textQuery: q.trim() }),
		});
		if (!resp.ok) return res.json({ results: [] });
		const data = await resp.json();
		const results = (data.places || []).map(p => ({
			lat: p.location?.latitude,
			lng: p.location?.longitude,
			displayName: p.formattedAddress || p.displayName?.text || "",
		}));
		res.json({ results });
	} catch {
		res.json({ results: [] });
	}
});

// GET /api/weather — current weather at coordinates proxy
app.get("/api/weather", requireAuth, async (req, res) => {
	const { lat, lng } = req.query;
	if (!lat || !lng) return res.status(400).json({ error: "lat and lng required" });
	try {
		const resp = await fetch(
			`https://weather.googleapis.com/v1/forecast:lookup?location.latitude=${lat}&location.longitude=${lng}&unitsSystem=IMPERIAL&key=${GOOGLE_MAPS_API_KEY}`
		);
		if (!resp.ok) return res.json({ error: "unavailable" });
		const data = await resp.json();
		const current = data.currentConditions;
		if (!current) return res.json({ error: "no data" });
		res.json({
			condition: current.weatherCondition?.description?.text || current.weatherCondition?.type || "",
			tempF: current.temperature?.value ?? null,
			feelsLikeF: current.feelsLikeTemperature?.value ?? null,
			humidity: current.relativeHumidity ?? null,
			windMph: current.wind?.speed?.value ?? null,
			uvIndex: current.uvIndex ?? null,
		});
	} catch {
		res.json({ error: "unavailable" });
	}
});

// ============================================================
// INVESTOR — Financial & Investor View (Read-Only)
// ============================================================

// GET /api/investor — Aggregated financial data for investor view
app.get("/api/investor", requireRole("Super Admin", "Investor"), async (req, res) => {
	try {
		const sheets = await getSheets();

		const response = await sheets.spreadsheets.values.batchGet({
			spreadsheetId: SPREADSHEET_ID,
			ranges: ["Job Tracking", "Payments Table", "Carrier Database"],
		});

		const rangeData = response.data.valueRanges || [];
		const jobTracking = parseSheet(rangeData[0]);
		jobTracking.data = deduplicateLoads(jobTracking.data, jobTracking.headers);
		const payments = parseSheet(rangeData[1]);
		const carrierDB = parseSheet(rangeData[2]);

		const user = req.session.user;
		const isSuperAdmin = user.role === "Super Admin";

		// Get investor's driver names from their owned trucks (for data filtering)
		let investorDriverSet = null; // null = no filter (Super Admin)
		if (!isSuperAdmin) {
			const ownedTrucks = db
				.prepare("SELECT assigned_driver FROM trucks WHERE owner_id = ? AND assigned_driver != ''")
				.all(user.id);
			investorDriverSet = new Set(ownedTrucks.map(t => t.assigned_driver.trim().toLowerCase()));
		}

		// Load per-investor config with fallback to global defaults (owner_id=0)
		const globalConfig = db.prepare("SELECT key, value FROM investor_config WHERE owner_id = 0").all();
		const config = {};
		globalConfig.forEach((r) => (config[r.key] = r.value));
		if (!isSuperAdmin) {
			const investorConfig = db.prepare("SELECT key, value FROM investor_config WHERE owner_id = ?").all(user.id);
			investorConfig.forEach((r) => (config[r.key] = r.value)); // override globals
		}

		// Filter sheet data by investor's drivers
		const driverCol = findCol(jobTracking.headers, /^driver$/i);
		const filteredJobData = investorDriverSet
			? jobTracking.data.filter(r => {
				const driver = driverCol ? (r[driverCol] || "").trim().toLowerCase() : "";
				return driver && investorDriverSet.has(driver);
			})
			: jobTracking.data;

		const payDriverCol = findCol(payments.headers, /driver/i);
		const payLoadIdCol = findCol(payments.headers, /load.?id|job.?id/i);
		const jobLoadIdCol = findCol(jobTracking.headers, /load.?id|job.?id/i);
		const investorLoadIds = investorDriverSet && jobLoadIdCol
			? new Set(filteredJobData.map(r => (r[jobLoadIdCol] || "").trim().toLowerCase()).filter(Boolean))
			: null;

		const filteredPayments = investorDriverSet
			? payments.data.filter(r => {
				if (payDriverCol) {
					const driver = (r[payDriverCol] || "").trim().toLowerCase();
					if (driver && investorDriverSet.has(driver)) return true;
				}
				if (payLoadIdCol && investorLoadIds) {
					const lid = (r[payLoadIdCol] || "").trim().toLowerCase();
					if (lid && investorLoadIds.has(lid)) return true;
				}
				return false;
			})
			: payments.data;

		const carrierDriverCol = findCol(carrierDB.headers, /driver/i) || carrierDB.headers[0];
		const filteredCarrierData = investorDriverSet
			? carrierDB.data.filter(r => {
				const driver = (r[carrierDriverCol] || "").trim().toLowerCase();
				return driver && investorDriverSet.has(driver);
			})
			: carrierDB.data;

		// ---- Expense Data (S1) ----
		let totalExpenses = 0;
		if (investorDriverSet && investorDriverSet.size > 0) {
			const driverList = [...investorDriverSet];
			const placeholders = driverList.map(() => '?').join(',');
			const expSum = db.prepare(`SELECT COALESCE(SUM(amount), 0) AS total FROM expenses WHERE LOWER(driver) IN (${placeholders})`).get(...driverList);
			totalExpenses += expSum.total;
			// Maintenance fund services for investor's trucks
			const maintSum = db.prepare(`SELECT COALESCE(SUM(mf.amount), 0) AS total FROM maintenance_fund mf INNER JOIN trucks t ON LOWER(mf.truck) = LOWER(t.unit_number) WHERE t.owner_id = ? AND mf.type = 'service'`).get(user.id);
			totalExpenses += maintSum.total;
			// Compliance fees paid for investor's trucks
			const compSum = db.prepare(`SELECT COALESCE(SUM(cf.amount), 0) AS total FROM compliance_fees cf INNER JOIN trucks t ON LOWER(cf.truck) = LOWER(t.unit_number) WHERE t.owner_id = ? AND cf.status = 'Paid'`).get(user.id);
			totalExpenses += compSum.total;
		} else if (isSuperAdmin) {
			const expSum = db.prepare(`SELECT COALESCE(SUM(amount), 0) AS total FROM expenses`).get();
			totalExpenses += expSum.total;
			const maintSum = db.prepare(`SELECT COALESCE(SUM(amount), 0) AS total FROM maintenance_fund WHERE type = 'service'`).get();
			totalExpenses += maintSum.total;
			const compSum = db.prepare(`SELECT COALESCE(SUM(amount), 0) AS total FROM compliance_fees WHERE status = 'Paid'`).get();
			totalExpenses += compSum.total;
		}

		// ---- Production Performance ----
		const rateCol = findCol(payments.headers, /rate|amount|total|pay/i);
		const payStatusCol = findCol(payments.headers, /pay.*status|status/i);
		const dateCol = findCol(payments.headers, /date/i);

		// Job Tracking cols used for per-truck revenue and daily avg fallback
		const jtRateCol = findCol(jobTracking.headers, /payment|rate|amount|revenue/i);
		const jtDateCol = findCol(jobTracking.headers, /status.*update.*date|completion.*date|assigned.*date/i)
			|| findCol(jobTracking.headers, /date/i);
		const jtDriverCol = findCol(jobTracking.headers, /^driver$/i);

		let totalRevenue = 0;
		let paidRevenue = 0;
		let last30DaysRevenue = 0;
		const monthlyRevenue = {};
		const now = new Date();
		const thirtyDaysAgo = new Date(now);
		thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

		// Detect if Payments Table has usable date data; fall back to Job Tracking if not
		const paymentsHaveDates = filteredPayments.some(r => dateCol && r[dateCol]);

		filteredPayments.forEach((r) => {
			const amt =
				parseFloat(String(rateCol ? r[rateCol] : "0").replace(/[$,]/g, "")) || 0;
			totalRevenue += amt;
			const ps = payStatusCol ? (r[payStatusCol] || "").trim() : "";
			if (/^paid$/i.test(ps)) paidRevenue += amt;

			if (dateCol && r[dateCol]) {
				const d = new Date(r[dateCol]);
				if (!isNaN(d)) {
					// 30-day window (S2)
					if (d >= thirtyDaysAgo) last30DaysRevenue += amt;
					const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
					monthlyRevenue[key] = (monthlyRevenue[key] || 0) + amt;
				}
			}
		});

		// If Payments Table has no dates, derive date-based metrics from Job Tracking
		if (!paymentsHaveDates && jtDateCol && jtRateCol) {
			filteredJobData.forEach((r) => {
				const amt = parseFloat(String((r[jtRateCol] || "0")).replace(/[$,]/g, "")) || 0;
				if (!amt) return;
				const d = new Date(r[jtDateCol]);
				if (!isNaN(d)) {
					if (d >= thirtyDaysAgo) last30DaysRevenue += amt;
					const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
					monthlyRevenue[key] = (monthlyRevenue[key] || 0) + amt;
				}
			});
			// Also treat all job amounts as "paid" for paidRevenue when no payment status exists
			if (paidRevenue === 0) {
				filteredJobData.forEach((r) => {
					const amt = parseFloat(String((r[jtRateCol] || "0")).replace(/[$,]/g, "")) || 0;
					paidRevenue += amt;
				});
			}
		}

		// Avg daily revenue = 30-day average (S2)
		const avgDailyRevenue = last30DaysRevenue / 30;

		// Operating period (earliest to latest — from Job Tracking dates if Payments Table lacks them)
		let earliestDate = null;
		let latestDate = null;
		const dateSource = paymentsHaveDates ? filteredPayments : filteredJobData;
		const dateSourceCol = paymentsHaveDates ? dateCol : jtDateCol;
		dateSource.forEach((r) => {
			if (dateSourceCol && r[dateSourceCol]) {
				const d = new Date(r[dateSourceCol]);
				if (!isNaN(d)) {
					if (!earliestDate || d < earliestDate) earliestDate = d;
					if (!latestDate || d > latestDate) latestDate = d;
				}
			}
		});

		// Months of operation and avg monthly owner earnings (S3)
		let monthsOfOperation = 1;
		if (earliestDate && latestDate) {
			monthsOfOperation = Math.max(1,
				(latestDate.getFullYear() - earliestDate.getFullYear()) * 12
				+ (latestDate.getMonth() - earliestDate.getMonth()) + 1
			);
		}
		const avgMonthlyOwnerEarnings = Math.round(paidRevenue / monthsOfOperation);

		// ---- Add truck fixed costs & maintenance fund to totalExpenses ----
		{
			const truckQuery = investorDriverSet
				? "SELECT insurance_monthly, eld_monthly, hvut_annual, irp_annual, driver_pay_daily, maintenance_fund_monthly FROM trucks WHERE owner_id = ?"
				: "SELECT insurance_monthly, eld_monthly, hvut_annual, irp_annual, driver_pay_daily, maintenance_fund_monthly FROM trucks";
			const truckArgs = investorDriverSet ? [user.id] : [];
			const fleetTrucks = db.prepare(truckQuery).all(...truckArgs);
			let fixedMonthlyTotal = 0;
			for (const t of fleetTrucks) {
				fixedMonthlyTotal += (t.insurance_monthly || 0) + (t.eld_monthly || 0)
					+ ((t.hvut_annual || 0) / 12) + ((t.irp_annual || 0) / 12)
					+ ((t.driver_pay_daily || 0) * 30)
					+ (t.maintenance_fund_monthly || 0);
			}
			totalExpenses += fixedMonthlyTotal * monthsOfOperation;
		}

		// Monthly revenue sorted
		const monthlyData = Object.entries(monthlyRevenue)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([month, amount]) => ({ month, amount: Math.round(amount) }));

		// ---- Asset Security (S4, S5) — now per-truck ----
		const allOwnedTrucks = investorDriverSet
			? db.prepare("SELECT id, unit_number, assigned_driver, purchase_price, title_status FROM trucks WHERE owner_id = ?").all(user.id)
			: db.prepare("SELECT id, unit_number, assigned_driver, purchase_price, title_status FROM trucks").all();
		const totalTrucks = allOwnedTrucks.length || 1;
		const totalPurchasePrice = allOwnedTrucks.reduce((sum, t) => sum + (t.purchase_price || 0), 0);
		const totalCurrentValue = Math.round(totalPurchasePrice * 0.80); // 20% flat depreciation
		// Use first truck's values as representative for single-truck display; fleet view uses totals
		const purchasePrice = allOwnedTrucks.length === 1 ? (allOwnedTrucks[0].purchase_price || 0) : totalPurchasePrice;
		const currentValue = allOwnedTrucks.length === 1 ? Math.round((allOwnedTrucks[0].purchase_price || 0) * 0.80) : totalCurrentValue;
		const titleStatus = allOwnedTrucks.length === 1 ? (allOwnedTrucks[0].title_status || "Clean") : "Mixed";

		// Fleet totals (S9)
		const totalStartupExpenses = 5000 * totalTrucks;
		const netRevenueToDate = Math.round(totalRevenue - totalExpenses);

		// ---- Tax Shield (S6, S7, S10) ----
		const section179 = totalPurchasePrice; // S6: 100% deductibility per truck
		const atRiskCapital = Math.max(0, (totalPurchasePrice + totalStartupExpenses) - netRevenueToDate); // S7

		// ---- Per-Truck Revenue Data (S8) ----
		const currentMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
		const perTruckData = {};
		if (investorDriverSet) {
			const ownedTrucks = db.prepare("SELECT unit_number, assigned_driver FROM trucks WHERE owner_id = ?").all(user.id);
			ownedTrucks.forEach((truck) => {
				const driverName = (truck.assigned_driver || "").trim().toLowerCase();
				let unitMonthlyGross = 0;
				if (driverName && jtRateCol) {
					// Use Job Tracking data for per-truck monthly revenue (more reliable driver+date data)
					filteredJobData.forEach((r) => {
						const driver = jtDriverCol ? (r[jtDriverCol] || "").trim().toLowerCase() : "";
						if (driver !== driverName) return;
						const dateVal = jtDateCol ? r[jtDateCol] : null;
						if (dateVal) {
							const d = new Date(dateVal);
							if (!isNaN(d)) {
								const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
								if (key === currentMonthKey) {
									unitMonthlyGross += parseFloat(String(r[jtRateCol] || "0").replace(/[$,]/g, "")) || 0;
								}
							}
						}
					});
				}
				// Per-truck monthly expenses (RFD-13)
				const expRow = db.prepare(`SELECT COALESCE(SUM(amount),0) AS t FROM expenses WHERE LOWER(driver) = ? AND strftime('%Y-%m', date) = ?`).get(driverName, currentMonthKey);
				const maintRow = db.prepare(`SELECT COALESCE(SUM(mf.amount),0) AS t FROM maintenance_fund mf WHERE LOWER(mf.truck) = ? AND strftime('%Y-%m', mf.date) = ?`).get(truck.unit_number.toLowerCase(), currentMonthKey);
				const compRow = db.prepare(`SELECT COALESCE(SUM(cf.amount),0) AS t FROM compliance_fees cf WHERE LOWER(cf.truck) = ? AND strftime('%Y-%m', cf.due_date) = ? AND cf.status = 'Paid'`).get(truck.unit_number.toLowerCase(), currentMonthKey);
				// Fixed costs from truck record (pro-rated monthly)
				const truckRow = db.prepare("SELECT insurance_monthly, eld_monthly, hvut_annual, irp_annual, driver_pay_daily, maintenance_fund_monthly FROM trucks WHERE unit_number = ?").get(truck.unit_number);
				const fixedMonthly = (truckRow?.insurance_monthly || 0) + (truckRow?.eld_monthly || 0) + ((truckRow?.hvut_annual || 0) / 12) + ((truckRow?.irp_annual || 0) / 12) + ((truckRow?.driver_pay_daily || 0) * 30) + (truckRow?.maintenance_fund_monthly || 0);
				const unitMonthlyExpenses = (expRow?.t || 0) + (maintRow?.t || 0) + (compRow?.t || 0) + fixedMonthly;
				// Mileage from odometer readings (max - min)
				const odometerRange = db.prepare(
					`SELECT MIN(odometer) AS minOdo, MAX(odometer) AS maxOdo FROM expenses WHERE LOWER(driver) = ? AND odometer > 0`
				).get(driverName);
				const totalMiles = (odometerRange?.maxOdo && odometerRange?.minOdo) ? Math.round(odometerRange.maxOdo - odometerRange.minOdo) : 0;

				perTruckData[truck.unit_number] = {
					unitMonthlyGross: Math.round(unitMonthlyGross),
					unitMonthlyExpenses: Math.round(unitMonthlyExpenses),
					estAnnualRevenue: Math.round((unitMonthlyGross - unitMonthlyExpenses) * 12),
					totalMiles,
				};
			});
		}

		// ---- Recession-Proof Metrics (kept in API for backward compat) ----
		const brokerCol = findCol(jobTracking.headers, /broker|shipper|customer|client/i);
		const statusCol = findCol(jobTracking.headers, /status/i);
		let totalJobs = filteredJobData.length;
		const completedStatuses = /^(delivered|completed|pod received)$/i;
		const completedJobs = statusCol
			? filteredJobData.filter((r) => completedStatuses.test((r[statusCol] || "").trim())).length
			: 0;

		// Fleet-level mileage aggregation
		const fleetTotalMiles = Object.values(perTruckData).reduce((s, t) => s + (t.totalMiles || 0), 0);
		const revenuePerMile = fleetTotalMiles > 0 ? Math.round((totalRevenue / fleetTotalMiles) * 100) / 100 : 0;
		const costPerMile = fleetTotalMiles > 0 ? Math.round((totalExpenses / fleetTotalMiles) * 100) / 100 : 0;

		res.json({
			production: {
				totalRevenue: Math.round(totalRevenue),
				paidRevenue: Math.round(paidRevenue),
				pendingRevenue: Math.round(totalRevenue - paidRevenue),
				avgDailyRevenue: Math.round(avgDailyRevenue),
				monthlyData,
				avgMonthlyOwnerEarnings,
				monthsOfOperation,
				investorSplitPct: 50,
				totalJobs,
				completedJobs,
				totalExpenses: Math.round(totalExpenses),
				netRevenueToDate,
				totalPurchasePrice,
				totalStartupExpenses,
				perTruckData,
			},
			asset: {
				purchasePrice,
				currentValue,
				titleStatus,
				depreciationYears: 1,
				annualDepreciation: purchasePrice,
				totalTrucks,
				totalMiles: fleetTotalMiles,
				revenuePerMile,
				costPerMile,
			},
			taxShield: {
				section179,
				atRiskCapital,
				writeOffPct: 100,
			},
			recessionProof: {
				totalJobs,
				completedJobs,
			},
			config,
		});
	} catch (error) {
		console.error("Error building investor data:", error.message);
		res.status(500).json({ error: error.message });
	}
});

// PUT /api/investor/config — Admin: update investor config
app.put("/api/investor/config", requireRole("Super Admin", "Investor"), (req, res) => {
	try {
		const user = req.session.user;
		const targetOwnerId = user.role === "Super Admin"
			? parseInt(req.query.ownerId) || 0
			: user.id;
		const updates = req.body; // { key: value, ... }
		const stmt = db.prepare(
			"INSERT OR REPLACE INTO investor_config (owner_id, key, value) VALUES (?, ?, ?)",
		);
		const updateMany = db.transaction((entries) => {
			for (const [k, v] of entries) stmt.run(targetOwnerId, k, String(v));
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

// GET /api/expenses/all — All expenses (all types) for dispatcher/admin
app.get("/api/expenses/all", requireRole("Super Admin", "Dispatcher"), (req, res) => {
	try {
		const { driver, type, status } = req.query;
		let sql = "SELECT id, timestamp, driver, load_id, type, amount, description, date, photo_data, status, gallons, odometer, created_at FROM expenses";
		const conditions = [];
		const params = [];
		if (driver) { conditions.push("LOWER(driver) = ?"); params.push(driver.toLowerCase()); }
		if (type) { conditions.push("LOWER(type) = ?"); params.push(type.toLowerCase()); }
		if (status) { conditions.push("LOWER(status) = ?"); params.push(status.toLowerCase()); }
		if (conditions.length) sql += " WHERE " + conditions.join(" AND ");
		sql += " ORDER BY id DESC";
		const expenses = db.prepare(sql).all(...params);
		res.json({ expenses });
	} catch (err) {
		console.error("Error fetching all expenses:", err.message);
		res.status(500).json({ error: err.message });
	}
});

// PUT /api/expenses/:id/status — Approve or reject an expense
app.put("/api/expenses/:id/status", requireRole("Super Admin", "Dispatcher"), (req, res) => {
	try {
		const id = parseInt(req.params.id);
		const { status } = req.body;
		if (!["Approved", "Rejected", "Pending"].includes(status)) {
			return res.status(400).json({ error: "Status must be Approved, Rejected, or Pending" });
		}
		const expense = db.prepare("SELECT id FROM expenses WHERE id = ?").get(id);
		if (!expense) return res.status(404).json({ error: "Expense not found" });
		db.prepare("UPDATE expenses SET status = ? WHERE id = ?").run(status, id);
		res.json({ success: true });
	} catch (err) {
		console.error("Error updating expense status:", err.message);
		res.status(500).json({ error: err.message });
	}
});

// GET /api/expenses/fuel-analytics — Fuel cost analytics + compliance
app.get("/api/expenses/fuel-analytics", requireRole("Super Admin", "Dispatcher"), (req, res) => {
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
app.get("/api/maintenance-fund", requireRole("Super Admin", "Dispatcher"), (req, res) => {
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
app.post("/api/maintenance-fund", requireRole("Super Admin", "Dispatcher"), (req, res) => {
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
app.get("/api/compliance/fees", requireRole("Super Admin", "Dispatcher"), (req, res) => {
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
app.post("/api/compliance/fees", requireRole("Super Admin", "Dispatcher"), (req, res) => {
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
app.put("/api/compliance/fees/:id", requireRole("Super Admin", "Dispatcher"), (req, res) => {
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
app.get("/api/compliance/ifta", requireRole("Super Admin", "Dispatcher"), (req, res) => {
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
		{ name: "WA", minLat: 45.54, maxLat: 49.0, minLng: -124.85, maxLng: -116.92 },
		{ name: "OR", minLat: 41.99, maxLat: 46.29, minLng: -124.57, maxLng: -116.46 },
		{ name: "ID", minLat: 41.99, maxLat: 49.0, minLng: -117.24, maxLng: -111.04 },
		{ name: "MT", minLat: 44.36, maxLat: 49.0, minLng: -116.05, maxLng: -104.04 },
		{ name: "WY", minLat: 40.99, maxLat: 45.01, minLng: -111.06, maxLng: -104.05 },
		{ name: "UT", minLat: 36.99, maxLat: 42.0, minLng: -114.05, maxLng: -109.04 },
		{ name: "ND", minLat: 45.94, maxLat: 49.0, minLng: -104.05, maxLng: -96.55 },
		{ name: "SD", minLat: 42.48, maxLat: 45.95, minLng: -104.06, maxLng: -96.44 },
		{ name: "NE", minLat: 39.99, maxLat: 43.0, minLng: -104.05, maxLng: -95.31 },
		{ name: "IA", minLat: 40.37, maxLat: 43.5, minLng: -96.64, maxLng: -90.14 },
		{ name: "MN", minLat: 43.5, maxLat: 49.38, minLng: -97.24, maxLng: -89.49 },
		{ name: "WI", minLat: 42.49, maxLat: 47.08, minLng: -92.89, maxLng: -86.25 },
		{ name: "MI", minLat: 41.7, maxLat: 48.31, minLng: -90.42, maxLng: -82.12 },
		{ name: "KY", minLat: 36.5, maxLat: 39.15, minLng: -89.57, maxLng: -81.96 },
		{ name: "WV", minLat: 37.2, maxLat: 40.64, minLng: -82.64, maxLng: -77.72 },
		{ name: "MD", minLat: 37.91, maxLat: 39.72, minLng: -79.49, maxLng: -75.05 },
		{ name: "DE", minLat: 38.45, maxLat: 39.84, minLng: -75.79, maxLng: -75.05 },
		{ name: "NJ", minLat: 38.93, maxLat: 41.36, minLng: -75.56, maxLng: -73.89 },
		{ name: "CT", minLat: 40.98, maxLat: 42.05, minLng: -73.73, maxLng: -71.79 },
		{ name: "RI", minLat: 41.15, maxLat: 42.02, minLng: -71.86, maxLng: -71.12 },
		{ name: "MA", minLat: 41.24, maxLat: 42.89, minLng: -73.51, maxLng: -69.93 },
		{ name: "VT", minLat: 42.73, maxLat: 45.02, minLng: -73.44, maxLng: -71.47 },
		{ name: "NH", minLat: 42.7, maxLat: 45.31, minLng: -72.56, maxLng: -70.7 },
		{ name: "ME", minLat: 43.06, maxLat: 47.46, minLng: -71.08, maxLng: -66.95 },
		{ name: "HI", minLat: 18.91, maxLat: 22.24, minLng: -160.25, maxLng: -154.81 },
		{ name: "AK", minLat: 51.21, maxLat: 71.39, minLng: -179.15, maxLng: -129.98 },
		{ name: "DC", minLat: 38.79, maxLat: 38.99, minLng: -77.12, maxLng: -76.91 },
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

// JSON payload too large error handler
app.use((err, req, res, next) => {
	if (err.type === "entity.too.large") {
		return res.status(413).json({ error: "The photo is too large. Please try a smaller image." });
	}
	if (err.type === "entity.parse.failed") {
		return res.status(400).json({ error: "Invalid request. Please try again." });
	}
	next(err);
});

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
		console.error("Server cannot operate without Google Sheets. Exiting.");
		process.exit(1);
	}
});
