// The world the driver-privacy receipt-page runners share: personal-world's
// made-up fleet, database and lifted server.js (receipts on), plus PR B's own
// routes and jobs lifted from server.js beside it, on the same database, data
// folder, clock and sheet. Both halves are server.js's own code; the second
// lift is a separate copy, so it shares the database and files, never memory.
// Every name, truck, receipt and PDF here is made up.
//
// A route or function server.js does not have yet is left out, and calling it
// answers { status: 0, missing: true }: a runner on a server.js without PR B
// fails each case on its own line instead of stopping at the first.

"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { createRequire } = require("module");
const pw = require("./personal-world");
const { closure, indexDeclarations } = require("./server-lift");

const { ROOT, SRC, USERS } = pw;
const appRequire = createRequire(path.join(ROOT, "server.js"));
const { PDFDocument, PDFName, PDFRawStream, PDFArray, StandardFonts, decodePDFRawStream } = appRequire("pdf-lib");
const rp = appRequire("./lib/receipt-pdf.js");

const PAGE_ROUTE_HEADS = {
	pages: 'app.get("/api/expenses/:id/receipt-pages", requireRole("Super Admin"), receiptPagesLimiter, async (req, res) => {',
	mark: 'app.post("/api/expenses/:id/receipt-pages/:page", requireRole("Super Admin"), refuseCrossOrigin, receiptPagesLimiter, async (req, res) => {',
	update: 'app.post("/api/invoices/:id/receipt-pages/update", requireRole("Super Admin"), refuseCrossOrigin, receiptPagesLimiter, async (req, res) => {',
	invoicePdf: 'app.get("/api/invoices/:id/pdf", requireAuth, (req, res) => {',
};
const PAGE_ROOTS = ["runReceiptPagesSweep", "rewriteInvoiceReceiptPages", "receiptPageVerdictsFor", "receiptPdfService", "currentReceiptRoster", "noticeTypeScope"];
const PROVIDED = ["db", "require", "console", "process", "__dirname", "Date", "app", "notifyChange",
	"getJobTrackingCached", "getSheets", "SPREADSHEET_ID", "REPLICA", "SHEET_TARGET", "renderPolicy", "fs", "DATA_DIR",
	"fetch", "io", "sendEmail", "fuelAnalyticsLimiter", "personalReceiptLimiter", "personalRouteLimiter", "personalListLimiter",
	"receiptPdfProbePaths", "receiptPagesLimiter"];
const DENIED = ["server", "transporter", "getDrive", "KEY_FILE"];

let liftedPages = null;
function pageCode() {
	if (!liftedPages) {
		const { decls } = indexDeclarations(SRC);
		const roots = PAGE_ROOTS.filter((r) => decls.has(r));
		const routes = Object.entries(PAGE_ROUTE_HEADS).filter(([, h]) => SRC.split(`\n${h}`).length === 2);
		liftedPages = {
			roots,
			missingRoots: PAGE_ROOTS.filter((r) => !roots.includes(r)),
			routeNames: routes.map(([k]) => k),
			code: closure(SRC, { roots, routes: routes.map(([, h]) => h), provided: PROVIDED, denied: DENIED }),
		};
	}
	return liftedPages;
}

class Res {
	constructor(done) { this.statusCode = 200; this.body = undefined; this.headers = {}; this._done = done; }
	status(c) { this.statusCode = c; return this; }
	json(b) { this.body = b; this._done(); return this; }
	send(b) { this.body = b; this._done(); return this; }
	setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; }
	set(k, v) { this.setHeader(k, v); return this; }
	end(b) { if (b !== undefined) this.body = b; this._done(); return this; }
}

const SAME_ORIGIN = { "x-requested-with": "XMLHttpRequest", "sec-fetch-site": "same-origin", host: "app.test" };
const CROSS_SITE = { "x-requested-with": "XMLHttpRequest", "sec-fetch-site": "cross-site", origin: "https://elsewhere.example", host: "app.test" };

