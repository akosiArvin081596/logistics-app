#!/usr/bin/env node
// scripts/pod-upload-shape-look.js: Part A of the POD upload-normalize plan
// (reports/2026-11-19-pod-upload-normalize-plan.md §6 and §11), read-only and counts only.
//
// Over the live POD and BOL rows uploaded in the last --days (30 unless set), it takes the files that
// imageToPdf() wrote from image uploads (one JPEG per page, each page the size of its image, as pdfkit
// writes them) and counts every other file as untouched. Each such page's JPEG, embedded as it came,
// goes through the real upload steps (lib/pod-upload-shape.js: the whitelist, one decode in a child,
// quality 70, 60, 50, the time limits) in memory. Then, for each load with such a page, its Triumph
// batch is estimated three ways (the batch size report's estimates for the invoice, the CSV and the
// rate con): as stored today, after the upload steps, and after both steps, the upload steps and then
// way 1 (lib/triumph-batch-recompress.js's own child, at 70, 60, then 50, from the shaped bytes, a copy
// kept only when smaller), since way 1 stays as it is (N1).
//
// It prints counts, shares, bytes, milliseconds and fixed words only: never a load, a name, a user, an
// amount or a file name. It opens the database read-only, reads the files and writes nothing.
//
// Usage, on the server from the app directory, with the Node pm2 runs:
//   node scripts/pod-upload-shape-look.js --db=app.db --uploads=uploads [--days=30] [--limit=3000]
// --limit caps the pages measured (the rest are counted as not measured).
// Exit codes: 0 measured, 1 an error, 2 refused.

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const shapeLib = require(path.join(ROOT, "lib", "pod-upload-shape.js"));
const slotsLib = require(path.join(ROOT, "lib", "image-child-slots.js"));
const way1 = require(path.join(ROOT, "lib", "triumph-batch-recompress.js"));
const triumphRules = require(path.join(ROOT, "lib", "triumph-rules.js"));
const autoRules = require(path.join(ROOT, "lib", "auto-invoice-rules.js"));
const sizeReport = require(path.join(ROOT, "scripts", "triumph-batch-size-report.js"));

const KNOWN_ARGS = new Set(["db", "uploads", "days", "limit"]);
const MAX_FILE_BYTES = 60 * 1024 * 1024;
// scanKitLimiter's budget: 120 scans per user per 15 minutes (POST /api/documents/scan).
const SCAN_WINDOW_MS = 15 * 60 * 1000;
const SCAN_LIMIT = 120;
// What the card sends, by the size it sends it at: ScanKit's page (1536 wide), the scan's photo
// attached as-is (1280 on its long edge), a picture from Upload File, "+" or a drop (1200).
const SOURCES = Object.freeze(["scan", "scan photo as-is", "upload file", "other size"]);

const refused = (msg) => Object.assign(new Error(msg), { refused: true });

function parseArgs(argv) {
	const out = {};
	for (const a of argv) {
		const m = /^--([a-z]{1,10})(?:=(.*))?$/.exec(String(a));
		if (!m || !KNOWN_ARGS.has(m[1])) throw refused(`unknown argument ${JSON.stringify(String(a).slice(0, 40))}`);
		out[m[1]] = m[2] === undefined ? true : m[2];
	}
	return out;
}

function wholeIn(raw, lo, hi, fallback) {
	if (raw === undefined) return fallback;
	const n = Number(raw);
	if (!Number.isInteger(n) || n < lo || n > hi) throw refused(`a whole number from ${lo} to ${hi} is needed`);
	return n;
}

function sourceOf(width, height) {
	if (width === 1536) return "scan";
	const edge = Math.max(width, height);
	if (edge === 1280) return "scan photo as-is";
	if (edge === 1200) return "upload file";
	return "other size";
}

