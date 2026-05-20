#!/usr/bin/env node
// Generate LogisX documentation PDFs from markdown source.
//
// Pipeline: docs/manual/{technical|user}/*.md → marked → wrap in HTML shell →
//           lib/pdf-browser.js renderHtmlToPdf() → docs/pdf/*.pdf
//
// Usage:
//   node scripts/docs/generate-docs.js              # both PDFs
//   node scripts/docs/generate-docs.js --technical
//   node scripts/docs/generate-docs.js --user

const fs = require("fs");
const path = require("path");
const { marked } = require("marked");
const { renderHtmlToPdf, shutdownBrowser } = require("../../lib/pdf-browser");

const ROOT = path.join(__dirname, "..", "..");
const MANUAL_DIR = path.join(ROOT, "docs", "manual");
const ASSETS_DIR = path.join(MANUAL_DIR, "assets");
const OUT_DIR = path.join(ROOT, "docs", "pdf");

const DOCS = {
	technical: {
		slug: "technical",
		filename: "LogisX-Technical-Documentation.pdf",
		title: "Technical Documentation",
		subtitle:
			"Architecture, APIs, database schema, integrations, and deployment guide for the LogisX dispatch & fleet management platform.",
		eyebrow: "Engineering Reference",
	},
	user: {
		slug: "user",
		filename: "LogisX-User-Manual.pdf",
		title: "User Manual",
		subtitle:
			"How to use LogisX as a Driver, Dispatcher, Super Admin, or Investor — plus the public application, investment, and load-tracking flows.",
		eyebrow: "User Guide",
	},
	driver: {
		slug: "driver",
		filename: "LogisX-Driver-Guide.pdf",
		title: "Driver Guide",
		subtitle:
			"Everything a LogisX driver needs to know — from your first sign-in and onboarding to running loads, reporting status, uploading proof of delivery, and getting paid.",
		eyebrow: "For Drivers",
	},
	dispatcher: {
		slug: "dispatcher",
		filename: "LogisX-Dispatcher-Guide.pdf",
		title: "Dispatcher Guide",
		subtitle:
			"How to run daily operations as a LogisX dispatcher — assigning loads, tracking trucks live, communicating with drivers, and keeping the wheels turning.",
		eyebrow: "For Dispatchers",
	},
	admin: {
		slug: "admin",
		filename: "LogisX-Super-Admin-Guide.pdf",
		title: "Super Admin Guide",
		subtitle:
			"The operations and financial controls you uniquely manage — users, applications, invoices, financials, data integrity, and the admin tools that keep LogisX running clean.",
		eyebrow: "For Super Admins",
	},
	investor: {
		slug: "investor",
		filename: "LogisX-Investor-Guide.pdf",
		title: "Investor Guide",
		subtitle:
			"How to read your investor dashboard, interpret the earnings math, download reports, and stay connected with operations on the trucks you fund.",
		eyebrow: "For Investors",
	},
};

// Configure marked: GFM, smartypants, headers get auto-IDs for cross-linking
marked.setOptions({
	gfm: true,
	breaks: false,
	headerIds: true,
	mangle: false,
});

function logoDataUri() {
	const png = path.join(ROOT, "client", "public", "logo.png");
	if (!fs.existsSync(png)) {
		throw new Error(`Logo not found at ${png}`);
	}
	const b64 = fs.readFileSync(png).toString("base64");
	return `data:image/png;base64,${b64}`;
}

function loadStyles() {
	return fs.readFileSync(path.join(ASSETS_DIR, "styles.css"), "utf8");
}

function readChaptersFor(slug) {
	const dir = path.join(MANUAL_DIR, slug);
	if (!fs.existsSync(dir)) {
		console.warn(`[generate-docs] Source directory missing: ${dir}`);
		return [];
	}
	const files = fs
		.readdirSync(dir)
		.filter((f) => f.endsWith(".md"))
		.sort();
	return files.map((f) => ({
		filename: f,
		body: fs.readFileSync(path.join(dir, f), "utf8"),
	}));
}

function buildTocFromTokens(tokens) {
	// Extract h1/h2 to build a 2-level TOC. h1 = chapter, h2 = section.
	const chapters = [];
	let current = null;
	for (const tok of tokens) {
		if (tok.type !== "heading") continue;
		if (tok.depth === 1) {
			current = { title: tok.text, sections: [] };
			chapters.push(current);
		} else if (tok.depth === 2 && current) {
			current.sections.push(tok.text);
		}
	}
	if (chapters.length === 0) return "";
	const lis = chapters
		.map((ch) => {
			const subs =
				ch.sections.length > 0
					? `<ul>${ch.sections
							.map((s) => `<li>${escapeHtml(s)}</li>`)
							.join("")}</ul>`
					: "";
			return `<li>${escapeHtml(ch.title)}${subs}</li>`;
		})
		.join("");
	return `<section class="toc"><h1>Contents</h1><ol>${lis}</ol></section>`;
}

