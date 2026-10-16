#!/usr/bin/env node
/**
 * The weekly invoice PDF's layout (the user, 2026-10-16), in both weekly
 * templates (onboarding-templates/policy/service-invoice.html and
 * service-invoice-owner-op.html) and, where it shares the same markup, the
 * manual invoice (service-invoice-manual.html):
 *
 *   1, 3, 5  fixed-width boxes cut the value off: the Invoice Number
 *            ("INV-2026- HR-2026..."), the second load of a two-load day's
 *            Load / BOL #, the signature Date ("Oct 15, 202"). Every text value
 *            the renderer fills is now a box that grows with its text and wraps
 *            (no <input>, no fixed width). The Invoice Number prints the
 *            invoice's own number, "INV-" and the stored suffix, instead of a
 *            literal "INV-2026-" glued before "HR-2026W41-01".
 *   2        the Submission Date printed a literal "Friday," beside every date.
 *            It prints the weekday of that date (the generation day in
 *            APP_TIMEZONE), worked out from the date text by calendar
 *            arithmetic, never through a zone. scripts/regenerate-invoice-pdfs.js
 *            dates an invoice by its created_at in APP_TIMEZONE, not in the
 *            process zone (UTC on the VPS).
 *   4        the Address line repeated city, state and zip when the saved
 *            street field already holds the whole address, and kept ", USA".
 *            lib/invoice-header.js providerAddressLine() builds the line once;
 *            saved addresses are unchanged. The line wraps.
 *   6        TOTAL DUE could print alone on a new page under the repeated table
 *            header: it stays with the row above it.
 *
 * Issued invoices are never regenerated, and no render_data is rewritten.
 *
 * Every case fails on the base (73be100). A4 checks server.js, which this
 * change edits through a patch main applies (three call sites): it fails until
 * that patch is in. What the boxes look like in a real PDF is checked on the
 * replica; this runner pins the markup and the values.
 *
 * Made-up data only. Pure: no server, no app.db, no network, no browser.
 * Run: node scripts/test-invoice-pdf-layout.js    # exits 1 on failure
 */
"use strict";
process.env.TZ = "UTC"; // production's clock zone
delete process.env.APP_TIMEZONE; // the default, America/New_York

const fs = require("fs");
const path = require("path");
function findRoot(dir) {
	while (!fs.existsSync(path.join(dir, "server.js"))) {
		const up = path.dirname(dir);
		if (up === dir) throw new Error("server.js not found above this runner");
		dir = up;
	}
	return dir;
}
const ROOT = findRoot(__dirname);
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const FIELD_MAPS = require(path.join(ROOT, "lib", "policy-field-maps.js"));
const appTime = require(path.join(ROOT, "lib", "app-time.js"));
const TEMPLATES = {
	service_invoice: read("onboarding-templates", "policy", "service-invoice.html"),
	service_invoice_owner_op: read("onboarding-templates", "policy", "service-invoice-owner-op.html"),
	service_invoice_manual: read("onboarding-templates", "policy", "service-invoice-manual.html"),
};
const WEEKLY = ["service_invoice", "service_invoice_owner_op"];
const WEEK = ["Saturday", "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
const ZONES = ["UTC", "America/New_York", "America/Los_Angeles", "Asia/Manila", "Pacific/Kiritimati"];
// The day rows are built by the template's own script, one per weekday, from
// this aria-label (the script's template string, read as it is written).
const DAY_ROW_LOAD_BOL = "${day} Load/BOL number";

// The module this change adds, or a clear error naming it.
function header() {
	const file = path.join(ROOT, "lib", "invoice-header.js");
	if (!fs.existsSync(file)) throw new Error("lib/invoice-header.js does not exist yet (the fix adds it)");
	return require(file);
}

// ── the per-case harness: one line per case, the failing checks under it ─────
let passed = 0;
let failed = 0;
function test(name, fn) {
	const checks = [];
	const eq = (label, actual, expected) => {
		const a = JSON.stringify(actual);
		const e = JSON.stringify(expected);
		checks.push({ ok: a === e, label, detail: `expected ${e}\n             actual   ${a}` });
	};
	const ok = (label, cond, detail = "") => checks.push({ ok: !!cond, label, detail });
	try {
		fn({ eq, ok });
	} catch (err) {
		checks.push({ ok: false, label: "threw", detail: String((err && err.message) || err).split("\n")[0] });
	}
	process.env.TZ = "UTC";
	const good = checks.length > 0 && checks.every((c) => c.ok);
	if (good) passed++; else failed++;
	console.log(`  ${good ? "ok  " : "FAIL"}  ${name}`);
	if (!good) {
		for (const c of checks.filter((x) => !x.ok).slice(0, 4)) console.log(`        - ${c.label}${c.detail ? `\n             ${c.detail}` : ""}`);
		if (!checks.length) console.log("        - no check ran");
	}
}

// The element carrying aria-label="<label>" in a template (static markup or the
// day-row script's own template string): its tag and attribute text.
function slot(html, label) {
	const esc = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const m = new RegExp(`<([a-z][a-z0-9]*)\\b([^>]*)\\baria-label="${esc}"([^>]*)>`, "i").exec(html);
	return m ? { tag: m[1].toLowerCase(), attrs: `${m[2]} ${m[3]}` } : null;
}
// A box that grows with its text: not an <input>, class "fill", no inline width.
function grows(html, label) {
	const s = slot(html, label);
	if (!s) return `no element labelled "${label}"`;
	if (s.tag === "input") return `"${label}" is an <input> (one line, cut at its width)`;
	if (!/\bclass="[^"]*\bfill\b/.test(s.attrs)) return `"${label}" has no "fill" class`;
	if (/\bstyle="[^"]*\bwidth\s*:/.test(s.attrs)) return `"${label}" has an inline width`;
	return "";
}
// One CSS rule's body, by its exact selector.
function rule(html, selector) {
	const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const m = new RegExp(`(?:^|[\\s}])${esc}\\s*\\{([^}]*)\\}`).exec(html);
	return m ? m[1] : "";
}
// Every selector list a declaration appears under, joined: "does any rule give
// <selector> this declaration?".
function declares(html, selector, declaration) {
	const re = /([^{}]+)\{([^}]*)\}/g;
	let m;
	while ((m = re.exec(html))) {
		const selectors = m[1].split(",").map((s) => s.trim());
		if (selectors.includes(selector) && m[2].includes(declaration)) return true;
	}
	return false;
}