// The pages of a PDF that imageToPdf() wrote: one JPEG image per page, drawn the size of the page.
// { jpegs: [{ bytes, width, height }] }, or { untouched: reason }.
async function pdfkitPages(buffer) {
	const { PDFDocument, PDFName, PDFDict, PDFRef, PDFRawStream, PDFNumber, PDFArray } = require(path.join(ROOT, "node_modules", "pdf-lib"));
	if (!buffer.subarray(0, 5).equals(Buffer.from("%PDF-"))) return { untouched: "not a PDF" };
	let doc;
	try {
		doc = await PDFDocument.load(buffer, { updateMetadata: false });
	} catch {
		return { untouched: "unreadable PDF" };
	}
	const pages = doc.getPages();
	if (!pages.length) return { untouched: "unreadable PDF" };
	const num = (v) => (v instanceof PDFNumber ? v.asNumber() : NaN);
	const jpegs = [];
	for (const page of pages) {
		const res = page.node.Resources();
		const xo = res instanceof PDFDict ? res.lookup(PDFName.of("XObject")) : null;
		const images = [];
		if (xo instanceof PDFDict) {
			for (const [, v] of xo.entries()) {
				const s = v instanceof PDFRef ? doc.context.lookup(v) : null;
				if (s instanceof PDFRawStream && s.dict.lookup(PDFName.of("Subtype")) === PDFName.of("Image")) images.push(s);
			}
		}
		if (images.length !== 1) return { untouched: "not one image a page" };
		const s = images[0];
		const filter = s.dict.lookup(PDFName.of("Filter"));
		const dct = filter === PDFName.of("DCTDecode") || (filter instanceof PDFArray && filter.size() === 1 && filter.lookup(0) === PDFName.of("DCTDecode"));
		const width = num(s.dict.lookup(PDFName.of("Width")));
		const height = num(s.dict.lookup(PDFName.of("Height")));
		const { width: pw, height: ph } = page.getSize();
		if (!dct) return { untouched: "not one image a page" };
		if (Math.round(pw) !== width || Math.round(ph) !== height) return { untouched: "pages not the image's size" };
		jpegs.push({ bytes: Buffer.from(s.getContents()), width, height });
	}
	return { jpegs };
}

