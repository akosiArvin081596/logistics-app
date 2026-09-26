#!/usr/bin/env node
/**
 * A stored truck photo, and a driver's CDL / medical card, are served only as
 * what their bytes are — and a truck photo is stored only when it is an image
 * that can be served.
 *
 * GET /api/driver/me/truck-photo and GET /api/driver/me/identity-file/:fileType
 * each send a file kept as a base64 data URI. Both go through
 * storedFileForServing(): the Content-Type comes from the bytes
 * (lib/image-size.js servedType() — a JPEG, PNG or WebP, and a PDF for an
 * identity file), the media type written into the URI is never read, and
 * anything else — empty or malformed included — is 404 { error: "Not found" }.
 * An identity file that is a PDF is sent as a download (Content-Disposition:
 * attachment) under the name the Driver Kit's link gives it — CDL-Front.pdf,
 * CDL-Back.pdf or Medical-Card.pdf; an image stays inline.
 * An identity file is sent Cache-Control: private, no-store — not kept by the
 * browser. A truck photo is sent private, no-cache with an ETag taken from the
 * stored value (storedFileETag(): a quoted 32-hex-digit prefix of its SHA-256),
 * so the browser revalidates it with the server on every use, and a request
 * whose If-None-Match names that ETag is answered 304 with no body
 * (ifNoneMatchIncludes()).
 * POST /api/trucks and PUT /api/trucks/:id refuse a truck photo that is not
 * such an image, or is over 16 MP or 2 MiB: 415 UNSUPPORTED_IMAGE_TYPE / 413
 * IMAGE_TOO_LARGE with field "photo" (truckPhotoForStorage()). One that passes
 * is stored in its canonical form, `data:<the type its bytes are>;base64,<the
 * bytes re-encoded>`. The PUT keys the check on the photo CHANGING, because
 * the Trucks Edit form resends the stored photo on every save.
 *
 * WHAT IS ASSERTED — the shipped code, lifted out of server.js, on an in-memory
 * SQLite:
 *   §1 storedFileForServing() — each type served as its bytes say, whatever the
 *      label; a PDF only for identity files; everything else null.
 *   §2 GET /api/driver/me/truck-photo — the shipped handler: 200 with the exact
 *      bytes, the sniffed type, nosniff, private, no-cache and the stored
 *      value's ETag, inline; 304 with no body for an If-None-Match that names
 *      that ETag (as sent, weakened, in a list, or "*"), and 200 with the new
 *      bytes under a new ETag once the stored photo changes, or for another
 *      driver whose truck's photo differs; 404 for every non-image, a PDF, an
 *      empty payload and a malformed value, whatever If-None-Match names; the
 *      role gate. ifNoneMatchIncludes() on its own.
 *   §3 GET /api/driver/me/identity-file/:fileType — the same for a PDF or an
 *      image, each sent private, no-store, a PDF as an attachment under the
 *      Driver Kit's name for it (also read from DriverKit.vue — its labels and
 *      its downloadName rule — so either side changed alone fails) and an image
 *      inline;
 *      malformed is 404 (it was 500); an unknown type is still 400 and another
 *      role still 403.
 *   §4 truckPhotoForStorage() — absent/clear as given, the three image types
 *      in canonical form (the sniffed label, base64 re-encoded), each refusal
 *      with its status, code and wording, the 16 MP and 2 MiB edges, and the
 *      length cap checked before anything is decoded.
 *   §5 PUT /api/trucks/:id — a resend of a stored photo (not an image, or not
 *      canonical), beside another change, saves it untouched; a change to a
 *      non-image or an oversized one is refused with nothing written and the
 *      month-end lock never asked; a change to an image is stored canonical;
 *      "" and null clear.
 *   §6 POST /api/trucks — a Super Admin's or a Dispatcher's non-image or
 *      oversized photo is 415 / 413 with nothing inserted, an image is stored
 *      canonical; an Investor's photo is still ignored.
 *   §7 source pins — no pattern over the payload or If-None-Match, the GET routes send only the
 *      sniffed type, the attachment header only for a PDF, each write check
 *      before the route's first read, await and write, and each route storing
 *      the checked value.
 * The mutants for these guards were run by hand before shipping and are not
 * committed.
 *
 * Pure: no server, no app.db, no network.
 *
 * Run: node scripts/test-stored-file-serving.js    # exits 1 on failure
 */
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const imageLimits = require(path.join(__dirname, "..", "lib", "image-size.js"));

let pass = 0;
const failures = [];
function eq(actual, expected, label) {
	const a = JSON.stringify(actual), e = JSON.stringify(expected);
	if (a === e) { pass++; return; }
	failures.push(`${label}\n      expected ${e}\n      actual   ${a}`);
}
const ok = (cond, label) => eq(!!cond, true, label);
function die(msg) { console.error(`FAILED: ${msg}`); process.exit(1); }
function section(title) { console.log(`\n${title}`); }

let Database, Jimp;
try {
	Database = require("better-sqlite3");
	({ Jimp } = require("jimp"));
} catch (e) {
	die(`a server dependency did not load (${e.message}); run npm ci under the .nvmrc Node`);
}

// ── lift the shipped code ───────────────────────────────────────────────────
// Anchored on a newline and counted, so a mention in a comment cannot be taken
// for the definition and a second copy fails the run instead of lifting either.
function liftFunction(name) {
	const needle = `\nfunction ${name}(`;
	const hits = SRC.split(needle).length - 1;
	if (hits !== 1) die(`expected exactly 1 definition of ${name}() in server.js, found ${hits}`);
	const a = SRC.indexOf(needle) + 1;
	const end = SRC.indexOf("\n}\n", a);
	if (end < 0) die(`no column-0 "}" after ${name}()`);
	return SRC.slice(a, end + 2);
}
function liftRoute(head) {
	const needle = `\n${head}`;
	const hits = SRC.split(needle).length - 1;
	if (hits !== 1) die(`expected exactly 1 registration ${JSON.stringify(head)}, found ${hits}`);
	const a = SRC.indexOf(needle) + 1;
	const end = SRC.indexOf("\n});", a);
	if (end < 0) die(`no column-0 "});" after ${head}`);
	return SRC.slice(a, end + "\n});".length);
}
// A one-line `const NAME = …;`, or a block from its head to `close`.
function liftConst(head, close = null) {
	const needle = `\n${head}`;
	const hits = SRC.split(needle).length - 1;
	if (hits !== 1) die(`expected exactly 1 statement starting ${JSON.stringify(head)}, found ${hits}`);
	const a = SRC.indexOf(needle) + 1;
	const end = close ? SRC.indexOf(close, a) : SRC.indexOf(";\n", a);
	if (end < 0) die(`no end found after ${head}`);
	return SRC.slice(a, end + (close ? close.length : 1));
}

const HEADS = {
	truckPhoto: 'app.get("/api/driver/me/truck-photo", requireAuth, (req, res) => {',
	identityFile: 'app.get("/api/driver/me/identity-file/:fileType", requireAuth, (req, res) => {',
	truckPut: 'app.put("/api/trucks/:id", requireRole("Super Admin", "Dispatcher"), async (req, res) => {',
	truckPost: 'app.post("/api/trucks", requireRole("Super Admin", "Dispatcher", "Investor"), async (req, res) => {',
};
const ROUTES = Object.fromEntries(Object.entries(HEADS).map(([k, h]) => [k, liftRoute(h)]));

// The subject, and the pure parsers the two truck routes call before or around
// it — the amounts included (their own subject is
// scripts/test-truck-cost-amounts.js). Everything else they reach is stubbed in
// mountTrucks().
const FUNCTIONS = [
	"storedFileForServing", "storedFileETag", "ifNoneMatchIncludes", "truckPhotoForStorage",
	"parseDriverPayDaily", "parseInServiceDate", "parseRetiredAt", "parseAdminFeePct", "truckMonthlyFixed", "normalizeDriverName",
	"parseTruckAmount", "parseTruckAmounts",
];
const FN_SRC = Object.fromEntries(FUNCTIONS.map((n) => [n, liftFunction(n)]));
const CONSTS = [
	liftConst("const DRIVER_PAY_DAILY_MAX = "), liftConst("const IN_SERVICE_MAX_MONTHS_AHEAD = "), liftConst("const ADMIN_FEE_PCT_MAX = "),
	liftConst("const TRUCK_AMOUNT_MAX = "), liftConst("const TRUCK_AMOUNT_FIELDS = [", "\n];"),
].join("\n");

