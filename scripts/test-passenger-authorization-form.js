#!/usr/bin/env node
/**
 * The passenger authorization form (Form PA-1) and the policy renderer's
 * per-label signature images: onboarding-templates/policy/passenger-authorization.html,
 * the passenger_authorization field map (lib/policy-field-maps.js), the form's
 * wording (lib/passenger-authorization-text.js), safeSignatureImages() and the
 * fill loop in lib/policy-renderer.js, and the DOC_FILES mirror in
 * scripts/audit-policy-labels.js.
 *
 * WHAT IS ASSERTED
 *   §1 the template and the field map agree: the map fills exactly the form's
 *      labels and the template carries each of them; requiredText and the
 *      image map name filled labels; each party's labels sit in that party's
 *      signature block and nowhere else (no label shared by two parties);
 *      DOC_FILES and its mirror agree; scripts/audit-policy-labels.js exits 0
 *   §2 the form: the 49 CFR 392.60 items (passenger, start and end points,
 *      expiry) and the company signature block; the rules ("never drive",
 *      "older than 10", "seat belt", "insurance"); NO review note (it is shown
 *      to the Super Admin and sent with the sample, never signed under); every
 *      capitalized word on a fixed list, so no person's or other carrier's
 *      name; no script, no resource but the fonts; what the map prints at each
 *      stage (blank form, signed by passenger and driver, countersigned): the
 *      company lines never alone, and never AUTHORIZED with a 392.60 item blank
 *   §3 safeSignatureImages(): keeps a raster data: URI per filled label; drops
 *      http(s), //host, SVG, an oversize URI, a label the document does not
 *      fill, a non-object or non-plain object, inherited keys and a 4th entry;
 *      logs the label, never the value; safeSignatureImage() is unchanged
 *   §4 the fill on a fake page: a stand-in for ./pdf-browser runs the in-page
 *      function (from its source, with a JSON copy of its argument, as
 *      Puppeteer does) against a stub document built from the template. Each
 *      signature slot becomes its own <img>; a label with no image keeps its
 *      text; a label named by both image rules still gets one image per slot;
 *      a repeated slot gets a fresh <img> each; a missing required slot is
 *      refused; equipment_policy and mobile_policy fill exactly as before
 *   §5 mutants: drop the label check, the per-value check, the cap or the
 *      plain-object check, skip the check in renderPolicy(), or ignore the map
 *      in the page: each flips a case above
 *
 * Pure: no server, no browser, no network, no database, no writes.
 *
 * Run: node scripts/test-passenger-authorization-form.js    # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const path = require("path");
const Module = require("module");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const TEMPLATE_FILE = "passenger-authorization.html";
const TEMPLATE_PATH = path.join(ROOT, "onboarding-templates", "policy", TEMPLATE_FILE);
const RENDERER_PATH = path.join(ROOT, "lib", "policy-renderer.js");
const RENDERER_SRC = fs.readFileSync(RENDERER_PATH, "utf8");
const AUDIT_PATH = path.join(ROOT, "scripts", "audit-policy-labels.js");
const TEXT_PATH = path.join(ROOT, "lib", "passenger-authorization-text.js");
const POLICY_FIELD_MAPS = require(path.join(ROOT, "lib", "policy-field-maps.js"));
const { SIGNATURE_DATA_URI_MAX_LENGTH } = require(path.join(ROOT, "lib", "image-size.js"));

let pass = 0;
const failures = [];
const ok = (cond, msg) => { if (cond) pass++; else failures.push(msg); };
const eq = (actual, expected, msg) => {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	ok(a === e, `${msg}\n      expected ${e}\n      actual   ${a}`);
};
// A part that throws (a missing file or export on older code) is one failure, not a crash.
async function part(title, fn) {
	console.log(title);
	try { await fn(); } catch (err) { failures.push(`${title}: threw ${err && err.message ? err.message : err}`); }
}
const readTemplate = () => fs.readFileSync(TEMPLATE_PATH, "utf8");
const loadText = () => require(TEXT_PATH).PASSENGER_AUTHORIZATION_TEXT;
const ariaLabels = (html) => [...html.matchAll(/aria-label="([^"]*)"/g)].map((m) => m[1]);
const sorted = (a) => [...a].sort();

// ── made-up people and values (no real person, carrier or place of business) ─
const img = (kind, words) => `data:image/${kind};base64,${Buffer.from(words).toString("base64")}`;
const PNG_PASSENGER = img("png", "made-up passenger signature");
const PNG_DRIVER = img("png", "made-up driver signature");
const PNG_COMPANY = img("png", "made-up company signature");
const PNG_OTHER = img("png", "made-up other signature");
const JPEG_ANY = img("jpeg", "made-up jpeg signature");
// A value the image check refuses; the runner checks it never reaches a log or the page.
const REFUSED_URL = "https://example.com/made-up.png";

const MINOR = {
	reference: "PA-0000ABCD",
	passengerName: "Riley Example",
	passengerAdult: false,
	guardianName: "Pat Example",
	guardianRelationship: "Parent",
	driverName: "Casey Example",
	truckUnit: "T-0000",
	tripStart: "Houston, TX",
	tripEnd: "Dallas, TX",
	validFrom: "November 2, 2026",
	expiresOn: "November 9, 2026",
	passengerSignedOn: "October 30, 2026",
	passengerSignatureImage: PNG_PASSENGER,
	driverSignedOn: "October 30, 2026",
	driverSignatureImage: PNG_DRIVER,
};
const COMPANY_SIGNED = {
	companyPrintedName: "Sam Example",
	companyTitle: "Safety Manager",
	companySignedOn: "October 31, 2026",
	companySignatureImage: PNG_COMPANY,
};
const ADULT = { ...MINOR, passengerName: "Jane Example", passengerAdult: true, guardianName: "", guardianRelationship: "" };
const FINAL_MINOR = { ...MINOR, ...COMPANY_SIGNED };

const LABELS = [
	"Authorization reference", "Validity notice", "Passenger name", "Passenger age statement", "Driver name",
	"Truck unit", "Trip start", "Trip end", "Valid from", "Expires on",
	"Passenger or guardian signature", "Passenger or guardian printed name", "Guardian relationship", "Passenger or guardian date",
	"Driver signature", "Driver printed name", "Driver date",
	"Company signature", "Company printed name", "Company title", "Company date",
];
const PARTY_LABELS = {
	passenger: ["Passenger or guardian signature", "Passenger or guardian printed name", "Guardian relationship", "Passenger or guardian date"],
	driver: ["Driver signature", "Driver printed name", "Driver date"],
	company: ["Company signature", "Company printed name", "Company title", "Company date"],
};
const IMAGE_LABELS = { passenger: "Passenger or guardian signature", driver: "Driver signature", company: "Company signature" };
const IMAGE_OF = { passenger: PNG_PASSENGER, driver: PNG_DRIVER, company: PNG_COMPANY };
// The renderer's style for a drawn signature, unchanged by this work.
const SIGNATURE_STYLE = "max-height:40px; max-width:100%; display:inline-block; vertical-align:middle; padding:0 4px; border-bottom:1px solid #000;";
// Every capitalized word in the template (its field labels aside, which §1
// pins): any name added to the form, a person's or a carrier's, fails §2.
const FORM_WORDS = [
	// the form's own words
	"A", "AND", "ACCIDENT", "AUTHORIZATION", "After", "Accident", "Authorization", "Authorized", "By", "Company", "Date",
	"Driver", "Each", "Expires", "FOR", "Form", "It", "NOT", "No", "PASSENGER", "Part", "Passenger", "Passenger's", "Printed",
	"Reference", "Relationship", "Release", "Room", "Rules", "SIGNED", "Signature", "Signatures", "The", "This", "Title",
	"Trip", "Truck", "UNTIL", "VALID", "Valid", "WAIVER", "Waiver", "Who",
	// the carrier, the rule, the form's number and date
	"CFR", "INC", "Inc", "LOGISX", "LogisX", "October", "PA", "S", "Texas", "U",
	// the markup and the fonts
	"Arial", "BlinkMacSystemFont", "DOCTYPE", "Open", "Roboto", "Sans", "Segoe", "UI", "UTF",
];

// The three signature blocks of Part 6, each from its data-party marker to the next.
function partyBlocks(html) {
	const order = ["passenger", "driver", "company"];
	const out = {};
	order.forEach((party, i) => {
		const at = html.indexOf(`data-party="${party}"`);
		if (at < 0) return;
		const end = i + 1 < order.length ? html.indexOf(`data-party="${order[i + 1]}"`, at) : html.indexOf("</section>", at);
		out[party] = html.slice(at, end > at ? end : undefined);
	});
	return out;
}

// The text a reader sees in the body, tags dropped and whitespace collapsed.
function bodyText(html) {
	const body = (/<body[^>]*>([\s\S]*)<\/body>/i.exec(html) || [null, ""])[1];
	return body
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/g, " ").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&amp;/g, "&")
		.replace(/\s+/g, " ")
		.trim();
}

// DOC_FILES as written in a source file: { key: "file.html" }.
function docFilesOf(src, file) {
	const m = /const DOC_FILES = \{([\s\S]*?)\n\};/.exec(src);
	if (!m) throw new Error(`no DOC_FILES block in ${file}`);
	return Object.fromEntries([...m[1].matchAll(/^\s*([a-z_]+):\s*"([^"]+)",/gm)].map((x) => [x[1], x[2]]));
}

// The people the other documents name as LogisX's signer, read from their
// maps so no name is written here.
function companyPeople() {
	const names = [
		POLICY_FIELD_MAPS.mobile_policy({}).text["Received by signature"],
		POLICY_FIELD_MAPS.master_agreement({}).text["Manager name"],
		POLICY_FIELD_MAPS.vehicle_lease({}).text["Lessor printed name"],
	];
	return [...new Set(names.filter((n) => typeof n === "string" && n.trim()))];
}

// ── the fake page ────────────────────────────────────────────────────────────
// CSS.escape as the CSSOM spec defines it, and its inverse for the stub's selector reader.
function cssEscape(value) {
	const s = String(value);
	let out = "";
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c === 0) { out += "�"; continue; }
		if ((c >= 0x01 && c <= 0x1f) || c === 0x7f || (i === 0 && c >= 0x30 && c <= 0x39) ||
			(i === 1 && c >= 0x30 && c <= 0x39 && s.charCodeAt(0) === 0x2d)) { out += `\\${c.toString(16)} `; continue; }
		if (i === 0 && s.length === 1 && c === 0x2d) { out += `\\${s[i]}`; continue; }
		if (c >= 0x80 || c === 0x2d || c === 0x5f || (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) { out += s[i]; continue; }
		out += `\\${s[i]}`;
	}
	return out;
}
const cssUnescape = (s) => s.replace(/\\(?:([0-9a-fA-F]{1,6})[ \t\n\r\f]?|([\s\S]))/g, (_, hex, ch) => (hex ? String.fromCodePoint(parseInt(hex, 16)) : ch));

// The selectors the fill code uses: an optional tag, then [attr] or [attr="value"]
// groups. Anything else throws, so a new kind of selector cannot quietly match nothing.
function parseSelector(sel) {
	const tag = /^[a-zA-Z]*/.exec(sel)[0];
	const attrs = [];
	let i = tag.length;
	const bad = () => new Error(`stub document: unsupported selector ${sel}`);
	while (i < sel.length) {
		if (sel[i] !== "[") throw bad();
		const name = /^[a-zA-Z-]+/.exec(sel.slice(i + 1));
		if (!name) throw bad();
		i += 1 + name[0].length;
		if (sel[i] === "]") { attrs.push([name[0], undefined]); i++; continue; }
		if (sel.slice(i, i + 2) !== "=\"") throw bad();
		i += 2;
		let raw = "";
		while (i < sel.length && sel[i] !== "\"") {
			if (sel[i] === "\\") { raw += sel.slice(i, i + 2); i += 2; } else { raw += sel[i]; i++; }
		}
		if (sel.slice(i, i + 2) !== "\"]") throw bad();
		i += 2;
		attrs.push([name[0], cssUnescape(raw)]);
	}
	return { tag, attrs };
}

