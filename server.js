require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { google } = require("googleapis");
const path = require("path");
const fs = require("fs");
const bcrypt = require("bcryptjs");
const session = require("express-session");
const Database = require("better-sqlite3");
const SqliteStore = require("better-sqlite3-session-store")(session);
const geolib = require("geolib");
const PDFDocument = require("pdfkit");
const compression = require("compression");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const { PDFDocument: PdfLibDocument, rgb, StandardFonts } = require("pdf-lib");
const { renderPolicy } = require("./lib/policy-renderer");
const { getStateFromCoords } = require("./lib/ifta-states");

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
// Emit a domain invalidation event so connected clients auto-refresh.
// Called after successful mutations (POST/PUT/DELETE) — no payload needed.
function notifyChange(domain) {
	io.to("dispatch").emit(`${domain}:changed`);
	// Also notify investor room for domains that affect investor dashboards
	if (["trucks", "expenses", "invoices", "investor"].includes(domain)) {
		io.to("investor").emit(`${domain}:changed`);
	}
}
app.set("trust proxy", 1); // Behind nginx — use real client IP for rate limiting
const ALLOWED_FILE_EXTS = new Set([".pdf",".jpg",".jpeg",".png",".gif",".webp",".doc",".docx",".xls",".xlsx",".csv",".txt"]);
function validateFileExt(fileName) { return ALLOWED_FILE_EXTS.has(path.extname(fileName || "").toLowerCase()); }
app.use(compression());
// 50 MB body limit — covers driver application payloads that bundle
// 3 high-res iPhone photos (CDL front + back + medical card) as base64.
// nginx client_max_body_size is set slightly above this so rejections
// always come from Express as JSON instead of a bare 413 from nginx.
app.use(express.json({ limit: "50mb" }));
// NOTE: /uploads static mount is deferred to after requireAuth is defined (see below),
// so every file under uploads/ requires an authenticated session.

// ============================================================
// SQLite — Local database for app data (messages, users, expenses)
// ============================================================
const db = new Database(path.join(__dirname, "app.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

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
db.exec(`CREATE INDEX IF NOT EXISTS idx_expenses_owner ON expenses(owner_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(date)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_expenses_status ON expenses(status)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_expenses_owner_date ON expenses(owner_id, date)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_trucks_owner ON trucks(owner_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_maintenance_truck ON maintenance_fund(truck)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_compliance_truck ON compliance_fees(truck)`);

// Migrate: add gallons + odometer columns to expenses table (fuel tracking)
try {
	db.prepare("SELECT gallons FROM expenses LIMIT 1").get();
} catch {
	db.exec(`ALTER TABLE expenses ADD COLUMN gallons REAL DEFAULT 0`);
	db.exec(`ALTER TABLE expenses ADD COLUMN odometer REAL DEFAULT 0`);
}

// Migration: add owner_id to expenses for investor data continuity
try { db.exec("ALTER TABLE expenses ADD COLUMN owner_id INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE expenses ADD COLUMN truck_unit TEXT DEFAULT ''"); } catch {}

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
try { db.exec("ALTER TABLE trucks ADD COLUMN title_state TEXT DEFAULT ''"); } catch {}
// Note: maintenance_fund_monthly already added via rename-recreate if needed;
// safe ALTER in case column doesn't exist yet on this instance
try { db.prepare("SELECT maintenance_fund_monthly FROM trucks LIMIT 1").get(); }
catch { try { db.exec("ALTER TABLE trucks ADD COLUMN maintenance_fund_monthly REAL DEFAULT 0"); } catch {} }

// Trailers table
db.exec(`
	CREATE TABLE IF NOT EXISTS trailers (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		trailer_number TEXT NOT NULL UNIQUE,
		type TEXT NOT NULL DEFAULT 'Dry Van' CHECK(type IN ('Dry Van','Reefer','Flatbed','Step Deck','Lowboy','Tanker','Other')),
		length TEXT DEFAULT '53',
		year INTEGER DEFAULT 0,
		vin TEXT DEFAULT '',
		license_plate TEXT DEFAULT '',
		status TEXT NOT NULL DEFAULT 'Available' CHECK(status IN ('Available','In Use','Maintenance','Out of Service')),
		truck_id INTEGER,
		notes TEXT DEFAULT '',
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		FOREIGN KEY (truck_id) REFERENCES trucks(id)
	)
`);

// Job applications table (public employment form)
db.exec(`
	CREATE TABLE IF NOT EXISTS job_applications (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		full_name TEXT NOT NULL,
		email TEXT NOT NULL,
		phone TEXT NOT NULL,
		dob TEXT NOT NULL,
		address TEXT NOT NULL,
		ssn TEXT NOT NULL,
		drivers_license TEXT NOT NULL,
		position TEXT NOT NULL,
		experience TEXT NOT NULL,
		has_cdl TEXT NOT NULL,
		work_authorized TEXT NOT NULL,
		felony_convicted TEXT NOT NULL,
		felony_explanation TEXT DEFAULT '',
		accident_history TEXT NOT NULL,
		accident_description TEXT DEFAULT '',
		traffic_citations TEXT DEFAULT '',
		certifications TEXT DEFAULT '',
		availability TEXT DEFAULT '[]',
		skills TEXT NOT NULL,
		reference_info TEXT DEFAULT '',
		additional_info TEXT DEFAULT '',
		signature TEXT NOT NULL,
		signature_date TEXT DEFAULT '',
		status TEXT NOT NULL DEFAULT 'New' CHECK(status IN ('New','Reviewed','Accepted','Rejected')),
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP
	)
`);

// Migration: add CDL + medical card columns to job_applications
try { db.exec("ALTER TABLE job_applications ADD COLUMN cdl_front TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE job_applications ADD COLUMN cdl_back TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE job_applications ADD COLUMN medical_card TEXT DEFAULT ''"); } catch {}

// Migration: add driver directory fields to job_applications (so acceptance flows into drivers_directory)
try { db.exec("ALTER TABLE job_applications ADD COLUMN city TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE job_applications ADD COLUMN state TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE job_applications ADD COLUMN zip TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE job_applications ADD COLUMN cell TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE job_applications ADD COLUMN dot TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE job_applications ADD COLUMN mc TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE job_applications ADD COLUMN hazmat TEXT DEFAULT ''"); } catch {}

// Migration: add asset_ref to messages (for "Share Asset" in chat)
try { db.exec("ALTER TABLE messages ADD COLUMN asset_ref TEXT DEFAULT ''"); } catch {}

// Migration: add rating to users (0-5 stars, Super Admin rates drivers)
try { db.exec("ALTER TABLE users ADD COLUMN rating REAL DEFAULT 0"); } catch {}

// Per-load driver ratings (1-5 stars, one rating per load)
db.exec(`
	CREATE TABLE IF NOT EXISTS load_ratings (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		load_id TEXT NOT NULL UNIQUE,
		driver_name TEXT NOT NULL,
		rating INTEGER NOT NULL CHECK(rating >= 1 AND rating <= 5),
		rated_by INTEGER NOT NULL,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
	)
`);

// Audit trail table
db.exec(`
	CREATE TABLE IF NOT EXISTS audit_trail (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		timestamp TEXT NOT NULL,
		user_id INTEGER NOT NULL,
		username TEXT NOT NULL,
		role TEXT NOT NULL,
		action TEXT NOT NULL,
		entity TEXT NOT NULL,
		entity_id TEXT DEFAULT '',
		details TEXT DEFAULT '',
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP
	)
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_trail(timestamp)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_trail(entity, entity_id)`);

function logAudit(req, action, entity, entityId, details) {
	try {
		const user = req.session?.user || {};
		db.prepare("INSERT INTO audit_trail (timestamp, user_id, username, role, action, entity, entity_id, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
			.run(new Date().toISOString(), user.id || 0, user.username || 'system', user.role || 'system', action, entity, String(entityId || ''), details || '');
	} catch (err) { console.error("Audit log error:", err.message); }
}

// Investors table (links investor name to a carrier in the Google Sheet)
db.exec(`
	CREATE TABLE IF NOT EXISTS investors (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		user_id INTEGER UNIQUE,
		full_name TEXT NOT NULL DEFAULT '',
		carrier_name TEXT NOT NULL DEFAULT '',
		status TEXT NOT NULL DEFAULT 'Active' CHECK(status IN ('Active','Inactive')),
		notes TEXT NOT NULL DEFAULT '',
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP
	)
`);
try { db.exec("ALTER TABLE investors ADD COLUMN carrier_name TEXT NOT NULL DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE investors ADD COLUMN application_id INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE investors ADD COLUMN entity_type TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE investors ADD COLUMN address TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE investors ADD COLUMN phone TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE investors ADD COLUMN email TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE investors ADD COLUMN ein_ssn TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE investors ADD COLUMN tax_classification TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE investors ADD COLUMN contact_person TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE investors ADD COLUMN contact_title TEXT DEFAULT ''"); } catch {}
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_inv_carrier ON investors(carrier_name)`);

// Carrier-driver history (preserves pairings when drivers move between carriers)
db.exec(`
	CREATE TABLE IF NOT EXISTS carrier_driver_history (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		carrier_name TEXT NOT NULL,
		driver_name TEXT NOT NULL,
		started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		ended_at DATETIME
	)
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_cdh_carrier ON carrier_driver_history(carrier_name)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_cdh_driver ON carrier_driver_history(driver_name)`);

// Geocode cache (address → lat/lng, persistent across restarts)
db.exec(`
	CREATE TABLE IF NOT EXISTS geocode_cache (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		address TEXT NOT NULL UNIQUE,
		lat REAL,
		lng REAL,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP
	)
`);
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_geocode_addr ON geocode_cache(address)`);

// Load coordinates (Load ID → origin/dest lat/lng, instant lookup)
db.exec(`
	CREATE TABLE IF NOT EXISTS load_coordinates (
		load_id TEXT PRIMARY KEY,
		origin_lat REAL,
		origin_lng REAL,
		dest_lat REAL,
		dest_lng REAL,
		pickup_address TEXT NOT NULL DEFAULT '',
		dropoff_address TEXT NOT NULL DEFAULT '',
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP
	)
`);
// Persistent cache for actual road-distance miles from Google Routes API.
// Populated via POST /api/admin/backfill-road-distances (one-time per load).
// Financials / investor endpoints read this column; fall back to haversine
// on rows where it's still NULL.
try { db.exec("ALTER TABLE load_coordinates ADD COLUMN distance_miles REAL"); } catch {}

// Drivers directory (replaces Carrier Database Google Sheet)
db.exec(`
	CREATE TABLE IF NOT EXISTS drivers_directory (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		driver_name TEXT NOT NULL UNIQUE,
		carrier_name TEXT DEFAULT '',
		state TEXT DEFAULT '',
		city TEXT DEFAULT '',
		zip TEXT DEFAULT '',
		address TEXT DEFAULT '',
		phone TEXT DEFAULT '',
		cell TEXT DEFAULT '',
		email TEXT DEFAULT '',
		dot TEXT DEFAULT '',
		mc TEXT DEFAULT '',
		trucks TEXT DEFAULT '',
		hazmat TEXT DEFAULT '',
		rating TEXT DEFAULT '',
		user_id INTEGER DEFAULT 0,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP
	)
`);

// Migration: add status column to drivers_directory (pending/active/inactive)
// Existing rows get 'active' so current drivers stay in the dispatch dropdown.
// New auto-created rows from onboarding default to 'pending' until drug test passes.
try {
	db.exec("ALTER TABLE drivers_directory ADD COLUMN status TEXT DEFAULT 'active'");
	db.prepare("UPDATE drivers_directory SET status = 'active' WHERE status IS NULL OR status = ''").run();
} catch {}

// Migration: add profile_picture_url to drivers_directory and investors for uploadable avatars
try { db.exec("ALTER TABLE drivers_directory ADD COLUMN profile_picture_url TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE investors ADD COLUMN profile_picture_url TEXT DEFAULT ''"); } catch {}

// One-time seed: import Carrier Database from Google Sheet into SQLite on first boot
const driverCount = db.prepare("SELECT COUNT(*) AS cnt FROM drivers_directory").get().cnt;
if (driverCount === 0) {
	(async () => {
		try {
			const sheets = await getSheets();
			const resp = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: "Carrier Database" });
			const rows = resp.data.values || [];
			if (rows.length < 2) return;
			const h = rows[0];
			const find = (regex) => h.findIndex(x => regex.test(x));
			const di = find(/driver/i); const ci = find(/carrier/i); const si = find(/state/i);
			const cti = find(/city/i); const zi = find(/zip/i); const ai = find(/address/i);
			const ti = find(/truck/i); const hzi = find(/hazmat/i); const pi = find(/phone/i);
			const cli = find(/cell/i); const ei = find(/email/i); const doi = find(/dot/i);
			const mi = find(/mc/i); const ri = find(/rating/i);
			const ins = db.prepare(`INSERT OR IGNORE INTO drivers_directory (driver_name, carrier_name, state, city, zip, address, phone, cell, email, dot, mc, trucks, hazmat, rating) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
			for (let i = 1; i < rows.length; i++) {
				const r = rows[i];
				const name = (r[di] || "").trim();
				if (!name) continue;
				ins.run(name, r[ci]||"", r[si]||"", r[cti]||"", r[zi]||"", r[ai]||"", r[pi]||"", r[cli]||"", r[ei]||"", r[doi]||"", r[mi]||"", r[ti]||"", r[hzi]||"", r[ri]||"");
			}
			console.log(`Seeded ${rows.length - 1} drivers from Carrier Database sheet into SQLite`);
		} catch (err) { console.error("Driver seed error:", err.message); }
	})();
}

// Backfill carrier_driver_history from drivers_directory on first startup
{
	const cdhCount = db.prepare("SELECT COUNT(*) AS c FROM carrier_driver_history").get().c;
	if (cdhCount === 0) {
		const drivers = db.prepare("SELECT driver_name, carrier_name FROM drivers_directory WHERE carrier_name != ''").all();
		const ins = db.prepare("INSERT OR IGNORE INTO carrier_driver_history (carrier_name, driver_name) VALUES (?, ?)");
		let count = 0;
		for (const d of drivers) {
			if (d.driver_name && d.carrier_name) { ins.run(d.carrier_name, d.driver_name); count++; }
		}
		if (count) console.log(`Backfilled ${count} carrier-driver pairing(s) to history`);
	}
}

// Helper: sync carrier-driver pairings from Carrier Database sheet into history table
// Detects when a driver changes carriers and preserves the old pairing
function syncCarrierDriverHistory(carrierDBData, driverColName, carrierColName) {
	if (!driverColName || !carrierColName) return;
	const now = new Date().toISOString();
	carrierDBData.forEach(row => {
		const driverName = (row[driverColName] || "").trim();
		const carrierName = (row[carrierColName] || "").trim();
		if (!driverName || !carrierName) return;
		const driverLower = driverName.toLowerCase();
		const carrierLower = carrierName.toLowerCase();
		// Check for open record for this driver
		const current = db.prepare(
			"SELECT id, carrier_name FROM carrier_driver_history WHERE LOWER(driver_name) = ? AND ended_at IS NULL"
		).get(driverLower);
		if (current) {
			if (current.carrier_name.toLowerCase() === carrierLower) return; // no change
			// Carrier changed: close old record
			db.prepare("UPDATE carrier_driver_history SET ended_at = ? WHERE id = ?").run(now, current.id);
		}
		// Insert new open record
		db.prepare("INSERT INTO carrier_driver_history (carrier_name, driver_name, started_at) VALUES (?, ?, ?)").run(carrierName, driverName, now);
	});
}

// Helper: get ALL drivers for an investor via company_name on their user account
function getInvestorDriverSet(userId, carrierDBData, driverColName, carrierColName) {
	const usr = db.prepare("SELECT company_name FROM users WHERE id = ?").get(userId);
	const carrierName = usr ? (usr.company_name || "").trim() : "";
	const set = new Set();
	// 1. From trucks assigned to this investor (most authoritative — direct owner_id link)
	const truckDrivers = db.prepare(
		"SELECT DISTINCT assigned_driver FROM trucks WHERE owner_id = ? AND assigned_driver IS NOT NULL AND assigned_driver != ''"
	).all(userId);
	truckDrivers.forEach(t => set.add(t.assigned_driver.trim().toLowerCase()));
	// 2. From live Carrier Database (drivers_directory) matching carrier name
	if (carrierName && carrierDBData && driverColName && carrierColName) {
		const carrierLower = carrierName.toLowerCase();
		carrierDBData.forEach(row => {
			const rowCarrier = (row[carrierColName] || "").trim().toLowerCase();
			const rowDriver = (row[driverColName] || "").trim().toLowerCase();
			if (rowCarrier === carrierLower && rowDriver) set.add(rowDriver);
		});
	}
	// 3. From carrier_driver_history (historical pairings)
	if (carrierName) {
		const historical = db.prepare(
			"SELECT DISTINCT driver_name FROM carrier_driver_history WHERE LOWER(carrier_name) = ?"
		).all(carrierName.toLowerCase());
		historical.forEach(h => { if (h.driver_name) set.add(h.driver_name.trim().toLowerCase()); });
	}
	return set;
}

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

// Migration: add investor_id to legal_documents for profile-level docs
try { db.exec("ALTER TABLE legal_documents ADD COLUMN investor_id INTEGER DEFAULT 0"); } catch {}

// Migration: add driver_id to legal_documents for Super-Admin-shared driver documents
// (insurance card, driver's license, photos, etc. that the driver sees read-only in their Kit tab)
try { db.exec("ALTER TABLE legal_documents ADD COLUMN driver_id INTEGER DEFAULT 0"); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_legal_docs_driver ON legal_documents(driver_id)"); } catch {}

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
db.exec(`CREATE INDEX IF NOT EXISTS idx_locations_driver_ts ON driver_locations(driver, timestamp DESC)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_locations_driver_load ON driver_locations(driver, load_id)`);

// driver_locations grows unbounded (every active driver pings every 30s).
// Purge rows older than 90 days on a weekly schedule + once at boot to seed.
function purgeOldDriverLocations() {
	try {
		const result = db.prepare("DELETE FROM driver_locations WHERE timestamp < datetime('now', '-90 days')").run();
		if (result.changes > 0) console.log(`[cleanup] Purged ${result.changes} old driver_locations rows`);
	} catch (err) {
		console.error("[cleanup] driver_locations purge failed:", err.message);
	}
}
purgeOldDriverLocations();
setInterval(purgeOldDriverLocations, 7 * 24 * 60 * 60 * 1000); // weekly

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
		["investor_split_pct", "50"],
		["blue_chip_brokers", "Pepsi,Coca-Cola,PepsiCo,Frito-Lay,Nestle,Procter & Gamble,Unilever,Walmart,Amazon,Target"],
		["maintenance_fund_monthly", "800"],
		["fuel_savings_target_pct", "15"],
	]);
}

// --- Driver Onboarding ---
db.exec(`
	CREATE TABLE IF NOT EXISTS driver_onboarding (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		user_id INTEGER NOT NULL UNIQUE,
		application_id INTEGER NOT NULL,
		driver_name TEXT NOT NULL,
		status TEXT NOT NULL DEFAULT 'documents_pending'
			CHECK(status IN ('documents_pending','documents_signed','fully_onboarded')),
		drug_test_result TEXT DEFAULT '',
		drug_test_file_url TEXT DEFAULT '',
		drug_test_uploaded_at TEXT DEFAULT '',
		onboarded_at TEXT DEFAULT '',
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		FOREIGN KEY (user_id) REFERENCES users(id),
		FOREIGN KEY (application_id) REFERENCES job_applications(id)
	)
`);

db.exec(`
	CREATE TABLE IF NOT EXISTS onboarding_documents (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		user_id INTEGER NOT NULL,
		doc_key TEXT NOT NULL,
		doc_name TEXT NOT NULL,
		signed INTEGER DEFAULT 0,
		signature_text TEXT DEFAULT '',
		signed_at TEXT DEFAULT '',
		confidential INTEGER DEFAULT 0,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		UNIQUE(user_id, doc_key),
		FOREIGN KEY (user_id) REFERENCES users(id)
	)
`);
// Migration: add signed_pdf_url column
try { db.exec("ALTER TABLE onboarding_documents ADD COLUMN signed_pdf_url TEXT DEFAULT ''"); } catch { /* exists */ }

db.exec(`
	CREATE TABLE IF NOT EXISTS driver_payment_info (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		user_id INTEGER NOT NULL UNIQUE,
		payment_method TEXT DEFAULT '',
		check_name TEXT DEFAULT '',
		bank_name TEXT DEFAULT '',
		bank_address TEXT DEFAULT '',
		bank_phone TEXT DEFAULT '',
		bank_routing TEXT DEFAULT '',
		bank_account TEXT DEFAULT '',
		bank_acct_name TEXT DEFAULT '',
		account_type TEXT DEFAULT '',
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		FOREIGN KEY (user_id) REFERENCES users(id)
	)
`);

db.exec(`
	CREATE TABLE IF NOT EXISTS invoices (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		invoice_number TEXT NOT NULL UNIQUE,
		driver TEXT NOT NULL,
		week_start TEXT NOT NULL,
		week_end TEXT NOT NULL,
		loads_count INTEGER NOT NULL DEFAULT 0,
		rate_per_load REAL NOT NULL DEFAULT 250.00,
		total_earnings REAL NOT NULL DEFAULT 0,
		expenses_total REAL NOT NULL DEFAULT 0,
		status TEXT NOT NULL DEFAULT 'Draft'
			CHECK(status IN ('Draft','Submitted','Approved','Processing','Rejected','Paid')),
		rejection_note TEXT DEFAULT '',
		pdf_file_name TEXT DEFAULT '',
		load_ids TEXT DEFAULT '[]',
		expense_ids TEXT DEFAULT '[]',
		submitted_at TEXT DEFAULT '',
		approved_at TEXT DEFAULT '',
		approved_by TEXT DEFAULT '',
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP
	)
`);
// Migrate: rebuild invoices table if CHECK constraint is outdated (adds 'Processing').
// Wrapped in a transaction so a crash mid-migration rolls back to the
// original state — prevents leaving an orphan `invoices_old` table behind.
// Also cleans up any orphan left by a previous failed attempt.
try { db.exec("DROP TABLE IF EXISTS invoices_old"); } catch {}
try {
	db.prepare("INSERT INTO invoices (invoice_number, driver, week_start, week_end, status) VALUES ('__test_proc__', '__test__', '1970-01-01', '1970-01-07', 'Processing')").run();
	db.prepare("DELETE FROM invoices WHERE invoice_number = '__test_proc__'").run();
} catch {
	const migrateInvoices = db.transaction(() => {
		db.exec(`
			ALTER TABLE invoices RENAME TO invoices_old;
			CREATE TABLE invoices (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				invoice_number TEXT NOT NULL UNIQUE,
				driver TEXT NOT NULL,
				week_start TEXT NOT NULL,
				week_end TEXT NOT NULL,
				loads_count INTEGER NOT NULL DEFAULT 0,
				rate_per_load REAL NOT NULL DEFAULT 250.00,
				total_earnings REAL NOT NULL DEFAULT 0,
				expenses_total REAL NOT NULL DEFAULT 0,
				status TEXT NOT NULL DEFAULT 'Draft'
					CHECK(status IN ('Draft','Submitted','Approved','Processing','Rejected','Paid')),
				rejection_note TEXT DEFAULT '',
				pdf_file_name TEXT DEFAULT '',
				load_ids TEXT DEFAULT '[]',
				expense_ids TEXT DEFAULT '[]',
				submitted_at TEXT DEFAULT '',
				approved_at TEXT DEFAULT '',
				approved_by TEXT DEFAULT '',
				created_at DATETIME DEFAULT CURRENT_TIMESTAMP
			);
			INSERT INTO invoices SELECT * FROM invoices_old;
			DROP TABLE invoices_old;
		`);
	});
	migrateInvoices();
	console.log("Migrated invoices table: added 'Processing' to status CHECK");
}
// Preserve a per-transition audit trail (approve → processing → paid) so
// the original approver isn't overwritten when the invoice advances through
// later states. Each added via ALTER TABLE (idempotent via try-catch).
try { db.exec("ALTER TABLE invoices ADD COLUMN processed_at TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE invoices ADD COLUMN processed_by TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE invoices ADD COLUMN paid_at TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE invoices ADD COLUMN paid_by TEXT DEFAULT ''"); } catch {}

db.exec(`CREATE INDEX IF NOT EXISTS idx_invoices_driver ON invoices(driver)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_invoices_week ON invoices(week_start, week_end)`);
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_driver_week ON invoices(driver, week_start)`);

// Onboarding document definitions
const ONBOARDING_DOCS = [
	{ key: "contractor_agreement", name: "Contractor Agreement", confidential: 1 },
	{ key: "equipment_policy", name: "Contracted Provider Equipment Policy", confidential: 0 },
	{ key: "w9", name: "W-9 Tax Form", confidential: 1 },
	{ key: "mobile_policy", name: "LogisX Inc. Mobile Policy", confidential: 0 },
	{ key: "substance_policy", name: "Substance Policy and Procedure", confidential: 0 },
];

// --- Investor Onboarding ---
db.exec(`
	CREATE TABLE IF NOT EXISTS investor_applications (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		legal_name TEXT NOT NULL,
		dba TEXT DEFAULT '',
		entity_type TEXT DEFAULT '',
		address TEXT DEFAULT '',
		contact_person TEXT DEFAULT '',
		contact_title TEXT DEFAULT '',
		phone TEXT DEFAULT '',
		email TEXT DEFAULT '',
		years_in_operation TEXT DEFAULT '',
		industry_experience TEXT DEFAULT '',
		fleet_size TEXT DEFAULT '',
		preferred_communication TEXT DEFAULT '',
		tax_classification TEXT DEFAULT '',
		ein_ssn TEXT DEFAULT '',
		bankruptcy_liens TEXT DEFAULT '',
		reporting_preference TEXT DEFAULT '',
		vehicle_year TEXT DEFAULT '',
		vehicle_make TEXT DEFAULT '',
		vehicle_model TEXT DEFAULT '',
		vehicle_vin TEXT DEFAULT '',
		vehicle_mileage TEXT DEFAULT '',
		vehicle_title_state TEXT DEFAULT '',
		vehicle_liens TEXT DEFAULT '',
		vehicle_registered_owner TEXT DEFAULT '',
		access_token TEXT DEFAULT '',
		status TEXT DEFAULT 'Draft' CHECK(status IN ('Draft','New','Reviewed','Accepted','Rejected')),
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP
	)
`);
// Migration: add access_token if missing
try { db.exec("ALTER TABLE investor_applications ADD COLUMN access_token TEXT DEFAULT ''"); } catch { /* exists */ }
try { db.exec("ALTER TABLE investor_applications ADD COLUMN vehicles_json TEXT DEFAULT '[]'"); } catch { /* exists */ }

// Migration: add 'Draft' to investor_applications status CHECK constraint
try {
	db.prepare("INSERT INTO investor_applications (legal_name, ein_ssn, phone, email, address, status) VALUES ('__test__','__t__','__t__','__t__','__t__','Draft')").run();
	db.prepare("DELETE FROM investor_applications WHERE legal_name='__test__'").run();
} catch {
	db.pragma("foreign_keys = OFF");
	db.exec(`
		ALTER TABLE investor_applications RENAME TO investor_applications_old;
		CREATE TABLE investor_applications (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			legal_name TEXT NOT NULL, dba TEXT DEFAULT '', entity_type TEXT DEFAULT '',
			address TEXT DEFAULT '', contact_person TEXT DEFAULT '', contact_title TEXT DEFAULT '',
			phone TEXT DEFAULT '', email TEXT DEFAULT '',
			years_in_operation TEXT DEFAULT '', industry_experience TEXT DEFAULT '',
			fleet_size TEXT DEFAULT '', preferred_communication TEXT DEFAULT '',
			tax_classification TEXT DEFAULT '', ein_ssn TEXT DEFAULT '',
			bankruptcy_liens TEXT DEFAULT '', reporting_preference TEXT DEFAULT '',
			vehicle_year TEXT DEFAULT '', vehicle_make TEXT DEFAULT '', vehicle_model TEXT DEFAULT '',
			vehicle_vin TEXT DEFAULT '', vehicle_mileage TEXT DEFAULT '',
			vehicle_title_state TEXT DEFAULT '', vehicle_liens TEXT DEFAULT '',
			vehicle_registered_owner TEXT DEFAULT '', access_token TEXT DEFAULT '',
			vehicles_json TEXT DEFAULT '[]',
			status TEXT DEFAULT 'Draft' CHECK(status IN ('Draft','New','Reviewed','Accepted','Rejected')),
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		);
		INSERT INTO investor_applications SELECT id, legal_name, dba, entity_type,
			address, contact_person, contact_title, phone, email,
			years_in_operation, industry_experience, fleet_size, preferred_communication,
			tax_classification, ein_ssn, bankruptcy_liens, reporting_preference,
			vehicle_year, vehicle_make, vehicle_model, vehicle_vin, vehicle_mileage,
			vehicle_title_state, vehicle_liens, vehicle_registered_owner, access_token,
			vehicles_json, status, created_at FROM investor_applications_old;
		DROP TABLE investor_applications_old;
	`);
	db.pragma("foreign_keys = ON");
}

db.exec(`
	CREATE TABLE IF NOT EXISTS investor_onboarding (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		application_id INTEGER NOT NULL UNIQUE,
		status TEXT DEFAULT 'documents_pending'
			CHECK(status IN ('documents_pending','banking_pending','fully_onboarded')),
		onboarded_at TEXT DEFAULT '',
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		FOREIGN KEY (application_id) REFERENCES investor_applications(id)
	)
`);

db.exec(`
	CREATE TABLE IF NOT EXISTS investor_onboarding_documents (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		application_id INTEGER NOT NULL,
		doc_key TEXT NOT NULL,
		doc_name TEXT NOT NULL,
		signed INTEGER DEFAULT 0,
		signature_text TEXT DEFAULT '',
		signed_at TEXT DEFAULT '',
		signed_pdf_url TEXT DEFAULT '',
		UNIQUE(application_id, doc_key),
		FOREIGN KEY (application_id) REFERENCES investor_applications(id)
	)
`);
try { db.exec("ALTER TABLE investor_onboarding_documents ADD COLUMN signature_image TEXT DEFAULT ''"); } catch { /* exists */ }

db.exec(`
	CREATE TABLE IF NOT EXISTS investor_payment_info (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		application_id INTEGER NOT NULL UNIQUE,
		bank_name TEXT DEFAULT '',
		account_type TEXT DEFAULT '',
		routing_number TEXT DEFAULT '',
		account_number TEXT DEFAULT '',
		account_name TEXT DEFAULT '',
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		FOREIGN KEY (application_id) REFERENCES investor_applications(id)
	)
`);

db.exec(`
	CREATE TABLE IF NOT EXISTS investor_outreach_log (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		email TEXT NOT NULL,
		subject TEXT NOT NULL,
		sent_by TEXT NOT NULL,
		status TEXT DEFAULT 'sent',
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP
	)
`);

// Truck ↔ Driver assignment history
db.exec(`
	CREATE TABLE IF NOT EXISTS truck_assignments (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		truck_id INTEGER NOT NULL,
		driver_name TEXT NOT NULL,
		start_date TEXT NOT NULL,
		end_date TEXT DEFAULT '',
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		FOREIGN KEY (truck_id) REFERENCES trucks(id)
	)
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_ta_truck ON truck_assignments(truck_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_ta_driver ON truck_assignments(driver_name)`);

// Helper: assign a driver to a truck (closes previous assignments, updates trucks.assigned_driver)
function assignDriverToTruck(truckId, driverName) {
	const now = new Date().toISOString();
	const nameLower = driverName.trim().toLowerCase();
	// Close any active assignment for this truck
	db.prepare("UPDATE truck_assignments SET end_date = ? WHERE truck_id = ? AND end_date = ''").run(now, truckId);
	// Close any active assignment for this driver (can only drive one truck)
	db.prepare("UPDATE truck_assignments SET end_date = ? WHERE LOWER(driver_name) = ? AND end_date = ''").run(now, nameLower);
	// Insert new assignment
	if (driverName.trim()) {
		db.prepare("INSERT INTO truck_assignments (truck_id, driver_name, start_date) VALUES (?, ?, ?)").run(truckId, driverName.trim(), now);
	}
	// Sync trucks.assigned_driver for backward compat
	db.prepare("UPDATE trucks SET assigned_driver = '' WHERE LOWER(assigned_driver) = ? AND id != ?").run(nameLower, truckId);
	db.prepare("UPDATE trucks SET assigned_driver = ? WHERE id = ?").run(driverName.trim(), truckId);
}

const INVESTOR_ONBOARDING_DOCS = [
	{ key: "master_agreement", name: "Master Participation & Management Agreement" },
	{ key: "vehicle_lease", name: "Commercial Vehicle Lease Agreement" },
	{ key: "w9", name: "W-9 Tax Form" },
];

// Session store in SQLite (persists across server restarts)
if (!process.env.SESSION_SECRET) {
	if (process.env.NODE_ENV === "production") {
		throw new Error("SESSION_SECRET must be set in production");
	}
	console.warn("WARNING: SESSION_SECRET not set in environment — using dev fallback. Set it in .env for production.");
}
const SESSION_SECRET = process.env.SESSION_SECRET || "dev-only-fallback-do-not-use-in-production";
app.use(
	session({
		store: new SqliteStore({ client: db, expired: { clear: true, intervalMs: 3600000 } }),
		secret: SESSION_SECRET,
		resave: false,
		saveUninitialized: false,
		cookie: {
			maxAge: 24 * 60 * 60 * 1000,
			httpOnly: true,
			secure: process.env.NODE_ENV === "production",
			sameSite: "strict",
		},
	}),
);
// ============================================================
// n8n Webhook: Upsert job into sheet_job_tracking (replaces Google Sheets write)
// ============================================================
app.post("/api/n8n/job", (req, res) => {
	const webhookSecret = process.env.N8N_WEBHOOK_SECRET;
	if (!webhookSecret || req.headers["x-webhook-secret"] !== webhookSecret) {
		return res.status(401).json({ error: "Unauthorized" });
	}
	try {
		const {
			load_id, details, driver, pickup_info, pickup_appointment, pickup_address,
			dropoff_info, dropoff_appointment, dropoff_address, payment, broker_contact_name,
			phone_number, email, assigned_date, documents, contract_id, trailer_number,
			job_status, truck,
		} = req.body;
		if (!load_id) return res.status(400).json({ error: "load_id is required" });

		// Upsert: update if load_id exists, insert if not
		const existing = db.prepare("SELECT id FROM sheet_job_tracking WHERE load_id = ?").get(load_id);
		if (existing) {
			const sets = [];
			const params = [];
			const maybeSet = (col, val) => { if (val !== undefined && val !== null) { sets.push(`${col} = ?`); params.push(val); } };
			maybeSet("details", details);
			maybeSet("driver", driver);
			maybeSet("pickup_info", pickup_info);
			maybeSet("pickup_appointment", pickup_appointment);
			maybeSet("pickup_address", pickup_address);
			maybeSet("dropoff_info", dropoff_info);
			maybeSet("dropoff_appointment", dropoff_appointment);
			maybeSet("dropoff_address", dropoff_address);
			maybeSet("_payment_", payment);
			maybeSet("broker_contact_name", broker_contact_name);
			maybeSet("phone_number", phone_number);
			maybeSet("email", email);
			maybeSet("assigned_date", assigned_date);
			maybeSet("documents", documents);
			maybeSet("contract_id", contract_id);
			maybeSet("trailer_number", trailer_number);
			maybeSet("job_status", job_status);
			maybeSet("truck", truck);
			if (sets.length > 0) {
				params.push(existing.id);
				db.prepare(`UPDATE sheet_job_tracking SET ${sets.join(", ")} WHERE id = ?`).run(...params);
			}
			res.json({ success: true, action: "updated", id: existing.id });
		} else {
			const result = db.prepare(`INSERT INTO sheet_job_tracking
				(load_id, details, driver, pickup_info, pickup_appointment, pickup_address,
				dropoff_info, dropoff_appointment, dropoff_address, _payment_, broker_contact_name,
				phone_number, email, assigned_date, documents, contract_id, trailer_number, job_status, truck)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
			.run(load_id, details || "", driver || "", pickup_info || "", pickup_appointment || "",
				pickup_address || "", dropoff_info || "", dropoff_appointment || "", dropoff_address || "",
				payment || "", broker_contact_name || "", phone_number || "", email || "",
				assigned_date || "", documents || "", contract_id || "", trailer_number || "",
				job_status || "Dispatched", truck || "");
			res.json({ success: true, action: "inserted", id: result.lastInsertRowid });
		}
	} catch (err) {
		res.status(500).json({ error: err.message });
	}
});

// Shared email helper
async function sendEmail(to, subject, htmlBody, attachments = []) {
	const gmailUser = process.env.GMAIL_USER;
	const gmailPass = process.env.GMAIL_APP_PASSWORD;
	if (!gmailUser || !gmailPass) return;
	try {
		const transporter = nodemailer.createTransport({ service: "gmail", auth: { user: gmailUser, pass: gmailPass } });
		await transporter.sendMail({ from: `"LogisX Inc." <${gmailUser}>`, to, subject, html: htmlBody, attachments });
	} catch (err) {
		console.error("Email send failed:", err.message);
	}
}

// Minimal HTML escape for user-sourced strings interpolated into email
// templates. Prevents Super Admin-supplied rejection notes or phished
// DB values from injecting arbitrary markup into outbound email.
function escHtml(s) {
	return String(s ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

// Shared HTML wrapper for invoice notifications — matches the
// driverWelcomeHtml branded template further down in this file so all
// LogisX outbound emails have a consistent look.
function invoiceEmailHtml({ heading, bodyHtml, ctaText = "", ctaHref = "" }) {
	return `
	<div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:600px;margin:0 auto;color:#1e293b">
		<div style="background:#0f2847;padding:24px 32px;border-radius:12px 12px 0 0">
			<img src="https://app.logisx.com/logo.avif" alt="LogisX" style="height:36px" />
		</div>
		<div style="padding:32px;background:#fff;border:1px solid #e2e8f0;border-top:none">
			<h2 style="margin:0 0 16px;font-size:20px;color:#0f172a">${heading}</h2>
			${bodyHtml}
			${ctaText && ctaHref ? `<div style="margin-top:24px;text-align:center">
				<a href="${ctaHref}" style="display:inline-block;background:#0f2847;color:#fff;padding:12px 32px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px">${ctaText}</a>
			</div>` : ""}
		</div>
		<div style="padding:16px 32px;text-align:center">
			<div style="font-size:11px;color:#94a3b8;line-height:1.6">LogisX Inc. | 4576 Research Forest Dr, Suite 200, The Woodlands, TX 77381 | USDOT# 4302683</div>
		</div>
	</div>`;
}

// Build a status-change email body. Called by the approve endpoint on every
// transition so the driver stays in the loop automatically.
function invoiceStatusChangeEmail(invoice, newStatus, rejectionNote = "") {
	const statusLabel = newStatus;
	const headline = {
		Approved: "Your invoice has been approved",
		Processing: "Your payment is being processed",
		Paid: "Your invoice has been paid",
		Rejected: "Your invoice needs attention",
	}[newStatus] || `Invoice status updated to ${newStatus}`;
	const statusColor = {
		Approved: "#16a34a", Processing: "#f59e0b", Paid: "#16a34a", Rejected: "#dc2626",
	}[newStatus] || "#0ea5e9";
	const noteBlock = newStatus === "Rejected" && rejectionNote
		? `<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:12px 16px;margin:16px 0;color:#991b1b;font-size:13px"><b>Reason:</b> ${escHtml(rejectionNote)}</div>`
		: "";
	const body = `
		<p style="margin:0 0 12px;line-height:1.6;color:#334155">Hi <b>${escHtml(invoice.driver)}</b>,</p>
		<p style="margin:0 0 12px;line-height:1.6;color:#334155">Your invoice <b>${escHtml(invoice.invoice_number)}</b> for the week of ${escHtml(invoice.week_start)} — ${escHtml(invoice.week_end)} has been updated.</p>
		<div style="background:#f0f9ff;border:1px solid #bae6fd;border-radius:10px;padding:16px;margin:16px 0">
			<div style="font-size:12px;color:#64748b;text-transform:uppercase;letter-spacing:0.04em">New Status</div>
			<div style="font-size:22px;font-weight:700;color:${statusColor};margin-top:4px">${statusLabel}</div>
		</div>
		<p style="margin:0 0 12px;line-height:1.5;color:#334155;font-size:14px"><b>Total:</b> $${Number(invoice.total_earnings || 0).toFixed(2)}</p>
		${noteBlock}
	`;
	return invoiceEmailHtml({
		heading: headline,
		bodyHtml: body,
		ctaText: "View Invoice",
		ctaHref: "https://app.logisx.com/invoices",
	});
}

// Serve Vue SPA build (client/dist) if it exists, otherwise fall back to public/
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
const SPREADSHEET_ID = "1ey1n0AAG0k8k-qwkWh2T_C8VqqY129OQQr7D5wNl7Mo"; // Production sheet (Dispatch Management - original, n8n writes here)
const ARCHIVE_SPREADSHEET_ID = "1WCiMmcI7GuS4eFaG9PAop5CFtMKKtfla1sOAKxcEduI"; // Old data (read-only archive)
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
// Sync driver to SQLite drivers_directory (replaces Google Sheet sync)
function syncDriverToCarrierSheet(driverName, opts = {}) {
	const { oldName, email, companyName, action } = opts;
	try {
		const truck = driverName ? db.prepare("SELECT unit_number FROM trucks WHERE LOWER(assigned_driver) = LOWER(?)").get(driverName.trim()) : null;
		const truckUnit = truck ? truck.unit_number : "";

		if (action === "add") {
			// New drivers created via onboarding start as 'pending' — they become 'active' when drug test passes
			db.prepare(`INSERT OR IGNORE INTO drivers_directory (driver_name, carrier_name, email, trucks, status) VALUES (?, ?, ?, ?, 'pending')`)
				.run(driverName.trim(), companyName || "", email || "", truckUnit);
		} else if (action === "update") {
			const existing = db.prepare("SELECT id FROM drivers_directory WHERE LOWER(driver_name) = LOWER(?)").get((oldName || driverName || "").trim());
			if (!existing) {
				return syncDriverToCarrierSheet(driverName, { ...opts, action: "add" });
			}
			const sets = ["driver_name = ?"];
			const params = [driverName.trim()];
			if (companyName !== undefined) { sets.push("carrier_name = ?"); params.push(companyName); }
			if (email !== undefined) { sets.push("email = ?"); params.push(email); }
			sets.push("trucks = ?"); params.push(truckUnit);
			params.push(existing.id);
			db.prepare(`UPDATE drivers_directory SET ${sets.join(", ")} WHERE id = ?`).run(...params);
		} else if (action === "delete") {
			db.prepare("DELETE FROM drivers_directory WHERE LOWER(driver_name) = LOWER(?)").run(driverName.trim());
		}
	} catch (err) {
		console.error("syncDriverToDirectory error:", err.message);
	}
}

// Helper: get carrier database from SQLite in the same format as parseSheet() for backward compat
function getCarrierDBFromSQLite() {
	const headers = ["Driver", "Carrier Name", "State", "City", "ZIP", "Address", "Trucks", "Hazmat", "PhoneNumber", "CellNumber", "Email", "DOT", "MC", "Rating", "Status"];
	const rows = db.prepare("SELECT * FROM drivers_directory ORDER BY driver_name ASC").all();
	const data = rows.map((d, i) => {
		const obj = {};
		obj["Driver"] = d.driver_name; obj["Carrier Name"] = d.carrier_name;
		obj["State"] = d.state; obj["City"] = d.city; obj["ZIP"] = d.zip; obj["Address"] = d.address;
		obj["Trucks"] = d.trucks; obj["Hazmat"] = d.hazmat; obj["PhoneNumber"] = d.phone;
		obj["CellNumber"] = d.cell; obj["Email"] = d.email; obj["DOT"] = d.dot;
		obj["MC"] = d.mc; obj["Rating"] = d.rating; obj["Status"] = d.status || 'active';
		obj._rowIndex = d.id;
		return obj;
	});
	return { headers, data };
}

// === DRIVERS DIRECTORY API (replaces Carrier Database sheet reads) ===

// GET /api/drivers-directory — all drivers from SQLite
app.get("/api/drivers-directory", requireAuth, (req, res) => {
	try {
		const drivers = db.prepare("SELECT * FROM drivers_directory ORDER BY driver_name ASC").all();
		// Return in a format compatible with the old sheet-based response
		const headers = ["Driver", "Carrier Name", "State", "City", "ZIP", "Address", "Trucks", "Hazmat", "PhoneNumber", "CellNumber", "Email", "DOT", "MC", "Rating", "Status"];
		const data = drivers.map(d => ({
			Driver: d.driver_name, "Carrier Name": d.carrier_name, State: d.state, City: d.city,
			ZIP: d.zip, Address: d.address, Trucks: d.trucks, Hazmat: d.hazmat,
			PhoneNumber: d.phone, CellNumber: d.cell, Email: d.email, DOT: d.dot, MC: d.mc, Rating: d.rating,
			Status: d.status || 'active',
			ProfilePictureUrl: d.profile_picture_url || '',
			_rowIndex: d.id, _id: d.id,
		}));
		res.json({ headers, data, total: data.length });
	} catch (err) {
		res.status(500).json({ error: err.message });
	}
});

// POST /api/drivers-directory — add driver (manual adds default to active)
app.post("/api/drivers-directory", requireRole("Super Admin", "Dispatcher"), (req, res) => {
	try {
		const { values, headers } = req.body;
		if (!values || !headers) return res.status(400).json({ error: "values and headers required" });
		const obj = {};
		headers.forEach((h, i) => { obj[h] = values[i] || ""; });
		db.prepare(`INSERT OR REPLACE INTO drivers_directory (driver_name, carrier_name, state, city, zip, address, phone, cell, email, dot, mc, trucks, hazmat, rating, status)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
			.run(obj.Driver || "", obj["Carrier Name"] || "", obj.State || "", obj.City || "", obj.ZIP || "",
				obj.Address || "", obj.PhoneNumber || "", obj.CellNumber || "", obj.Email || "",
				obj.DOT || "", obj.MC || "", obj.Trucks || "", obj.Hazmat || "", obj.Rating || "",
				obj.Status || "active");
		// Sync carrier-driver history on write (not on read)
		if (obj.Driver && obj["Carrier Name"]) {
			syncCarrierDriverHistory([obj], "Driver", "Carrier Name");
		}
		notifyChange("drivers");
		res.json({ success: true });
	} catch (err) {
		res.status(500).json({ error: err.message });
	}
});

// PUT /api/drivers-directory/:id — update driver
app.put("/api/drivers-directory/:id", requireRole("Super Admin", "Dispatcher"), (req, res) => {
	try {
		const id = parseInt(req.params.id);
		const { values, headers } = req.body;
		if (!values || !headers) return res.status(400).json({ error: "values and headers required" });
		const obj = {};
		headers.forEach((h, i) => { obj[h] = values[i] || ""; });
		// Keep existing status if the client didn't send one
		const current = db.prepare("SELECT status FROM drivers_directory WHERE id = ?").get(id);
		const nextStatus = obj.Status || current?.status || "active";
		db.prepare(`UPDATE drivers_directory SET driver_name=?, carrier_name=?, state=?, city=?, zip=?, address=?, phone=?, cell=?, email=?, dot=?, mc=?, trucks=?, hazmat=?, rating=?, status=? WHERE id=?`)
			.run(obj.Driver || "", obj["Carrier Name"] || "", obj.State || "", obj.City || "", obj.ZIP || "",
				obj.Address || "", obj.PhoneNumber || "", obj.CellNumber || "", obj.Email || "",
				obj.DOT || "", obj.MC || "", obj.Trucks || "", obj.Hazmat || "", obj.Rating || "",
				nextStatus, id);
		// Sync carrier-driver history on write (not on read)
		if (obj.Driver && obj["Carrier Name"]) {
			syncCarrierDriverHistory([obj], "Driver", "Carrier Name");
		}
		notifyChange("drivers");
		res.json({ success: true });
	} catch (err) {
		res.status(500).json({ error: err.message });
	}
});

// GET /api/drivers-directory/:id/documents — signed onboarding PDFs + drug test + SSN for a driver
app.get("/api/drivers-directory/:id/documents", requireRole("Super Admin", "Dispatcher"), (req, res) => {
	try {
		const id = parseInt(req.params.id);
		const driver = db.prepare("SELECT * FROM drivers_directory WHERE id = ?").get(id);
		if (!driver) return res.status(404).json({ error: "Driver not found" });

		// Find the matching user by driver_name (case-insensitive)
		const user = db.prepare("SELECT id, driver_name FROM users WHERE LOWER(driver_name) = LOWER(?)").get((driver.driver_name || "").trim());
		if (!user) {
			return res.json({ documents: [], drugTest: null, linked: false, ssn: null });
		}

		const onboarding = db.prepare("SELECT drug_test_result, drug_test_file_url, drug_test_uploaded_at, status FROM driver_onboarding WHERE user_id = ?").get(user.id);
		const documents = db.prepare(
			"SELECT doc_key, doc_name, signed, signature_text, signed_at, signed_pdf_url FROM onboarding_documents WHERE user_id = ? ORDER BY id"
		).all(user.id);

		// Pull the original job application record so the profile card can
		// display everything the applicant submitted. SSN is kept out of the
		// application object and returned as a separate, Super-Admin-only field.
		const fullApplication = db.prepare(
			"SELECT * FROM job_applications WHERE id = (SELECT application_id FROM driver_onboarding WHERE user_id = ?)"
		).get(user.id);
		let ssn = null;
		let application = null;
		if (fullApplication) {
			const isSuperAdmin = req.session.user.role === "Super Admin";
			if (isSuperAdmin) {
				ssn = fullApplication.ssn || null;
			}
			// Strip SSN + heavy base64 document fields. Driver's license number is
			// also sensitive PII — only Super Admins see it; Dispatchers get the
			// rest of the application detail without the DL#.
			const { ssn: _drop, cdl_front, cdl_back, medical_card, drivers_license, ...safeApp } = fullApplication;
			application = isSuperAdmin ? { ...safeApp, drivers_license } : safeApp;
		}

		res.json({
			documents,
			drugTest: onboarding && onboarding.drug_test_result ? {
				result: onboarding.drug_test_result,
				file_url: onboarding.drug_test_file_url,
				uploaded_at: onboarding.drug_test_uploaded_at,
			} : null,
			onboardingStatus: onboarding?.status || null,
			linked: true,
			ssn,
			application,
		});
	} catch (err) {
		res.status(500).json({ error: err.message });
	}
});

// DELETE /api/drivers-directory/:id — delete driver (cascades shared documents + profile picture on disk + in DB)
app.delete("/api/drivers-directory/:id", requireRole("Super Admin"), (req, res) => {
	try {
		const id = parseInt(req.params.id);
		if (!id || id <= 0) return res.status(400).json({ error: "Invalid driver id" });
		// Cascade: remove any shared documents uploaded to this driver (files + rows)
		const orphanedDocs = db.prepare("SELECT file_url FROM legal_documents WHERE driver_id = ?").all(id);
		for (const doc of orphanedDocs) {
			if (!doc.file_url) continue;
			try {
				const filePath = path.join(__dirname, doc.file_url);
				if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
			} catch (err) { console.error("Failed to unlink driver doc on cascade:", err.message); }
		}
		// Cascade: remove profile picture if any
		const existingDriver = db.prepare("SELECT profile_picture_url FROM drivers_directory WHERE id = ?").get(id);
		if (existingDriver?.profile_picture_url) {
			try {
				const picPath = path.join(__dirname, existingDriver.profile_picture_url);
				if (fs.existsSync(picPath)) fs.unlinkSync(picPath);
			} catch (err) { console.error("Failed to unlink driver profile pic on cascade:", err.message); }
		}
		db.prepare("DELETE FROM legal_documents WHERE driver_id = ?").run(id);
		db.prepare("DELETE FROM drivers_directory WHERE id = ?").run(id);
		notifyChange("drivers");
		res.json({ success: true, cascadedDocs: orphanedDocs.length });
	} catch (err) {
		res.status(500).json({ error: err.message });
	}
});

// ============================================================
// PROFILE PICTURES — shared helper + per-entity upload endpoints
// ============================================================

// Helper: persist a base64-encoded image to uploads/profile-pictures/ and return its public URL.
// Frontend pre-resizes and exports JPEG via canvas, so we always save with .jpg extension.
function saveProfilePicture(entityType, entityId, fileData) {
	const dir = path.join(__dirname, "uploads", "profile-pictures");
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
	const safeName = `${entityType}-${entityId}-${Date.now()}.jpg`;
	const base64 = fileData.replace(/^data:[^;]+;base64,/, "");
	fs.writeFileSync(path.join(dir, safeName), Buffer.from(base64, "base64"));
	return `/uploads/profile-pictures/${safeName}`;
}

// POST /api/drivers-directory/:id/profile-picture — Super Admin or the driver themselves
app.post("/api/drivers-directory/:id/profile-picture", requireAuth, (req, res) => {
	try {
		const id = parseInt(req.params.id);
		if (!id || id <= 0) return res.status(400).json({ error: "Invalid driver id" });
		const driver = db.prepare("SELECT * FROM drivers_directory WHERE id = ?").get(id);
		if (!driver) return res.status(404).json({ error: "Driver not found" });

		// Ownership check: Super Admin OR Driver role with matching driver_name
		const sessionUser = req.session.user;
		if (sessionUser.role !== "Super Admin") {
			if (sessionUser.role !== "Driver") return res.status(403).json({ error: "Forbidden" });
			const sessionDriver = (sessionUser.driver_name || sessionUser.driverName || "").trim().toLowerCase();
			if (!sessionDriver || sessionDriver !== (driver.driver_name || "").trim().toLowerCase()) {
				return res.status(403).json({ error: "Forbidden" });
			}
		}

		const { fileData } = req.body;
		if (!fileData) return res.status(400).json({ error: "fileData required" });
		if (fileData.length > 7_000_000) return res.status(400).json({ error: "File too large (max 5MB)" });

		// Unlink the old picture if the driver already had one
		if (driver.profile_picture_url) {
			try {
				const oldPath = path.join(__dirname, driver.profile_picture_url);
				if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
			} catch (err) { console.error("Failed to unlink old driver profile pic:", err.message); }
		}

		const fileUrl = saveProfilePicture("driver", id, fileData);
		db.prepare("UPDATE drivers_directory SET profile_picture_url = ? WHERE id = ?").run(fileUrl, id);
		res.json({ success: true, url: fileUrl });
	} catch (err) {
		console.error("Driver profile picture upload error:", err.message);
		res.status(500).json({ error: err.message });
	}
});

// POST /api/investors/:id/profile-picture — Super Admin or the investor themselves
app.post("/api/investors/:id/profile-picture", requireAuth, (req, res) => {
	try {
		const id = parseInt(req.params.id);
		if (!id || id <= 0) return res.status(400).json({ error: "Invalid investor id" });
		const investor = db.prepare("SELECT * FROM investors WHERE id = ?").get(id);
		if (!investor) return res.status(404).json({ error: "Investor not found" });

		// Ownership check: Super Admin OR Investor role whose users.id matches investors.user_id
		const sessionUser = req.session.user;
		if (sessionUser.role !== "Super Admin") {
			if (sessionUser.role !== "Investor" || investor.user_id !== sessionUser.id) {
				return res.status(403).json({ error: "Forbidden" });
			}
		}

		const { fileData } = req.body;
		if (!fileData) return res.status(400).json({ error: "fileData required" });
		if (fileData.length > 7_000_000) return res.status(400).json({ error: "File too large (max 5MB)" });

		// Unlink the old picture if the investor already had one
		if (investor.profile_picture_url) {
			try {
				const oldPath = path.join(__dirname, investor.profile_picture_url);
				if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
			} catch (err) { console.error("Failed to unlink old investor profile pic:", err.message); }
		}

		const fileUrl = saveProfilePicture("investor", id, fileData);
		db.prepare("UPDATE investors SET profile_picture_url = ? WHERE id = ?").run(fileUrl, id);
		res.json({ success: true, url: fileUrl });
	} catch (err) {
		console.error("Investor profile picture upload error:", err.message);
		res.status(500).json({ error: err.message });
	}
});

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

// Authenticated static serving for uploads (drug tests, signed PDFs, invoices, legal docs, etc.)
// Every subdirectory under uploads/ contains sensitive documents (PII, signatures, banking info, SSN on W-9),
// so the entire tree requires a session. Public onboarding flows serve PDFs via dedicated /api/... routes
// instead of direct static URLs, so locking this down does not break any public page.
app.use("/uploads", requireAuth, express.static(path.join(__dirname, "uploads")));

// ============================================================
// PUBLIC: Job Application
// ============================================================
const publicFormLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: { error: "Too many submissions. Try again later." }, standardHeaders: true });
app.post("/api/public/apply", publicFormLimiter, (req, res) => {
	try {
		const { full_name, email, phone, dob, address, ssn, drivers_license, position, experience, has_cdl, work_authorized, felony_convicted, felony_explanation, accident_history, accident_description, traffic_citations, certifications, availability, skills, reference_info, additional_info, signature, signature_date, cdl_front, cdl_back, medical_card, city, state, zip, cell, dot, mc, hazmat } = req.body;
		if (!full_name || !email || !phone || !dob || !address || !ssn || !drivers_license || !position || !experience || !has_cdl || !work_authorized || !felony_convicted || !accident_history || !signature) {
			return res.status(400).json({ error: "Please fill in all required fields." });
		}
		const result = db.prepare(`
			INSERT INTO job_applications (full_name, email, phone, dob, address, ssn, drivers_license, position, experience, has_cdl, work_authorized, felony_convicted, felony_explanation, accident_history, accident_description, traffic_citations, certifications, availability, skills, reference_info, additional_info, signature, signature_date, cdl_front, cdl_back, medical_card, city, state, zip, cell, dot, mc, hazmat)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).run(full_name, email, phone, dob, address, ssn, drivers_license, position, experience, has_cdl, work_authorized, felony_convicted, felony_explanation || '', accident_history, accident_description || '', traffic_citations || '', certifications || '', JSON.stringify(availability || []), skills, typeof reference_info === 'string' ? reference_info : JSON.stringify(reference_info || ''), additional_info || '', signature, signature_date || new Date().toLocaleDateString('en-US'), cdl_front || '', cdl_back || '', medical_card || '', city || '', state || '', zip || '', cell || '', dot || '', mc || '', hazmat || '');
		res.json({ success: true, id: result.lastInsertRowid });

		// Send confirmation email to applicant (branded HTML)
		const applicantDriverHtml = `
		<div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:600px;margin:0 auto;color:#1e293b">
			<div style="background:#0f2847;padding:24px 32px;border-radius:12px 12px 0 0">
				<img src="https://app.logisx.com/logo.avif" alt="LogisX" style="height:36px" />
			</div>
			<div style="padding:32px;background:#fff;border:1px solid #e2e8f0;border-top:none">
				<h2 style="margin:0 0 16px;font-size:20px;color:#0f172a">Onboarding Status: Documents Received!</h2>
				<p style="margin:0 0 12px;line-height:1.6;color:#334155">Hi <b>${full_name}</b>,</p>
				<p style="margin:0 0 20px;line-height:1.6;color:#334155">Thanks for getting your paperwork squared away. Now that the legal stuff is signed and uploaded, you've officially cleared Phase 1. We are currently reviewing your file.</p>

				<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:16px;margin:0 0 24px">
					<div style="font-size:13px;font-weight:700;color:#0f172a;margin-bottom:12px">Here is what happens next:</div>
					<table style="width:100%;border-collapse:collapse;font-size:13px;color:#334155">
						<tr>
							<td style="padding:8px 10px 8px 0;vertical-align:top;width:24px"><div style="width:22px;height:22px;border-radius:50%;background:#0f2847;color:#fff;font-size:11px;font-weight:700;text-align:center;line-height:22px">1</div></td>
							<td style="padding:8px 0;line-height:1.5;border-bottom:1px solid #f1f5f9"><b>Pre-Employment Screening:</b> A member of our safety team will contact you shortly to schedule your <b>pre-appointment drug test</b>. If you've already completed one recently for another carrier, let us know, but expect to be sent for a new one under the LogisX account.</td>
						</tr>
						<tr>
							<td style="padding:8px 10px 8px 0;vertical-align:top"><div style="width:22px;height:22px;border-radius:50%;background:#0f2847;color:#fff;font-size:11px;font-weight:700;text-align:center;line-height:22px">2</div></td>
							<td style="padding:8px 0;line-height:1.5;border-bottom:1px solid #f1f5f9"><b>FMCSA Clearinghouse:</b> This is mandatory. If you haven't already, make sure you are enrolled in the <b>FMCSA Clearinghouse</b> and have granted LogisX Inc. permission to run your full query. We cannot put you in a truck until this is cleared.</td>
						</tr>
						<tr>
							<td style="padding:8px 10px 8px 0;vertical-align:top"><div style="width:22px;height:22px;border-radius:50%;background:#0f2847;color:#fff;font-size:11px;font-weight:700;text-align:center;line-height:22px">3</div></td>
							<td style="padding:8px 0;line-height:1.5"><b>Driver Training:</b> While we finalize your background check, it's time to get in the right mindset. At LogisX, we pride ourselves on professional, elite operation.</td>
						</tr>
					</table>
				</div>

				<div style="background:#fffbeb;border:1px solid #fef3c7;border-left:4px solid #f59e0b;border-radius:8px;padding:14px 18px;margin:0 0 24px">
					<div style="font-size:13px;font-weight:700;color:#92400e;margin-bottom:6px">Pro-Tip: Don't end up on the internet for the wrong reasons.</div>
					<p style="margin:0;font-size:13px;color:#78350f;line-height:1.5">To understand the standard of safety we expect, take a look at what <em>not</em> to do out there. Check out these "professional" moves on <b>Bonehead Truckers</b> &mdash; study them so you don't repeat them.</p>
				</div>

				<div style="text-align:center;margin:0 0 24px">
					<a href="https://www.youtube.com/watch?v=KpHxeBQ3TSc&list=PL7DBE50EBBC23F024" style="display:inline-block;background:#dc2626;color:#ffffff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px">&#9654; Watch Bonehead Truckers</a>
				</div>

				<p style="margin:0 0 6px;font-size:14px;color:#334155;text-align:center">Stand by for a call from our safety coordinator.</p>
				<p style="margin:0;font-size:14px;font-weight:700;color:#0f172a;text-align:center">&mdash; The LogisX Safety Team</p>
			</div>
			<div style="padding:16px 32px;text-align:center;background:#f8fafc;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 12px 12px">
				<div style="font-size:11px;color:#94a3b8;line-height:1.6">LogisX Inc. | 4576 Research Forest Dr, Suite 200, The Woodlands, TX 77381 | USDOT# 4302683</div>
			</div>
		</div>`;
		sendEmail(email, "LogisX - Onboarding Status: Documents Received!", applicantDriverHtml);

		// Send admin notification (detailed)
		const adminDriverHtml = `
		<div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:600px;margin:0 auto;color:#1e293b">
			<div style="background:#0f2847;padding:24px 32px;border-radius:12px 12px 0 0">
				<img src="https://app.logisx.com/logo.avif" alt="LogisX" style="height:36px" />
			</div>
			<div style="padding:32px;background:#fff;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 12px 12px">
				<h2 style="margin:0 0 16px;font-size:20px;color:#0f172a">New Driver Application</h2>
				<p style="margin:0 0 20px;line-height:1.6;color:#334155">A new driver application has been submitted and is ready for review.</p>
				<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:16px;margin:0 0 20px">
					<table style="width:100%;border-collapse:collapse;font-size:14px">
						<tr><td style="padding:5px 0;color:#64748b;width:140px">Name</td><td style="padding:5px 0;font-weight:600">${full_name}</td></tr>
						<tr><td style="padding:5px 0;color:#64748b">Email</td><td style="padding:5px 0"><a href="mailto:${email}">${email}</a></td></tr>
						<tr><td style="padding:5px 0;color:#64748b">Phone</td><td style="padding:5px 0">${phone}</td></tr>
						${cell ? `<tr><td style="padding:5px 0;color:#64748b">Cell</td><td style="padding:5px 0">${cell}</td></tr>` : ''}
						<tr><td style="padding:5px 0;color:#64748b">Position</td><td style="padding:5px 0">${position}</td></tr>
						<tr><td style="padding:5px 0;color:#64748b">Experience</td><td style="padding:5px 0">${experience} years</td></tr>
						<tr><td style="padding:5px 0;color:#64748b">CDL</td><td style="padding:5px 0">${has_cdl}</td></tr>
						<tr><td style="padding:5px 0;color:#64748b">Hazmat</td><td style="padding:5px 0">${hazmat || 'No'}</td></tr>
						<tr><td style="padding:5px 0;color:#64748b">Work Authorized</td><td style="padding:5px 0">${work_authorized}</td></tr>
						<tr><td style="padding:5px 0;color:#64748b">Felony</td><td style="padding:5px 0">${felony_convicted}</td></tr>
						<tr><td style="padding:5px 0;color:#64748b">Address</td><td style="padding:5px 0">${address}</td></tr>
						${(city || state || zip) ? `<tr><td style="padding:5px 0;color:#64748b">City / State / ZIP</td><td style="padding:5px 0">${[city, state].filter(Boolean).join(', ')}${zip ? ' ' + zip : ''}</td></tr>` : ''}
						${dot ? `<tr><td style="padding:5px 0;color:#64748b">DOT #</td><td style="padding:5px 0">${dot}</td></tr>` : ''}
						${mc ? `<tr><td style="padding:5px 0;color:#64748b">MC #</td><td style="padding:5px 0">${mc}</td></tr>` : ''}
					</table>
				</div>
				<div style="text-align:center;margin:24px 0">
					<a href="https://app.logisx.com/applications" style="display:inline-block;background:#0f2847;color:#ffffff;padding:12px 32px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px">Review Application</a>
				</div>
			</div>
			<div style="padding:16px 32px;text-align:center">
				<div style="font-size:11px;color:#94a3b8;line-height:1.6">LogisX Inc. | 4576 Research Forest Dr, Suite 200, The Woodlands, TX 77381 | USDOT# 4302683</div>
			</div>
		</div>`;
		sendEmail("info@logisx.com", `New Driver Application: ${full_name}`, adminDriverHtml);
	} catch (err) {
		res.status(500).json({ error: err.message });
	}
});

app.get("/api/applications", requireRole("Super Admin"), (req, res) => {
	try {
		const apps = db.prepare(`SELECT ja.*, do.user_id AS onboarding_user_id, do.status AS onboarding_status, do.drug_test_result
			FROM job_applications ja
			LEFT JOIN driver_onboarding do ON do.application_id = ja.id
			ORDER BY ja.created_at DESC`).all();
		res.json(apps);
	} catch (err) {
		res.status(500).json({ error: err.message });
	}
});

app.put("/api/applications/:id/status", requireRole("Super Admin"), async (req, res) => {
	try {
		const { status } = req.body;
		if (!['New', 'Reviewed', 'Accepted', 'Rejected'].includes(status)) {
			return res.status(400).json({ error: "Invalid status" });
		}
		const appId = parseInt(req.params.id);
		db.prepare("UPDATE job_applications SET status = ? WHERE id = ?").run(status, appId);

		// Auto-create driver account on acceptance
		if (status === "Accepted") {
			const application = db.prepare("SELECT * FROM job_applications WHERE id = ?").get(appId);
			if (!application) return res.status(404).json({ error: "Application not found" });

			// Check if already onboarded for this application
			const existingOnboarding = db.prepare("SELECT id FROM driver_onboarding WHERE application_id = ?").get(appId);
			if (existingOnboarding) {
				notifyChange("applications");
				return res.json({ success: true, message: "Application accepted (account already exists)" });
			}

			// Generate username from phone: LogisX-{last4digits} (e.g., "LogisX-2609")
			const fullName = application.full_name.trim();
			const phoneDigits = (application.phone || "").replace(/\D/g, "");
			const last4 = phoneDigits.slice(-4) || "0000";
			let baseUsername = `LogisX-${last4}`;
			let username = baseUsername;
			let suffix = 1;
			while (db.prepare("SELECT id FROM users WHERE LOWER(username) = LOWER(?)").get(username)) {
				username = `${baseUsername}-${suffix}`;
				suffix++;
			}

			// Generate random temp password
			const tempPassword = crypto.randomBytes(4).toString("hex"); // 8 char hex string
			const hash = await bcrypt.hash(tempPassword, 10);

			// Create user (do NOT sync to Carrier Database yet — that happens at full onboarding)
			const userResult = db.prepare(
				"INSERT INTO users (username, password_hash, role, driver_name, email, full_name, company_name) VALUES (?, ?, 'Driver', ?, ?, ?, '')"
			).run(username, hash, fullName, application.email || "", fullName);
			const userId = userResult.lastInsertRowid;

			// Create onboarding record
			db.prepare(
				"INSERT INTO driver_onboarding (user_id, application_id, driver_name, status) VALUES (?, ?, ?, 'documents_pending')"
			).run(userId, appId, fullName);

			// Seed 6 onboarding documents
			const seedDoc = db.prepare(
				"INSERT OR IGNORE INTO onboarding_documents (user_id, doc_key, doc_name, confidential) VALUES (?, ?, ?, ?)"
			);
			for (const doc of ONBOARDING_DOCS) {
				seedDoc.run(userId, doc.key, doc.name, doc.confidential);
			}

			logAudit(req, "accept_application", "application", appId, `Accepted driver "${fullName}", created account "${username}"`);
			notifyChange("applications"); notifyChange("users"); notifyChange("drivers");

			res.json({
				success: true,
				accountCreated: true,
				credentials: { username, tempPassword, userId, driverName: fullName },
			});

			// Welcome email to driver (branded)
			const driverWelcomeHtml = `
			<div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:600px;margin:0 auto;color:#1e293b">
				<div style="background:#0f2847;padding:24px 32px;border-radius:12px 12px 0 0">
					<img src="https://app.logisx.com/logo.avif" alt="LogisX" style="height:36px" />
				</div>
				<div style="padding:32px;background:#fff;border:1px solid #e2e8f0;border-top:none">
					<h2 style="margin:0 0 16px;font-size:20px;color:#0f172a">Welcome to LogisX!</h2>
					<p style="margin:0 0 12px;line-height:1.6;color:#334155">Hi <b>${fullName}</b>,</p>
					<p style="margin:0 0 20px;line-height:1.6;color:#334155">Congratulations! Your driver application has been <b style="color:#16a34a">approved</b>. Your account is ready — please log in and complete your onboarding documents to get on the road.</p>

					<div style="background:#f0f9ff;border:1px solid #bae6fd;border-radius:10px;padding:20px;margin:0 0 20px">
						<div style="font-size:12px;font-weight:700;color:#0369a1;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:12px">Your Login Credentials</div>
						<table style="width:100%;border-collapse:collapse;font-size:14px">
							<tr><td style="padding:6px 0;color:#64748b;width:130px">Username</td><td style="padding:6px 0;font-weight:700;color:#0f172a;font-family:monospace">${username}</td></tr>
							<tr><td style="padding:6px 0;color:#64748b">Temporary Password</td><td style="padding:6px 0;font-weight:700;color:#d97706;font-family:monospace">${tempPassword}</td></tr>
						</table>
					</div>

					<div style="text-align:center;margin:28px 0">
						<a href="https://app.logisx.com/login" style="display:inline-block;background:#0f2847;color:#ffffff;padding:14px 40px;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px">Login &amp; Start Onboarding &rarr;</a>
					</div>

					<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:16px;margin:0 0 20px">
						<div style="font-size:13px;font-weight:700;color:#0f172a;margin-bottom:8px">What to expect:</div>
						<table style="width:100%;border-collapse:collapse;font-size:13px;color:#334155">
							<tr><td style="padding:5px 8px 5px 0;vertical-align:top;width:20px"><b>1.</b></td><td style="padding:5px 0;border-bottom:1px solid #f1f5f9">Sign 5 onboarding documents (Contractor Agreement, Equipment Policy, W-9, Mobile Policy, Substance Policy)</td></tr>
							<tr><td style="padding:5px 8px 5px 0;vertical-align:top"><b>2.</b></td><td style="padding:5px 0;border-bottom:1px solid #f1f5f9">Complete pre-employment drug test (our safety team will contact you)</td></tr>
							<tr><td style="padding:5px 8px 5px 0;vertical-align:top"><b>3.</b></td><td style="padding:5px 0">Once cleared, you'll be fully onboarded and ready to receive loads</td></tr>
						</table>
					</div>

					<div style="background:#fffbeb;border:1px solid #fef3c7;border-radius:8px;padding:12px 16px;margin:0 0 20px">
						<p style="margin:0;font-size:13px;color:#92400e;line-height:1.5"><b>Important:</b> Please change your password after your first login for security.</p>
					</div>

					<p style="color:#64748b;font-size:13px;margin:20px 0 0">Questions? Contact us at <a href="mailto:info@logisx.com" style="color:#3b82f6;text-decoration:none">info@logisx.com</a>.</p>
				</div>
				<div style="padding:16px 32px;text-align:center;background:#f8fafc;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 12px 12px">
					<div style="font-size:11px;color:#94a3b8;line-height:1.6">LogisX Inc. | 4576 Research Forest Dr, Suite 200, The Woodlands, TX 77381 | USDOT# 4302683</div>
				</div>
			</div>`;
			sendEmail(application.email, "Welcome to LogisX — Your Driver Account is Ready", driverWelcomeHtml);

			// Admin notification
			const adminDriverAcceptHtml = `
			<div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:600px;margin:0 auto;color:#1e293b">
				<div style="background:#0f2847;padding:24px 32px;border-radius:12px 12px 0 0">
					<img src="https://app.logisx.com/logo.avif" alt="LogisX" style="height:36px" />
				</div>
				<div style="padding:32px;background:#fff;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 12px 12px">
					<h2 style="margin:0 0 16px;font-size:20px;color:#0f172a">Driver Application Accepted</h2>
					<p style="margin:0 0 20px;line-height:1.6;color:#334155">Driver <b>${fullName}</b> has been accepted and their account has been created. They will now proceed to the onboarding phase.</p>

					<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:16px;margin:0 0 20px">
						<table style="width:100%;border-collapse:collapse;font-size:14px">
							<tr><td style="padding:5px 0;color:#64748b;width:140px">Driver Name</td><td style="padding:5px 0;font-weight:600">${fullName}</td></tr>
							<tr><td style="padding:5px 0;color:#64748b">Username</td><td style="padding:5px 0;font-weight:600;font-family:monospace">${username}</td></tr>
							<tr><td style="padding:5px 0;color:#64748b">Email</td><td style="padding:5px 0">${application.email}</td></tr>
							<tr><td style="padding:5px 0;color:#64748b">Phone</td><td style="padding:5px 0">${application.phone}</td></tr>
							<tr><td style="padding:5px 0;color:#64748b">Position</td><td style="padding:5px 0">${application.position}</td></tr>
							<tr><td style="padding:5px 0;color:#64748b">Onboarding Status</td><td style="padding:5px 0;font-weight:600;color:#d97706">Documents Pending (5 docs)</td></tr>
							<tr><td style="padding:5px 0;color:#64748b">Accepted By</td><td style="padding:5px 0">${req.session.user.username}</td></tr>
						</table>
					</div>

					<div style="text-align:center;margin:24px 0">
						<a href="https://app.logisx.com/applications" style="display:inline-block;background:#0f2847;color:#ffffff;padding:12px 32px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px">View Applications</a>
					</div>
				</div>
				<div style="padding:16px 32px;text-align:center">
					<div style="font-size:11px;color:#94a3b8;line-height:1.6">LogisX Inc. | 4576 Research Forest Dr, Suite 200, The Woodlands, TX 77381 | USDOT# 4302683</div>
				</div>
			</div>`;
			sendEmail("info@logisx.com", `Driver Accepted: ${fullName}`, adminDriverAcceptHtml);
			return;
		}

		res.json({ success: true });
	} catch (err) {
		res.status(500).json({ error: err.message });
	}
});

app.get("/api/applications/:id/pdf", requireRole("Super Admin"), async (req, res) => {
	try {
		const app = db.prepare("SELECT * FROM job_applications WHERE id = ?").get(parseInt(req.params.id));
		if (!app) return res.status(404).json({ error: "Application not found" });

		// Capture pdfkit output into a buffer so we can optionally append
		// uploaded-PDF pages via pdf-lib before sending to the client.
		const doc = new PDFDocument({ size: "LETTER", margin: 50 });
		const pdfkitChunks = [];
		doc.on("data", (c) => pdfkitChunks.push(c));

		// Header
		doc.fontSize(20).font("Helvetica-Bold").text("LogisX Employment Application", { align: "center" });
		doc.moveDown(0.3);
		doc.fontSize(10).font("Helvetica").fillColor("#6b7280").text(`Application ID: ${app.id} | Status: ${app.status} | Submitted: ${app.created_at}`, { align: "center" });
		doc.moveDown(0.5);
		doc.moveTo(50, doc.y).lineTo(562, doc.y).strokeColor("#e2e4ea").stroke();
		doc.moveDown(0.8);

		const section = (title) => { doc.fontSize(12).font("Helvetica-Bold").fillColor("#0ea5e9").text(title); doc.moveDown(0.2); doc.moveTo(50, doc.y).lineTo(562, doc.y).strokeColor("#e8edf2").stroke(); doc.moveDown(0.4); };
		const field = (label, value) => { doc.fontSize(9).font("Helvetica-Bold").fillColor("#374151").text(label + ": ", { continued: true }); doc.font("Helvetica").fillColor("#111827").text(value || "N/A"); doc.moveDown(0.15); };

		section("Personal Information");
		field("Full Name", app.full_name);
		field("Email", app.email);
		field("Phone", app.phone);
		if (app.cell) field("Cell", app.cell);
		field("Date of Birth", app.dob);
		field("Address", app.address);
		if (app.city || app.state || app.zip) {
			field("City / State / ZIP", `${[app.city, app.state].filter(Boolean).join(", ")}${app.zip ? " " + app.zip : ""}`);
		}
		field("SSN", app.ssn ? "***-**-" + app.ssn.slice(-4) : "N/A");
		field("Drivers License", app.drivers_license);
		field("Position", app.position);
		if (app.dot) field("DOT #", app.dot);
		if (app.mc) field("MC #", app.mc);
		field("Hazmat Endorsement", app.hazmat || "No");
		doc.moveDown(0.5);

		section("Experience & Qualifications");
		field("Years of Experience", app.experience);
		field("Valid CDL", app.has_cdl);
		field("Work Authorized", app.work_authorized);
		field("Felony Conviction", app.felony_convicted);
		if (app.felony_explanation) field("Explanation", app.felony_explanation);
		doc.moveDown(0.5);

		section("Driving & Accident History");
		field("Commercial Accident", app.accident_history);
		if (app.accident_description) field("Description", app.accident_description);
		field("Traffic Citations (3 yrs)", app.traffic_citations || "N/A");
		doc.moveDown(0.5);

		section("Certifications & Availability");
		field("Certifications", app.certifications || "None listed");
		try { field("Availability", JSON.parse(app.availability).join(", ")); } catch { field("Availability", app.availability); }
		field("Skills", app.skills);
		doc.moveDown(0.5);

		section("References");
		try {
			const refs = JSON.parse(app.reference_info);
			if (Array.isArray(refs)) {
				refs.forEach((r, i) => {
						field("Reference " + (i + 1), `Company: ${r.name || "—"} | Phone: ${r.phone || "—"} | Email: ${r.relationship || "—"}${r.contactPerson ? " | Contact: " + r.contactPerson : ""}`);
					});
			} else { field("Reference Info", app.reference_info); }
		} catch { field("Reference Info", app.reference_info || "None"); }
		if (app.additional_info) field("Additional Info", app.additional_info);
		doc.moveDown(0.5);

		section("Applicant Signature");
		doc.fontSize(10).font("Helvetica-Oblique").fillColor("#111827").text(app.signature || "");
		doc.moveDown(0.2);
		field("Date", app.signature_date);
		doc.moveDown(0.5);

		// Embed CDL/Medical images if present.
		// Renders each image at its NATIVE resolution (no upscaling / stretching).
		// Small images are shown small so the reviewer can see they are low quality
		// instead of being silently blown up into a pixelated mess.
		const getJpegDimensions = (buf) => {
			// Walk JPEG markers looking for SOF0/SOF2 to read native width/height.
			// Returns { width, height } or null if unreadable.
			if (!buf || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
			let i = 2;
			while (i < buf.length) {
				if (buf[i] !== 0xff) return null;
				const marker = buf[i + 1];
				if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
					return { height: (buf[i + 5] << 8) | buf[i + 6], width: (buf[i + 7] << 8) | buf[i + 8] };
				}
				i += 2 + ((buf[i + 2] << 8) | buf[i + 3]);
			}
			return null;
		};
		const getPngDimensions = (buf) => {
			if (!buf || buf.length < 24) return null;
			if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) return null;
			return {
				width: (buf[16] << 24) | (buf[17] << 16) | (buf[18] << 8) | buf[19],
				height: (buf[20] << 24) | (buf[21] << 16) | (buf[22] << 8) | buf[23],
			};
		};
		// Collect uploaded PDFs so we can merge them at the end via pdf-lib.
		// Each entry: { label, base64 }
		const uploadedPdfs = [];
		const embedImage = (label, base64) => {
			if (!base64) return;
			try {
				if (base64.startsWith("data:application/pdf")) {
					// Queue the PDF for merging at the end. Also add a title-page
					// in the pdfkit output so reviewers see a clear separator.
					uploadedPdfs.push({ label, base64 });
					doc.addPage();
					doc.fontSize(14).font("Helvetica-Bold").fillColor("#0ea5e9").text(label, { align: "center" });
					doc.moveDown(0.5);
					doc.fontSize(10).font("Helvetica").fillColor("#6b7280").text("(original PDF appended on the following pages)", { align: "center" });
					return;
				}
				const data = base64.replace(/^data:image\/\w+;base64,/, "");
				const buf = Buffer.from(data, "base64");
				const dims = getJpegDimensions(buf) || getPngDimensions(buf);
				doc.addPage();
				doc.fontSize(14).font("Helvetica-Bold").fillColor("#0ea5e9").text(label, { align: "center" });
				doc.moveDown(0.5);
				// Letter page usable box: 612 wide × ~720 tall below the heading.
				const BOX_W = 500;
				const BOX_H = 600;
				const LEFT_MARGIN = 56;
				if (dims && dims.width > 0 && dims.height > 0) {
					// Scale DOWN to fit the box, never UP past the native size.
					// scale === 1 means render at actual resolution.
					const scale = Math.min(BOX_W / dims.width, BOX_H / dims.height, 1);
					const renderW = Math.round(dims.width * scale);
					const renderH = Math.round(dims.height * scale);
					const x = LEFT_MARGIN + Math.round((BOX_W - renderW) / 2);
					const y = doc.y;
					doc.image(buf, x, y, { width: renderW, height: renderH });
					// Always report the native size so the reviewer can flag low-quality photos.
					doc.y = y + renderH + 10;
					doc.fontSize(9).font("Helvetica-Oblique")
						.fillColor(dims.width < 800 || dims.height < 500 ? "#dc2626" : "#6b7280")
						.text(`Actual image resolution: ${dims.width}\u00D7${dims.height}px`, LEFT_MARGIN, doc.y, { width: BOX_W, align: "center" });
					if (dims.width < 800 || dims.height < 500) {
						doc.moveDown(0.25);
						doc.fontSize(9).font("Helvetica-Oblique").fillColor("#dc2626")
							.text("Low-resolution upload — request a clearer photo from the applicant.", LEFT_MARGIN, doc.y, { width: BOX_W, align: "center" });
					}
				} else {
					// Unknown format — fall back to fit (may scale up slightly).
					doc.image(buf, LEFT_MARGIN, doc.y, { fit: [BOX_W, BOX_H], align: "center", valign: "center" });
				}
			} catch { /* skip if image is invalid */ }
		};
		embedImage("CDL - Front", app.cdl_front);
		embedImage("CDL - Back", app.cdl_back);
		embedImage("Medical Card", app.medical_card);

		// Finalize pdfkit output to the buffer, then merge uploaded PDFs (if any)
		// via pdf-lib before streaming the final bytes to the client.
		doc.end();
		await new Promise((resolve) => doc.on("end", resolve));
		const basePdfBuf = Buffer.concat(pdfkitChunks);

		res.setHeader("Content-Type", "application/pdf");
		res.setHeader("Content-Disposition", `inline; filename=application-${app.full_name.replace(/\s+/g, "-")}.pdf`);

		if (uploadedPdfs.length === 0) {
			return res.end(basePdfBuf);
		}
		try {
			const mergedPdf = await PdfLibDocument.load(basePdfBuf);
			for (const { base64 } of uploadedPdfs) {
				try {
					const pdfBytes = Buffer.from(base64.replace(/^data:application\/pdf;base64,/, ""), "base64");
					const srcPdf = await PdfLibDocument.load(pdfBytes, { ignoreEncryption: true });
					const pages = await mergedPdf.copyPages(srcPdf, srcPdf.getPageIndices());
					pages.forEach((p) => mergedPdf.addPage(p));
				} catch (mergeErr) {
					console.error("Application PDF: failed to merge uploaded PDF:", mergeErr.message);
					// Skip the unmergeable attachment — the placeholder page in
					// the pdfkit output already tells the reviewer it was uploaded.
				}
			}
			const finalBytes = await mergedPdf.save();
			res.end(Buffer.from(finalBytes));
		} catch (err) {
			console.error("Application PDF: pdf-lib merge failed, sending pdfkit-only version:", err.message);
			res.end(basePdfBuf);
		}
	} catch (err) {
		console.error("Application PDF: generation failed:", err.message);
		if (!res.headersSent) res.status(500).json({ error: "Failed to generate application PDF" });
	}
});

// === INVESTOR ONBOARDING ENDPOINTS (Public) ===

// POST /api/public/investor-apply — Single atomic submission: form + vehicles + banking + signatures
app.post("/api/public/investor-apply", publicFormLimiter, async (req, res) => {
	try {
		const { legal_name, dba, entity_type, address, contact_person, contact_title, phone, email,
			years_in_operation, industry_experience, fleet_size, preferred_communication,
			tax_classification, ein_ssn, bankruptcy_liens, reporting_preference,
			vehicles, banking, signatures } = req.body;

		// Validate required fields
		if (!legal_name || !email || !phone || !address || !ein_ssn) {
			return res.status(400).json({ error: "Please fill in all required fields." });
		}
		if (!banking || !banking.bank_name || !banking.routing_number || !banking.account_number) {
			return res.status(400).json({ error: "Banking information is required." });
		}
		if (!signatures || Object.keys(signatures).length < INVESTOR_ONBOARDING_DOCS.length) {
			return res.status(400).json({ error: "All documents must be signed." });
		}
		for (const doc of INVESTOR_ONBOARDING_DOCS) {
			const sig = signatures[doc.key];
			if (!sig || !sig.text || !sig.text.trim()) {
				return res.status(400).json({ error: `Signature required for ${doc.name}.` });
			}
		}

		const accessToken = crypto.randomUUID();
		const vehiclesArr = Array.isArray(vehicles) ? vehicles : [];
		const now = new Date().toISOString();
		const effectiveDate = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
		const signedAt = new Date().toLocaleString("en-US", { month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true, timeZoneName: "short" });

		// 1. Insert all DB records in a single transaction
		const applyTx = db.transaction(() => {
			// Application record
			const result = db.prepare(`
				INSERT INTO investor_applications (legal_name, dba, entity_type, address, contact_person, contact_title, phone, email,
					years_in_operation, industry_experience, fleet_size, preferred_communication,
					tax_classification, ein_ssn, bankruptcy_liens, reporting_preference, access_token, status)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'New')
			`).run(legal_name, dba || "", entity_type || "", address, contact_person || "", contact_title || "",
				phone, email, years_in_operation || "", industry_experience || "", fleet_size || "",
				preferred_communication || "", tax_classification || "", ein_ssn, bankruptcy_liens || "", reporting_preference || "", accessToken);

			const appId = result.lastInsertRowid;

			// Vehicles
			if (vehiclesArr.length > 0) {
				const v = vehiclesArr[0];
				db.prepare(`UPDATE investor_applications SET
					vehicle_year=?, vehicle_make=?, vehicle_model=?, vehicle_vin=?, vehicle_mileage=?,
					vehicle_title_state=?, vehicle_liens=?, vehicle_registered_owner=?,
					vehicles_json=? WHERE id=?`
				).run(v.year || "", v.make || "", v.model || "", v.vin || "",
					v.mileage || "", v.titleState || "", v.liens || "", v.registeredOwner || "",
					JSON.stringify(vehiclesArr), appId);
			}

			// Banking
			db.prepare(`INSERT INTO investor_payment_info (application_id, bank_name, account_type, routing_number, account_number, account_name)
				VALUES (?, ?, ?, ?, ?, ?)`).run(appId, banking.bank_name, banking.account_type || "", banking.routing_number, banking.account_number, banking.account_name || "");

			// Onboarding — fully onboarded immediately
			db.prepare("INSERT INTO investor_onboarding (application_id, status, onboarded_at) VALUES (?, 'fully_onboarded', ?)").run(appId, now);

			// Documents — all signed
			const insertDoc = db.prepare("INSERT INTO investor_onboarding_documents (application_id, doc_key, doc_name, signed, signature_text, signature_image, signed_at, signed_pdf_url) VALUES (?, ?, ?, 1, ?, ?, ?, ?)");
			for (const doc of INVESTOR_ONBOARDING_DOCS) {
				const sig = signatures[doc.key];
				const signedFileName = `${doc.key}-inv-${appId}-signed.pdf`;
				const signedPdfUrl = `/uploads/investor-onboarding-signed/${signedFileName}`;
				insertDoc.run(appId, doc.key, doc.name, sig.text.trim(), sig.image || "", now, signedPdfUrl);
			}

			return appId;
		});

		const appId = applyTx();

		// 2. Generate signed PDFs (outside transaction — file I/O)
		const signedDir = path.join(__dirname, "uploads", "investor-onboarding-signed");
		if (!fs.existsSync(signedDir)) fs.mkdirSync(signedDir, { recursive: true });

		// appData feeds both fillW9Form (W-9) and renderPolicy (master_agreement, vehicle_lease).
		// The HTML templates need the extra fields (years_in_operation, fleet_size, vehicle_*,
		// banking) that aren't in the old minimal appData shape.
		const appData = {
			legalName: legal_name,
			dba: dba || "",
			entityType: entity_type || "",
			address,
			contactPerson: contact_person || "",
			contactTitle: contact_title || "",
			phone,
			email,
			einSsn: ein_ssn,
			effectiveDate,
			// Extended fields for HTML templates
			yearsInOperation: years_in_operation || "",
			fleetSize: fleet_size || "",
			vehicles: vehiclesArr,
			bankName: banking?.bank_name || "",
			bankRouting: banking?.routing_number || "",
			bankAccount: banking?.account_number || "",
			accountType: banking?.account_type || "",
		};

		for (const doc of INVESTOR_ONBOARDING_DOCS) {
			const sig = signatures[doc.key];
			const signedFileName = `${doc.key}-inv-${appId}-signed.pdf`;
			const signedPath = path.join(signedDir, signedFileName);
			try {
				if (doc.key === "w9") {
					const pdfBytes = await fillW9Form({ ...appData, signatureText: sig.text.trim(), signatureImage: sig.image });
					if (pdfBytes) fs.writeFileSync(signedPath, pdfBytes);
				} else if (doc.key === "master_agreement") {
					const pdfBuffer = await renderPolicy("master_agreement", {
						...appData,
						signatureText: sig.text.trim(),
						signatureImage: sig.image,
						signedAt,
					});
					fs.writeFileSync(signedPath, pdfBuffer);
				} else if (doc.key === "vehicle_lease") {
					const pdfBuffer = await renderPolicy("vehicle_lease", {
						...appData,
						signatureText: sig.text.trim(),
						signatureImage: sig.image,
						signedAt,
					});
					fs.writeFileSync(signedPath, pdfBuffer);
				}
			} catch (pdfErr) {
				console.error(`PDF generation failed for ${doc.key}:`, pdfErr.message);
			}
		}

		res.json({ success: true, applicationId: appId });

		// Send emails (async, don't block response)
		const vehicleRows = vehiclesArr.map((v, i) => `<tr>
			<td style="padding:6px 10px;border-bottom:1px solid #f1f5f9">${i + 1}</td>
			<td style="padding:6px 10px;border-bottom:1px solid #f1f5f9">${v.year || ""} ${v.make || ""} ${v.model || ""}</td>
			<td style="padding:6px 10px;border-bottom:1px solid #f1f5f9">${v.vin || ""}</td>
			<td style="padding:6px 10px;border-bottom:1px solid #f1f5f9">${v.licensePlate || ""}</td>
			<td style="padding:6px 10px;border-bottom:1px solid #f1f5f9">${v.titleState || ""}</td>
			<td style="padding:6px 10px;border-bottom:1px solid #f1f5f9">${v.purchasePrice ? "$" + Number(v.purchasePrice).toLocaleString() : ""}</td>
		</tr>`).join("");

		// Email A: Applicant confirmation (simple)
		const applicantHtml = `
		<div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:600px;margin:0 auto;color:#1e293b">
			<div style="background:#0f2847;padding:24px 32px;border-radius:12px 12px 0 0">
				<img src="https://app.logisx.com/logo.avif" alt="LogisX" style="height:36px" />
			</div>
			<div style="padding:32px;background:#fff;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 12px 12px">
				<h2 style="margin:0 0 16px;font-size:20px;color:#0f172a">Application Received</h2>
				<p>Hi <b>${legal_name}</b>,</p>
				<p>Thank you for submitting your investor application with LogisX. We have received all your information and signed documents.</p>
				<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:16px;margin:20px 0">
					<table style="width:100%;border-collapse:collapse;font-size:14px">
						<tr><td style="padding:4px 0;color:#64748b;width:140px">Company</td><td style="padding:4px 0;font-weight:600">${legal_name}${dba ? ` (DBA: ${dba})` : ""}</td></tr>
						${entity_type ? `<tr><td style="padding:4px 0;color:#64748b">Entity Type</td><td style="padding:4px 0">${entity_type}</td></tr>` : ""}
						<tr><td style="padding:4px 0;color:#64748b">Fleet Size</td><td style="padding:4px 0">${vehiclesArr.length} vehicle(s)</td></tr>
						<tr><td style="padding:4px 0;color:#64748b">Documents</td><td style="padding:4px 0;color:#16a34a;font-weight:600">3/3 Signed</td></tr>
					</table>
				</div>
				<h3 style="font-size:15px;margin:24px 0 8px;color:#0f172a">What happens next?</h3>
				<ul style="padding-left:20px;color:#475569;line-height:1.8">
					<li>Our team will review your application within <b>1-2 business days</b></li>
					<li>You'll receive login credentials via email once approved</li>
					<li>Access your investor dashboard to track fleet performance and financials</li>
				</ul>
				<p style="color:#64748b;font-size:13px;margin-top:24px">If you have any questions, reply to this email or contact us at info@logisx.com.</p>
				<p style="margin-top:24px">Best regards,<br><b>LogisX Team</b></p>
			</div>
		</div>`;
		sendEmail(email, "LogisX - Investor Application Received", applicantHtml);

		// Email B: Admin notification (detailed + attachments)
		const adminHtml = `
		<div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:700px;margin:0 auto;color:#1e293b">
			<div style="background:#0f2847;padding:24px 32px;border-radius:12px 12px 0 0">
				<img src="https://app.logisx.com/logo.avif" alt="LogisX" style="height:36px" />
			</div>
			<div style="padding:32px;background:#fff;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 12px 12px">
				<p style="margin:0 0 20px;color:#475569">A new investor application has been submitted and is ready for review.</p>

				<h3 style="font-size:15px;margin:0 0 12px;color:#0f172a;border-bottom:2px solid #e2e8f0;padding-bottom:6px">Company Information</h3>
				<table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:24px">
					<tr><td style="padding:5px 0;color:#64748b;width:180px">Legal Name</td><td style="padding:5px 0;font-weight:600">${legal_name}</td></tr>
					${dba ? `<tr><td style="padding:5px 0;color:#64748b">DBA</td><td style="padding:5px 0">${dba}</td></tr>` : ""}
					${entity_type ? `<tr><td style="padding:5px 0;color:#64748b">Entity Type</td><td style="padding:5px 0">${entity_type}</td></tr>` : ""}
					<tr><td style="padding:5px 0;color:#64748b">Address</td><td style="padding:5px 0">${address}</td></tr>
					${contact_person ? `<tr><td style="padding:5px 0;color:#64748b">Contact Person</td><td style="padding:5px 0">${contact_person}${contact_title ? " (" + contact_title + ")" : ""}</td></tr>` : ""}
					<tr><td style="padding:5px 0;color:#64748b">Phone</td><td style="padding:5px 0">${phone}</td></tr>
					<tr><td style="padding:5px 0;color:#64748b">Email</td><td style="padding:5px 0"><a href="mailto:${email}">${email}</a></td></tr>
					${ein_ssn ? `<tr><td style="padding:5px 0;color:#64748b">EIN/SSN</td><td style="padding:5px 0">${ein_ssn}</td></tr>` : ""}
					${tax_classification ? `<tr><td style="padding:5px 0;color:#64748b">Tax Classification</td><td style="padding:5px 0">${tax_classification}</td></tr>` : ""}
					${years_in_operation ? `<tr><td style="padding:5px 0;color:#64748b">Years in Operation</td><td style="padding:5px 0">${years_in_operation}</td></tr>` : ""}
					${industry_experience ? `<tr><td style="padding:5px 0;color:#64748b">Industry Experience</td><td style="padding:5px 0">${industry_experience}</td></tr>` : ""}
					${bankruptcy_liens ? `<tr><td style="padding:5px 0;color:#64748b">Bankruptcy/Liens</td><td style="padding:5px 0">${bankruptcy_liens}</td></tr>` : ""}
				</table>

				<h3 style="font-size:15px;margin:0 0 12px;color:#0f172a;border-bottom:2px solid #e2e8f0;padding-bottom:6px">Fleet (${vehiclesArr.length} Vehicle${vehiclesArr.length !== 1 ? "s" : ""})</h3>
				<table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:24px">
					<thead><tr style="background:#f8fafc">
						<th style="padding:8px 10px;text-align:left;font-weight:600;color:#64748b;font-size:11px;text-transform:uppercase">#</th>
						<th style="padding:8px 10px;text-align:left;font-weight:600;color:#64748b;font-size:11px;text-transform:uppercase">Vehicle</th>
						<th style="padding:8px 10px;text-align:left;font-weight:600;color:#64748b;font-size:11px;text-transform:uppercase">VIN</th>
						<th style="padding:8px 10px;text-align:left;font-weight:600;color:#64748b;font-size:11px;text-transform:uppercase">Plate</th>
						<th style="padding:8px 10px;text-align:left;font-weight:600;color:#64748b;font-size:11px;text-transform:uppercase">State</th>
						<th style="padding:8px 10px;text-align:left;font-weight:600;color:#64748b;font-size:11px;text-transform:uppercase">Price</th>
					</tr></thead>
					<tbody>${vehicleRows}</tbody>
				</table>

				<h3 style="font-size:15px;margin:0 0 12px;color:#0f172a;border-bottom:2px solid #e2e8f0;padding-bottom:6px">Banking</h3>
				<table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:24px">
					<tr><td style="padding:5px 0;color:#64748b;width:180px">Bank</td><td style="padding:5px 0">${banking.bank_name}</td></tr>
					${banking.account_type ? `<tr><td style="padding:5px 0;color:#64748b">Account Type</td><td style="padding:5px 0">${banking.account_type}</td></tr>` : ""}
					<tr><td style="padding:5px 0;color:#64748b">Routing Number</td><td style="padding:5px 0">${banking.routing_number}</td></tr>
					<tr><td style="padding:5px 0;color:#64748b">Account Number</td><td style="padding:5px 0">${"••••" + banking.account_number.slice(-4)}</td></tr>
					${banking.account_name ? `<tr><td style="padding:5px 0;color:#64748b">Name on Account</td><td style="padding:5px 0">${banking.account_name}</td></tr>` : ""}
				</table>

				<h3 style="font-size:15px;margin:0 0 12px;color:#0f172a;border-bottom:2px solid #e2e8f0;padding-bottom:6px">Signed Documents</h3>
				<table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:24px">
					${INVESTOR_ONBOARDING_DOCS.map(doc => {
						const sig = signatures[doc.key];
						return `<tr><td style="padding:5px 0;color:#64748b">${doc.name}</td><td style="padding:5px 0;color:#16a34a;font-weight:600">Signed by ${sig.text.trim()}</td></tr>`;
					}).join("")}
				</table>
				<p style="font-size:13px;color:#64748b">Signed PDFs are attached to this email.</p>

				<div style="margin-top:28px;text-align:center">
					<a href="https://app.logisx.com/investor-applications" style="display:inline-block;background:#0f2847;color:#fff;padding:12px 32px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px">Review Application</a>
				</div>
			</div>
		</div>`;

		const pdfAttachments = INVESTOR_ONBOARDING_DOCS.map(doc => {
			const filename = `${doc.key}-inv-${appId}-signed.pdf`;
			const filepath = path.join(signedDir, filename);
			return fs.existsSync(filepath) ? { filename: `${doc.name}.pdf`, path: filepath } : null;
		}).filter(Boolean);

		sendEmail("info@logisx.com", `New Investor Application: ${legal_name}`, adminHtml, pdfAttachments);
	} catch (err) {
		res.status(500).json({ error: err.message });
	}
});

// Helper: fill W-9 PDF form fields
async function fillW9Form({ legalName = "", dba = "", entityType = "", address = "", einSsn = "", signatureText = "", signatureImage, effectiveDate = "" }) {
	const templatePath = path.join(__dirname, "uploads", "onboarding-templates", "fw9.pdf");
	if (!fs.existsSync(templatePath)) return null;
	const templateBytes = fs.readFileSync(templatePath);
	const pdfDoc = await PdfLibDocument.load(templateBytes);
	const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
	const form = pdfDoc.getForm();

	// Set default font for all fields so appearances render correctly
	const rawUpdateFAs = (fieldName) => {
		try { form.getTextField(fieldName).updateAppearances(font); } catch {}
	};

	// Helper to set text and update appearance
	const setField = (name, value) => {
		try {
			const f = form.getTextField(name);
			f.setText(value);
			f.updateAppearances(font);
		} catch {}
	};

	// Line 1: Name
	if (legalName) setField("topmostSubform[0].Page1[0].f1_01[0]", legalName);
	// Line 2: DBA
	if (dba) setField("topmostSubform[0].Page1[0].f1_02[0]", dba);

	// Line 3a: Entity type checkboxes
	const entityCheckMap = {
		"Sole Prop": 0, "C-Corp": 1, "S-Corp": 2, "Corp": 1, "Partnership": 3, "Trust": 4, "Trust/Estate": 4, "LLC": 5, "Other": 6,
	};
	const cbIdx = entityCheckMap[entityType];
	if (cbIdx !== undefined) {
		try { form.getCheckBox(`topmostSubform[0].Page1[0].Boxes3a-b_ReadOrder[0].c1_1[${cbIdx}]`).check(); } catch {}
	}
	// LLC tax classification letter
	if (entityType === "LLC") {
		setField("topmostSubform[0].Page1[0].Boxes3a-b_ReadOrder[0].f1_03[0]", "P");
	}

	// Line 5: Street address, Line 6: City/State/ZIP
	if (address) {
		const parts = address.split(",").map(s => s.trim());
		// Line 5 — street address
		setField("topmostSubform[0].Page1[0].Address_ReadOrder[0].f1_07[0]", parts[0] || address);
		// Line 6 — city, state, ZIP (f1_08 is Line 6; f1_09 is "Requester's name" — wrong box)
		if (parts.length > 1) {
			setField("topmostSubform[0].Page1[0].Address_ReadOrder[0].f1_08[0]", parts.slice(1).join(", "));
		}
	}

	// EIN/SSN — fill the appropriate section based on entity type
	if (einSsn) {
		const digits = einSsn.replace(/\D/g, "");
		const looksLikeEin = /^\d{2}-\d{7}$/.test(einSsn.trim());
		const isIndividual = (!entityType || entityType === "Sole Prop") && !looksLikeEin;
		if (isIndividual && digits.length === 9) {
			// SSN fields (3 + 2 + 4) — for individuals/sole props only
			setField("topmostSubform[0].Page1[0].f1_11[0]", digits.slice(0, 3));
			setField("topmostSubform[0].Page1[0].f1_12[0]", digits.slice(3, 5));
			setField("topmostSubform[0].Page1[0].f1_13[0]", digits.slice(5));
		} else if (digits.length >= 2) {
			// EIN fields (2 + remaining) — for LLCs, corps, partnerships, trusts
			setField("topmostSubform[0].Page1[0].f1_14[0]", digits.slice(0, 2));
			if (digits.length > 2) setField("topmostSubform[0].Page1[0].f1_15[0]", digits.slice(2));
		}
	}

	// Flatten form so fields become static text
	form.flatten();

	// Add signature overlay (after flattening, so we draw on top)
	if (signatureText) {
		const page1 = pdfDoc.getPages()[0];
		const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
		const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
		const blue = rgb(0.1, 0.34, 0.86);
		// "Sign Here" line on page 1 — "Signature of U.S. person" field
		const sigY = 195;
		page1.drawText(signatureText, { x: 120, y: sigY, size: 10, font: fontBold, color: blue });
		if (effectiveDate) page1.drawText(effectiveDate, { x: 460, y: sigY, size: 9, font, color: blue });
		if (signatureImage) {
			try {
				const sigBytes = Buffer.from(signatureImage.replace(/^data:image\/\w+;base64,/, ""), "base64");
				const sigImg = await pdfDoc.embedPng(sigBytes);
				const nameW = fontBold.widthOfTextAtSize(signatureText, 10);
				page1.drawImage(sigImg, { x: 120 + nameW + 10, y: sigY - 10, width: 120, height: 35 });
			} catch { /* skip */ }
		}
	}

	return await pdfDoc.save();
}

// Helper: verify investor access token
function verifyInvestorToken(req, res) {
	const appId = parseInt(req.params.id);
	const token = req.query.token || req.body?.accessToken || req.headers["x-access-token"] || "";
	if (!appId || isNaN(appId)) { res.status(400).json({ error: "Invalid application ID" }); return null; }
	const app = db.prepare("SELECT id, access_token FROM investor_applications WHERE id = ?").get(appId);
	if (!app) { res.status(404).json({ error: "Application not found" }); return null; }
	if (!app.access_token || app.access_token !== token) { res.status(403).json({ error: "Invalid access token" }); return null; }
	return appId;
}

// GET /api/public/investor-onboarding/:id — Get application + onboarding status (token required)
app.get("/api/public/investor-onboarding/:id", (req, res) => {
	try {
		const appId = verifyInvestorToken(req, res);
		if (!appId) return;
		const application = db.prepare("SELECT id, legal_name, dba, entity_type, address, contact_person, email, phone, status FROM investor_applications WHERE id = ?").get(appId);
		const onboarding = db.prepare("SELECT * FROM investor_onboarding WHERE application_id = ?").get(appId);
		const documents = db.prepare("SELECT * FROM investor_onboarding_documents WHERE application_id = ? ORDER BY id").all(appId);
		res.json({ application, onboarding, documents, totalDocs: INVESTOR_ONBOARDING_DOCS.length });
	} catch (err) {
		res.status(500).json({ error: err.message });
	}
});

// POST /api/public/investor-onboarding/:id/sign/:docKey — Sign a document (token required)
app.post("/api/public/investor-onboarding/:id/sign/:docKey", async (req, res) => {
	try {
		const appId = verifyInvestorToken(req, res);
		if (!appId) return;
		const { docKey } = req.params;
		const { signatureText, signatureImage, vehicleInfo } = req.body;
		if (!signatureText || !signatureText.trim()) return res.status(400).json({ error: "Signature required" });

		const docRow = db.prepare("SELECT * FROM investor_onboarding_documents WHERE application_id = ? AND doc_key = ?").get(appId, docKey);
		if (!docRow) return res.status(404).json({ error: "Document not found" });
		if (docRow.signed) return res.json({ success: true, message: "Already signed" });

		const application = db.prepare("SELECT * FROM investor_applications WHERE id = ?").get(appId);
		const effectiveDate = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
		const signedDir = path.join(__dirname, "uploads", "investor-onboarding-signed");
		if (!fs.existsSync(signedDir)) fs.mkdirSync(signedDir, { recursive: true });
		const signedFileName = `${docKey}-inv-${appId}-signed.pdf`;
		const signedPath = path.join(signedDir, signedFileName);
		let signedPdfUrl = `/uploads/investor-onboarding-signed/${signedFileName}`;

		// Save vehicle info if provided (for Exhibit A)
		const vehiclesArr = Array.isArray(vehicleInfo) ? vehicleInfo : (vehicleInfo ? [vehicleInfo] : []);
		if (vehiclesArr.length > 0) {
			const v = vehiclesArr[0];
			db.prepare(`UPDATE investor_applications SET
				vehicle_year=?, vehicle_make=?, vehicle_model=?, vehicle_vin=?, vehicle_mileage=?,
				vehicle_title_state=?, vehicle_liens=?, vehicle_registered_owner=?,
				vehicles_json=? WHERE id=?`
			).run(v.year || "", v.make || "", v.model || "",
				v.vin || "", v.mileage || "", v.titleState || "",
				v.liens || "", v.registeredOwner || "",
				JSON.stringify(vehiclesArr), appId);
		}

		if (docKey === "w9") {
			const pdfBytes = await fillW9Form({
				legalName: application?.legal_name || "", dba: application?.dba || "",
				entityType: application?.entity_type || "", address: application?.address || "",
				einSsn: application?.ein_ssn || "", signatureText: signatureText.trim(),
				signatureImage, effectiveDate,
			});
			if (pdfBytes) {
				fs.writeFileSync(signedPath, pdfBytes);
			} else {
				signedPdfUrl = "";
			}
		} else if (docKey === "master_agreement" || docKey === "vehicle_lease") {
			const signedAt = new Date().toLocaleString("en-US", { month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true, timeZoneName: "short" });
			// Load any stored vehicles (from vehicles_json or the vehicle_* fallback columns)
			let storedVehicles = vehiclesArr;
			if (!storedVehicles.length) {
				try { storedVehicles = JSON.parse(application?.vehicles_json || "[]"); } catch { storedVehicles = []; }
				if (!storedVehicles.length && application?.vehicle_year) {
					storedVehicles = [{
						year: application.vehicle_year, make: application.vehicle_make, model: application.vehicle_model,
						vin: application.vehicle_vin, mileage: application.vehicle_mileage,
						titleState: application.vehicle_title_state, liens: application.vehicle_liens,
						registeredOwner: application.vehicle_registered_owner,
					}];
				}
			}
			const payInfo = db.prepare("SELECT * FROM investor_payment_info WHERE application_id = ?").get(appId);
			const pdfBuffer = await renderPolicy(docKey, {
				legalName: application?.legal_name || "",
				dba: application?.dba || "",
				entityType: application?.entity_type || "",
				address: application?.address || "",
				contactPerson: application?.contact_person || "",
				contactTitle: application?.contact_title || "",
				phone: application?.phone || "",
				email: application?.email || "",
				einSsn: application?.ein_ssn || "",
				yearsInOperation: application?.years_in_operation || "",
				fleetSize: application?.fleet_size || "",
				vehicles: storedVehicles,
				bankName: payInfo?.bank_name || "",
				bankRouting: payInfo?.routing_number || "",
				bankAccount: payInfo?.account_number || "",
				accountType: payInfo?.account_type || "",
				effectiveDate,
				signatureText: signatureText.trim(),
				signatureImage,
				signedAt,
			});
			fs.writeFileSync(signedPath, pdfBuffer);
		}

		const now = new Date().toISOString();
		db.prepare("UPDATE investor_onboarding_documents SET signed=1, signature_text=?, signature_image=?, signed_at=?, signed_pdf_url=? WHERE application_id=? AND doc_key=?")
			.run(signatureText.trim(), signatureImage || "", now, signedPdfUrl, appId, docKey);

		// Check if all docs signed → advance status
		const signedCount = db.prepare("SELECT COUNT(*) AS cnt FROM investor_onboarding_documents WHERE application_id=? AND signed=1").get(appId).cnt;
		if (signedCount === INVESTOR_ONBOARDING_DOCS.length) {
			const hasBanking = db.prepare("SELECT 1 FROM investor_payment_info WHERE application_id=?").get(appId);
			if (hasBanking) {
				db.prepare("UPDATE investor_onboarding SET status='fully_onboarded', onboarded_at=? WHERE application_id=?")
					.run(new Date().toISOString(), appId);
			} else {
				db.prepare("UPDATE investor_onboarding SET status='banking_pending' WHERE application_id=?").run(appId);
			}
		}

		res.json({ success: true });
	} catch (err) {
		console.error("Investor sign error:", err.message);
		res.status(500).json({ error: err.message });
	}
});

// Serve investor onboarding document PDFs (preview, token required)
app.get("/api/public/investor-onboarding/:id/documents/:docKey/pdf", async (req, res) => {
	try {
		const appId = verifyInvestorToken(req, res);
		if (!appId) return;
		const { docKey } = req.params;
		const application = db.prepare("SELECT * FROM investor_applications WHERE id = ?").get(appId);
		const effectiveDate = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

		if (docKey === "master_agreement" || docKey === "vehicle_lease") {
			let vehicles = [];
			try { vehicles = JSON.parse(application?.vehicles_json || "[]"); } catch { /* skip */ }
			if (!vehicles.length && (application?.vehicle_year || application?.vehicle_make)) {
				vehicles.push({
					year: application.vehicle_year || "", make: application.vehicle_make || "",
					model: application.vehicle_model || "", vin: application.vehicle_vin || "",
					mileage: application.vehicle_mileage || "",
					titleState: application.vehicle_title_state || "",
					liens: application.vehicle_liens || "",
					registeredOwner: application.vehicle_registered_owner || "",
				});
			}
			const payInfo = db.prepare("SELECT * FROM investor_payment_info WHERE application_id = ?").get(appId);
			const pdfBuffer = await renderPolicy(docKey, {
				legalName: application?.legal_name || "",
				dba: application?.dba || "",
				entityType: application?.entity_type || "",
				address: application?.address || "",
				contactPerson: application?.contact_person || "",
				contactTitle: application?.contact_title || "",
				phone: application?.phone || "",
				email: application?.email || "",
				einSsn: application?.ein_ssn || "",
				yearsInOperation: application?.years_in_operation || "",
				fleetSize: application?.fleet_size || "",
				vehicles,
				bankName: payInfo?.bank_name || "",
				bankRouting: payInfo?.routing_number || "",
				bankAccount: payInfo?.account_number || "",
				accountType: payInfo?.account_type || "",
				effectiveDate,
			});
			res.setHeader("Content-Type", "application/pdf");
			const filename = docKey === "master_agreement" ? "Master Agreement Preview.pdf" : "Vehicle Lease Preview.pdf";
			res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
			return res.send(pdfBuffer);
		}

		if (docKey === "w9") {
			const pdfBytes = await fillW9Form({
				legalName: application?.legal_name || "", dba: application?.dba || "",
				entityType: application?.entity_type || "", address: application?.address || "",
				einSsn: application?.ein_ssn || "", effectiveDate,
			});
			if (!pdfBytes) return res.status(404).json({ error: "W-9 template not found" });
			res.setHeader("Content-Type", "application/pdf");
			res.setHeader("Content-Disposition", 'inline; filename="W-9 Form Preview.pdf"');
			return res.send(Buffer.from(pdfBytes));
		}

		return res.status(404).json({ error: "Unknown document" });
	} catch (err) {
		res.status(500).json({ error: err.message });
	}
});

// POST /api/public/investor-onboarding/:id/vehicles — Save vehicles JSON (token required)
app.post("/api/public/investor-onboarding/:id/vehicles", (req, res) => {
	try {
		const appId = verifyInvestorToken(req, res);
		if (!appId) return;
		const { vehicles } = req.body;
		const vehiclesArr = Array.isArray(vehicles) ? vehicles : [];
		db.prepare("UPDATE investor_applications SET vehicles_json=? WHERE id=?")
			.run(JSON.stringify(vehiclesArr), appId);
		// Also update the legacy single-vehicle columns from the first vehicle
		if (vehiclesArr.length > 0) {
			const v = vehiclesArr[0];
			db.prepare(`UPDATE investor_applications SET
				vehicle_year=?, vehicle_make=?, vehicle_model=?, vehicle_vin=?, vehicle_mileage=?,
				vehicle_title_state=?, vehicle_liens=?, vehicle_registered_owner=? WHERE id=?`
			).run(v.year || "", v.make || "", v.model || "", v.vin || "",
				v.mileage || "", v.titleState || "", v.liens || "", v.registeredOwner || "", appId);
		}
		res.json({ success: true });
	} catch (err) {
		res.status(500).json({ error: err.message });
	}
});

// POST /api/public/investor-onboarding/:id/banking — Step 3: Submit banking info (token required)
app.post("/api/public/investor-onboarding/:id/banking", (req, res) => {
	try {
		const appId = verifyInvestorToken(req, res);
		if (!appId) return;
		const { bank_name, account_type, routing_number, account_number, account_name } = req.body;
		if (!bank_name || !routing_number || !account_number) {
			return res.status(400).json({ error: "Bank name, routing number, and account number are required" });
		}
		// Verify all documents are signed before accepting banking info
		const signedCount = db.prepare("SELECT COUNT(*) AS cnt FROM investor_onboarding_documents WHERE application_id=? AND signed=1").get(appId).cnt;
		if (signedCount < INVESTOR_ONBOARDING_DOCS.length) {
			return res.status(400).json({ error: "All documents must be signed before submitting banking info" });
		}
		db.prepare(`INSERT OR REPLACE INTO investor_payment_info (application_id, bank_name, account_type, routing_number, account_number, account_name)
			VALUES (?, ?, ?, ?, ?, ?)`).run(appId, bank_name, account_type || "", routing_number, account_number, account_name || "");

		db.prepare("UPDATE investor_onboarding SET status='fully_onboarded', onboarded_at=? WHERE application_id=?")
			.run(new Date().toISOString(), appId);

		// Promote from Draft to New — application is now visible to admins
		db.prepare("UPDATE investor_applications SET status='New' WHERE id=? AND status='Draft'").run(appId);

		res.json({ success: true });
	} catch (err) {
		res.status(500).json({ error: err.message });
	}
});

// Stateless PDF preview — generates document from posted form data, no DB writes
app.post("/api/public/investor-preview-pdf/:docKey", async (req, res) => {
	try {
		const { docKey } = req.params;
		const { legal_name, dba, entity_type, address, contact_person, contact_title, phone, email, ein_ssn, years_in_operation, fleet_size, vehicles, banking, signatureText, signatureImage } = req.body;
		const effectiveDate = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
		const signedAt = signatureText ? new Date().toLocaleString("en-US", { month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true, timeZoneName: "short" }) : undefined;
		const vehiclesArr = Array.isArray(vehicles) ? vehicles : [];
		const appData = {
			legalName: legal_name || "",
			dba: dba || "",
			entityType: entity_type || "",
			address: address || "",
			contactPerson: contact_person || "",
			contactTitle: contact_title || "",
			phone: phone || "",
			email: email || "",
			einSsn: ein_ssn || "",
			yearsInOperation: years_in_operation || "",
			fleetSize: fleet_size || "",
			vehicles: vehiclesArr,
			bankName: banking?.bank_name || "",
			bankRouting: banking?.routing_number || "",
			bankAccount: banking?.account_number || "",
			accountType: banking?.account_type || "",
			effectiveDate,
			signatureText: signatureText || undefined,
			signatureImage: signatureImage || undefined,
			signedAt,
		};

		if (docKey === "master_agreement" || docKey === "vehicle_lease") {
			const pdfBuffer = await renderPolicy(docKey, appData);
			res.setHeader("Content-Type", "application/pdf");
			const filename = docKey === "master_agreement" ? "Master Agreement.pdf" : "Vehicle Lease.pdf";
			res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
			return res.send(pdfBuffer);
		}
		if (docKey === "w9") {
			const pdfBytes = await fillW9Form(appData);
			if (!pdfBytes) return res.status(404).json({ error: "W-9 template not found" });
			res.setHeader("Content-Type", "application/pdf");
			res.setHeader("Content-Disposition", 'inline; filename="W-9 Form.pdf"');
			return res.send(Buffer.from(pdfBytes));
		}
		return res.status(404).json({ error: "Unknown document" });
	} catch (err) {
		res.status(500).json({ error: err.message });
	}
});

// Signed investor PDFs are served by the authenticated /uploads mount (see top of file).

// Admin: list investor applications
app.get("/api/investor-applications", requireRole("Super Admin"), (req, res) => {
	try {
		const apps = db.prepare(`SELECT ia.*, io.status AS onboarding_status,
			(SELECT COUNT(*) FROM investor_onboarding_documents WHERE application_id=ia.id AND signed=1) AS signed_count
			FROM investor_applications ia
			LEFT JOIN investor_onboarding io ON io.application_id = ia.id
			WHERE ia.status != 'Draft'
			ORDER BY ia.created_at DESC`).all();
		res.json(apps);
	} catch (err) {
		res.status(500).json({ error: err.message });
	}
});

// Admin: get full investor application detail
app.get("/api/investor-applications/:id", requireRole("Super Admin"), (req, res) => {
	try {
		const appId = parseInt(req.params.id);
		const application = db.prepare(`SELECT ia.*, io.status AS onboarding_status,
			(SELECT COUNT(*) FROM investor_onboarding_documents WHERE application_id=ia.id AND signed=1) AS signed_count
			FROM investor_applications ia
			LEFT JOIN investor_onboarding io ON io.application_id = ia.id
			WHERE ia.id = ?`).get(appId);
		if (!application) return res.status(404).json({ error: "Application not found" });
		let vehicles = [];
		try { vehicles = JSON.parse(application.vehicles_json || "[]"); } catch { /* skip */ }
		const banking = db.prepare("SELECT bank_name, account_type, routing_number, account_number, account_name FROM investor_payment_info WHERE application_id=?").get(appId) || {};
		const documents = db.prepare("SELECT doc_key, doc_name, signed, signature_text, signed_at, signed_pdf_url FROM investor_onboarding_documents WHERE application_id=? ORDER BY id").all(appId);
		res.json({ application, vehicles, banking, documents });
	} catch (err) {
		res.status(500).json({ error: err.message });
	}
});

// Admin: accept/reject investor application
app.put("/api/investor-applications/:id/status", requireRole("Super Admin"), async (req, res) => {
	try {
		const { status } = req.body;
		if (!["New", "Reviewed", "Accepted", "Rejected"].includes(status)) {
			return res.status(400).json({ error: "Invalid status" });
		}
		const appId = parseInt(req.params.id);
		db.prepare("UPDATE investor_applications SET status=? WHERE id=?").run(status, appId);

		if (status === "Accepted") {
			const application = db.prepare("SELECT * FROM investor_applications WHERE id=?").get(appId);
			if (!application) return res.status(404).json({ error: "Application not found" });
			// Check if user already exists
			const existingUser = db.prepare("SELECT id FROM users WHERE LOWER(email)=LOWER(?)").get(application.email);
			if (existingUser) return res.json({ success: true, message: "Accepted (user already exists)" });

			// Auto-create investor user account
			const fullName = application.legal_name.trim();
			let baseUsername = fullName.toLowerCase().replace(/\s+/g, ".").replace(/[^a-z0-9.]/g, "");
			let username = baseUsername;
			let suffix = 1;
			while (db.prepare("SELECT id FROM users WHERE LOWER(username)=LOWER(?)").get(username)) {
				username = `${baseUsername}${suffix}`;
				suffix++;
			}
			const tempPassword = crypto.randomBytes(4).toString("hex");
			const hash = await bcrypt.hash(tempPassword, 10);
			const userResult = db.prepare(
				"INSERT INTO users (username, password_hash, role, driver_name, email, full_name, company_name) VALUES (?, ?, 'Investor', '', ?, ?, ?)"
			).run(username, hash, application.email || "", fullName, application.dba || fullName);
			const userId = userResult.lastInsertRowid;

			// Create investor record with full business info from application
			db.prepare(`INSERT OR IGNORE INTO investors
				(user_id, full_name, carrier_name, status, application_id, entity_type, address, phone, email, ein_ssn, tax_classification, contact_person, contact_title)
				VALUES (?, ?, ?, 'Active', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
				.run(userId, fullName, application.dba || fullName, appId,
					application.entity_type || "", application.address || "", application.phone || "",
					application.email || "", application.ein_ssn || "", application.tax_classification || "",
					application.contact_person || "", application.contact_title || "");

			// Create trucks from application vehicles (owner_id = user ID, consistent with dashboard/reports)
			let vehicles = [];
			try { vehicles = JSON.parse(application.vehicles_json || "[]"); } catch { /* skip */ }
			const validTruckStatus = ["Active", "Inactive", "Maintenance", "OOS"];
			for (let i = 0; i < vehicles.length; i++) {
				const v = vehicles[i];
				const unitNum = `INV-${appId}-${String.fromCharCode(65 + i)}`;
				const truckStatus = validTruckStatus.includes(v.status) ? v.status : "Active";
				try {
					db.prepare(`INSERT INTO trucks (unit_number, make, model, year, vin, license_plate, status, owner_id, purchase_price, title_status, title_state, notes)
						VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
					.run(unitNum, v.make || "", v.model || "", parseInt(v.year) || 0, v.vin || "", v.licensePlate || "",
						truckStatus, userId, parseFloat(v.purchasePrice) || 0,
						v.titleStatus || "Clean", v.titleState || "", "");
				} catch { /* skip duplicate */ }
			}

			logAudit(req, "accept_investor", "investor_application", appId, `Accepted investor "${fullName}", created account "${username}", ${vehicles.length} vehicle(s)`);
			notifyChange("investor-applications"); notifyChange("investors"); notifyChange("users"); notifyChange("trucks");
			res.json({ success: true, accountCreated: true, credentials: { username, tempPassword, userId, investorName: fullName } });

			// Send welcome email to investor (async, non-blocking)
			const welcomeHtml = `
			<div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:600px;margin:0 auto;color:#1e293b">
				<div style="background:#0f2847;padding:24px 32px;border-radius:12px 12px 0 0">
					<img src="https://app.logisx.com/logo.avif" alt="LogisX" style="height:36px" />
				</div>
				<div style="padding:32px;background:#fff;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 12px 12px">
					<h2 style="margin:0 0 16px;font-size:20px;color:#0f172a">Welcome to LogisX!</h2>
					<p style="margin:0 0 12px;line-height:1.6;color:#334155">Hi <b>${fullName}</b>,</p>
					<p style="margin:0 0 20px;line-height:1.6;color:#334155">Your investor application has been <b style="color:#16a34a">approved</b>. Your account is ready and ${vehicles.length} vehicle(s) have been registered to your fleet.</p>

					<div style="background:#f0f9ff;border:1px solid #bae6fd;border-radius:10px;padding:20px;margin:0 0 20px">
						<div style="font-size:12px;font-weight:700;color:#0369a1;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:12px">Your Login Credentials</div>
						<table style="width:100%;border-collapse:collapse;font-size:14px">
							<tr><td style="padding:6px 0;color:#64748b;width:130px">Username</td><td style="padding:6px 0;font-weight:700;color:#0f172a;font-family:monospace">${username}</td></tr>
							<tr><td style="padding:6px 0;color:#64748b">Temporary Password</td><td style="padding:6px 0;font-weight:700;color:#d97706;font-family:monospace">${tempPassword}</td></tr>
						</table>
					</div>

					<div style="text-align:center;margin:28px 0">
						<a href="https://app.logisx.com/login" style="display:inline-block;background:#0f2847;color:#ffffff;padding:14px 40px;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px">Login to Your Dashboard &rarr;</a>
					</div>

					<div style="background:#fffbeb;border:1px solid #fef3c7;border-radius:8px;padding:12px 16px;margin:0 0 20px">
						<p style="margin:0;font-size:13px;color:#92400e;line-height:1.5"><b>Important:</b> Please change your password after your first login for security.</p>
					</div>

					<p style="color:#64748b;font-size:13px;margin:20px 0 0">If you have any questions, contact us at <a href="mailto:info@logisx.com" style="color:#3b82f6;text-decoration:none">info@logisx.com</a>.</p>
				</div>
				<div style="padding:16px 32px;text-align:center">
					<div style="font-size:11px;color:#94a3b8;line-height:1.6">LogisX Inc. | 4576 Research Forest Dr, Suite 200, The Woodlands, TX 77381 | USDOT# 4302683</div>
				</div>
			</div>`;
			sendEmail(application.email, "Welcome to LogisX — Your Account is Ready", welcomeHtml);

			// Send admin notification
			const adminAcceptHtml = `
			<div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:600px;margin:0 auto;color:#1e293b">
				<div style="background:#0f2847;padding:24px 32px;border-radius:12px 12px 0 0">
					<img src="https://app.logisx.com/logo.avif" alt="LogisX" style="height:36px" />
				</div>
				<div style="padding:32px;background:#fff;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 12px 12px">
					<h2 style="margin:0 0 16px;font-size:20px;color:#0f172a">Investor Accepted</h2>
					<p style="margin:0 0 20px;line-height:1.6;color:#334155">Investor <b>${fullName}</b> has been accepted and their account has been created.</p>

					<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:16px;margin:0 0 20px">
						<table style="width:100%;border-collapse:collapse;font-size:14px">
							<tr><td style="padding:5px 0;color:#64748b;width:140px">Username</td><td style="padding:5px 0;font-weight:600;font-family:monospace">${username}</td></tr>
							<tr><td style="padding:5px 0;color:#64748b">Email</td><td style="padding:5px 0">${application.email}</td></tr>
							<tr><td style="padding:5px 0;color:#64748b">Entity Type</td><td style="padding:5px 0">${application.entity_type || "-"}</td></tr>
							<tr><td style="padding:5px 0;color:#64748b">Fleet</td><td style="padding:5px 0;font-weight:600">${vehicles.length} vehicle(s) added</td></tr>
							<tr><td style="padding:5px 0;color:#64748b">Accepted By</td><td style="padding:5px 0">${req.session.user.username}</td></tr>
						</table>
					</div>

					<div style="text-align:center;margin:24px 0">
						<a href="https://app.logisx.com/investor-applications" style="display:inline-block;background:#0f2847;color:#ffffff;padding:12px 32px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px">View Applications</a>
					</div>
				</div>
				<div style="padding:16px 32px;text-align:center">
					<div style="font-size:11px;color:#94a3b8;line-height:1.6">LogisX Inc. | 4576 Research Forest Dr, Suite 200, The Woodlands, TX 77381 | USDOT# 4302683</div>
				</div>
			</div>`;
			sendEmail("info@logisx.com", `Investor Accepted: ${fullName}`, adminAcceptHtml);
			return;
		}

		res.json({ success: true });
	} catch (err) {
		res.status(500).json({ error: err.message });
	}
});

// POST /api/investor-outreach/send — Send invite emails to potential investors
app.post("/api/investor-outreach/send", requireRole("Super Admin"), async (req, res) => {
	try {
		const { emails, subject, body } = req.body;
		if (!emails || !Array.isArray(emails) || emails.length === 0) {
			return res.status(400).json({ error: "At least one email is required" });
		}
		if (emails.length > 50) {
			return res.status(400).json({ error: "Maximum 50 emails per batch" });
		}
		if (!subject || !body) {
			return res.status(400).json({ error: "Subject and body are required" });
		}

		const gmailUser = process.env.GMAIL_USER;
		const gmailPass = process.env.GMAIL_APP_PASSWORD;
		if (!gmailUser || !gmailPass) {
			return res.status(500).json({ error: "Email not configured. Set GMAIL_USER and GMAIL_APP_PASSWORD in .env" });
		}

		const transporter = nodemailer.createTransport({
			service: "gmail",
			auth: { user: gmailUser, pass: gmailPass },
		});

		const sentBy = req.session.user.username;
		const logInsert = db.prepare("INSERT INTO investor_outreach_log (email, subject, sent_by, status) VALUES (?, ?, ?, ?)");
		let sentCount = 0;
		const failures = [];

		// Build professional HTML email template wrapping admin's message
		const bodyHtml = body.split(/\n\n+/).map(p => `<p style="margin:0 0 14px;line-height:1.7;color:#334155">${p.replace(/\n/g, "<br>")}</p>`).join("");
		const investLink = "https://app.logisx.com/invest";
		const outreachHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
		<body style="margin:0;padding:0;background:#f1f5f9;font-family:'Helvetica Neue',Arial,sans-serif">
		<div style="max-width:620px;margin:0 auto;padding:24px 16px">
			<!-- Header -->
			<div style="background:#0f2847;padding:28px 32px;border-radius:14px 14px 0 0;text-align:center">
				<img src="https://app.logisx.com/logo.avif" alt="LogisX" style="height:38px" />
			</div>
			<!-- Body -->
			<div style="background:#ffffff;padding:36px 32px 28px;border-left:1px solid #e2e8f0;border-right:1px solid #e2e8f0">
				${bodyHtml}

				<!-- CTA Button -->
				<div style="text-align:center;margin:32px 0">
					<a href="${investLink}" style="display:inline-block;background:#0f2847;color:#ffffff;padding:16px 44px;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px;letter-spacing:0.02em">Start Your Application &rarr;</a>
				</div>

				<!-- Value Props -->
				<div style="margin:28px 0 8px">
					<div style="font-size:13px;font-weight:700;color:#0f172a;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:14px;text-align:center">Why Partner With LogisX?</div>
					<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
						<tr>
							<td style="width:33%;padding:0 6px;vertical-align:top">
								<div style="background:#f0f9ff;border:1px solid #bae6fd;border-radius:10px;padding:18px 14px;text-align:center">
									<div style="font-size:24px;margin-bottom:6px">&#128666;</div>
									<div style="font-size:12px;font-weight:700;color:#0369a1;margin-bottom:4px">Fleet Management</div>
									<div style="font-size:11px;color:#64748b;line-height:1.4">Full operational support for your vehicles</div>
								</div>
							</td>
							<td style="width:33%;padding:0 6px;vertical-align:top">
								<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:18px 14px;text-align:center">
									<div style="font-size:24px;margin-bottom:6px">&#128200;</div>
									<div style="font-size:12px;font-weight:700;color:#15803d;margin-bottom:4px">Revenue Tracking</div>
									<div style="font-size:11px;color:#64748b;line-height:1.4">Real-time financial dashboard &amp; reporting</div>
								</div>
							</td>
							<td style="width:33%;padding:0 6px;vertical-align:top">
								<div style="background:#fefce8;border:1px solid #fef08a;border-radius:10px;padding:18px 14px;text-align:center">
									<div style="font-size:24px;margin-bottom:6px">&#9889;</div>
									<div style="font-size:12px;font-weight:700;color:#a16207;margin-bottom:4px">Simple Onboarding</div>
									<div style="font-size:11px;color:#64748b;line-height:1.4">3-step digital process, done in minutes</div>
								</div>
							</td>
						</tr>
					</table>
				</div>

				<!-- Steps -->
				<div style="margin:24px 0 0">
					<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
						<tr>
							<td style="text-align:center;padding:10px 4px">
								<div style="width:32px;height:32px;border-radius:50%;background:#0f2847;color:#fff;font-weight:700;font-size:14px;line-height:32px;margin:0 auto 6px">1</div>
								<div style="font-size:11px;font-weight:600;color:#0f172a">Application</div>
								<div style="font-size:10px;color:#94a3b8">Company &amp; contact info</div>
							</td>
							<td style="text-align:center;color:#cbd5e1;font-size:18px">&rarr;</td>
							<td style="text-align:center;padding:10px 4px">
								<div style="width:32px;height:32px;border-radius:50%;background:#0f2847;color:#fff;font-weight:700;font-size:14px;line-height:32px;margin:0 auto 6px">2</div>
								<div style="font-size:11px;font-weight:600;color:#0f172a">Documents</div>
								<div style="font-size:10px;color:#94a3b8">Sign agreements &amp; W-9</div>
							</td>
							<td style="text-align:center;color:#cbd5e1;font-size:18px">&rarr;</td>
							<td style="text-align:center;padding:10px 4px">
								<div style="width:32px;height:32px;border-radius:50%;background:#0f2847;color:#fff;font-weight:700;font-size:14px;line-height:32px;margin:0 auto 6px">3</div>
								<div style="font-size:11px;font-weight:600;color:#0f172a">Banking</div>
								<div style="font-size:10px;color:#94a3b8">ACH settlement details</div>
							</td>
						</tr>
					</table>
				</div>
			</div>
			<!-- Footer -->
			<div style="background:#f8fafc;padding:24px 32px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 14px 14px;text-align:center">
				<div style="font-size:13px;font-weight:700;color:#0f172a;margin-bottom:4px">LogisX Inc.</div>
				<div style="font-size:11px;color:#94a3b8;line-height:1.6">
					4576 Research Forest Dr, Suite 200, The Woodlands, TX 77381<br>
					USDOT# 4302683 | <a href="mailto:info@logisx.com" style="color:#3b82f6;text-decoration:none">info@logisx.com</a>
				</div>
			</div>
		</div>
		</body></html>`;

		for (const email of emails) {
			const trimmed = email.trim();
			if (!trimmed || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
				failures.push({ email: trimmed, error: "Invalid email format" });
				continue;
			}
			try {
				await transporter.sendMail({
					from: `"LogisX Inc." <${gmailUser}>`,
					to: trimmed,
					subject,
					text: body,
					html: outreachHtml,
				});
				logInsert.run(trimmed, subject, sentBy, "sent");
				sentCount++;
			} catch (mailErr) {
				logInsert.run(trimmed, subject, sentBy, "failed");
				failures.push({ email: trimmed, error: mailErr.message });
			}
		}

		res.json({ success: true, sentCount, failures, total: emails.length });
	} catch (err) {
		res.status(500).json({ error: err.message });
	}
});

// GET /api/investor-outreach/log — Recent outreach history
app.get("/api/investor-outreach/log", requireRole("Super Admin"), (req, res) => {
	try {
		const logs = db.prepare("SELECT * FROM investor_outreach_log ORDER BY created_at DESC LIMIT 100").all();
		res.json({ logs });
	} catch (err) {
		res.status(500).json({ error: err.message });
	}
});

// === DRIVER ONBOARDING ENDPOINTS ===

// Helper: check if onboarding is complete and finalize
async function checkAndCompleteOnboarding(userId) {
	const ob = db.prepare("SELECT * FROM driver_onboarding WHERE user_id = ?").get(userId);
	if (!ob || ob.status === "fully_onboarded") return ob;
	const signedCount = db.prepare(
		"SELECT COUNT(*) AS cnt FROM onboarding_documents WHERE user_id = ? AND signed = 1"
	).get(userId).cnt;
	const allSigned = signedCount === ONBOARDING_DOCS.length;
	// Update to documents_signed if all docs signed
	if (allSigned && ob.status === "documents_pending") {
		db.prepare("UPDATE driver_onboarding SET status = 'documents_signed' WHERE user_id = ?").run(userId);

		const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
		const application = db.prepare("SELECT * FROM job_applications WHERE id = (SELECT application_id FROM driver_onboarding WHERE user_id = ?)").get(userId);
		const driverName = user?.driver_name || "";
		const driverEmail = user?.email || application?.email || "";

		// Add driver to drivers_directory immediately
		if (driverName) {
			syncDriverToCarrierSheet(driverName, { email: driverEmail, companyName: user?.company_name || "", action: "add" });
			// Backfill directory with application details (city/state/zip/cell/dot/mc/hazmat/address/phone)
			if (application) {
				try {
					db.prepare(`UPDATE drivers_directory SET
						phone = CASE WHEN ? != '' THEN ? ELSE phone END,
						cell = CASE WHEN ? != '' THEN ? ELSE cell END,
						address = CASE WHEN ? != '' THEN ? ELSE address END,
						city = CASE WHEN ? != '' THEN ? ELSE city END,
						state = CASE WHEN ? != '' THEN ? ELSE state END,
						zip = CASE WHEN ? != '' THEN ? ELSE zip END,
						dot = CASE WHEN ? != '' THEN ? ELSE dot END,
						mc = CASE WHEN ? != '' THEN ? ELSE mc END,
						hazmat = CASE WHEN ? != '' THEN ? ELSE hazmat END
						WHERE LOWER(driver_name) = LOWER(?)`).run(
						application.phone || '', application.phone || '',
						application.cell || '', application.cell || '',
						application.address || '', application.address || '',
						application.city || '', application.city || '',
						application.state || '', application.state || '',
						application.zip || '', application.zip || '',
						application.dot || '', application.dot || '',
						application.mc || '', application.mc || '',
						application.hazmat || '', application.hazmat || '',
						driverName.trim()
					);
				} catch (err) { console.error("drivers_directory backfill error:", err.message); }
			}
		}

		// Notify driver
		if (driverName) {
			insertNotification.run(
				driverName.trim().toLowerCase(), "documents_signed",
				"Documents Received", "All onboarding documents have been signed. Stand by for the next steps.",
				JSON.stringify({ userId })
			);
		}

		// Collect signed PDF attachments
		const signedDocs = db.prepare("SELECT doc_key, doc_name, signed_pdf_url FROM onboarding_documents WHERE user_id = ? AND signed = 1").all(userId);
		const pdfAttachments = signedDocs.map(d => {
			if (!d.signed_pdf_url) return null;
			const filepath = path.join(__dirname, d.signed_pdf_url.replace(/^\//, ""));
			return fs.existsSync(filepath) ? { filename: `${d.doc_name}.pdf`, path: filepath } : null;
		}).filter(Boolean);

		// Email to driver — documents received + next steps
		const driverDocsHtml = `
		<div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:600px;margin:0 auto;color:#1e293b">
			<div style="background:#0f2847;padding:24px 32px;border-radius:12px 12px 0 0">
				<img src="https://app.logisx.com/logo.avif" alt="LogisX" style="height:36px" />
			</div>
			<div style="padding:32px;background:#fff;border:1px solid #e2e8f0;border-top:none">
				<h2 style="margin:0 0 16px;font-size:20px;color:#0f172a">Onboarding Status: Documents Received!</h2>
				<p style="margin:0 0 12px;line-height:1.6;color:#334155">Hi <b>${driverName}</b>,</p>
				<p style="margin:0 0 20px;line-height:1.6;color:#334155">Thanks for getting your paperwork squared away. Now that the legal stuff is signed and uploaded, you've officially cleared Phase 1. We are currently reviewing your file.</p>

				<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:16px;margin:0 0 24px">
					<div style="font-size:13px;font-weight:700;color:#0f172a;margin-bottom:12px">Here is what happens next:</div>
					<table style="width:100%;border-collapse:collapse;font-size:13px;color:#334155">
						<tr>
							<td style="padding:8px 10px 8px 0;vertical-align:top;width:24px"><div style="width:22px;height:22px;border-radius:50%;background:#0f2847;color:#fff;font-size:11px;font-weight:700;text-align:center;line-height:22px">1</div></td>
							<td style="padding:8px 0;line-height:1.5;border-bottom:1px solid #f1f5f9"><b>Pre-Employment Screening:</b> A member of our safety team will contact you shortly to schedule your <b>pre-appointment drug test</b>.</td>
						</tr>
						<tr>
							<td style="padding:8px 10px 8px 0;vertical-align:top"><div style="width:22px;height:22px;border-radius:50%;background:#0f2847;color:#fff;font-size:11px;font-weight:700;text-align:center;line-height:22px">2</div></td>
							<td style="padding:8px 0;line-height:1.5;border-bottom:1px solid #f1f5f9"><b>FMCSA Clearinghouse:</b> Make sure you are enrolled and have granted LogisX Inc. permission to run your full query.</td>
						</tr>
						<tr>
							<td style="padding:8px 10px 8px 0;vertical-align:top"><div style="width:22px;height:22px;border-radius:50%;background:#0f2847;color:#fff;font-size:11px;font-weight:700;text-align:center;line-height:22px">3</div></td>
							<td style="padding:8px 0;line-height:1.5"><b>Driver Training:</b> While we finalize your background check, it's time to get in the right mindset.</td>
						</tr>
					</table>
				</div>

				<div style="background:#fffbeb;border:1px solid #fef3c7;border-left:4px solid #f59e0b;border-radius:8px;padding:14px 18px;margin:0 0 24px">
					<div style="font-size:13px;font-weight:700;color:#92400e;margin-bottom:6px">Pro-Tip: Don't end up on the internet for the wrong reasons.</div>
					<p style="margin:0;font-size:13px;color:#78350f;line-height:1.5">Check out <b>Bonehead Truckers</b> — study them so you don't repeat them.</p>
				</div>

				<div style="text-align:center;margin:0 0 24px">
					<a href="https://www.youtube.com/watch?v=KpHxeBQ3TSc&list=PL7DBE50EBBC23F024" style="display:inline-block;background:#dc2626;color:#ffffff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px">&#9654; Watch Bonehead Truckers</a>
				</div>

				<p style="margin:0 0 6px;font-size:14px;color:#334155;text-align:center">Stand by for a call from our safety coordinator.</p>
				<p style="margin:0;font-size:14px;font-weight:700;color:#0f172a;text-align:center">&mdash; The LogisX Safety Team</p>
			</div>
			<div style="padding:16px 32px;text-align:center;background:#f8fafc;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 12px 12px">
				<div style="font-size:11px;color:#94a3b8;line-height:1.6">LogisX Inc. | 4576 Research Forest Dr, Suite 200, The Woodlands, TX 77381 | USDOT# 4302683</div>
			</div>
		</div>`;
		if (driverEmail) sendEmail(driverEmail, "LogisX - Onboarding Status: Documents Received!", driverDocsHtml);

		// Email to admin — all docs signed + attachments
		const adminDocsHtml = `
		<div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:600px;margin:0 auto;color:#1e293b">
			<div style="background:#0f2847;padding:24px 32px;border-radius:12px 12px 0 0">
				<img src="https://app.logisx.com/logo.avif" alt="LogisX" style="height:36px" />
			</div>
			<div style="padding:32px;background:#fff;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 12px 12px">
				<h2 style="margin:0 0 16px;font-size:20px;color:#0f172a">Driver Documents Signed</h2>
				<p style="margin:0 0 20px;line-height:1.6;color:#334155">Driver <b>${driverName}</b> has signed all ${ONBOARDING_DOCS.length} onboarding documents. Signed copies are attached.</p>

				<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:16px;margin:0 0 20px">
					<table style="width:100%;border-collapse:collapse;font-size:14px">
						<tr><td style="padding:5px 0;color:#64748b;width:140px">Driver Name</td><td style="padding:5px 0;font-weight:600">${driverName}</td></tr>
						<tr><td style="padding:5px 0;color:#64748b">Email</td><td style="padding:5px 0">${driverEmail}</td></tr>
						<tr><td style="padding:5px 0;color:#64748b">Phone</td><td style="padding:5px 0">${application?.phone || "—"}</td></tr>
						<tr><td style="padding:5px 0;color:#64748b">Position</td><td style="padding:5px 0">${application?.position || "—"}</td></tr>
						<tr><td style="padding:5px 0;color:#64748b">Documents</td><td style="padding:5px 0;font-weight:600;color:#16a34a">${ONBOARDING_DOCS.length}/${ONBOARDING_DOCS.length} Signed</td></tr>
						<tr><td style="padding:5px 0;color:#64748b">Status</td><td style="padding:5px 0;font-weight:600;color:#d97706">Awaiting Drug Test</td></tr>
					</table>
				</div>

				<p style="font-size:13px;color:#64748b">Signed PDFs are attached to this email.</p>

				<div style="text-align:center;margin:24px 0">
					<a href="https://app.logisx.com/applications" style="display:inline-block;background:#0f2847;color:#ffffff;padding:12px 32px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px">View Applications</a>
				</div>
			</div>
			<div style="padding:16px 32px;text-align:center">
				<div style="font-size:11px;color:#94a3b8;line-height:1.6">LogisX Inc. | 4576 Research Forest Dr, Suite 200, The Woodlands, TX 77381 | USDOT# 4302683</div>
			</div>
		</div>`;
		sendEmail("info@logisx.com", `Driver Documents Signed: ${driverName}`, adminDocsHtml, pdfAttachments);
	}
	// Fully onboarded if all signed AND drug test passed
	if (allSigned && ob.drug_test_result === "pass") {
		const now = new Date().toISOString();
		db.prepare("UPDATE driver_onboarding SET status = 'fully_onboarded', onboarded_at = ? WHERE user_id = ?").run(now, userId);
		// Sync driver to drivers_directory + activate
		const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
		const pathTwoApplication = db.prepare("SELECT * FROM job_applications WHERE id = ?").get(ob.application_id);
		if (user) {
			syncDriverToCarrierSheet(user.driver_name, { email: user.email, companyName: user.company_name, action: "add" });

			// Backfill application details (idempotent — only fills blank fields so manual edits win)
			if (pathTwoApplication) {
				try {
					db.prepare(`UPDATE drivers_directory SET
						phone = CASE WHEN ? != '' THEN ? ELSE phone END,
						cell = CASE WHEN ? != '' THEN ? ELSE cell END,
						address = CASE WHEN ? != '' THEN ? ELSE address END,
						city = CASE WHEN ? != '' THEN ? ELSE city END,
						state = CASE WHEN ? != '' THEN ? ELSE state END,
						zip = CASE WHEN ? != '' THEN ? ELSE zip END,
						dot = CASE WHEN ? != '' THEN ? ELSE dot END,
						mc = CASE WHEN ? != '' THEN ? ELSE mc END,
						hazmat = CASE WHEN ? != '' THEN ? ELSE hazmat END
						WHERE LOWER(driver_name) = LOWER(?)`).run(
						pathTwoApplication.phone || '', pathTwoApplication.phone || '',
						pathTwoApplication.cell || '', pathTwoApplication.cell || '',
						pathTwoApplication.address || '', pathTwoApplication.address || '',
						pathTwoApplication.city || '', pathTwoApplication.city || '',
						pathTwoApplication.state || '', pathTwoApplication.state || '',
						pathTwoApplication.zip || '', pathTwoApplication.zip || '',
						pathTwoApplication.dot || '', pathTwoApplication.dot || '',
						pathTwoApplication.mc || '', pathTwoApplication.mc || '',
						pathTwoApplication.hazmat || '', pathTwoApplication.hazmat || '',
						(user.driver_name || '').trim()
					);
				} catch (err) { console.error("drivers_directory path2 backfill error:", err.message); }
			}

			// Auto-activate the driver now that drug test passed
			try {
				db.prepare("UPDATE drivers_directory SET status = 'active' WHERE LOWER(driver_name) = LOWER(?)").run((user.driver_name || '').trim());
			} catch (err) { console.error("drivers_directory activation error:", err.message); }

			insertNotification.run(
				user.driver_name.trim().toLowerCase(), "onboarding_complete",
				"Onboarding Complete", "You are now fully onboarded. Welcome to LogisX!",
				JSON.stringify({ userId })
			);
		}
		return { ...ob, status: "fully_onboarded", onboarded_at: now };
	}
	return db.prepare("SELECT * FROM driver_onboarding WHERE user_id = ?").get(userId);
}

// GET /api/onboarding — list all onboarding records (Super Admin)
app.get("/api/onboarding", requireRole("Super Admin"), (req, res) => {
	try {
		const records = db.prepare(`
			SELECT o.*, u.username, u.email,
				(SELECT COUNT(*) FROM onboarding_documents WHERE user_id = o.user_id AND signed = 1) AS signed_count
			FROM driver_onboarding o
			JOIN users u ON u.id = o.user_id
			ORDER BY o.created_at DESC
		`).all();
		res.json({ records, totalDocs: ONBOARDING_DOCS.length });
	} catch (err) {
		res.status(500).json({ error: err.message });
	}
});

// GET /api/onboarding/:userId — get onboarding status + doc statuses
app.get("/api/onboarding/:userId", requireAuth, (req, res) => {
	try {
		const userId = parseInt(req.params.userId);
		// Drivers can only access their own
		if (req.session.user.role === "Driver" && req.session.user.id !== userId) {
			return res.status(403).json({ error: "Forbidden" });
		}
		const onboarding = db.prepare("SELECT * FROM driver_onboarding WHERE user_id = ?").get(userId);
		if (!onboarding) return res.status(404).json({ error: "No onboarding record" });
		const documents = db.prepare("SELECT * FROM onboarding_documents WHERE user_id = ? ORDER BY id").all(userId);
		res.json({ onboarding, documents, totalDocs: ONBOARDING_DOCS.length });
	} catch (err) {
		res.status(500).json({ error: err.message });
	}
});

// POST /api/onboarding/:userId/documents/:docKey/sign — driver signs a document
app.post("/api/onboarding/:userId/documents/:docKey/sign", requireAuth, async (req, res) => {
	try {
		const userId = parseInt(req.params.userId);
		const { docKey } = req.params;
		const { signatureText, signatureImage, paymentInfo } = req.body;
		if (req.session.user.id !== userId) {
			return res.status(403).json({ error: "You can only sign your own documents" });
		}
		if (!signatureText || !signatureText.trim()) {
			return res.status(400).json({ error: "Signature is required" });
		}
		const docRow = db.prepare("SELECT * FROM onboarding_documents WHERE user_id = ? AND doc_key = ?").get(userId, docKey);
		if (!docRow) return res.status(404).json({ error: "Document not found" });
		if (docRow.signed) return res.json({ success: true, message: "Already signed" });

		const signedDir = path.join(__dirname, "uploads", "onboarding-signed");
		if (!fs.existsSync(signedDir)) fs.mkdirSync(signedDir, { recursive: true });
		const signedFileName = `${docKey}-${userId}-signed.pdf`;
		const signedPath = path.join(signedDir, signedFileName);
		let signedPdfUrl = `/uploads/onboarding-signed/${signedFileName}`;

		// All 4 policy docs now share a single HTML → Puppeteer → PDF pipeline.
		// W-9 stays on pdf-lib because it's an IRS AcroForm fill, not a generated layout.
		// service_invoice is intentionally NOT in this branch — it was dead code here
		// (never in ONBOARDING_DOCS). The real service invoice use is the weekly
		// invoice flow at POST /api/invoices/generate.
		const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
		const application = db.prepare("SELECT * FROM job_applications WHERE id = (SELECT application_id FROM driver_onboarding WHERE user_id = ?)").get(userId);
		const effectiveDate = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
		const resolvedFullName = user?.driver_name || application?.full_name || signatureText.trim();

		if (docKey === "contractor_agreement") {
			// Contractor agreement has banking info — persist it before rendering
			if (paymentInfo) {
				db.prepare(`INSERT OR REPLACE INTO driver_payment_info
					(user_id, payment_method, check_name, bank_name, bank_address, bank_phone, bank_routing, bank_account, bank_acct_name, account_type)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
				).run(userId, paymentInfo.paymentMethod || "", paymentInfo.checkName || "",
					paymentInfo.bankName || "", paymentInfo.bankAddress || "", paymentInfo.bankPhone || "",
					paymentInfo.bankRouting || "", paymentInfo.bankAccount || "", paymentInfo.bankAcctName || "",
					paymentInfo.accountType || "");
			}
			const pdfBuffer = await renderPolicy("contractor_agreement", {
				fullName: resolvedFullName,
				address: application?.address || "",
				effectiveDate,
				signatureText: signatureText.trim(),
				signatureImage: signatureImage || null,
				paymentMethod: paymentInfo?.paymentMethod || "",
				checkName: paymentInfo?.checkName || "",
				bankName: paymentInfo?.bankName || "",
				bankAddress: paymentInfo?.bankAddress || "",
				bankPhone: paymentInfo?.bankPhone || "",
				bankRouting: paymentInfo?.bankRouting || "",
				bankAccount: paymentInfo?.bankAccount || "",
				bankAcctName: paymentInfo?.bankAcctName || "",
				accountType: paymentInfo?.accountType || "",
			});
			fs.writeFileSync(signedPath, pdfBuffer);
		} else if (docKey === "equipment_policy" || docKey === "mobile_policy" || docKey === "substance_policy") {
			const pdfBuffer = await renderPolicy(docKey, {
				fullName: resolvedFullName,
				effectiveDate,
				signatureText: signatureText.trim(),
				signatureImage: signatureImage || null,
			});
			fs.writeFileSync(signedPath, pdfBuffer);
		} else {
			// W-9: fill form fields (same as investor) + overlay signature and date
			const pdfBytes = await fillW9Form({
				legalName: resolvedFullName,
				entityType: "Sole Prop",
				address: application?.address || "",
				einSsn: application?.ssn || "",
				signatureText: signatureText.trim(),
				signatureImage: signatureImage || undefined,
				effectiveDate,
			});
			if (pdfBytes) {
				fs.writeFileSync(signedPath, pdfBytes);
			} else {
				signedPdfUrl = "";
			}
		}

		const nowIso = new Date().toISOString();
		db.prepare(
			"UPDATE onboarding_documents SET signed = 1, signature_text = ?, signed_at = ?, signed_pdf_url = ? WHERE user_id = ? AND doc_key = ?"
		).run(signatureText.trim(), nowIso, signedPdfUrl, userId, docKey);

		const updated = await checkAndCompleteOnboarding(userId);
		res.json({ success: true, onboarding: updated });
	} catch (err) {
		console.error("Sign document error:", err.message);
		res.status(500).json({ error: err.message });
	}
});

// Signed onboarding PDFs are served by the authenticated /uploads mount (see top of file).

// POST /api/onboarding/:userId/drug-test — Super Admin uploads drug test result
app.post("/api/onboarding/:userId/drug-test", requireRole("Super Admin"), async (req, res) => {
	try {
		const userId = parseInt(req.params.userId);
		const { result, fileData, fileName } = req.body;
		if (!["pass", "fail"].includes(result)) {
			return res.status(400).json({ error: "Result must be 'pass' or 'fail'" });
		}
		const ob = db.prepare("SELECT * FROM driver_onboarding WHERE user_id = ?").get(userId);
		if (!ob) return res.status(404).json({ error: "No onboarding record" });

		let fileUrl = "";
		if (fileData && fileName) {
			if (!validateFileExt(fileName)) return res.status(400).json({ error: "File type not allowed" });
			// Save file to uploads/onboarding/
			const uploadsDir = path.join(__dirname, "uploads", "onboarding");
			if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
			const ext = path.extname(fileName) || ".pdf";
			const safeName = `drug-test-${userId}-${Date.now()}${ext}`;
			const filePath = path.join(uploadsDir, safeName);
			const buffer = Buffer.from(fileData, "base64");
			fs.writeFileSync(filePath, buffer);
			fileUrl = `/uploads/onboarding/${safeName}`;
		}

		const now = new Date().toISOString();
		db.prepare(
			"UPDATE driver_onboarding SET drug_test_result = ?, drug_test_file_url = ?, drug_test_uploaded_at = ? WHERE user_id = ?"
		).run(result, fileUrl, now, userId);

		const updated = await checkAndCompleteOnboarding(userId);
		logAudit(req, "upload_drug_test", "onboarding", userId, `Drug test: ${result} for ${ob.driver_name}`);
		res.json({ success: true, onboarding: updated });
	} catch (err) {
		res.status(500).json({ error: err.message });
	}
});

// GET /api/onboarding/documents/:docKey/pdf — serve onboarding PDF (HTML template rendered via Puppeteer)
app.get("/api/onboarding/documents/:docKey/pdf", requireAuth, async (req, res) => {
	try {
		const { docKey } = req.params;
		const docDef = ONBOARDING_DOCS.find(d => d.key === docKey);
		if (!docDef) return res.status(404).json({ error: "Unknown document" });

		const userId = req.session.user.id;
		const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
		const application = db.prepare("SELECT * FROM job_applications WHERE id = (SELECT application_id FROM driver_onboarding WHERE user_id = ?)").get(userId);
		const driverName = user?.driver_name || application?.full_name || "";
		const effectiveDate = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

		if (docKey === "w9") {
			// W-9: fill form fields (same as investor) — preview without signature
			const pdfBytes = await fillW9Form({
				legalName: driverName,
				entityType: "Sole Prop",
				address: application?.address || "",
				einSsn: application?.ssn || "",
				effectiveDate,
			});
			if (!pdfBytes) return res.status(404).json({ error: "W-9 template not found" });
			res.setHeader("Content-Type", "application/pdf");
			res.setHeader("Content-Disposition", 'inline; filename="W-9 Preview.pdf"');
			return res.send(Buffer.from(pdfBytes));
		}

		// HTML → Puppeteer → PDF for all policy docs (preview = no signature)
		const previewData = {
			fullName: driverName,
			address: application?.address || "",
			effectiveDate,
			signatureText: "",
			signatureImage: null,
			// Contractor agreement gets empty banking defaults for preview
			paymentMethod: "",
			checkName: "",
			bankName: "",
			bankAddress: "",
			bankPhone: "",
			bankRouting: "",
			bankAccount: "",
			bankAcctName: "",
			accountType: "",
		};
		const pdfBuffer = await renderPolicy(docKey, previewData);
		res.setHeader("Content-Type", "application/pdf");
		res.setHeader("Content-Disposition", `inline; filename="${docKey}-preview.pdf"`);
		return res.send(pdfBuffer);
	} catch (err) {
		console.error("Policy preview error:", err.message);
		res.status(500).json({ error: err.message });
	}
});

// Drug test files under uploads/onboarding are served by the authenticated /uploads mount (see top of file).

// === INVOICE ENDPOINTS ===

// Helper: compute LogisX week range (Saturday–Friday) in CST
function getWeekRange(referenceDate) {
	const d = referenceDate ? new Date(referenceDate) : new Date();
	// Convert to CST (America/Chicago)
	const cstStr = d.toLocaleString("en-US", { timeZone: "America/Chicago" });
	const cst = new Date(cstStr);
	const day = cst.getDay(); // 0=Sun..6=Sat
	// Find the most recent Saturday
	const satOffset = day === 6 ? 0 : day + 1;
	const weekStart = new Date(cst);
	weekStart.setDate(cst.getDate() - satOffset);
	weekStart.setHours(0, 0, 0, 0);
	// Friday = Saturday + 6
	const weekEnd = new Date(weekStart);
	weekEnd.setDate(weekStart.getDate() + 6);
	weekEnd.setHours(23, 59, 59, 999);
	const fmt = (dt) => dt.toISOString().split("T")[0];
	return { weekStart: fmt(weekStart), weekEnd: fmt(weekEnd) };
}

function isAfterDeadline(weekEndDate) {
	const nowStr = new Date().toLocaleString("en-US", { timeZone: "America/Chicago" });
	const now = new Date(nowStr);
	const deadline = new Date(weekEndDate + "T18:00:00");
	return now > deadline;
}

function generateInvoiceNumber(driverName, weekStart) {
	const initials = driverName.split(/\s+/).map(w => w[0]).join("").toUpperCase().slice(0, 3);
	const d = new Date(weekStart);
	const year = d.getFullYear();
	// ISO week number
	const jan1 = new Date(year, 0, 1);
	const days = Math.floor((d - jan1) / 86400000);
	const weekNum = Math.ceil((days + jan1.getDay() + 1) / 7);
	const weekStr = String(weekNum).padStart(2, "0");
	// Check for existing invoices this week for this driver
	const existing = db.prepare("SELECT COUNT(*) AS cnt FROM invoices WHERE driver = ? AND week_start = ?")
		.get(driverName.toLowerCase(), weekStart).cnt;
	const seq = String(existing + 1).padStart(2, "0");
	return `INV-${initials}-${year}W${weekStr}-${seq}`;
}

// POST /api/invoices/generate — driver generates weekly invoice
app.post("/api/invoices/generate", requireAuth, async (req, res) => {
	try {
		const user = req.session.user;
		const driverName = user.role === "Driver" ? user.driverName : (req.body.driver || "");
		if (!driverName) return res.status(400).json({ error: "Driver name required" });

		// Only driver for themselves or Super Admin
		if (user.role === "Driver" && user.driverName.toLowerCase() !== driverName.toLowerCase()) {
			return res.status(403).json({ error: "Forbidden" });
		}

		const { weekEnd } = req.body;
		const range = weekEnd ? getWeekRange(weekEnd) : getWeekRange();
		const { weekStart, weekEnd: computedWeekEnd } = range;

		// Check for existing invoice this week
		const existing = db.prepare("SELECT * FROM invoices WHERE LOWER(driver) = ? AND week_start = ?")
			.get(driverName.toLowerCase(), weekStart);
		if (existing && existing.status !== "Draft") {
			return res.status(409).json({ error: "Invoice already submitted for this week", invoice: existing });
		}

		// Fetch loads from Google Sheets
		const sheets = await getSheets();
		const resp = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: "Job Tracking" });
		const rows = resp.data.values || [];
		if (rows.length < 2) return res.status(400).json({ error: "No data in Job Tracking" });
		const headers = rows[0];
		const data = rows.slice(1).map((r, i) => {
			const obj = {};
			headers.forEach((h, j) => { obj[h] = r[j] || ""; });
			obj._rowIndex = i + 2;
			return obj;
		});

		const driverCol = headers.find(h => /driver/i.test(h));
		// Match "Job Status" as well as plain "Status" — the production sheet
		// uses "Job Status" while the anchored /^status$/i from before did
		// not match it, causing statusCol to be undefined and the whole
		// week filter to reject every row with "No completed loads".
		const statusCol = headers.find(h => /^(job[\s._-]?)?status$/i.test(h));
		const loadIdCol = headers.find(h => /load.?id|job.?id/i.test(h));
		const dateCol = headers.find(h => /status.*update.*date|completion.*date|drop.?off.*date|deliv.*date/i.test(h))
			|| headers.find(h => /date/i.test(h));

		// Filter completed loads for this driver in the week
		const completedRe = /delivered|completed|pod received/i;
		const nameLower = driverName.toLowerCase();
		const weekLoads = data.filter(row => {
			if (!driverCol || (row[driverCol] || "").trim().toLowerCase() !== nameLower) return false;
			if (!statusCol || !completedRe.test(row[statusCol])) return false;
			if (!dateCol) return true; // if no date column, include all completed
			// Parse date and check if in week range
			const rawDate = (row[dateCol] || "").replace(/^date:\s*/i, "").trim();
			if (!rawDate) return true; // no date? include to be safe
			const parsed = new Date(rawDate);
			if (isNaN(parsed.getTime())) return true;
			const dateStr = parsed.toISOString().split("T")[0];
			return dateStr >= weekStart && dateStr <= computedWeekEnd;
		});

		// Deduplicate by load ID (keep last)
		const loadMap = new Map();
		for (const load of weekLoads) {
			const lid = loadIdCol ? (load[loadIdCol] || "") : "";
			if (lid) loadMap.set(lid, load);
			else loadMap.set(`_row_${load._rowIndex}`, load);
		}
		const uniqueLoads = [...loadMap.values()];

		if (uniqueLoads.length === 0) {
			return res.status(400).json({ error: "No completed loads found for this week", weekStart, weekEnd: computedWeekEnd });
		}

		// Fetch expenses for this week
		const expenses = db.prepare(
			`SELECT * FROM expenses WHERE LOWER(driver) = ? AND date >= ? AND date <= ? ORDER BY date ASC`
		).all(nameLower, weekStart, computedWeekEnd);

		const loadsCount = uniqueLoads.length;
		const dailyRate = 250;
		const expensesTotal = expenses.reduce((sum, e) => sum + (e.amount || 0), 0);
		const loadIds = uniqueLoads.map(l => loadIdCol ? l[loadIdCol] : "").filter(Boolean);
		const expenseIds = expenses.map(e => e.id);

		// --- Active-day algorithm for driver pay ---
		// Parse date from messy sheet values like "5/16/25 9:00" or "5/16/25 06:00-18:00 Appt."
		function parseInvoiceDate(val) {
			if (!val) return null;
			const cleaned = String(val).replace(/^date:\s*/i, "").trim();
			// Try M/D/YY or M/D/YYYY format first
			const m = cleaned.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
			if (m) {
				let yr = parseInt(m[3]); if (yr < 100) yr += 2000;
				const d = new Date(yr, parseInt(m[1]) - 1, parseInt(m[2]));
				return isNaN(d) ? null : d;
			}
			// Fallback: try native Date parse
			const d = new Date(cleaned);
			return isNaN(d) ? null : d;
		}
		function fmtLocalDate(d) {
			return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
		}

		const pickupCol = headers.find(h => /pickup.*appo|pickup.*date/i.test(h));
		const dropoffCol = headers.find(h => /drop.?off.*appo|drop.?off.*date|deliv.*appoint/i.test(h));
		const activeDaySet = new Set();
		const dayLoadMap = {}; // date string → [load IDs]

		for (const load of uniqueLoads) {
			const pickup = parseInvoiceDate(pickupCol ? load[pickupCol] : null);
			const dropoff = parseInvoiceDate(dropoffCol ? load[dropoffCol] : null);
			if (!pickup) continue;
			const start = new Date(pickup); start.setHours(12, 0, 0, 0);
			const end = dropoff ? new Date(dropoff) : new Date(pickup);
			end.setHours(12, 0, 0, 0);
			if (end < start) { end.setTime(start.getTime()); }
			const cur = new Date(start);
			const lid = loadIdCol ? (load[loadIdCol] || "") : "";
			while (cur <= end) {
				const ds = fmtLocalDate(cur);
				// Only count days within the invoice week
				if (ds >= weekStart && ds <= computedWeekEnd) {
					activeDaySet.add(ds);
					if (!dayLoadMap[ds]) dayLoadMap[ds] = [];
					if (lid && !dayLoadMap[ds].includes(lid)) dayLoadMap[ds].push(lid);
				}
				cur.setDate(cur.getDate() + 1);
			}
		}

		const activeDays = activeDaySet.size;
		const totalEarnings = activeDays * dailyRate;

		// Generate invoice number
		// Delete existing draft if any
		if (existing && existing.status === "Draft") {
			db.prepare("DELETE FROM invoices WHERE id = ?").run(existing.id);
		}
		const invoiceNumber = generateInvoiceNumber(driverName, weekStart);

		// Generate PDF via HTML → Puppeteer pipeline (see lib/policy-renderer.js)
		const uploadsDir = path.join(__dirname, "uploads", "invoices");
		if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
		const pdfFileName = `${invoiceNumber}.pdf`;
		const pdfPath = path.join(uploadsDir, pdfFileName);

		// Bucket active days into the Sat–Fri template grid
		const DAY_NAMES = ["Saturday", "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
		const daysMap = {};
		for (const d of DAY_NAMES) daysMap[d] = { loadBol: "", total: 0, completed: false };
		for (const ds of activeDaySet) {
			const dt = new Date(ds + "T12:00:00");
			const jsDay = dt.getDay(); // 0=Sun..6=Sat
			const templateDay = DAY_NAMES[(jsDay + 1) % 7]; // shift so 6(Sat)→0, 0(Sun)→1, ...
			const entry = daysMap[templateDay];
			entry.total += dailyRate;
			entry.completed = true;
			const bols = dayLoadMap[ds] || [];
			entry.loadBol = entry.loadBol
				? `${entry.loadBol}, ${bols.join(", ")}`.replace(/, $/, "")
				: bols.join(", ");
		}

		// Lookup driver's contact info + payment info for the invoice header
		const driverUser = db.prepare("SELECT id FROM users WHERE LOWER(driver_name) = LOWER(?)").get(driverName);
		const payInfo = driverUser
			? db.prepare("SELECT * FROM driver_payment_info WHERE user_id = ?").get(driverUser.id)
			: null;
		// Pull provider address + phone from drivers_directory (populated during onboarding)
		const driverRow = db.prepare(
			"SELECT address, city, state, zip, phone, cell FROM drivers_directory WHERE LOWER(driver_name) = LOWER(?)"
		).get(driverName);
		const providerAddress = driverRow
			? [driverRow.address, driverRow.city, driverRow.state, driverRow.zip].filter(Boolean).join(", ")
			: "";
		const providerPhone = driverRow ? (driverRow.phone || driverRow.cell || "") : "";

		const nowStr = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
		const pdfBuffer = await renderPolicy("service_invoice", {
			driverName,
			businessName: driverName,
			providerAddress,
			providerPhone,
			invoiceNumberSuffix: invoiceNumber.replace(/^INV-/, ""),
			submissionDate: nowStr,
			signatureDate: nowStr,
			totalDue: totalEarnings,
			bankOnFile: payInfo?.bank_name || "",
			accountType: (payInfo?.account_type || "").toLowerCase(),
			days: daysMap,
			// Default compliance checkboxes to checked — the driver is certifying they've
			// uploaded these documents via the app. Unchecking is a manual override.
			hasEldData: true,
			hasBol: true,
			hasDvir: true,
			hasFuelReceipts: true,
		});
		fs.writeFileSync(pdfPath, pdfBuffer);

		// Insert into DB (rate_per_load stores daily rate; loads_count stores active days for this invoice)
		const result = db.prepare(
			`INSERT INTO invoices (invoice_number, driver, week_start, week_end, loads_count, rate_per_load, total_earnings, expenses_total, status, pdf_file_name, load_ids, expense_ids)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Draft', ?, ?, ?)`
		).run(
			invoiceNumber, driverName.toLowerCase(), weekStart, computedWeekEnd,
			activeDays, dailyRate, totalEarnings, expensesTotal,
			pdfFileName, JSON.stringify(loadIds), JSON.stringify(expenseIds)
		);

		const invoice = db.prepare("SELECT * FROM invoices WHERE id = ?").get(result.lastInsertRowid);
		const late = isAfterDeadline(computedWeekEnd);
		res.json({ success: true, invoice, isLate: late });
	} catch (err) {
		console.error("Invoice generation error:", err.message);
		res.status(500).json({ error: err.message });
	}
});

// GET /api/invoices — list invoices
app.get("/api/invoices", requireAuth, (req, res) => {
	try {
		const user = req.session.user;
		let invoices;
		if (user.role === "Super Admin") {
			const driverFilter = req.query.driver;
			const statusFilter = req.query.status;
			let sql = "SELECT * FROM invoices WHERE 1=1";
			const params = [];
			if (driverFilter) { sql += " AND LOWER(driver) = ?"; params.push(driverFilter.toLowerCase()); }
			if (statusFilter) { sql += " AND status = ?"; params.push(statusFilter); }
			sql += " ORDER BY created_at DESC";
			invoices = db.prepare(sql).all(...params);
		} else {
			const driverName = user.driverName || "";
			invoices = db.prepare("SELECT * FROM invoices WHERE LOWER(driver) = ? ORDER BY created_at DESC")
				.all(driverName.toLowerCase());
		}
		res.json({ invoices });
	} catch (err) {
		res.status(500).json({ error: err.message });
	}
});

// GET /api/invoices/:id/pdf — serve invoice PDF
app.get("/api/invoices/:id/pdf", requireAuth, (req, res) => {
	try {
		const invoice = db.prepare("SELECT * FROM invoices WHERE id = ?").get(parseInt(req.params.id));
		if (!invoice) return res.status(404).json({ error: "Invoice not found" });
		// Drivers can only access their own
		const user = req.session.user;
		if (user.role === "Driver" && invoice.driver !== (user.driverName || "").toLowerCase()) {
			return res.status(403).json({ error: "Forbidden" });
		}
		const pdfPath = path.join(__dirname, "uploads", "invoices", invoice.pdf_file_name);
		if (!fs.existsSync(pdfPath)) return res.status(404).json({ error: "PDF file not found" });
		res.setHeader("Content-Type", "application/pdf");
		res.setHeader("Content-Disposition", `inline; filename="${invoice.pdf_file_name}"`);
		fs.createReadStream(pdfPath).pipe(res);
	} catch (err) {
		res.status(500).json({ error: err.message });
	}
});

// PUT /api/invoices/:id/submit — driver submits invoice AND emails the PDF
// to Super Admin (info@logisx.com) so the admin can review in their inbox.
// Email is best-effort: submission succeeds even if the email fails.
app.put("/api/invoices/:id/submit", requireAuth, async (req, res) => {
	try {
		const invoice = db.prepare("SELECT * FROM invoices WHERE id = ?").get(parseInt(req.params.id));
		if (!invoice) return res.status(404).json({ error: "Invoice not found" });
		const user = req.session.user;
		if (user.role === "Driver" && invoice.driver !== (user.driverName || "").toLowerCase()) {
			return res.status(403).json({ error: "Forbidden" });
		}
		if (invoice.status !== "Draft") {
			return res.status(400).json({ error: `Cannot submit invoice with status "${invoice.status}"` });
		}
		const now = new Date().toISOString();
		db.prepare("UPDATE invoices SET status = 'Submitted', submitted_at = ? WHERE id = ?").run(now, invoice.id);
		notifyChange("invoices");
		res.json({ success: true });

		// Fire-and-forget: attach the PDF and email the admin. Wrapped in
		// try/catch so any email failure never blocks the 200 response.
		(async () => {
			try {
				const adminEmail = process.env.GMAIL_USER || "info@logisx.com";
				const pdfPath = path.join(__dirname, "uploads", "invoices", invoice.pdf_file_name || "");
				const attachments = invoice.pdf_file_name && fs.existsSync(pdfPath)
					? [{ filename: invoice.pdf_file_name, path: pdfPath }]
					: [];
				const html = invoiceEmailHtml({
					heading: `New Invoice: ${escHtml(invoice.invoice_number)}`,
					bodyHtml: `
						<p style="margin:0 0 12px;line-height:1.6;color:#334155">Driver <b>${escHtml(invoice.driver)}</b> just submitted an invoice for the week of ${escHtml(invoice.week_start)} — ${escHtml(invoice.week_end)}.</p>
						<div style="background:#f0f9ff;border:1px solid #bae6fd;border-radius:10px;padding:16px;margin:16px 0">
							<div style="display:flex;justify-content:space-between;font-size:13px;padding:4px 0"><span style="color:#64748b">Invoice</span><b>${escHtml(invoice.invoice_number)}</b></div>
							<div style="display:flex;justify-content:space-between;font-size:13px;padding:4px 0"><span style="color:#64748b">Driver</span><b>${escHtml(invoice.driver)}</b></div>
							<div style="display:flex;justify-content:space-between;font-size:13px;padding:4px 0"><span style="color:#64748b">Week</span><b>${escHtml(invoice.week_start)} — ${escHtml(invoice.week_end)}</b></div>
							<div style="display:flex;justify-content:space-between;font-size:13px;padding:4px 0"><span style="color:#64748b">Loads</span><b>${Number(invoice.loads_count || 0)}</b></div>
							<div style="display:flex;justify-content:space-between;font-size:15px;padding:8px 0 0;border-top:1px solid #bae6fd;margin-top:6px"><span style="color:#64748b;font-weight:600">Total</span><b style="color:#0f172a">$${Number(invoice.total_earnings || 0).toFixed(2)}</b></div>
						</div>
						<p style="margin:0 0 12px;line-height:1.5;color:#334155;font-size:13px">The full invoice PDF is attached. Log in to the admin dashboard to approve, reject, or mark as paid.</p>
					`,
					ctaText: "Review Invoice",
					ctaHref: "https://app.logisx.com/invoices",
				});
				await sendEmail(adminEmail, `New Invoice: ${invoice.invoice_number} - ${invoice.driver}`, html, attachments);
			} catch (emailErr) {
				console.error("Invoice submit email failed:", emailErr.message);
			}
		})();
	} catch (err) {
		res.status(500).json({ error: err.message });
	}
});

// PUT /api/invoices/:id/approve — Super Admin transitions invoice status.
// Valid state machine:
//   Submitted → Approved (or Rejected)
//   Approved → Processing (or Paid)
//   Processing → Paid
// Every successful transition fires an email to the driver.
app.put("/api/invoices/:id/approve", requireRole("Super Admin"), async (req, res) => {
	try {
		const invoice = db.prepare("SELECT * FROM invoices WHERE id = ?").get(parseInt(req.params.id));
		if (!invoice) return res.status(404).json({ error: "Invoice not found" });
		const { action, rejectionNote } = req.body; // action: "approve" | "reject" | "processing" | "paid"
		if (!["approve", "reject", "processing", "paid"].includes(action)) {
			return res.status(400).json({ error: "Action must be 'approve', 'reject', 'processing', or 'paid'" });
		}
		// Enforce valid transitions
		const currentStatus = invoice.status;
		const transitionOk = {
			approve: currentStatus === "Submitted",
			reject: currentStatus === "Submitted",
			processing: currentStatus === "Approved",
			paid: currentStatus === "Approved" || currentStatus === "Processing",
		}[action];
		if (!transitionOk) {
			return res.status(400).json({ error: `Cannot ${action} an invoice with status "${currentStatus}"` });
		}
		const now = new Date().toISOString();
		const adminName = req.session.user.username;
		let newStatus = "";
		if (action === "approve") {
			newStatus = "Approved";
			db.prepare("UPDATE invoices SET status = 'Approved', approved_at = ?, approved_by = ? WHERE id = ?")
				.run(now, adminName, invoice.id);
		} else if (action === "reject") {
			newStatus = "Rejected";
			db.prepare("UPDATE invoices SET status = 'Rejected', rejection_note = ?, approved_at = ?, approved_by = ? WHERE id = ?")
				.run(rejectionNote || "", now, adminName, invoice.id);
		} else if (action === "processing") {
			newStatus = "Processing";
			// Record the processing transition in its own fields — do NOT
			// overwrite approved_at / approved_by (which tracked who first
			// approved the invoice).
			db.prepare("UPDATE invoices SET status = 'Processing', processed_at = ?, processed_by = ? WHERE id = ?")
				.run(now, adminName, invoice.id);
		} else if (action === "paid") {
			newStatus = "Paid";
			// Same principle: paid_at / paid_by are separate from approved_*
			// so the original approver is preserved in the audit trail.
			db.prepare("UPDATE invoices SET status = 'Paid', paid_at = ?, paid_by = ? WHERE id = ?")
				.run(now, adminName, invoice.id);
		}
		notifyChange("invoices");
		res.json({ success: true, status: newStatus });

		// Fire-and-forget: email the driver about the status change. Best-effort.
		(async () => {
			try {
				const driverUser = db.prepare(
					"SELECT email FROM users WHERE LOWER(driver_name) = LOWER(?) AND role = 'Driver' LIMIT 1"
				).get(invoice.driver);
				if (!driverUser || !driverUser.email) return;
				const updated = { ...invoice, status: newStatus };
				const html = invoiceStatusChangeEmail(updated, newStatus, rejectionNote || "");
				await sendEmail(driverUser.email, `Invoice ${invoice.invoice_number}: ${newStatus}`, html);
			} catch (emailErr) {
				console.error("Invoice status email failed:", emailErr.message);
			}
		})();
	} catch (err) {
		res.status(500).json({ error: err.message });
	}
});

// Invoice PDFs are served by the authenticated /uploads mount (see top of file).

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

// Login — rate limited to prevent brute-force
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: { error: "Too many login attempts. Try again in 15 minutes." }, standardHeaders: true });
app.post("/api/auth/login", loginLimiter, async (req, res) => {
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

// Change the current user's own password. Requires the current password
// to prevent someone with an unattended session from locking the real user out.
// Rate-limited (5/15min per IP) to defeat brute-force against currentPassword.
// On success, purges all other sessions for this user and rotates the current
// session ID so any hijacked cookies are invalidated immediately.
const changePasswordLimiter = rateLimit({
	windowMs: 15 * 60 * 1000,
	max: 5,
	message: { error: "Too many password change attempts. Try again in 15 minutes." },
	standardHeaders: true,
});
app.post("/api/auth/change-password", requireAuth, changePasswordLimiter, async (req, res) => {
	try {
		const { currentPassword, newPassword } = req.body;
		if (!currentPassword || !newPassword) {
			return res.status(400).json({ error: "Current and new password required" });
		}
		if (typeof newPassword !== "string" || newPassword.length < 8) {
			return res.status(400).json({ error: "New password must be at least 8 characters" });
		}
		if (newPassword.length > 200) {
			return res.status(400).json({ error: "New password is too long" });
		}
		const userId = req.session.user.id;
		const row = db.prepare("SELECT id, password_hash FROM users WHERE id = ?").get(userId);
		if (!row) return res.status(404).json({ error: "User not found" });
		const valid = await bcrypt.compare(currentPassword, row.password_hash);
		if (!valid) return res.status(401).json({ error: "Current password is incorrect" });
		const hash = await bcrypt.hash(newPassword, 10);
		db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, userId);

		// Invalidate every other session for this user. Connect-style session
		// stores serialize the session as JSON in the `sess` column, so we use
		// json_extract to match and delete. The current session is preserved
		// by matching on sid; we then rotate its ID via regenerate() below.
		const currentSid = req.sessionID;
		try {
			db.prepare(
				"DELETE FROM sessions WHERE json_extract(sess, '$.user.id') = ? AND sid != ?"
			).run(userId, currentSid);
		} catch (purgeErr) {
			console.error("change-password: session purge failed:", purgeErr.message);
		}

		// Rotate the current session ID so a previously captured cookie
		// (the pre-change one) no longer authenticates.
		const userSnapshot = { ...req.session.user };
		req.session.regenerate((regenErr) => {
			if (regenErr) {
				console.error("change-password: regenerate failed:", regenErr.message);
				return res.status(500).json({ error: "Password updated but session rotate failed. Please log out and back in." });
			}
			req.session.user = userSnapshot;
			req.session.save(() => res.json({ success: true }));
		});
	} catch (err) {
		console.error("change-password error:", err.message);
		res.status(500).json({ error: "Failed to change password" });
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

		logAudit(req, 'create_user', 'user', username, `Created user "${username}" with role ${role}`);
		notifyChange("users");
		res.json({ success: true });
	} catch (error) {
		console.error("Error creating user:", error.message);
		res.status(500).json({ error: error.message });
	}
});

// Admin: list all users (without password hashes)
app.get("/api/users", requireRole("Super Admin"), (req, res) => {
	const users = db
		.prepare(`SELECT u.id, u.username, u.role, u.driver_name, u.email, u.full_name, u.company_name, u.created_at, u.rating,
			do2.status AS onboarding_status
			FROM users u
			LEFT JOIN driver_onboarding do2 ON do2.user_id = u.id`)
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
			Rating: u.rating || 0,
			OnboardingStatus: u.onboarding_status || null,
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

		notifyChange("users");
		res.json({ success: true });
	} catch (error) {
		console.error("Error updating user:", error.message);
		res.status(500).json({ error: error.message });
	}
});

// Download SQLite database file (Super Admin only)
app.get("/api/db/download", requireRole("Super Admin"), (req, res) => {
	// Backup to a temp file to capture WAL contents
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

// Rate a driver (Super Admin only)
app.put("/api/users/:id/rating", requireRole("Super Admin"), (req, res) => {
	const id = parseInt(req.params.id);
	const { rating } = req.body;
	if (rating === undefined || rating < 0 || rating > 5) return res.status(400).json({ error: "Rating must be between 0 and 5" });
	const user = db.prepare("SELECT id, role FROM users WHERE id = ?").get(id);
	if (!user) return res.status(404).json({ error: "User not found" });
	if (user.role !== "Driver") return res.status(400).json({ error: "Only drivers can be rated" });
	db.prepare("UPDATE users SET rating = ? WHERE id = ?").run(parseFloat(rating), id);
	res.json({ success: true });
});

// Per-load rating: upsert
app.put("/api/load-ratings/:loadId", requireRole("Super Admin"), (req, res) => {
	const loadId = decodeURIComponent(req.params.loadId).trim();
	const { rating, driverName } = req.body;
	if (!rating || rating < 1 || rating > 5) return res.status(400).json({ error: "Rating must be 1-5" });
	if (!driverName) return res.status(400).json({ error: "Driver name required" });
	db.prepare(`
		INSERT INTO load_ratings (load_id, driver_name, rating, rated_by, updated_at)
		VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
		ON CONFLICT(load_id) DO UPDATE SET rating = excluded.rating, rated_by = excluded.rated_by, updated_at = CURRENT_TIMESTAMP
	`).run(loadId, driverName.trim(), rating, req.session.user.id);
	// Recompute driver average and update users.rating
	const avg = db.prepare("SELECT AVG(rating) as avg FROM load_ratings WHERE LOWER(driver_name) = LOWER(?)").get(driverName.trim());
	if (avg && avg.avg) {
		db.prepare("UPDATE users SET rating = ? WHERE LOWER(driver_name) = LOWER(?)").run(Math.round(avg.avg * 10) / 10, driverName.trim());
	}
	res.json({ success: true, loadRating: rating, averageRating: avg?.avg || rating });
});

// Per-load rating: get single
app.get("/api/load-ratings/:loadId", requireRole("Super Admin", "Dispatcher"), (req, res) => {
	const loadId = decodeURIComponent(req.params.loadId).trim();
	const row = db.prepare("SELECT rating FROM load_ratings WHERE load_id = ?").get(loadId);
	res.json({ rating: row ? row.rating : null });
});

// Per-load rating: bulk averages for all drivers
app.get("/api/load-ratings/averages", requireRole("Super Admin", "Dispatcher"), (req, res) => {
	const rows = db.prepare("SELECT LOWER(driver_name) as driver, AVG(rating) as average, COUNT(*) as count FROM load_ratings GROUP BY LOWER(driver_name)").all();
	const averages = {};
	rows.forEach(r => { averages[r.driver] = { average: Math.round(r.average * 10) / 10, count: r.count } });
	res.json({ averages });
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
	notifyChange("users");
	res.json({ success: true });
});

// List investor users (for owner dropdown)
app.get("/api/users/investors", requireRole("Super Admin", "Dispatcher"), (req, res) => {
	const investors = db
		.prepare("SELECT user_id AS id, full_name AS username, full_name AS CompanyName FROM investors ORDER BY full_name ASC")
		.all();
	res.json({ investors });
});

// ============================================================
// INVESTOR DATABASE — CRUD for investor profiles
// ============================================================

app.get("/api/investors", requireRole("Super Admin"), (req, res) => {
	const rows = db.prepare(`
		SELECT i.*, u.username FROM investors i
		LEFT JOIN users u ON u.id = i.user_id
		ORDER BY i.full_name ASC
	`).all();
	const investors = rows.map(r => ({
		id: r.id,
		userId: r.user_id,
		username: r.username || "",
		fullName: r.full_name,
		carrierName: r.carrier_name || "",
		status: r.status,
		notes: r.notes,
		createdAt: r.created_at,
		applicationId: r.application_id || 0,
		profilePictureUrl: r.profile_picture_url || "",
		truckCount: db.prepare("SELECT COUNT(*) as n FROM trucks WHERE owner_id = ?").get(r.user_id).n,
	}));
	res.json({ investors });
});

app.post("/api/investors", requireRole("Super Admin"), (req, res) => {
	const { userId, fullName, carrierName, status, notes, entityType, address, phone, email, einSsn, taxClassification, contactPerson, contactTitle } = req.body;
	if (!fullName || !fullName.trim()) return res.status(400).json({ error: "Full name is required" });
	const result = db.prepare(`
		INSERT INTO investors (user_id, full_name, carrier_name, status, notes, entity_type, address, phone, email, ein_ssn, tax_classification, contact_person, contact_title)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`).run(userId || null, fullName.trim(), (carrierName || "").trim(), status || "Active", (notes || "").trim(),
		(entityType || "").trim(), (address || "").trim(), (phone || "").trim(), (email || "").trim(),
		(einSsn || "").trim(), (taxClassification || "").trim(), (contactPerson || "").trim(), (contactTitle || "").trim());
	notifyChange("investors");
	res.json({ success: true, id: result.lastInsertRowid });
});

app.put("/api/investors/:id", requireRole("Super Admin"), (req, res) => {
	const { id } = req.params;
	const existing = db.prepare("SELECT * FROM investors WHERE id = ?").get(id);
	if (!existing) return res.status(404).json({ error: "Investor not found" });
	const { userId, fullName, carrierName, status, notes, entityType, address, phone, email, einSsn, taxClassification, contactPerson, contactTitle } = req.body;
	db.prepare(`
		UPDATE investors SET user_id=?, full_name=?, carrier_name=?, status=?, notes=?,
		entity_type=?, address=?, phone=?, email=?, ein_ssn=?, tax_classification=?, contact_person=?, contact_title=?
		WHERE id=?
	`).run(
		userId ?? existing.user_id, (fullName || existing.full_name).trim(), (carrierName || existing.carrier_name).trim(),
		status || existing.status, (notes ?? existing.notes).trim(),
		(entityType ?? existing.entity_type).trim(), (address ?? existing.address).trim(),
		(phone ?? existing.phone).trim(), (email ?? existing.email).trim(),
		(einSsn ?? existing.ein_ssn).trim(), (taxClassification ?? existing.tax_classification).trim(),
		(contactPerson ?? existing.contact_person).trim(), (contactTitle ?? existing.contact_title).trim(), id
	);
	notifyChange("investors");
	res.json({ success: true });
});

app.delete("/api/investors/:id", requireRole("Super Admin"), (req, res) => {
	const { id } = req.params;
	const existing = db.prepare("SELECT * FROM investors WHERE id = ?").get(id);
	if (!existing) return res.status(404).json({ error: "Investor not found" });
	// Cascade: unlink the profile picture from disk
	if (existing.profile_picture_url) {
		try {
			const picPath = path.join(__dirname, existing.profile_picture_url);
			if (fs.existsSync(picPath)) fs.unlinkSync(picPath);
		} catch (err) { console.error("Failed to unlink investor profile pic on cascade:", err.message); }
	}
	db.prepare("DELETE FROM investors WHERE id = ?").run(id);
	notifyChange("investors");
	res.json({ success: true });
});

// Check if a driver has an active load (returns error message or null)
async function checkDriverActiveLoad(driverName) {
	try {
		const sheets = await getSheets();
		const resp = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: "Job Tracking" });
		const rows = resp.data.values || [];
		if (rows.length < 2) return null;
		const headers = rows[0];
		const driverCol = headers.findIndex(h => /^driver$/i.test(h));
		const statusCol = headers.findIndex(h => /status/i.test(h));
		if (driverCol === -1 || statusCol === -1) return null;
		const activeRe = /^(assigned|dispatched|at shipper|loading|in transit|at receiver|unloading)$/i;
		for (let i = 1; i < rows.length; i++) {
			const r = rows[i];
			const driver = (r[driverCol] || "").trim().toLowerCase();
			const status = (r[statusCol] || "").trim();
			if (driver === driverName.trim().toLowerCase() && activeRe.test(status)) {
				const loadIdCol = headers.findIndex(h => /load.?id|job.?id/i.test(h));
				const loadId = loadIdCol !== -1 ? (r[loadIdCol] || "unknown") : "unknown";
				return `${driverName} has an active load (${loadId}, status: ${status}). Complete or cancel the load before reassigning.`;
			}
		}
		return null;
	} catch (err) {
		console.error("checkDriverActiveLoad error:", err.message);
		// Fail closed: if we cannot verify the driver is free, do NOT allow the
		// assignment. Throwing here propagates to the caller's outer catch which
		// returns HTTP 500, blocking the dispatch instead of silently permitting
		// double-dispatch on a Sheets API blip.
		throw new Error("Unable to verify driver availability — try again");
	}
}

// Truck Database: list all trucks (Investor sees only their own)
app.get("/api/trucks", requireRole("Super Admin", "Dispatcher", "Investor"), async (req, res) => {
	const user = req.session.user;
	let rows;
	if (user.role === "Investor") {
		rows = db.prepare("SELECT * FROM trucks WHERE owner_id = ? ORDER BY unit_number ASC").all(user.id);
	} else {
		rows = db.prepare("SELECT * FROM trucks ORDER BY unit_number ASC").all();
	}

	// Build completed-load counts per truck from the cached Job Tracking sheet.
	// Preferred match: exact truck column (populated by n8n). Fallback: match
	// the load's driver against the truck's assigned_driver. If the sheet
	// fetch fails, return 0 counts rather than failing the whole endpoint.
	let loadsByTruck = {};
	let loadsByDriver = {};
	try {
		const jt = await getJobTrackingCached();
		const statusCol = findCol(jt.headers, /status/i);
		const driverCol = findCol(jt.headers, /^driver$/i);
		const truckCol = findCol(jt.headers, /^truck$|truck[._\s-]?(unit|number|#)|unit[._\s-]?number/i);
		const completedRe = /^(delivered|completed|pod received)$/i;
		jt.data.forEach((r) => {
			const st = statusCol ? (r[statusCol] || "").trim() : "";
			if (!completedRe.test(st)) return;
			const driver = driverCol ? (r[driverCol] || "").trim().toLowerCase() : "";
			const truckUnit = truckCol ? (r[truckCol] || "").trim().toLowerCase() : "";
			if (truckUnit) loadsByTruck[truckUnit] = (loadsByTruck[truckUnit] || 0) + 1;
			if (driver) loadsByDriver[driver] = (loadsByDriver[driver] || 0) + 1;
		});
	} catch (err) {
		console.error("/api/trucks: job tracking fetch failed:", err.message);
	}

	const trucks = rows.map((t) => {
		const unitLower = (t.unit_number || "").toLowerCase();
		const driverLower = (t.assigned_driver || "").trim().toLowerCase();
		const directCount = loadsByTruck[unitLower];
		const loadCount = (directCount !== undefined)
			? directCount
			: (loadsByDriver[driverLower] || 0);
		return {
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
			TitleState: t.title_state || '',
			MaintenanceFundMonthly: t.maintenance_fund_monthly || 0,
			LoadCount: loadCount,
		};
	});
	res.json({ trucks });
});

// GET /api/truck-assignments — current active truck↔driver assignments
app.get("/api/truck-assignments", requireAuth, (req, res) => {
	try {
		const assignments = db.prepare(`
			SELECT ta.id, ta.truck_id, ta.driver_name, ta.start_date,
				t.unit_number, t.make, t.model, t.year
			FROM truck_assignments ta
			JOIN trucks t ON t.id = ta.truck_id
			WHERE ta.end_date = ''
			ORDER BY ta.start_date DESC
		`).all();
		res.json({ assignments });
	} catch (err) {
		res.status(500).json({ error: err.message });
	}
});

// Truck Database: add a new truck
app.post("/api/trucks", requireRole("Super Admin", "Dispatcher", "Investor"), async (req, res) => {
	try {
		const { unitNumber, make, model, year, vin, licensePlate, status, assignedDriver, notes, ownerId, driverPayDaily, purchasePrice, titleStatus, maintenanceFundMonthly } = req.body;
		// Investors auto-set owner_id to their own user ID
		let finalOwnerId = parseInt(ownerId) || 0;
		if (req.session.user.role === "Investor") {
			finalOwnerId = req.session.user.id;
		}
		if (!unitNumber || !unitNumber.trim()) {
			return res.status(400).json({ error: "Unit number is required" });
		}
		const existing = db.prepare("SELECT id FROM trucks WHERE LOWER(unit_number) = LOWER(?)").get(unitNumber.trim());
		if (existing) {
			return res.status(400).json({ error: "Unit number already exists" });
		}
		const validStatus = ["Active", "Inactive", "Maintenance", "OOS"].includes(status) ? status : "Active";
		// Check if driver has an active load before allowing assignment
		if (assignedDriver && assignedDriver.trim()) {
			const activeCheck = await checkDriverActiveLoad(assignedDriver.trim());
			if (activeCheck) return res.status(409).json({ error: activeCheck });
		}
		const result = db.prepare(
			"INSERT INTO trucks (unit_number, make, model, year, vin, license_plate, status, assigned_driver, notes, owner_id, driver_pay_daily, purchase_price, title_status, maintenance_fund_monthly) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
		).run(unitNumber.trim(), make || "", model || "", parseInt(year) || 0, vin || "", licensePlate || "", validStatus, assignedDriver || "", notes || "", finalOwnerId, parseFloat(driverPayDaily) || 0, parseFloat(purchasePrice) || 0, titleStatus || "Clean", parseFloat(maintenanceFundMonthly) || 0);
		// Create truck assignment record
		if (assignedDriver && assignedDriver.trim()) {
			assignDriverToTruck(result.lastInsertRowid, assignedDriver.trim());
		}
		notifyChange("trucks");
		res.json({ success: true, id: result.lastInsertRowid });
	} catch (error) {
		console.error("Error creating truck:", error.message);
		res.status(500).json({ error: error.message });
	}
});

// Truck Database: update a truck
app.put("/api/trucks/:id", requireRole("Super Admin", "Dispatcher"), async (req, res) => {
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
			// Check if driver has an active load before allowing reassignment
			if (assignedDriver && assignedDriver.trim() && assignedDriver.trim().toLowerCase() !== (truck.assigned_driver || "").trim().toLowerCase()) {
				const activeCheck = await checkDriverActiveLoad(assignedDriver.trim());
				if (activeCheck) return res.status(409).json({ error: activeCheck });
			}
			// Use the assignment helper (handles history + backward compat)
			assignDriverToTruck(id, assignedDriver || "");
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
		// Log driver assignment change to history + sync to Carrier Database sheet
		if (assignedDriver !== undefined) {
			const oldDriver = truck.assigned_driver;
			const newOwnerId = ownerId !== undefined ? parseInt(ownerId) || 0 : truck.owner_id;
			// Log to history if driver changed
			if (assignedDriver && assignedDriver.trim()) {
				syncDriverToCarrierSheet(assignedDriver.trim(), { action: "update" });
			}
			if (oldDriver && oldDriver.trim() && oldDriver.trim().toLowerCase() !== (assignedDriver || "").trim().toLowerCase()) {
				syncDriverToCarrierSheet(oldDriver.trim(), { action: "update" });
			}
		}
		notifyChange("trucks");
		res.json({ success: true });
	} catch (error) {
		console.error("Error updating truck:", error.message);
		res.status(500).json({ error: error.message });
	}
});

// GET /api/trucks/:id/driver-files — Files belonging to the driver assigned
// to this truck. Super Admin + Dispatcher only. Returns CDL front/back +
// medical card from the application, signed onboarding PDFs, and the drug
// test file URL.
//
// SECURITY notes:
// - Investor role is NOT allowed on this endpoint. Per 2026-04-13 client
//   feedback, investors should not see driver confidential files (CDL,
//   medical card, drug test, signed policies) even for trucks they own —
//   these are between the driver, dispatch, and Super Admin only.
// - Confidential onboarding docs (W-9, contractor agreement, NDA) are
//   filtered out — only non-confidential docs are returned.
// - signature_text is NOT returned: it is the driver's typed legal name
//   acting as their e-signature on legally binding docs. Non-admin
//   viewers see signed/unsigned status only.
// - SSN and driver's license number never flow through this endpoint.
// - Dedicated rate limiter (30/15min) prevents bulk enumeration of
//   base64-heavy document payloads.
const driverFilesLimiter = rateLimit({
	windowMs: 15 * 60 * 1000,
	max: 30,
	message: { error: "Too many requests. Try again later." },
	standardHeaders: true,
});
app.get("/api/trucks/:id/driver-files", requireRole("Super Admin", "Dispatcher"), driverFilesLimiter, (req, res) => {
	try {
		const id = parseInt(req.params.id);
		const truck = db.prepare("SELECT id, unit_number, assigned_driver, owner_id FROM trucks WHERE id = ?").get(id);
		if (!truck) return res.status(404).json({ error: "Truck not found" });
		const driverName = (truck.assigned_driver || "").trim();
		if (!driverName) {
			return res.json({ driverName: "", files: [], onboardingDocs: [], drugTest: null });
		}
		// Resolve driver_name → user_id → application_id to reach the uploaded files.
		const user = db.prepare("SELECT id, driver_name FROM users WHERE LOWER(driver_name) = LOWER(?) AND role = 'Driver'").get(driverName);
		if (!user) {
			return res.json({ driverName, files: [], onboardingDocs: [], drugTest: null });
		}
		const onboarding = db.prepare("SELECT application_id, drug_test_result, drug_test_file_url, drug_test_uploaded_at FROM driver_onboarding WHERE user_id = ?").get(user.id);
		const files = [];
		if (onboarding?.application_id) {
			const app = db.prepare("SELECT cdl_front, cdl_back, medical_card FROM job_applications WHERE id = ?").get(onboarding.application_id);
			if (app) {
				const mime = (b64) => {
					if (!b64) return null;
					if (b64.startsWith("data:application/pdf")) return "pdf";
					if (b64.startsWith("data:image/")) return "image";
					return null;
				};
				if (app.cdl_front) files.push({ label: "CDL Front", type: mime(app.cdl_front), data: app.cdl_front });
				if (app.cdl_back) files.push({ label: "CDL Back", type: mime(app.cdl_back), data: app.cdl_back });
				if (app.medical_card) files.push({ label: "Medical Card", type: mime(app.medical_card), data: app.medical_card });
			}
		}
		// Only non-confidential onboarding docs. Never expose signature_text.
		// Super Admin gets to see the full list via a different endpoint; this
		// one is scoped to what dispatchers legitimately need for operations.
		const onboardingDocs = db.prepare(
			"SELECT doc_key, doc_name, signed, signed_at, signed_pdf_url FROM onboarding_documents WHERE user_id = ? AND (confidential = 0 OR confidential IS NULL) ORDER BY id"
		).all(user.id);
		const drugTest = onboarding && onboarding.drug_test_result ? {
			result: onboarding.drug_test_result,
			file_url: onboarding.drug_test_file_url,
			uploaded_at: onboarding.drug_test_uploaded_at,
		} : null;
		res.json({ driverName, files, onboardingDocs, drugTest });
	} catch (err) {
		console.error("GET /api/trucks/:id/driver-files error:", err.message);
		res.status(500).json({ error: "Failed to load driver files" });
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
	notifyChange("trucks");
	res.json({ success: true });
});

// ============================================================
// TRAILERS CRUD
// ============================================================
app.get("/api/trailers", requireRole("Super Admin", "Dispatcher"), (req, res) => {
	try {
		const trailers = db.prepare(`
			SELECT t.*, tr.unit_number AS truck_number, tr.assigned_driver
			FROM trailers t
			LEFT JOIN trucks tr ON t.truck_id = tr.id
			ORDER BY t.created_at DESC
		`).all();
		res.json(trailers);
	} catch (err) {
		res.status(500).json({ error: err.message });
	}
});

app.post("/api/trailers", requireRole("Super Admin", "Dispatcher"), (req, res) => {
	try {
		const { trailer_number, type, length, year, vin, license_plate, status, truck_id, notes } = req.body;
		if (!trailer_number) return res.status(400).json({ error: "Trailer number is required" });
		const existing = db.prepare("SELECT id FROM trailers WHERE trailer_number = ?").get(trailer_number);
		if (existing) return res.status(409).json({ error: "Trailer number already exists" });
		// If assigning to a truck, check no other trailer is already on that truck
		if (truck_id) {
			const onTruck = db.prepare("SELECT id, trailer_number FROM trailers WHERE truck_id = ?").get(truck_id);
			if (onTruck) return res.status(409).json({ error: `Truck already has trailer ${onTruck.trailer_number} assigned` });
		}
		const result = db.prepare(`
			INSERT INTO trailers (trailer_number, type, length, year, vin, license_plate, status, truck_id, notes)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).run(trailer_number, type || 'Dry Van', length || '53', year || 0, vin || '', license_plate || '', status || 'Available', truck_id || null, notes || '');
		notifyChange("trailers");
		res.json({ success: true, id: result.lastInsertRowid });
	} catch (err) {
		res.status(500).json({ error: err.message });
	}
});

app.put("/api/trailers/:id", requireRole("Super Admin", "Dispatcher"), (req, res) => {
	try {
		const id = parseInt(req.params.id);
		const trailer = db.prepare("SELECT * FROM trailers WHERE id = ?").get(id);
		if (!trailer) return res.status(404).json({ error: "Trailer not found" });
		const { trailer_number, type, length, year, vin, license_plate, status, truck_id, notes } = req.body;
		// If changing truck assignment, check no other trailer is on that truck
		if (truck_id && truck_id !== trailer.truck_id) {
			const onTruck = db.prepare("SELECT id, trailer_number FROM trailers WHERE truck_id = ? AND id != ?").get(truck_id, id);
			if (onTruck) return res.status(409).json({ error: `Truck already has trailer ${onTruck.trailer_number} assigned` });
		}
		db.prepare(`
			UPDATE trailers SET trailer_number = ?, type = ?, length = ?, year = ?, vin = ?, license_plate = ?, status = ?, truck_id = ?, notes = ?
			WHERE id = ?
		`).run(
			trailer_number ?? trailer.trailer_number,
			type ?? trailer.type,
			length ?? trailer.length,
			year ?? trailer.year,
			vin ?? trailer.vin,
			license_plate ?? trailer.license_plate,
			status ?? trailer.status,
			truck_id === undefined ? trailer.truck_id : (truck_id || null),
			notes ?? trailer.notes,
			id
		);
		notifyChange("trailers");
		res.json({ success: true });
	} catch (err) {
		res.status(500).json({ error: err.message });
	}
});

app.delete("/api/trailers/:id", requireRole("Super Admin"), (req, res) => {
	try {
		const id = parseInt(req.params.id);
		const trailer = db.prepare("SELECT * FROM trailers WHERE id = ?").get(id);
		if (!trailer) return res.status(404).json({ error: "Trailer not found" });
		db.prepare("DELETE FROM trailers WHERE id = ?").run(id);
		notifyChange("trailers");
		res.json({ success: true });
	} catch (err) {
		res.status(500).json({ error: err.message });
	}
});

// Admin: bulk-rename a misspelled driver name in Job Tracking sheet
// GET /api/admin/audit-trail — View audit log
app.get("/api/admin/audit-trail", requireRole("Super Admin"), (req, res) => {
	const { limit = 100, entity, username } = req.query;
	let sql = "SELECT * FROM audit_trail";
	const conditions = [];
	const params = [];
	if (entity) { conditions.push("entity = ?"); params.push(entity); }
	if (username) { conditions.push("LOWER(username) = LOWER(?)"); params.push(username); }
	if (conditions.length) sql += " WHERE " + conditions.join(" AND ");
	sql += " ORDER BY id DESC LIMIT ?";
	params.push(parseInt(limit) || 100);
	const logs = db.prepare(sql).all(...params);
	res.json({ logs });
});

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

		// Also fix drivers_directory in SQLite
		db.prepare("UPDATE drivers_directory SET driver_name = ? WHERE LOWER(driver_name) = LOWER(?)").run(newName.trim(), oldName.trim());

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
			ranges: ["Job Tracking"],
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

// GET /api/archive — Read-only access to old/archived spreadsheet data
app.get("/api/archive", requireRole("Super Admin"), async (req, res) => {
	try {
		const sheets = await getSheets();
		const sheetName = req.query.sheet || "Job Tracking";
		const page = Math.max(1, parseInt(req.query.page) || 1);
		const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
		const search = (req.query.search || "").trim().toLowerCase();

		const resp = await sheets.spreadsheets.values.get({ spreadsheetId: ARCHIVE_SPREADSHEET_ID, range: sheetName });
		const rows = resp.data.values || [];
		if (rows.length < 1) return res.json({ headers: [], data: [], total: 0, page, limit });
		const headers = rows[0];
		let data = rows.slice(1).map((r, i) => {
			const obj = { _rowIndex: i + 2 };
			headers.forEach((h, j) => { obj[h] = r[j] || ""; });
			return obj;
		});

		// Search filter
		if (search) {
			data = data.filter(row => headers.some(h => (row[h] || "").toLowerCase().includes(search)));
		}

		const total = data.length;
		const start = (page - 1) * limit;
		const paged = data.slice(start, start + limit);
		res.json({ headers, data: paged, total, page, limit });
	} catch (err) {
		console.error("Archive read error:", err.message);
		res.status(500).json({ error: err.message });
	}
});

// GET /api/archive/tabs — List available tabs in the archive spreadsheet
app.get("/api/archive/tabs", requireRole("Super Admin"), async (req, res) => {
	try {
		const sheets = await getSheets();
		const meta = await sheets.spreadsheets.get({ spreadsheetId: ARCHIVE_SPREADSHEET_ID, fields: "sheets.properties.title" });
		const tabs = meta.data.sheets.map(s => s.properties.title);
		res.json({ tabs });
	} catch (err) {
		res.status(500).json({ error: err.message });
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

// POST /api/admin/backfill-road-distances — Populate distance_miles on
// load_coordinates via Google Routes API. Idempotent: skips rows that
// already have a non-null distance_miles value. Returns a progress report.
// Safe to call multiple times; re-running only hits the API for rows where
// backfill has not yet succeeded (so adding new loads later only costs the
// new rows). Rate-limited to ~5 QPS to stay well under Routes API quotas.
app.post("/api/admin/backfill-road-distances", requireRole("Super Admin"), async (req, res) => {
	try {
		const force = req.query.force === "1" || req.body?.force === true;
		const limit = Math.min(1000, parseInt(req.query.limit || req.body?.limit) || 500);
		const sql = force
			? "SELECT load_id, origin_lat, origin_lng, dest_lat, dest_lng FROM load_coordinates WHERE origin_lat IS NOT NULL AND dest_lat IS NOT NULL LIMIT ?"
			: "SELECT load_id, origin_lat, origin_lng, dest_lat, dest_lng FROM load_coordinates WHERE origin_lat IS NOT NULL AND dest_lat IS NOT NULL AND (distance_miles IS NULL OR distance_miles <= 0) LIMIT ?";
		const rows = db.prepare(sql).all(limit);
		if (rows.length === 0) {
			return res.json({ message: "Nothing to backfill — all coordinated loads already have road distance.", updated: 0, skipped: 0, failed: 0 });
		}
		const updateStmt = db.prepare("UPDATE load_coordinates SET distance_miles = ? WHERE load_id = ?");
		let updated = 0;
		let failed = 0;
		const errors = [];
		// Sequential with 200ms delay to stay under Google Routes quota.
		// 500 rows at 5/s = 100s max — acceptable for a one-time admin op.
		for (const r of rows) {
			const from = { latitude: r.origin_lat, longitude: r.origin_lng };
			const to = { latitude: r.dest_lat, longitude: r.dest_lng };
			try {
				const route = await getRoute(from, to);
				if (route && route.distanceMiles > 0) {
					updateStmt.run(route.distanceMiles, r.load_id);
					updated++;
				} else {
					failed++;
					errors.push({ load_id: r.load_id, reason: "no route found" });
				}
			} catch (err) {
				failed++;
				errors.push({ load_id: r.load_id, reason: err.message });
			}
			await new Promise(rs => setTimeout(rs, 200));
		}
		res.json({
			message: `Backfilled ${updated}/${rows.length} load_coordinates rows with road distance.`,
			updated,
			failed,
			errors: errors.slice(0, 20), // cap to keep response small
		});
	} catch (error) {
		console.error("Error in backfill-road-distances:", error.message);
		res.status(500).json({ error: "Failed to backfill road distances" });
	}
});

// Debug: check what the driver endpoint returns (first 2 loads)
app.get("/api/debug/driver-view/:driverName", requireRole("Super Admin"), async (req, res) => {
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
app.get("/api/debug/driver-empty/:driverName", requireRole("Super Admin"), async (req, res) => {
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
app.get("/api/debug/sample-row", requireRole("Super Admin"), async (req, res) => {
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
app.get("/api/debug/driver-loads/:driverName", requireRole("Super Admin"), async (req, res) => {
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
app.get("/api/debug/user/:username", requireRole("Super Admin"), (req, res) => {
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
		const { values, coordinates } = req.body; // values = array of cell values, coordinates = optional {loadId, originLat, originLng, destLat, destLng, pickupAddress, dropoffAddress}

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

		// Save coordinates to load_coordinates if provided
		if (sheetName === "Job Tracking" && coordinates && coordinates.loadId) {
			try {
				const lid = coordinates.loadId.trim().toLowerCase().replace(/^#/, "");
				db.prepare(`INSERT OR REPLACE INTO load_coordinates (load_id, origin_lat, origin_lng, dest_lat, dest_lng, pickup_address, dropoff_address) VALUES (?, ?, ?, ?, ?, ?, ?)`)
					.run(lid, coordinates.originLat || null, coordinates.originLng || null, coordinates.destLat || null, coordinates.destLng || null, coordinates.pickupAddress || "", coordinates.dropoffAddress || "");
			} catch { /* non-critical */ }
		}

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

// POST /api/webhook/new-load — Called by n8n after writing a load to Google Sheets.
// Emits a socket event so connected dashboards refresh instantly instead of waiting for the 60s poll.
app.post("/api/webhook/new-load", (req, res) => {
	const webhookSecret = process.env.N8N_WEBHOOK_SECRET;
	if (!webhookSecret || req.headers["x-webhook-secret"] !== webhookSecret) {
		return res.status(401).json({ error: "Unauthorized" });
	}
	jtCacheInvalidate();
	const loadId = req.body?.load_id || req.body?.loadId || "";
	const driver = req.body?.driver || "";
	insertDispatchNotification.run(
		"new-load",
		`New Load${loadId ? " " + loadId : ""}`,
		driver ? `Assigned to ${driver}` : "New load added from dispatch workflow",
		JSON.stringify({ loadId, driver, source: "n8n" })
	);
	io.to("dispatch").emit("new-load", { timestamp: Date.now() });
	io.to("dispatch").emit("dispatch-notification", { type: "new-load", title: `New Load${loadId ? " " + loadId : ""}`, body: driver ? `Assigned to ${driver}` : "New load added" });
	res.json({ ok: true });
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

		// Look up truck and owner for this driver
		const truckForDriver = db.prepare("SELECT unit_number, owner_id FROM trucks WHERE LOWER(assigned_driver) = LOWER(?)").get(driver.trim());
		const truckUnit = truckForDriver ? truckForDriver.unit_number : '';
		const ownerId = truckForDriver ? truckForDriver.owner_id : 0;

		// Ensure Truck and Owner ID columns exist in sheet
		let truckColIdx = headers.findIndex(h => /^truck$/i.test(h));
		let ownerColIdx = headers.findIndex(h => /^owner.?id$/i.test(h));
		if (truckColIdx === -1 || ownerColIdx === -1) {
			const newHeaders = [];
			if (truckColIdx === -1) { newHeaders.push('Truck'); truckColIdx = headers.length + newHeaders.length - 1; }
			if (ownerColIdx === -1) { newHeaders.push('Owner ID'); ownerColIdx = headers.length + newHeaders.length - 1; }
			if (newHeaders.length) {
				await sheets.spreadsheets.values.update({
					spreadsheetId: SPREADSHEET_ID,
					range: `Job Tracking!${colLetter(headers.length)}1`,
					valueInputOption: "USER_ENTERED",
					requestBody: { values: [newHeaders] },
				});
				headers.push(...newHeaders);
			}
		}

		// Batch update: driver, status, truck, owner ID
		const updates = [
			{ range: `Job Tracking!${colLetter(driverColIdx)}${rowIndex}`, values: [[driver]] },
		];
		if (statusColIdx !== -1) updates.push({ range: `Job Tracking!${colLetter(statusColIdx)}${rowIndex}`, values: [["Dispatched"]] });
		if (truckColIdx !== -1) updates.push({ range: `Job Tracking!${colLetter(truckColIdx)}${rowIndex}`, values: [[truckUnit]] });
		if (ownerColIdx !== -1) updates.push({ range: `Job Tracking!${colLetter(ownerColIdx)}${rowIndex}`, values: [[String(ownerId)]] });

		await sheets.spreadsheets.values.batchUpdate({
			spreadsheetId: SPREADSHEET_ID,
			requestBody: { valueInputOption: "USER_ENTERED", data: updates },
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

		logAudit(req, 'dispatch_load', 'load', loadId, `Assigned driver ${driver} to load ${loadId}`);
		notifyChange("dashboard"); jtCacheInvalidate();
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
		notifyChange("dashboard"); jtCacheInvalidate();
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
		notifyChange("dashboard"); jtCacheInvalidate();
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
		// Use shared 60s Job Tracking cache (invalidated by mutations) instead of
		// hitting Sheets on every dashboard load.
		const jobTracking = await getJobTrackingCached();
		const carrierDB = getCarrierDBFromSQLite();

		// Identify key columns
		const statusCol = findCol(jobTracking.headers, /status/i);
		const driverCol = findCol(jobTracking.headers, /driver/i);
		const loadIdCol = findCol(jobTracking.headers, /load.?id|job.?id/i);
		const delivDateCol = findCol(
			jobTracking.headers,
			/deliv|drop.?off.*date|completion.*date/i,
		);
		const jtPayCol = findCol(jobTracking.headers, /payment|rate|amount|pay/i);
		const carrierDriverCol =
			findCol(carrierDB.headers, /driver/i) || carrierDB.headers[0];
		const truckCol = findCol(carrierDB.headers, /truck|unit|vehicle/i);

		// Status patterns
		const activeStatuses =
			/^(in transit|dispatched|assigned|picked up|at shipper|at receiver|loading|unloading)$/i;
		const completedStatuses = /^(delivered|completed|pod received)$/i;
		const canceledStatuses = /^(cancel|canceled|cancelled)$/i;
		const unassignedStatuses =
			/^(unassigned|new|open|pending|available)$/i;

		// Filter jobs — only rows with a Load ID
		const hasLoadId = (r) => loadIdCol ? !!(r[loadIdCol] || "").trim() : true;
		const activeJobs = jobTracking.data.filter(
			(r) => hasLoadId(r) && statusCol && activeStatuses.test((r[statusCol] || "").trim()),
		);
		const unassignedJobs = jobTracking.data.filter((r) => {
			if (!hasLoadId(r)) return false;
			const status = statusCol ? (r[statusCol] || "").trim() : "";
			if (activeStatuses.test(status) || completedStatuses.test(status) || canceledStatuses.test(status)) return false;
			return unassignedStatuses.test(status) || !status;
		});
		const completedJobs = jobTracking.data.filter(
			(r) =>
				hasLoadId(r) &&
				statusCol &&
				completedStatuses.test((r[statusCol] || "").trim()),
		);

		// Sort completed jobs by most recent first
		const sortDateCol = findCol(jobTracking.headers, /completion.*date|status.*update.*date|drop.?off.*date|assigned.*date/i);
		if (sortDateCol) {
			completedJobs.sort((a, b) => {
				const da = new Date((a[sortDateCol] || '').replace(/^Date:\s*/i, '').trim());
				const db2 = new Date((b[sortDateCol] || '').replace(/^Date:\s*/i, '').trim());
				const ta = isNaN(da) ? 0 : da.getTime();
				const tb = isNaN(db2) ? 0 : db2.getTime();
				return tb - ta;
			});
		}

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

		// Fleet utilization — mirror the /trucks page: total = every truck in the
		// fleet (all statuses), assigned = any truck with a driver. Previous logic
		// excluded Inactive/OOS trucks and conflated drivers_directory rows with
		// trucks, producing "0/0" when the real fleet had Inactive rows.
		const totalTrucks = db.prepare("SELECT COUNT(*) AS cnt FROM trucks").get().cnt;
		const assignedTrucks = db.prepare(
			"SELECT COUNT(*) AS cnt FROM trucks WHERE TRIM(assigned_driver) != ''"
		).get().cnt;

		// Revenue
		function parseAmount(str) {
			return (
				parseFloat(String(str || "0").replace(/[$,]/g, "")) || 0
			);
		}
		// Revenue — only count rows that map to one of the three dashboard
		// buckets (completed, active, unassigned/empty). Canceled and
		// uncategorized rows (status matches none of the four regexes) are
		// excluded from all three totals so the cards match the breakdown
		// modal content exactly.
		let revTotal = 0,
			revPaid = 0,
			revPending = 0;
		jobTracking.data.filter(hasLoadId).forEach((r) => {
			const amt = parseAmount(jtPayCol ? r[jtPayCol] : 0);
			if (!amt) return;
			const status = statusCol ? (r[statusCol] || "").trim() : "";
			if (completedStatuses.test(status)) {
				revTotal += amt;
				revPaid += amt;
			} else if (activeStatuses.test(status) || unassignedStatuses.test(status) || !status) {
				revTotal += amt;
				revPending += amt;
			}
		});

		// Driver list for dispatch dropdown — only active drivers (pending = awaiting drug test, inactive = disabled)
		const driverMap = new Map();
		carrierDB.data.forEach((r) => {
			const name = (r[carrierDriverCol] || "").trim();
			const status = (r["Status"] || "active").toLowerCase();
			if (name && status === "active" && !driverMap.has(name.toLowerCase())) driverMap.set(name.toLowerCase(), name);
		});
		const driverList = [...driverMap.values()].sort();

		// Fleet details
		const fleet = carrierDB.data.map((r) => {
			const name = (r[carrierDriverCol] || "").trim();
			const nameLower = name.toLowerCase();
			const currentLoad = activeJobs.find(
				(j) =>
					driverCol && (j[driverCol] || "").trim().toLowerCase() === nameLower,
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
				CompletedLoads: completedJobs.filter((j) => {
					return driverCol && (j[driverCol] || "").trim().toLowerCase() === nameLower;
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
		const respCompleted = req.session.user.role !== "Super Admin"
			? sanitizeBrokerColumns(jobTracking.headers, completedJobs)
			: completedJobs;

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
			completedHeaders: jobTracking.headers,
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
	// Track last (most recent) index per load ID — bottom row wins
	const lastIndex = new Map();
	for (let i = 0; i < data.length; i++) {
		const lid = (data[i][loadIdCol] || "").trim().toLowerCase().replace(/^#/, "");
		if (!lid) continue;
		lastIndex.set(lid, i); // overwrite keeps the last occurrence
	}
	const keepSet = new Set(lastIndex.values());
	const duplicates = [];
	const filtered = [];
	for (let i = 0; i < data.length; i++) {
		const lid = (data[i][loadIdCol] || "").trim().toLowerCase().replace(/^#/, "");
		if (!lid) { filtered.push(data[i]); continue; }
		if (keepSet.has(i)) filtered.push(data[i]);
		else duplicates.push(data[i]);
	}
	if (!returnDuplicates) return filtered;
	return { data: filtered, duplicates };
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
			ranges: ["Job Tracking"],
		});

		const rangeData = response.data.valueRanges || [];
		const jobTracking = parseSheet(rangeData[0]);
		jobTracking.data = deduplicateLoads(jobTracking.data, jobTracking.headers);
		const carrierDB = getCarrierDBFromSQLite();

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

		// Onboarding data (if driver has an onboarding record).
		// IMPORTANT: drivers must NOT see their own drug test result — legal
		// requirement. We explicitly enumerate the columns returned here and
		// omit drug_test_result / drug_test_file_url / drug_test_uploaded_at.
		// Super Admin / Dispatcher still sees them via /api/drivers-directory/:id/documents.
		const userId = req.session.user.id;
		const onboarding = db.prepare(
			"SELECT id, user_id, application_id, driver_name, status, onboarded_at, created_at FROM driver_onboarding WHERE user_id = ?"
		).get(userId) || null;
		const onboardingDocs = onboarding
			? db.prepare("SELECT * FROM onboarding_documents WHERE user_id = ? ORDER BY id").all(userId)
			: [];
		// Also fetch the original application so the driver Kit can display
		// the documents and qualifications the applicant submitted. SSN is
		// stripped; drivers_license and CDL/medical uploads are kept — the
		// driver is allowed to see their own license and uploaded documents.
		let application = null;
		if (onboarding?.application_id) {
			const fullApp = db.prepare("SELECT * FROM job_applications WHERE id = ?").get(onboarding.application_id);
			if (fullApp) {
				const { ssn: _drop, ...safeApp } = fullApp;
				application = safeApp;
			}
		}
		// Recent invoices
		const driverInvoices = db.prepare(
			`SELECT id, invoice_number, week_start, week_end, loads_count, total_earnings, expenses_total, status, submitted_at, created_at
			 FROM invoices WHERE LOWER(driver) = ? ORDER BY created_at DESC LIMIT 20`
		).all(nameLower);

		// Shared documents — files Super Admin uploaded to this driver via /drivers detail modal.
		// Lookup keyed on drivers_directory.id (resolved by driver_name). Guard against id=0 sentinel
		// collision so drivers without a directory row return [] instead of every truck/investor doc.
		let sharedDocuments = [];
		let profilePictureUrl = "";
		let driverDirectoryId = 0;
		const directoryRow = db.prepare("SELECT id, profile_picture_url FROM drivers_directory WHERE LOWER(driver_name) = ?").get(nameLower);
		if (directoryRow && directoryRow.id > 0) {
			driverDirectoryId = directoryRow.id;
			profilePictureUrl = directoryRow.profile_picture_url || "";
			sharedDocuments = db.prepare(
				`SELECT id, doc_type, file_name, notes, uploaded_by, uploaded_at
				 FROM legal_documents WHERE driver_id = ? ORDER BY uploaded_at DESC`
			).all(directoryRow.id);
		}

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
			onboarding: onboarding ? {
				...onboarding,
				documents: onboardingDocs,
				totalDocs: ONBOARDING_DOCS.length,
			} : null,
			application,
			invoices: driverInvoices,
			sharedDocuments,
			profilePictureUrl,
			driverDirectoryId,
		});
	} catch (error) {
		console.error("Error fetching driver data:", error.message);
		res.status(500).json({ error: error.message });
	}
});

// GET /api/driver/shared-documents/:id/download — Proxy download for driver shared docs
// Ownership check: the requesting user must be the driver the document was uploaded to (or Super Admin).
// Matches the invoice/investor signed-PDF proxy pattern. This is the only path drivers use to access
// their files — the raw /uploads/legal/* route is protected by requireAuth but not by ownership,
// so we deliberately don't expose the raw file_url to the driver's frontend.
app.get("/api/driver/shared-documents/:id/download", requireAuth, (req, res) => {
	try {
		const docId = parseInt(req.params.id);
		if (!docId || docId <= 0) return res.status(400).json({ error: "Invalid document id" });
		const doc = db.prepare("SELECT * FROM legal_documents WHERE id = ?").get(docId);
		if (!doc) return res.status(404).json({ error: "Document not found" });
		if (!doc.driver_id || doc.driver_id <= 0) {
			return res.status(404).json({ error: "Not a driver shared document" });
		}
		const sessionUser = req.session.user;
		if (sessionUser.role !== "Super Admin") {
			// Ownership check: session user must be the driver this doc was uploaded to
			const driverRow = db.prepare("SELECT driver_name FROM drivers_directory WHERE id = ?").get(doc.driver_id);
			if (!driverRow) return res.status(403).json({ error: "Forbidden" });
			const sessionDriver = (sessionUser.driver_name || sessionUser.driverName || "").trim().toLowerCase();
			if (!sessionDriver || sessionDriver !== (driverRow.driver_name || "").trim().toLowerCase()) {
				return res.status(403).json({ error: "Forbidden" });
			}
		}
		if (!doc.file_url) return res.status(404).json({ error: "File missing" });
		const filePath = path.join(__dirname, doc.file_url);
		if (!fs.existsSync(filePath)) return res.status(404).json({ error: "File missing" });
		res.sendFile(filePath);
	} catch (err) {
		console.error("Shared doc download error:", err.message);
		res.status(500).json({ error: err.message });
	}
});

// PUT /api/driver/status — Update load status
app.put("/api/driver/status", requireAuth, async (req, res) => {
	try {
		let { rowIndex, driverName, loadId, newStatus, rowData } = req.body;
		const sheets = await getSheets();

		// Read entire sheet to verify exact row
		const allSheetRes = await sheets.spreadsheets.values.get({
			spreadsheetId: SPREADSHEET_ID,
			range: "Job Tracking",
		});
		const allRows = (allSheetRes.data.values || []);
		const headers = allRows[0] || [];
		const dataRows = allRows.slice(1);

		const statusIdx = headers.findIndex((h) => /status/i.test(h));
		const dateIdx = headers.findIndex((h) => /status.*update.*date|update.*date/i.test(h));
		const loadIdIdx = headers.findIndex((h) => /load.?id|job.?id/i.test(h));

		if (statusIdx === -1) {
			return res.status(400).json({ error: "Status column not found in sheet" });
		}

		// Helper: check if a sheet row matches the frontend rowData on all columns
		function rowMatchesData(sheetRow) {
			if (!rowData || !sheetRow) return false;
			for (let c = 0; c < headers.length; c++) {
				const col = headers[c];
				if (!col) continue;
				const expected = (rowData[col] != null ? String(rowData[col]) : "").trim();
				const actual = (sheetRow[c] || "").trim();
				if (expected && expected !== actual) return false;
			}
			return true;
		}

		// Step 1: verify row at given rowIndex matches all column data
		const rowAtIndex = dataRows[rowIndex - 2] || [];
		if (rowData && !rowMatchesData(rowAtIndex)) {
			// Step 2: scan all rows to find the exact match
			let foundRow = -1;
			for (let i = dataRows.length - 1; i >= 0; i--) {
				if (rowMatchesData(dataRows[i])) { foundRow = i + 2; break; }
			}
			if (foundRow === -1) {
				// Step 3: fallback to Load ID match (last row with that ID)
				if (loadId && loadIdIdx !== -1) {
					const targetLid = loadId.toString().trim().toLowerCase().replace(/^#/, "");
					for (let i = dataRows.length - 1; i >= 0; i--) {
						const lid = (dataRows[i][loadIdIdx] || "").trim().toLowerCase().replace(/^#/, "");
						if (lid === targetLid) { foundRow = i + 2; break; }
					}
				}
				if (foundRow === -1) {
					return res.status(404).json({ error: `Could not find exact row for Load ID ${loadId}` });
				}
			}
			rowIndex = foundRow;
		}

		// Enforce one active job at a time: block transition to "At Shipper" if another load is active
		if (/^at shipper$/i.test(newStatus)) {
			const driverCol = headers.findIndex((h) => /driver/i.test(h));
			if (driverCol !== -1) {
				const activeRe = /^(at shipper|loading|in transit|at receiver)$/i;
				const hasActive = dataRows.some((row, i) => {
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

		// Read verified row to get old status for logging
		const currentRow = dataRows[rowIndex - 2] || [];
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
		// Write Completion Date when status is a completed status
		if (/^(delivered|completed|pod received)$/i.test(newStatus)) {
			const compDateIdx = headers.findIndex((h) => /completion.*date/i.test(h));
			if (compDateIdx !== -1) {
				updateData.push({ range: `Job Tracking!${colLetter(compDateIdx)}${rowIndex}`, values: [[dateTime]] });
			}
		}

		await sheets.spreadsheets.values.batchUpdate({
			spreadsheetId: SPREADSHEET_ID,
			requestBody: {
				valueInputOption: "USER_ENTERED",
				data: updateData,
			},
		});

		// Notify dispatch in real-time
		jtCacheInvalidate();
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

		logAudit(req, 'update_status', 'load', loadId, `Status changed to "${newStatus}" for load ${loadId} (driver: ${driverName})`);
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
					`SELECT id, timestamp, "from", "to", message, load_id AS loadId, read, attachment_url, attachment_type
					 FROM messages
					 WHERE (LOWER("from") = ? OR LOWER("to") = ?) AND load_id = ?
					 ORDER BY id ASC`,
				)
				.all(nameLower, nameLower, loadId);
		} else {
			messages = db
				.prepare(
					`SELECT id, timestamp, "from", "to", message, load_id AS loadId, read, attachment_url, attachment_type
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

// Receipt photo storage helpers — write base64 data URIs to disk and return
// the URL path. Old base64-in-DB rows still work because the frontend img tag
// accepts both data URIs and URL paths.
const RECEIPTS_DIR = path.join(__dirname, "uploads", "expense-receipts");
try { fs.mkdirSync(RECEIPTS_DIR, { recursive: true }); } catch {}
function saveReceiptToDisk(photoData) {
	if (!photoData || typeof photoData !== "string") return "";
	if (!photoData.startsWith("data:")) return photoData; // already a URL/path
	const m = photoData.match(/^data:image\/(\w+);base64,(.+)$/);
	if (!m) return ""; // unrecognized format — drop silently
	const ext = (m[1] || "png").toLowerCase().replace("jpeg", "jpg");
	const buf = Buffer.from(m[2], "base64");
	const fname = `${Date.now()}-${crypto.randomBytes(6).toString("hex")}.${ext}`;
	const fpath = path.join(RECEIPTS_DIR, fname);
	try {
		fs.writeFileSync(fpath, buf);
		return `/uploads/expense-receipts/${fname}`;
	} catch (err) {
		console.error("Receipt save failed:", err.message);
		return ""; // fall back to no photo rather than blob in DB
	}
}

// POST /api/expenses — Log a new expense (SQLite)
app.post("/api/expenses", requireAuth, (req, res) => {
	try {
		const { driver, loadId, type, amount, description, date, photoData, gallons, odometer } =
			req.body;
		if (!driver || !type || !amount || !date) {
			return res.status(400).json({ error: "Missing required fields" });
		}
		// Ownership: Drivers can only submit their own expenses; Investors cannot submit at all
		const userRole = req.session.user.role;
		if (userRole === "Driver") {
			if (driver.trim().toLowerCase() !== (req.session.user.driverName || "").trim().toLowerCase()) {
				return res.status(403).json({ error: "Drivers can only submit their own expenses" });
			}
		} else if (userRole === "Investor") {
			return res.status(403).json({ error: "Investors cannot submit expenses" });
		}
		const VALID_EXPENSE_TYPES = ['Fuel', 'Repair', 'Maintenance', 'Wear & Tear', 'Toll', 'Food', 'Other'];
		if (!VALID_EXPENSE_TYPES.includes(type)) {
			return res.status(400).json({ error: "Invalid expense type" });
		}
		// Validate amount: must be positive number under 1M
		const parsedAmount = parseFloat(amount);
		if (isNaN(parsedAmount) || parsedAmount <= 0 || parsedAmount > 1_000_000) {
			return res.status(400).json({ error: "Amount must be a positive number under 1,000,000" });
		}
		// Sanitize free-text fields
		const safeDescription = (description || "").toString().slice(0, 500);
		const safeLoadId = (loadId || "").toString().slice(0, 100);

		const timestamp = new Date().toISOString();
		// Look up truck/owner for this driver to stamp on expense
		const driverTruck = db.prepare("SELECT unit_number, owner_id FROM trucks WHERE LOWER(assigned_driver) = LOWER(?)").get(driver.trim());
		const expOwnerId = driverTruck ? driverTruck.owner_id : 0;
		const expTruckUnit = driverTruck ? driverTruck.unit_number : '';
		// Receipt photo: write base64 to disk, store URL path in column instead of blob
		const photoUrlOrPath = saveReceiptToDisk(photoData);
		const result = db
			.prepare(
				`INSERT INTO expenses (timestamp, driver, load_id, type, amount, description, date, photo_data, gallons, odometer, owner_id, truck_unit)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(timestamp, driver, safeLoadId, type, parsedAmount, safeDescription, date, photoUrlOrPath,
				parseFloat(gallons) || 0, parseFloat(odometer) || 0, expOwnerId, expTruckUnit);
		notifyChange("expenses");
		res.json({ success: true, id: result.lastInsertRowid });
	} catch (error) {
		console.error("Error logging expense:", error.message);
		res.status(500).json({ error: "Failed to log expense" });
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

// GET /api/legal-documents — Legal docs for investor's trucks or driver shared docs
app.get("/api/legal-documents", requireRole("Super Admin", "Investor"), (req, res) => {
	try {
		const user = req.session.user;
		const isSuperAdmin = user.role === "Super Admin";
		let truckId = req.query.truckId ? parseInt(req.query.truckId) : null;
		if (!truckId && req.query.unit_number) {
			const t = db.prepare("SELECT id FROM trucks WHERE LOWER(unit_number) = LOWER(?)").get(req.query.unit_number.trim());
			if (t) truckId = t.id;
		}
		// Super Admin viewing a specific driver's shared docs — guard against driver_id=0 sentinel collision
		const queryDriverId = req.query.driver_id ? parseInt(req.query.driver_id) : null;
		if (isSuperAdmin && queryDriverId && queryDriverId > 0) {
			const driverDocs = db.prepare(
				`SELECT ld.* FROM legal_documents ld WHERE ld.driver_id = ? ORDER BY ld.uploaded_at DESC`
			).all(queryDriverId);
			return res.json({ documents: driverDocs });
		}
		let docs;
		if (isSuperAdmin) {
			const queryInvId = req.query.investor_id ? parseInt(req.query.investor_id) : null;
			if (queryInvId) {
				// Super Admin viewing a specific investor's docs (profile + truck)
				const invUserId = db.prepare("SELECT user_id FROM investors WHERE id = ?").get(queryInvId);
				const owned = invUserId ? db.prepare("SELECT id FROM trucks WHERE owner_id = ?").all(invUserId.user_id).map(t => t.id) : [];
				const conditions = [`ld.investor_id = ?`];
				const params = [queryInvId];
				if (owned.length > 0) {
					conditions.push(`ld.truck_id IN (${owned.map(() => '?').join(',')})`);
					params.push(...owned);
				}
				docs = db.prepare(`SELECT ld.*, t.make, t.model FROM legal_documents ld LEFT JOIN trucks t ON t.id = ld.truck_id WHERE (${conditions.join(' OR ')}) ORDER BY ld.uploaded_at DESC`).all(...params);
			} else if (truckId) {
				docs = db.prepare(`SELECT ld.*, t.make, t.model FROM legal_documents ld LEFT JOIN trucks t ON t.id = ld.truck_id WHERE ld.truck_id = ? ORDER BY ld.uploaded_at DESC`).all(truckId);
			} else {
				docs = db.prepare(`SELECT ld.*, t.make, t.model FROM legal_documents ld LEFT JOIN trucks t ON t.id = ld.truck_id ORDER BY ld.uploaded_at DESC`).all();
			}
		} else {
			const inv = db.prepare("SELECT id FROM investors WHERE user_id = ?").get(user.id);
			const invId = inv ? inv.id : 0;
			const owned = db.prepare("SELECT id FROM trucks WHERE owner_id = ?").all(user.id).map(t => t.id);
			if (owned.length === 0 && !invId) return res.json({ documents: [] });
			// Get truck docs + investor-profile docs
			const conditions = [];
			const params = [];
			if (owned.length > 0) {
				conditions.push(`ld.truck_id IN (${owned.map(() => '?').join(',')})`);
				params.push(...owned);
			}
			if (invId) {
				conditions.push(`ld.investor_id = ?`);
				params.push(invId);
			}
			const where = conditions.length > 0 ? `WHERE (${conditions.join(' OR ')})` : '';
			docs = db.prepare(`SELECT ld.*, t.make, t.model FROM legal_documents ld LEFT JOIN trucks t ON t.id = ld.truck_id ${where} ORDER BY ld.uploaded_at DESC`).all(...params);
		}
		res.json({ documents: docs });
	} catch (err) {
		console.error("Error fetching legal documents:", err.message);
		res.status(500).json({ error: err.message });
	}
});

// POST /api/legal-documents/upload — Super Admin or Investor uploads a legal doc
app.post("/api/legal-documents/upload", requireRole("Super Admin", "Investor"), async (req, res) => {
	try {
		const { truckId, unitNumber, docType, fileData, fileName, notes, investorId, driverId } = req.body;
		if (!fileData || !fileName) {
			return res.status(400).json({ error: "fileData and fileName are required" });
		}
		if (fileData.length > 13_500_000) {
			return res.status(400).json({ error: "File too large (max 10MB)" });
		}
		if (!validateFileExt(fileName)) return res.status(400).json({ error: "File type not allowed" });
		const validTypes = ['Title','Vehicle Title','Registration','Insurance Certificate','Insurance COI','Lease Agreement','Bill of Sale','Inspection Report','IFTA License','Maintenance Records','Photo','Contract','Tax Document','Compliance','Driver\'s License','Medical Card','ID Card','Other'];
		const safeType = validTypes.includes(docType) ? docType : 'Other';
		const ext = path.extname(fileName) || '.pdf';
		// Prefix filename with driver- or truck identifier depending on mode (for easier forensics in the uploads dir)
		const drvId = parseInt(driverId) || 0;
		const prefix = drvId > 0 ? `driver${drvId}` : (unitNumber || 'truck').replace(/[^a-zA-Z0-9]/g, '_');
		const safeName = `${prefix}_${safeType.replace(/[\s']/g, '_')}_${Date.now()}${ext}`;
		const legalDir = path.join(__dirname, "uploads", "legal");
		if (!fs.existsSync(legalDir)) fs.mkdirSync(legalDir, { recursive: true });
		const base64 = fileData.replace(/^data:[^;]+;base64,/, "");
		fs.writeFileSync(path.join(legalDir, safeName), Buffer.from(base64, "base64"));
		const fileUrl = `/uploads/legal/${safeName}`;
		// Determine investor_id: from request body or from session (if Investor role)
		let invId = parseInt(investorId) || 0;
		if (req.session.user.role === "Investor" && !invId) {
			const inv = db.prepare("SELECT id FROM investors WHERE user_id = ?").get(req.session.user.id);
			if (inv) invId = inv.id;
		}
		// Driver-mode uploads MUST NOT also be tagged with truck/investor IDs
		const finalTruckId = drvId > 0 ? 0 : (parseInt(truckId) || 0);
		const finalInvId = drvId > 0 ? 0 : invId;
		const finalUnit = drvId > 0 ? '' : (unitNumber || '');
		const result = db.prepare(
			`INSERT INTO legal_documents (truck_id, unit_number, doc_type, file_name, file_url, notes, uploaded_by, investor_id, driver_id) VALUES (?,?,?,?,?,?,?,?,?)`
		).run(finalTruckId, finalUnit, safeType, fileName, fileUrl, notes || '', req.session.user.username, finalInvId, drvId);
		res.json({ success: true, id: result.lastInsertRowid, fileUrl });
	} catch (err) {
		console.error("Legal doc upload error:", err.message);
		res.status(500).json({ error: err.message });
	}
});

// DELETE /api/legal-documents/:id — Super Admin or owner removes a legal doc
app.delete("/api/legal-documents/:id", requireRole("Super Admin", "Investor"), (req, res) => {
	try {
		const id = parseInt(req.params.id);
		const doc = db.prepare("SELECT * FROM legal_documents WHERE id = ?").get(id);
		if (!doc) return res.status(404).json({ error: "Document not found" });
		if (doc.file_url) {
			const filePath = path.join(__dirname, doc.file_url);
			try { fs.unlinkSync(filePath); } catch { /* file may already be gone */ }
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
		if (!validateFileExt(fileName)) return res.status(400).json({ error: "File type not allowed" });
		const attachmentType = (mimeType || '').startsWith('image/') ? 'image' : (mimeType === 'application/pdf' ? 'pdf' : 'other');
		const ext = path.extname(fileName) || (attachmentType === 'image' ? '.jpg' : '.bin');
		const safeName = `chat_${Date.now()}_${Math.random().toString(36).slice(2,7)}${ext}`;
		const chatDir = path.join(__dirname, "uploads", "chat");
		if (!fs.existsSync(chatDir)) fs.mkdirSync(chatDir, { recursive: true });
		const base64 = fileData.replace(/^data:[^;]+;base64,/, "");
		fs.writeFileSync(path.join(chatDir, safeName), Buffer.from(base64, "base64"));
		res.json({ success: true, fileUrl: `/uploads/chat/${safeName}`, attachmentType });
	} catch (err) {
		console.error("Chat attachment error:", err.message);
		res.status(500).json({ error: err.message });
	}
});

// GET /api/investor/onboarding-documents — Investor's signed onboarding docs (Master Agreement, Vehicle Lease, W-9)
app.get("/api/investor/onboarding-documents", requireRole("Super Admin", "Investor"), (req, res) => {
	try {
		const user = req.session.user;
		let investor;
		if (user.role === "Super Admin" && req.query.investor_id) {
			investor = db.prepare("SELECT application_id FROM investors WHERE id = ?").get(parseInt(req.query.investor_id));
		} else {
			investor = db.prepare("SELECT application_id FROM investors WHERE user_id = ?").get(user.id);
		}
		if (!investor || !investor.application_id) return res.json({ documents: [] });
		const docs = db.prepare("SELECT doc_key, doc_name, signed, signature_text, signed_at, signed_pdf_url FROM investor_onboarding_documents WHERE application_id = ? ORDER BY id").all(investor.application_id);
		res.json({ documents: docs });
	} catch (err) {
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
			const cdb = getCarrierDBFromSQLite();
			const cDriverCol = findCol(cdb.headers, /driver/i) || cdb.headers[0];
			const cCarrierCol = findCol(cdb.headers, /carrier/i);
			const driverSet = getInvestorDriverSet(user.id, cdb.data, cDriverCol, cCarrierCol);
			if (driverSet.size === 0) return res.json({ documents: [] });
			const drivers = [...driverSet];
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
		const purchasePrice = parseFloat(config.truck_purchase_price || config.purchase_price) || 58000;
		const totalTrucks = isSuperAdmin
			? db.prepare("SELECT COUNT(*) AS cnt FROM trucks").get().cnt
			: db.prepare("SELECT COUNT(*) AS cnt FROM trucks WHERE owner_id = ?").get(user.id).cnt;
		const totalPurchasePrice = purchasePrice * totalTrucks;
		const totalStartupExpenses = 5000 * totalTrucks;
		const section179 = purchasePrice;
		const annualDepreciation = purchasePrice;

		// Net revenue — must succeed; we refuse to fabricate financial figures
		let netRevenueToDate = 0;
		try {
			const sheets = await getSheets();
			const rng = await sheets.spreadsheets.values.batchGet({ spreadsheetId: SPREADSHEET_ID, ranges: ["Job Tracking"] });
			const jt = parseSheet(rng.data.valueRanges[0]);
			const cdb = parseSheet(rng.data.valueRanges[1]);
			const cDriverCol = findCol(cdb.headers, /driver/i) || cdb.headers[0];
			const cCarrierCol = findCol(cdb.headers, /carrier/i);
			const jtRateCol = findCol(jt.headers, /rate|amount|revenue|pay|charge|price|cost/i);
			const jtDriverCol = findCol(jt.headers, /driver/i);
			let totalRevenue = 0;
			let driverSet = null;
			const taxOwnerId = !isSuperAdmin ? user.id : null;
			if (!isSuperAdmin) {
				driverSet = getInvestorDriverSet(user.id, cdb.data, cDriverCol, cCarrierCol);
			}
			const taxOwnerIdCol = findCol(jt.headers, /^owner.?id$/i);
			jt.data.forEach(r => {
				if (driverSet) {
					let match = false;
					if (taxOwnerIdCol && parseInt(r[taxOwnerIdCol]) === taxOwnerId) match = true;
					if (!match && jtDriverCol) {
						const d = (r[jtDriverCol] || "").trim().toLowerCase();
						if (driverSet.has(d)) match = true;
					}
					if (!match) return;
				}
				if (jtRateCol) totalRevenue += parseFloat(String(r[jtRateCol] || "0").replace(/[$,]/g, "")) || 0;
			});
			const expClause = isSuperAdmin
				? db.prepare("SELECT COALESCE(SUM(amount),0) AS t FROM expenses").get().t
				: (() => {
					const drivers = [...getInvestorDriverSet(user.id, cdb.data, cDriverCol, cCarrierCol)];
					if (!drivers.length) return 0;
					const ph = drivers.map(() => "?").join(",");
					return db.prepare(`SELECT COALESCE(SUM(amount),0) AS t FROM expenses WHERE owner_id = ? OR LOWER(driver) IN (${ph})`).get(user.id, ...drivers).t;
				})();
			netRevenueToDate = Math.round(totalRevenue - expClause);
		} catch (sheetsErr) {
			// Refuse to generate a financial document with fabricated zeros.
			console.error("Tax CSV: sheets fetch failed:", sheetsErr.message);
			return res.status(503).json({
				error: "Unable to generate tax document — financial data source unavailable. Please try again shortly.",
			});
		}

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
		const response = await sheets.spreadsheets.values.get({
			spreadsheetId: SPREADSHEET_ID,
			range: "Job Tracking",
		});
		const jobTracking = parseSheet(response.data);
		jobTracking.data = deduplicateLoads(jobTracking.data, jobTracking.headers);
		const rptCarrierDB = getCarrierDBFromSQLite();
		const rptCDriverCol = findCol(rptCarrierDB.headers, /driver/i) || rptCarrierDB.headers[0];
		const rptCCarrierCol = findCol(rptCarrierDB.headers, /carrier/i);

		let investorDriverSet = null;
		const reportOwnerId = !isSuperAdmin ? user.id : null;
		if (!isSuperAdmin) {
			investorDriverSet = getInvestorDriverSet(user.id, rptCarrierDB.data, rptCDriverCol, rptCCarrierCol);
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
		const rptOwnerIdCol = findCol(jobTracking.headers, /^owner.?id$/i);
		const jtDateColR = findCol(jobTracking.headers, /status.*update.*date|completion.*date|assigned.*date/i) || findCol(jobTracking.headers, /date/i);
		const filteredJobData = (investorDriverSet
			? jobTracking.data.filter(r => {
				if (rptOwnerIdCol && parseInt(r[rptOwnerIdCol]) === reportOwnerId) return true;
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

		const jtRateCol2 = findCol(jobTracking.headers, /payment|rate|amount|revenue/i);
		const jtDateCol2 = findCol(jobTracking.headers, /status.*update.*date|completion.*date|assigned.*date/i) || findCol(jobTracking.headers, /date/i);
		const rptStatusCol = findCol(jobTracking.headers, /status/i);
		const rptCompletedStatuses = /^(delivered|completed|pod received)$/i;

		// Only count revenue from rows in a completed status (delivered,
		// completed, pod received) — matches the investor dashboard logic
		// so the PDF and the dashboard always show the same totalRevenue.
		// Prior semantic also counted dispatched/in-transit rows, creating
		// a confusing gap between the two surfaces.
		let totalRevenue = 0;
		filteredJobData.forEach(r => {
			const amt = parseFloat(String((jtRateCol2 ? r[jtRateCol2] : "0")).replace(/[$,]/g, "")) || 0;
			if (!amt) return;
			const st = rptStatusCol ? (r[rptStatusCol] || "").trim() : "";
			if (rptCompletedStatuses.test(st)) totalRevenue += amt;
		});

		// Fleet purchase price — sum actual trucks.purchase_price column.
		// Was previously hardcoded to $58,000 via config.truck_purchase_price
		// fallback, which was wrong once real purchase prices were entered
		// in the trucks table. Per 2026-04-13 client feedback.
		const ownedTrucks2 = isSuperAdmin
			? db.prepare("SELECT * FROM trucks").all()
			: db.prepare("SELECT * FROM trucks WHERE owner_id = ?").all(user.id);
		const totalTrucks = ownedTrucks2.length || 1;
		const totalPurchasePrice = ownedTrucks2.reduce((sum, t) => sum + (t.purchase_price || 0), 0);
		// "Per truck" shows the single value for a one-truck fleet and the
		// average for multi-truck fleets (same pattern as /api/investor).
		const purchasePrice = ownedTrucks2.length === 1
			? (ownedTrucks2[0].purchase_price || 0)
			: (totalTrucks > 0 ? Math.round(totalPurchasePrice / totalTrucks) : 0);
		const totalStartupExpenses = 5000 * totalTrucks;
		const currentValue = Math.round(totalPurchasePrice * 0.80);

		// Helper: how many months does this truck appear in the report period?
		// - With a date range: clamp to the range, bounded by created_at
		// - All-time: from truck.created_at to now
		// - Missing created_at (legacy data): fall back to the fleet-wide
		//   earliest created_at, or to 1 month as a floor
		const reportNow = new Date();
		const fleetEarliestCreated = ownedTrucks2
			.map(t => (t.created_at ? new Date(t.created_at) : null))
			.filter(d => d && !isNaN(d))
			.reduce((min, d) => (min === null || d < min ? d : min), null);
		function truckMonthsInPeriod(t) {
			const createdAt = t.created_at ? new Date(t.created_at) : null;
			const truckStart = (createdAt && !isNaN(createdAt))
				? createdAt
				: fleetEarliestCreated; // legacy data fallback
			let start, end;
			if (filterStart || filterEnd) {
				start = filterStart || truckStart || reportNow;
				end = filterEnd || reportNow;
			} else {
				start = truckStart || reportNow;
				end = reportNow;
			}
			// If the truck was created after the period ended, zero months.
			if (truckStart && filterEnd && truckStart > filterEnd) return 0;
			// Clamp start to truck creation.
			if (truckStart && start < truckStart) start = truckStart;
			if (end < start) return 0;
			const months = (end.getFullYear() - start.getFullYear()) * 12
				+ (end.getMonth() - start.getMonth()) + 1;
			return Math.max(1, months);
		}

		let totalExpenses = 0;
		let fuelExpenses = 0, maintenanceExpenses = 0, complianceExpenses = 0, otherExpenses = 0;
		// Parameterized date filters (avoid string interpolation in SQL)
		let dateWhere = '';
		const dateParams = [];
		if (filterStart) { dateWhere += ' AND date >= ?'; dateParams.push(filterStart.toISOString().slice(0, 10)); }
		if (filterEnd) { dateWhere += ' AND date <= ?'; dateParams.push(filterEnd.toISOString().slice(0, 10)); }

		// Itemized trip expenses by type — runs for both Super Admin and Investor.
		// Investor: filter by their assigned driver list. Super Admin: no driver
		// filter (aggregate everything). Previously this block was gated on
		// investorDriverSet being populated, which silently zeroed all expense
		// lines on Super Admin reports.
		{
			let whereClause = '';
			const whereParams = [];
			if (investorDriverSet && investorDriverSet.size > 0) {
				const driverList = [...investorDriverSet];
				const ph = driverList.map(() => '?').join(',');
				whereClause = ` AND LOWER(driver) IN (${ph})`;
				whereParams.push(...driverList);
			}
			const expRows = db.prepare(
				`SELECT LOWER(type) AS t, COALESCE(SUM(amount),0) AS total FROM expenses WHERE 1=1${whereClause}${dateWhere} GROUP BY LOWER(type)`
			).all(...whereParams, ...dateParams);
			// Categorization per 2026-04-13 client feedback:
			// - Fuel → Fuel Expenses
			// - Repair / Maintenance / Tire / Oil → Maintenance & Repairs
			// - Everything else (Wear & Tear, Toll, Food, Other) → Other Expenses
			expRows.forEach(r => {
				if (/fuel/i.test(r.t)) fuelExpenses += r.total;
				else if (/maint|repair|tire|oil/i.test(r.t)) maintenanceExpenses += r.total;
				else otherExpenses += r.total;
				totalExpenses += r.total;
			});
		}

		// Maintenance fund disbursements (truck-level service payments)
		{
			const maintTotal = (investorDriverSet
				? db.prepare(`SELECT COALESCE(SUM(mf.amount),0) AS t FROM maintenance_fund mf INNER JOIN trucks t ON LOWER(mf.truck)=LOWER(t.unit_number) WHERE t.owner_id=? AND mf.type='service'`).get(user.id)
				: db.prepare(`SELECT COALESCE(SUM(amount),0) AS t FROM maintenance_fund WHERE type='service'`).get()
			).t;
			maintenanceExpenses += maintTotal;
			totalExpenses += maintTotal;
		}

		// Compliance / Regulatory = truck fixed costs (ELD + HVUT/12 + IRP/12)
		// per month, multiplied by the number of months each truck was active
		// in the report period. PLUS any manually-logged compliance_fees rows.
		// Per 2026-04-13 client feedback: "Compliance/Regulatory is the ELD,
		// HVUT, IRP added up and divided by 12 months which is part of the
		// fixed expenses. On run report period it needs to show this month
		// per month."
		{
			for (const t of ownedTrucks2) {
				const monthlyFixed = (t.eld_monthly || 0)
					+ ((t.hvut_annual || 0) / 12)
					+ ((t.irp_annual || 0) / 12);
				const months = truckMonthsInPeriod(t);
				const truckFixed = monthlyFixed * months;
				complianceExpenses += truckFixed;
				totalExpenses += truckFixed;
			}
			const compFees = (investorDriverSet
				? db.prepare(`SELECT COALESCE(SUM(cf.amount),0) AS t FROM compliance_fees cf INNER JOIN trucks t ON LOWER(cf.truck)=LOWER(t.unit_number) WHERE t.owner_id=? AND cf.status='Paid'`).get(user.id)
				: db.prepare(`SELECT COALESCE(SUM(amount),0) AS t FROM compliance_fees WHERE status='Paid'`).get()
			).t;
			complianceExpenses += compFees;
			totalExpenses += compFees;
		}

		// Round category totals AFTER all sources have been summed, then
		// derive totalExpenses from the ROUNDED categories so the P&L adds
		// up exactly — otherwise independent rounding can drift by $1-2.
		fuelExpenses = Math.round(fuelExpenses);
		maintenanceExpenses = Math.round(maintenanceExpenses);
		complianceExpenses = Math.round(complianceExpenses);
		otherExpenses = Math.round(otherExpenses);
		totalExpenses = fuelExpenses + maintenanceExpenses + complianceExpenses + otherExpenses;

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
		const avgPerLoad = completedJobs > 0 ? totalRevenue / completedJobs : 0;
		kpiRow("Total Revenue", fmt(totalRevenue), "Avg Revenue / Load", fmt(avgPerLoad));
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
		// Helper: add a page break if the next line wouldn't fit above the
		// footer. Fixes the "Total Expenses" orphan + gap bug where the loop
		// used to let pdfkit split a row across pages, leaving a huge blank
		// space on page 2. Per 2026-04-13 client feedback.
		const footerSafety = 60;
		const ensureSpace = (needed) => {
			if (doc.y + needed > doc.page.height - footerSafety) {
				doc.addPage();
			}
		};
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
		const plLineHeight = 18;
		const plX = 50, plW = doc.page.width - 100;
		plLines.forEach((line, i) => {
			if (i === plLines.length - 3) { // separator before net profit
				// Keep the separator AND the following three bold rows together
				// so they don't split across pages.
				ensureSpace(plLineHeight * 3 + 10);
				doc.moveTo(plX, doc.y).lineTo(plX + plW, doc.y).strokeColor("#cccccc").stroke();
				doc.moveDown(0.3);
			} else {
				ensureSpace(plLineHeight);
			}
			const y = doc.y;
			doc.font(line.bold ? "Helvetica-Bold" : "Helvetica").fontSize(10).fillColor(line.indent ? "#555555" : "#000000")
				.text(line.label, plX + (line.indent ? 15 : 0), y, { width: plW - 80 })
				.font(line.bold ? "Helvetica-Bold" : "Helvetica").fillColor(line.bold ? "#0f3460" : "#333333")
				.text(line.value, plX + plW - 80, y, { width: 80, align: "right" });
			// Force consistent line spacing regardless of pdfkit's per-text
			// auto-advance, so ensureSpace() math stays predictable.
			doc.y = y + plLineHeight;
		});
		doc.moveDown(0.5);

		// ── Monthly Revenue Table
		if (monthlyData2.length > 0) {
			// Keep the section header + header row + first data row together.
			// sectionHeader ~52pt + 18pt header row + 16pt data row = 86pt.
			ensureSpace(90);
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
				if (ty > doc.page.height - footerSafety) { doc.addPage(); ty = 50; }
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
			// Section header ~52pt + first kpiRow ~36pt = 88pt.
			ensureSpace(90);
			sectionHeader("Fleet Breakdown");
			ownedTrucks2.forEach(t => {
				ensureSpace(36);
				kpiRow(
					`Unit ${t.unit_number}`,
					`${t.make||""} ${t.model||""}`.trim() || "—",
					"Driver",
					t.assigned_driver || "Unassigned"
				);
			});
		}

		// ── Footer (last page only — pageAdded handler removed to prevent infinite loop)
		doc.rect(0, doc.page.height - 30, doc.page.width, 30).fill("#f0f0f0");
		doc.fillColor("#999").fontSize(8).font("Helvetica")
			.text(`Generated by LogisX  ·  ${dateStr}`, 50, doc.page.height - 20, { lineBreak: false });

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
			if (clientFileName && !validateFileExt(clientFileName)) return res.status(400).json({ error: "File type not allowed" });
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
								const geoMsg = geofenceTriggered === "At Shipper"
									? `You have arrived at the pickup location`
									: `You have arrived at the delivery location`;
								const geoNotif = insertNotification.run(
									driverName.trim().toLowerCase(), 'geofence',
									`${geofenceTriggered} — Load ${loadId}`,
									geoMsg,
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
								const dispatchMsg = geofenceTriggered === "At Shipper"
									? `${driverName} has arrived at the pickup location (Load ${loadId})`
									: `${driverName} has arrived at the delivery location (Load ${loadId})`;
								insertDispatchNotification.run(
									'geofence',
									`${driverName}: ${geofenceTriggered}`,
									dispatchMsg,
									JSON.stringify({ loadId, driverName, status: geofenceTriggered })
								);
								io.to("dispatch").emit("dispatch-notification", {
									type: 'geofence',
									title: `${driverName}: ${geofenceTriggered}`,
									body: dispatchMsg,
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
			const dirDrivers = db.prepare("SELECT driver_name FROM drivers_directory").all();
			for (const d of dirDrivers) {
				if (d.driver_name) allDriverNames.push(d.driver_name);
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
							// Fallback: load_coordinates table by Load ID
							if (!entry.originLat || !entry.destLat) {
								const lc = db.prepare("SELECT * FROM load_coordinates WHERE load_id = ?").get(lid.toLowerCase());
								if (lc) {
									if (!entry.originLat && lc.origin_lat) { entry.originLat = lc.origin_lat; entry.originLng = lc.origin_lng; }
									if (!entry.destLat && lc.dest_lat) { entry.destLat = lc.dest_lat; entry.destLng = lc.dest_lng; }
								}
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

// Forward geocode address → lat/lng with SQLite cache
async function geocodeAddress(address) {
	if (!address || address.trim().length < 5) return null;
	const key = address.trim().toLowerCase();
	// Check cache
	const cached = db.prepare("SELECT lat, lng FROM geocode_cache WHERE address = ?").get(key);
	if (cached) return cached.lat ? { lat: cached.lat, lng: cached.lng } : null;
	// Call Google Geocoding API
	try {
		const resp = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${GOOGLE_MAPS_API_KEY}`);
		const data = await resp.json();
		if (data.status === "OK" && data.results && data.results.length > 0) {
			const loc = data.results[0].geometry.location;
			db.prepare("INSERT OR REPLACE INTO geocode_cache (address, lat, lng) VALUES (?, ?, ?)").run(key, loc.lat, loc.lng);
			return { lat: loc.lat, lng: loc.lng };
		}
	} catch { /* silent */ }
	// Cache null to avoid retrying
	db.prepare("INSERT OR REPLACE INTO geocode_cache (address, lat, lng) VALUES (?, NULL, NULL)").run(key);
	return null;
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
app.get("/api/config/maps-key", (req, res) => {
	res.json({ key: GOOGLE_MAPS_API_KEY });
});

// GET /api/geocode — reverse geocode via Google Geocoding API
app.get("/api/geocode", async (req, res) => {
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
					{ long_name: (comp.find(c => c.types.includes("sublocality")) || {}).long_name || "", types: ["sublocality"] },
					{ short_name: (comp.find(c => c.types.includes("administrative_area_level_1")) || {}).short_name || "", types: ["administrative_area_level_1"] },
					{ long_name: (comp.find(c => c.types.includes("postal_code")) || {}).long_name || "", types: ["postal_code"] },
				],
			}],
		});
	} catch {
		res.json({ status: "ERROR", results: [] });
	}
});

// GET /api/geocode/search — Forward geocode via Google Places API (New)
app.get("/api/geocode/search", async (req, res) => {
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

// GET /api/geocode/load/:loadId — get coordinates for a load (SQLite lookup, geocodes on-demand if missing)
app.get("/api/geocode/load/:loadId", requireAuth, async (req, res) => {
	try {
		const loadId = decodeURIComponent(req.params.loadId).trim().toLowerCase().replace(/^#/, "");
		let row = db.prepare("SELECT * FROM load_coordinates WHERE load_id = ?").get(loadId);

		// On miss (or partial coverage): find addresses in the sheet, geocode, and cache
		const needsGeocode = !row || !row.origin_lat || !row.dest_lat;
		if (needsGeocode) {
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
				const pickupAddrCol = headers.find((h) => /pickup.*address|origin.*address|shipper.*address/i.test(h));
				const dropoffAddrCol = headers.find((h) => /drop.?off.*address|dest.*address|receiver.*address|delivery.*address/i.test(h));
				if (loadIdCol) {
					for (let i = 1; i < rows.length; i++) {
						const obj = {};
						headers.forEach((h, idx) => { obj[h] = rows[i][idx] || ""; });
						if ((obj[loadIdCol] || "").trim().toLowerCase() === loadId) {
							const pickupAddr = pickupAddrCol ? (obj[pickupAddrCol] || "").trim() : "";
							const dropoffAddr = dropoffAddrCol ? (obj[dropoffAddrCol] || "").trim() : "";
							const [origin, dest] = await Promise.all([
								pickupAddr ? geocodeAddress(pickupAddr) : Promise.resolve(null),
								dropoffAddr ? geocodeAddress(dropoffAddr) : Promise.resolve(null),
							]);
							db.prepare(`INSERT OR REPLACE INTO load_coordinates (load_id, origin_lat, origin_lng, dest_lat, dest_lng, pickup_address, dropoff_address) VALUES (?, ?, ?, ?, ?, ?, ?)`)
								.run(
									loadId,
									origin ? origin.lat : (row && row.origin_lat) || null,
									origin ? origin.lng : (row && row.origin_lng) || null,
									dest ? dest.lat : (row && row.dest_lat) || null,
									dest ? dest.lng : (row && row.dest_lng) || null,
									pickupAddr || (row && row.pickup_address) || "",
									dropoffAddr || (row && row.dropoff_address) || "",
								);
							row = db.prepare("SELECT * FROM load_coordinates WHERE load_id = ?").get(loadId);
							break;
						}
					}
				}
			} catch (err) {
				console.error("Lazy geocode failed for load", loadId, err.message);
			}
		}

		if (!row) return res.json({});
		const result = {};
		if (row.origin_lat) { result.originLat = row.origin_lat; result.originLng = row.origin_lng; }
		if (row.dest_lat) { result.destLat = row.dest_lat; result.destLng = row.dest_lng; }
		result.pickupAddress = row.pickup_address;
		result.dropoffAddress = row.dropoff_address;
		res.json(result);
	} catch (err) {
		res.status(500).json({ error: err.message });
	}
});

// GET /api/geocode/bulk — geocode all loads (Super Admin)
app.get("/api/geocode/bulk", requireRole("Super Admin"), async (req, res) => {
	try {
		const sheets = await getSheets();
		const resp = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: "Job Tracking" });
		const rows = (resp.data.values || []);
		if (rows.length < 2) return res.json({ geocoded: 0, skipped: 0 });
		const headers = rows[0];
		const loadIdIdx = headers.findIndex(h => /load.?id|job.?id/i.test(h));
		const pickupIdx = headers.findIndex(h => /pickup.*address/i.test(h));
		const dropoffIdx = headers.findIndex(h => /drop.?off.*address|dest.*address/i.test(h));
		const addresses = new Set();
		for (let i = 1; i < rows.length; i++) {
			if (loadIdIdx !== -1 && !(rows[i][loadIdIdx] || "").trim()) continue;
			if (pickupIdx !== -1) { const a = (rows[i][pickupIdx] || "").trim(); if (a) addresses.add(a); }
			if (dropoffIdx !== -1) { const a = (rows[i][dropoffIdx] || "").trim(); if (a) addresses.add(a); }
		}
		let geocoded = 0, skipped = 0;
		for (const addr of addresses) {
			const cached = db.prepare("SELECT id FROM geocode_cache WHERE address = ?").get(addr.trim().toLowerCase());
			if (cached) { skipped++; continue; }
			await geocodeAddress(addr);
			geocoded++;
			await new Promise(r => setTimeout(r, 50)); // rate limit
		}
		res.json({ geocoded, skipped, total: addresses.size });
	} catch (err) {
		res.status(500).json({ error: err.message });
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

// Job Tracking sheet cache — avoids hitting Google Sheets API on every investor request (2-5s).
// TTL 60s. Invalidated by mutation endpoints (dispatch, status update, load edit) via jtCacheInvalidate().
let _jtCache = null;
const JT_CACHE_TTL = 60_000;
async function getJobTrackingCached() {
	if (_jtCache && (Date.now() - _jtCache.at) < JT_CACHE_TTL) return _jtCache.data;
	const sheets = await getSheets();
	const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: "Job Tracking" });
	const parsed = parseSheet(response.data);
	parsed.data = deduplicateLoads(parsed.data, parsed.headers);
	_jtCache = { data: parsed, at: Date.now() };
	return parsed;
}
function jtCacheInvalidate() { _jtCache = null; }

// GET /api/investor — Aggregated financial data for investor view
app.get("/api/investor", requireRole("Super Admin", "Investor"), async (req, res) => {
	try {
		const jobTracking = await getJobTrackingCached();
		const carrierDB = getCarrierDBFromSQLite();

		const user = req.session.user;
		const isSuperAdmin = user.role === "Super Admin";

		// Resolve carrier DB columns (history sync moved to POST/PUT /api/drivers-directory)
		const carrierDriverCol = findCol(carrierDB.headers, /driver/i) || carrierDB.headers[0];
		const carrierCarrierCol = findCol(carrierDB.headers, /carrier/i);

		// Get investor's driver names (current + historical) for data filtering
		let investorDriverSet = null; // null = no filter (Super Admin)
		const investorOwnerId = !isSuperAdmin ? user.id : null;
		if (!isSuperAdmin) {
			investorDriverSet = getInvestorDriverSet(user.id, carrierDB.data, carrierDriverCol, carrierCarrierCol);
		}

		// Load per-investor config with fallback to global defaults (owner_id=0)
		const globalConfig = db.prepare("SELECT key, value FROM investor_config WHERE owner_id = 0").all();
		const config = {};
		globalConfig.forEach((r) => (config[r.key] = r.value));
		if (!isSuperAdmin) {
			const investorConfig = db.prepare("SELECT key, value FROM investor_config WHERE owner_id = ?").all(user.id);
			investorConfig.forEach((r) => (config[r.key] = r.value)); // override globals
		}

		// Filter sheet data by Owner ID column (primary) or driver name (fallback for old data)
		const driverCol = findCol(jobTracking.headers, /^driver$/i);
		const ownerIdCol = findCol(jobTracking.headers, /^owner.?id$/i);
		const filteredJobData = investorDriverSet
			? jobTracking.data.filter(r => {
				// Primary: match Owner ID column (stamped at dispatch)
				if (ownerIdCol) {
					const rowOwnerId = parseInt(r[ownerIdCol]) || 0;
					if (rowOwnerId === investorOwnerId) return true;
				}
				// Fallback: match driver name (for loads dispatched before Owner ID column existed)
				const driver = driverCol ? (r[driverCol] || "").trim().toLowerCase() : "";
				return driver && investorDriverSet.has(driver);
			})
			: jobTracking.data;

		const filteredCarrierData = investorDriverSet
			? carrierDB.data.filter(r => {
				const driver = (r[carrierDriverCol] || "").trim().toLowerCase();
				return driver && investorDriverSet.has(driver);
			})
			: carrierDB.data;

		// ---- Production Performance (from Job Tracking) ----
		const jtRateCol = findCol(jobTracking.headers, /payment|rate|amount|revenue/i);
		const jtDateCol = findCol(jobTracking.headers, /status.*update.*date|completion.*date|assigned.*date/i)
			|| findCol(jobTracking.headers, /date/i);
		const jtDriverCol = findCol(jobTracking.headers, /^driver$/i);
		const jtTruckCol = findCol(jobTracking.headers, /^truck$|truck[._\s-]?(unit|number|#)|unit[._\s-]?number/i);
		const statusCol = findCol(jobTracking.headers, /status/i);
		const pickupDateCol = findCol(jobTracking.headers, /pickup.*appo|pickup.*date/i);
		const dropoffDateCol = findCol(jobTracking.headers, /drop.?off.*appo|drop.?off.*date|delivery.*date/i);

		// Helper: parse a messy date cell like "5/16/25 9:00" or "5/16/25 06:00-18:00 Appt." into a Date
		function parseSheetDate(val) {
			if (!val) return null;
			const m = String(val).match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
			if (!m) return null;
			let yr = parseInt(m[3]);
			if (yr < 100) yr += 2000;
			const d = new Date(yr, parseInt(m[1]) - 1, parseInt(m[2]));
			return isNaN(d) ? null : d;
		}
		// Helper: format a Date as "YYYY-MM-DD" using LOCAL time (avoids UTC shift)
		function fmtDate(d) {
			return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
		}
		// Helper: expand two dates into an array of "YYYY-MM-DD" strings (inclusive)
		function expandDateRange(start, end) {
			const dates = [];
			const s = new Date(start); s.setHours(12, 0, 0, 0);
			const e = end ? new Date(end) : new Date(start);
			e.setHours(12, 0, 0, 0);
			if (e < s) return [fmtDate(s)];
			// Cap at 31 days to prevent runaway loops on bad data (no trucking load spans >31 days)
			const MAX_SPAN = 31 * 24 * 3600 * 1000;
			if (e - s > MAX_SPAN) e.setTime(s.getTime() + MAX_SPAN);
			const cur = new Date(s);
			while (cur <= e) {
				dates.push(fmtDate(cur));
				cur.setDate(cur.getDate() + 1);
			}
			return dates;
		}
		const loadIdCol = findCol(jobTracking.headers, /load.?id|job.?id/i);
		const completedStatuses = /^(delivered|completed|pod received)$/i;

		// ---- Miles source: load_coordinates table ----
		// Prefer cached road distance (Google Routes API, distance_miles
		// column). Fall back to haversine straight-line when the backfill
		// hasn't run yet. Same pattern as /api/financials.
		const milesByLoadId = {};
		{
			const coordRows = db.prepare(
				"SELECT load_id, origin_lat, origin_lng, dest_lat, dest_lng, distance_miles FROM load_coordinates WHERE origin_lat IS NOT NULL AND dest_lat IS NOT NULL"
			).all();
			for (const c of coordRows) {
				if (c.distance_miles != null && c.distance_miles > 0) {
					milesByLoadId[(c.load_id || "").toLowerCase()] = c.distance_miles;
				} else {
					const meters = geolib.getDistance(
						{ latitude: c.origin_lat, longitude: c.origin_lng },
						{ latitude: c.dest_lat, longitude: c.dest_lng }
					);
					milesByLoadId[(c.load_id || "").toLowerCase()] = meters / 1609.344;
				}
			}
		}

		// ---- Single-pass: revenue + driver pay + operating period + per-driver gross ----
		const activeWorkStatuses = /^(in transit|dispatched|assigned|picked up|at shipper|at receiver|loading|unloading|delivered|completed|pod received)$/i;
		let totalRevenue = 0;
		let last30DaysRevenue = 0;
		let earliestDate = null;
		let latestDate = null;
		const monthlyRevenue = {};
		const completedLoadIds = new Set();
		const grossByDriver = {};       // per-driver completed revenue (replaces Pass 3 inner loop)
		const milesByDriver = {};       // per-driver haversine miles (replaces odoByDriver)
		const milesByTruck = {};        // per-truck haversine miles
		const loadsByDriver = {};       // per-driver completed load count (fallback when no truck column)
		const loadsByTruck = {};        // per-truck completed load count (preferred when truck column exists)
		const driverDaySets = {};        // per-driver active day Sets (all-time, used for totals)
		// Driver active days bucketed by LOAD'S ASSIGNED MONTH (not by physical day).
		// This matches how revenue is bucketed — both should answer the question:
		// "for loads assigned in month X, how much did we earn and how much did we
		// pay the driver?" Previously loads assigned in April with old pickup dates
		// in 2021 would show their revenue in April but their driver pay in 2021.
		const driverMonthlyDays = {};    // { driver: { "YYYY-MM": Set<"YYYY-MM-DD"> } }
		const now = new Date();
		const thirtyDaysAgo = new Date(now);
		thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

		filteredJobData.forEach((r) => {
			const st = statusCol ? (r[statusCol] || "").trim() : "";
			const driver = jtDriverCol ? (r[jtDriverCol] || "").trim().toLowerCase() : "";
			const truckUnit = jtTruckCol ? (r[jtTruckCol] || "").trim().toLowerCase() : "";

			// Resolve the load's assigned-month key once (used by both revenue and driver pay)
			let assignedMonthKey = null;
			if (jtDateCol && r[jtDateCol]) {
				const d = parseSheetDate(r[jtDateCol]) || new Date(r[jtDateCol]);
				if (d && !isNaN(d)) assignedMonthKey = fmtDate(d).slice(0, 7);
			}

			// Revenue (completed loads only)
			if (completedStatuses.test(st)) {
				if (driver) loadsByDriver[driver] = (loadsByDriver[driver] || 0) + 1;
				if (truckUnit) loadsByTruck[truckUnit] = (loadsByTruck[truckUnit] || 0) + 1;
				const amt = parseFloat(String((jtRateCol ? r[jtRateCol] : "0")).replace(/[$,]/g, "")) || 0;
				if (amt) {
					const lid = loadIdCol ? (r[loadIdCol] || "").trim() : "";
					if (lid) completedLoadIds.add(lid);
					totalRevenue += amt;
					if (driver) grossByDriver[driver] = (grossByDriver[driver] || 0) + amt;
					// Haversine miles per load (straight-line, load_coordinates)
					const loadMiles = milesByLoadId[lid.toLowerCase()] || 0;
					if (loadMiles > 0) {
						if (driver) milesByDriver[driver] = (milesByDriver[driver] || 0) + loadMiles;
						if (truckUnit) milesByTruck[truckUnit] = (milesByTruck[truckUnit] || 0) + loadMiles;
					}
					if (assignedMonthKey) {
						const d = parseSheetDate(r[jtDateCol]) || new Date(r[jtDateCol]);
						if (d >= thirtyDaysAgo) last30DaysRevenue += amt;
						monthlyRevenue[assignedMonthKey] = (monthlyRevenue[assignedMonthKey] || 0) + amt;
					}
				}
			}

			// Driver active days (all work statuses, not just completed)
			if (activeWorkStatuses.test(st) && driver) {
				const pickup = parseSheetDate(pickupDateCol ? r[pickupDateCol] : null);
				const dropoff = parseSheetDate(dropoffDateCol ? r[dropoffDateCol] : null);
				if (pickup) {
					const days = expandDateRange(pickup, dropoff || pickup);
					// All-time set (for totals)
					if (!driverDaySets[driver]) driverDaySets[driver] = new Set();
					days.forEach(d => driverDaySets[driver].add(d));
					// Per-assigned-month set (for monthly P&L). Falls back to the
					// physical day's month if the load has no assigned date (rare).
					if (!driverMonthlyDays[driver]) driverMonthlyDays[driver] = {};
					days.forEach(d => {
						const bucket = assignedMonthKey || d.slice(0, 7);
						if (!driverMonthlyDays[driver][bucket]) driverMonthlyDays[driver][bucket] = new Set();
						driverMonthlyDays[driver][bucket].add(d);
					});
				}
			}

			// Operating period (track earliest/latest dates)
			if (jtDateCol && r[jtDateCol]) {
				const d = parseSheetDate(r[jtDateCol]) || new Date(r[jtDateCol]);
				if (d && !isNaN(d)) {
					if (!earliestDate || d < earliestDate) earliestDate = d;
					if (!latestDate || d > latestDate) latestDate = d;
				}
			}
		});

		// Avg daily revenue = 30-day average (S2).
		// Gross = raw top-line from completed loads in the trailing 30 days.
		// Investor daily = the 50% split after driver pay + fixed + trip expenses
		// is applied — computed below after netProfit is known for the window.
		const avgDailyRevenue = last30DaysRevenue / 30;

		// Months of operation and avg monthly owner earnings (S3)
		let monthsOfOperation = 1;
		if (earliestDate && latestDate) {
			monthsOfOperation = Math.max(1,
				(latestDate.getFullYear() - earliestDate.getFullYear()) * 12
				+ (latestDate.getMonth() - earliestDate.getMonth()) + 1
			);
		}
		const avgMonthlyOwnerEarnings = Math.round(totalRevenue / monthsOfOperation);

		// ---- Expense Data — load-specific + truck-level ----
		let totalExpenses = 0;
		if (completedLoadIds.size > 0) {
			const lidList = [...completedLoadIds];
			const lidPh = lidList.map(() => '?').join(',');
			if (investorOwnerId) {
				const driverList = [...investorDriverSet];
				const driverPh = driverList.length ? driverList.map(() => '?').join(',') : "'__none__'";
				const expSum = db.prepare(`SELECT COALESCE(SUM(amount), 0) AS total FROM expenses WHERE load_id IN (${lidPh}) AND (owner_id = ? OR LOWER(driver) IN (${driverPh}))`).get(...lidList, investorOwnerId, ...driverList);
				totalExpenses += expSum.total;
			} else if (isSuperAdmin) {
				const expSum = db.prepare(`SELECT COALESCE(SUM(amount), 0) AS total FROM expenses WHERE load_id IN (${lidPh})`).get(...lidList);
				totalExpenses += expSum.total;
			}
		}
		// Truck-level costs (maintenance fund DISBURSEMENTS, compliance fees)
		// NOTE: maintenance_fund table = actual service payments. SEPARATE from trucks.maintenance_fund_monthly (budget).
		if (investorOwnerId) {
			const maintSum = db.prepare(`SELECT COALESCE(SUM(mf.amount), 0) AS total FROM maintenance_fund mf INNER JOIN trucks t ON LOWER(mf.truck) = LOWER(t.unit_number) WHERE t.owner_id = ? AND mf.type = 'service'`).get(user.id);
			totalExpenses += maintSum.total;
			const compSum = db.prepare(`SELECT COALESCE(SUM(cf.amount), 0) AS total FROM compliance_fees cf INNER JOIN trucks t ON LOWER(cf.truck) = LOWER(t.unit_number) WHERE t.owner_id = ? AND cf.status = 'Paid'`).get(user.id);
			totalExpenses += compSum.total;
		} else if (isSuperAdmin) {
			totalExpenses += db.prepare(`SELECT COALESCE(SUM(amount), 0) AS total FROM maintenance_fund WHERE type = 'service'`).get().total;
			totalExpenses += db.prepare(`SELECT COALESCE(SUM(amount), 0) AS total FROM compliance_fees WHERE status = 'Paid'`).get().total;
		}

		// ---- Driver Pay from active-day sets (computed in single pass above) ----
		const driverPayDetails = {};
		let totalDriverPay = 0;
		{
			// Get daily rates from trucks (one query, not per-truck)
			const trucksByDriver = {};
			const truckQuery = investorDriverSet
				? "SELECT assigned_driver, driver_pay_daily FROM trucks WHERE owner_id = ?"
				: "SELECT assigned_driver, driver_pay_daily FROM trucks";
			db.prepare(truckQuery).all(...(investorDriverSet ? [user.id] : [])).forEach(t => {
				const d = (t.assigned_driver || "").trim().toLowerCase();
				if (d) trucksByDriver[d] = t.driver_pay_daily || 250;
			});
			for (const [driver, daySet] of Object.entries(driverDaySets)) {
				const rate = trucksByDriver[driver] || 250;
				const activeDays = daySet.size;
				const pay = activeDays * rate;
				totalDriverPay += pay;
				driverPayDetails[driver] = { activeDays, dailyRate: rate, totalPay: pay, dates: [...daySet].sort() };
			}
			totalExpenses += totalDriverPay;
		}

		// ---- Add truck fixed costs (excluding driver pay — now computed above) ----
		// NOTE: maintenance_fund_monthly here is the monthly RESERVE budget from the
		// trucks table. See comment above for distinction from maintenance_fund table.
		{
			const truckQuery = investorDriverSet
				? "SELECT insurance_monthly, eld_monthly, hvut_annual, irp_annual, maintenance_fund_monthly, created_at FROM trucks WHERE owner_id = ?"
				: "SELECT insurance_monthly, eld_monthly, hvut_annual, irp_annual, maintenance_fund_monthly, created_at FROM trucks";
			const truckArgs = investorDriverSet ? [user.id] : [];
			const fleetTrucks = db.prepare(truckQuery).all(...truckArgs);
			for (const t of fleetTrucks) {
				const fixedPerMonth = (t.insurance_monthly || 0) + (t.eld_monthly || 0)
					+ ((t.hvut_annual || 0) / 12) + ((t.irp_annual || 0) / 12)
					+ (t.maintenance_fund_monthly || 0);
				let truckMonths = monthsOfOperation;
				if (t.created_at) {
					const truckDate = new Date(t.created_at);
					if (!isNaN(truckDate)) {
						truckMonths = Math.max(1,
							(now.getFullYear() - truckDate.getFullYear()) * 12
							+ (now.getMonth() - truckDate.getMonth()) + 1
						);
						truckMonths = Math.min(truckMonths, monthsOfOperation);
					}
				}
				totalExpenses += fixedPerMonth * truckMonths;
			}
		}

		// Monthly revenue sorted
		const monthlyData = Object.entries(monthlyRevenue)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([month, amount]) => ({ month, amount: Math.round(amount) }));

		// ---- Monthly Earnings Breakdown (exact calendar month) ----
		const monthlyEarnings = [];
		{
			const currentMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

			// 1. Monthly driver pay — bucketed by each load's ASSIGNED month,
			// not by the physical day the driver was active. This keeps revenue
			// and driver pay aligned so a load assigned in April always shows
			// both its revenue AND its driver pay in April.
			const monthlyDriverPay = {};
			const monthlyDriverDetails = {}; // { "YYYY-MM": { driver: { activeDays, dailyRate, totalPay } } }
			for (const [driver, monthsMap] of Object.entries(driverMonthlyDays)) {
				const rate = (driverPayDetails[driver] && driverPayDetails[driver].dailyRate) || 250;
				for (const [mk, daySet] of Object.entries(monthsMap)) {
					const activeDays = daySet.size;
					const pay = activeDays * rate;
					monthlyDriverPay[mk] = (monthlyDriverPay[mk] || 0) + pay;
					if (!monthlyDriverDetails[mk]) monthlyDriverDetails[mk] = {};
					monthlyDriverDetails[mk][driver] = { activeDays, dailyRate: rate, totalPay: pay };
				}
			}

			// 2. Monthly trip expenses — from DB grouped by month
			const monthlyTripExp = {};
			const tripExpByCategory = {};  // { "YYYY-MM": { fuel: X, maintenance: X, ... } }
			if (investorOwnerId) {
				const driverList = [...investorDriverSet];
				const driverPh = driverList.length ? driverList.map(() => '?').join(',') : "'__none__'";
				const rows = db.prepare(
					`SELECT strftime('%Y-%m', date) AS m, COALESCE(SUM(amount), 0) AS t FROM expenses WHERE (owner_id = ? OR LOWER(driver) IN (${driverPh})) GROUP BY m`
				).all(investorOwnerId, ...driverList);
				rows.forEach(r => { if (r.m) monthlyTripExp[r.m] = r.t; });
				const catRows = db.prepare(
					`SELECT strftime('%Y-%m', date) AS m, LOWER(type) AS cat, COALESCE(SUM(amount), 0) AS t FROM expenses WHERE (owner_id = ? OR LOWER(driver) IN (${driverPh})) GROUP BY m, LOWER(type)`
				).all(investorOwnerId, ...driverList);
				catRows.forEach(r => { if (r.m) { if (!tripExpByCategory[r.m]) tripExpByCategory[r.m] = {}; tripExpByCategory[r.m][r.cat] = r.t; } });
			} else if (isSuperAdmin) {
				const rows = db.prepare(`SELECT strftime('%Y-%m', date) AS m, COALESCE(SUM(amount), 0) AS t FROM expenses GROUP BY m`).all();
				rows.forEach(r => { if (r.m) monthlyTripExp[r.m] = r.t; });
				const catRows = db.prepare(`SELECT strftime('%Y-%m', date) AS m, LOWER(type) AS cat, COALESCE(SUM(amount), 0) AS t FROM expenses GROUP BY m, LOWER(type)`).all();
				catRows.forEach(r => { if (r.m) { if (!tripExpByCategory[r.m]) tripExpByCategory[r.m] = {}; tripExpByCategory[r.m][r.cat] = r.t; } });
			}

			// 3. Monthly fixed costs — constant per month per truck (only months truck existed)
			const truckFixedQuery = investorDriverSet
				? "SELECT insurance_monthly, eld_monthly, hvut_annual, irp_annual, maintenance_fund_monthly, created_at FROM trucks WHERE owner_id = ?"
				: "SELECT insurance_monthly, eld_monthly, hvut_annual, irp_annual, maintenance_fund_monthly, created_at FROM trucks";
			const truckFixedArgs = investorDriverSet ? [user.id] : [];
			const fixedTrucks = db.prepare(truckFixedQuery).all(...truckFixedArgs);
			function getMonthlyFixedCosts(monthKey) {
				let total = 0;
				for (const t of fixedTrucks) {
					const perMonth = (t.insurance_monthly || 0) + (t.eld_monthly || 0)
						+ ((t.hvut_annual || 0) / 12) + ((t.irp_annual || 0) / 12)
						+ (t.maintenance_fund_monthly || 0);
					// Only count if truck existed in this month
					if (t.created_at) {
						const td = new Date(t.created_at);
						const truckKey = `${td.getFullYear()}-${String(td.getMonth() + 1).padStart(2, "0")}`;
						if (monthKey < truckKey) continue; // truck didn't exist yet
					}
					total += perMonth;
				}
				return Math.round(total);
			}

			// 4. Build the array for every month from earliest to current
			const startMonth = earliestDate
				? `${earliestDate.getFullYear()}-${String(earliestDate.getMonth() + 1).padStart(2, "0")}`
				: currentMonthKey;
			let cursor = new Date(parseInt(startMonth.slice(0, 4)), parseInt(startMonth.slice(5, 7)) - 1, 1);
			const endDate = new Date(now.getFullYear(), now.getMonth(), 1);
			while (cursor <= endDate) {
				const mk = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}`;
				const revenue = monthlyRevenue[mk] || 0;
				const driverPay = monthlyDriverPay[mk] || 0;
				const fixedCosts = getMonthlyFixedCosts(mk);
				const tripExpenses = monthlyTripExp[mk] || 0;
				const netProfit = revenue - driverPay - fixedCosts - tripExpenses;
				monthlyEarnings.push({
					month: mk,
					revenue: Math.round(revenue),
					driverPay: Math.round(driverPay),
					driverDetails: monthlyDriverDetails[mk] || {},
					fixedCosts,
					tripExpenses: Math.round(tripExpenses),
					tripExpCategories: tripExpByCategory[mk] || {},
					netProfit: Math.round(netProfit),
					investorEarnings: Math.round(netProfit / 2),
					companyEarnings: Math.round(netProfit / 2),
					isCurrentMonth: mk === currentMonthKey,
				});
				cursor.setMonth(cursor.getMonth() + 1);
			}
		}

		// ---- Asset Security (S4, S5) — now per-truck ----
		// Single truck query with all columns needed by asset section + per-truck loop
		const allOwnedTrucks = investorDriverSet
			? db.prepare("SELECT * FROM trucks WHERE owner_id = ?").all(user.id)
			: db.prepare("SELECT * FROM trucks").all();
		const totalTrucks = allOwnedTrucks.length;
		const totalPurchasePrice = allOwnedTrucks.reduce((sum, t) => sum + (t.purchase_price || 0), 0);
		const depreciationYears = Math.max(1, parseFloat(config.depreciation_years) || 5);
		const depreciationRate = Math.min(1, monthsOfOperation / (depreciationYears * 12));
		const totalCurrentValue = Math.round(totalPurchasePrice * (1 - depreciationRate));
		// Use first truck's values as representative for single-truck display; fleet view uses totals
		const purchasePrice = allOwnedTrucks.length === 1 ? (allOwnedTrucks[0].purchase_price || 0) : totalPurchasePrice;
		const currentValue = allOwnedTrucks.length === 1 ? Math.round((allOwnedTrucks[0].purchase_price || 0) * (1 - depreciationRate)) : totalCurrentValue;
		const titleStatus = allOwnedTrucks.length === 1 ? (allOwnedTrucks[0].title_status || "Clean") : "Mixed";

		// Fleet totals (S9)
		const totalStartupExpenses = 5000 * totalTrucks;
		const netRevenueToDate = Math.round(totalRevenue - totalExpenses);

		// Fixed cost breakdown (per-category sums across fleet, monthly)
		const fixedCostBreakdown = {
			insurance: Math.round(allOwnedTrucks.reduce((s, t) => s + (t.insurance_monthly || 0), 0)),
			eld: Math.round(allOwnedTrucks.reduce((s, t) => s + (t.eld_monthly || 0), 0)),
			irp: Math.round(allOwnedTrucks.reduce((s, t) => s + ((t.irp_annual || 0) / 12), 0)),
			hvut: Math.round(allOwnedTrucks.reduce((s, t) => s + ((t.hvut_annual || 0) / 12), 0)),
			maintReserve: Math.round(allOwnedTrucks.reduce((s, t) => s + (t.maintenance_fund_monthly || 0), 0)),
			truckCount: totalTrucks,
		};

		// ---- Tax Shield (S6, S7, S10) ----
		const section179 = totalPurchasePrice; // S6: 100% deductibility per truck
		const atRiskCapital = Math.max(0, (totalPurchasePrice + totalStartupExpenses) - netRevenueToDate); // S7

		// ---- Per-Truck Revenue Data (S8) — batched queries, no inner loops ----
		const perTruckData = {};
		if (investorDriverSet) {
			// Batch queries BEFORE the loop (4 queries total instead of 5N)
			const expByDriver = Object.fromEntries(
				db.prepare(`SELECT LOWER(driver) AS d, COALESCE(SUM(amount),0) AS t FROM expenses WHERE owner_id = ? GROUP BY LOWER(driver)`).all(user.id).map(r => [r.d, r.t])
			);
			const maintByTruck = Object.fromEntries(
				db.prepare(`SELECT LOWER(mf.truck) AS u, COALESCE(SUM(mf.amount),0) AS t FROM maintenance_fund mf INNER JOIN trucks t ON LOWER(mf.truck)=LOWER(t.unit_number) WHERE t.owner_id = ? AND mf.type='service' GROUP BY LOWER(mf.truck)`).all(user.id).map(r => [r.u, r.t])
			);
			const compByTruck = Object.fromEntries(
				db.prepare(`SELECT LOWER(cf.truck) AS u, COALESCE(SUM(cf.amount),0) AS t FROM compliance_fees cf INNER JOIN trucks t ON LOWER(cf.truck)=LOWER(t.unit_number) WHERE t.owner_id = ? AND cf.status='Paid' GROUP BY LOWER(cf.truck)`).all(user.id).map(r => [r.u, r.t])
			);
			// Use allOwnedTrucks (already fetched for asset section) — no extra query
			allOwnedTrucks.forEach((truck) => {
				const driverName = (truck.assigned_driver || "").trim().toLowerCase();
				const unitLower = truck.unit_number.toLowerCase();
				// Revenue from grossByDriver map (computed in single pass above)
				const unitTotalGross = grossByDriver[driverName] || 0;
				// Expenses from batch maps (zero queries in this loop)
				const varExp = expByDriver[driverName] || 0;
				const maintExp = maintByTruck[unitLower] || 0;
				const compExp = compByTruck[unitLower] || 0;
				const fixedPerMonth = (truck.insurance_monthly || 0) + (truck.eld_monthly || 0)
					+ ((truck.hvut_annual || 0) / 12) + ((truck.irp_annual || 0) / 12)
					+ (truck.maintenance_fund_monthly || 0);
				let truckMonths = monthsOfOperation;
				if (truck.created_at) {
					const td = new Date(truck.created_at);
					if (!isNaN(td)) {
						truckMonths = Math.max(1, (now.getFullYear() - td.getFullYear()) * 12 + (now.getMonth() - td.getMonth()) + 1);
						truckMonths = Math.min(truckMonths, monthsOfOperation);
					}
				}
				const driverPay = driverPayDetails[driverName]?.totalPay || 0;
				const unitTotalExpenses = varExp + maintExp + compExp + (fixedPerMonth * truckMonths) + driverPay;
				const avgMonthlyGross = Math.round(unitTotalGross / truckMonths);
				const avgMonthlyExpenses = Math.round(unitTotalExpenses / truckMonths);
				// Miles from the haversine accumulators computed in the single-pass
				// loop above. Prefer truck-column attribution over driver-based
				// (same fallback pattern as loadCount below).
				const truckMilesRaw = milesByTruck[unitLower];
				const totalMiles = Math.round(
					truckMilesRaw !== undefined ? truckMilesRaw : (milesByDriver[driverName] || 0)
				);

				// Prefer direct truck-column attribution (loads tagged with this unit
				// number) over driver-based attribution, which is stale if a driver
				// switched trucks. Fall back to driver-based when the sheet has no
				// truck column for a given row.
				const truckLoadCount = loadsByTruck[unitLower];
				const loadCount = (truckLoadCount !== undefined)
					? truckLoadCount
					: (loadsByDriver[driverName] || 0);
				perTruckData[truck.unit_number] = {
					unitMonthlyGross: avgMonthlyGross,
					unitMonthlyExpenses: avgMonthlyExpenses,
					estAnnualRevenue: Math.round((avgMonthlyGross - avgMonthlyExpenses) * 12),
					totalMiles,
					loadCount,
				};
			});
		}

		// ---- Recession-Proof Metrics (kept in API for backward compat) ----
		const brokerCol = findCol(jobTracking.headers, /broker|shipper|customer|client/i);
		const totalJobs = filteredJobData.length;
		const completedJobCount = statusCol
			? filteredJobData.filter((r) => completedStatuses.test((r[statusCol] || "").trim())).length
			: 0;

		// Fleet-level mileage aggregation
		const fleetTotalMiles = Object.values(perTruckData).reduce((s, t) => s + (t.totalMiles || 0), 0);
		const revenuePerMile = fleetTotalMiles > 0 ? Math.round((totalRevenue / fleetTotalMiles) * 100) / 100 : 0;
		const costPerMile = fleetTotalMiles > 0 ? Math.round((totalExpenses / fleetTotalMiles) * 100) / 100 : 0;

		// Resolve the investor's own record so the dashboard can display (and upload) their profile picture
		let investorProfile = null;
		if (!isSuperAdmin) {
			investorProfile = db.prepare("SELECT id, profile_picture_url FROM investors WHERE user_id = ?").get(user.id);
		}

		// ---- Investor-centric aggregates (P0-4/5/6 from 2026-04-12 meeting) ----
		// Every metric on the investor dashboard must be based on what the
		// owner actually takes home, not the gross. The backend returns both:
		// frontend can show "Truck Gross" and "Your Take-Home" side-by-side.
		const investorNetToDate = Math.round(
			(monthlyEarnings || []).reduce((s, m) => s + (m.investorEarnings || 0), 0)
		);
		// Trailing 3-month average investor take-home. Uses the most recent
		// 3 entries from monthlyEarnings (which is ordered oldest → newest).
		// Falls back to all-time avg if fewer than 3 months exist.
		const recentMonths = (monthlyEarnings || []).slice(-3);
		const trailing3MonthInvestor = recentMonths.length
			? recentMonths.reduce((s, m) => s + (m.investorEarnings || 0), 0) / recentMonths.length
			: 0;
		const avgMonthlyInvestorEarnings = Math.round(
			monthsOfOperation > 0 && monthlyEarnings?.length
				? investorNetToDate / monthlyEarnings.length
				: 0
		);
		// Daily investor take-home: derived from monthly take-home across the
		// trailing window, divided by days in that window. This is more
		// accurate than `avgDailyRevenue / 2` because it already accounts for
		// the actual driver pay / fixed cost / trip expense mix per month.
		const trailingDays = recentMonths.length * 30;
		const avgDailyInvestorEarnings = trailingDays > 0
			? Math.round((recentMonths.reduce((s, m) => s + (m.investorEarnings || 0), 0) / trailingDays) * 100) / 100
			: 0;

		// Annotate every perTruckData entry with the investor-centric
		// numbers the frontend needs for ROI and break-even. For the
		// single-truck investor (the common case) this is just the fleet
		// totals. For multi-truck investors each truck gets an equal share;
		// true per-truck monthly tracking is a P1 enhancement.
		{
			const truckCount = Math.max(1, allOwnedTrucks.length);
			const perTruckMonthlyInvestor = Math.round(trailing3MonthInvestor / truckCount);
			const perTruckEstAnnualInvestor = Math.round(perTruckMonthlyInvestor * 12);
			for (const unit of Object.keys(perTruckData)) {
				const price = (allOwnedTrucks.find(t => t.unit_number === unit)?.purchase_price) || 0;
				perTruckData[unit].monthlyInvestorEarnings = perTruckMonthlyInvestor;
				perTruckData[unit].estAnnualInvestorRevenue = perTruckEstAnnualInvestor;
				perTruckData[unit].investorROI = price > 0
					? Math.round((perTruckEstAnnualInvestor / price) * 1000) / 10
					: 0;
				perTruckData[unit].breakEvenMonths = perTruckMonthlyInvestor > 0
					? Math.ceil(price / perTruckMonthlyInvestor)
					: null;
			}
		}

		res.json({
			production: {
				totalRevenue: Math.round(totalRevenue),
				avgDailyRevenue: Math.round(avgDailyRevenue),
				avgDailyInvestorEarnings,
				last30DaysRevenue: Math.round(last30DaysRevenue),
				monthlyData,
				avgMonthlyOwnerEarnings,
				avgMonthlyInvestorEarnings,
				trailing3MonthInvestor: Math.round(trailing3MonthInvestor),
				monthsOfOperation,
				investorSplitPct: parseFloat(config.investor_split_pct) || 50,
				totalJobs,
				completedJobs: completedJobCount,
				totalExpenses: Math.round(totalExpenses),
				investorEarnings: Math.round((totalRevenue - totalExpenses) / 2),
				investorNetToDate,
				totalDriverPay: Math.round(totalDriverPay),
				driverPayDetails: Object.fromEntries(Object.entries(driverPayDetails).map(([k, v]) => [k, { activeDays: v.activeDays, dailyRate: v.dailyRate, totalPay: v.totalPay }])),
				netRevenueToDate,
				totalPurchasePrice,
				totalStartupExpenses,
				perTruckData,
				monthlyEarnings,
				fixedCostBreakdown,
			},
			asset: {
				purchasePrice,
				currentValue,
				titleStatus,
				depreciationYears,
				annualDepreciation: Math.round(totalPurchasePrice / depreciationYears),
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
				completedJobs: completedJobCount,
			},
			config,
			investor: investorProfile ? {
				id: investorProfile.id,
				profilePictureUrl: investorProfile.profile_picture_url || "",
			} : null,
		});
	} catch (error) {
		console.error("Error building investor data:", error.message);
		res.status(500).json({ error: error.message });
	}
});

// GET /api/financials — Super Admin financials dashboard (P1-1 from 2026-04-12 meeting)
// Deshorn asked for a financial overview tab showing expense categories, highest/lowest
// loads, per-truck macro view, rate-per-mile, and a driver earnings leaderboard. Reuses
// the job-tracking cache + the same aggregation primitives as /api/investor but without
// the investor-owner filter (Super Admin sees the whole fleet).
app.get("/api/financials", requireRole("Super Admin"), async (req, res) => {
	try {
		const jobTracking = await getJobTrackingCached();

		// Column resolution (same regex as investor endpoint)
		const jtRateCol = findCol(jobTracking.headers, /payment|rate|amount|revenue/i);
		const jtDateCol = findCol(jobTracking.headers, /status.*update.*date|completion.*date|assigned.*date/i)
			|| findCol(jobTracking.headers, /date/i);
		const jtDriverCol = findCol(jobTracking.headers, /^driver$/i);
		const jtTruckCol = findCol(jobTracking.headers, /^truck$|truck[._\s-]?(unit|number|#)|unit[._\s-]?number/i);
		// Intentionally stricter than /api/investor's /status/i so we never
		// accidentally match "Status Update Date". Production sheet uses
		// "Job Status" as the actual header, which is handled here. Same
		// fix pattern as the P0-8 invoice endpoint regex.
		const statusCol = findCol(jobTracking.headers, /^(job[\s._-]?)?status$/i);
		const pickupDateCol = findCol(jobTracking.headers, /pickup.*appo|pickup.*date/i);
		const dropoffDateCol = findCol(jobTracking.headers, /drop.?off.*appo|drop.?off.*date|delivery.*date/i);
		const loadIdCol = findCol(jobTracking.headers, /load.?id|job.?id/i);
		const completedStatuses = /^(delivered|completed|pod received)$/i;
		const activeWorkStatuses = /^(in transit|dispatched|assigned|picked up|at shipper|at receiver|loading|unloading|delivered|completed|pod received)$/i;

		function parseSheetDate(val) {
			if (!val) return null;
			const m = String(val).match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
			if (!m) return null;
			let yr = parseInt(m[3]);
			if (yr < 100) yr += 2000;
			const d = new Date(yr, parseInt(m[1]) - 1, parseInt(m[2]));
			return isNaN(d) ? null : d;
		}
		function fmtDate(d) {
			return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
		}
		function expandDateRange(start, end) {
			const dates = [];
			const s = new Date(start); s.setHours(12, 0, 0, 0);
			const e = end ? new Date(end) : new Date(start);
			e.setHours(12, 0, 0, 0);
			if (e < s) return [fmtDate(s)];
			const MAX_SPAN = 31 * 24 * 3600 * 1000;
			if (e - s > MAX_SPAN) e.setTime(s.getTime() + MAX_SPAN);
			const cur = new Date(s);
			while (cur <= e) {
				dates.push(fmtDate(cur));
				cur.setDate(cur.getDate() + 1);
			}
			return dates;
		}

		// ---- Miles source: load_coordinates table ----
		// Prefer real road distance from Google Routes API (cached in
		// distance_miles column, populated via /api/admin/backfill-road-
		// distances). Fall back to haversine straight-line for any row
		// where the backfill hasn't run yet. Old odometer-based miles
		// were always $0 because drivers rarely filled the odometer field.
		const milesByLoadId = {};
		let roadMilesCount = 0;
		let haversineMilesCount = 0;
		{
			const coordRows = db.prepare(
				"SELECT load_id, origin_lat, origin_lng, dest_lat, dest_lng, distance_miles FROM load_coordinates WHERE origin_lat IS NOT NULL AND dest_lat IS NOT NULL"
			).all();
			for (const c of coordRows) {
				if (c.distance_miles != null && c.distance_miles > 0) {
					milesByLoadId[(c.load_id || "").toLowerCase()] = c.distance_miles;
					roadMilesCount++;
				} else {
					const meters = geolib.getDistance(
						{ latitude: c.origin_lat, longitude: c.origin_lng },
						{ latitude: c.dest_lat, longitude: c.dest_lng }
					);
					milesByLoadId[(c.load_id || "").toLowerCase()] = meters / 1609.344;
					haversineMilesCount++;
				}
			}
		}

		// ---- Single-pass aggregation across all loads ----
		let totalRevenue = 0;
		let earliestDate = null;
		let latestDate = null;
		let completedRowCount = 0;       // row-level count — matches /api/investor.completedJobs
		// Unassigned revenue: completed loads where the Driver column is blank.
		// Tracked separately so the leaderboard sum reconciles with totalRevenue
		// AND so Deshorn can see a data-quality signal (loads that never got
		// attributed to a real driver).
		let unassignedGross = 0;
		let unassignedLoadCount = 0;
		let unassignedMiles = 0;
		const completedLoadIds = new Set();  // unique load IDs — used for expense matching
		const grossByDriver = {};
		const milesByDriver = {};        // sum of haversine miles per driver
		const milesByTruck = {};         // sum of haversine miles per truck
		let fleetTotalMiles = 0;
		let loadsWithCoords = 0;         // data-quality signal
		const loadsByDriver = {};
		const loadsByTruck = {};
		const driverDaySets = {};
		const completedLoads = []; // for highest/lowest — store minimal fields
		const now = new Date();

		jobTracking.data.forEach((r) => {
			const st = statusCol ? (r[statusCol] || "").trim() : "";
			const driver = jtDriverCol ? (r[jtDriverCol] || "").trim() : "";
			const driverLc = driver.toLowerCase();
			const truckUnit = jtTruckCol ? (r[jtTruckCol] || "").trim().toLowerCase() : "";

			// Operating period
			if (jtDateCol && r[jtDateCol]) {
				const d = parseSheetDate(r[jtDateCol]) || new Date(r[jtDateCol]);
				if (d && !isNaN(d)) {
					if (!earliestDate || d < earliestDate) earliestDate = d;
					if (!latestDate || d > latestDate) latestDate = d;
				}
			}

			// Revenue + completed-load list
			if (completedStatuses.test(st)) {
				completedRowCount++;
				if (driverLc) loadsByDriver[driverLc] = (loadsByDriver[driverLc] || 0) + 1;
				if (truckUnit) loadsByTruck[truckUnit] = (loadsByTruck[truckUnit] || 0) + 1;
				const amt = parseFloat(String((jtRateCol ? r[jtRateCol] : "0")).replace(/[$,]/g, "")) || 0;
				if (amt) {
					const lid = loadIdCol ? (r[loadIdCol] || "").trim() : "";
					if (lid) completedLoadIds.add(lid);
					totalRevenue += amt;
					if (driverLc) {
						grossByDriver[driverLc] = (grossByDriver[driverLc] || 0) + amt;
					} else {
						unassignedGross += amt;
						unassignedLoadCount += 1;
					}
					// Miles for this load (straight-line from load_coordinates).
					// Loads without coordinates contribute 0 — counted separately
					// as loadsWithCoords so the frontend can show coverage %.
					const loadMiles = milesByLoadId[lid.toLowerCase()] || 0;
					if (loadMiles > 0) {
						loadsWithCoords++;
						fleetTotalMiles += loadMiles;
						if (driverLc) {
							milesByDriver[driverLc] = (milesByDriver[driverLc] || 0) + loadMiles;
						} else {
							unassignedMiles += loadMiles;
						}
						if (truckUnit) milesByTruck[truckUnit] = (milesByTruck[truckUnit] || 0) + loadMiles;
					}
					// Capture for highest/lowest. Use display name for driver (not lowercase).
					const dateStr = jtDateCol && r[jtDateCol] ? String(r[jtDateCol]) : "";
					completedLoads.push({
						loadId: lid || `#${completedLoads.length + 1}`,
						driver: driver || "(unknown)",
						amount: amt,
						date: dateStr,
					});
				}
			}

			// Active-day sets for driver pay
			if (activeWorkStatuses.test(st) && driverLc) {
				const pickup = parseSheetDate(pickupDateCol ? r[pickupDateCol] : null);
				const dropoff = parseSheetDate(dropoffDateCol ? r[dropoffDateCol] : null);
				if (pickup) {
					const days = expandDateRange(pickup, dropoff || pickup);
					if (!driverDaySets[driverLc]) driverDaySets[driverLc] = new Set();
					days.forEach(d => driverDaySets[driverLc].add(d));
				}
			}
		});

		let monthsOfOperation = 1;
		if (earliestDate && latestDate) {
			monthsOfOperation = Math.max(1,
				(latestDate.getFullYear() - earliestDate.getFullYear()) * 12
				+ (latestDate.getMonth() - earliestDate.getMonth()) + 1
			);
		}

		// ---- Expense totals (entire fleet, no filter) ----
		const expByCategory = Object.fromEntries(
			db.prepare(`SELECT LOWER(type) AS cat, COALESCE(SUM(amount),0) AS t FROM expenses GROUP BY LOWER(type)`).all().map(r => [r.cat || "other", r.t])
		);
		const totalTripExpenses = Object.values(expByCategory).reduce((s, v) => s + v, 0);

		// Monthly expenses by category
		const monthlyCategoryRows = db.prepare(
			`SELECT strftime('%Y-%m', date) AS m, LOWER(type) AS cat, COALESCE(SUM(amount),0) AS t
			 FROM expenses WHERE date IS NOT NULL AND date != '' GROUP BY m, LOWER(type) ORDER BY m ASC`
		).all();
		const expensesByMonthMap = {};
		monthlyCategoryRows.forEach(r => {
			if (!r.m) return;
			if (!expensesByMonthMap[r.m]) expensesByMonthMap[r.m] = { month: r.m, fuel: 0, maintenance: 0, repair: 0, toll: 0, food: 0, other: 0 };
			const key = (r.cat in expensesByMonthMap[r.m]) ? r.cat : "other";
			expensesByMonthMap[r.m][key] += r.t;
		});
		const expensesByMonth = Object.values(expensesByMonthMap);

		// Maintenance fund + compliance fees (truck-level) roll into totalExpenses
		const maintSum = db.prepare(`SELECT COALESCE(SUM(amount),0) AS t FROM maintenance_fund WHERE type='service'`).get().t;
		const compSum = db.prepare(`SELECT COALESCE(SUM(amount),0) AS t FROM compliance_fees WHERE status='Paid'`).get().t;

		// ---- Driver pay from active-day sets ----
		const trucksByDriver = {};
		db.prepare("SELECT assigned_driver, driver_pay_daily FROM trucks").all().forEach(t => {
			const d = (t.assigned_driver || "").trim().toLowerCase();
			if (d) trucksByDriver[d] = t.driver_pay_daily || 250;
		});
		const driverPayDetails = {};
		let totalDriverPay = 0;
		for (const [driver, daySet] of Object.entries(driverDaySets)) {
			const rate = trucksByDriver[driver] || 250;
			const activeDays = daySet.size;
			const pay = activeDays * rate;
			totalDriverPay += pay;
			driverPayDetails[driver] = { activeDays, dailyRate: rate, totalPay: pay };
		}

		// ---- Truck fixed costs ----
		const allTrucks = db.prepare("SELECT * FROM trucks").all();
		let totalFixedCosts = 0;
		for (const t of allTrucks) {
			const perMonth = (t.insurance_monthly || 0) + (t.eld_monthly || 0)
				+ ((t.hvut_annual || 0) / 12) + ((t.irp_annual || 0) / 12)
				+ (t.maintenance_fund_monthly || 0);
			let truckMonths = monthsOfOperation;
			if (t.created_at) {
				const td = new Date(t.created_at);
				if (!isNaN(td)) {
					truckMonths = Math.max(1, (now.getFullYear() - td.getFullYear()) * 12 + (now.getMonth() - td.getMonth()) + 1);
					truckMonths = Math.min(truckMonths, monthsOfOperation);
				}
			}
			totalFixedCosts += perMonth * truckMonths;
		}

		const totalExpenses = totalTripExpenses + maintSum + compSum + totalDriverPay + totalFixedCosts;
		const netProfit = totalRevenue - totalExpenses;

		// ---- Biggest expense category (compared across fuel/maint/repair/tolls/other) ----
		const catLabels = { fuel: "Fuel", maintenance: "Maintenance", repair: "Repair", toll: "Tolls", food: "Food", other: "Other" };
		let biggest = { name: "—", amount: 0 };
		for (const [cat, amt] of Object.entries(expByCategory)) {
			if (amt > biggest.amount) biggest = { name: catLabels[cat] || cat, amount: Math.round(amt) };
		}

		// ---- Per-Truck Performance ----
		const expByDriverRows = db.prepare(`SELECT LOWER(driver) AS d, COALESCE(SUM(amount),0) AS t FROM expenses GROUP BY LOWER(driver)`).all();
		const expByDriver = Object.fromEntries(expByDriverRows.map(r => [r.d, r.t]));
		const maintByTruck = Object.fromEntries(
			db.prepare(`SELECT LOWER(truck) AS u, COALESCE(SUM(amount),0) AS t FROM maintenance_fund WHERE type='service' GROUP BY LOWER(truck)`).all().map(r => [r.u, r.t])
		);
		const compByTruck = Object.fromEntries(
			db.prepare(`SELECT LOWER(truck) AS u, COALESCE(SUM(amount),0) AS t FROM compliance_fees WHERE status='Paid' GROUP BY LOWER(truck)`).all().map(r => [r.u, r.t])
		);

		const perTruck = allTrucks.map((truck) => {
			const driverName = (truck.assigned_driver || "").trim().toLowerCase();
			const unitLower = (truck.unit_number || "").toLowerCase();
			const gross = grossByDriver[driverName] || 0;
			const varExp = expByDriver[driverName] || 0;
			const maintExp = maintByTruck[unitLower] || 0;
			const compExp = compByTruck[unitLower] || 0;
			const fixedPerMonth = (truck.insurance_monthly || 0) + (truck.eld_monthly || 0)
				+ ((truck.hvut_annual || 0) / 12) + ((truck.irp_annual || 0) / 12)
				+ (truck.maintenance_fund_monthly || 0);
			let truckMonths = monthsOfOperation;
			if (truck.created_at) {
				const td = new Date(truck.created_at);
				if (!isNaN(td)) {
					truckMonths = Math.max(1, (now.getFullYear() - td.getFullYear()) * 12 + (now.getMonth() - td.getMonth()) + 1);
					truckMonths = Math.min(truckMonths, monthsOfOperation);
				}
			}
			const driverPay = driverPayDetails[driverName]?.totalPay || 0;
			const fixedTotal = fixedPerMonth * truckMonths;
			const expenses = varExp + maintExp + compExp + fixedTotal + driverPay;
			const net = gross - expenses;
			// Per-truck miles from haversine: prefer truck-column attribution,
			// fall back to driver attribution for loads that have no truck
			// column (same pattern as loadCount below).
			const truckMiles = milesByTruck[unitLower];
			const totalMiles = Math.round(
				truckMiles !== undefined ? truckMiles : (milesByDriver[driverName] || 0)
			);
			const ratePerMile = totalMiles > 0 ? Math.round((gross / totalMiles) * 100) / 100 : 0;
			const truckLoadCount = loadsByTruck[unitLower];
			const loadCount = (truckLoadCount !== undefined) ? truckLoadCount : (loadsByDriver[driverName] || 0);
			return {
				unitNumber: truck.unit_number,
				assignedDriver: truck.assigned_driver || "—",
				loadCount,
				gross: Math.round(gross),
				expenses: Math.round(expenses),
				net: Math.round(net),
				totalMiles,
				ratePerMile,
				monthlyCost: Math.round(fixedPerMonth),
			};
		});

		// ---- Highest + lowest paying loads ----
		// Guard against fewer than 10 completed loads: sliceStart below ensures
		// the "lowest" window never overlaps the "highest" window so a single
		// load never appears in both lists when the fleet is young.
		const sortedLoads = [...completedLoads].sort((a, b) => b.amount - a.amount);
		const highest = sortedLoads.slice(0, 5).map(l => ({ loadId: l.loadId, driver: l.driver, amount: Math.round(l.amount), date: l.date }));
		const lowestStart = Math.max(5, sortedLoads.length - 5);
		const lowest = sortedLoads.slice(lowestStart).reverse().map(l => ({ loadId: l.loadId, driver: l.driver, amount: Math.round(l.amount), date: l.date }));

		// ---- Driver earnings leaderboard ----
		// Use the driver's display name from the first row they appear in rather than lowercase
		const driverDisplayNames = {};
		jobTracking.data.forEach(r => {
			const d = jtDriverCol ? (r[jtDriverCol] || "").trim() : "";
			if (d && !driverDisplayNames[d.toLowerCase()]) driverDisplayNames[d.toLowerCase()] = d;
		});
		const drivers = Object.entries(grossByDriver).map(([lcName, gross]) => {
			const totalMiles = Math.round(milesByDriver[lcName] || 0);
			const pay = driverPayDetails[lcName]?.totalPay || 0;
			return {
				name: driverDisplayNames[lcName] || lcName,
				totalEarnings: Math.round(pay), // what the driver earned (their take)
				grossRevenue: Math.round(gross), // revenue the driver generated
				loadCount: loadsByDriver[lcName] || 0,
				totalMiles,
				avgRatePerMile: totalMiles > 0 ? Math.round((gross / totalMiles) * 100) / 100 : 0,
			};
		}).sort((a, b) => b.grossRevenue - a.grossRevenue);
		// Reconcile the leaderboard with totalRevenue: any completed revenue
		// from rows with a blank Driver column is surfaced as a single
		// "(Unassigned)" row at the bottom. Without this, sum(drivers) is
		// quietly less than totalRevenue whenever the sheet has data-quality
		// gaps — and the investor reading the dashboard has no way to tell.
		if (unassignedGross > 0) {
			const uMiles = Math.round(unassignedMiles);
			drivers.push({
				name: "(Unassigned)",
				totalEarnings: 0,
				grossRevenue: Math.round(unassignedGross),
				loadCount: unassignedLoadCount,
				totalMiles: uMiles,
				avgRatePerMile: uMiles > 0 ? Math.round((unassignedGross / uMiles) * 100) / 100 : 0,
				isUnassigned: true, // flag for frontend styling
			});
		}

		// Fleet-wide avg rate/mile — uses the haversine miles accumulated
		// in the single-pass loop, rounded to whole miles for the summary.
		const fleetTotalMilesRounded = Math.round(fleetTotalMiles);
		const avgRatePerMile = fleetTotalMilesRounded > 0
			? Math.round((totalRevenue / fleetTotalMilesRounded) * 100) / 100
			: 0;

		res.json({
			summary: {
				totalRevenue: Math.round(totalRevenue),
				totalExpenses: Math.round(totalExpenses),
				netProfit: Math.round(netProfit),
				biggestExpenseCategory: biggest,
				avgRatePerMile,
				totalMiles: fleetTotalMilesRounded,
				monthsOfOperation,
				// Row count (not unique load IDs) — consistent with totalRevenue
				// which also sums per-row, and matches /api/investor.completedJobs.
				completedLoadCount: completedRowCount,
				// Miles source breakdown: "road" if every coord row has a
				// cached Google Routes distance, "haversine" if none do,
				// "mixed" if some do. loadsWithCoords / completedRowCount =
				// coverage — non-100% means some completed loads have no
				// geocoded pickup/dropoff yet.
				milesSource: roadMilesCount > 0 && haversineMilesCount === 0
					? "road"
					: roadMilesCount === 0 ? "haversine" : "mixed",
				roadMilesLoadCount: roadMilesCount,
				haversineLoadCount: haversineMilesCount,
				loadsWithCoords,
				// Data-quality signal: completed revenue from rows with no
				// assigned driver. Non-zero means the sheet has attribution
				// gaps the investor should know about.
				unassignedRevenue: Math.round(unassignedGross),
				unassignedLoadCount,
			},
			expensesByCategory: Object.fromEntries(
				Object.entries(expByCategory).map(([k, v]) => [k, Math.round(v)])
			),
			expensesByMonth,
			perTruck,
			loads: { highest, lowest },
			drivers,
		});
	} catch (error) {
		console.error("GET /api/financials error:", error.message);
		res.status(500).json({ error: "Failed to load financials" });
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
		let sql = "SELECT id, timestamp, driver, load_id, type, amount, description, date, photo_data, status, gallons, odometer, truck_unit, created_at FROM expenses";
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

// GET /api/expenses/receipts-download — Super Admin downloads all receipts
// for a specific truck within a date range as a ZIP bundle. Returns both the
// receipt files (named by date + expense ID + load ID) and a manifest.csv
// with all metadata. Used for monthly accounting / tax review.
app.get("/api/expenses/receipts-download", requireRole("Super Admin"), (req, res) => {
	try {
		const { truck, from, to } = req.query;
		if (!truck || !from || !to) {
			return res.status(400).json({ error: "truck, from, and to query params are required (YYYY-MM-DD)" });
		}
		// Basic date format sanity check (YYYY-MM-DD). Anything else gets rejected.
		if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
			return res.status(400).json({ error: "Dates must be YYYY-MM-DD" });
		}
		if (to < from) {
			return res.status(400).json({ error: "'to' must be on or after 'from'" });
		}
		const expenses = db.prepare(
			`SELECT id, date, driver, load_id, type, amount, description, photo_data, gallons, odometer
			 FROM expenses
			 WHERE LOWER(truck_unit) = LOWER(?) AND date >= ? AND date <= ?
			 ORDER BY date ASC, id ASC`
		).all(truck, from, to);

		if (expenses.length === 0) {
			return res.status(404).json({ error: "No expenses found for that truck and date range" });
		}

		// Stream a zip directly to the response. Files referenced in
		// photo_data live under /uploads/expense-receipts/ — any row that
		// somehow points outside that directory is skipped for safety.
		const archiver = require("archiver");
		const safeTruck = truck.replace(/[^a-zA-Z0-9._-]/g, "_");
		const filename = `${safeTruck}-receipts-${from}-to-${to}.zip`;
		res.setHeader("Content-Type", "application/zip");
		res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

		const archive = archiver("zip", { zlib: { level: 9 } });
		// Error handler has to be installed BEFORE pipe() so early failures
		// surface as a JSON response. Once pipe() has flushed any bytes to
		// the client the headers are already sent, so a mid-stream failure
		// can only produce a truncated zip — we log it, but the client has
		// no clean way to know. Acceptable for a Super-Admin-only export.
		archive.on("error", (err) => {
			console.error("Receipt zip error:", err.message);
			if (!res.headersSent) res.status(500).json({ error: "Failed to build receipt archive" });
		});
		archive.pipe(res);

		// Manifest CSV — reviewer can open in Excel to reconcile the bundle
		const csvRows = ["date,expense_id,driver,load_id,type,amount,description,file_name"];
		const receiptsDir = path.join(__dirname, "uploads", "expense-receipts");
		let attachedCount = 0;
		for (const exp of expenses) {
			const p = exp.photo_data || "";
			let fileName = "";
			// Only accept photo_data rows that point at our expense-receipts
			// directory. This prevents path traversal (../../etc/passwd) or
			// any stray absolute path that might have been stored before the
			// disk-migration landed.
			if (p && p.startsWith("/uploads/expense-receipts/")) {
				const srcPath = path.join(__dirname, p.replace(/^\//, ""));
				if (srcPath.startsWith(receiptsDir) && fs.existsSync(srcPath)) {
					const ext = path.extname(srcPath).toLowerCase() || ".bin";
					fileName = `${exp.date}_exp-${exp.id}${exp.load_id ? "_load-" + exp.load_id : ""}${ext}`.replace(/[^a-zA-Z0-9._-]/g, "_");
					archive.file(srcPath, { name: `receipts/${fileName}` });
					attachedCount++;
				}
			}
			// CSV row: always include, so rows without a receipt file are still accounted for.
			// Prepend a single quote to any cell starting with =+-@\t to neutralize
			// Excel/Calc formula-injection (OWASP CSV injection).
			const csvCell = (v) => {
				let s = String(v ?? "");
				if (/^[=+\-@\t]/.test(s)) s = "'" + s;
				return `"${s.replace(/"/g, '""')}"`;
			};
			csvRows.push([
				exp.date, exp.id, exp.driver, exp.load_id, exp.type,
				Number(exp.amount || 0).toFixed(2),
				exp.description, fileName || "(no file)"
			].map(csvCell).join(","));
		}
		// RFC 4180 uses CRLF between rows so Excel on Windows parses it correctly.
		archive.append(csvRows.join("\r\n"), { name: "manifest.csv" });
		archive.finalize();
		console.log(`Receipt zip: ${truck} ${from}..${to} — ${expenses.length} rows, ${attachedCount} files`);
	} catch (err) {
		console.error("GET /api/expenses/receipts-download error:", err.message);
		if (!res.headersSent) res.status(500).json({ error: "Failed to download receipts" });
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
		notifyChange("expenses");
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

// Final error handler — catches anything that propagates via next(err) or
// uncaught throws inside async route handlers. Logs the full error server-side
// and returns a generic 500 to the client (never leaks err.message details).
// Per-route try/catch blocks still own their own error responses; this is the
// safety net that prevents stack traces from reaching API consumers.
app.use((err, req, res, next) => {
	if (res.headersSent) return next(err);
	console.error(`[unhandled] ${req.method} ${req.originalUrl}:`, err);
	res.status(500).json({ error: "Internal server error" });
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

		// Background: auto-geocode all load addresses
		(async () => {
			try {
				const sheets2 = await getSheets();
				const jtResp = await sheets2.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: "Job Tracking" });
				const jtRows = (jtResp.data.values || []);
				if (jtRows.length < 2) return;
				const hdr = jtRows[0];
				const lidIdx = hdr.findIndex(h => /load.?id|job.?id/i.test(h));
				const piIdx = hdr.findIndex(h => /pickup.*address/i.test(h));
				const doIdx = hdr.findIndex(h => /drop.?off.*address|dest.*address/i.test(h));
				const addresses = new Set();
				for (let i = 1; i < jtRows.length; i++) {
					if (lidIdx !== -1 && !(jtRows[i][lidIdx] || "").trim()) continue; // skip rows without Load ID
					if (piIdx !== -1) { const a = (jtRows[i][piIdx] || "").trim(); if (a) addresses.add(a); }
					if (doIdx !== -1) { const a = (jtRows[i][doIdx] || "").trim(); if (a) addresses.add(a); }
				}
				let geocoded = 0;
				for (const addr of addresses) {
					const cached = db.prepare("SELECT id FROM geocode_cache WHERE address = ?").get(addr.trim().toLowerCase());
					if (cached) continue;
					await geocodeAddress(addr);
					geocoded++;
					await new Promise(r => setTimeout(r, 60)); // rate limit
				}
				if (geocoded) console.log(`Auto-geocoded ${geocoded} addresses on startup`);

				// Populate load_coordinates from sheet + geocode_cache
				const existingCoords = db.prepare("SELECT COUNT(*) AS c FROM load_coordinates").get().c;
				const lidIdx2 = hdr.findIndex(h => /load.?id|job.?id/i.test(h));
				if (lidIdx2 !== -1) {
					const ins = db.prepare(`INSERT OR REPLACE INTO load_coordinates (load_id, origin_lat, origin_lng, dest_lat, dest_lng, pickup_address, dropoff_address) VALUES (?, ?, ?, ?, ?, ?, ?)`);
					let coordCount = 0;
					// Iterate bottom-up to get the most recent row per load ID
					const seenLids = new Set();
					for (let i = jtRows.length - 1; i >= 1; i--) {
						const lid = (jtRows[i][lidIdx2] || "").trim().toLowerCase().replace(/^#/, "");
						if (!lid || seenLids.has(lid)) continue;
						seenLids.add(lid);
						const pa = piIdx !== -1 ? (jtRows[i][piIdx] || "").trim() : "";
						const da = doIdx !== -1 ? (jtRows[i][doIdx] || "").trim() : "";
						const oCache = pa ? db.prepare("SELECT lat, lng FROM geocode_cache WHERE address = ?").get(pa.toLowerCase()) : null;
						const dCache = da ? db.prepare("SELECT lat, lng FROM geocode_cache WHERE address = ?").get(da.toLowerCase()) : null;
						if ((oCache && oCache.lat) || (dCache && dCache.lat)) {
							ins.run(lid, oCache?.lat || null, oCache?.lng || null, dCache?.lat || null, dCache?.lng || null, pa, da);
							coordCount++;
						}
					}
					if (coordCount) console.log(`Populated ${coordCount} load coordinates`);
				}
			} catch (err) {
				console.error("Auto-geocode error:", err.message);
			}
		})();
	} catch (error) {
		console.error(`Google Sheets connection FAILED: ${error.message}`);
		console.error("Server cannot operate without Google Sheets. Exiting.");
		process.exit(1);
	}
});

// Clean up the shared Puppeteer browser process on shutdown so pm2 restarts
// don't leak Chromium instances.
const { shutdownBrowser } = require("./lib/pdf-browser");
async function gracefulShutdown(signal) {
	console.log(`${signal} received — shutting down Puppeteer browser`);
	try { await shutdownBrowser(); } catch { /* ignore */ }
	process.exit(0);
}
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
