// One-off: seed the 4 demo trucks expected by seed-staging.js.
// Used when seed-staging.js failed mid-run (users got seeded, trucks didn't).
//
// Safe to re-run — uses INSERT OR IGNORE-style upserts.

const Database = require("better-sqlite3");
const db = new Database("app.db");

const kevin = db.prepare("SELECT id FROM users WHERE username = ?").get("kevin");
const deshorn = db.prepare("SELECT id FROM users WHERE username = ?").get("deshorn");
if (!kevin || !deshorn) {
	console.error("Run scripts/seed-staging.js first (need kevin + deshorn users).");
	process.exit(1);
}

const insert = db.prepare(`
	INSERT OR IGNORE INTO trucks (
		unit_number, make, model, year, vin, license_plate, status, assigned_driver, owner_id,
		purchase_price, title_status, maintenance_fund_monthly, insurance_monthly, eld_monthly,
		hvut_annual, irp_annual, driver_pay_daily, admin_fee_pct
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const trucks = [
	["TRK-101", "Freightliner", "Cascadia", 2022, "3AKJHHDR5NSLA1234", "TX-8472-KL", "Active",
		"Lesline Johnson", kevin.id, 58000, "Clean", 800, 250, 45, 550, 1800, 250, 50],
	["TRK-102", "Kenworth", "T680", 2023, "1XKYD49X1NJ456789", "TX-9381-MR", "Active",
		"Kenrick Davis", kevin.id, 65000, "Clean", 900, 275, 45, 550, 1800, 275, 50],
	["TRK-201", "Peterbilt", "579", 2021, "2NP2HJ7X5MM987654", "LA-5521-DK", "Active",
		"Andrew Raczkowski", deshorn.id, 52000, "Clean", 750, 230, 40, 550, 1600, 240, 50],
	["TRK-202", "Volvo", "VNL 760", 2024, "4V4NC9EH3RN112233", "LA-6632-DK", "Active",
		"Marcus Williams", deshorn.id, 72000, "Lien", 1000, 300, 50, 550, 2000, 280, 50],
];

let inserted = 0;
for (const t of trucks) {
	const r = insert.run(...t);
	if (r.changes) inserted++;
}

console.log(`Inserted ${inserted} trucks (skipped ${trucks.length - inserted} already present).`);
const rows = db.prepare("SELECT unit_number, assigned_driver, owner_id FROM trucks").all();
console.log(rows);
db.close();