// opts: { env, render(templateName, data, record), io (a socket server stand-in
// for PR B's half; none by default) }
function buildPrivacyWorld(opts = {}) {
	const env = opts.env || {};
	const base = pw.buildPersonalWorld({ env, receipts: true, receiptPdfProbes: opts.receiptPdfProbes });
	if (opts.render) base.hooks.render = opts.render;
	try { base.db.exec(appRequire("./lib/receipt-page-privacy").SCHEMA_SQL); } catch { /* a server.js without PR B */ }

	const clock = base.clock;
	class FixedDate extends Date {
		constructor(...args) { super(...(args.length ? args : [clock.now])); }
		static now() { return clock.now; }
	}
	const routes = [];
	const register = (method) => (p, ...handlers) => { routes.push({ method, path: p, handlers }); };
	const app = { get: register("GET"), post: register("POST"), put: register("PUT"), delete: register("DELETE"), patch: register("PATCH") };
	const quiet = { log() {}, info() {}, warn() {}, error: (...a) => { if (process.env.PERSONAL_WORLD_DEBUG) console.error(...a); } };
	const renderPolicy = (templateName, data) => (base.hooks.render
		? base.hooks.render(templateName, data, async (t, d) => { base.rendered.push({ templateName: t, data: JSON.parse(JSON.stringify(d)) }); })
		: Promise.resolve(Buffer.from(`%PDF-stub ${templateName}`)));
	const deps = {
		db: base.db,
		require: appRequire,
		console: quiet,
		process: { env: { CSRF_HEADER_REQUIRED: "", ...env }, argv: [], cwd: () => ROOT, pid: process.pid },
		__dirname: ROOT,
		Date: FixedDate,
		app,
		notifyChange: (d) => base.notifications.push(d),
		getJobTrackingCached: null,
		getSheets: async () => ({ spreadsheets: { values: { get: async () => ({ data: { values: base.sheet.rows.map((r) => [...r]) } }) } } }),
		SPREADSHEET_ID: "test-sheet",
		REPLICA: null,
		SHEET_TARGET: null,
		renderPolicy,
		fs,
		DATA_DIR: base.dataDir,
		fetch: () => { throw new Error("no network in a test"); },
		io: opts.io || null,
		sendEmail: async () => undefined,
		fuelAnalyticsLimiter: (req, res, next) => next(),
		personalReceiptLimiter: (req, res, next) => next(),
		personalRouteLimiter: (req, res, next) => next(),
		personalListLimiter: (req, res, next) => next(),
		receiptPdfProbePaths: () => ({ ...(opts.receiptPdfProbes || { env: "", db: "" }) }),
		receiptPagesLimiter: (req, res, next) => next(),
	};
	const lifted = pageCode();
	const body = ['"use strict";', lifted.code.text, `return { ${lifted.roots.join(", ")} };`].join("\n");
	const mine = new Function(...Object.keys(deps), body)(...Object.values(deps));

	const match = (pattern, actual) => {
		const a = pattern.split("/");
		const b = actual.split("?")[0].split("/");
		if (a.length !== b.length) return null;
		const params = {};
		for (let i = 0; i < a.length; i++) {
			if (a[i].startsWith(":")) params[a[i].slice(1)] = decodeURIComponent(b[i]);
			else if (a[i] !== b[i]) return null;
		}
		return params;
	};
	const ownRoute = (method, url) => routes.find((r) => r.method === method && match(r.path, url)) || null;
	const isPageUrl = (url) => /^\/api\/expenses\/[^/]+\/receipt-pages(\/[^/]+)?$|^\/api\/invoices\/[^/]+\/receipt-pages\/update$|^\/api\/invoices\/[^/]+\/pdf$/.test(url.split("?")[0]);

	// PR B's routes and the invoice PDF route run here; every other route in
	// personal-world. as: a USERS key, or null for signed out.
	async function call(method, url, { as = "admin", body: reqBody = {}, query = {}, headers } = {}) {
		const route = ownRoute(method, url);
		if (!route) {
			if (isPageUrl(url)) return { status: 0, missing: true, body: { error: `no route ${method} ${url} in this server.js` } };
			return base.call(method, url, { as, body: reqBody, query, headers });
		}
		const params = match(route.path, url);
		const hdrs = headers || SAME_ORIGIN;
		const user = as ? { ...USERS[as] } : null;
		const req = {
			method, url, originalUrl: url, path: url, params, body: reqBody, query, headers: hdrs, ip: "127.0.0.1",
			hostname: "app.test", protocol: "https",
			session: user ? { user } : {},
			get(h) { return hdrs[String(h).toLowerCase()]; },
			route: { path: route.path },
		};
		let finished;
		const done = new Promise((r) => { finished = r; });
		const res = new Res(() => finished());
		let i = 0;
		const next = async () => {
			const h = route.handlers[i++];
			if (!h) return;
			await h(req, res, next);
		};
		await next();
		const timer = setTimeout(() => finished(), 60000);
		await done;
		clearTimeout(timer);
		if (res.body === undefined) throw new Error(`no response from ${method} ${url}`);
		return { status: res.statusCode, body: res.body, headers: res.headers };
	}

	const missing = (name) => async () => ({ missing: name });
	const api = Object.fromEntries(PAGE_ROOTS.map((r) => [r, mine[r] || missing(r)]));
	return {
		...base,
		call,
		mine: api,
		lifted: { roots: lifted.roots, missingRoots: lifted.missingRoots, routes: lifted.routeNames },
		cleanup: base.cleanup,
	};
}

