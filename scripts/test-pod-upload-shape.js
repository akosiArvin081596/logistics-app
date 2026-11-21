#!/usr/bin/env node
// scripts/test-pod-upload-shape.js: POD and BOL photos shaped at upload (decision 59), the library and
// its Part A: lib/pod-upload-shape.js, lib/pod-upload-image-child.js, lib/image-child-slots.js and
// scripts/pod-upload-shape-look.js.
//
//   §1 the switches: on only for exactly "true" (trimmed), each its own
//   §2 the page box (N3): s = min(72/150, 540/w, 720/h) points a pixel on the page as drawn, `scale` never
//      `fit`: 1200 x 900 drawn 576 x 432 on landscape Letter at 150 dpi; a 1536 x 1988 scan inside
//      540 x 720 (about 205 dpi, 7.5 x 9.7 in); an orientation-6 1280 x 960 on a portrait page; the PDF's
//      page box and drawn box read back from its content, its image stream the JPEG as given, with a
//      fixed clock
//   §3 the page budget: a 469 KB page under 200 KB at the same pixel size; one still over at 50 goes as
//      it came, flagged; a slow child passes its time limit and a child error leaves its page as it came,
//      each flagged; page count and order kept in a mixed 5-page upload; the whitelist's refusals
//   §4 the row's counts, "unknown" for a client that sends no page sources, and the audit words
//   §5 the shared cap (N6): its number, uploads hold at most cap - 1, a job whose upload has answered
//      never starts, a full queue answers at once
//   §6 Part A (N9, N1): read-only and counts only, on a made-up database; pdfkit's image uploads only;
//      the loads that fit after both steps (the upload steps, then way 1)
//   §7 mutants: one per new check, each caught against its passing control
//
// Every case needs the new modules, so each fails on the old code; the guards that pass on the base by
// design are the upload route's (scripts/test-documents-role-gates.js §7). Made-up photos only
// (scripts/lib/made-up-jpeg.js). Temporary folders only; no port and no network.
//   node scripts/test-pod-upload-shape.js      # exits 1 on any failure

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const Module = require("module");

const ROOT = path.join(__dirname, "..");
const jpegs = require("./lib/made-up-jpeg");

function tryRequire(rel) {
	try {
		return require(path.join(ROOT, rel));
	} catch {
		return null;
	}
}
const shape = tryRequire("lib/pod-upload-shape.js");
const slotsLib = tryRequire("lib/image-child-slots.js");
const look = tryRequire("scripts/pod-upload-shape-look.js");
const way1 = require(path.join(ROOT, "lib", "triumph-batch-recompress.js"));

let pass = 0;
const failures = [];
function ok(cond, label, detail) {
	if (cond) {
		pass++;
		console.log(`ok    ${label}`);
	} else {
		failures.push(label);
		console.log(`FAIL  ${label}${detail !== undefined ? `  (${typeof detail === "string" ? detail : JSON.stringify(detail)})` : ""}`);
	}
}
const section = (t) => console.log(`\n${t}`);
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
const near = (a, b, eps = 0.01) => Math.abs(a - b) <= eps;
const FIXED = Object.freeze({ CreationDate: new Date("2026-11-02T15:04:05Z") });
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pod-upload-shape-"));
// The slots' wait timers don't hold a process open (unref), so this run holds itself open.
const keepAlive = setInterval(() => {}, 1000);

// A copy of a module with one exact edit, compiled where the module lives, or null when it can't be
// built (no such module, or the edit's text is not there exactly once).
function mutantOf(rel, from, to) {
	try {
		const file = path.join(ROOT, rel);
		const src = fs.readFileSync(file, "utf8");
		if (src.split(from).length - 1 !== 1) return null;
		const m = new Module(file, module);
		m.filename = file;
		m.paths = Module._nodeModulePaths(path.dirname(file));
		m._compile(src.replace(from, to), file);
		return m.exports;
	} catch {
		return null;
	}
}
async function holds(fn) {
	try {
		return Boolean(await fn());
	} catch {
		return false;
	}
}
const mutants = [];
// Runs `check` against the real module (the control) and against a mutant, later in §7.
function withMutant(label, check, rel, from, to) {
	mutants.push({ label, check, rel, from, to });
}