function makeNode(doc, tagName, attrs = {}, initialText = "") {
	const attributes = new Map(Object.entries(attrs));
	let value = tagName === "INPUT" ? (attributes.get("value") ?? "") : "";
	let text = initialText;
	const node = {
		tagName,
		style: { cssText: "" },
		getAttribute: (n) => (attributes.has(n) ? attributes.get(n) : null),
		setAttribute: (n, v) => { attributes.set(n, String(v)); },
		removeAttribute: (n) => { attributes.delete(n); },
		hasAttribute: (n) => attributes.has(n),
		get value() { return value; },
		set value(v) { value = String(v); },
		get textContent() { return text; },
		set textContent(v) { text = v == null ? "" : String(v); },
		// As in a browser: the property reflects the attribute, as a string.
		get src() { return attributes.get("src") ?? ""; },
		set src(v) { attributes.set("src", String(v)); },
		get alt() { return attributes.get("alt") ?? ""; },
		set alt(v) { attributes.set("alt", String(v)); },
		replaceWith(other) {
			const at = doc.nodes.indexOf(node);
			if (at < 0) throw new Error("stub document: replaceWith on a node not in the document");
			doc.nodes.splice(at, 1, other);
			doc.replaced.push({ from: node, to: other });
		},
	};
	return node;
}

