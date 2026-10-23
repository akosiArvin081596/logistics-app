// The made-up database setup-db.cjs builds when no SOURCE_DB is given (the default).
//
// No real database is opened. The schema is the app's own: an empty file in the
// work dir is booted once with boot-server.sh (made-up settings, the Google
// stand-in, no client), so server.js creates every table the way it does on a new
// install. The records then go in through the app's own routes, as a person would
// make them, and the server is stopped by its PID with stop-server.sh:
//
//   POST /api/auth/setup   the Super Admin                 qa-e2e-admin
//   POST /api/users        the Dispatcher                  qa-e2e-dispatcher
//                          two Investors                   qa-e2e-investor1, qa-e2e-investor2
//                          the Driver ("QA E2E Driver One",
//                          the made-up Sheets fixture's driver of QA-E2E-1001 and -1003)
//                                                          qa-e2e-driver
//   POST /api/trucks       truck QA-E2E-T1 (the fixture's truck for those loads),
//                          assigned to that driver, with a JPEG photo
//
// With the server stopped, two rows no route makes directly are written:
//
//   job_applications       the driver's accepted application, with an image cdl_front
//   driver_onboarding      the driver, fully onboarded on that application 60 days ago
//                          (the Kit tab renders; the welcome card, shown for 14 days, does not)
//
// Every name, address and number is invented (QA-/qa-e2e- names, example.test
// mail, no SSN or licence number), and the two images (the photo a JPEG, the CDL a
// PNG) are drawn here at run time. The truck's unit number is not QA-TEST-: e2e.mjs deletes QA-TEST-
// trucks as leftovers, and R2a needs a truck that is not one of its own.
//
// The Sheets copy the seed boot made (<db>.sheets.json) is removed again, so the
// run's first boot starts from a fresh copy of the fixture.
//
// E2E_SEED_CHECKOUT names the checkout whose server.js builds the schema (default:
// the checkout this harness lives in); it is for the harness's own tests.
"use strict";
const fs = require("fs");
const net = require("net");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const paths = require("./paths.cjs");

const DRIVER_NAME = "QA E2E Driver One";
const TRUCK_UNIT = "QA-E2E-T1";
const ACCOUNTS = {
	superAdmin: { username: "qa-e2e-admin", role: "Super Admin" },
	driver: { username: "qa-e2e-driver", role: "Driver", driverName: DRIVER_NAME },
	investor: { username: "qa-e2e-investor1", role: "Investor" },
	investor2: { username: "qa-e2e-investor2", role: "Investor" },
	dispatcher: { username: "qa-e2e-dispatcher", role: "Dispatcher" },
};

function crc32(buf) {
	let crc = ~0;
	for (const b of buf) {
		crc ^= b;
		for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
	}
	return (~crc) >>> 0;
}

// A small RGB PNG with a random base colour and stripes, drawn now: real image
// bytes, so the app's image checks take it as the picture it is.
function madeUpPng(width = 96, height = 64) {
	const [r, g, b] = crypto.randomBytes(3);
	const raw = Buffer.alloc((width * 3 + 1) * height);
	for (let y = 0; y < height; y++) {
		const row = y * (width * 3 + 1);
		raw[row] = 0; // filter: none
		for (let x = 0; x < width; x++) {
			const stripe = ((x + y) >> 3) & 1 ? 60 : 0;
			raw[row + 1 + x * 3] = (r + stripe) & 0xff;
			raw[row + 2 + x * 3] = (g + stripe) & 0xff;
			raw[row + 3 + x * 3] = (b + stripe) & 0xff;
		}
	}
	const chunk = (type, data) => {
		const len = Buffer.alloc(4);
		len.writeUInt32BE(data.length);
		const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(body));
		return Buffer.concat([len, body, crc]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 2; // RGB
	const png = Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", zlib.deflateSync(raw)),
		chunk("IEND", Buffer.alloc(0)),
	]);
	return `data:image/png;base64,${png.toString("base64")}`;
}

// A JPEG of the same kind of picture, through the app's own jimp: truck photos are
// JPEGs, and step 9 expects the photo served as image/jpeg.
async function madeUpJpeg(width = 96, height = 64) {
	const { Jimp } = paths.appRequire("jimp");
	const [r, g, b] = crypto.randomBytes(3);
	const img = new Jimp({ width, height, color: 0x000000ff });
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const stripe = ((x + y) >> 3) & 1 ? 60 : 0;
			img.setPixelColor(((((r + stripe) & 0xff) << 24) | (((g + stripe) & 0xff) << 16) | (((b + stripe) & 0xff) << 8) | 0xff) >>> 0, x, y);
		}
	}
	return `data:image/jpeg;base64,${(await img.getBuffer("image/jpeg")).toString("base64")}`;
}

