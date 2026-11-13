#!/usr/bin/env node
// lib/triumph-transfer.js: the SFTP connection to Triumph, against an in-process ssh2 server
// (scripts/e2e/fake-triumph.cjs) on 127.0.0.1, with made-up host and client keys made at run
// time. The real protocol, and no outside host.
//
//   §1 the settings: each required one, by name and never by value; no default but the port;
//      the one host-key type; a replica holds none
//   §2 the connection: the pinned host key (a wrong one refuses, before any sign-in); only the
//      configured key type is offered; the key alone signs in, and a password or a
//      keyboard-interactive prompt is never answered; a file channel that never opens ends
//      the connection; a replica, missing settings or an unreadable key reach nothing
//   §3 read mode: list, stat and get only, and no write operation reaches the server
//   §4 live mode: put() refuses outside the live mode, without the lock point's token, with a
//      token whose claim isn't past the lock, for another file than the lock covers, after the
//      lease ran out; with the token, the PDF then the CSV, each size checked, the CSV made only
//      if it isn't there; a CSV whose open the server refused sent nothing, one cut off may have
//   §5 sample mode: shut once the go-live date holds any value, once live and in a replica;
//      only the made-up batch, by its content; the PDF first, and a failed PDF sends no CSV
//   §6 the source: no delete, rename, mkdir or setstat anywhere; only the sample script opens
//      sample mode; only the transport calls put()
//
// Made-up keys, folders and loads only (LD-TEST-*), all in memory.
//   node scripts/test-triumph-transfer.js      # exits 1 on any failure
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const TRANSFER_FILE = path.join(ROOT, "lib", "triumph-transfer.js");
if (!fs.existsSync(TRANSFER_FILE) || !fs.existsSync(path.join(ROOT, "lib", "triumph-ledger.js"))) {
	console.log("FAIL  lib/triumph-transfer.js or lib/triumph-ledger.js is missing: there is no transport and no lock point");
	process.exit(1);
}
const transfer = require(TRANSFER_FILE);
const ledger = require(path.join(ROOT, "lib", "triumph-ledger.js"));
const factoring = require(path.join(ROOT, "lib", "factoring-store.js"));
const triumphBatch = require(path.join(ROOT, "lib", "triumph-batch.js"));
const rules = require(path.join(ROOT, "lib", "triumph-rules.js"));
const { startFakeTriumph, fingerprintOfKey } = require(path.join(ROOT, "scripts", "e2e", "fake-triumph.cjs"));
const { Client, utils: { generateKeyPairSync: sshKeyPair, parseKey } } = require(path.join(ROOT, "node_modules", "ssh2"));
// ssh2's own ed25519 keys are now and then ones its parser refuses (a few in a thousand): a
// made-up key is made again until it parses, so no run turns on that chance.
function generateKeyPairSync(type, opts) {
	for (let i = 0; i < 50; i++) {
		const k = sshKeyPair(type, opts);
		if (!(parseKey(k.private) instanceof Error)) return k;
	}
	throw new Error(`no usable made-up ${type} key in 50 tries`);
}
const Database = require(path.join(ROOT, "node_modules", "better-sqlite3"));
const { PDFDocument, StandardFonts } = require(path.join(ROOT, "node_modules", "pdf-lib"));

let pass = 0;
const failures = [];
function eq(actual, expected, label) {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) { pass++; return; }
	failures.push(`${label}\n      expected ${e}\n      actual   ${a}`);
}
const ok = (cond, label) => eq(Boolean(cond), true, label);
const section = (t) => console.log(`\n${t}`);