// Every element of the page that carries an aria-label or a data- attribute
// (all the fill code looks up), in document order, with its own text.
function stubDocument(html) {
	const doc = {
		nodes: [],
		replaced: [],
		querySelectorAll(sel) {
			const q = parseSelector(sel);
			return doc.nodes.filter((n) => (!q.tag || n.tagName === q.tag.toUpperCase()) &&
				q.attrs.every(([name, want]) => (want === undefined ? n.hasAttribute(name) : n.getAttribute(name) === want)));
		},
		querySelector(sel) { return doc.querySelectorAll(sel)[0] || null; },
		getElementById: () => null,
		createElement: (tag) => makeNode(doc, String(tag).toUpperCase()),
	};
	const tagRe = /<([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/g;
	let m;
	while ((m = tagRe.exec(html))) {
		const attrs = {};
		for (const a of m[2].matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*"([^"]*)")?/g)) {
			attrs[a[1].toLowerCase()] = (a[2] ?? "").replace(/&quot;/g, "\"").replace(/&amp;/g, "&");
		}
		if (!("aria-label" in attrs) && !Object.keys(attrs).some((k) => k.startsWith("data-"))) continue;
		const tagName = m[1].toUpperCase();
		const after = m.index + m[0].length;
		const initial = tagName === "INPUT" ? "" : html.slice(after, html.indexOf("<", after));
		doc.nodes.push(makeNode(doc, tagName, attrs, initial));
	}
	return doc;
}

const recorder = (transform = null) => ({ transform, docs: [], args: [], results: [], closed: 0 });

function fakePage(html, rec) {
	const doc = stubDocument(html);
	rec.docs.push(doc);
	return {
		async evaluate(fn, arg) {
			// Puppeteer sends the function's source and a JSON copy of its argument:
			// nothing from the renderer's own scope reaches the page.
			const inPage = new Function("document", "CSS", `return (${fn.toString()});`)(doc, { escape: cssEscape });
			const sent = arg === undefined ? undefined : JSON.parse(JSON.stringify(arg));
			rec.args.push(sent);
			const result = await inPage(sent);
			const back = result === undefined ? undefined : JSON.parse(JSON.stringify(result));
			rec.results.push(back);
			return back;
		},
		async pdf() { return new Uint8Array(Buffer.from("%PDF-1.7\n% made-up stand-in for the browser's output\n")); },
		async close() { rec.closed++; },
	};
}

// lib/policy-renderer.js compiled from `src` at its own path (so its requires
// resolve from lib/), with ./pdf-browser replaced by the fake page and
// puppeteer by nothing: no browser can start.
function loadRenderer(src, rec) {
	const fakeBrowser = { openPageWithContent: async (html) => fakePage(rec.transform ? rec.transform(html) : html, rec) };
	const realRequire = Module.prototype.require;
	Module.prototype.require = function (id) {
		if (id === "./pdf-browser") return fakeBrowser;
		if (id === "puppeteer") return {};
		return realRequire.apply(this, arguments);
	};
	try {
		const m = new Module(RENDERER_PATH, null);
		m.filename = RENDERER_PATH;
		m.paths = Module._nodeModulePaths(path.dirname(RENDERER_PATH));
		m._compile(src, RENDERER_PATH);
		return m.exports;
	} finally {
		Module.prototype.require = realRequire;
	}
}

// A render with console.warn captured: { pdf, warns, error }.
async function rendering(R, docKey, data) {
	const warns = [];
	const realWarn = console.warn;
	console.warn = (...a) => warns.push(a.map(String).join(" "));
	try {
		return { pdf: await R.renderPolicy(docKey, data), warns, error: null };
	} catch (error) {
		return { pdf: null, warns, error };
	} finally {
		console.warn = realWarn;
	}
}
const shown = (n) => (n.tagName === "INPUT" ? n.value : n.textContent);
const slotsOf = (doc, label) => doc.nodes.filter((n) => n.getAttribute("aria-label") === label);
const swapsOf = (doc, label) => doc.replaced.filter((r) => r.from.getAttribute("aria-label") === label).map((r) => r.to);
const imagesIn = (doc) => doc.nodes.filter((n) => n.tagName === "IMG");
// Removes the one span carrying `label`, or doubles it; anything but exactly one match throws.
function editSlot(label, how) {
	return (html) => {
		const re = new RegExp(`<span\\b[^>]*aria-label="${label}"[^>]*></span>`, "g");
		const found = html.match(re) || [];
		if (found.length !== 1) throw new Error(`fixture: "${label}" slot found ${found.length} times`);
		return html.replace(re, how === "remove" ? "" : `${found[0]}${found[0]}`);
	};
}

