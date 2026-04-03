#!/usr/bin/env node
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");

const db = new Database("app.db");
const hash = bcrypt.hashSync("investor123", 10);

// -- Investors --
db.prepare("INSERT INTO users (username, password_hash, role, driver_name, email, full_name, company_name) VALUES (?, ?, ?, ?, ?, ?, ?)")
  .run("kevin", hash, "Investor", "", "kevin@gmail.com", "Kevin Canunayon", "KC Trucking LLC");
db.prepare("INSERT INTO users (username, password_hash, role, driver_name, email, full_name, company_name) VALUES (?, ?, ?, ?, ?, ?, ?)")
  .run("deshorn", hash, "Investor", "", "deshornking@gmail.com", "Deshorn King", "ABC Inc");

const kevin = db.prepare("SELECT id FROM users WHERE username = ?").get("kevin");
const deshorn = db.prepare("SELECT id FROM users WHERE username = ?").get("deshorn");

// -- Drivers --
db.prepare("INSERT INTO users (username, password_hash, role, driver_name, email, full_name) VALUES (?, ?, ?, ?, ?, ?)")
  .run("lesline", hash, "Driver", "Lesline Johnson", "leslinejohnson@gmail.com", "Lesline Johnson");
db.prepare("INSERT INTO users (username, password_hash, role, driver_name, email, full_name) VALUES (?, ?, ?, ?, ?, ?)")
  .run("kenrick", hash, "Driver", "Kenrick Davis", "kenrickdavis@gmail.com", "Kenrick Davis");
db.prepare("INSERT INTO users (username, password_hash, role, driver_name, email, full_name) VALUES (?, ?, ?, ?, ?, ?)")
  .run("andrew", hash, "Driver", "Andrew Raczkowski", "andrewracz@gmail.com", "Andrew Raczkowski");
db.prepare("INSERT INTO users (username, password_hash, role, driver_name, email, full_name) VALUES (?, ?, ?, ?, ?, ?)")
  .run("marcus", hash, "Driver", "Marcus Williams", "marcuswilliams@gmail.com", "Marcus Williams");

// -- Dispatcher --
db.prepare("INSERT INTO users (username, password_hash, role, driver_name, email, full_name) VALUES (?, ?, ?, ?, ?, ?)")
  .run("dispatch1", hash, "Dispatcher", "", "dispatch@logisx.com", "Azure Estelle");

// -- Kevin's trucks (2) --
db.prepare(`INSERT INTO trucks (unit_number, make, model, year, vin, license_plate, status, assigned_driver, owner_id,
  purchase_price, title_status, maintenance_fund_monthly, insurance_monthly, eld_monthly, hvut_annual, irp_annual, driver_pay_daily, admin_fee_pct)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  .run("TRK-101", "Freightliner", "Cascadia", 2022, "3AKJHHDR5NSLA1234", "TX-8472-KL", "Active",
    "Lesline Johnson", kevin.id, 58000, "Clean", 800, 250, 45, 550, 1800, 250, 50);

db.prepare(`INSERT INTO trucks (unit_number, make, model, year, vin, license_plate, status, assigned_driver, owner_id,
  purchase_price, title_status, maintenance_fund_monthly, insurance_monthly, eld_monthly, hvut_annual, irp_annual, driver_pay_daily, admin_fee_pct)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  .run("TRK-102", "Kenworth", "T680", 2023, "1XKYD49X1NJ456789", "TX-9381-MR", "Active",
    "Kenrick Davis", kevin.id, 65000, "Clean", 900, 275, 45, 550, 1800, 275, 50);

// -- Deshorn's trucks (2) --
db.prepare(`INSERT INTO trucks (unit_number, make, model, year, vin, license_plate, status, assigned_driver, owner_id,
  purchase_price, title_status, maintenance_fund_monthly, insurance_monthly, eld_monthly, hvut_annual, irp_annual, driver_pay_daily, admin_fee_pct)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  .run("TRK-201", "Peterbilt", "579", 2021, "2NP2HJ7X5MM987654", "LA-5521-DK", "Active",
    "Andrew Raczkowski", deshorn.id, 52000, "Clean", 750, 230, 40, 550, 1600, 240, 50);

db.prepare(`INSERT INTO trucks (unit_number, make, model, year, vin, license_plate, status, assigned_driver, owner_id,
  purchase_price, title_status, maintenance_fund_monthly, insurance_monthly, eld_monthly, hvut_annual, irp_annual, driver_pay_daily, admin_fee_pct)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  .run("TRK-202", "Volvo", "VNL 760", 2024, "4V4NC9EH3RN112233", "LA-6632-DK", "Active",
    "Marcus Williams", deshorn.id, 72000, "Lien", 1000, 300, 50, 550, 2000, 280, 50);

// -- Print summary --
const users = db.prepare("SELECT id, username, role, full_name, company_name FROM users WHERE role != 'Super Admin'").all();
const trucks = db.prepare("SELECT unit_number, make, model, assigned_driver, owner_id, purchase_price FROM trucks").all();

console.log("\n=== STAGING TEST DATA ===\n");
console.log("Users (password: investor123 for all):");
users.forEach(u => console.log(`  [${u.id}] ${u.username} (${u.role}) - ${u.full_name} ${u.company_name ? '@ ' + u.company_name : ''}`));
console.log("\nTrucks:");
trucks.forEach(t => console.log(`  ${t.unit_number} ${t.make} ${t.model} | Driver: ${t.assigned_driver} | Owner ID: ${t.owner_id} | $${t.purchase_price}`));
console.log("\nDone!");