// The nearest-rank percentile, as the size report states it.
function percentile(sorted, p) {
	if (!sorted.length) return null;
	return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

const share = (n, d) => (d ? `${Math.round((1000 * n) / d) / 10}%` : "n/a");
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

// The most pages one user's uploads would send to the scan in any 15 minutes, per user.
function peaksByUser(events) {
	const byUser = new Map();
	for (const e of events) {
		const k = e.user === null || e.user === undefined ? "unknown" : String(e.user);
		if (!byUser.has(k)) byUser.set(k, []);
		byUser.get(k).push(e);
	}
	const peaks = [];
	for (const list of byUser.values()) {
		list.sort((a, b) => a.at - b.at);
		let best = 0;
		let start = 0;
		let inWindow = 0;
		for (let i = 0; i < list.length; i++) {
			inWindow += list[i].pages;
			while (list[i].at - list[start].at >= SCAN_WINDOW_MS) inWindow -= list[start++].pages;
			best = Math.max(best, inWindow);
		}
		peaks.push(best);
	}
	return peaks;
}

async function build({ db, uploadsDir, days = 30, limit = 3000, deps = {} }) {
	const shaper = deps.shaper || shapeLib.createShaper({ encode: shapeLib.createEncoder({ slots: slotsLib.createUploadSlots({ reserved: 1 }) }) });
	const way1Encode = deps.way1Encode || way1.createEncoder();
	const now = deps.clock || (() => Date.now());
	const kinds = Object.keys(triumphRules.DOCUMENT_KINDS);
	const rows = db.prepare(
		`SELECT id, load_id, type, file_name, drive_url, uploaded_by_user_id,
		        CAST(strftime('%s', uploaded_at) AS INTEGER) AS at_s,
		        CASE WHEN uploaded_at >= datetime('now', ?) THEN 1 ELSE 0 END AS in_window
		 FROM documents
		 WHERE deleted_at IS NULL AND UPPER(TRIM(type)) IN (${kinds.map(() => "?").join(",")})`,
	).all(`-${days} days`, ...kinds);

	const untouched = new Map();
	const count = (map, k, n = 1) => map.set(k, (map.get(k) || 0) + n);
	const pagesBySource = Object.fromEntries(SOURCES.map((s) => [s, { pages: 0, within: 0, byQuality: Object.fromEntries(shapeLib.STEPS.map((q) => [q, 0])), large: 0 }]));
	const leftReasons = new Map();
	const whitelistRejects = new Map();
	const times = [];
	const childTimes = [];
	const scanEvents = [];
	let measured = 0;
	let notMeasured = 0;
	let windowRows = 0;
	// Per load: each batch document's bytes as stored, and how the upload steps would change them.
	const loads = new Map();
	const loadOf = (key) => {
		if (!loads.has(key)) loads.set(key, { files: [], touched: false });
		return loads.get(key);
	};

	for (const row of rows) {
		const key = autoRules.loadKey(row.load_id);
		const kind = triumphRules.documentKind(row.type);
		if (!key || !kind) continue;
		const file = autoRules.documentLocalPath(uploadsDir, row);
		let bytes = null;
		try {
			if (file) bytes = fs.statSync(file).size;
		} catch {
			bytes = null;
		}
		const entry = { kind, bytes, shaped: null };
		loadOf(key).files.push(entry);
		if (!(row.in_window === 1 && (kind === "pod" || kind === "bol"))) continue;
		windowRows++;
		if (bytes === null) { count(untouched, "file missing"); continue; }
		if (bytes > MAX_FILE_BYTES) { count(untouched, "file too large to read"); continue; }
		const parsed = await pdfkitPages(fs.readFileSync(file));
		if (parsed.untouched) { count(untouched, parsed.untouched); continue; }
		const pages = [];
		let uploadFilePages = 0;
		for (const jp of parsed.jpegs) {
			const source = sourceOf(jp.width, jp.height);
			if (source === "upload file") uploadFilePages++;
			if (measured >= limit) {
				notMeasured++;
				pages.push({ before: jp.bytes, after: jp.bytes });
				continue;
			}
			measured++;
			const t0 = now();
			const { pages: [p] } = await shaper.shapePages([jp.bytes]);
			const ms = now() - t0;
			times.push(ms);
			const b = pagesBySource[source];
			b.pages++;
			if (p.outcome === "within") b.within++;
			else if (p.outcome === "recompressed") {
				b.byQuality[p.quality] = (b.byQuality[p.quality] || 0) + 1;
				childTimes.push(ms);
			} else {
				b.large++;
				count(leftReasons, p.reason);
				if (p.reason === "whitelist") count(whitelistRejects, p.detail || "other");
				if (p.reason === "floor" || p.reason === "check") childTimes.push(ms);
			}
			pages.push({ before: jp.bytes, after: p.bytes });
		}
		if (uploadFilePages) scanEvents.push({ user: row.uploaded_by_user_id, at: Number(row.at_s) * 1000, pages: uploadFilePages });
		const saved = pages.reduce((n, p) => n + p.before.length - p.after.length, 0);
		entry.shaped = { bytes: bytes - saved, pages };
		loadOf(key).touched = true;
	}

	// The batches of the loads with a shaped page: today, after the upload steps, after both steps.
	const rateCons = sizeReport.readDocuments(db, uploadsDir).rateCons;
	const touched = [...loads.entries()].filter(([, l]) => l.touched);
	const sizeOf = (key, pick) => {
		const files = loads.get(key).files.map((f) => ({ key, kind: f.kind, bytes: pick(f) }));
		return sizeReport.batchSizes({ files, rateCons }).sizes.get(key);
	};
	const fits = (v) => v < sizeReport.LIMIT_BYTES;
	let fitToday = 0;
	let fitAfterUpload = 0;
	const fitAfterWay1 = Object.fromEntries(way1.STEPS.map((q) => [q, 0]));
	let overAfterBoth = 0;
	for (const [key, load] of touched) {
		if (fits(sizeOf(key, (f) => f.bytes))) fitToday++;
		const afterUpload = sizeOf(key, (f) => (f.shaped ? f.shaped.bytes : f.bytes));
		if (fits(afterUpload)) { fitAfterUpload++; continue; }
		// Way 1, as it runs on a batch over the limit: each step from the shaped photos' own bytes.
		let fitAt = null;
		for (const quality of way1.STEPS) {
			let saved = 0;
			for (const f of load.files) {
				for (const p of f.shaped ? f.shaped.pages : []) {
					const v = shapeLib.jpegVerdict(p.after);
					if (!v.take) continue;
					const r = await way1Encode(v.stripped, quality);
					const jpeg = r && Buffer.isBuffer(r.jpeg) ? r.jpeg : null;
					if (jpeg && jpeg.length < p.after.length && way1.newJpegOk(jpeg, v.width, v.height)) saved += p.after.length - jpeg.length;
				}
			}
			if (fits(afterUpload - saved)) { fitAt = quality; break; }
		}
		if (fitAt === null) overAfterBoth++;
		else fitAfterWay1[fitAt]++;
	}

	const sorted = (a) => [...a].sort((x, y) => x - y);
	const allSorted = sorted(times);
	const childSorted = sorted(childTimes);
	const peaks = peaksByUser(scanEvents);
	const uploadFileTotal = scanEvents.reduce((n, e) => n + e.pages, 0);
	const lines = [
		"Part A, the POD upload-normalize look: read-only; nothing is written, kept or sent.",
		`The window: the last ${plural(days, "day")}; live POD and BOL rows in it: ${windowRows}.`,
		`Page budget ${shapeLib.PAGE_BUDGET_BYTES} bytes, steps ${shapeLib.STEPS.join(", ")}; the upload's ${shapeLib.UPLOAD_BUDGET_MS} ms and a photo's ${shapeLib.IMAGE_TIMEOUT_MS} ms.`,
		`Pages measured: ${measured}; not measured (past --limit): ${notMeasured}.`,
		`Untouched files: ${[...untouched.values()].reduce((a, b) => a + b, 0)}${untouched.size ? ` (${[...untouched.entries()].sort().map(([k, v]) => `${k} ${v}`).join("; ")})` : ""}.`,
	];
	for (const s of SOURCES) {
		const b = pagesBySource[s];
		if (!b.pages) continue;
		let under = b.within;
		const steps = shapeLib.STEPS.map((q) => {
			under += b.byQuality[q] || 0;
			return `by ${q}: ${share(under, b.pages)}`;
		}).join(", ");
		lines.push(`${s}: ${plural(b.pages, "page")}; under the budget as it came: ${share(b.within, b.pages)}; ${steps}; left over the budget: ${b.large}.`);
	}
	lines.push(`Left as they came over the budget, by reason: ${leftReasons.size ? [...leftReasons.entries()].sort().map(([k, v]) => `${k} ${v}`).join("; ") : "none"}.`);
	lines.push(`The whitelist's rejects among them: ${whitelistRejects.size ? [...whitelistRejects.entries()].sort().map(([k, v]) => `${k} ${v}`).join("; ") : "none"}.`);
	lines.push(`Time a page, all measured pages: p50 ${percentile(allSorted, 0.5) ?? "n/a"} ms, p95 ${percentile(allSorted, 0.95) ?? "n/a"} ms; pages a child ran for: p50 ${percentile(childSorted, 0.5) ?? "n/a"} ms, p95 ${percentile(childSorted, 0.95) ?? "n/a"} ms.`);
	lines.push(`Loads with a measured page: ${touched.length}; their batch fits Triumph's ${sizeReport.LIMIT_BYTES - 1} bytes (estimated): today ${fitToday}; after the upload steps ${fitAfterUpload}; after both steps (the upload steps, then way 1) ${fitAfterUpload + Object.values(fitAfterWay1).reduce((a, b) => a + b, 0)} (way 1 at ${way1.STEPS.map((q) => `${q}: ${fitAfterWay1[q]}`).join(", ")}); still over after both: ${overAfterBoth}.`);
	lines.push(`Upload File, "+" and drop pages the scan-all switch would send to ScanKit: ${uploadFileTotal}; the most one user's uploads would send in any 15 minutes: ${peaks.length ? Math.max(...peaks) : 0}; users whose 15-minute peak passes ScanKit's ${SCAN_LIMIT}: ${peaks.filter((p) => p > SCAN_LIMIT).length}.`);
	return { lines, counts: { windowRows, measured, notMeasured, untouched: Object.fromEntries(untouched), pagesBySource, leftReasons: Object.fromEntries(leftReasons), whitelistRejects: Object.fromEntries(whitelistRejects), loads: touched.length, fitToday, fitAfterUpload, fitAfterWay1, overAfterBoth, uploadFileTotal, peaks } };
}

async function run(argv, deps = {}) {
	const args = parseArgs(argv);
	if (typeof args.db !== "string" || !args.db) throw refused("--db=<app.db> is required");
	if (typeof args.uploads !== "string" || !args.uploads) throw refused("--uploads=<uploads folder> is required");
	const days = wholeIn(args.days, 1, 120, 30);
	const limit = wholeIn(args.limit, 1, 100000, 3000);
	const uploadsDir = path.resolve(args.uploads);
	if (!(fs.existsSync(uploadsDir) && fs.statSync(uploadsDir).isDirectory())) throw refused("--uploads is not a folder");
	const db = sizeReport.openReadOnly(path.resolve(args.db));
	try {
		return await build({ db, uploadsDir, days, limit, deps });
	} finally {
		db.close();
	}
}

async function main() {
	let out;
	try {
		out = await run(process.argv.slice(2));
	} catch (e) {
		if (!e.refused) {
			console.error(`FAILED: ${String((e && e.message) || e).slice(0, 300)}`);
			process.exit(1);
		}
		console.error(`REFUSED: ${e.message}`);
		process.exit(2);
	}
	console.log(out.lines.join("\n"));
}

if (require.main === module) main();

module.exports = { run, build, pdfkitPages, sourceOf, peaksByUser, percentile };