// `Buffer` is handed in so the runner can count what the lifted code decodes.
// `crypto` is handed in because the global of that name is Web Crypto, which
// has no createHash().
let decodes = 0;
const CountingBuffer = Object.assign(Object.create(Buffer), {
	from: (...args) => { if (args[1] === "base64") decodes++; return Buffer.from(...args); },
});
function buildModule() {
	return new Function("imageLimits", "todayKeyCT", "Buffer", "crypto",
		`"use strict";\n${CONSTS}\n${FUNCTIONS.map((n) => FN_SRC[n]).join("\n")}\nreturn { ${FUNCTIONS.join(", ")}, TRUCK_AMOUNT_FIELDS };`
	)(imageLimits, () => "2026-09-26", CountingBuffer, crypto);
}
const M = buildModule();

// A lifted route's catch logs through console.error. Collected, not printed:
// every path asserted here answers without one.
const logged = [];
async function quiet(fn) {
	const e = console.error;
	console.error = (...args) => logged.push(args.map(String).join(" "));
	try { return await fn(); } finally { console.error = e; }
}
function mountRoute(routeSrc, env) {
	let handler = null;
	const grab = (p, ...rest) => { handler = rest[rest.length - 1]; };
	const all = {
		app: { get: grab, post: grab, put: grab },
		requireAuth: (req, res, next) => next(),
		requireRole: () => (req, res, next) => next(),
		...env,
	};
	const names = Object.keys(all);
	new Function(...names, routeSrc)(...names.map((k) => all[k]));
	if (typeof handler !== "function") die("a lifted route did not register a handler");
	return (req) => quiet(async () => {
		const out = { status: 200, headers: {}, body: undefined };
		const res = {
			status(c) { out.status = c; return this; },
			json(b) { out.body = b; return this; },
			setHeader(k, v) { out.headers[String(k).toLowerCase()] = v; },
			end(b) { out.body = b; return this; },
		};
		await handler({ params: {}, query: {}, body: {}, headers: {}, sessionID: "t-sid", ...req }, res);
		return out;
	});
}