// ── §3's cases, as a table any copy of the renderer can be run against ──────
function section3Cases(R) {
	const TEXT = { "Passenger or guardian signature": "x", "Driver signature": "x", "Company signature": "x", "Driver printed name": "x" };
	const quietly = (fn) => {
		const realWarn = console.warn;
		console.warn = () => {};
		try { return fn(); } finally { console.warn = realWarn; }
	};
	const run = (map, text = TEXT) => JSON.stringify(quietly(() => R.safeSignatureImages(map, text, "passenger_authorization")));
	const J = (o) => JSON.stringify(o);
	return [
		["keeps a PNG data URI for a filled label", () => run({ "Driver signature": PNG_DRIVER }) === J({ "Driver signature": PNG_DRIVER })],
		["keeps a JPEG data URI", () => run({ "Company signature": JPEG_ANY }) === J({ "Company signature": JPEG_ANY })],
		["keeps one image per label for three labels", () => run({ "Passenger or guardian signature": PNG_PASSENGER, "Driver signature": PNG_DRIVER, "Company signature": PNG_COMPANY }) ===
			J({ "Passenger or guardian signature": PNG_PASSENGER, "Driver signature": PNG_DRIVER, "Company signature": PNG_COMPANY })],
		["drops an https URL", () => run({ "Driver signature": "https://example.com/signature.png" }) === "{}"],
		["drops an http URL", () => run({ "Driver signature": "http://example.com/made-up/signature.png" }) === "{}"],
		["drops a protocol-relative //host URL", () => run({ "Driver signature": "//example.com/signature.png" }) === "{}"],
		["drops an SVG data URI", () => run({ "Driver signature": "data:image/svg+xml;base64,PHN2Zy8+" }) === "{}"],
		["drops a data URI over the length cap", () => run({ "Driver signature": `data:image/png;base64,${"A".repeat(SIGNATURE_DATA_URI_MAX_LENGTH)}` }) === "{}"],
		["drops a label the document does not fill", () => run({ "Witness signature": PNG_OTHER }) === "{}"],
		["drops every image when the document fills nothing", () => run({ "Driver signature": PNG_DRIVER }, null) === "{}" && run({ "Driver signature": PNG_DRIVER }, {}) === "{}"],
		["drops a label the text only inherits", () => run({ "Driver signature": PNG_DRIVER }, Object.create({ "Driver signature": "x" })) === "{}"],
		["drops a non-object", () => [PNG_DRIVER, [PNG_DRIVER], null, undefined, 42, true, new Map([["Driver signature", PNG_DRIVER]]), () => PNG_DRIVER]
			.every((v) => run(v) === "{}")],
		["drops inherited keys", () => run(Object.create({ "Driver signature": PNG_DRIVER })) === "{}"],
		// Each holds a filled label as an OWN key with a valid image: only the
		// plain-object rule stops them.
		["drops a non-plain object even when its own key is a filled label", () => {
			class Holder { constructor() { this["Driver signature"] = PNG_DRIVER; } }
			const list = [];
			list["Driver signature"] = PNG_DRIVER;
			const custom = Object.assign(Object.create({ unrelated: true }), { "Driver signature": PNG_DRIVER });
			return [new Holder(), list, custom].every((v) => run(v) === "{}");
		}],
		["keeps own keys only when Object.prototype carries a label", () => {
			Object.prototype["Driver signature"] = PNG_OTHER;
			try {
				return run({ "Company signature": PNG_COMPANY }) === J({ "Company signature": PNG_COMPANY });
			} finally {
				delete Object.prototype["Driver signature"];
			}
		}],
		["drops a 4th entry", () => run({ "Passenger or guardian signature": PNG_PASSENGER, "Driver signature": PNG_DRIVER, "Company signature": PNG_COMPANY, "Driver printed name": PNG_OTHER }) ===
			J({ "Passenger or guardian signature": PNG_PASSENGER, "Driver signature": PNG_DRIVER, "Company signature": PNG_COMPANY })],
		["keeps the others when one is refused", () => run({ "Driver signature": PNG_DRIVER, "Company signature": "https://example.com/signature.png" }) === J({ "Driver signature": PNG_DRIVER })],
		["drops an empty or non-string value", () => run({ "Driver signature": "", "Company signature": 42, "Passenger or guardian signature": null }) === "{}"],
		["trims a value as safeSignatureImage() does", () => run({ "Driver signature": `  ${PNG_DRIVER}\n` }) === J({ "Driver signature": PNG_DRIVER })],
		["returns a new object with no prototype", () => {
			const input = { "Driver signature": PNG_DRIVER };
			const out = quietly(() => R.safeSignatureImages(input, TEXT, "passenger_authorization"));
			input["Driver signature"] = PNG_OTHER;
			return out !== input && Object.getPrototypeOf(out) === null && out["Driver signature"] === PNG_DRIVER;
		}],
		["logs each dropped label and never its value", () => {
			const seen = [];
			const realWarn = console.warn;
			console.warn = (...a) => seen.push(a.map(String).join(" "));
			try {
				R.safeSignatureImages({ "Company signature": REFUSED_URL, "Witness signature": PNG_OTHER, ["L".repeat(500)]: PNG_OTHER },
					TEXT, "passenger_authorization");
			} finally {
				console.warn = realWarn;
			}
			const all = seen.join("\n");
			return seen.length === 3 && all.includes("\"Company signature\"") && all.includes("\"Witness signature\"") &&
				all.includes(`"${"L".repeat(80)}"`) && !all.includes("L".repeat(81)) &&
				!all.includes(REFUSED_URL) && !all.includes(PNG_OTHER.slice(22));
		}],
	];
}
const holds = (fn) => { try { return fn() === true; } catch { return false; } };

