#!/usr/bin/env node
// The walkthrough video's made-up driver, planted into a fresh made-up e2e database BEFORE the
// recording server boots on it. Every value comes from DEMO (storyboard.cjs).
//
//   node scripts/e2e/walkthrough/plant.cjs <db>
//
// 1. Refuses unless <db> is in the work dir, no process has it open, the logins file says
//    setup-db.cjs made it up ("seed": "made-up"), no server has booted on it yet (no
//    <db>.sheets.json) and it holds no walkthrough driver.
// 2. Boots a short-lived server on it (boot-server.sh, no client; it starts the run's copy of
//    the made-up Sheets fixture), signs in as the seed's Super Admin (Keychain), makes the driver
//    (POST /api/users) and the truck (POST /api/trucks), and stops it by its recorded PID
//    (stop-server.sh), as seed-made-up.cjs does. This comes first: the truck route refuses to
//    assign a driver who already has an active load in the sheet.
// 3. With the server stopped, adds DEMO's three loads, dated from today, to that sheet copy.
// 4. Still stopped, writes the rows no route makes directly: the accepted
//    application and onboarding (fully onboarded 60 days ago), the five signed contracts, the
//    directory row's contact fields, two truck documents, alerts, two messages and last
//    week's invoice.
// The driver's password goes to the Keychain (E2E_KEYCHAIN_SERVICE, account walkthroughDriver)
// before the account is made; its name and id go to <work dir>/walkthrough-login.json (0600).
// The password is never printed or written to a file.
"use strict";
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const paths = require("../paths.cjs");
const keychain = require("../keychain.cjs");
const { appDayKey, appDayStartIso } = require("../app-day.cjs");
const { client, freePort, runScript, stopSeedServer, madeUpJpeg } = require("../seed-made-up.cjs");
const { DEMO } = require("./storyboard.cjs");

const KEYCHAIN_ACCOUNT = "walkthroughDriver";
const LOGIN_FILE = "walkthrough-login.json";
// The server's ONBOARDING_DOCS, as the Kit lists them once signed.
const CONTRACTS = [
	{ key: "contractor_agreement", name: "Contractor Agreement", confidential: 1 },
	{ key: "equipment_policy", name: "Contracted Provider Equipment Policy", confidential: 0 },
	{ key: "w9", name: "W-9 Tax Form", confidential: 1 },
	{ key: "mobile_policy", name: "LogisX Inc. Mobile Policy", confidential: 0 },
	{ key: "substance_policy", name: "Substance Policy and Procedure", confidential: 0 },
];

function fail(msg, code = 2) {
	console.error(`plant: ${msg}`);
	process.exit(code);
}

// Day arithmetic on business-day keys, anchored at noon UTC so no zone moves the date.
function addDays(dayKey, n) {
	const d = new Date(`${dayKey}T12:00:00Z`);
	d.setUTCDate(d.getUTCDate() + n);
	return d.toISOString().slice(0, 10);
}
const sheetDate = (dayKey) => { const [y, m, d] = dayKey.split("-"); return `${Number(m)}/${Number(d)}/${y}`; };
const sqliteStamp = (ms) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);

// The last full Saturday-to-Friday week before today (the driver app's invoice week).
function lastInvoiceWeek(today) {
	const dow = new Date(`${today}T12:00:00Z`).getUTCDay(); // 0 Sunday .. 6 Saturday
	const lastFriday = addDays(today, -(((dow - 5 + 7) % 7) || 7));
	return { start: addDays(lastFriday, -6), end: lastFriday };
}