const weekday = (key, submissionDate) => FIELD_MAPS[key]({ submissionDate }).text["Submission weekday"];

console.log("The weekly invoice PDF prints every value whole, the real weekday, the address once, and TOTAL DUE with its rows");

test("A1 Submission Date prints the date's own weekday, in every process zone, on both weekly invoices: Thu Oct 15, Fri Oct 16, Sat Oct 17, the two DST Sundays (Mar 8, Nov 1) and a long month name. Base: no weekday label (the template's literal \"Friday,\")", ({ eq }) => {
	const dates = ["Oct 15, 2026", "Oct 16, 2026", "Oct 17, 2026", "Mar 8, 2026", "Nov 1, 2026", "Mar 7, 2026", "October 14, 2026", "2026-12-31"];
	const want = ["Thursday,", "Friday,", "Saturday,", "Sunday,", "Sunday,", "Saturday,", "Wednesday,", "Thursday,"];
	for (const zone of ZONES) {
		process.env.TZ = zone;
		for (const key of WEEKLY) eq(`${key} under TZ=${zone}`, dates.map((d) => weekday(key, d)), want);
	}
});

test("A2 From the instant the server dates the invoice by (appTime.dateTextInZone, APP_TIMEZONE): 8:30 PM EDT Thu Oct 15 is Thursday though UTC says Oct 16; the 7:30 PM EST Friday batch after the clocks go back is Friday though UTC says Saturday; 1:30 AM on both DST Sundays is Sunday. Base: no weekday label", ({ eq }) => {
	const instants = ["2026-10-16T00:30:00Z", "2026-11-07T00:30:00Z", "2026-03-08T06:30:00Z", "2026-11-01T05:30:00Z", "2026-11-01T06:30:00Z", "2026-10-09T22:30:00Z"];
	const wantDates = ["Oct 15, 2026", "Nov 6, 2026", "Mar 8, 2026", "Nov 1, 2026", "Nov 1, 2026", "Oct 9, 2026"];
	const wantDays = ["Thursday,", "Friday,", "Sunday,", "Sunday,", "Sunday,", "Friday,"];
	for (const zone of ["UTC", "Asia/Manila", "America/Los_Angeles"]) {
		process.env.TZ = zone;
		const dates = instants.map((i) => appTime.dateTextInZone(new Date(i), appTime.appTimeZone()));
		eq(`the dates under TZ=${zone}`, dates, wantDates);
		for (const key of WEEKLY) eq(`${key} weekday under TZ=${zone}`, dates.map((d) => weekday(key, d)), wantDays);
	}
});