function freePort() {
	return new Promise((resolve, reject) => {
		const s = net.createServer();
		s.once("error", reject);
		s.listen(0, "127.0.0.1", () => {
			const { port } = s.address();
			s.close(() => resolve(port));
		});
	});
}

// A tiny cookie-keeping client for the seed server. Passwords travel only in
// request bodies to 127.0.0.1 and are never printed.
function client(base) {
	const jar = new Map();
	return async (method, p, body) => {
		const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
		const r = await fetch(base + p, {
			method,
			redirect: "manual",
			headers: { "content-type": "application/json", "x-requested-with": "XMLHttpRequest", ...(cookie ? { cookie } : {}) },
			body: body ? JSON.stringify(body) : undefined,
		});
		for (const sc of r.headers.getSetCookie()) {
			const [kv] = sc.split(";");
			const i = kv.indexOf("=");
			jar.set(kv.slice(0, i), kv.slice(i + 1));
		}
		let json = null;
		try { json = await r.json(); } catch { /* not JSON */ }
		return { status: r.status, json };
	};
}

function runScript(script, args, env) {
	return spawnSync("bash", [path.join(__dirname, script), ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 150_000 });
}

const alive = (pid) => {
	try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
};

// Stops the seed server with stop-server.sh (the PID boot-server.sh recorded, while
// it is still that server). Where stop-server.sh cannot see processes (a sandbox
// without ps), that same recorded PID, which this setup started moments ago, gets
// the SIGTERM. Then waits until it has exited, so the database is free.
async function stopSeedServer(port, env, log) {
	const pidFile = path.join(paths.workDir(), `server-${port}.pid`);
	let pid = null;
	try { pid = Number(fs.readFileSync(pidFile, "utf8").split("\n")[0]); } catch { /* boot never recorded one */ }
	const stop = runScript("stop-server.sh", [String(port)], env);
	if (stop.status !== 0) log(`seed server: stop-server.sh exit ${stop.status}: ${String(stop.stderr || stop.stdout || "").trim()}`);
	if (!Number.isInteger(pid) || pid <= 0) return;
	if (alive(pid)) {
		try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
	}
	for (let i = 0; i < 40 && alive(pid); i++) await new Promise((r) => setTimeout(r, 250));
	if (alive(pid)) throw new Error(`the seed server (pid ${pid}, port ${port}) is still running; stop it with stop-server.sh ${port}`);
	fs.rmSync(pidFile, { force: true });
	log(`seed server: stopped (pid ${pid})`);
}