// A small PNG drawn here: a pale card with a grey photo box and text bars, so the Kit's CDL
// thumbnail reads as a placeholder and never as a real licence.
function placeholderIdPng(width = 240, height = 152) {
	const raw = Buffer.alloc((width * 3 + 1) * height);
	const px = (x, y, [r, g, b]) => { const i = y * (width * 3 + 1) + 1 + x * 3; raw[i] = r; raw[i + 1] = g; raw[i + 2] = b; };
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			let c = [236, 241, 247];
			if (y < 22) c = [58, 92, 140];
			else if (x >= 14 && x < 74 && y >= 34 && y < 112) c = [176, 184, 196];
			else if (x >= 88 && x < 220 && [40, 58, 76, 94].some((t) => y >= t && y < t + 8)) c = [196, 204, 214];
			if (x < 2 || y < 2 || x >= width - 2 || y >= height - 2) c = [150, 160, 172];
			px(x, y, c);
		}
	}
	const chunk = (type, data) => {
		const len = Buffer.alloc(4);
		len.writeUInt32BE(data.length);
		const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(zlib.crc32(body) >>> 0);
		return Buffer.concat([len, body, crc]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = 2;
	const png = Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", zlib.deflateSync(raw)),
		chunk("IEND", Buffer.alloc(0)),
	]);
	return `data:image/png;base64,${png.toString("base64")}`;
}

// A copy of the Sheets book with DEMO's loads added, as the Google stand-in reads it
// (boot-server.sh keeps an existing <db>.sheets.json). Pure: `source` is not changed.
function sheetsWithDemo(source, today) {
	const book = JSON.parse(JSON.stringify(source));
	const main = Object.values(book.spreadsheets).find((s) => s.role === "main");
	if (!main) throw new Error("the Sheets copy has no main book");
	const tab = (title) => main.sheets.find((s) => s.properties.title === title);
	const jt = tab("Job Tracking");
	const pay = tab("Payments Table");
	const headers = jt.values[0];
	const idCol = headers.indexOf("Load ID");
	const held = DEMO.loads.filter((l) => jt.values.some((r) => r[idCol] === l.id)).map((l) => l.id);
	if (held.length) throw new Error(`the Sheets copy already holds ${held.join(", ")}`);
	for (const l of DEMO.loads) {
		const cell = {
			"Load ID": l.id, Details: l.details, "Trailer Number": l.trailer, Driver: DEMO.driver.name,
			"Pickup Info": l.pickupInfo, "Pickup Address": l.pickupAddress, "Pickup Appointment": `${sheetDate(addDays(today, l.pickupDay))} ${l.pickupTime}`,
			"Drop-off Info": l.dropInfo, "Drop-off Address": l.dropAddress, "Drop-off Appointment": `${sheetDate(addDays(today, l.dropDay))} ${l.dropTime}`,
			"Job Status": l.status, "Assigned Date": sheetDate(addDays(today, l.assignedDay)),
			"Status Update Date": l.completedDay !== null ? sheetDate(addDays(today, l.completedDay)) : l.status === "Dispatched" ? "" : sheetDate(today),
			"Completion Date": l.completedDay !== null ? sheetDate(addDays(today, l.completedDay)) : "",
			"  Payment  ": l.payment, Truck: DEMO.truck.unit, "Owner ID": "0",
		};
		jt.values.push(headers.map((h) => (h in cell ? cell[h] : "")));
		pay.values.push([l.id, "", l.payment]);
	}
	book.note = `${book.note} Plus the driver app walkthrough's made-up loads (scripts/e2e/walkthrough/plant.cjs).`;
	return book;
}