// Each page's size and the box its one image is drawn in, read back from the content stream: every
// `cm` composed (the last applies first), the unit square mapped through them.
async function drawnBoxes(pdf) {
	const { PDFDocument, PDFName, PDFArray, PDFRef } = require(path.join(ROOT, "node_modules", "pdf-lib"));
	const doc = await PDFDocument.load(pdf, { updateMetadata: false });
	return doc.getPages().map((page) => {
		const { width, height } = page.getSize();
		const contents = page.node.Contents();
		const parts = contents instanceof PDFArray ? contents.asArray().map((r) => (r instanceof PDFRef ? doc.context.lookup(r) : r)) : [contents];
		const text = parts.map((s) => {
			const raw = Buffer.from(s.getContents());
			return s.dict.lookup(PDFName.of("Filter")) === PDFName.of("FlateDecode") ? zlib.inflateSync(raw).toString("latin1") : raw.toString("latin1");
		}).join("\n");
		const ms = [...text.matchAll(/(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) cm/g)].map((m) => m.slice(1, 7).map(Number));
		const corners = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => {
			let p = [x, y];
			for (let i = ms.length - 1; i >= 0; i--) {
				const [a, b, c, d, e, f] = ms[i];
				p = [a * p[0] + c * p[1] + e, b * p[0] + d * p[1] + f];
			}
			return p;
		});
		const xs = corners.map((p) => p[0]);
		const ys = corners.map((p) => p[1]);
		return { page: [width, height], x: Math.min(...xs), top: height - Math.max(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
	});
}

// The made-up photos (sizes measured once: the noisy ones barely shrink, the near-blank ones a lot).
const P = {
	big: jpegs.jpeg({ width: 1200, height: 900, quality: 100, seed: 3, blank: true }), //   ~469 KB -> ~41 KB at 70
	floor: jpegs.jpeg({ width: 1200, height: 900, quality: 90, seed: 3 }), //               ~596 KB, still over at 50
	small: jpegs.jpeg({ width: 820, height: 620, quality: 76, seed: 5 }), //                ~175 KB, within the budget
	scan: jpegs.jpeg({ width: 1536, height: 1988, quality: 97, seed: 4, blank: true }), //  ~820 KB, a scan's size
	cmyk: jpegs.jpeg({ width: 820, height: 620, quality: 98, components: 4, seed: 8 }),
	turned: jpegs.jpeg({ width: 1280, height: 960, quality: 98, seed: 9, orientation: 6 }),
	progressive: jpegs.jpeg({ width: 820, height: 620, quality: 98, progressive: true, seed: 10 }),
	rgbIds: jpegs.jpeg({ width: 820, height: 620, quality: 98, ids: [0x52, 0x47, 0x42], seed: 11 }),
	adobe0: jpegs.jpeg({ width: 820, height: 620, quality: 98, adobe: { transform: 0, at: "before" }, seed: 12 }),
	blank820: jpegs.jpeg({ width: 820, height: 620, quality: 100, seed: 6, blank: true }), // ~224 KB -> ~21 KB
};
const BUDGET = 200 * 1024;

function realShaper(over = {}) {
	const slots = slotsLib.createUploadSlots({ reserved: 1 });
	return shape.createShaper({ encode: shape.createEncoder({ slots, ...(over.childPath ? { childPath: over.childPath } : {}) }), info: FIXED, ...over.shaper });
}

(async () => {
	// ---------------------------------------------------------------- §1
	section("§1 the switches");
	const switches = (lib) => {
		const on = (v) => [lib.normalizeEnabled({ POD_UPLOAD_NORMALIZE_ENABLED: v }), lib.scanAllEnabled({ POD_UPLOAD_SCAN_ALL_ENABLED: v })];
		return JSON.stringify([on("true"), on(" true "), on(undefined), on(""), on("1"), on("yes"), on("TRUE"), on("on"), on("false"),
			lib.normalizeEnabled(), lib.normalizeEnabled(null), lib.normalizeEnabled({ POD_UPLOAD_SCAN_ALL_ENABLED: "true" }), lib.scanAllEnabled({ POD_UPLOAD_NORMALIZE_ENABLED: "true" })])
			=== JSON.stringify([[true, true], [true, true], [false, false], [false, false], [false, false], [false, false], [false, false], [false, false], [false, false], false, false, false, false]);
	};
	ok(await holds(() => switches(shape)), "§1 FAILS ON THE OLD CODE: POD_UPLOAD_NORMALIZE_ENABLED and POD_UPLOAD_SCAN_ALL_ENABLED are on only for exactly \"true\" (trimmed), off unset, and each is its own");
	withMutant("§1's switches: a reader that takes true|1|yes|on", switches, "lib/pod-upload-shape.js",
		'return String((env && env.POD_UPLOAD_NORMALIZE_ENABLED) ?? "").trim() === "true";',
		'return /^(true|1|yes|on)$/i.test(String((env && env.POD_UPLOAD_NORMALIZE_ENABLED) ?? "").trim());');
	ok(await holds(() => ["POD", "pod", " Bol ", "BOL"].every((t) => shape.shapedType(t)) && ["Receipt", "Other", "RATECON", "", null, ["POD"]].every((t) => shape.shapedType(t) === null)),
		"§1 FAILS ON THE OLD CODE: POD and BOL are matched without regard to case; Receipt, Other and anything else are never shaped");

	// ---------------------------------------------------------------- §2
	section("§2 the page box (N3)");
	const box1200 = (lib) => {
		const at = lib.letterPlacement(1200, 900, 1);
		return JSON.stringify(at.size) === "[792,612]" && at.layout === "landscape" && near(at.drawnW, 576) && near(at.drawnH, 432) && near(at.x, 108) && near(at.y, 90) && near(at.dpi, 150) && near(at.scale, 0.48, 1e-9);
	};
	ok(await holds(() => box1200(shape)), "§2 FAILS ON THE OLD CODE: a 1200 x 900 photo is drawn 576 x 432 pt (8 x 6 in) on landscape Letter at 150 dpi, centred");
	withMutant("§2's 1200 x 900 box: drawn to fill the box (no 150 dpi cap)", box1200, "lib/pod-upload-shape.js", "Math.min(72 / BASE_DPI, ", "Math.min(1, ");
	const boxScan = (lib) => {
		const at = lib.letterPlacement(1536, 1988, 1);
		return JSON.stringify(at.size) === "[612,792]" && at.drawnW <= 540 + 1e-9 && at.drawnH <= 720 + 1e-9 && near(at.drawnW, 540) && near(at.drawnH / 72, 9.7, 0.05) && near(at.dpi, 205, 0.5) && near(at.x, 36);
	};
	ok(await holds(() => boxScan(shape)), "§2 FAILS ON THE OLD CODE: a 1536 x 1988 scan is scaled down to fit inside 540 x 720 pt: 7.5 x 9.7 in, about 205 dpi, never under 150");
	withMutant("§2's scan box: no margins", boxScan, "lib/pod-upload-shape.js", "const MARGIN_PT = 36;", "const MARGIN_PT = 0;");
	const boxTurned = (lib) => {
		const at = lib.letterPlacement(1280, 960, 6);
		return JSON.stringify(at.size) === "[612,792]" && at.layout === "portrait" && near(at.drawnW, 460.8) && near(at.drawnH, 614.4);
	};
	ok(await holds(() => boxTurned(shape)), "§2 FAILS ON THE OLD CODE: an orientation-6 photo stored 1280 x 960 is upright 960 x 1280, so its page is portrait, drawn 460.8 x 614.4 pt");
	withMutant("§2's orientation-6 box: the orientation ignored", boxTurned, "lib/pod-upload-shape.js", "const turned = orientation >= 5 && orientation <= 8;", "const turned = false;");

	const pdfBox = async (lib) => {
		const pdf = await lib.letterPdf([P.small, P.turned], { info: FIXED });
		const again = await lib.letterPdf([P.small, P.turned], { info: FIXED });
		const boxes = await drawnBoxes(pdf);
		const images = await jpegs.imagesIn(pdf);
		const a = boxes[0];
		const b = boxes[1];
		const aw = 820 * 0.48;
		const ah = 620 * 0.48;
		return pdf.equals(again)
			&& boxes.length === 2
			&& JSON.stringify(a.page) === "[792,612]" && near(a.w, aw) && near(a.h, ah) && near(a.x, (792 - aw) / 2) && near(a.top, (612 - ah) / 2)
			&& JSON.stringify(b.page) === "[612,792]" && near(b.w, 460.8) && near(b.h, 614.4) && near(b.x, (612 - 460.8) / 2) && near(b.top, (792 - 614.4) / 2)
			&& images.length === 2 && images[0].bytes.equals(P.small) && images[1].bytes.equals(P.turned);
	};
	ok(await holds(() => pdfBox(shape)), "§2 FAILS ON THE OLD CODE: the PDF read back: each page's box and the box its image is drawn in, at 150 dpi, the orientation-6 one upright on a portrait page; each image stream is the JPEG byte for byte; the same bytes twice with a fixed clock");
	withMutant("§2's PDF: drawn with `fit` (the margins' box) instead of `scale`", pdfBox, "lib/pod-upload-shape.js",
		"doc.image(img, at.x, at.y, { scale: at.scale });", "doc.image(img, MARGIN_PT, MARGIN_PT, { fit: [at.size[0] - 2 * MARGIN_PT, at.size[1] - 2 * MARGIN_PT] });");
	ok(await holds(async () => {
		const refused = await shape.letterPdf([Buffer.from("not a photo")]).then(() => null, (e) => e);
		return refused && refused.status === 415;
	}), "§2 FAILS ON THE OLD CODE: a page that isn't a JPEG within the document photo limits is refused before pdfkit sees it (415)");

	// ---------------------------------------------------------------- §3
	section("§3 the page budget");
	const budget = async (lib) => {
		const sh = lib === shape ? realShaper() : lib.createShaper({ encode: lib.createEncoder({ slots: slotsLib.createUploadSlots() }), info: FIXED });
		const r = await sh.shape([P.big]);
		const [im] = await jpegs.imagesIn(r.pdf);
		const f = im && jpegs.frameOf(im.bytes);
		return P.big.length > 450 * 1024 && r.pages[0].outcome === "recompressed" && r.pages[0].quality === 70 && im.bytes.length <= BUDGET && im.bytes.length === r.pages[0].bytes
			&& f && f.marker === 0xc0 && f.width === 1200 && f.height === 900 && f.components === 3 && im.width === 1200 && im.height === 900;
	};
	ok(await holds(() => budget(shape)), `§3 FAILS ON THE OLD CODE: a ${Math.round(P.big.length / 1024)} KB page goes under 200 KB at the first step, 70, at the same pixel size (1200 x 900, baseline), and that copy is the page`);
	withMutant("§3's budget: every page passes as it came", budget, "lib/pod-upload-shape.js",
		'if (buf.length <= pageBudget) return { bytes: buf, outcome: "within" };', 'if (buf.length > 0) return { bytes: buf, outcome: "within" };');
	const floor = async (lib) => {
		const sh = lib.createShaper({ encode: lib.createEncoder({ slots: slotsLib.createUploadSlots() }), info: FIXED });
		const r = await sh.shape([P.floor]);
		const [im] = await jpegs.imagesIn(r.pdf);
		return r.pages[0].outcome === "large" && r.pages[0].reason === "floor" && im.bytes.equals(P.floor) && r.counts.leftLarge === 1 && r.counts.reasons.floor === 1;
	};
	ok(await holds(() => floor(shape)), `§3 FAILS ON THE OLD CODE: a ${Math.round(P.floor.length / 1024)} KB page still over at 50 goes as it came, byte for byte, flagged (floor)`);
	withMutant("§3's floor: a page still over at 50 is not flagged", floor, "lib/pod-upload-shape.js",
		'if (r.over) return large(buf, "floor");', 'if (r.over) return { bytes: buf, outcome: "within" };');

	const HANG = path.join(TMP, "hang-child.js");
	fs.writeFileSync(HANG, "process.once(\"message\", () => {});\nprocess.on(\"disconnect\", () => process.exit(0));\nsetInterval(() => {}, 1000);\n");
	const ERRS = path.join(TMP, "error-child.js");
	fs.writeFileSync(ERRS, "process.once(\"message\", () => process.send({ error: \"made-up failure\" }, () => process.exit(0)));\n");
	const slow = async (lib) => {
		const sh = lib.createShaper({ encode: lib.createEncoder({ slots: slotsLib.createUploadSlots(), childPath: HANG }), imageTimeoutMs: 400, info: FIXED });
		const t0 = Date.now();
		const r = await sh.shape([P.big]);
		const ms = Date.now() - t0;
		const [im] = await jpegs.imagesIn(r.pdf);
		return r.pages[0].outcome === "large" && r.pages[0].reason === "time" && im.bytes.equals(P.big) && ms < 3000;
	};
	ok(await holds(() => slow(shape)), "§3 FAILS ON THE OLD CODE: a slow child is killed at its time limit, and its page goes as it came, flagged (time)");
	withMutant("§3's slow child: a timed-out child read as a child error", slow, "lib/pod-upload-shape.js",
		"return answer.timedOut ? { timeUp: true } : answer;", "return answer;");
	const childErr = async (lib) => {
		const sh = lib.createShaper({ encode: lib.createEncoder({ slots: slotsLib.createUploadSlots(), childPath: ERRS }), info: FIXED });
		const r = await sh.shape([P.big, P.small]);
		const ims = await jpegs.imagesIn(r.pdf);
		return r.pages[0].outcome === "large" && r.pages[0].reason === "child" && ims[0].bytes.equals(P.big) && ims[1].bytes.equals(P.small) && r.pages.length === 2;
	};
	ok(await holds(() => childErr(shape)), "§3 FAILS ON THE OLD CODE: a child error leaves its page as it came, flagged (child), and the next page goes on");
	withMutant("§3's child error: an error answer not caught as one", childErr, "lib/pod-upload-shape.js",
		'if (!r || r.error) return large(buf, "child");', 'if (!r) return large(buf, "child");');

	const five = async (lib) => {
		const sh = lib.createShaper({ encode: lib.createEncoder({ slots: slotsLib.createUploadSlots() }), info: FIXED });
		const order = [P.small, P.blank820, P.cmyk, P.turned, P.big];
		const r = await sh.shape(order, { sources: ["scanned", "not_routed", "not_routed", "fallback", "original"] });
		const ims = await jpegs.imagesIn(r.pdf);
		const boxes = await drawnBoxes(r.pdf);
		const outs = r.pages.map((p) => `${p.outcome}${p.reason ? `:${p.reason}` : ""}`);
		return ims.length === 5 && ims.map((im) => im.pages[0]).join() === "0,1,2,3,4"
			&& ims[0].bytes.equals(P.small) && !ims[1].bytes.equals(P.blank820) && ims[1].bytes.length <= BUDGET && ims[2].bytes.equals(P.cmyk) && ims[3].bytes.equals(P.turned) && ims[4].bytes.length <= BUDGET
			&& JSON.stringify(outs) === JSON.stringify(["within", "recompressed", P.cmyk.length > BUDGET ? "large:whitelist" : "within", P.turned.length > BUDGET ? "large:whitelist" : "within", "recompressed"])
			&& boxes.map((b) => b.page[0]).join() === "792,792,792,612,792"
			&& [ims[1], ims[4]].every((im) => { const f = jpegs.frameOf(im.bytes); return f && f.width === im.width && f.height === im.height; });
	};
	ok(await holds(() => five(shape)), "§3 FAILS ON THE OLD CODE: a mixed 5-page upload keeps its page count and order: the small page and the CMYK and orientation-6 ones as they came, the two near-blank ones re-compressed at their own sizes, the turned one on a portrait page");
	withMutant("§3's five pages: the pages taken in reverse", five, "lib/pod-upload-shape.js",
		"for (const buf of list) pages.push(await onePage(buf));", "for (const buf of [...list].reverse()) pages.push(await onePage(buf));");

	const verdicts = (lib) => {
		const why = (b) => { const v = lib.jpegVerdict(b); return v.take ? "take" : v.reason; };
		return JSON.stringify([P.big, P.cmyk, P.turned, P.progressive, P.rgbIds, P.adobe0, jpegs.jpeg({ width: 600, height: 400, seed: 2 }), Buffer.from("x")].map(why))
			=== JSON.stringify(["take", "components", "orientation", "frame", "rgb_ids", "adobe", "pixels", "frame"]);
	};
	ok(await holds(() => verdicts(shape)), "§3 FAILS ON THE OLD CODE: the whitelist is way 1's: a baseline RGB photo is taken; CMYK, orientation 6, progressive, R-G-B component IDs, an Adobe transform 0, under 0.5 MP and not a JPEG are each left, with the reason");
	withMutant("§3's whitelist: the orientation rule dropped", verdicts, "lib/pod-upload-shape.js",
		'if (strip.orientation !== 1) return left("orientation");', "");

	// ---------------------------------------------------------------- §4
	section("§4 the row's counts and the audit words");
	const counts = async (lib) => {
		const stub = async () => ({ over: true });
		const sh = lib.createShaper({ encode: stub, info: FIXED });
		const known = await sh.shape([P.small, P.small], { sources: ["scanned", "original"] });
		const none = await sh.shape([P.small, P.small]);
		const bad = await sh.shape([P.small, P.small], { sources: ["scanned", "made-up"] });
		const short = await sh.shape([P.small, P.small], { sources: ["scanned"] });
		const c = known.counts;
		return JSON.stringify([c.pages, c.sources, c.scanned, c.notScanned, c.recompressed, c.bytesBefore, c.bytesAfter, c.leftLarge]) === JSON.stringify([2, "scanned,original", 1, 1, 0, 2 * P.small.length, 2 * P.small.length, 0])
			&& [none, bad, short].every((x) => x.counts.sources === "unknown" && x.counts.scanned === null && x.counts.notScanned === null);
	};
	ok(await holds(() => counts(shape)), "§4 FAILS ON THE OLD CODE: the row's counts: pages, the card's page sources, scanned and not, re-compressed, bytes before and after, left over the budget; \"unknown\" when the client sends none (or a list it can't trust)");
	withMutant("§4's counts: no page sources read as known", counts, "lib/pod-upload-shape.js",
		"return ok ? { known: true, list: raw.slice() } : { known: false, list: [] };", "return { known: true, list: Array.isArray(raw) ? raw.slice() : [] };");
	const audit = (lib) => lib.auditText("pod", { pages: 3, sources: "scanned,fallback,scanned", scanned: 2, notScanned: 1, recompressed: 1, bytesBefore: 900000, bytesAfter: 400000, leftLarge: 1, reasons: { time: 1 } })
		=== "POD: 3 pages; 1 re-compressed, 900000 → 400000 bytes; 1 left as it came over the budget (time 1); 1 not scanned"
		&& lib.auditText("BOL", { pages: 1, scanned: null, notScanned: null, recompressed: 0, bytesBefore: 5, bytesAfter: 5, leftLarge: 0, reasons: {} }) === "BOL: 1 page; 0 re-compressed, 5 → 5 bytes; page sources unknown";
	ok(await holds(() => audit(shape)), "§4 FAILS ON THE OLD CODE: one audit row's words: the type, counts and bytes, why pages were left, and how many were not scanned (never a load, a name or a file)");
	withMutant("§4's audit words: the bytes left out", audit, "lib/pod-upload-shape.js", ", ${c.bytesBefore} → ${c.bytesAfter} bytes", "");

	// ---------------------------------------------------------------- §5
	section("§5 the shared cap (N6)");
	const capNumber = (lib) => lib.IMAGE_CHILD_CAP === 3 && lib.createUploadSlots().stats().max === 2 && lib.createUploadSlots({ reserved: 2 }).stats().max === 1
		&& lib.createUploadSlots({ reserved: 0 }).stats().max === 2;
	ok(await holds(() => capNumber(slotsLib)), "§5 FAILS ON THE OLD CODE: the cap is 3 image children; uploads hold at most cap - 1 = 2 slots (the receipt lane's held for it), 1 while way 1's lane is held too, and never 3 even with nothing held");
	withMutant("§5's cap: uploads may take every slot", capNumber, "lib/image-child-slots.js", "Math.min(cap - 1, cap - reserved)", "Math.min(cap, cap - reserved)");
	const neverStarts = async (lib) => {
		const s = lib.createUploadSlots({ reserved: 2 });
		const first = await s.take({ until: Date.now() + 5000 });
		let answered = false;
		const waiting = s.take({ until: Date.now() + 5000, live: () => !answered });
		const queued = s.stats().waiting === 1;
		answered = true;
		first();
		const got = await waiting;
		const st = s.stats();
		return typeof first === "function" && queued && got === null && st.started === 1 && st.held === 0;
	};
	ok(await holds(() => neverStarts(slotsLib)), "§5 FAILS ON THE OLD CODE: a job whose upload has answered while it waited never starts when the slot frees");
	withMutant("§5's waiting job: started though its upload answered", neverStarts, "lib/image-child-slots.js", "if (!w.live()) {", "if (false) {");
	const waits = async (lib) => {
		const s = lib.createUploadSlots({ reserved: 1 });
		const a = await s.take();
		const b = await s.take();
		const t0 = Date.now();
		const late = await s.take({ until: Date.now() + 150 });
		const lateMs = Date.now() - t0;
		const c = s.take({ until: Date.now() + 5000 });
		const queued = s.stats().waiting === 1;
		a();
		const got = await c;
		const full = lib.createUploadSlots({ reserved: 1, queueCap: 1 });
		await full.take(); await full.take();
		full.take({ until: Date.now() + 5000 });
		const busy = await full.take({ until: Date.now() + 5000 });
		b(); got();
		return typeof a === "function" && typeof b === "function" && late === null && lateMs >= 100 && queued && typeof got === "function" && busy === lib.BUSY;
	};
	ok(await holds(() => waits(slotsLib)), "§5 FAILS ON THE OLD CODE: a third upload job waits for a slot, gets none past its upload's time (null), starts when one frees, and a full queue answers BUSY at once");
	withMutant("§5's queue: no cap on waiting jobs", waits, "lib/image-child-slots.js", "if (waiting.length >= queueCap) return Promise.resolve(BUSY);", "");
	const shaperWaits = async (lib) => {
		const slots = slotsLib.createUploadSlots({ reserved: 2 });
		const holder = await slots.take();
		let started = 0;
		const encode = lib.createEncoder({ slots, childPath: ERRS });
		const counted = async (...a) => { started++; return encode(...a); };
		const sh = lib.createShaper({ encode: counted, budgetMs: 200, info: FIXED });
		const r = await sh.shape([P.big, P.blank820]);
		holder();
		const st = slots.stats();
		return r.pages.map((p) => `${p.outcome}:${p.reason}`).join() === "large:time,large:time" && started === 1 && st.started === 1 && st.held === 0;
	};
	ok(await holds(() => shaperWaits(shape)), "§5 FAILS ON THE OLD CODE: an upload whose time runs out while its page waits for a slot goes as it came (time), its later pages are not queued, and no child of it starts after it answered");
	withMutant("§5's upload time: a page that waited past it still queued again", shaperWaits, "lib/pod-upload-shape.js", "if (remaining <= 0) return large(buf, \"time\");", "");

	// ---------------------------------------------------------------- §6
	section("§6 Part A (scripts/pod-upload-shape-look.js)");
	await partA();

	// ---------------------------------------------------------------- §7
	section("§7 mutants: each caught against its passing control");
	for (const m of mutants) {
		const control = await holds(() => m.check(m.rel.startsWith("lib/image-child-slots") ? slotsLib : m.rel.startsWith("scripts/") ? look : shape));
		const mutant = mutantOf(m.rel, m.from, m.to);
		const caught = mutant !== null && !(await holds(() => m.check(mutant)));
		ok(control && caught, `§7 FAILS ON THE OLD CODE: MUTANT ${m.label}: caught (the control passes, the mutant fails)`, { control, built: mutant !== null });
	}
})().catch((e) => failures.push(`the run threw: ${e && e.stack}`)).then(() => {
	clearInterval(keepAlive);
	fs.rmSync(TMP, { recursive: true, force: true });
	console.log(`\n${pass} passed, ${failures.length} failed`);
	for (const f of failures) console.log(`FAIL  ${f}`);
	process.exit(failures.length ? 1 : 0);
});

// Part A on a made-up database: every load, user and file name here is made up.
async function partA() {
	const Database = require(path.join(ROOT, "node_modules", "better-sqlite3"));
	const PDFKit = require(path.join(ROOT, "node_modules", "pdfkit"));
	const SERVER = require("./lib/server-source").serverSource();
	const dir = fs.mkdtempSync(path.join(TMP, "part-a-"));
	const up = path.join(dir, "uploads");
	fs.mkdirSync(up);
	const dbPath = path.join(dir, "made-up.db");
	const db = new Database(dbPath);
	const create = SERVER.match(/CREATE TABLE IF NOT EXISTS documents \([\s\S]*?\n\t\)/);
	db.exec(create ? create[0] : "CREATE TABLE documents (id INTEGER PRIMARY KEY)");
	for (const m of SERVER.matchAll(/ALTER TABLE documents ADD COLUMN ([^"`;\n]+)/g)) {
		try { db.exec(`ALTER TABLE documents ADD COLUMN ${m[1]}`); } catch { /* there */ }
	}
	// What imageToPdf() writes: one page the image's size, the JPEG as it came.
	const pdfkitFile = (images) => new Promise((resolve, reject) => {
		const doc = new PDFKit({ autoFirstPage: false, info: FIXED });
		const chunks = [];
		doc.on("data", (c) => chunks.push(c));
		doc.on("end", () => resolve(Buffer.concat(chunks)));
		doc.on("error", reject);
		for (const buf of images) {
			const img = doc.openImage(buf);
			doc.addPage({ size: [img.width, img.height] });
			doc.image(img, 0, 0);
		}
		doc.end();
	});
	const { PDFDocument, StandardFonts } = require(path.join(ROOT, "node_modules", "pdf-lib"));
	const textPdf = async () => {
		const d = await PDFDocument.create();
		const page = d.addPage([612, 792]);
		page.drawText("PROOF OF DELIVERY (MADE UP)", { x: 54, y: 700, size: 12, font: await d.embedFont(StandardFonts.Helvetica) });
		return Buffer.from(await d.save());
	};
	const four = [5, 6, 7, 13].map((seed) => jpegs.jpeg({ width: 820, height: 620, quality: 76, seed }));
	const files = {
		"MU-1_POD_1.pdf": await pdfkitFile([P.big, P.small]),
		"MU-1_BOL_2.pdf": await pdfkitFile([P.scan]),
		"MU-2_POD_3.pdf": await pdfkitFile([P.floor]),
		"MU-3_POD_4.pdf": await textPdf(),
		"MU-4_POD_5.pdf": await pdfkitFile([P.small]),
		"MU-5_POD_6.pdf": await pdfkitFile([P.small]),
		"MU-7_POD_8.pdf": await pdfkitFile(four),
		"MU-8_POD_9.pdf": shape ? await shape.letterPdf([P.small], { info: FIXED }) : await textPdf(),
		"MU-9_Receipt_10.pdf": await pdfkitFile([P.small]),
	};
	for (const [name, bytes] of Object.entries(files)) fs.writeFileSync(path.join(up, name), bytes);
	const add = db.prepare("INSERT INTO documents (load_id, driver, type, file_name, drive_url, uploaded_at, deleted_at, uploaded_by_user_id) VALUES (?, 'Made Up Driver', ?, ?, ?, datetime('now', ?), ?, ?)");
	const row = (load, type, name, ago, deleted = null, user = 7) => add.run(load, type, name, `/uploads/${name}`, ago, deleted, user);
	row("MU-1", "POD", "MU-1_POD_1.pdf", "-1 hours");
	row("MU-1", "BOL", "MU-1_BOL_2.pdf", "-1 hours");
	row("MU-2", "POD", "MU-2_POD_3.pdf", "-50 minutes");
	row("MU-3", "POD", "MU-3_POD_4.pdf", "-2 hours");
	row("MU-4", "POD", "MU-4_POD_5.pdf", "-40 days");
	row("MU-5", "POD", "MU-5_POD_6.pdf", "-2 hours", "2026-11-01T00:00:00Z");
	row("MU-6", "POD", "MU-6_POD_7.pdf", "-2 hours");
	row("MU-7", "POD", "MU-7_POD_8.pdf", "-3 hours", null, 8);
	row("MU-8", "POD", "MU-8_POD_9.pdf", "-3 hours", null, 8);
	row("MU-9", "Receipt", "MU-9_Receipt_10.pdf", "-3 hours");
	db.close();
	const fingerprint = () => JSON.stringify([sha256(fs.readFileSync(dbPath)), fs.readdirSync(dir).sort(), fs.readdirSync(up).sort().map((n) => [n, sha256(fs.readFileSync(path.join(up, n)))])]);
	const before = fingerprint();

	let out = null;
	let error = "";
	try {
		out = await look.run([`--db=${dbPath}`, `--uploads=${up}`, "--days=30"]);
	} catch (e) {
		error = String((e && e.message) || e);
	}
	const c = out ? out.counts : {};
	const by = (s) => (c.pagesBySource || {})[s] || {};
	ok(Boolean(out), "§6 FAILS ON THE OLD CODE: Part A runs on a made-up database and uploads folder", error);
	ok(out && c.windowRows === 7 && c.measured === 8 && c.notMeasured === 0
		&& JSON.stringify(Object.entries(c.untouched || {}).sort()) === JSON.stringify([["file missing", 1], ["not one image a page", 1], ["pages not the image's size", 1]]),
	"§6 FAILS ON THE OLD CODE: it takes only pdfkit's image uploads in the window (live POD and BOL rows): 8 pages measured; a text PDF, a Letter-page PDF the new steps wrote and a missing file untouched; an old, a deleted and a Receipt row left out", c.untouched);
	ok(out && by("upload file").pages === 2 && by("upload file").byQuality[70] === 1 && by("upload file").large === 1 && by("scan").pages === 1 && by("scan").byQuality[70] === 1
		&& by("other size").pages === 5 && by("other size").within === 5 && JSON.stringify(c.leftReasons) === JSON.stringify({ floor: 1 }),
	"§6 FAILS ON THE OLD CODE: by source and step: Upload File's two pages (one under at 70, one still over at 50), the scan's one under at 70, five within the budget as they came", c.pagesBySource);
	ok(out && c.loads === 3 && c.fitToday === 1 && c.fitAfterUpload === 2 && c.fitAfterWay1[60] === 1 && c.fitAfterWay1[70] === 0 && c.overAfterBoth === 0,
		"§6 FAILS ON THE OLD CODE (N1): loads that fit, counted after both steps: one today, two after the upload steps, and the load of four ~175 KB pages, untouched by the budget, fits only after way 1 (at 60)", { loads: c.loads, today: c.fitToday, upload: c.fitAfterUpload, way1: c.fitAfterWay1, over: c.overAfterBoth });
	ok(out && c.uploadFileTotal === 2 && JSON.stringify([...(c.peaks || [])].sort()) === "[2]",
		"§6 FAILS ON THE OLD CODE: Upload File pages the scan-all switch would send to ScanKit (2), and one user's 15-minute peak (2)", { total: c.uploadFileTotal, peaks: c.peaks });
	const text = out ? out.lines.join("\n") : "";
	ok(out && /p50 \d+ ms, p95 \d+ ms/.test(text) && /after both steps \(the upload steps, then way 1\) 3/.test(text),
		"§6 FAILS ON THE OLD CODE (N9): it prints p50 and p95 milliseconds a page, and the loads that fit after both steps", text.split("\n").slice(-4).join(" | "));
	ok(out && !/MU-\d|Made Up Driver|\.pdf|user 7|user 8/.test(text) && !text.includes(dir) && text.split("\n").length >= 8,
		"§6 FAILS ON THE OLD CODE: its lines hold counts and fixed words only: no load, name, file, folder or user", text.match(/MU-\d|Made Up Driver|\.pdf/) || "");
	ok(out && fingerprint() === before, "§6 FAILS ON THE OLD CODE: it writes nothing: the database and every upload byte for byte, and no file added beside them");
	withMutant("§6 Part A: a Letter-page PDF measured as if imageToPdf() wrote it", async (lib) => {
		const r = await lib.pdfkitPages(files["MU-8_POD_9.pdf"]);
		const t = await lib.pdfkitPages(files["MU-1_POD_1.pdf"]);
		return r.untouched === "pages not the image's size" && Array.isArray(t.jpegs) && t.jpegs.length === 2;
	}, "scripts/pod-upload-shape-look.js", "if (Math.round(pw) !== width || Math.round(ph) !== height) return { untouched: \"pages not the image's size\" };", "");
	let refused = "";
	try {
		await look.run([`--db=${dbPath}`, `--uploads=${up}`, "--days=0"]);
	} catch (e) {
		refused = e && e.refused ? "refused" : String(e && e.message);
	}
	ok(refused === "refused", "§6 FAILS ON THE OLD CODE: an argument out of range (--days=0) is refused before anything is read");
}