function escapeHtml(s) {
	return String(s)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function renderCover(doc) {
	const today = new Date().toLocaleDateString("en-US", {
		year: "numeric",
		month: "long",
		day: "numeric",
	});
	return `
<section class="cover">
	<div>
		<img class="cover-logo" src="${logoDataUri()}" alt="LogisX" />
		<div class="cover-eyebrow">${escapeHtml(doc.eyebrow)}</div>
		<h1 class="cover-title">${escapeHtml(doc.title)}</h1>
		<p class="cover-subtitle">${escapeHtml(doc.subtitle)}</p>
	</div>
	<div class="cover-footer">
		<span>LogisX Inc. &middot; <strong>Deshorn King, CEO</strong></span>
		<span>${escapeHtml(today)}</span>
	</div>
</section>`;
}

function wrapChapter(html) {
	return `<section class="chapter">${html}</section>`;
}

function rewriteAssetPaths(html) {
	// Markdown can reference ./assets/screenshots/foo.png; turn into data: URIs
	// so Puppeteer never needs to make a network request to find them.
	return html.replace(
		/(<img[^>]+src=")([^"]+)("[^>]*>)/g,
		(match, pre, src, post) => {
			if (src.startsWith("data:") || /^https?:/.test(src)) return match;
			let abs;
			if (src.startsWith("/")) {
				abs = path.join(ROOT, src.slice(1));
			} else {
				abs = path.resolve(ASSETS_DIR, src);
			}
			if (!fs.existsSync(abs)) {
				console.warn(`  ⚠ Image not found: ${src} (resolved ${abs}) — stripping tag`);
				return ""; // drop the entire <img> tag rather than leaving a broken reference
			}
			const ext = path.extname(abs).slice(1).toLowerCase();
			const mime = ext === "svg" ? "svg+xml" : ext === "jpg" ? "jpeg" : ext;
			const b64 = fs.readFileSync(abs).toString("base64");
			return `${pre}data:image/${mime};base64,${b64}${post}`;
		}
	);
}

async function buildPdf(key) {
	const doc = DOCS[key];
	console.log(`\n[generate-docs] Building ${doc.filename}…`);
	const chapters = readChaptersFor(doc.slug);

	// Concatenate raw markdown so marked can lex it all at once (for TOC).
	const concatenated = chapters.map((c) => c.body).join("\n\n");
	const tokens = marked.lexer(concatenated);

	// Render each chapter separately so we can wrap in .chapter for page-break-before
	const chapterHtml = chapters
		.map((c) => wrapChapter(marked.parse(c.body)))
		.join("\n");

	const tocHtml = buildTocFromTokens(tokens);

	const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(doc.title)} — LogisX</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet" />
<style>${loadStyles()}</style>
</head>
<body>
${renderCover(doc)}
${tocHtml}
${rewriteAssetPaths(chapterHtml)}
</body>
</html>`;

	if (!fs.existsSync(OUT_DIR)) {
		fs.mkdirSync(OUT_DIR, { recursive: true });
	}

	const outPath = path.join(OUT_DIR, doc.filename);
	const pdf = await renderHtmlToPdf(html);
	fs.writeFileSync(outPath, pdf);
	const kb = (pdf.length / 1024).toFixed(1);
	console.log(`  ✓ Wrote ${path.relative(ROOT, outPath)} (${kb} KB)`);
	return outPath;
}

async function main() {
	const args = process.argv.slice(2);
	// CLI flags select a subset; otherwise build everything.
	const flagMap = {
		"--technical": "technical",
		"--user": "user",
		"--driver": "driver",
		"--dispatcher": "dispatcher",
		"--admin": "admin",
		"--investor": "investor",
	};
	const requested = Object.keys(flagMap).filter((f) => args.includes(f)).map((f) => flagMap[f]);
	const which = requested.length > 0 ? requested : Object.keys(DOCS);

	try {
		for (const key of which) {
			await buildPdf(key);
		}
	} catch (err) {
		console.error("[generate-docs] FAILED:", err);
		process.exitCode = 1;
	} finally {
		await shutdownBrowser();
	}
}

if (require.main === module) {
	main();
}

module.exports = { buildPdf };