async function makeAccountAndTruck({ WORK, dbAbs, sa, password }) {
	const checkout = path.resolve(process.env.E2E_SEED_CHECKOUT || paths.REPO);
	const port = await freePort();
	const env = { ...process.env, NODE_BIN: process.execPath, E2E_WORK_DIR: WORK, E2E_NO_CLIENT: "1" };
	for (const k of ["E2E_MAINTENANCE_NOTICE", "E2E_FAKE_GMAIL", "E2E_DRIVER_INSTRUCTIONS_DENY", "INVESTOR_LEASE_PAYOUTS_ENABLED"]) delete env[k];
	const log = (line) => console.log(`plant: ${line}`);
	let ids = null;
	try {
		const boot = runScript("boot-server.sh", [checkout, String(port), dbAbs], env);
		if (boot.status !== 0) {
			throw new Error(`the plant server did not boot (boot-server.sh exit ${boot.status}): ${String(boot.stderr || boot.stdout || "").trim().split("\n").slice(-3).join(" | ")}`);
		}
		log(`a short-lived server from ${checkout} on 127.0.0.1:${port} (made-up settings, no client)`);
		const api = client(`http://127.0.0.1:${port}`);
		const login = await api("POST", "/api/auth/login", { username: sa.username, password: sa.password });
		if (login.status !== 200) throw new Error(`the seed's Super Admin sign-in answered ${login.status}`);
		const d = DEMO.driver;
		const u = await api("POST", "/api/users", { username: d.username, password, role: "Driver", email: d.email, fullName: d.name, driverName: d.name });
		if (u.status !== 200) throw new Error(`POST /api/users answered ${u.status} ${u.json && u.json.error ? u.json.error : ""}`);
		const t = await api("POST", "/api/trucks", {
			unitNumber: DEMO.truck.unit, make: DEMO.truck.make, model: DEMO.truck.model, year: DEMO.truck.year,
			assignedDriver: d.name, photo: await madeUpJpeg(), notes: "Made-up truck for the driver app walkthrough video",
		});
		if (t.status !== 200 || !t.json || !t.json.id) throw new Error(`POST /api/trucks answered ${t.status} ${t.json && t.json.error ? t.json.error : ""}`);
		await api("POST", "/api/auth/logout");
		ids = { truckId: t.json.id };
		log(`driver ${d.username} through POST /api/users; truck ${DEMO.truck.unit} (id ${t.json.id}) through POST /api/trucks`);
	} finally {
		await stopSeedServer(port, env, log, checkout);
		fs.rmSync(path.join(WORK, `server-${port}.log`), { force: true });
	}
	return ids;
}