test("A3 A date it can't read prints no weekday rather than a wrong one, and neither weekly template keeps a literal \"Friday,\": each has a \"Submission weekday\" slot just before the date. Base: the literal is in both templates", ({ eq, ok }) => {
	for (const key of WEEKLY) {
		eq(`${key}: unreadable dates`, ["", "TBD", "Feb 30, 2026", "Octopus 3, 2026", "13/01/2026", undefined].map((d) => weekday(key, d)), ["", "", "", "", "", ""]);
		const html = TEMPLATES[key];
		ok(`${key}: no literal "Friday," in the template`, !/<strong>\s*Friday,\s*<\/strong>/.test(html));
		ok(`${key}: the weekday slot sits right before the date`, /aria-label="Submission weekday"[^>]*><\/strong>\s*<span\b[^>]*aria-label="Submission date"/.test(html));
	}
});

test("A4 server.js builds every directory address with providerAddressLine(): the weekly generate route, the manual invoice's payee list and the Personal correction draft; no hand-rolled address/city/state/zip join is left. Base: three joins (fails until main applies layout-server-patch.diff)", ({ eq, ok }) => {
	const src = read("server.js");
	const joins = src.match(/\[\s*\w+\.address,\s*\w+\.city,\s*\w+\.state,\s*\w+\.zip\s*\]\.filter\(Boolean\)\.join\(", "\)/g) || [];
	eq("address/city/state/zip joins left in server.js", joins.length, 0);
	ok("lib/invoice-header.js is required", /const \{[^}]*\bproviderAddressLine\b[^}]*\} = require\("\.\/lib\/invoice-header"\);/.test(src));
	ok("the generate route's provider address", /const providerAddress = driverRow \? providerAddressLine\(driverRow\) : "";/.test(src));
	ok("the manual invoice's payee list", /address: providerAddressLine\(d\),/.test(src));
	ok("the Personal correction draft's payee address", /payeeAddress: dirRow \? providerAddressLine\(dirRow\) : "",/.test(src));
	ok("no comment still says the template prints a literal \"Friday,\"", !/literal "Friday,"/.test(src));
});

test("B1 scripts/regenerate-invoice-pdfs.js dates an invoice by its created_at in APP_TIMEZONE: created 00:30 UTC Oct 16 prints Oct 15 (8:30 PM EDT, a Thursday), 00:30 UTC Sat Nov 7 prints Nov 6 (the Friday batch, EST). Base: the process zone (UTC) prints Oct 16 and Nov 7", ({ eq }) => {
	const src = read("scripts", "regenerate-invoice-pdfs.js");
	const lines = src.split("\n").filter((l) => /^\s*const submissionDate = /.test(l));
	eq("one submissionDate line", lines.length, 1);
	let helper = {};
	try { helper = header(); } catch (_e) { helper = {}; }
	const run = (createdAt) => new Function("createdAt", "invoiceDateFromStamp", `${lines[0]}\nreturn submissionDate;`)(createdAt, helper.invoiceDateFromStamp);
	for (const zone of ["UTC", "Asia/Manila"]) {
		process.env.TZ = zone;
		eq(`under TZ=${zone}`, ["2026-10-16 00:30:00", "2026-11-07 00:30:00", "2026-10-15 15:00:00"].map(run), ["Oct 15, 2026", "Nov 6, 2026", "Oct 15, 2026"]);
	}
	eq("its weekday", weekday("service_invoice", run("2026-10-16 00:30:00")), "Thursday,");
	eq("the script's own address join left", (src.match(/\[\s*\w+\.address,\s*\w+\.city,\s*\w+\.state,\s*\w+\.zip\s*\]\.filter\(Boolean\)/g) || []).length, 0);
	eq("the script's provider address uses the helper", /const providerAddress = driverRow \? providerAddressLine\(driverRow\) : "";/.test(src), true);
});