// ---------------------------------------------------------------------------
// Made-up PDFs.

const pdfString = (s) => `(${String(s).replace(/[\\()]/g, (c) => `\\${c}`)})`;
// Glyph ids that do not spell the text (offset), as a font with no ToUnicode map draws them.
const glyphHex = (s, offset = 0x100) => `<${[...String(s)].map((ch) => (ch.charCodeAt(0) + offset).toString(16).padStart(4, "0")).join("")}>`;

// pages: [[line, ...], ...]. A line is a string (Helvetica, WinAnsi) or
// { unmapped: "text" } (a Type0 font with Identity-H and no ToUnicode map).
// sharedImages: every page's resources list every page's image (one per page,
// its bytes spelling IMGMARK-P<n>), and each page draws only its own.
function receiptPdf(pages, { compress = true, sharedImages = false } = {}) {
	const objs = [];
	const n = pages.length;
	const imageBase = 7;
	const imageCount = sharedImages ? n : 0;
	const pageBase = imageBase + imageCount;
	objs.push("<< /Type /Catalog /Pages 2 0 R >>");
	objs.push(`<< /Type /Pages /Kids [${pages.map((_, i) => `${pageBase + 2 * i + 1} 0 R`).join(" ")}] /Count ${n} >>`);
	objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
	objs.push("<< /Type /Font /Subtype /Type0 /BaseFont /MadeUpGlyphs /Encoding /Identity-H /DescendantFonts [5 0 R] >>");
	objs.push("<< /Type /Font /Subtype /CIDFontType2 /BaseFont /MadeUpGlyphs /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 6 0 R /DW 500 >>");
	objs.push("<< /Type /FontDescriptor /FontName /MadeUpGlyphs /Flags 4 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 900 /Descent -200 /CapHeight 700 /StemV 80 >>");
	const xobjects = [];
	for (let i = 0; i < imageCount; i++) {
		const bytes = Buffer.from(`IMGMARK-P${i + 1}`.padEnd(16, "-").slice(0, 16), "latin1");
		objs.push(rp.streamObject("/Type /XObject /Subtype /Image /Width 16 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8", bytes));
		xobjects.push(`/Im${i + 1} ${imageBase + i} 0 R`);
	}
	const resources = `<< /Font << /F1 3 0 R /F2 4 0 R >>${sharedImages ? ` /XObject << ${xobjects.join(" ")} >>` : ""} >>`;
	pages.forEach((lines, i) => {
		const ops = ["BT", "/F1 10 Tf", "13 TL", "20 380 Td"];
		lines.forEach((line, k) => {
			if (k) ops.push("T*");
			if (typeof line === "string") ops.push(`${pdfString(line)} Tj`);
			else ops.push("/F2 10 Tf", `${glyphHex(line.unmapped)} Tj`, "/F1 10 Tf");
		});
		ops.push("ET");
		if (sharedImages) ops.push(`q 64 0 0 4 20 10 cm /Im${i + 1} Do Q`);
		const content = Buffer.from(ops.join("\n"), "latin1");
		objs.push(compress ? rp.streamObject("/Filter /FlateDecode", zlib.deflateSync(content)) : rp.streamObject("", content));
		objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Contents ${pageBase + 2 * i} 0 R /Resources ${resources} >>`);
	});
	return rp.rawPdf(objs);
}

const ascii = (s) => String(s == null ? "" : s).replace(/[^\x20-\x7e]/g, "?").slice(0, 120);

// What Chrome would hand back: the invoice page (its total, adjustment and each
// Personal line with its receipt note), then one page per receipt sheet with
// its header and note, each sheet's anchor a named destination.
async function fakeChrome(templateName, data) {
	const doc = await PDFDocument.create({ updateMetadata: false });
	const font = await doc.embedFont(StandardFonts.Helvetica);
	const write = (page, lines) => lines.forEach((t, i) => page.drawText(ascii(t), { x: 40, y: 740 - 14 * i, size: 10, font }));
	const lines = [`INVOICE ${templateName}`, `TOTAL DUE ${Number(data.totalDue || 0).toFixed(2)}`, `ADJUSTMENT ${Number(data.adjustment || 0).toFixed(2)}`];
	for (const l of data.personalLines || []) lines.push(`${l.label} ${l.amount != null ? l.amount : ""} | ${l.receiptNote || ""}`);
	write(doc.addPage([612, 792]), lines);
	const sheets = (data.receiptPages || []).map((p) => {
		const page = doc.addPage([612, 792]);
		write(page, [`SHEET ${p.anchor}`, p.header || "", p.note || ""]);
		return [p.anchor, doc.context.obj([page.ref, "XYZ", 0, 792, 0])];
	});
	if (sheets.length) doc.catalog.set(PDFName.of("Dests"), doc.context.obj(Object.fromEntries(sheets)));
	return Buffer.from(await doc.save({ useObjectStreams: false }));
}

// Every stream of a PDF, decoded, as latin1 text; pdf-lib's hex-string text
// (<48656C6C6F> Tj) is decoded as well, so a search sees drawn text however it
// was written.
async function streamTexts(pdf) {
	const doc = await PDFDocument.load(pdf, { updateMetadata: false });
	const out = [];
	for (const [, obj] of doc.context.enumerateIndirectObjects()) {
		if (!(obj instanceof PDFRawStream)) continue;
		let bytes;
		try { bytes = obj.dict.lookup(PDFName.of("Filter")) ? decodePDFRawStream(obj).decode() : obj.contents; } catch { bytes = obj.contents; }
		const text = Buffer.from(bytes).toString("latin1");
		const hex = [...text.matchAll(/<([0-9A-Fa-f]{2,4000})>/g)].map((m) => Buffer.from(m[1], "hex").toString("latin1")).join("|");
		out.push(`${text}\n${hex}`);
	}
	return out;
}

// Each page's own drawn text (its content streams, not the forms it draws).
async function pageTexts(pdf) {
	const doc = await PDFDocument.load(pdf, { updateMetadata: false });
	return doc.getPages().map((p) => {
		const c = p.node.Contents();
		const streams = !c ? [] : c instanceof PDFArray ? c.asArray().map((r) => doc.context.lookup(r)) : [c];
		const text = streams.map((s) => (s instanceof PDFRawStream
			? Buffer.from(s.dict.lookup(PDFName.of("Filter")) ? decodePDFRawStream(s).decode() : s.contents).toString("latin1") : "")).join("\n");
		const hex = [...text.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)].map((m) => Buffer.from(m[1], "hex").toString("latin1"));
		const lit = [...text.matchAll(/\(((?:[^()\\]|\\.){0,500})\)\s*Tj/g)].map((m) => m[1]);
		return [...hex, ...lit].join("|");
	});
}

module.exports = { buildPrivacyWorld, receiptPdf, fakeChrome, streamTexts, pageTexts, glyphHex, SAME_ORIGIN, CROSS_SITE, PAGE_ROUTE_HEADS, PAGE_ROOTS };