(async () => {
	// ── §1 the template and the field map agree ──────────────────────────────
	await part("§1 the template and the field map agree", () => {
		ok(fs.existsSync(TEMPLATE_PATH), `§1 onboarding-templates/policy/${TEMPLATE_FILE} exists`);
		const mapper = POLICY_FIELD_MAPS.passenger_authorization;
		ok(typeof mapper === "function", "§1 lib/policy-field-maps.js registers passenger_authorization");
		const html = readTemplate();
		const fields = mapper(FINAL_MINOR);
		const inTemplate = ariaLabels(html);
		const filled = Object.keys(fields.text);
		eq(filled, LABELS, "§1 the map fills exactly the form's 21 labels");
		eq(filled.filter((l) => !inTemplate.includes(l)), [], "§1 every label the map fills is in the template");
		eq([...new Set(inTemplate)].filter((l) => !filled.includes(l)), [], "§1 every label in the template is one the map fills");
		for (const l of LABELS) {
			const n = inTemplate.filter((x) => x === l).length;
			const want = l === "Authorization reference" ? 2 : 1;
			ok(n === want, `§1 "${l}" appears ${want} time(s) in the template (found ${n})`);
		}
		eq(fields.requiredText.filter((l) => !Object.prototype.hasOwnProperty.call(fields.text, l)), [], "§1 requiredText names only filled labels");
		eq(sorted(fields.requiredText), sorted(LABELS), "§1 every label is required (an empty value is skipped by the fill assertion)");
		eq(Object.keys(fields.signatureImagesByLabel), Object.values(IMAGE_LABELS), "§1 the image map holds the three signature labels");
		ok(fields.signatureLabelForImage === null && fields.signatureImage === null,
			"§1 the single-image rule is off for this form: images are placed only by label");

		const blocks = partyBlocks(html);
		eq(Object.keys(blocks), ["passenger", "driver", "company"], "§1 Part 6 holds the passenger, driver and company blocks, in that order");
		for (const party of Object.keys(PARTY_LABELS)) {
			ok(html.split(`data-party="${party}"`).length === 2, `§1 one ${party} block`);
		}
		const owners = new Map();
		for (const [party, labels] of Object.entries(PARTY_LABELS)) {
			const inBlock = ariaLabels(blocks[party] || "");
			eq(sorted(inBlock), sorted(labels), `§1 the ${party} block holds exactly the ${party}'s labels`);
			for (const l of labels) {
				ok(inTemplate.filter((x) => x === l).length === inBlock.filter((x) => x === l).length, `§1 "${l}" appears only in the ${party} block`);
			}
			for (const l of inBlock) owners.set(l, [...(owners.get(l) || []), party]);
			ok(labels.includes(IMAGE_LABELS[party]), `§1 the ${party}'s signature image goes on the ${party}'s own block`);
		}
		eq([...owners].filter(([, parties]) => parties.length > 1).map(([l]) => l), [], "§1 no label is shared by two parties");

		const rendererDocs = docFilesOf(RENDERER_SRC, "lib/policy-renderer.js");
		eq(rendererDocs.passenger_authorization, TEMPLATE_FILE, "§1 DOC_FILES maps passenger_authorization to its template");
		eq(docFilesOf(fs.readFileSync(AUDIT_PATH, "utf8"), "scripts/audit-policy-labels.js"), rendererDocs,
			"§1 scripts/audit-policy-labels.js mirrors DOC_FILES in lib/policy-renderer.js");
		const R = loadRenderer(RENDERER_SRC, recorder());
		ok(R.prepareTemplateHtml("passenger_authorization") === html, "§1 the renderer prepares the template as its file (no placeholder to fill)");

		const audit = spawnSync(process.execPath, [AUDIT_PATH], { cwd: ROOT, encoding: "utf8", timeout: 30000 });
		const auditOut = `${audit.stdout || ""}${audit.stderr || ""}`;
		ok(audit.status === 0, `§1 node scripts/audit-policy-labels.js exits 0 (exit ${audit.status})\n${auditOut}`);
		ok(/^(ok|note)\s+passenger_authorization\b/m.test(audit.stdout || ""), "§1 the audit covers passenger_authorization");
	});

	// ── §2 the form ──────────────────────────────────────────────────────────
	await part("§2 the form", () => {
		const T = loadText();
		const html = readTemplate();
		const body = bodyText(html);
		const lowerBody = body.toLowerCase();
		const lowerAll = html.toLowerCase();
		const at = (s) => html.indexOf(s);

		// 49 CFR 392.60: the passenger's name, where the trip begins and ends,
		// when the authorization expires, and the carrier's signature.
		const part_ = (n) => at(`<h2>Part ${n}.`);
		ok([1, 2, 3, 4, 5, 6].every((n) => html.split(`<h2>Part ${n}.`).length === 2 && (n === 1 || part_(n) > part_(n - 1))), "§2 Parts 1-6, each once, in order");
		const slot = (l) => at(`aria-label="${l}"`);
		ok(["Passenger name", "Passenger age statement", "Driver name", "Truck unit"].every((l) => slot(l) > part_(1) && slot(l) < part_(2)),
			"§2 Part 1 names the passenger, the age, the only driver and the truck");
		ok(["Trip start", "Trip end", "Valid from", "Expires on"].every((l) => slot(l) > part_(2) && slot(l) < part_(3)),
			"§2 Part 2 holds the trip's start and end points and its dates");
		ok([...PARTY_LABELS.company].every((l) => slot(l) > part_(6)), "§2 the company signature block is in Part 6");
		ok(/Authorized for LogisX Inc\./.test(partyBlocks(html).company || ""), "§2 the company block is signed for LogisX Inc.");
		ok(body.includes("49 CFR 392.60"), "§2 the form says which rule it meets");
		ok(body.includes("This authorization is not valid until it is signed for the Company in Part 6."), "§2 the form says it is not valid until the company signs");
		ok(body.includes("LogisX Inc., a Texas corporation and authorized U.S. motor carrier"), "§2 the form names the carrier as the other documents do");
		for (const words of ["never drive", "older than 10", "seat belt", "insurance", "parent or legal guardian", "release"]) {
			ok(lowerBody.includes(words), `§2 the form says "${words}"`);
		}
		eq(html.split(`Form ${T.FORM_VERSION} (${T.FORM_DATE})`).length - 1, 3,
			"§2 the form's version and date (from the wording module) print in all three places: header, page footer, closing line");
		ok(html.includes(`aria-label="Validity notice">${T.VALIDITY_NOTICE.pending}<`), "§2 left unfilled, the notice reads NOT VALID");

		// The review note is for the Super Admin and the sample; nobody signs under it.
		ok(typeof T.REVIEW_NOTE === "string" && /lawyer/i.test(T.REVIEW_NOTE) && /insurance/i.test(T.REVIEW_NOTE),
			"§2 the review note is exported for the countersign screen");
		ok(!html.includes(T.REVIEW_NOTE), "§2 the template does NOT carry the review note");
		ok(!/lawyer|attorney|\breview/i.test(html), "§2 ...nor any other wording of it");

		const capitalized = new Set((html.replace(/aria-label="[^"]*"/g, " ").match(/[A-Za-z][A-Za-z']*/g) || [])
			.map((w) => w.replace(/'+$/, ""))
			.filter((w) => /^[A-Z]/.test(w)));
		eq([...capitalized].filter((w) => !FORM_WORDS.includes(w)).sort(), [],
			"§2 every capitalized word in the template is on the form's list: no person's or other carrier's name");
		eq(FORM_WORDS.filter((w) => !capitalized.has(w)), [], "§2 ...and the list holds no word the template lacks");
		const tokens = new Set(lowerAll.match(/[a-z]+/g) || []);
		const people = companyPeople();
		ok(people.length > 0, "§2 the other documents' company signer could be read from their maps");
		for (const person of people) {
			const parts = person.toLowerCase().split(/\s+/).filter((w) => w.length >= 3);
			ok(parts.length > 0 && parts.every((w) => !tokens.has(w)), "§2 the template names no company signer (the countersigner types their own name)");
		}
		ok(!/<script/i.test(html), "§2 no script: nothing on the page can change a filled value");
		const urls = [...html.matchAll(/https?:\/\/[^\s"'<>)]+/g)].map((m) => m[0]);
		ok(urls.length > 0 && urls.every((u) => /^https:\/\/fonts\.(googleapis|gstatic)\.com(\/|$)/.test(u)),
			`§2 the only resources are the fonts the other templates load (${urls.join(", ")})`);
		ok(!html.includes("\r"), "§2 LF line endings");
		ok(!/\{\{[A-Z_]+\}\}/.test(html), "§2 no {{PLACEHOLDER}} for the renderer to leave behind");

		// What the map prints at each stage.
		const map = POLICY_FIELD_MAPS.passenger_authorization;
		const COMPANY_LINES = PARTY_LABELS.company;
		const values = (fields, labels) => labels.map((l) => fields.text[l]);
		const blank = map({ driverName: "Casey Example" });
		eq(blank.text["Validity notice"], T.VALIDITY_NOTICE.pending, "§2 blank form: NOT VALID");
		eq(LABELS.filter((l) => !["Driver name", "Validity notice"].includes(l) && blank.text[l] !== ""), [],
			"§2 blank form: only the driver's name and the notice print");
		eq(Object.keys(blank.signatureImagesByLabel), [], "§2 blank form: no image");

		const minor = map(MINOR);
		eq(minor.text["Validity notice"], T.VALIDITY_NOTICE.pending, "§2 signed by guardian and driver: still NOT VALID");
		eq(values(minor, COMPANY_LINES), ["", "", "", ""], "§2 signed by guardian and driver: the company lines are blank");
		eq(Object.keys(minor.signatureImagesByLabel), [IMAGE_LABELS.passenger, IMAGE_LABELS.driver], "§2 signed by guardian and driver: their two images");
		eq(values(minor, ["Passenger name", "Passenger age statement", "Passenger or guardian signature", "Passenger or guardian printed name", "Guardian relationship", "Passenger or guardian date"]),
			["Riley Example", T.AGE_STATEMENT.minor, "Pat Example", "Pat Example", "Parent", "October 30, 2026"],
			"§2 a minor: the guardian signs, with the relationship");
		eq(values(minor, ["Driver name", "Driver signature", "Driver printed name", "Driver date", "Trip start", "Trip end", "Valid from", "Expires on", "Truck unit", "Authorization reference"]),
			["Casey Example", "Casey Example", "Casey Example", "October 30, 2026", "Houston, TX", "Dallas, TX", "November 2, 2026", "November 9, 2026", "T-0000", "PA-0000ABCD"],
			"§2 the driver, trip, dates, truck and reference print as given");
		eq(T.AGE_STATEMENT.minor.includes("older than 10"), true, "§2 the minor's age line says older than 10");

		const adult = map(ADULT);
		eq(values(adult, ["Passenger age statement", "Passenger or guardian signature", "Passenger or guardian printed name", "Guardian relationship"]),
			[T.AGE_STATEMENT.adult, "Jane Example", "Jane Example", ""], "§2 an adult signs for themselves, no relationship line");

		const final = map(FINAL_MINOR);
		eq(final.text["Validity notice"], T.VALIDITY_NOTICE.authorized, "§2 countersigned: AUTHORIZED");
		eq(values(final, COMPANY_LINES), ["Sam Example", "Sam Example", "Safety Manager", "October 31, 2026"], "§2 countersigned: the company lines print");
		eq(Object.keys(final.signatureImagesByLabel), Object.values(IMAGE_LABELS), "§2 countersigned: all three images");

		for (const key of Object.keys(COMPANY_SIGNED)) {
			const partial = map({ ...FINAL_MINOR, [key]: "" });
			ok(partial.text["Validity notice"] === T.VALIDITY_NOTICE.pending && values(partial, COMPANY_LINES).every((v) => v === "") &&
				!(IMAGE_LABELS.company in partial.signatureImagesByLabel), `§2 without ${key} nothing of the company's prints and it stays NOT VALID`);
		}
		// 49 CFR 392.60's items (and a minor's relationship line): one blank and the
		// form cannot read AUTHORIZED.
		for (const key of ["passengerName", "tripStart", "tripEnd", "validFrom", "expiresOn", "guardianRelationship"]) {
			const blankItem = map({ ...FINAL_MINOR, [key]: "" });
			ok(blankItem.text["Validity notice"] === T.VALIDITY_NOTICE.pending && values(blankItem, COMPANY_LINES).every((v) => v === "") &&
				!(IMAGE_LABELS.company in blankItem.signatureImagesByLabel), `§2 with ${key} blank it stays NOT VALID and nothing of the company's prints`);
		}
		eq(map({ ...ADULT, ...COMPANY_SIGNED }).text["Validity notice"], T.VALIDITY_NOTICE.authorized, "§2 an adult needs no relationship line to be AUTHORIZED");
		const unsignedRider = map({ ...FINAL_MINOR, passengerSignedOn: "" });
		ok(unsignedRider.text["Validity notice"] === T.VALIDITY_NOTICE.pending && values(unsignedRider, COMPANY_LINES).every((v) => v === ""),
			"§2 the company cannot countersign a form the passenger or guardian has not signed");
		const unsignedDriver = map({ ...FINAL_MINOR, driverSignedOn: "" });
		ok(unsignedDriver.text["Validity notice"] === T.VALIDITY_NOTICE.pending && values(unsignedDriver, COMPANY_LINES).every((v) => v === ""),
			"§2 ...nor one the driver has not signed");
		const stringAge = map({ ...FINAL_MINOR, passengerAdult: "false" });
		ok(stringAge.text["Passenger age statement"] === "" && stringAge.text["Passenger or guardian signature"] === "" &&
			stringAge.text["Validity notice"] === T.VALIDITY_NOTICE.pending && !(IMAGE_LABELS.passenger in stringAge.signatureImagesByLabel),
			"§2 the age answer must be a real true/false: \"false\" as text signs nothing");
		ok(!/\bCOMPANY\b/.test(map.toString()), "§2 the map never fills from the COMPANY constant: only a Super Admin's countersign authorizes a rider");
		const printed = [map({}), blank, minor, adult, final].flatMap((f) => Object.values(f.text)).join(" ").toLowerCase();
		ok(people.every((p) => !printed.includes(p.toLowerCase())), "§2 the map prints no company signer's name of its own");
	});

	// ── §3 safeSignatureImages() ─────────────────────────────────────────────
	await part("§3 safeSignatureImages()", () => {
		const R = loadRenderer(RENDERER_SRC, recorder());
		ok(typeof R.safeSignatureImages === "function", "§3 lib/policy-renderer.js exports safeSignatureImages");
		for (const [name, fn] of section3Cases(R)) ok(holds(fn), `§3 ${name}`);
		const SINGLE = [
			[PNG_DRIVER, PNG_DRIVER], [JPEG_ANY, JPEG_ANY], [`  ${PNG_DRIVER}  `, PNG_DRIVER],
			["data:image/gif;base64,R0lGODlh", "data:image/gif;base64,R0lGODlh"], ["data:image/webp;base64,UklGRg==", "data:image/webp;base64,UklGRg=="],
			["https://example.com/signature.png", null], ["//example.com/signature.png", null], ["data:image/svg+xml;base64,PHN2Zy8+", null],
			[`data:image/png;base64,${"A".repeat(SIGNATURE_DATA_URI_MAX_LENGTH)}`, null], ["", null], ["   ", null], [42, null], [null, null], [undefined, null],
		];
		for (const [input, want] of SINGLE) {
			const label = typeof input === "string" ? JSON.stringify(input.length > 40 ? `${input.slice(0, 40)}...` : input) : String(input);
			eq(R.safeSignatureImage(input), want, `§3 safeSignatureImage(${label}) is unchanged`);
		}
	});

	// ── §4 the fill on a fake page ───────────────────────────────────────────
	console.log("§4 the fill on a fake page");
	const T4 = (() => { try { return loadText(); } catch { return null; } })();
	await part("§4(a) countersigned: three slots, three images", async () => {
		const rec = recorder();
		const { pdf, error } = await rendering(loadRenderer(RENDERER_SRC, rec), "passenger_authorization", FINAL_MINOR);
		if (error) throw error;
		ok(Buffer.isBuffer(pdf) && pdf.subarray(0, 4).toString() === "%PDF", "§4(a) the render returns the page's PDF as a Buffer");
		const doc = rec.docs[0];
		eq(imagesIn(doc).length, 3, "§4(a) three <img> on the page");
		for (const [party, label] of Object.entries(IMAGE_LABELS)) {
			const swaps = swapsOf(doc, label);
			ok(swaps.length === 1 && swaps[0].tagName === "IMG" && swaps[0].getAttribute("src") === IMAGE_OF[party],
				`§4(a) the ${party}'s slot became one <img> carrying the ${party}'s own image`);
			ok(swaps.length === 1 && swaps[0].getAttribute("alt") === "Signature" && swaps[0].style.cssText === SIGNATURE_STYLE,
				`§4(a) ...with the renderer's alt text and style`);
		}
		ok(new Set(imagesIn(doc)).size === 3, "§4(a) each slot has a node of its own");
		const want = POLICY_FIELD_MAPS.passenger_authorization(FINAL_MINOR).text;
		for (const l of LABELS.filter((x) => !Object.values(IMAGE_LABELS).includes(x))) {
			const slots = slotsOf(doc, l);
			ok(slots.length > 0 && slots.every((n) => shown(n) === want[l]), `§4(a) "${l}" reads its value`);
		}
		ok(T4 && slotsOf(doc, "Validity notice").every((n) => n.textContent === T4.VALIDITY_NOTICE.authorized), "§4(a) the notice reads AUTHORIZED");
		eq(rec.results[0], { verified: LABELS, mismatched: [], missed: [] }, "§4(a) the fill report verifies every label");
		eq(Object.keys(rec.args[0].signatureImagesByLabel || {}), Object.values(IMAGE_LABELS), "§4(a) the page receives the three checked images");
		eq(rec.closed, 1, "§4(a) the page is closed");
	});
	await part("§4(b) signed by guardian and driver: the company slot keeps its text", async () => {
		const rec = recorder();
		const { error } = await rendering(loadRenderer(RENDERER_SRC, rec), "passenger_authorization", MINOR);
		if (error) throw error;
		const doc = rec.docs[0];
		eq(imagesIn(doc).length, 2, "§4(b) two <img>: the guardian's and the driver's");
		eq(swapsOf(doc, IMAGE_LABELS.company).length, 0, "§4(b) the company's slot is not replaced");
		ok(slotsOf(doc, IMAGE_LABELS.company).length === 1 && shown(slotsOf(doc, IMAGE_LABELS.company)[0]) === "", "§4(b) ...and stays blank");
		ok(T4 && slotsOf(doc, "Validity notice").every((n) => n.textContent === T4.VALIDITY_NOTICE.pending), "§4(b) the notice reads NOT VALID");
		eq(rec.results[0] && rec.results[0].mismatched, [], "§4(b) nothing mismatched");
	});
	await part("§4(c) a refused company image never reaches the page", async () => {
		const rec = recorder();
		const { error, warns } = await rendering(loadRenderer(RENDERER_SRC, rec), "passenger_authorization",
			{ ...FINAL_MINOR, companySignatureImage: REFUSED_URL });
		if (error) throw error;
		const doc = rec.docs[0];
		eq(imagesIn(doc).length, 2, "§4(c) only the two checked images are placed");
		ok(slotsOf(doc, IMAGE_LABELS.company).length === 1 && shown(slotsOf(doc, IMAGE_LABELS.company)[0]) === "Sam Example",
			"§4(c) the company's slot keeps its text (the typed name)");
		ok(!JSON.stringify(rec.args[0]).includes(REFUSED_URL), "§4(c) the refused value is not in what the page receives");
		ok(warns.some((w) => w.includes("\"Company signature\"")) && warns.every((w) => !w.includes(REFUSED_URL)), "§4(c) the log names the label, not the value");
	});
	await part("§4(d) a label named by both image rules gets one image per slot", async () => {
		const real = POLICY_FIELD_MAPS.passenger_authorization;
		POLICY_FIELD_MAPS.passenger_authorization = (data) => ({ ...real(data), signatureLabelForImage: IMAGE_LABELS.driver, signatureImage: PNG_OTHER });
		const rec = recorder();
		let result;
		try {
			result = await rendering(loadRenderer(RENDERER_SRC, rec), "passenger_authorization", FINAL_MINOR);
		} finally {
			POLICY_FIELD_MAPS.passenger_authorization = real;
		}
		if (result.error) throw result.error;
		const doc = rec.docs[0];
		const swaps = swapsOf(doc, IMAGE_LABELS.driver);
		ok(swaps.length === 1 && swaps[0].getAttribute("src") === PNG_DRIVER, "§4(d) the driver's slot is replaced once, by the label's own image");
		eq(imagesIn(doc).length, 3, "§4(d) still three <img>");
	});
	await part("§4(e) a repeated slot gets a fresh <img> each", async () => {
		const rec = recorder(editSlot(IMAGE_LABELS.driver, "double"));
		const { error } = await rendering(loadRenderer(RENDERER_SRC, rec), "passenger_authorization", FINAL_MINOR);
		if (error) throw error;
		const doc = rec.docs[0];
		const swaps = swapsOf(doc, IMAGE_LABELS.driver);
		ok(swaps.length === 2 && swaps[0] !== swaps[1] && swaps.every((n) => n.getAttribute("src") === PNG_DRIVER), "§4(e) both copies of the slot carry the image, each its own node");
		eq(imagesIn(doc).length, 4, "§4(e) four <img>");
		ok(rec.results[0] && rec.results[0].verified.includes(IMAGE_LABELS.driver), "§4(e) the repeated label is verified");
	});
	await part("§4(f) an image for a label the form does not fill is dropped", async () => {
		const real = POLICY_FIELD_MAPS.passenger_authorization;
		POLICY_FIELD_MAPS.passenger_authorization = (data) => {
			const f = real(data);
			return { ...f, signatureImagesByLabel: { ...f.signatureImagesByLabel, "Witness signature": PNG_OTHER } };
		};
		const rec = recorder();
		let result;
		try {
			result = await rendering(loadRenderer(RENDERER_SRC, rec), "passenger_authorization", FINAL_MINOR);
		} finally {
			POLICY_FIELD_MAPS.passenger_authorization = real;
		}
		if (result.error) throw result.error;
		eq(imagesIn(rec.docs[0]).length, 3, "§4(f) no extra <img>");
		ok(!JSON.stringify(rec.args[0]).includes(PNG_OTHER), "§4(f) the stray image is not sent to the page");
		ok(result.warns.some((w) => w.includes("\"Witness signature\"")), "§4(f) the log names the stray label");
	});
	await part("§4(g) a required slot missing from the page refuses the PDF", async () => {
		for (const label of ["Trip end", IMAGE_LABELS.company]) {
			const rec = recorder(editSlot(label, "remove"));
			const { pdf, error } = await rendering(loadRenderer(RENDERER_SRC, rec), "passenger_authorization", FINAL_MINOR);
			ok(pdf === null && error && error.code === "DOCUMENT_FIELDS_UNFILLED" && error.message.includes(label),
				`§4(g) without its "${label}" slot the render is refused, naming the label (${error ? error.message : "no error"})`);
			eq(rec.closed, 1, `§4(g) the page is closed after the "${label}" refusal`);
		}
	});
	await part("§4(h) equipment_policy fills exactly as before", async () => {
		const data = { fullName: "Casey Example", signatureText: "Casey Example", effectiveDate: "October 30, 2026", signatureImage: PNG_DRIVER };
		const rec = recorder();
		const { pdf, error } = await rendering(loadRenderer(RENDERER_SRC, rec), "equipment_policy", data);
		if (error) throw error;
		ok(Buffer.isBuffer(pdf), "§4(h) the render returns a Buffer");
		const doc = rec.docs[0];
		const swaps = swapsOf(doc, "Provider signature");
		ok(swaps.length === 1 && swaps[0].getAttribute("src") === PNG_DRIVER && swaps[0].getAttribute("alt") === "Signature" && swaps[0].style.cssText === SIGNATURE_STYLE,
			"§4(h) the drawn signature replaces the provider's slot, as before");
		eq(imagesIn(doc).length, 1, "§4(h) one <img>");
		const full = slotsOf(doc, "Full name")[0];
		const date = slotsOf(doc, "Date")[0];
		ok(full && full.value === "Casey Example" && full.getAttribute("value") === "Casey Example", "§4(h) the name is filled as value and attribute");
		ok(date && date.value === "October 30, 2026", "§4(h) the date is filled");
		eq(rec.results[0], { verified: ["Full name", "Provider signature", "Date"], mismatched: [], missed: [] }, "§4(h) the fill report is as before");
		ok(rec.args[0].signatureLabelForImage === "Provider signature" && rec.args[0].signatureImage === PNG_DRIVER &&
			Object.keys(rec.args[0].signatureImagesByLabel || {}).length === 0, "§4(h) the page gets the single image and no per-label image");

		const rec2 = recorder();
		const refused = await rendering(loadRenderer(RENDERER_SRC, rec2), "equipment_policy", { ...data, signatureImage: REFUSED_URL });
		if (refused.error) throw refused.error;
		eq(imagesIn(rec2.docs[0]).length, 0, "§4(h) a non-data: image is refused, as before");
		ok(slotsOf(rec2.docs[0], "Provider signature")[0].value === "Casey Example", "§4(h) ...and the typed signature fills the slot");
		ok(refused.warns.length === 1 && refused.warns[0].includes("equipment_policy") && !refused.warns[0].includes(REFUSED_URL), "§4(h) ...with the one warning, as before");
	});
	await part("§4(i) mobile_policy: the drawn signature never reaches the company's line", async () => {
		const data = { fullName: "Casey Example", signatureText: "Casey Example", effectiveDate: "October 30, 2026", signatureImage: PNG_DRIVER };
		const rec = recorder();
		const { error } = await rendering(loadRenderer(RENDERER_SRC, rec), "mobile_policy", data);
		if (error) throw error;
		const doc = rec.docs[0];
		const swaps = swapsOf(doc, "Driver signature");
		ok(swaps.length === 1 && swaps[0].getAttribute("src") === PNG_DRIVER, "§4(i) the driver's slot carries the drawn signature");
		eq(imagesIn(doc).length, 1, "§4(i) one <img>");
		const want = POLICY_FIELD_MAPS.mobile_policy(data).text;
		const received = slotsOf(doc, "Received by signature")[0];
		ok(received && received.tagName === "INPUT" && received.value === want["Received by signature"] && received.value !== "",
			"§4(i) the company's line keeps its typed text");
		eq(rec.results[0], { verified: ["Full name", "Driver signature", "Driver date", "Received by signature", "Received by title"], mismatched: [], missed: [] },
			"§4(i) the fill report is as before");
	});

	// ── §5 mutants ───────────────────────────────────────────────────────────
	await part("§5 mutants", async () => {
		const REFUSED_COMPANY_IMAGE = { ...FINAL_MINOR, companySignatureImage: "https://example.com/made-up.png" };
		const MUTANTS = [
			["drop the label check", "if (!Object.prototype.hasOwnProperty.call(labels, label)) {", "if (false) {",
				{ section3: "drops a label the document does not fill" }],
			["drop the per-value check", "const safe = safeSignatureImage(value);", "const safe = value;", { section3: "drops an https URL" }],
			["raise the cap", "const SIGNATURE_IMAGES_MAX = 3;", "const SIGNATURE_IMAGES_MAX = 4;", { section3: "drops a 4th entry" }],
			["drop the plain-object check", "if (proto !== Object.prototype && proto !== null) return out;", "",
				{ section3: "drops a non-plain object even when its own key is a filled label" }],
			["ignore the map in the page", "signatureImagesByLabel && Object.prototype.hasOwnProperty.call(signatureImagesByLabel, label)", "false",
				{ data: FINAL_MINOR, of: "§4(a)", flipped: (doc) => imagesIn(doc).length !== 3 }],
			["skip the check in renderPolicy()", "fields.signatureImagesByLabel = safeSignatureImages(fields.signatureImagesByLabel, fields.text, docKey);", "",
				{ data: REFUSED_COMPANY_IMAGE, of: "§4(c)", flipped: (doc) => imagesIn(doc).some((n) => !String(n.getAttribute("src")).startsWith("data:")) }],
		];
		for (const [name, from, to, expect] of MUTANTS) {
			const found = RENDERER_SRC.split(from).length - 1;
			ok(found === 1, `§5 "${name}": its anchor is in lib/policy-renderer.js exactly once (found ${found})`);
			if (found !== 1) continue;
			const rec = recorder();
			const mutant = loadRenderer(RENDERER_SRC.replace(from, to), rec);
			if (expect.section3) {
				const flipped = section3Cases(mutant).filter(([, fn]) => !holds(fn)).map(([c]) => c);
				ok(flipped.includes(expect.section3), `§5 "${name}" flips §3 "${expect.section3}" (flipped: ${flipped.join("; ") || "none"})`);
			} else {
				const { error } = await rendering(mutant, "passenger_authorization", expect.data);
				ok(!error && expect.flipped(rec.docs[0]), `§5 "${name}" flips ${expect.of} (${error ? error.message : `${imagesIn(rec.docs[0]).length} images`})`);
			}
		}
	});

	console.log(`\n${"=".repeat(64)}`);
	if (failures.length) {
		console.log(`FAILURES (${failures.length}):`);
		for (const f of failures) console.log(`  x ${f}`);
		console.log(`\n${pass} passed, ${failures.length} failed`);
		process.exitCode = 1;
		return;
	}
	console.log(`${pass} assertions passed`);
})();