test("B2 invoiceDateFromStamp(): a SQLite UTC stamp, an ISO Z stamp, a custom zone, and nothing for a blank or unreadable stamp. Base: no lib/invoice-header.js", ({ eq }) => {
	const { invoiceDateFromStamp } = header();
	eq("stamps", [
		invoiceDateFromStamp("2026-10-16 00:30:00"),
		invoiceDateFromStamp("2026-10-16T00:30:00Z"),
		invoiceDateFromStamp("2026-10-16T00:30:00.000Z"),
		invoiceDateFromStamp("2026-10-16 00:30:00", "UTC"),
		invoiceDateFromStamp("2026-10-16 00:30:00", "Asia/Manila"),
		invoiceDateFromStamp(""),
		invoiceDateFromStamp(null),
		invoiceDateFromStamp("yesterday"),
	], ["Oct 15, 2026", "Oct 15, 2026", "Oct 15, 2026", "Oct 16, 2026", "Oct 16, 2026", "", "", ""]);
});

test("C1 providerAddressLine(): a street field already holding the whole address prints once, without the country; a split address prints \"street, city, ST zip\"; a street named after the city keeps the city; partial streets get only what they lack. Base: no lib/invoice-header.js", ({ eq }) => {
	const { providerAddressLine } = header();
	const tx = { city: "Houston", state: "TX", zip: "77002" };
	const cases = [
		[{ address: "1200 Elm St, Houston, TX 77002, USA", ...tx }, "1200 Elm St, Houston, TX 77002"],
		[{ address: "1200 Elm St, Houston, TX 77002, United States", ...tx }, "1200 Elm St, Houston, TX 77002"],
		[{ address: "1200 Elm St, Houston, TX 77002, U.S.A.", ...tx }, "1200 Elm St, Houston, TX 77002"],
		[{ address: "1200 Elm St Apt 4, Houston, TX 77002-1234, USA", ...tx }, "1200 Elm St Apt 4, Houston, TX 77002-1234"],
		[{ address: "1200 Elm St,  houston ,  tx 77002 , usa", ...tx }, "1200 Elm St, houston, tx 77002"],
		[{ address: "1200 Elm St, Houston, Texas 77002, USA", ...tx }, "1200 Elm St, Houston, Texas 77002"],
		[{ address: "1200 Elm St Houston TX 77002 USA", ...tx }, "1200 Elm St Houston TX 77002"],
		[{ address: "1200 Elm St", ...tx }, "1200 Elm St, Houston, TX 77002"],
		[{ address: "45 Houston Ave", ...tx }, "45 Houston Ave, Houston, TX 77002"],
		[{ address: "1200 Elm St, Houston, TX", ...tx }, "1200 Elm St, Houston, TX 77002"],
		[{ address: "1200 Elm St, Houston", ...tx }, "1200 Elm St, Houston, TX 77002"],
		[{ address: "1200 Elm St, TX 77002", ...tx }, "1200 Elm St, Houston, TX 77002"],
		[{ address: "1200 Elm St, Houston, 77002", ...tx }, "1200 Elm St, Houston, TX 77002"],
		[{ address: "1200 Elm St, Houston, TX 77002, USA", city: "", state: "", zip: "" }, "1200 Elm St, Houston, TX 77002"],
		[{ address: "", ...tx }, "Houston, TX 77002"],
		[{ address: "1200 Elm St", city: "", state: "TX", zip: "" }, "1200 Elm St, TX"],
		[{ address: null, city: null, state: null, zip: null }, ""],
		[null, ""],
	];
	for (const [row, want] of cases) eq(JSON.stringify(row), providerAddressLine(row), want);
});

test("D1 Every text value the renderer fills on the three invoices is a box that grows and wraps: no <input>, no fixed width, the .fill rule wraps anywhere and sets no width. Covers Invoice Number, Submission/Issue Date, signature Date, Address, each day's Load / BOL #, Notes. Base: fixed-width inputs", ({ eq, ok }) => {
	const labels = {
		service_invoice: ["Provider name", "Business name", "Provider address", "Provider phone", "Invoice number suffix", "Submission date", "Bank on file", "Provider signature", "Signature date", DAY_ROW_LOAD_BOL],
		service_invoice_owner_op: ["Provider name", "Business name", "Provider address", "Provider phone", "Invoice number suffix", "Submission date", "Bank on file", "Provider signature", "Signature date"],
		service_invoice_manual: ["Payee name", "Payee role", "Payee address", "Payee phone", "Invoice number suffix", "Issue date", "Notes", "Prepared by", "Payee signature", "Signature date"],
	};
	for (const [key, list] of Object.entries(labels)) {
		const html = TEMPLATES[key];
		eq(`${key}: boxes that would cut their value`, list.map((l) => grows(html, l)).filter(Boolean), []);
		const fill = rule(html, ".fill");
		ok(`${key}: a .fill rule that wraps anywhere`, /overflow-wrap:\s*anywhere/.test(fill), fill || "(no .fill rule)");
		ok(`${key}: the .fill rule sets no fixed width`, fill && !/(^|[\s;])width\s*:/.test(fill), fill);
		ok(`${key}: the FROM block's boxes are not held to 340px`, !/\.from-cell \.(blank|fill) \{[^}]*max-width:\s*340px/.test(html));
	}
	// The renderer fills these labels; each must still be in the template it fills.
	for (const key of Object.keys(labels)) {
		const asked = Object.keys(FIELD_MAPS[key]({}).text).filter((l) => !/^(Saturday|Sunday|Monday|Tuesday|Wednesday|Thursday|Friday) /.test(l));
		eq(`${key}: labels the field map fills that the template lacks`, asked.filter((l) => !slot(TEMPLATES[key], l)), []);
	}
});