function writeRows(db, { userId, truckId, today }) {
	const d = DEMO.driver;
	const now = Date.now();
	const day = 86_400_000;
	const onboardedMs = now - d.onboardedDaysAgo * day;
	const nameLower = d.name.toLowerCase();
	db.prepare("UPDATE users SET must_change_password = 0 WHERE id = ?").run(userId);
	db.prepare("DELETE FROM sessions").run();

	const app = db.prepare(`INSERT INTO job_applications
		(full_name, email, phone, dob, address, ssn, drivers_license, position, experience, has_cdl, work_authorized,
		 felony_convicted, accident_history, skills, signature, status, cdl_front, city, state, zip)
		VALUES (?, ?, ?, '1980-01-01', '1 Example Ct', '', '', 'Driver', '10 years', 'Yes', 'Yes', 'No', 'No', 'Made-up', ?, 'Accepted', ?, ?, ?, '')`)
		.run(d.name, d.email, d.phone, d.name, placeholderIdPng(), d.city, d.state);
	const applicationId = Number(app.lastInsertRowid);
	db.prepare("INSERT INTO driver_onboarding (user_id, application_id, driver_name, status, onboarded_at) VALUES (?, ?, ?, 'fully_onboarded', ?)")
		.run(userId, applicationId, d.name, new Date(onboardedMs).toISOString());
	const signedAt = new Date(onboardedMs - day).toISOString();
	const contract = db.prepare(`INSERT INTO onboarding_documents (user_id, doc_key, doc_name, signed, signature_text, signed_at, confidential, signed_pdf_url)
		VALUES (?, ?, ?, 1, ?, ?, ?, ?)`);
	for (const c of CONTRACTS) contract.run(userId, c.key, c.name, d.name, signedAt, c.confidential, `/uploads/onboarding-signed/walkthrough-sample-${c.key}.pdf`);

	const dir = db.prepare(`UPDATE drivers_directory SET phone = ?, email = ?, city = ?, state = ?, trucks = ?, status = 'active'
		WHERE LOWER(driver_name) = LOWER(?)`).run(d.phone, d.email, d.city, d.state, DEMO.truck.unit, d.name);
	if (dir.changes !== 1) throw new Error(`expected POST /api/users to have made one directory row for ${d.name}, found ${dir.changes}`);

	const open = db.prepare("SELECT id FROM truck_assignments WHERE truck_id = ? AND LOWER(driver_name) = LOWER(?) AND COALESCE(end_date, '') = ''").all(truckId, d.name);
	if (open.length !== 1) throw new Error(`truck ${DEMO.truck.unit} has ${open.length} open assignment(s) to ${d.name}, not one`);
	// From the onboarding day, so the assignment covers every DEMO load's dates.
	db.prepare("UPDATE truck_assignments SET start_date = ? WHERE id = ?").run(appDayStartIso(addDays(today, -d.onboardedDaysAgo)), open[0].id);

	const doc = db.prepare(`INSERT INTO legal_documents (truck_id, unit_number, doc_type, file_name, file_url, notes, uploaded_by, uploaded_at, visible_to_driver, driver_id, investor_id)
		VALUES (?, ?, ?, ?, '', ?, 'qa-e2e-admin', ?, 1, 0, 0)`);
	DEMO.truckDocuments.forEach((t, i) => doc.run(truckId, DEMO.truck.unit, t.docType, t.fileName, t.notes, sqliteStamp(onboardedMs + (i + 1) * day)));

	// Oldest first: Alerts lists by id, newest at the top.
	const note = db.prepare("INSERT INTO notifications (driver_name, type, title, body, metadata, read, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
	for (const n of [...DEMO.notifications].sort((a, b) => b.minutesAgo - a.minutesAgo)) note.run(nameLower, n.type, n.title, n.body, "{}", n.read ? 1 : 0, sqliteStamp(now - n.minutesAgo * 60_000));

	const active = DEMO.loads.find((l) => l.key === "active");
	const msg = db.prepare(`INSERT INTO messages (timestamp, "from", "to", message, load_id, read, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
	for (const m of [...DEMO.messages].sort((a, b) => b.minutesAgo - a.minutesAgo)) {
		const at = now - m.minutesAgo * 60_000;
		const [from, to] = m.from === "driver" ? [d.name, DEMO.dispatch] : [DEMO.dispatch, d.name];
		msg.run(new Date(at).toISOString(), from, to, m.text, active.id, m.read ? 1 : 0, sqliteStamp(at));
	}

	const week = lastInvoiceWeek(today);
	const inv = DEMO.invoice;
	const delivered = DEMO.loads.find((l) => l.key === "delivered");
	const submittedAt = appDayStartIso(addDays(week.end, 1));
	db.prepare(`INSERT INTO invoices (invoice_number, driver, week_start, week_end, loads_count, rate_per_load, total_earnings, expenses_total, status, submitted_at, load_ids, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
		.run(inv.number, d.name, week.start, week.end, inv.days, inv.ratePerDay, inv.earnings, inv.receipts, inv.status, submittedAt,
			JSON.stringify([delivered.id]), sqliteStamp(Date.parse(submittedAt)));
	return { applicationId, week };
}

async function main() {
	const dbArg = process.argv.slice(2).find((a) => !a.startsWith("--"));
	if (!dbArg) fail("usage: node scripts/e2e/walkthrough/plant.cjs <db>  (a made-up database setup-db.cjs made in the work dir)");
	paths.warnNodeVersion("plant");
	let WORK, dbAbs, Database;
	try {
		WORK = paths.workDir();
		dbAbs = paths.workFile(dbArg);
		Database = paths.appRequire("better-sqlite3");
		keychain.requireSecurity();
	} catch (e) {
		fail(e.message);
	}
	let holders = "";
	try {
		holders = execFileSync("lsof", ["-t", "--", dbAbs], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch { /* no process has it open */ }
	if (holders) fail(`refusing: process(es) ${holders.split(/\s+/).join(", ")} have ${dbAbs} open; plant before the recording server boots`);
	const sheetsCopy = `${dbAbs}.sheets.json`;
	if (fs.existsSync(sheetsCopy)) fail(`refusing: ${sheetsCopy} exists, so a server has booted on this database. Make a fresh one: setup-db.cjs ${dbArg} --force`);

	let logins;
	try {
		logins = keychain.loadLogins(keychain.loginsFile(WORK));
	} catch (e) {
		fail(`logins: ${e.message}`);
	}
	if (logins.seed !== "made-up") fail(`refusing: the logins file says this work dir's seed is "${logins.seed}", not "made-up". The walkthrough is filmed on the made-up seed only`);
	if (!(logins.dbs || []).includes(dbAbs)) fail(`refusing: setup-db.cjs did not make ${dbAbs} (not in the logins file's dbs)`);
	if (!logins.superAdmin) fail("the logins file has no Super Admin");

	{
		const db = new Database(dbAbs, { fileMustExist: true, readonly: true });
		const taken = db.prepare("SELECT id FROM users WHERE LOWER(username) = LOWER(?) OR LOWER(COALESCE(driver_name, '')) = LOWER(?)").all(DEMO.driver.username, DEMO.driver.name);
		db.close();
		if (taken.length) fail(`refusing: ${dbAbs} already holds the walkthrough driver (user #${taken.map((r) => r.id).join(", #")}). Make a fresh one: setup-db.cjs ${dbArg} --force`);
	}

	const today = appDayKey();
	console.log(`plant: work dir ${WORK}; database ${dbAbs}; business day ${today}`);

	const item = { service: keychain.DEFAULT_SERVICE(), account: KEYCHAIN_ACCOUNT };
	const password = crypto.randomBytes(18).toString("base64url");
	try {
		keychain.storePassword(item, password);
	} catch (e) {
		fail(`Keychain: ${e.message}`);
	}
	console.log(`plant: the driver's password is in the Keychain (service ${item.service}, account ${item.account}); not printed`);

	let made;
	try {
		made = await makeAccountAndTruck({ WORK, dbAbs, sa: logins.superAdmin, password });
		// The copy the plant server's boot made (and may have written), with DEMO's loads added.
		let st = null;
		try { st = fs.lstatSync(sheetsCopy); } catch { /* reported below */ }
		if (!st || !st.isFile()) throw new Error(`${sheetsCopy} is missing or not a plain file after the plant server's boot`);
		const book = sheetsWithDemo(JSON.parse(fs.readFileSync(sheetsCopy, "utf8")), today);
		fs.writeFileSync(sheetsCopy, JSON.stringify(book, null, 1) + "\n", { mode: 0o600 });
		fs.chmodSync(sheetsCopy, 0o600);
		console.log(`plant: ${sheetsCopy}: the made-up fixture plus ${DEMO.loads.map((l) => `${l.id} (${l.status})`).join(", ")}`);
	} catch (e) {
		fail(e.message, 1);
	}

	const db = new Database(dbAbs, { fileMustExist: true });
	db.pragma("busy_timeout = 5000");
	let out;
	try {
		const user = db.prepare("SELECT id, role, driver_name FROM users WHERE username = ?").get(DEMO.driver.username);
		if (!user || user.role !== "Driver" || user.driver_name !== DEMO.driver.name) throw new Error("the driver account is missing or not the Driver DEMO names");
		out = { userId: user.id, ...writeRows(db, { userId: user.id, truckId: made.truckId, today }) };
	} catch (e) {
		db.close();
		fail(e.message, 1);
	}
	db.close();

	const file = path.join(WORK, LOGIN_FILE);
	const record = { createdAt: new Date().toISOString(), db: dbAbs, username: DEMO.driver.username, userId: out.userId, truckId: made.truckId, keychain: item };
	fs.writeFileSync(file, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
	fs.chmodSync(file, 0o600);
	console.log(`plant: driver user #${out.userId}, application #${out.applicationId}, fully onboarded ${DEMO.driver.onboardedDaysAgo} days ago; ` +
		`${CONTRACTS.length} signed contracts, ${DEMO.truckDocuments.length} truck documents, ${DEMO.notifications.length} alerts, ${DEMO.messages.length} messages, ` +
		`invoice ${DEMO.invoice.number} for ${out.week.start}..${out.week.end}`);
	console.log(`plant: login written (0600, no password): ${file}`);
	console.log("plant: next: boot-server.sh on this database, then driver-walkthrough.mjs");
}

// The pure parts, for scripts/test-driver-walkthrough-media.js. Requiring this file plants nothing.
module.exports = { sheetsWithDemo, placeholderIdPng, lastInvoiceWeek, addDays, sheetDate, CONTRACTS };

if (require.main === module) main().catch((e) => fail(e.message, 1));