// Builds the made-up database at destAbs (an empty file is made there first) and
// returns the five logins' entries (names and ids). `passwords` maps each login
// key to the password it is to get; `log` prints one line.
async function seedMadeUp({ destAbs, passwords, log, Database }) {
	const WORK = paths.workDir();
	const checkout = path.resolve(process.env.E2E_SEED_CHECKOUT || paths.REPO);
	fs.writeFileSync(destAbs, "", { mode: 0o600 });
	const port = await freePort();
	const env = { ...process.env, NODE_BIN: process.execPath, E2E_WORK_DIR: WORK, E2E_NO_CLIENT: "1" };
	// The seed server runs with every optional feature off, whatever the caller exported.
	for (const k of ["E2E_MAINTENANCE_NOTICE", "E2E_FAKE_GMAIL", "E2E_DRIVER_INSTRUCTIONS_DENY", "INVESTOR_LEASE_PAYOUTS_ENABLED"]) delete env[k];
	const logFile = path.join(WORK, `server-${port}.log`);
	const boot = runScript("boot-server.sh", [checkout, String(port), destAbs], env);
	if (boot.status !== 0) {
		throw new Error(`the seed server did not boot (boot-server.sh exit ${boot.status}): ${String(boot.stderr || boot.stdout || "").trim().split("\n").slice(-3).join(" | ")}`);
	}
	log(`seed server: the app's own schema, booted from ${checkout} on 127.0.0.1:${port} (made-up settings, no client)`);
	let truckId = null;
	try {
		const api = client(`http://127.0.0.1:${port}`);
		const check = await api("GET", "/api/auth/setup-check");
		if (!check.json || check.json.needsSetup !== true) throw new Error(`the new database is not empty (setup-check ${check.status})`);
		const sa = ACCOUNTS.superAdmin;
		const s = await api("POST", "/api/auth/setup", { username: sa.username, password: passwords.superAdmin, email: `${sa.username}@example.test` });
		if (s.status !== 200) throw new Error(`POST /api/auth/setup answered ${s.status} ${s.json && s.json.error ? s.json.error : ""}`);
		for (const key of ["dispatcher", "investor", "investor2", "driver"]) {
			const a = ACCOUNTS[key];
			const body = { username: a.username, password: passwords[key], role: a.role, email: `${a.username}@example.test`, fullName: `QA E2E ${key}` };
			if (a.driverName) body.driverName = a.driverName;
			const u = await api("POST", "/api/users", body);
			if (u.status !== 200) throw new Error(`POST /api/users (${key}) answered ${u.status} ${u.json && u.json.error ? u.json.error : ""}`);
		}
		const t = await api("POST", "/api/trucks", {
			unitNumber: TRUCK_UNIT, make: "QA-TEST", model: "Made-up", assignedDriver: DRIVER_NAME, photo: await madeUpJpeg(),
			notes: "Made-up truck from the e2e seed (setup-db.cjs)",
		});
		if (t.status !== 200 || !t.json || !t.json.id) throw new Error(`POST /api/trucks answered ${t.status} ${t.json && t.json.error ? t.json.error : ""}`);
		truckId = t.json.id;
		await api("POST", "/api/auth/logout");
		log(`seed: 5 accounts through POST /api/auth/setup and /api/users; truck ${TRUCK_UNIT} (id ${truckId}) through POST /api/trucks`);
	} finally {
		await stopSeedServer(port, env, log);
	}
	fs.rmSync(logFile, { force: true });
	fs.rmSync(`${destAbs}.sheets.json`, { force: true });

	const db = new Database(destAbs, { fileMustExist: true });
	try {
		const ids = {};
		for (const [key, a] of Object.entries(ACCOUNTS)) {
			const row = db.prepare("SELECT id, role FROM users WHERE username = ?").get(a.username);
			if (!row || row.role !== a.role) throw new Error(`the seed account ${key} is missing or has another role`);
			ids[key] = row.id;
		}
		db.prepare(`UPDATE users SET must_change_password = 0 WHERE id IN (${Object.values(ids).map(() => "?").join(", ")})`).run(...Object.values(ids));
		db.prepare("DELETE FROM sessions").run();
		const app = db.prepare(`INSERT INTO job_applications
			(full_name, email, phone, dob, address, ssn, drivers_license, position, experience, has_cdl, work_authorized,
			 felony_convicted, accident_history, skills, signature, status, cdl_front, city, state, zip)
			VALUES (?, ?, '555-010-0100', '1990-01-01', 'QA-TEST 1 Made-up Way', '', '', 'Driver', '5 years', 'Yes', 'Yes',
			 'No', 'No', 'QA-TEST', ?, 'Accepted', ?, 'Testville', 'TX', '75001')`)
			.run(DRIVER_NAME, `${ACCOUNTS.driver.username}@example.test`, DRIVER_NAME, madeUpPng(120, 76));
		const applicationId = Number(app.lastInsertRowid);
		// Onboarded 60 days ago, like a driver already at work: the driver app's
		// "Welcome to the Team!" card shows only in the 14 days after onboarding,
		// and it would cover the screens the run taps.
		db.prepare("INSERT INTO driver_onboarding (user_id, application_id, driver_name, status, onboarded_at) VALUES (?, ?, ?, 'fully_onboarded', ?)")
			.run(ids.driver, applicationId, DRIVER_NAME, new Date(Date.now() - 60 * 86_400_000).toISOString());
		const truck = db.prepare("SELECT assigned_driver, substr(photo, 1, 30) AS head FROM trucks WHERE id = ?").get(truckId);
		if (!truck || truck.assigned_driver !== DRIVER_NAME || !/^data:image\//.test(truck.head || "")) {
			throw new Error(`truck ${TRUCK_UNIT} was not stored assigned to the made-up driver with an image photo`);
		}
		log(`seed: application ${applicationId} (image cdl_front) and the driver fully onboarded, written with the server stopped`);
		return {
			superAdmin: { username: ACCOUNTS.superAdmin.username, userId: ids.superAdmin },
			driver: { username: ACCOUNTS.driver.username, userId: ids.driver, truckId, applicationId },
			investor: { username: ACCOUNTS.investor.username, userId: ids.investor },
			investor2: { username: ACCOUNTS.investor2.username, userId: ids.investor2 },
			dispatcher: { username: ACCOUNTS.dispatcher.username, userId: ids.dispatcher },
		};
	} finally {
		db.close();
	}
}

module.exports = { seedMadeUp, madeUpPng, madeUpJpeg, ACCOUNTS, DRIVER_NAME, TRUCK_UNIT };