// The plan's key: RSA 4096 in PEM, as Arvin made it on the box. Made here, for this run only.
const CLIENT = crypto.generateKeyPairSync("rsa", { modulusLength: 4096, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const OTHER_CLIENT = generateKeyPairSync("ed25519");
const HOST_ED = generateKeyPairSync("ed25519");
const HOST_RSA = generateKeyPairSync("rsa", { bits: 2048 });
const OTHER_HOST = generateKeyPairSync("ed25519");
const SUBMIT = "/made-up/submit";
const REPORTS = "/made-up/reports";
const KEY_PATH = "/made-up/not-a-real-key-file";
const LIVE = { TRIUMPH_SUBMIT_ENABLED: "true", TRIUMPH_SUBMIT_DRY_RUN: "false", TRIUMPH_LIVE_CONFIRMED_ON: "2026-11-05" };

function envFor(fake, over = {}) {
	return {
		TRIUMPH_HOST: fake.host,
		TRIUMPH_PORT: String(fake.port),
		TRIUMPH_USER: "made-up-user",
		TRIUMPH_KEY_FILE: KEY_PATH,
		TRIUMPH_HOST_FINGERPRINT: fingerprintOfKey(HOST_ED.private),
		TRIUMPH_HOST_KEY_TYPE: "ED25519",
		TRIUMPH_SUBMIT_DIR: SUBMIT,
		TRIUMPH_REPORTS_DIR: REPORTS,
		...over,
	};
}

// ssh2's own Client, counting each connection the transport starts.
let connects = 0;
class CountingClient extends Client {
	connect(cfg) {
		connects++;
		return super.connect(cfg);
	}
}
const readKeyFile = (p) => {
	if (p !== KEY_PATH) throw new Error("not the made-up key path");
	return CLIENT.privateKey;
};
const make = (env, extra = {}) => transfer.create({ env, Client: CountingClient, readKeyFile, ...extra });
const codeOf = async (fn) => {
	try {
		await fn();
		return "OK";
	} catch (e) {
		return e && e.code;
	}
};
const fakeWith = (over = {}) => startFakeTriumph({ hostKey: HOST_ED.private, clientKey: CLIENT.privateKey, folders: [SUBMIT, REPORTS], ...over });

// A claim at the lock, as lib/triumph-job.js leaves one: built, its files' hashes recorded.
const T0 = "2026-11-12T15:00:00.000Z";
function lockedDb({ pdf, csv, pdfName = "11122026-1.pdf", csvName = "logisx_20261112T150000Z_11122026-1.csv" }) {
	const db = new Database(":memory:");
	db.exec("CREATE TABLE load_invoice_drafts (id INTEGER PRIMARY KEY AUTOINCREMENT, load_id TEXT, invoice_id TEXT, recipient TEXT, total TEXT, broker_name TEXT, order_number TEXT, via TEXT, created_by TEXT, created_at TEXT)");
	ledger.ensureSchema(db);
	db.prepare("INSERT INTO load_factoring (load_key, load_id, factored, source, set_at, updated_at) VALUES ('ld-test-0001', 'LD-TEST-0001', 1, 'script', ?, ?)").run(T0, T0);
	const files = { pdf: { name: pdfName, sha256: sha(pdf), bytes: pdf.length }, csv: { name: csvName, sha256: sha(csv), bytes: csv.length }, invoicePage: { name: "invoice-page.pdf", sha256: "x", bytes: 1 } };
	db.prepare(`INSERT INTO triumph_submissions (load_key, load_id, state, first_seen_at, lease_owner, lease_until, stage, invoice_id, invoice_date, reserved_at, pdf_name, csv_name, files_json, updated_at)
		VALUES ('ld-test-0001', 'LD-TEST-0001', 'working', ?, 'made-up-run#1', '2099-01-01T00:00:00.000Z', 'built', '11122026-1', '2026-11-12', ?, ?, ?, ?, ?)`).run(T0, T0, pdfName, csvName, JSON.stringify(files), T0);
	return db;
}
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

async function madeUpPdf(lines) {
	const doc = await PDFDocument.create();
	const font = await doc.embedFont(StandardFonts.Helvetica);
	const page = doc.addPage([612, 792]);
	lines.forEach((text, i) => page.drawText(`${text} `, { x: 54, y: 720 - i * 20, size: 12, font }));
	return Buffer.from(await doc.save({ useObjectStreams: false }));
}

(async () => {
	// ---------------------------------------------------------------- §1
	section("§1 the settings");
	{
		const full = envFor({ host: "127.0.0.1", port: 2222 });
		const r = rules.transportSettings(full);
		ok(r.ok && r.settings.port === 2222 && r.settings.submitDir === SUBMIT, "§1 every setting set: usable");
		eq([...r.settings.hostKeyAlgorithms], ["ssh-ed25519"], "§1 ED25519: only that type is offered");
		eq([...rules.transportSettings({ ...full, TRIUMPH_HOST_KEY_TYPE: "rsa" }).settings.hostKeyAlgorithms], ["rsa-sha2-512", "rsa-sha2-256"], "§1 RSA: its SHA-2 signatures only, never SHA-1's ssh-rsa");
		eq([...rules.transportSettings({ ...full, TRIUMPH_HOST_KEY_TYPE: "ECDSA" }).settings.hostKeyAlgorithms], ["ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521"], "§1 ECDSA: its three curves");
		eq(rules.transportSettings({ ...full, TRIUMPH_PORT: "" }).settings.port, 22, "§1 no port: the protocol's own 22");
		const none = rules.transportSettings({});
		eq([none.ok, none.missing, none.settings], [false, ["TRIUMPH_HOST", "TRIUMPH_USER", "TRIUMPH_KEY_FILE", "TRIUMPH_HOST_FINGERPRINT", "TRIUMPH_HOST_KEY_TYPE", "TRIUMPH_SUBMIT_DIR"], null], "§1 nothing set: every required one missing, by name; no default reaches anything");
		for (const [name, v] of [["TRIUMPH_HOST", "sftp://made-up.example.test"], ["TRIUMPH_HOST", "made up.example.test"], ["TRIUMPH_PORT", "0"], ["TRIUMPH_PORT", "70000"], ["TRIUMPH_PORT", "22a"],
			["TRIUMPH_USER", "made up"], ["TRIUMPH_KEY_FILE", "relative/key"], ["TRIUMPH_HOST_FINGERPRINT", "MD5:aa:bb"], ["TRIUMPH_HOST_FINGERPRINT", "SHA256:short"],
			["TRIUMPH_HOST_KEY_TYPE", "DSA"], ["TRIUMPH_SUBMIT_DIR", "/made-up/../up"], ["TRIUMPH_SUBMIT_DIR", "/made up/x"], ["TRIUMPH_REPORTS_DIR", "/made-up/./x"]]) {
			const bad = rules.transportSettings({ ...full, [name]: v });
			eq([bad.ok, bad.invalid, bad.settings], [false, [name], null], `§1 ${name} ${JSON.stringify(v)}: refused, named`);
			ok(!JSON.stringify(bad).includes(v), `§1 ...and the answer holds no part of the value it refused (${name})`);
		}
		ok(rules.transportSettings({ ...full, TRIUMPH_REPORTS_DIR: "" }).ok, "§1 the reports folder is optional for submitting");
		eq(rules.transportSettings(full, { replica: true }), { ok: false, replica: true, missing: [], invalid: [], settings: null }, "§1 a replica holds no connection, whatever its settings say");
		eq(transfer.fingerprintOf(Buffer.from("made-up blob")), crypto.createHash("sha256").update("made-up blob").digest("base64").replace(/=+$/, ""), "§1 a host key's fingerprint is ssh-keygen -l's: SHA-256, base64, no padding");
	}

	// ---------------------------------------------------------------- §2
	section("§2 the connection");
	{
		const fake = await fakeWith();
		try {
			connects = 0;
			const t = make(envFor(fake));
			ok(t.configured, "§2 (fixture) the settings are usable");
			const s = await t.openRead();
			eq(await s.list("submit"), [], "§2 the pinned host key and the key alone: signed in, an empty folder lists as none");
			s.close();
			eq(fake.auth.map((a) => a.method), ["publickey", "publickey"], "§2 ...the key was the one method used (offered, then signed)");

			fake.auth.length = 0;
			const wrongHost = make(envFor(fake, { TRIUMPH_HOST_FINGERPRINT: fingerprintOfKey(OTHER_HOST.private) }));
			eq(await codeOf(() => wrongHost.openRead()), "HOST_KEY_MISMATCH", "§2 a host key that isn't the pinned one: HOST_KEY_MISMATCH");
			eq(fake.auth, [], "§2 ...before any sign-in: the key was never offered to it");
			const wrongType = make(envFor(fake, { TRIUMPH_HOST_KEY_TYPE: "RSA" }));
			eq(await codeOf(() => wrongType.openRead()), "CONNECT_FAILED", "§2 a host with no key of the configured type: no handshake, nothing else offered");

			const wrongKey = make(envFor(fake), { readKeyFile: () => OTHER_CLIENT.private });
			eq(await codeOf(() => wrongKey.openRead()), "LOGIN_REFUSED", "§2 another client key: LOGIN_REFUSED");
			const noKey = make(envFor(fake), { readKeyFile: () => { throw Object.assign(new Error("made-up"), { code: "ENOENT" }); } });
			const before = connects;
			eq(await codeOf(() => noKey.openRead()), "KEY_UNREADABLE", "§2 a key file that can't be read: KEY_UNREADABLE");
			eq(connects, before, "§2 ...and no connection was started");
		} finally {
			await fake.close();
		}

		// Only a password and a prompt on offer: the client never answers either.
		const asks = await fakeWith({ methods: ["password", "keyboard-interactive"] });
		try {
			const t = make(envFor(asks));
			eq(await codeOf(() => t.openRead()), "LOGIN_REFUSED", "§2 a server that asks for a password or a prompt: LOGIN_REFUSED");
			eq([...new Set(asks.auth.map((a) => a.method))], ["publickey"], "§2 ...the client tried its key and nothing else: no password, no prompt answered");
		} finally {
			await asks.close();
		}

		// A server that signs the app in and never opens the file channel: the wait ends, and so
		// does the connection.
		const holds = await fakeWith({ faults: { holdSubsystem: () => true } });
		try {
			const t = make(envFor(holds), { readyTimeoutMs: 10000, opTimeoutMs: 1000 });
			const started = Date.now();
			const code = await Promise.race([codeOf(() => t.openRead()), new Promise((r) => setTimeout(() => r("STILL_WAITING"), 15000))]);
			eq(code, "SFTP_TIMEOUT", "§2 FAILS ON A CHANNEL THAT WAITS FOREVER: a server that never opens the file channel: SFTP_TIMEOUT");
			ok(Date.now() - started < 10000, "§2 ...within the operation's time");
			for (let i = 0; i < 40 && holds.open(); i++) await new Promise((r) => setTimeout(r, 50));
			eq(holds.open(), 0, "§2 ...and the connection is ended");
		} finally {
			await holds.close();
		}

		// An RSA host key pinned with type RSA. The fake serves that one key; the type's own
		// effect, a host with no key of it, is the wrong-type case above.
		const both = await startFakeTriumph({ hostKey: HOST_RSA.private, clientKey: CLIENT.privateKey, folders: [SUBMIT] });
		try {
			const rsa = make(envFor(both, { TRIUMPH_HOST_FINGERPRINT: fingerprintOfKey(HOST_RSA.private), TRIUMPH_HOST_KEY_TYPE: "RSA" }));
			const s = await rsa.openRead();
			s.close();
			ok(true, "§2 an RSA host key, pinned with type RSA: signed in");
		} catch (e) {
			ok(false, `§2 an RSA host key, pinned with type RSA: signed in (${e && e.code})`);
		} finally {
			await both.close();
		}

		connects = 0;
		eq(await codeOf(() => make(envFor({ host: "127.0.0.1", port: 9 }), { replica: true }).openRead()), "TRANSPORT_REPLICA", "§2 a replica: refused");
		eq(await codeOf(() => make({}).openRead()), "TRANSPORT_UNCONFIGURED", "§2 no settings: refused");
		eq(connects, 0, "§2 ...and neither started a connection");
	}

	// ---------------------------------------------------------------- §3
	section("§3 read mode");
	{
		const fake = await fakeWith({ files: new Map([[`${REPORTS}/invoicestatus_made_up.csv`, Buffer.from("a,b\r\n")]]) });
		try {
			const s = await make(envFor(fake)).openRead();
			eq(await s.list("reports"), [{ name: "invoicestatus_made_up.csv", size: 5, mtime: 1762905600 }], "§3 list: names, sizes and times");
			eq(await s.stat("reports", "invoicestatus_made_up.csv"), { size: 5, mtime: 1762905600 }, "§3 stat");
			eq((await s.get("reports", "invoicestatus_made_up.csv")).toString(), "a,b\r\n", "§3 get");
			eq(await codeOf(() => s.get("reports", "../submit/x.pdf")), "NAME_UNSAFE", "§3 a name with a path: refused");
			eq(await codeOf(() => s.list("elsewhere")), "FOLDER_UNSET", "§3 only the two folders the settings name");
			s.close();
			eq(Object.keys(s).sort(), ["close", "get", "list", "stat"], "§3 the read session has no way to write");
			eq(fake.writeOps(), [], "§3 no write operation reached the server");
		} finally {
			await fake.close();
		}
		const noReports = await fakeWith({ folders: [SUBMIT] });
		try {
			const s = await make(envFor(noReports)).openRead();
			eq(await s.list("reports"), [], "§3 a reports folder that isn't there yet lists as none, not an error");
			s.close();
		} finally {
			await noReports.close();
		}
	}

	// ---------------------------------------------------------------- §4
	section("§4 live mode: put() and the lock");
	{
		const pdf = await madeUpPdf(["MADE-UP INVOICE 11122026-1"]);
		const csv = Buffer.from("DTR_NAME,INVOICE#,INV_DATE,PO,INVAMT\r\nExample Broker LLC,11122026-1,11/12/2026,LD-TEST-0001,2150.00\r\n");
		const PDF = "11122026-1.pdf";
		const CSV = "logisx_20261112T150000Z_11122026-1.csv";
		const fake = await fakeWith();
		const now = () => new Date(T0);
		try {
			connects = 0;
			const dry = make(envFor(fake, { TRIUMPH_SUBMIT_ENABLED: "true" }), { db: lockedDb({ pdf, csv }), now });
			eq(await codeOf(() => dry.openLive()), "NOT_LIVE", "§4 dry run: openLive() refuses NOT_LIVE");
			eq(connects, 0, "§4 FAILS ON A BUILD GATED ON ENABLED ALONE: ...before any connection");

			const db = lockedDb({ pdf, csv });
			const t = make(envFor(fake, LIVE), { db, now });
			const s = await t.openLive();
			eq(Object.keys(s).sort(), ["close", "put"], "§4 the live session has put() and nothing else");
			eq(await codeOf(() => s.put(null, { name: PDF, bytes: pdf })), "UNLOCKED_PUT", "§4 FAILS ON A WRAPPER THAT ACCEPTS ANY PUT: no token, UNLOCKED_PUT");
			const forged = { key: "ld-test-0001", owner: "made-up-run#1", invoiceId: "11122026-1", lockedAt: T0 };
			eq(await codeOf(() => s.put(forged, { name: PDF, bytes: pdf })), "UNLOCKED_PUT", "§4 a token for a claim still at 'built' (not locked): UNLOCKED_PUT");
			eq(fake.writeOps(), [], "§4 ...and no write operation reached the server");

			const lock = ledger.lockForUpload(db, "ld-test-0001", "made-up-run#1", { nowIso: T0, mode: "live" });
			ok(lock.ok, `§4 (fixture) the lock point gives a token (${lock.code || "ok"})`);
			eq(await codeOf(() => s.put({ ...lock.token, lockedAt: "2026-11-12T14:00:00.000Z" }, { name: PDF, bytes: pdf })), "UNLOCKED_PUT", "§4 a token whose lock isn't the marker's: UNLOCKED_PUT");
			eq(await codeOf(() => s.put({ ...lock.token, owner: "another-run#9" }, { name: PDF, bytes: pdf })), "UNLOCKED_PUT", "§4 another run's token: UNLOCKED_PUT");
			eq(await codeOf(() => s.put(lock.token, { name: "11122026-2.pdf", bytes: pdf })), "UNLOCKED_PUT", "§4 a file the lock doesn't cover (another name): UNLOCKED_PUT");
			eq(await codeOf(() => s.put(lock.token, { name: PDF, bytes: Buffer.concat([pdf, Buffer.from(" ")]) })), "UNLOCKED_PUT", "§4 the right name, other bytes: UNLOCKED_PUT");
			eq(await codeOf(() => s.put(lock.token, { name: CSV, bytes: csv })), "UNLOCKED_PUT", "§4 the CSV before the PDF has gone: UNLOCKED_PUT (the PDF goes first)");
			eq(fake.writeOps(), [], "§4 ...none of them reached the server");

			eq(await codeOf(() => s.put(lock.token, { name: PDF, bytes: pdf })), "OK", "§4 the token and the PDF it covers: sent");
			ok(fake.files.get(`${SUBMIT}/${PDF}`).equals(pdf), "§4 ...byte for byte, into the submissions folder, under its INVOICE# name");
			ledger.setStage(db, "ld-test-0001", "made-up-run#1", "pdf_uploaded", T0);
			eq(await codeOf(() => s.put(lock.token, { name: CSV, bytes: csv })), "UNLOCKED_PUT", "§4 the CSV before its own stage (csv_uploading): UNLOCKED_PUT");
			ledger.setStage(db, "ld-test-0001", "made-up-run#1", "csv_uploading", T0);
			eq(await codeOf(() => s.put(lock.token, { name: CSV, bytes: csv })), "OK", "§4 at csv_uploading, the CSV: sent");
			const opens = fake.ops.filter((o) => o.op === "OPEN").map((o) => [path.posix.basename(o.path), o.exclusive]);
			eq(opens, [[PDF, false], [CSV, true]], "§4 the PDF before the CSV, and the CSV opened only if it isn't there");
			eq(fake.ops.filter((o) => o.op === "STAT").map((o) => path.posix.basename(o.path)), [PDF, CSV], "§4 each file's remote size checked after it went");

			db.prepare("UPDATE triumph_submissions SET lease_until = '2026-11-12T14:59:00.000Z'").run();
			eq(await codeOf(() => s.put(lock.token, { name: CSV, bytes: csv })), "UNLOCKED_PUT", "§4 a lease that ran out: UNLOCKED_PUT");
			s.close();
		} finally {
			await fake.close();
		}

		// What a failure tells the job: nothing made there, or maybe.
		const refusesCsv = await fakeWith({ faults: { openStatus: (p) => (p.endsWith(".csv") ? 3 : null) } });
		try {
			const db = lockedDb({ pdf, csv });
			const lock = ledger.lockForUpload(db, "ld-test-0001", "made-up-run#1", { nowIso: T0, mode: "live" });
			ledger.setStage(db, "ld-test-0001", "made-up-run#1", "csv_uploading", T0);
			const s = await make(envFor(refusesCsv, LIVE), { db, now: () => new Date(T0) }).openLive();
			let err = null;
			try {
				await s.put(lock.token, { name: CSV, bytes: csv });
			} catch (e) {
				err = e;
			}
			eq([err && err.code, err && err.nothingSent], ["PUT_FAILED", true], "§4 the server refused the CSV's open: nothing was made there (nothingSent)");
			s.close();
		} finally {
			await refusesCsv.close();
		}
		// The CSV's exclusive open fails with a plain failure when the file is there already: only
		// an earlier try of this same batch could have put it there.
		const already = await fakeWith({ files: new Map([[`${SUBMIT}/${CSV}`, Buffer.from("made-up earlier try")]]) });
		try {
			const db = lockedDb({ pdf, csv });
			const lock = ledger.lockForUpload(db, "ld-test-0001", "made-up-run#1", { nowIso: T0, mode: "live" });
			ledger.setStage(db, "ld-test-0001", "made-up-run#1", "csv_uploading", T0);
			const s = await make(envFor(already, LIVE), { db, now: () => new Date(T0) }).openLive();
			let err = null;
			try {
				await s.put(lock.token, { name: CSV, bytes: csv });
			} catch (e) {
				err = e;
			}
			eq([err && err.code, err && err.nothingSent], ["PUT_FAILED", false], "§4 FAILS ON A BUILD THAT READS ANY REFUSED OPEN AS NOTHING SENT: a CSV already there: it may be ours, so it may have gone");
			ok(already.files.get(`${SUBMIT}/${CSV}`).toString() === "made-up earlier try", "§4 ...and the file there is left as it was");
			s.close();
		} finally {
			await already.close();
		}
		const cutsOff = await fakeWith({ faults: { dropOnWrite: (p) => p.endsWith(".csv") } });
		try {
			const db = lockedDb({ pdf, csv });
			const lock = ledger.lockForUpload(db, "ld-test-0001", "made-up-run#1", { nowIso: T0, mode: "live" });
			ledger.setStage(db, "ld-test-0001", "made-up-run#1", "csv_uploading", T0);
			const s = await make(envFor(cutsOff, LIVE), { db, now: () => new Date(T0), opTimeoutMs: 3000 }).openLive();
			let err = null;
			try {
				await s.put(lock.token, { name: CSV, bytes: csv });
			} catch (e) {
				err = e;
			}
			eq([Boolean(err), err && err.nothingSent], [true, false], "§4 a CSV cut off after its bytes went: it may be there (not nothingSent), so it is never sent again");
			s.close();
		} finally {
			await cutsOff.close();
		}
		const lies = await fakeWith({ faults: { sizeFor: (p) => (p.endsWith(".pdf") ? 1 : null) } });
		try {
			const db = lockedDb({ pdf, csv });
			const lock = ledger.lockForUpload(db, "ld-test-0001", "made-up-run#1", { nowIso: T0, mode: "live" });
			const s = await make(envFor(lies, LIVE), { db, now: () => new Date(T0) }).openLive();
			eq(await codeOf(() => s.put(lock.token, { name: PDF, bytes: pdf })), "SIZE_MISMATCH", "§4 a remote size that isn't the file's: SIZE_MISMATCH");
			s.close();
		} finally {
			await lies.close();
		}
	}

	// ---------------------------------------------------------------- §5
	section("§5 sample mode");
	{
		const lines = ["MADE-UP FACTOR LINE ONE", "MADE-UP FACTOR LINE TWO", "MADE-UP FACTOR LLC", "MADE-UP REMIT LINE"];
		// A stand-in renderer: the page's text as a PDF, so the stamp beside the block can be read.
		// A character scan, not a regex: each tag becomes a line break and a style block's text is dropped.
		const pageText = (html) => {
			let text = "", tag = null, inStyle = false;
			for (const ch of String(html)) {
				if (tag === null && ch === "<") tag = "";
				else if (tag !== null && ch === ">") {
					const name = tag.trim().toLowerCase();
					if (name.startsWith("style")) inStyle = true;
					else if (name.startsWith("/style")) inStyle = false;
					tag = null;
					text += "\n";
				} else if (tag !== null) tag += ch;
				else if (!inStyle) text += ch;
			}
			return text;
		};
		const render = async (html) => madeUpPdf(pageText(html).split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 30));
		const sample = await triumphBatch.buildSampleBatch({ lines, day: "2026-11-12", render, at: new Date(T0) });
		ok(sample.ok, "§5 (fixture) the made-up batch builds");
		const files = { pdfName: sample.pdfName, pdf: sample.pdf, csvName: sample.csvName, csv: sample.csv };
		const fake = await fakeWith();
		try {
			connects = 0;
			for (const [label, env] of [["the go-live date set", { TRIUMPH_LIVE_CONFIRMED_ON: "2026-11-20" }], ["a mistyped go-live date", { TRIUMPH_LIVE_CONFIRMED_ON: "20/11/2026" }],
				["the mode live", LIVE]]) {
				eq(await codeOf(() => make(envFor(fake, env)).openSample()), "SAMPLE_AFTER_LIVE", `§5 FAILS ON A DATE-BLIND GATE: ${label}: the sample is shut`);
			}
			eq(await codeOf(() => make(envFor(fake), { replica: true }).openSample()), "SAMPLE_REPLICA", "§5 a replica: shut");
			eq(connects, 0, "§5 ...none of them started a connection");

			const s = await make(envFor(fake)).openSample();
			eq(Object.keys(s).sort(), ["close", "putSample"], "§5 the sample session has putSample() and nothing else");
			const csvText = sample.csv.toString();
			const swap = (from, to) => Buffer.from(csvText.replace(from, to));
			for (const [label, change] of [
				["a real-shaped invoice number", { csv: swap(/SAMPLE-0001/, "11122026-7"), csvName: sample.csvName }],
				["another debtor", { csv: swap("Example Broker LLC (SAMPLE - DO NOT FUND)", "Example Broker LLC") }],
				["another amount", { csv: swap(",1.00\r\n", ",2150.00\r\n") }],
				["a date that isn't one", { csv: swap(/\d{2}\/\d{2}\/\d{4}/, "02/30/2026") }],
				["a second row", { csv: Buffer.concat([sample.csv, Buffer.from(csvText.split("\r\n")[1] + "\r\n")]) }],
				["another PDF name", { pdfName: "11122026-7.pdf" }],
				["a CSV named for another number", { csvName: sample.csvName.replace("SAMPLE-0001", "SAMPLE-0002") }],
				["a PDF with no stamp", { pdf: await madeUpPdf(["MADE-UP INVOICE SAMPLE-0001"]) }],
			]) {
				eq(await codeOf(() => s.putSample({ ...files, ...change })), "SAMPLE_REFUSED", `§5 FAILS ON A NAMES-ONLY CHECK: ${label}: SAMPLE_REFUSED`);
			}
			eq(fake.writeOps(), [], "§5 ...and none of them wrote anything");
			eq(await codeOf(() => s.putSample(files)), "OK", "§5 the made-up batch, as built: sent");
			eq(fake.ops.filter((o) => o.op === "OPEN").map((o) => path.posix.basename(o.path)), [sample.pdfName, sample.csvName], "§5 the PDF first, then the CSV");
			ok(fake.files.get(`${SUBMIT}/${sample.csvName}`).equals(sample.csv), "§5 the CSV as built, byte for byte");
			s.close();
		} finally {
			await fake.close();
		}
		const pdfFails = await fakeWith({ faults: { openStatus: (p) => (p.endsWith(".pdf") ? 4 : null) } });
		try {
			const s = await make(envFor(pdfFails)).openSample();
			let err = null;
			try {
				await s.putSample(files);
			} catch (e) {
				err = e;
			}
			eq(err && err.part, "pdf", "§5 a PDF that fails: the failure names the PDF");
			eq(pdfFails.ops.filter((o) => o.op === "OPEN").map((o) => path.posix.basename(o.path)), [sample.pdfName], "§5 ...and no CSV was opened");
			s.close();
		} finally {
			await pdfFails.close();
		}
	}

	// ---------------------------------------------------------------- §6
	section("§6 the source");
	{
		const code = (src) => src.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
		const src = code(fs.readFileSync(TRANSFER_FILE, "utf8"));
		for (const call of ["unlink", "rename", "mkdir", "rmdir", "setstat", "fsetstat", "chmod", "chown", "symlink", "ext_openssh_rename", "fastPut", "createWriteStream"]) {
			ok(!new RegExp(`\\.${call}\\(`).test(src), `§6 the wrapper never calls sftp.${call}()`);
		}
		eq(Object.keys(transfer.create({})).sort(), ["configured", "invalid", "missing", "openLive", "openRead", "openSample"], "§6 the wrapper's ways in: read, live and sample, and no other");
		// The server as the scripts read it (scripts/lib/server-source.js, its route modules
		// spliced in), then lib/ and scripts/.
		const sources = [["the server", require("./lib/server-source").serverSource()]];
		for (const dir of ["lib", "scripts"]) {
			for (const f of fs.readdirSync(path.join(ROOT, dir)).filter((x) => /\.(js|cjs|mjs)$/.test(x) && !/^test-/.test(x))) {
				sources.push([`${dir}/${f}`, fs.readFileSync(path.join(ROOT, dir, f), "utf8")]);
			}
		}
		const callers = (re) => sources.filter(([f, text]) => f !== "lib/triumph-transfer.js" && re.test(code(text))).map(([f]) => f);
		eq(callers(/\.openSample\(/), ["scripts/triumph-batch-sample.js"], "§6 only the sample script opens sample mode");
		eq(callers(/\.putSample\(/), ["scripts/triumph-batch-sample.js"], "§6 ...and only it calls putSample()");
		eq(callers(/\.openLive\(/), ["lib/triumph-job.js"], "§6 only the submit job opens live mode");
	}

	console.log(`\n${pass} passed, ${failures.length} failed`);
	for (const f of failures) console.log(`FAIL  ${f}`);
	process.exit(failures.length ? 1 : 0);
})().catch((e) => {
	console.log(`FAIL  the runner itself: ${e && e.stack}`);
	process.exit(1);
});