test("D2 The Invoice Number box prints the invoice's own number: the template's prefix and the field map's suffix make \"INV-HR-2026W41-01\" (\"INV-M-HR-2026W41-01\" on the manual one), not \"INV-2026-HR-2026W41-01\". Base: a literal \"INV-2026-\" on both weekly templates", ({ eq }) => {
	const number = (key, invoiceNumber) => {
		const m = /<span class="prefix">([^<]*)<\/span>\s*<[a-z]+\b[^>]*aria-label="Invoice number suffix"/.exec(TEMPLATES[key]);
		return (m ? m[1] : "(no prefix span before a suffix box)") + FIELD_MAPS[key]({ invoiceNumberSuffix: invoiceNumber.replace(/^INV-/, "") }).text["Invoice number suffix"];
	};
	for (const key of WEEKLY) eq(key, number(key, "INV-HR-2026W41-01"), "INV-HR-2026W41-01");
	eq("service_invoice_manual", number("service_invoice_manual", "INV-M-HR-2026W41-01"), "INV-M-HR-2026W41-01");
});

test("D3 A two-load day's Load / BOL # wraps inside its cell: each day row's box is a block-level fill that breaks long numbers, and the field map passes both loads whole. Base: a one-line input", ({ eq, ok }) => {
	const html = TEMPLATES.service_invoice;
	eq("the day row's Load / BOL box", grows(html, DAY_ROW_LOAD_BOL), "");
	const cell = rule(html, ".service-table .load-cell .fill");
	ok("the Load / BOL box fills its cell as a block", /display:\s*block/.test(cell), cell || "(no .service-table .load-cell .fill rule)");
	const text = FIELD_MAPS.service_invoice({ days: { Tuesday: { loadBol: "30080873, 209875716", total: 300, completed: true } } }).text;
	eq("Tuesday's value", text["Tuesday Load/BOL number"], "30080873, 209875716");
});

test("D4 TOTAL DUE stays with the rows above it: on the weekly invoice no table row splits and neither TOTAL DUE nor the adjustment line may start a page; the owner-operator and manual invoices keep their pay summary's last lines the same way. Base: no rule", ({ ok }) => {
	const svc = TEMPLATES.service_invoice;
	ok("service_invoice: rows don't split", declares(svc, ".service-table tr", "break-inside: avoid"));
	ok("service_invoice: TOTAL DUE never starts a page", declares(svc, ".service-table .total-row", "break-before: avoid"));
	ok("service_invoice: nor the adjustment line", declares(svc, ".service-table .adjustment-row", "break-before: avoid"));
	ok("service_invoice: the legacy property too", declares(svc, ".service-table .total-row", "page-break-before: avoid"));
	for (const key of ["service_invoice_owner_op", "service_invoice_manual"]) {
		const html = TEMPLATES[key];
		ok(`${key}: summary lines don't split`, declares(html, ".pay-summary .row", "break-inside: avoid"));
		ok(`${key}: TOTAL DUE never starts a page`, declares(html, ".pay-summary .total-row", "break-before: avoid"));
		ok(`${key}: nor the adjustment line`, declares(html, ".pay-summary .adjustment-row", "break-before: avoid"));
	}
	ok("service_invoice_manual: nor DRIVER OWES", declares(TEMPLATES.service_invoice_manual, ".pay-summary .owed-row", "break-before: avoid"));
});

console.log(`\n${passed} passed, ${failed} failed (of ${passed + failed})`);
process.exit(failed ? 1 : 0);