// ── fixtures ────────────────────────────────────────────────────────────────
function segment(marker, payload) {
	const s = Buffer.alloc(4 + payload.length);
	s[0] = 0xff; s[1] = marker; s.writeUInt16BE(2 + payload.length, 2);
	payload.copy(s, 4);
	return s;
}
// A JPEG header with a frame of the given size and no image data: enough for
// checkImage() to read, which is all the write check decodes.
function jpegHeader(width, height) {
	const frame = Buffer.alloc(15);
	frame[0] = 8; frame.writeUInt16BE(height, 1); frame.writeUInt16BE(width, 3); frame[5] = 3;
	return Buffer.concat([Buffer.from([0xff, 0xd8]), segment(0xe0, Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1")), segment(0xc0, frame), Buffer.from([0xff, 0xd9])]);
}
function webpVp8x(width, height) {
	const b = Buffer.alloc(30);
	b.write("RIFF", 0, "latin1"); b.writeUInt32LE(22, 4); b.write("WEBP", 8, "latin1");
	b.write("VP8X", 12, "latin1"); b.writeUInt32LE(10, 16);
	b.writeUIntLE(width - 1, 24, 3); b.writeUIntLE(height - 1, 27, 3);
	return b;
}
// A PNG signature and IHDR declaring the given size: all checkImage() reads.
function pngHeader(width, height) {
	const b = Buffer.alloc(33);
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
	b.writeUInt32BE(13, 8); b.write("IHDR", 12, "latin1");
	b.writeUInt32BE(width, 16); b.writeUInt32BE(height, 20);
	b[24] = 8; b[25] = 2;
	return b;
}
const HTML = Buffer.from("<!doctype html><html><head><title>Truck 33</title></head><body><p>Truck 33</p></body></html>");
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="3"><rect width="4" height="3" fill="#36c"/></svg>');
const PDF = Buffer.from("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n", "latin1");
const GIF = Buffer.concat([Buffer.from("GIF89a", "latin1"), Buffer.from([4, 0, 3, 0, 0x80, 0, 0]), Buffer.alloc(16)]);
// A phone photo in the format the old Add form stored as it came.
const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheicmif1heic", "latin1"), Buffer.alloc(24)]);
const WEBP = webpVp8x(4, 3);
const uri = (label, buf) => `data:${label};base64,${buf.toString("base64")}`;
// What a photo that passes is stored as: the type its bytes are, and base64
// exactly as the bytes encode.
const canonical = (buf) => uri(imageLimits.servedType(buf), buf);
// Base64 wrapped at 76 columns (as MIME writes it) with a trailing newline: the
// decoder skips the whitespace, so it decodes to the same bytes.
const wrapped = (label, buf) => `data:${label};base64,${buf.toString("base64").replace(/.{1,76}/g, "$&\r\n")} `;
let JPEG, PNG; // real, decodable images — encoded in main()

const SUPER = { id: 1, username: "super_admin", role: "Super Admin" };
const DISPATCHER = { id: 2, username: "kevin", role: "Dispatcher" };
const DRIVER = { id: 3, username: "sking", role: "Driver", driverName: "Shorn King" };
const INVESTOR = { id: 9, username: "acme", role: "Investor" };

const TRUCKS_DDL = `CREATE TABLE trucks (
	id INTEGER PRIMARY KEY AUTOINCREMENT, unit_number TEXT UNIQUE, make TEXT DEFAULT '', model TEXT DEFAULT '',
	year INTEGER DEFAULT 0, vin TEXT DEFAULT '', license_plate TEXT DEFAULT '', status TEXT DEFAULT 'Active',
	assigned_driver TEXT DEFAULT '', notes TEXT DEFAULT '', owner_id INTEGER DEFAULT 0, driver_pay_daily REAL DEFAULT 0,
	purchase_price REAL DEFAULT 0, title_status TEXT DEFAULT 'Clean', maintenance_fund_monthly REAL DEFAULT 0,
	fuel_tank_gallons REAL DEFAULT 0, avg_mpg REAL DEFAULT 0, in_service_date TEXT DEFAULT '', retired_at TEXT DEFAULT '',
	photo TEXT DEFAULT '', insurance_monthly REAL DEFAULT 0, eld_monthly REAL DEFAULT 0, truck_payment_monthly REAL DEFAULT 0,
	hvut_annual REAL DEFAULT 0, irp_annual REAL DEFAULT 0, admin_fee_pct REAL DEFAULT 50, created_at TEXT DEFAULT '',
	routemate_vehicle_id TEXT DEFAULT '')`;
function makeDb() {
	const db = new Database(":memory:");
	db.exec(TRUCKS_DDL);
	db.exec("CREATE TABLE driver_onboarding (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, application_id INTEGER)");
	db.exec("CREATE TABLE job_applications (id INTEGER PRIMARY KEY AUTOINCREMENT, cdl_front TEXT DEFAULT '', cdl_back TEXT DEFAULT '', medical_card TEXT DEFAULT '')");
	db.exec("CREATE TABLE truck_assignments (id INTEGER PRIMARY KEY AUTOINCREMENT, truck_id INTEGER, driver_name TEXT, start_date TEXT, end_date TEXT DEFAULT '')");
	const truck = db.prepare("INSERT INTO trucks (id, unit_number, make, status, assigned_driver, notes, owner_id, photo) VALUES (?, ?, 'Freightliner', 'Active', ?, '', 5, ?)");
	truck.run(1, "LogisX-#33", "Shorn King", "");
	truck.run(2, "LogisX-#91", "", uri("image/heic", HEIC)); // stored before the write check existed
	truck.run(3, "LogisX-#302", "", "");
	db.prepare("INSERT INTO job_applications (id) VALUES (7)").run();
	db.prepare("INSERT INTO driver_onboarding (user_id, application_id) VALUES (3, 7)").run();
	return db;
}
const truckRow = (db, id) => db.prepare("SELECT * FROM trucks WHERE id = ?").get(id);
const snapshot = (db) => JSON.stringify({
	trucks: db.prepare("SELECT * FROM trucks ORDER BY id").all(),
	assignments: db.prepare("SELECT * FROM truck_assignments ORDER BY id").all(),
});
const bytesOf = (out) => (Buffer.isBuffer(out.body) ? out.body : null);
const NOT_FOUND = { status: 404, body: { error: "Not found" }, contentType: null };
const shape = (out) => ({ status: out.status, body: Buffer.isBuffer(out.body) ? "<bytes>" : out.body, contentType: out.headers["content-type"] || null });
const REFUSED_415 = { error: imageLimits.MESSAGES.truckPhoto[415], code: "UNSUPPORTED_IMAGE_TYPE", field: "photo" };
const REFUSED_413 = { error: imageLimits.MESSAGES.truckPhoto[413], code: "IMAGE_TOO_LARGE", field: "photo" };

// ═══════════════════════════════════════════════════════════════ §1
function servingSection() {
	section("§1 storedFileForServing()");
	const serve = (value, opts) => {
		const r = opts === undefined ? M.storedFileForServing(value) : M.storedFileForServing(value, opts);
		return r && { contentType: r.contentType, same: Buffer.isBuffer(r.body) && r.body.equals(value.slice ? Buffer.from(value.slice(value.indexOf(",") + 1), "base64") : Buffer.alloc(0)) };
	};
	eq(serve(uri("image/jpeg", JPEG)), { contentType: "image/jpeg", same: true }, "§1 a JPEG: image/jpeg, the stored bytes");
	eq(serve(uri("image/png", PNG)), { contentType: "image/png", same: true }, "§1 a PNG: image/png");
	eq(serve(uri("image/webp", WEBP)), { contentType: "image/webp", same: true }, "§1 a WebP: image/webp");
	eq(serve(uri("image/jpeg", PNG)), { contentType: "image/png", same: true }, "§1 PNG bytes under an image/jpeg label: image/png (the bytes decide)");
	eq(serve(uri("image/svg+xml", JPEG)), { contentType: "image/jpeg", same: true }, "§1 JPEG bytes under an SVG label: image/jpeg");
	eq(serve(uri(`image/${"x".repeat(2000)}`, JPEG)), { contentType: "image/jpeg", same: true }, "§1 a label of any length is not read");
	eq(serve(uri("application/pdf", PDF)), null, "§1 a PDF, images only (the truck photo): null");
	eq(serve(uri("application/pdf", PDF), { pdf: true }), { contentType: "application/pdf", same: true }, "§1 a PDF with { pdf: true } (identity files): application/pdf");
	eq(serve(uri("application/pdf", JPEG), { pdf: true }), { contentType: "image/jpeg", same: true }, "§1 JPEG bytes under a PDF label: image/jpeg");
	for (const [label, value] of [
		["an HTML document under text/html", uri("text/html", HTML)],
		["an HTML document under image/jpeg", uri("image/jpeg", HTML)],
		["an HTML document under application/pdf", uri("application/pdf", HTML)],
		["an SVG document under image/svg+xml", uri("image/svg+xml", SVG)],
		["a GIF", uri("image/gif", GIF)],
		["a HEIC photo", uri("image/heic", HEIC)],
		["an empty payload", "data:image/jpeg;base64,"],
		["no comma", `data:image/jpeg;base64${JPEG.toString("base64")}`],
		["no ;base64 (a text data URI)", `data:image/jpeg,${JPEG.toString("base64")}`],
		["a parameter after ;base64", `data:image/jpeg;base64;charset=utf-8,${JPEG.toString("base64")}`],
		["the FIRST comma decides the header", `data:text/html,<p>a</p>;base64,${JPEG.toString("base64")}`],
		["a path, not a data URI", "/uploads/trucks/33.jpg"],
		["DATA: in capitals", `DATA:image/jpeg;base64,${JPEG.toString("base64")}`],
		["blank", ""],
	]) {
		for (const pdf of [false, true]) eq(M.storedFileForServing(value, { pdf }), null, `§1 ${label}${pdf ? " ({ pdf: true })" : ""}: null`);
	}
	for (const [label, value] of [["undefined", undefined], ["null", null], ["a number", 42], ["an object", { src: "x" }], ["a Buffer", JPEG]]) {
		eq(M.storedFileForServing(value), null, `§1 ${label}: null, no throw`);
	}
}

// ═══════════════════════════════════════════════════════════════ §2 + §3
async function getSections() {
	section("§2 GET /api/driver/me/truck-photo");
	const db = makeDb();
	const photoEnv = (d) => ({ db: d, storedFileForServing: M.storedFileForServing, storedFileETag: M.storedFileETag, ifNoneMatchIncludes: M.ifNoneMatchIncludes });
	const getPhoto = mountRoute(ROUTES.truckPhoto, photoEnv(db));
	const photoAs = (user, stored, headers = {}) => {
		db.prepare("UPDATE trucks SET photo = ? WHERE id = 1").run(stored);
		return getPhoto({ session: { user }, headers });
	};
	// The ETag scheme, worked out here rather than through the shipped helper:
	// the quoted first 32 hex digits of the stored value's SHA-256.
	const etagOf = (stored) => `"${crypto.createHash("sha256").update(stored).digest("hex").slice(0, 32)}"`;
	{
		const out = await photoAs(DRIVER, uri("image/jpeg", JPEG));
		ok(out.status === 200 && out.headers["content-type"] === "image/jpeg" && JPEG.equals(bytesOf(out) || Buffer.alloc(0)),
			`§2 a JPEG: 200 image/jpeg with the exact bytes (got ${out.status} ${out.headers["content-type"]})`);
		eq([out.headers["cache-control"], out.headers["x-content-type-options"]], ["private, no-cache", "nosniff"],
			"§2 ...revalidated with the server on every use (private, no-cache), with nosniff");
		eq(out.headers.etag ?? null, etagOf(uri("image/jpeg", JPEG)), "§2 ...and an ETag: the quoted first 32 hex digits of the stored value's SHA-256");
		eq(out.headers["content-disposition"] ?? null, null, "§2 ...and inline: no Content-Disposition");
	}
	{
		// Revalidation: the browser keeps the photo with its ETag and asks again on
		// every use; the route answers 304 while the stored photo is the one that
		// ETag names.
		const JPEG_URI = uri("image/jpeg", JPEG), PNG_URI = uri("image/png", PNG);
		const E1 = etagOf(JPEG_URI), E2 = etagOf(PNG_URI);
		ok(E1 !== E2, "§2 (fixture) two stored photos, two ETags");
		const hit = await photoAs(DRIVER, JPEG_URI, { "if-none-match": E1 });
		eq({ status: hit.status, body: hit.body ?? null, etag: hit.headers.etag ?? null, cache: hit.headers["cache-control"] ?? null, type: hit.headers["content-type"] ?? null },
			{ status: 304, body: null, etag: E1, cache: "private, no-cache", type: null },
			"§2 If-None-Match naming the stored photo's ETag: 304 with no body, its ETag and Cache-Control, no Content-Type");
		for (const [label, header] of [
			["that ETag weakened (W/)", `W/${E1}`],
			["that ETag in a list", `"0000" , ${E1},W/"1111"`],
			['"*"', "*"],
		]) {
			const out = await photoAs(DRIVER, JPEG_URI, { "if-none-match": header });
			eq([out.status, out.body ?? null], [304, null], `§2 If-None-Match ${label}: 304 with no body`);
		}
		for (const [label, header] of [
			["another photo's ETag", E2],
			["that ETag unquoted", E1.slice(1, -1)],
			["a prefix of that ETag", `${E1.slice(0, 17)}"`],
			["blank", ""],
			["a comma alone", ","],
		]) {
			const out = await photoAs(DRIVER, JPEG_URI, { "if-none-match": header });
			ok(out.status === 200 && JPEG.equals(bytesOf(out) || Buffer.alloc(0)) && out.headers.etag === E1,
				`§2 If-None-Match ${label}: 200 with the bytes and the stored photo's ETag (got ${out.status})`);
		}
		// The stored photo changes: the ETag the browser holds no longer names it.
		const changed = await photoAs(DRIVER, PNG_URI, { "if-none-match": E1 });
		ok(changed.status === 200 && changed.headers["content-type"] === "image/png" && PNG.equals(bytesOf(changed) || Buffer.alloc(0)),
			`§2 a different stored photo, asked with the old ETag: 200 with the new bytes (got ${changed.status} ${changed.headers["content-type"]})`);
		eq([changed.headers.etag ?? null, changed.headers["cache-control"] ?? null], [E2, "private, no-cache"],
			"§2 ...under the new photo's ETag, revalidated on every use");
		eq((await photoAs(DRIVER, PNG_URI, { "if-none-match": E2 })).status, 304, "§2 ...and that new ETag is answered 304");
		// Nothing servable is never a 304, whatever If-None-Match names.
		const HTML_URI = uri("image/jpeg", HTML);
		for (const [label, header] of [["the stored value's own hash", etagOf(HTML_URI)], ['"*"', "*"]]) {
			eq(shape(await photoAs(DRIVER, HTML_URI, { "if-none-match": header })), NOT_FOUND,
				`§2 a stored value that is not an image, If-None-Match ${label}: 404, not 304`);
		}
		eq(shape(await getPhoto({ session: { user: { ...DRIVER, driverName: "Rodney Brown" } }, headers: { "if-none-match": "*" } })), NOT_FOUND,
			'§2 a driver on no truck, If-None-Match "*": 404, not 304');
	}
	{
		// Each request is answered for the session that sends it: another driver,
		// whose truck has a different photo, sending the first photo's ETag is sent
		// their own photo in full.
		const db2 = makeDb();
		db2.prepare("UPDATE trucks SET photo = ? WHERE id = 1").run(uri("image/jpeg", JPEG));
		db2.prepare("UPDATE trucks SET assigned_driver = 'Marcus Hale', photo = ? WHERE id = 3").run(uri("image/png", PNG));
		const get2 = mountRoute(ROUTES.truckPhoto, photoEnv(db2));
		const E1 = etagOf(uri("image/jpeg", JPEG));
		const mine = await get2({ session: { user: DRIVER }, headers: { "if-none-match": E1 } });
		eq(mine.status, 304, "§2 (control) the first driver, sending their photo's ETag: 304");
		const other = await get2({ session: { user: { id: 4, username: "mhale", role: "Driver", driverName: "Marcus Hale" } }, headers: { "if-none-match": E1 } });
		ok(other.status === 200 && other.headers["content-type"] === "image/png" && PNG.equals(bytesOf(other) || Buffer.alloc(0)) &&
			other.headers.etag === etagOf(uri("image/png", PNG)),
			`§2 another driver, whose truck has a different photo, sending that ETag: 200 with their own photo under its own ETag (got ${other.status})`);
	}
	{
		const out = await photoAs(DRIVER, uri("image/jpeg", PNG));
		ok(out.status === 200 && out.headers["content-type"] === "image/png" && PNG.equals(bytesOf(out) || Buffer.alloc(0)),
			`§2 PNG bytes under an image/jpeg label: 200 image/png (got ${out.status} ${out.headers["content-type"]})`);
	}
	{
		const out = await photoAs(DRIVER, uri("image/webp", WEBP));
		ok(out.status === 200 && out.headers["content-type"] === "image/webp", `§2 a WebP: 200 image/webp (got ${out.headers["content-type"]})`);
	}
	for (const [label, stored] of [
		["an HTML document under text/html", uri("text/html", HTML)],
		["an SVG document under image/svg+xml", uri("image/svg+xml", SVG)],
		["an HTML document under image/jpeg", uri("image/jpeg", HTML)],
		["a PDF (not a truck photo type)", uri("application/pdf", PDF)],
		["a GIF", uri("image/gif", GIF)],
		["a HEIC photo", uri("image/heic", HEIC)],
		["an empty payload", "data:image/jpeg;base64,"],
		["a malformed value (no comma)", `data:image/jpeg;base64${JPEG.toString("base64")}`],
		["a malformed value (no ;base64)", `data:image/jpeg,${JPEG.toString("base64")}`],
		["no photo", ""],
	]) {
		eq(shape(await photoAs(DRIVER, stored)), NOT_FOUND, `§2 ${label}: 404, no Content-Type of its own`);
	}
	eq(shape(await getPhoto({ session: { user: { ...DRIVER, driverName: "Rodney Brown" } } })), NOT_FOUND, "§2 a driver on no truck: 404");
	eq(shape(await getPhoto({ session: { user: SUPER } })), NOT_FOUND, "§2 a Super Admin (no driver name of their own): 404, not 403");
	for (const user of [DISPATCHER, INVESTOR]) {
		db.prepare("UPDATE trucks SET photo = ? WHERE id = 1").run(uri("image/jpeg", JPEG));
		const out = await getPhoto({ session: { user } });
		eq([out.status, out.body], [403, { error: "Forbidden" }], `§2 a ${user.role}: 403, as before`);
		const conditional = await getPhoto({ session: { user }, headers: { "if-none-match": etagOf(uri("image/jpeg", JPEG)) } });
		eq([conditional.status, conditional.body], [403, { error: "Forbidden" }], `§2 a ${user.role} sending the photo's ETag: still 403, not 304`);
	}
	// ifNoneMatchIncludes() on its own, against the tag "abc".
	for (const [label, header, want] of [
		["absent", undefined, false],
		["blank", "", false],
		["not text", ['"abc"'], false],
		["the tag", '"abc"', true],
		["the tag weakened", 'W/"abc"', true],
		["the tag in a spaced list", ' "x" ,  W/"abc" ', true],
		['"*"', "*", true],
		['"*" with spaces', " * ", true],
		["another tag", '"abd"', false],
		["the tag unquoted", "abc", false],
		["a lowercase w/ (not the weak prefix)", 'w/"abc"', false],
	]) {
		eq(M.ifNoneMatchIncludes(header, '"abc"'), want, `§2 ifNoneMatchIncludes(${label}): ${want}`);
	}

	section("§3 GET /api/driver/me/identity-file/:fileType");
	const getFile = mountRoute(ROUTES.identityFile, { db, storedFileForServing: M.storedFileForServing });
	const fileAs = (user, fileType, col, stored) => {
		if (col) db.prepare(`UPDATE job_applications SET ${col} = ? WHERE id = 7`).run(stored);
		return getFile({ session: { user }, params: { fileType } });
	};
	{
		const out = await fileAs(DRIVER, "cdl-front", "cdl_front", uri("application/pdf", PDF));
		ok(out.status === 200 && out.headers["content-type"] === "application/pdf" && PDF.equals(bytesOf(out) || Buffer.alloc(0)),
			`§3 a PDF: 200 application/pdf with the exact bytes (got ${out.status} ${out.headers["content-type"]})`);
		eq([out.headers["cache-control"] ?? null, out.headers["x-content-type-options"] ?? null], ["private, no-store", "nosniff"],
			"§3 ...not kept by the browser (private, no-store), with nosniff");
		eq(out.headers["content-disposition"] ?? null, 'attachment; filename="CDL-Front.pdf"', "§3 ...as a download named CDL-Front.pdf, the Driver Kit's own name");
	}
	// The Driver Kit's <a download> names (DriverKit.vue: the label, spaces as
	// hyphens). A Content-Disposition filename overrides that attribute, so the
	// header sends the same names and a driver's download is named as before.
	for (const [fileType, col, name] of [
		["cdl-front", "cdl_front", "CDL-Front.pdf"], ["cdl-back", "cdl_back", "CDL-Back.pdf"], ["medical-card", "medical_card", "Medical-Card.pdf"],
	]) {
		const out = await fileAs(DRIVER, fileType, col, uri("image/jpeg", PDF));
		eq([out.status, out.headers["content-type"], out.headers["content-disposition"] ?? null], [200, "application/pdf", `attachment; filename="${name}"`],
			`§3 a PDF stored as ${fileType} (under an image label): a download named ${name}`);
	}
	{
		// ...and the same names read from DriverKit.vue itself: its add('<label>',
		// app.<column>_type, '<fileType>') calls and its downloadName rule, held
		// against what the shipped route sends for each fileType. A label, the
		// rule or the server's map changed alone fails here.
		const KIT = fs.readFileSync(path.join(__dirname, "..", "client", "src", "components", "driver", "DriverKit.vue"), "utf8");
		const RULE = "downloadName: `${label.replace(/\\s+/g, '-')}.${type === 'pdf' ? 'pdf' : 'jpg'}`,";
		ok(KIT.includes(RULE), "§3 DriverKit.vue names a PDF download by its label with each whitespace run as a hyphen, plus .pdf (its downloadName rule, verbatim)");
		const kitFiles = [...KIT.matchAll(/\badd\('([^'\n]{1,40})', app\.[a-z_]{1,40}_type, '([a-z-]{1,40})'\)/g)].map((m) => ({ label: m[1], fileType: m[2] }));
		eq(kitFiles.map((f) => f.fileType).sort(), ["cdl-back", "cdl-front", "medical-card"], "§3 DriverKit.vue lists the three identity files, one add() each");
		const stored = uri("application/pdf", PDF);
		db.prepare("UPDATE job_applications SET cdl_front = ?, cdl_back = ?, medical_card = ? WHERE id = 7").run(stored, stored, stored);
		for (const { label, fileType } of kitFiles) {
			const kitName = `${label.replace(/\s+/g, "-")}.pdf`;
			const out = await getFile({ session: { user: DRIVER }, params: { fileType } });
			eq(out.headers["content-disposition"] ?? null, `attachment; filename="${kitName}"`,
				`§3 ${fileType}: the route's download name is the Driver Kit's for ${JSON.stringify(label)}, ${kitName}`);
		}
	}
	{
		const out = await fileAs(DRIVER, "cdl-back", "cdl_back", uri("image/jpeg", JPEG));
		ok(out.status === 200 && out.headers["content-type"] === "image/jpeg" && JPEG.equals(bytesOf(out) || Buffer.alloc(0)),
			`§3 a JPEG: 200 image/jpeg with the exact bytes (got ${out.status} ${out.headers["content-type"]})`);
		eq(out.headers["content-disposition"] ?? null, null, "§3 ...inline: no Content-Disposition (the Driver Kit shows it as a background)");
		eq([out.headers["cache-control"] ?? null, out.headers["x-content-type-options"] ?? null], ["private, no-store", "nosniff"],
			"§3 ...and an image is not kept by the browser either (private, no-store), with nosniff");
	}
	{
		const out = await fileAs(DRIVER, "medical-card", "medical_card", uri("application/pdf", JPEG));
		ok(out.status === 200 && out.headers["content-type"] === "image/jpeg", `§3 JPEG bytes under a PDF label: image/jpeg (got ${out.headers["content-type"]})`);
		eq(out.headers["content-disposition"] ?? null, null, "§3 ...inline: the bytes decide, not the label");
	}
	for (const [label, bytes, type] of [["a PNG", PNG, "image/png"], ["a WebP", WEBP, "image/webp"]]) {
		const out = await fileAs(DRIVER, "cdl-front", "cdl_front", uri("application/pdf", bytes));
		eq([out.status, out.headers["content-type"], out.headers["content-disposition"] ?? null], [200, type, null], `§3 ${label}: ${type}, inline`);
	}
	for (const [label, stored] of [
		["an HTML document under text/html", uri("text/html", HTML)],
		["an HTML document under application/pdf", uri("application/pdf", HTML)],
		["an SVG document under image/svg+xml", uri("image/svg+xml", SVG)],
		["a malformed value (no comma) — it was 500", `data:application/pdf;base64${PDF.toString("base64")}`],
		["a malformed value (no ;base64) — it was 500", `data:application/pdf,${PDF.toString("base64")}`],
		["an empty payload", "data:application/pdf;base64,"],
		["no file", ""],
	]) {
		eq(shape(await fileAs(DRIVER, "medical-card", "medical_card", stored)), NOT_FOUND, `§3 ${label}: 404`);
	}
	for (const fileType of ["ssn", "photo", "cdl_front", "__proto__", "constructor", "toString"]) {
		const out = await fileAs(DRIVER, fileType, null);
		eq([out.status, out.body], [400, { error: "Invalid file type" }], `§3 fileType ${JSON.stringify(fileType)}: 400, not one of the three names`);
	}
	eq(shape(await fileAs(SUPER, "cdl-front", null)), NOT_FOUND, "§3 a Super Admin with no application of their own: 404, not 403");
	for (const user of [DISPATCHER, INVESTOR]) {
		const out = await fileAs(user, "cdl-front", null);
		eq([out.status, out.body], [403, { error: "Forbidden" }], `§3 a ${user.role}: still 403`);
	}
	eq(logged, [], "§2/§3 no path logged anything — a malformed value is a 404, not an error");
}

// ═══════════════════════════════════════════════════════════════ §4
function refusalSection() {
	section("§4 truckPhotoForStorage()");
	const r415 = { status: 415, body: { error: imageLimits.MESSAGES.truckPhoto[415], code: "UNSUPPORTED_IMAGE_TYPE" } };
	const r413 = { status: 413, body: { error: imageLimits.MESSAGES.truckPhoto[413], code: "IMAGE_TOO_LARGE" } };
	for (const [label, v] of [["undefined (not sent)", undefined], ["null (a clear)", null], ['"" (a clear)', ""]]) {
		const r = M.truckPhotoForStorage(v);
		ok(r && Object.keys(r).join() === "value" && r.value === v, `§4 ${label}: { value } as given (got ${JSON.stringify(r)})`);
	}
	// A photo that passes is stored as the type its bytes are, base64 re-encoded.
	eq(canonical(PNG), uri("image/png", PNG), "§4 (fixture) the canonical form of a PNG is its own data URI");
	for (const [label, v, stored] of [
		["a JPEG", uri("image/jpeg", JPEG), uri("image/jpeg", JPEG)],
		["a PNG", uri("image/png", PNG), uri("image/png", PNG)],
		["a WebP", uri("image/webp", WEBP), uri("image/webp", WEBP)],
		["PNG bytes under an image/jpeg label", uri("image/jpeg", PNG), uri("image/png", PNG)],
		["JPEG bytes under an SVG label", uri("image/svg+xml", JPEG), uri("image/jpeg", JPEG)],
		["WebP bytes under a label of 2,000 characters", uri(`image/${"x".repeat(2000)}`, WEBP), uri("image/webp", WEBP)],
		["base64 wrapped at 76 columns, with a trailing space", wrapped("image/jpeg", JPEG), uri("image/jpeg", JPEG)],
		["base64 with its padding left off", uri("image/png", PNG).replace(/=+$/, ""), uri("image/png", PNG)],
		["base64 in the URL-safe alphabet", uri("image/jpeg", JPEG).replace(/\+/g, "-").replace(/\//g, "_"), uri("image/jpeg", JPEG)],
		["a 4,000 × 4,000 JPEG (exactly the 16 MP ceiling)", uri("image/jpeg", jpegHeader(4000, 4000)), uri("image/jpeg", jpegHeader(4000, 4000))],
		["a 4,000 × 4,000 PNG (exactly the 16 MP ceiling)", uri("image/png", pngHeader(4000, 4000)), uri("image/png", pngHeader(4000, 4000))],
	]) {
		eq(M.truckPhotoForStorage(v), { value: stored }, `§4 ${label}: allowed, stored as ${stored.slice(0, stored.indexOf(",") + 1)}…`);
	}
	ok(wrapped("image/jpeg", JPEG).includes("\r\n") && uri("image/png", PNG).endsWith("=") && /[+/]/.test(JPEG.toString("base64")),
		"§4 (fixture) the wrapped, unpadded and URL-safe variants each differ from the canonical text");
	for (const [label, v] of [
		["a number", 12345], ["an object", { src: uri("image/jpeg", JPEG) }], ["an array", [uri("image/jpeg", JPEG)]], ["true", true], ["a Buffer", JPEG],
		["an HTML document under text/html", uri("text/html", HTML)],
		["an HTML document under image/jpeg", uri("image/jpeg", HTML)],
		["an SVG document under image/svg+xml", uri("image/svg+xml", SVG)],
		["a PDF", uri("application/pdf", PDF)],
		["a GIF", uri("image/gif", GIF)],
		["a HEIC photo", uri("image/heic", HEIC)],
		["an empty payload", "data:image/jpeg;base64,"],
		["no comma", `data:image/jpeg;base64${JPEG.toString("base64")}`],
		["no ;base64", `data:image/jpeg,${JPEG.toString("base64")}`],
		["a path, not a data URI", "/uploads/trucks/33.jpg"],
		["a JPEG whose size cannot be read", uri("image/jpeg", jpegHeader(640, 480).subarray(0, 20))],
	]) {
		eq(M.truckPhotoForStorage(v), r415, `§4 ${label}: 415 UNSUPPORTED_IMAGE_TYPE, the truckPhoto wording`);
	}
	// 16 MP: one row over, as each type declares it.
	for (const [label, v] of [
		["a JPEG one row over 16 MP (4,001 × 4,000)", uri("image/jpeg", jpegHeader(4001, 4000))],
		["a PNG header declaring 4,001 × 4,000", uri("image/png", pngHeader(4001, 4000))],
		["a WebP declaring 4,000 × 4,001", uri("image/webp", webpVp8x(4000, 4001))],
		["a 10,000 × 10,000 JPEG (the old 100 MP ceiling)", uri("image/jpeg", jpegHeader(10000, 10000))],
	]) {
		eq(M.truckPhotoForStorage(v), r413, `§4 ${label}: 413 IMAGE_TOO_LARGE, the truckPhoto wording`);
	}

	// 2 MiB of image bytes: the edge is allowed, one byte over is 413 — a string
	// short enough to decode, refused on what it decodes to.
	eq(imageLimits.TRUCK_PHOTO_MAX_BYTES, 2 * 1024 * 1024, "§4 (fixture) TRUCK_PHOTO_MAX_BYTES is 2 MiB");
	const sized = (n) => Buffer.concat([JPEG, Buffer.alloc(n - JPEG.length)]);
	const atBytes = sized(imageLimits.TRUCK_PHOTO_MAX_BYTES);
	const overBytes = sized(imageLimits.TRUCK_PHOTO_MAX_BYTES + 1);
	ok(uri("image/jpeg", overBytes).length <= imageLimits.TRUCK_PHOTO_DATA_URI_MAX_LENGTH, "§4 (fixture) the 2 MiB + 1 byte photo is under the length cap");
	ok(M.truckPhotoForStorage(uri("image/jpeg", atBytes)).value === uri("image/jpeg", atBytes), "§4 a 2 MiB JPEG (exactly the byte ceiling): allowed, stored as sent");
	eq(M.truckPhotoForStorage(uri("image/jpeg", overBytes)), r413, "§4 a JPEG one byte over 2 MiB: 413 IMAGE_TOO_LARGE");
	eq(imageLimits.checkImage(overBytes, imageLimits.LIMITS.TRUCK_PHOTO).reason, "bytes", "§4 ...refused by checkImage() on its bytes");

	// The length cap, at its exact edge, and before anything is decoded.
	const MAX = imageLimits.TRUCK_PHOTO_DATA_URI_MAX_LENGTH;
	const b64 = atBytes.toString("base64");
	const atCap = `data:image/${"x".repeat(MAX - b64.length - "data:image/;base64,".length)};base64,${b64}`;
	eq(atCap.length, MAX, "§4 (fixture) a data URI exactly at TRUCK_PHOTO_DATA_URI_MAX_LENGTH");
	ok(M.truckPhotoForStorage(atCap).value === uri("image/jpeg", atBytes),
		"§4 a 2 MiB JPEG in a data URI exactly at the cap: allowed, stored under image/jpeg");
	decodes = 0;
	eq(M.truckPhotoForStorage(`${atCap}A`), r413, "§4 one character over the cap: 413 IMAGE_TOO_LARGE");
	eq(decodes, 0, "§4 ...refused without decoding anything");
	decodes = 0;
	M.truckPhotoForStorage(uri("image/jpeg", HTML));
	eq(decodes, 1, "§4 (control) a string under the cap is decoded once");
	ok(MAX >= Math.ceil(imageLimits.TRUCK_PHOTO_MAX_BYTES / 3) * 4 + "data:image/webp;base64,".length,
		"§4 the cap admits TRUCK_PHOTO_MAX_BYTES under any of the three image labels");
}

// ═══════════════════════════════════════════════════════════════ §5 + §6
// Everything the two truck routes reach besides the lifted parsers is stubbed:
// the month-end locks, the active-load check, the sheet, the audit trail and the
// driver assignment. `calls` records whether a refusal reached any of them.
function mountTrucks(db) {
	const calls = { editLock: 0, createLock: 0, jt: 0, activeLoad: 0, assign: 0, audit: [] };
	const refuse = (req, res) => res.status(409).json({ code: "PERIOD_STUB" });
	const env = {
		db,
		...M,
		truckEditLockBlockers: () => { calls.editLock++; return { unreadable: false, blockers: [] }; },
		truckCreateLockBlockers: () => { calls.createLock++; return { unreadable: false, blockers: [] }; },
		periodBlockedResponse: refuse,
		periodLockUnreadableResponse: refuse,
		truckChargeFromMonth: () => "",
		truckChargeUntilMonth: () => "",
		checkDriverActiveLoad: async () => { calls.activeLoad++; return null; },
		getJobTrackingCached: async () => { calls.jt++; return { headers: [], data: [] }; },
		driverHistoryFloorMonth: () => ({ floor: "", unbounded: false }),
		canonicalDriverName: (name) => String(name || "").trim(),
		assignDriverToTruck: () => { calls.assign++; },
		syncDriverToCarrierSheet: () => {},
		refusePayEdit: (req, res) => res.status(403).json({ code: "PAY_EDIT_ADMIN_ONLY" }),
		auditText: (s, n) => String(s || "").slice(0, n),
		logAudit: (req, action) => { calls.audit.push(action); },
		fuelModel: { DEFAULT_TANK_GALLONS: 200 },
		notifyChange: () => {},
	};
	const put = mountRoute(ROUTES.truckPut, env);
	const post = mountRoute(ROUTES.truckPost, env);
	return {
		put: (user, id, body) => put({ session: { user }, params: { id: String(id) }, body }),
		post: (user, body) => post({ session: { user }, body }),
		calls,
	};
}

async function putSection() {
	section("§5 PUT /api/trucks/:id");
	const LEGACY = uri("image/heic", HEIC);
	{
		// The Edit form resends the stored photo with every save.
		const db = makeDb();
		const { put } = mountTrucks(db);
		const out = await put(DISPATCHER, 2, { notes: "new tyres", photo: LEGACY });
		const t = truckRow(db, 2);
		ok(out.status === 200 && t.notes === "new tyres" && t.photo === LEGACY,
			`§5 a save resending the stored photo (not an image) beside a notes change: 200, the note saved, the photo as it was (got ${out.status} ${JSON.stringify(out.body)})`);
	}
	{
		const db = makeDb();
		db.prepare("UPDATE trucks SET photo = ? WHERE id = 1").run(uri("image/jpeg", JPEG));
		const { put } = mountTrucks(db);
		const out = await put(SUPER, 1, { make: "Volvo", photo: uri("image/jpeg", JPEG) });
		ok(out.status === 200 && truckRow(db, 1).make === "Volvo", `§5 a save resending a stored image: 200 (got ${out.status})`);
	}
	{
		// A photo stored before normalization — PNG bytes under an image/jpeg label,
		// base64 wrapped — resent unchanged: written back exactly as stored.
		const db = makeDb();
		const OLD = wrapped("image/jpeg", PNG);
		db.prepare("UPDATE trucks SET photo = ? WHERE id = 1").run(OLD);
		const { put } = mountTrucks(db);
		const out = await put(DISPATCHER, 1, { notes: "rotated", photo: OLD });
		ok(out.status === 200 && truckRow(db, 1).notes === "rotated" && truckRow(db, 1).photo === OLD,
			`§5 a resend of a stored photo that is not canonical: 200, the photo untouched (got ${out.status} ${JSON.stringify(out.body)})`);
	}
	for (const [label, who, photo, expect] of [
		["an HTML document under image/jpeg", DISPATCHER, uri("image/jpeg", HTML), REFUSED_415],
		["an SVG document", SUPER, uri("image/svg+xml", SVG), REFUSED_415],
		["a PDF", SUPER, uri("application/pdf", PDF), REFUSED_415],
		["a malformed value", SUPER, `data:image/jpeg,${JPEG.toString("base64")}`, REFUSED_415],
		["a value that is not text", DISPATCHER, { src: uri("image/jpeg", JPEG) }, REFUSED_415],
		["a number", SUPER, 7, REFUSED_415],
		["a string over the length cap", SUPER, `data:image/jpeg;base64,${"A".repeat(imageLimits.TRUCK_PHOTO_DATA_URI_MAX_LENGTH)}`, REFUSED_413],
		["a JPEG one byte over 2 MiB", DISPATCHER, uri("image/jpeg", Buffer.concat([JPEG, Buffer.alloc(imageLimits.TRUCK_PHOTO_MAX_BYTES + 1 - JPEG.length)])), REFUSED_413],
		["a PNG declaring more than 16 MP", SUPER, uri("image/png", pngHeader(4001, 4000)), REFUSED_413],
	]) {
		const db = makeDb();
		const { put, calls } = mountTrucks(db);
		const before = snapshot(db);
		const out = await put(who, 2, { notes: "new tyres", photo, assignedDriver: "Shorn King" });
		eq([out.status, out.body], [expect.code === "IMAGE_TOO_LARGE" ? 413 : 415, expect], `§5 a change to ${label}: refused with field "photo"`);
		ok(snapshot(db) === before && calls.editLock === 0 && calls.activeLoad === 0 && calls.assign === 0 && calls.audit.length === 0,
			`§5 ...nothing written, and neither the month-end lock, the active-load check nor the assignment reached (${JSON.stringify(calls)})`);
	}
	for (const [label, photo, stored] of [
		["a JPEG", uri("image/jpeg", JPEG), uri("image/jpeg", JPEG)],
		["a PNG", uri("image/png", PNG), uri("image/png", PNG)],
		["a WebP", uri("image/webp", WEBP), uri("image/webp", WEBP)],
		["PNG bytes under an image/jpeg label", uri("image/jpeg", PNG), uri("image/png", PNG)],
		["a JPEG in wrapped base64", wrapped("image/jpeg", JPEG), uri("image/jpeg", JPEG)],
	]) {
		const db = makeDb();
		const { put } = mountTrucks(db);
		const out = await put(DISPATCHER, 2, { photo });
		const got = truckRow(db, 2).photo;
		ok(out.status === 200 && got === stored,
			`§5 a change to ${label}: 200, stored canonical as ${stored.slice(0, stored.indexOf(",") + 1)}… (got ${out.status} ${JSON.stringify(out.body)}, ${String(got).slice(0, 40)}…)`);
	}
	{
		// The same image the truck already has, sent under another label: a change
		// of text, stored canonical, and so the same stored value it replaces.
		const db = makeDb();
		db.prepare("UPDATE trucks SET photo = ? WHERE id = 1").run(uri("image/png", PNG));
		const { put } = mountTrucks(db);
		const out = await put(SUPER, 1, { photo: wrapped("image/jpeg", PNG) });
		ok(out.status === 200 && truckRow(db, 1).photo === uri("image/png", PNG), `§5 the stored image resent as other text: stored canonical, unchanged (got ${out.status})`);
	}
	for (const [label, photo, stored] of [['""', "", ""], ["null", null, null]]) {
		const db = makeDb();
		const { put } = mountTrucks(db);
		const out = await put(SUPER, 2, { photo });
		ok(out.status === 200 && truckRow(db, 2).photo === stored, `§5 ${label} clears the photo (got ${out.status}, ${JSON.stringify(truckRow(db, 2).photo)})`);
	}
	{
		const db = makeDb();
		const { put } = mountTrucks(db);
		const out = await put(SUPER, 2, { notes: "no photo field" });
		ok(out.status === 200 && truckRow(db, 2).photo === LEGACY, `§5 a save without the photo field leaves it alone (got ${out.status})`);
	}
}

async function postSection() {
	section("§6 POST /api/trucks");
	const add = (over = {}) => ({ unitNumber: "LogisX-#23", make: "Volvo", status: "Active", ownerId: 5, driverPayDaily: 0, ...over });
	for (const [label, who, photo, expect] of [
		["a Super Admin, an HTML document under image/jpeg", SUPER, uri("image/jpeg", HTML), REFUSED_415],
		["a Dispatcher, an SVG document", DISPATCHER, uri("image/svg+xml", SVG), REFUSED_415],
		["a Super Admin, a PDF", SUPER, uri("application/pdf", PDF), REFUSED_415],
		["a Super Admin, a photo that is not text", SUPER, { src: uri("image/jpeg", JPEG) }, REFUSED_415],
		["a Dispatcher, a malformed value", DISPATCHER, `data:image/jpeg;base64${JPEG.toString("base64")}`, REFUSED_415],
		["a Super Admin, a string over the length cap", SUPER, `data:image/png;base64,${"A".repeat(imageLimits.TRUCK_PHOTO_DATA_URI_MAX_LENGTH)}`, REFUSED_413],
		["a Dispatcher, a JPEG one byte over 2 MiB", DISPATCHER, uri("image/jpeg", Buffer.concat([JPEG, Buffer.alloc(imageLimits.TRUCK_PHOTO_MAX_BYTES + 1 - JPEG.length)])), REFUSED_413],
		["a Super Admin, a PNG declaring more than 16 MP", SUPER, uri("image/png", pngHeader(4001, 4000)), REFUSED_413],
	]) {
		const db = makeDb();
		const { post, calls } = mountTrucks(db);
		const before = snapshot(db);
		const out = await post(who, add({ photo, assignedDriver: "Rodney Brown" }));
		eq([out.status, out.body], [expect.code === "IMAGE_TOO_LARGE" ? 413 : 415, expect], `§6 ${label}: refused with field "photo"`);
		ok(snapshot(db) === before && calls.jt === 0 && calls.activeLoad === 0 && calls.createLock === 0 && calls.audit.length === 0,
			`§6 ...nothing inserted, and neither the sheet, the active-load check nor the month-end lock reached (${JSON.stringify(calls)})`);
	}
	for (const [label, who, photo, stored] of [
		["a Super Admin, a JPEG", SUPER, uri("image/jpeg", JPEG), uri("image/jpeg", JPEG)],
		["a Super Admin, PNG bytes under an image/jpeg label", SUPER, uri("image/jpeg", PNG), uri("image/png", PNG)],
		["a Dispatcher, a WebP in wrapped base64", DISPATCHER, wrapped("image/webp", WEBP), uri("image/webp", WEBP)],
	]) {
		const db = makeDb();
		const { post } = mountTrucks(db);
		const out = await post(who, add({ unitNumber: "LogisX-#24", photo }));
		const t = db.prepare("SELECT * FROM trucks WHERE unit_number = 'LogisX-#24'").get();
		ok(out.status === 200 && !!t && t.photo === stored,
			`§6 ${label}: created, the photo stored canonical as ${stored.slice(0, stored.indexOf(",") + 1)}… (got ${out.status} ${JSON.stringify(out.body)})`);
	}
	for (const [label, photo] of [["an HTML document under image/jpeg", uri("image/jpeg", HTML)], ["a photo that is not text", { src: "x" }]]) {
		const db = makeDb();
		const { post } = mountTrucks(db);
		const out = await post(INVESTOR, add({ unitNumber: "INV-24-B", photo, driverPayDaily: undefined }));
		const t = db.prepare("SELECT * FROM trucks WHERE unit_number = 'INV-24-B'").get();
		ok(out.status === 200 && !!t && t.photo === "" && t.owner_id === INVESTOR.id,
			`§6 an Investor, ${label}: not refused — created, the photo ignored as before (got ${out.status} ${JSON.stringify(out.body)}, ${JSON.stringify(t && t.photo)})`);
	}
}

// ═══════════════════════════════════════════════════════════════ §7
function sourcePins() {
	section("§7 source pins");
	const code = (s) => s.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
	for (const name of ["storedFileForServing", "truckPhotoForStorage"]) {
		const body = code(FN_SRC[name]);
		ok(!/\.(test|exec|match|matchAll|replace|split|search)\(|new RegExp|\/\^/.test(body), `§7 ${name}() runs no pattern over the value`);
	}
	{
		// One split(), on a literal comma. A pattern literal would need a slash
		// outside the "W/" strings.
		const body = code(FN_SRC.ifNoneMatchIncludes);
		ok(!/RegExp|\.(test|exec|match|matchAll|replace|search)\(/.test(body) && !body.split('"W/"').join("").includes("/") &&
			(body.match(/\.split\(/g) || []).length === 1 && body.includes('header.split(",")'),
			"§7 ifNoneMatchIncludes() runs no pattern over If-None-Match: one split() on a literal comma");
	}
	const sff = code(FN_SRC.storedFileForServing);
	ok(sff.includes('const comma = dataUri.indexOf(",");') && sff.includes('.endsWith(";base64")') && sff.includes("imageLimits.servedType(body, { pdf })"),
		"§7 storedFileForServing() splits on the first comma and takes the type from servedType()");
	const tps = code(FN_SRC.truckPhotoForStorage);
	const capAt = tps.indexOf("value.length > imageLimits.TRUCK_PHOTO_DATA_URI_MAX_LENGTH");
	ok(capAt > 0 && capAt < tps.indexOf("storedFileForServing(value)") && tps.includes("imageLimits.checkImage(file.body, imageLimits.LIMITS.TRUCK_PHOTO)"),
		"§7 truckPhotoForStorage() caps the length before it decodes, then parses as the route serves and checks the TRUCK_PHOTO limits");
	const passAt = tps.indexOf('return { value: `data:${file.contentType};base64,${file.body.toString("base64")}` };');
	ok(passAt > 0 && tps.indexOf("if (!verdict.ok) return refusal(verdict);") < passAt,
		"§7 ...and answers a photo that passes as the sniffed type and the re-encoded bytes, only after checkImage() passed it");
	for (const [label, key, call] of [
		["truck-photo", "truckPhoto", "storedFileForServing(row?.photo)"],
		["identity-file", "identityFile", "storedFileForServing(row?.data, { pdf: true })"],
	]) {
		const r = code(ROUTES[key]);
		const types = r.match(/setHeader\("Content-Type", [^)]*\)/g) || [];
		ok(r.includes(call) && JSON.stringify(types) === JSON.stringify(['setHeader("Content-Type", file.contentType)']) && !/base64,\(/.test(r),
			`§7 GET ${label} serves through ${call} and sends no Content-Type but the sniffed one (got ${JSON.stringify(types)})`);
	}
	{
		const r = code(ROUTES.identityFile);
		const dispositions = r.match(/setHeader\("Content-Disposition"/g) || [];
		const branch = r.indexOf('if (file.contentType === "application/pdf") {');
		ok(dispositions.length === 1 && branch > r.indexOf("if (!col) return res.status(400)") && r.indexOf('setHeader("Content-Disposition"') > branch &&
			r.includes('res.setHeader("Content-Disposition", `attachment; filename="${pdfDownloadName[req.params.fileType]}"`);'),
			"§7 GET identity-file sends one Content-Disposition, attachment, only for a PDF and only once fileType is one of the three names");
		const names = r.match(/const pdfDownloadName = \{[^}]*\}/);
		ok(!!names && names[0].includes('"cdl-front": "CDL-Front.pdf"') && names[0].includes('"cdl-back": "CDL-Back.pdf"') &&
			names[0].includes('"medical-card": "Medical-Card.pdf"') && (names[0].match(/:/g) || []).length === 3,
			"§7 ...named by a fixed map holding exactly the Driver Kit's three names");
		ok(!code(ROUTES.truckPhoto).includes("Content-Disposition"), "§7 GET truck-photo sends no Content-Disposition");
	}
	const put = code(ROUTES.truckPut);
	const putCheck = put.indexOf('if (photo !== undefined && photo !== null && photo !== "" && photo !== (truck.photo || "")) {');
	ok(putCheck > 0 && put.indexOf("truckPhotoForStorage(photo)") > putCheck, "§7 PUT keys the photo check on a change from the stored photo");
	ok(putCheck < put.indexOf("truckEditLockBlockers(") && putCheck < put.indexOf("await ") && putCheck < put.indexOf("assignDriverToTruck(") &&
		putCheck < put.indexOf("db.prepare(`UPDATE trucks SET"), "§7 ...before the month-end lock, the first await and every write");
	ok(put.includes("let photoToStore = photo;") && put.includes("photoToStore = photoChecked.value;") &&
		put.includes('if (photo !== undefined) { updates.push("photo = ?"); params.push(photoToStore); }') && !/params\.push\(photo\)/.test(put),
		"§7 ...and the UPDATE writes the checked value when the photo changed, and a resend as it is");
	const post = code(ROUTES.truckPost);
	const postCheck = post.indexOf("truckPhotoForStorage(photo)");
	const postGate = post.indexOf('if (costsAllowed && photo !== undefined && photo !== null && photo !== "") {');
	const allowedAt = post.indexOf('const costsAllowed = req.session.user.role === "Super Admin" || req.session.user.role === "Dispatcher";');
	ok(postCheck > 0 && allowedAt > 0 && allowedAt < postGate && postGate < postCheck,
		"§7 POST checks the photo for the two roles whose photo is stored (costsAllowed, decided above the check)");
	ok((post.match(/req\.session\.user\.role === "Super Admin" \|\| req\.session\.user\.role === "Dispatcher"/g) || []).length === 1,
		"§7 ...and that predicate is written once in the route");
	ok(postCheck < post.indexOf("parseDriverPayDaily(") && postCheck < post.indexOf("await ") && postCheck < post.indexOf("INSERT INTO trucks"),
		"§7 ...before its first read, await and the INSERT");
	ok(post.includes('let createPhoto = "";') && (post.match(/createPhoto = /g) || []).length === 2 && post.includes("createPhoto = photoChecked.value;"),
		"§7 ...and the INSERT stores the checked value, or nothing");
}

(async () => {
	const img = new Jimp({ width: 4, height: 3, color: 0x3366ccff });
	JPEG = await img.getBuffer("image/jpeg", { quality: 80 });
	PNG = await img.getBuffer("image/png");
	servingSection();
	await getSections();
	refusalSection();
	await putSection();
	await postSection();
	sourcePins();

	console.log(`\n${"=".repeat(64)}`);
	if (failures.length) {
		console.log(`✗ ${failures.length} assertion(s) failed, ${pass} passed:`);
		for (const f of failures) console.log(`  - ${f}`);
		process.exit(1);
	}
	console.log(`✓ ${pass} assertions passed`);
})().catch((e) => { console.error(e); process.exit(1); });
