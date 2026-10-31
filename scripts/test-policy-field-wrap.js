#!/usr/bin/env node
/**
 * Long values in policy documents (POLICY_FIELD_WRAP_ENABLED): the wrap step
 * (wrapOverflowingInputs()) and the required-label check (assertDocumentFilled())
 * in lib/policy-renderer.js, and the signing failure path in server.js that
 * carries a refused render to the driver and to staff.
 *
 *   §1 the flag: on only for exactly "true", read at each render; the example
 *      settings file lists it off; the replica rules allow it; server.js reads
 *      it nowhere (the renderer does)
 *   §2 flag off: today's render path: one fill evaluate, then the PDF, no span;
 *      the substance policy's signature-and-date slot stays an input, cut short
 *      in the stand-in's painted text, and a required slot too narrow to show
 *      anything still renders; a name too long for its slot in a sentence
 *      stays an input too
 *   §3 flag on, the wrap, on a stand-in page that lays out its inputs (made-up
 *      metrics: 7px a character, a blank's 4px side padding): a value wider
 *      than its box becomes a span with the same text and attributes that
 *      wraps, takes the input's text styles and keeps the input's width and
 *      bottom rule where the template's rules would give a span others; a value
 *      that fits, an empty one, a hidden input and a checkbox are left alone;
 *      an unlabelled input is wrapped too; in running text (text, or an inline
 *      element with text, beside the slot) the span is inline and flows with
 *      the sentence, while a slot on a line of its own keeps the box and a
 *      block slot stays a block; the substance policy's long signature line
 *      prints whole in its box, a name too long for its "I, ____ ," slot flows
 *      inline, and a short one prints as with the flag off
 *   §4 flag on, the check: a required value that still overflows after the
 *      wrap is refused (DOCUMENT_FIELDS_UNFILLED) before any PDF exists, with
 *      the document and the label named and the value in neither the message
 *      nor the log line; a non-required one, an empty one, or a report without
 *      `clipped` (the flag-off shape) is not
 *   §5 the failure path, lifted from server.js onto an in-memory database:
 *      writeSignedArtifact() keeps the labels; the driver sign route answers
 *      503 with a "wait to hear from our team" message (retryable false); signing_error,
 *      the alert row, the staff notice and the log lines name the document and
 *      the label and never the value; any other failure keeps today's "try
 *      again" answer; with room, a long name signs
 *   §6 mutants: each part removed or loosened flips a case above
 *
 * Made-up data only. No browser, network or server: the renderer runs on a
 * stand-in page, the route on an in-memory SQLite database, files in a fresh
 * mkdtemp folder.
 *
 * Run: node scripts/test-policy-field-wrap.js    # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const Module = require("module");

const ROOT = path.join(__dirname, "..");
const RENDERER_PATH = path.join(ROOT, "lib", "policy-renderer.js");
const RENDERER_SRC = fs.readFileSync(RENDERER_PATH, "utf8");
const EXAMPLE_SETTINGS = path.join(ROOT, ".env.example");
const FLAG = "POLICY_FIELD_WRAP_ENABLED";
const SIGN_ROUTE = "/api/onboarding/:userId/documents/:docKey/sign";
const SIGN_HEAD = `app.post("${SIGN_ROUTE}", requireAuth, onboardingSignLimiter, async (req, res) => {`;

// The shell's value never reaches a case.
delete process.env[FLAG];

// Made-up signer data.
const LONG_NAME = "Annabel Quinn Testerson-Made";
const SHORT_NAME = "Al Bo";
const DATE = "October 31, 2026";
const ADDRESS = "4821 Made-Up Industrial Parkway, Suite 1200, Testville, ST 00000";
const SLOT = "Driver signature and date";
const LONG_DATA = { fullName: LONG_NAME, signatureText: LONG_NAME, effectiveDate: DATE };
const SHORT_DATA = { fullName: SHORT_NAME, signatureText: SHORT_NAME, effectiveDate: DATE };
const PREVIEW_DATA = { fullName: LONG_NAME, signatureText: "", effectiveDate: DATE };
// Long enough that the substance policy's "I, ____ ," slot (240px) wraps too.
const VERY_LONG_NAME = "Annabel Quinn Testerson-Made Example";
const VERY_LONG_DATA = { fullName: VERY_LONG_NAME, signatureText: VERY_LONG_NAME, effectiveDate: DATE };
// The date the sign route prints (its own clock, as server.js computes it).
const TODAY = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
// What must never appear in a message or a log line.
const VALUE_TOKENS = [`${LONG_NAME} — ${DATE}`, `${LONG_NAME} — ${TODAY}`, LONG_NAME, "Annabel", "Testerson", DATE, TODAY, "October 31", "2026"];
const leaks = (text) => VALUE_TOKENS.filter((t) => String(text).includes(t));

// ── output ──────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const out = (s) => process.stdout.write(`${s}\n`);
const section = (title) => out(`\n§ ${title}`);
function realCheck(name, cond, detail) {
	if (cond) { passed++; out(`ok    ${name}`); return; }
	failed++;
	out(`FAIL  ${name}${detail === undefined ? "" : `  (${typeof detail === "string" ? detail : JSON.stringify(detail)})`}`);
}

// ── the stand-in page ───────────────────────────────────────────────────────
// Made-up text metrics: every character 7px wide; a .blank pads 4px a side.
const CH = 7;
// Chromium's own width for a text input with no width rule (the note on
// .blank-xl in onboarding-templates/policy/vehicle-lease.html).
const INPUT_DEFAULT_WIDTH = 154;
// The screen column a display:block blank fills.
const CONTAINER_WIDTH = 560;
const INK = "rgb(17, 17, 17)";
const textWidth = (s) => String(s).length * CH;
const px = (v) => (/^-?\d+(\.\d+)?px$/.test(String(v)) ? parseFloat(v) : 0);

// CSS.escape as the CSSOM spec defines it, and its inverse for the selector reader.
function cssEscape(value) {
	const s = String(value);
	let r = "";
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c === 0) { r += "�"; continue; }
		if ((c >= 0x01 && c <= 0x1f) || c === 0x7f || (i === 0 && c >= 0x30 && c <= 0x39) ||
			(i === 1 && c >= 0x30 && c <= 0x39 && s.charCodeAt(0) === 0x2d)) { r += `\\${c.toString(16)} `; continue; }
		if (i === 0 && s.length === 1 && c === 0x2d) { r += `\\${s[i]}`; continue; }
		if (c >= 0x80 || c === 0x2d || c === 0x5f || (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) { r += s[i]; continue; }
		r += `\\${s[i]}`;
	}
	return r;
}
const cssUnescape = (s) => s.replace(/\\(?:([0-9a-fA-F]{1,6})[ \t\n\r\f]?|([\s\S]))/g, (_, hex, ch) => (hex ? String.fromCodePoint(parseInt(hex, 16)) : ch));

// An optional tag, then [attr] or [attr="value"] groups; anything else throws,
// so a new kind of selector cannot quietly match nothing.
function parseSelector(sel) {
	const tag = /^[a-zA-Z]*/.exec(sel)[0];
	const attrs = [];
	let i = tag.length;
	const bad = () => new Error(`stand-in page: unsupported selector ${sel}`);
	while (i < sel.length) {
		if (sel[i] !== "[") throw bad();
		const name = /^[a-zA-Z-]+/.exec(sel.slice(i + 1));
		if (!name) throw bad();
		i += 1 + name[0].length;
		if (sel[i] === "]") { attrs.push([name[0].toLowerCase(), undefined]); i++; continue; }
		if (sel.slice(i, i + 2) !== "=\"") throw bad();
		i += 2;
		let raw = "";
		while (i < sel.length && sel[i] !== "\"") {
			if (sel[i] === "\\") { raw += sel.slice(i, i + 2); i += 2; } else { raw += sel[i]; i++; }
		}
		if (sel.slice(i, i + 2) !== "\"]") throw bad();
		i += 2;
		attrs.push([name[0].toLowerCase(), cssUnescape(raw)]);
	}
	return { tag: tag.toUpperCase(), attrs };
}

// An inline style attribute as an ordered map, and back.
function parseStyle(text) {
	const m = new Map();
	for (const part of String(text || "").split(";")) {
		const at = part.indexOf(":");
		if (at < 0) continue;
		const name = part.slice(0, at).trim().toLowerCase();
		let value = part.slice(at + 1).trim();
		const important = /!\s*important$/i.test(value);
		if (important) value = value.replace(/\s*!\s*important$/i, "");
		if (name) m.set(name, { value, important });
	}
	return m;
}
const serializeStyle = (m) => [...m].map(([k, d]) => `${k}: ${d.value}${d.important ? " !important" : ""};`).join(" ");

function makeNode(doc, tagName, attrs = {}, initialText = "") {
	const attributes = new Map(Object.entries(attrs));
	let value = tagName === "INPUT" ? (attributes.get("value") ?? "") : "";
	let text = initialText;
	const style = {
		setProperty(name, v, priority = "") {
			const m = parseStyle(attributes.get("style"));
			if (v === "" || v == null) m.delete(name);
			else m.set(name, { value: String(v), important: priority === "important" });
			attributes.set("style", serializeStyle(m));
		},
		getPropertyValue(name) { const d = parseStyle(attributes.get("style")).get(name); return d ? d.value : ""; },
		getPropertyPriority(name) { const d = parseStyle(attributes.get("style")).get(name); return d && d.important ? "important" : ""; },
	};
	const node = {
		tagName,
		nodeType: 1,
		// Set for inputs by attachParents(): what the in-page check for running text reads.
		parentElement: null,
		style,
		get type() { return tagName === "INPUT" ? String(attributes.get("type") || "text").toLowerCase() : undefined; },
		getAttribute: (n) => (attributes.has(n) ? attributes.get(n) : null),
		setAttribute: (n, v) => { attributes.set(String(n).toLowerCase(), String(v)); },
		removeAttribute: (n) => { attributes.delete(n); },
		hasAttribute: (n) => attributes.has(n),
		getAttributeNames: () => [...attributes.keys()],
		get value() { return value; },
		set value(v) { value = String(v); },
		get textContent() { return text; },
		set textContent(v) { text = v == null ? "" : String(v); },
		get src() { return attributes.get("src") ?? ""; },
		set src(v) { attributes.set("src", String(v)); },
		get alt() { return attributes.get("alt") ?? ""; },
		set alt(v) { attributes.set("alt", String(v)); },
		// Layout, as Chromium reports it: whole pixels for the two widths, the
		// exact box for the rect.
		get clientWidth() { return Math.round(doc.layout(node).width); },
		get scrollWidth() { const l = doc.layout(node); return Math.round(Math.max(l.width, l.needed)); },
		getBoundingClientRect() { const w = doc.layout(node).width; return { width: w, height: 0, left: 0, right: w, top: 0, bottom: 0 }; },
		replaceWith(other) {
			const at = doc.nodes.indexOf(node);
			if (at < 0) throw new Error("stand-in page: replaceWith on a node not in the document");
			doc.nodes.splice(at, 1, other);
		},
	};
	return node;
}

// The page's elements that carry an aria-label or a data- attribute, and every
// input, in document order. `parent` stands for what a span inherits where the
// slot sits (the substance policy's receipt body is justified).
function stubDocument(html, { parent = {} } = {}) {
	const widths = new Map();
	for (const m of html.matchAll(/\.([a-zA-Z0-9_-]+)\s*\{\s*width:\s*(\d+(?:\.\d+)?)px;?\s*\}/g)) widths.set(m[1], Number(m[2]));
	const doc = {
		nodes: [],
		created: new Set(),
		parent: { textAlign: "justify", textIndent: "0px", letterSpacing: "normal", textTransform: "none", whiteSpace: "normal", ...parent },
		querySelectorAll(sel) {
			const q = parseSelector(sel);
			return doc.nodes.filter((n) => (!q.tag || n.tagName === q.tag) &&
				q.attrs.every(([name, want]) => (want === undefined ? n.hasAttribute(name) : n.getAttribute(name) === want)));
		},
		querySelector(sel) { return doc.querySelectorAll(sel)[0] || null; },
		getElementById: () => null,
		createElement(tag) { const n = makeNode(doc, String(tag).toUpperCase()); doc.created.add(n); return n; },
		// The computed value of one property: the inline style, then the made-up
		// sheet below. A detached element has none, as in a browser.
		computed(node, prop) {
			if (node && node.stub) return prop === "display" ? node.display : "";
			if (!doc.nodes.includes(node)) return "";
			const inline = node.style.getPropertyValue(prop);
			if (inline !== "") return inline;
			const cls = String(node.getAttribute("class") || "").split(/\s+/).filter(Boolean);
			const blank = cls.includes("blank");
			const isInput = node.tagName === "INPUT";
			// A rule written for inputs only (as `td input[type="text"]` is), which a span never matches.
			const inputRule = isInput && node.hasAttribute("data-stub-input-rule");
			switch (prop) {
				case "display": return cls.includes("blank-block") ? "block" : blank || isInput ? "inline-block" : "inline";
				case "padding-left": case "padding-right": return blank ? "4px" : isInput ? "1px" : "0px";
				case "border-bottom-width": return inputRule ? "2px" : blank ? "1px" : isInput ? "2px" : "0px";
				case "border-bottom-style": return inputRule ? "dotted" : blank ? "solid" : isInput ? "inset" : "none";
				case "border-bottom-color": return inputRule ? "rgb(0, 0, 0)" : blank ? INK : isInput ? "rgb(118, 118, 118)" : INK;
				case "vertical-align": return "baseline";
				// The browser's own sheet resets these on an input; a span inherits them.
				case "text-align": return isInput ? "start" : doc.parent.textAlign;
				case "text-indent": return isInput ? "0px" : doc.parent.textIndent;
				case "letter-spacing": return isInput ? "normal" : doc.parent.letterSpacing;
				case "text-transform": return isInput ? "none" : doc.parent.textTransform;
				case "word-spacing": return "0px";
				case "white-space": return isInput ? "pre" : doc.parent.whiteSpace;
				case "overflow-wrap": return "normal";
				case "font-family": return "\"Open Sans\", sans-serif";
				case "font-size": return "14px";
				case "font-weight": return "400";
				case "font-style": return "normal";
				case "line-height": return "22px";
				case "color": return INK;
				default: return "";
			}
		},
		// { width: the border box, needed: the width its text takes }.
		layout(node) {
			if (node.hasAttribute("hidden") || !doc.nodes.includes(node)) return { width: 0, needed: 0 };
			const c = (p) => doc.computed(node, p);
			// An inline span has no box of its own (Chromium reports 0 for both widths): its text flows.
			if (node.tagName === "SPAN" && c("display") === "inline") return { width: 0, needed: 0 };
			const padding = px(c("padding-left")) + px(c("padding-right"));
			const inline = node.style.getPropertyValue("width");
			const cls = String(node.getAttribute("class") || "").split(/\s+/).filter(Boolean);
			const fromClass = cls.map((k) => widths.get(k)).filter((w) => w !== undefined).pop();
			let width;
			if (px(inline) || inline === "0px") width = px(inline);
			else if (c("display") === "block") width = CONTAINER_WIDTH;
			else if (fromClass !== undefined) width = fromClass;
			else if (node.tagName === "INPUT") width = INPUT_DEFAULT_WIDTH;
			else width = Math.min(textWidth(node.textContent) + padding, CONTAINER_WIDTH); // a span with no width rule fits its text
			let needed = 0;
			if (node.tagName === "INPUT") {
				if (node.type === "text") needed = textWidth(node.value) + padding;
			} else if (node.tagName === "SPAN") {
				const ws = c("white-space");
				const words = String(node.textContent).split(/\s+/).filter(Boolean);
				const unit = words.length ? Math.max(...words.map(textWidth)) : 0;
				needed = ws === "nowrap" || ws === "pre"
					? textWidth(node.textContent) + padding
					: (c("overflow-wrap") === "anywhere" ? Math.min(unit, CH) : unit) + padding;
			}
			return { width, needed };
		},
		// What the page prints of a slot: a text input shows what fits its box; a
		// span its whole text unless even wrapped it overflows; others their text.
		visible(node) {
			if (node.hasAttribute("hidden")) return "";
			if (node.tagName === "INPUT") {
				if (node.type !== "text") return "";
				const l = doc.layout(node);
				const room = l.width - px(doc.computed(node, "padding-left")) - px(doc.computed(node, "padding-right"));
				return node.value.slice(0, Math.max(0, Math.floor(room / CH)));
			}
			if (node.tagName === "IMG") return "";
			if (doc.created.has(node)) {
				const l = doc.layout(node);
				return l.needed <= l.width ? node.textContent : "";
			}
			return node.textContent;
		},
		painted() { return doc.nodes.map((n) => doc.visible(n)).join("\n"); },
		slots(label) { return doc.nodes.filter((n) => n.getAttribute("aria-label") === label); },
	};
	const tagRe = /<([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/g;
	let m;
	while ((m = tagRe.exec(html))) {
		const attrs = {};
		for (const a of m[2].matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*"([^"]*)")?/g)) {
			attrs[a[1].toLowerCase()] = (a[2] ?? "").replace(/&quot;/g, "\"").replace(/&amp;/g, "&");
		}
		const tagName = m[1].toUpperCase();
		if (tagName !== "INPUT" && !("aria-label" in attrs) && !Object.keys(attrs).some((k) => k.startsWith("data-"))) continue;
		const after = m.index + m[0].length;
		doc.nodes.push(makeNode(doc, tagName, attrs, tagName === "INPUT" ? "" : html.slice(after, html.indexOf("<", after))));
	}
	attachParents(html, doc.nodes.filter((n) => n.tagName === "INPUT"));
	return doc;
}

// Each input's parent, as the in-page check for running text reads it: its child nodes in order, text
// ({ nodeType: 3, data }) and elements ({ nodeType: 1, display, textContent }), the input itself among them.
// A walk over start tags, end tags and the text between them, enough for the pages here.
const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const INLINE_TAGS = new Set(["a", "abbr", "b", "cite", "code", "em", "i", "label", "mark", "q", "s", "small", "span", "strong", "sub", "sup", "time", "u"]);
const ENTITIES = { nbsp: String.fromCharCode(0xa0), amp: "&", quot: "\"", lt: "<", gt: ">", sect: "§" };
const decodeText = (s) => s.replace(/&([a-z]+);/g, (all, name) => (Object.prototype.hasOwnProperty.call(ENTITIES, name) ? ENTITIES[name] : all));
function attachParents(html, inputs) {
	const frame = (tag) => ({ tag, el: { nodeType: 1, stub: true, display: INLINE_TAGS.has(tag) ? "inline" : "block", childNodes: [], textContent: "" } });
	const stack = [frame("#root")];
	const addText = (raw) => {
		if (!raw) return;
		const data = decodeText(raw);
		stack[stack.length - 1].el.childNodes.push({ nodeType: 3, data });
		for (const f of stack) f.el.textContent += data;
	};
	const tokenRe = /<!--[\s\S]*?-->|<!doctype[^>]*>|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>/gi;
	let at = 0;
	let placed = 0;
	let m;
	while ((m = tokenRe.exec(html))) {
		addText(html.slice(at, m.index));
		at = tokenRe.lastIndex;
		if (!m[2]) continue;
		const tag = m[2].toLowerCase();
		if (m[1]) {
			const open = stack.map((f) => f.tag).lastIndexOf(tag);
			if (open > 0) stack.length = open;
			continue;
		}
		const parent = stack[stack.length - 1].el;
		if (tag === "input") {
			const node = inputs[placed++];
			if (!node) throw new Error("stand-in page: more inputs in the markup than in the document");
			node.parentElement = parent;
			parent.childNodes.push(node);
			continue;
		}
		const f = frame(tag);
		parent.childNodes.push(f.el);
		if (!VOID_TAGS.has(tag)) stack.push(f);
	}
	addText(html.slice(at));
	if (placed !== inputs.length) throw new Error(`stand-in page: ${inputs.length} inputs in the document, ${placed} in the markup`);
}

const newRecord = (transform = null, opts = {}) => ({ transform, opts, docs: [], calls: [], results: [], pdfOptions: [], closed: 0 });

// Puppeteer sends a function's source and a JSON copy of its argument, so
// nothing from the renderer's own scope reaches the page.
function fakePage(html, rec) {
	const doc = stubDocument(html, rec.opts);
	rec.docs.push(doc);
	const computedStyle = (el) => ({ getPropertyValue: (p) => doc.computed(el, p) });
	return {
		async evaluate(fn, arg) {
			rec.calls.push(fn && fn.name ? `evaluate:${fn.name}` : "evaluate");
			const inPage = new Function("document", "CSS", "getComputedStyle", `return (${fn.toString()});`)(doc, { escape: cssEscape }, computedStyle);
			const sent = arg === undefined ? undefined : JSON.parse(JSON.stringify(arg));
			const result = await inPage(sent);
			const back = result === undefined ? undefined : JSON.parse(JSON.stringify(result));
			rec.results.push(back);
			return back;
		},
		async pdf(options) {
			rec.calls.push("pdf");
			rec.pdfOptions.push(options);
			// Over writeSignedArtifact()'s size floor, so a stored copy passes it.
			return new Uint8Array(Buffer.from(`%PDF-1.7\n% made-up stand-in for the browser's output\n${"%".repeat(1200)}\n`));
		},
		async close() { rec.calls.push("close"); rec.closed++; },
	};
}

// lib/policy-renderer.js compiled from `src` at its own path, with ./pdf-browser
// replaced by the stand-in page and puppeteer by nothing: no browser starts.
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

// One render with the flag set to `flag` (undefined: unset) and console.warn
// captured: { pdf, warns, error }.
async function rendering(R, docKey, data, flag) {
	const saved = process.env[FLAG];
	if (flag === undefined) delete process.env[FLAG]; else process.env[FLAG] = flag;
	const warns = [];
	const realWarn = console.warn;
	console.warn = (...a) => warns.push(a.map(String).join(" "));
	try {
		return { pdf: await R.renderPolicy(docKey, data), warns, error: null };
	} catch (error) {
		return { pdf: null, warns, error };
	} finally {
		console.warn = realWarn;
		if (saved === undefined) delete process.env[FLAG]; else process.env[FLAG] = saved;
	}
}

// The substance policy's slots, doctored where a case needs a box too narrow
// for one character. Each edit must apply exactly once.
function edit(html, from, to) {
	const n = html.split(from).length - 1;
	if (n !== 1) throw new Error(`template edit applies ${n} times: ${from}`);
	return html.replace(from, to);
}
const SLOT_TAG = `style="width: 260px;" aria-label="${SLOT}"`;
const NARROW = (html) => edit(html, SLOT_TAG, `style="width: 6px;" aria-label="${SLOT}"`);
const RENAMED = (html) => edit(html, SLOT_TAG, "style=\"width: 260px;\" aria-label=\"Driver signature (made-up rename)\"");
const NARROW_APPROVED = (html) => edit(html, "class=\"blank blank-md\" aria-label=\"Approved by\"", "class=\"blank blank-md\" style=\"width: 6px;\" aria-label=\"Approved by\"");

// A made-up page for the wrap itself: one input per case.
const UNIT_HTML = `<!doctype html><html><head><style>
  .blank-md { width: 240px; }
  .blank-tiny { width: 6px; }
</style></head><body>
<input type="text" class="blank blank-md" aria-label="Fits" value="${SHORT_NAME}">
<input type="text" class="blank blank-md" aria-label="Long" value="${ADDRESS}">
<input type="text" class="blank blank-md" aria-label="Empty" value="">
<input type="text" class="blank" aria-label="Default width" value="${ADDRESS}">
<input type="text" class="blank blank-md" data-stub-input-rule aria-label="Input rule" value="${ADDRESS}">
<input type="text" class="blank blank-block" aria-label="Block" value="${ADDRESS} ${ADDRESS}">
<input type="text" class="blank blank-md" value="${ADDRESS}">
<input type="text" class="blank blank-md" hidden aria-label="Hidden" value="${ADDRESS}">
<input type="checkbox" aria-label="Box" value="on">
<input type="text" class="blank blank-tiny" aria-label="Tiny" value="${SHORT_NAME}">
<input type="text" class="blank blank-md" id="made-up-id" data-row="3" style="margin-left: 2px;" aria-label="Attributes" value="${ADDRESS}">
</body></html>`;
const UNIT_LABELS = ["Fits", "Long", "Empty", "Default width", "Input rule", "Block", "Hidden", "Box", "Tiny", "Attributes"];

// A made-up page for slots in running text: in a sentence, after a label, on a line of their own.
const SENTENCE_HTML = `<!doctype html><html><head><style>
  .blank-md { width: 240px; }
</style></head><body>
<p>Made-up words before, <input type="text" class="blank blank-md" aria-label="In a sentence" value="${ADDRESS}"> , made-up words after.</p>
<p><strong>Made-up label:</strong> <input type="text" class="blank blank-md" aria-label="After a label" value="${ADDRESS}"></p>
<div>
  <input type="text" class="blank blank-md" aria-label="Own line" value="${ADDRESS}">
  <div>Made-up caption under it</div>
</div>
<p>&nbsp; <input type="text" class="blank blank-md" aria-label="Beside a space" value="${ADDRESS}"> &nbsp;</p>
<p>Made-up words, <input type="text" class="blank blank-block" aria-label="Block in a sentence" value="${ADDRESS} ${ADDRESS}"> , more.</p>
</body></html>`;
const SENTENCE_LABELS = ["In a sentence", "After a label", "Own line", "Beside a space", "Block in a sentence"];

async function unitWrap(ctx, opts = {}, html = UNIT_HTML, labels = UNIT_LABELS) {
	const rec = newRecord(null, opts);
	const R = ctx.R(rec);
	const page = fakePage(html, rec);
	const report = await page.evaluate(R.wrapOverflowingInputs, labels);
	return { doc: rec.docs[0], report: report || {} };
}
const one = (doc, label) => doc.slots(label)[0] || null;

// ── §1 the flag ─────────────────────────────────────────────────────────────
async function g1Flag(ctx) {
	const { check } = ctx;
	const R = ctx.R(newRecord());
	check("§1 the renderer exports fieldWrapEnabled() and wrapOverflowingInputs()",
		typeof R.fieldWrapEnabled === "function" && typeof R.wrapOverflowingInputs === "function");
	if (typeof R.fieldWrapEnabled === "function") {
		check("§1 on for exactly \"true\"", R.fieldWrapEnabled({ [FLAG]: "true" }) === true);
		const offs = [undefined, "", "false", "TRUE", "True", "1", "yes", "on", " true", "true ", "0"];
		check("§1 off for unset, blank, false, TRUE, True, 1, yes, on, padded true and 0",
			offs.every((v) => R.fieldWrapEnabled(v === undefined ? {} : { [FLAG]: v }) === false),
			offs.filter((v) => R.fieldWrapEnabled(v === undefined ? {} : { [FLAG]: v }) !== false));
		process.env[FLAG] = "true";
		const onNow = R.fieldWrapEnabled();
		delete process.env[FLAG];
		check("§1 read from the environment at the call, not once at load", onNow === true && R.fieldWrapEnabled() === false);
	}
	const reads = ctx.rendererSrc.split("\n").filter((l) => new RegExp(`env\\.${FLAG}\\b`).test(l));
	check("§1 the renderer reads the flag in one place, as === \"true\"",
		reads.length === 1 && new RegExp(`env\\.${FLAG}\\s*===\\s*"true"`).test(reads[0]), reads.length);
	check("§1 server.js reads no such setting itself (the renderer does)", !new RegExp(`process\\.env\\.${FLAG}`).test(ctx.serverSrc));
	const example = fs.readFileSync(EXAMPLE_SETTINGS, "utf8").split("\n");
	const at = example.findIndex((l) => l === `${FLAG}=false`);
	const block = at < 0 ? "" : example.slice(Math.max(0, at - 20), at).join("\n");
	check("§1 the example settings file lists the flag off, says only exactly \"true\" turns it on",
		at >= 0 && /DEFAULT OFF/.test(block) && /exactly "true"/.test(block));
	const rules = require(path.join(ROOT, "lib", "replica-rules.js"));
	check("§1 the replica rules let a replica task switch it on (it renders locally and sends nothing)",
		Array.isArray(rules.ENABLE_ALLOWED) && rules.ENABLE_ALLOWED.includes(FLAG) && typeof rules.enableRefusal === "function" && rules.enableRefusal(FLAG) === null);
}

// ── §2 flag off ─────────────────────────────────────────────────────────────
async function g2FlagOff(ctx) {
	const { check } = ctx;
	for (const flag of [undefined, "", "false", "TRUE", "1"]) {
		const rec = newRecord();
		const r = await rendering(ctx.R(rec), "substance_policy", LONG_DATA, flag);
		const doc = rec.docs[0];
		const slot = doc ? one(doc, SLOT) : null;
		const tag = flag === undefined ? "unset" : JSON.stringify(flag);
		check(`§2 flag ${tag}: the long substance policy renders`, !r.error && Boolean(r.pdf), r.error && r.error.message);
		check(`§2 flag ${tag}: today's page calls (one fill evaluate, the PDF, close)`,
			JSON.stringify(rec.calls) === JSON.stringify(["evaluate", "pdf", "close"]), rec.calls);
		check(`§2 flag ${tag}: no span is made and the slot stays an input with the whole value`,
			Boolean(doc) && doc.created.size === 0 && Boolean(slot) && slot.tagName === "INPUT" && slot.value === `${LONG_NAME} — ${DATE}`);
		check(`§2 flag ${tag}: the input prints cut short, without the date (today's fault)`,
			Boolean(slot) && !doc.visible(slot).includes(DATE) && doc.visible(slot).startsWith(LONG_NAME));
	}
	const rec = newRecord(NARROW);
	const r = await rendering(ctx.R(rec), "substance_policy", LONG_DATA, undefined);
	check("§2 flag off: a required slot too narrow to show anything still renders (as today)", !r.error && Boolean(r.pdf), r.error && r.error.message);
	check("§2 flag off: the PDF options are today's", JSON.stringify(rec.pdfOptions[0]) === JSON.stringify({
		format: "Letter", printBackground: true, margin: { top: 0, bottom: 0, left: 0, right: 0 }, preferCSSPageSize: true,
	}), rec.pdfOptions[0]);
	const longer = newRecord();
	await rendering(ctx.R(longer), "substance_policy", VERY_LONG_DATA, undefined);
	const ldoc = longer.docs[0];
	const lname = ldoc ? one(ldoc, "Name") : null;
	check("§2 flag off, a name too long for the \"I, ____ ,\" slot: nothing is swapped, so nothing flows inline (the slot stays an input)",
		Boolean(ldoc) && ldoc.created.size === 0 && Boolean(lname) && lname.tagName === "INPUT" && lname.value === VERY_LONG_NAME);
}

// ── §3 flag on: the wrap ────────────────────────────────────────────────────
async function g3Wrap(ctx) {
	const { check } = ctx;
	let unit;
	try { unit = await unitWrap(ctx); } catch (e) { check("§3 the wrap runs on the stand-in page", false, e.message); return; }
	const { doc, report } = unit;
	const fits = one(doc, "Fits");
	check("§3 a value that fits stays an input, untouched", Boolean(fits) && fits.tagName === "INPUT" && fits.value === SHORT_NAME && !fits.hasAttribute("style"));
	const long = one(doc, "Long");
	check("§3 a value wider than its box becomes a span with the whole value",
		Boolean(long) && long.tagName === "SPAN" && long.textContent === ADDRESS);
	check("§3 ...the span keeps the input's class and label and carries no type or value",
		Boolean(long) && long.getAttribute("class") === "blank blank-md" && !long.hasAttribute("type") && !long.hasAttribute("value"));
	check("§3 ...it wraps: white-space normal and overflow-wrap anywhere, both !important",
		Boolean(long) && long.style.getPropertyValue("white-space") === "normal" && long.style.getPropertyPriority("white-space") === "important" &&
		long.style.getPropertyValue("overflow-wrap") === "anywhere" && long.style.getPropertyPriority("overflow-wrap") === "important");
	check("§3 ...it is an inline-block with the input's font",
		Boolean(long) && long.style.getPropertyValue("display") === "inline-block" && long.style.getPropertyValue("font-size") === "14px" &&
		long.style.getPropertyValue("font-family") === "\"Open Sans\", sans-serif" && long.style.getPropertyValue("line-height") === "22px");
	check("§3 ...it takes the input's alignment, not the justified parent's",
		Boolean(long) && long.style.getPropertyValue("text-align") === "start" && doc.computed(long, "text-align") === "start");
	check("§3 ...the template's width and bottom rule size it (nothing pinned where they agree)",
		Boolean(long) && long.clientWidth === 240 && long.style.getPropertyValue("width") === "" && long.style.getPropertyValue("border-bottom-width") === "" &&
		doc.computed(long, "border-bottom-width") === "1px" && doc.computed(long, "border-bottom-style") === "solid");
	check("§3 ...and its text now fits: nothing overflows and the whole value prints",
		Boolean(long) && long.scrollWidth <= long.clientWidth && doc.visible(long) === ADDRESS);
	const deflt = one(doc, "Default width");
	check("§3 an input with no width rule keeps its own width on the span (pinned)",
		Boolean(deflt) && deflt.tagName === "SPAN" && deflt.style.getPropertyValue("width") === `${INPUT_DEFAULT_WIDTH}px` && deflt.clientWidth === INPUT_DEFAULT_WIDTH);
	const rule = one(doc, "Input rule");
	check("§3 a bottom rule written for inputs only is pinned on the span",
		Boolean(rule) && rule.tagName === "SPAN" && rule.style.getPropertyValue("border-bottom-width") === "2px" &&
		rule.style.getPropertyValue("border-bottom-style") === "dotted" && rule.style.getPropertyValue("border-bottom-color") === "rgb(0, 0, 0)");
	const block = one(doc, "Block");
	check("§3 a display:block input becomes a block span", Boolean(block) && block.tagName === "SPAN" && block.style.getPropertyValue("display") === "block");
	const attrs = one(doc, "Attributes");
	check("§3 the span keeps every other attribute (id, data-, its own inline style)",
		Boolean(attrs) && attrs.tagName === "SPAN" && attrs.getAttribute("id") === "made-up-id" && attrs.getAttribute("data-row") === "3" &&
		attrs.style.getPropertyValue("margin-left") === "2px");
	const unlabelled = doc.nodes.filter((n) => !n.hasAttribute("aria-label"));
	check("§3 an unlabelled input (as a cloned vehicle row's) is wrapped too",
		unlabelled.length === 1 && unlabelled[0].tagName === "SPAN" && unlabelled[0].textContent === ADDRESS);
	check("§3 an empty value, a hidden input and a checkbox are left alone",
		["Empty", "Hidden", "Box"].every((l) => { const n = one(doc, l); return n && n.tagName === "INPUT"; }));
	check("§3 the report lists the labels swapped, in page order",
		JSON.stringify(report.wrapped) === JSON.stringify(["Long", "Default width", "Input rule", "Block", "Tiny", "Attributes"]), report.wrapped);
	check("§3 the report lists only the slot that still overflows as clipped", JSON.stringify(report.clipped) === JSON.stringify(["Tiny"]), report.clipped);

	// A slot inside a line that doesn't wrap, centred, upper-cased and indented.
	const odd = await unitWrap(ctx, { parent: { whiteSpace: "nowrap", textAlign: "center", textTransform: "uppercase", textIndent: "24px" } });
	const oddLong = one(odd.doc, "Long");
	check("§3 in a line that doesn't wrap, the span still wraps and fits",
		Boolean(oddLong) && oddLong.tagName === "SPAN" && oddLong.scrollWidth <= oddLong.clientWidth);
	check("§3 ...and keeps the input's alignment, case and indent, not the line's",
		Boolean(oddLong) && odd.doc.computed(oddLong, "text-align") === "start" &&
		odd.doc.computed(oddLong, "text-transform") === "none" && odd.doc.computed(oddLong, "text-indent") === "0px");

	// Slots in running text.
	const sent = await unitWrap(ctx, {}, SENTENCE_HTML, SENTENCE_LABELS);
	const inSentence = one(sent.doc, "In a sentence");
	check("§3 a value too long for its slot in a sentence becomes an inline span: it flows with the sentence, whole, under the blank's rule, with no width and never reported cut off",
		Boolean(inSentence) && inSentence.tagName === "SPAN" && inSentence.style.getPropertyValue("display") === "inline" && inSentence.textContent === ADDRESS &&
		sent.doc.visible(inSentence) === ADDRESS && sent.doc.computed(inSentence, "border-bottom-style") === "solid" &&
		inSentence.style.getPropertyValue("width") === "" && !(sent.report.clipped || []).includes("In a sentence"));
	const afterLabel = one(sent.doc, "After a label");
	check("§3 after a label on its line (an inline element with text beside it), it flows inline too",
		Boolean(afterLabel) && afterLabel.tagName === "SPAN" && afterLabel.style.getPropertyValue("display") === "inline");
	const ownLine = one(sent.doc, "Own line");
	check("§3 on a line of its own (only a block caption beside it), it keeps #681's box: an inline-block of the slot's width",
		Boolean(ownLine) && ownLine.tagName === "SPAN" && ownLine.style.getPropertyValue("display") === "inline-block" && ownLine.clientWidth === 240);
	const besideSpace = one(sent.doc, "Beside a space");
	check("§3 blank text beside a slot (an nbsp) is no sentence: it keeps the box",
		Boolean(besideSpace) && besideSpace.tagName === "SPAN" && besideSpace.style.getPropertyValue("display") === "inline-block");
	const blockInText = one(sent.doc, "Block in a sentence");
	check("§3 a block slot beside text stays a block span (as does a flex item, which the browser makes a block)",
		Boolean(blockInText) && blockInText.tagName === "SPAN" && blockInText.style.getPropertyValue("display") === "block");

	// The substance policy itself.
	const rec = newRecord();
	const r = await rendering(ctx.R(rec), "substance_policy", LONG_DATA, "true");
	const sdoc = rec.docs[0];
	const slot = sdoc ? one(sdoc, SLOT) : null;
	check("§3 flag on: the long substance policy renders", !r.error && Boolean(r.pdf), r.error && r.error.message);
	check("§3 flag on: the wrap runs after the fill and before the PDF",
		JSON.stringify(rec.calls) === JSON.stringify(["evaluate", "evaluate:wrapOverflowingInputs", "pdf", "close"]), rec.calls);
	// The stand-in can't clone table rows, so the order against those steps is read from the source.
	const src = ctx.rendererSrc;
	const wrapAt = src.indexOf("await page.evaluate(wrapOverflowingInputs");
	check("§3 the wrap step comes after the table, receipt and vehicle-row steps (it sees their inputs) and before page.pdf()",
		wrapAt > src.indexOf("}, tableFills);") && wrapAt > src.indexOf("}, fields.receiptPages);") && wrapAt > src.indexOf("}, fields.vehicles);") &&
		wrapAt < src.indexOf("const pdf = await page.pdf("));
	check("§3 flag on: the signature-and-date slot is a span with the whole value, the date included",
		Boolean(slot) && slot.tagName === "SPAN" && slot.textContent === `${LONG_NAME} — ${DATE}` && sdoc.visible(slot).includes(DATE));
	check("§3 flag on: the span keeps the template's 260px box", Boolean(slot) && slot.style.getPropertyValue("width") === "260px" && slot.clientWidth === 260);
	check("§3 flag on: the slots that fit stay inputs", Boolean(sdoc) && ["Driver/Associate name", "Name"].every((l) => { const n = one(sdoc, l); return n && n.tagName === "INPUT"; }));
	check("§3 flag on: nothing is logged for a value that wraps and fits", r.warns.length === 0, r.warns.length);
	const vrec = newRecord();
	const vr = await rendering(ctx.R(vrec), "substance_policy", VERY_LONG_DATA, "true");
	const vdoc = vrec.docs[0];
	const vname = vdoc ? one(vdoc, "Name") : null;
	const vsig = vdoc ? one(vdoc, SLOT) : null;
	check("§3 flag on, a name too long for the \"I, ____ ,\" slot: it flows inline with its sentence, the whole name printed, with no width",
		!vr.error && Boolean(vname) && vname.tagName === "SPAN" && vname.style.getPropertyValue("display") === "inline" &&
		vname.textContent === VERY_LONG_NAME && vdoc.visible(vname) === VERY_LONG_NAME && vname.style.getPropertyValue("width") === "",
		vr.error ? vr.error.message : undefined);
	check("§3 ...while the signature-and-date slot, on a line of its own, keeps #681's box: an inline-block of the template's 260px",
		Boolean(vsig) && vsig.tagName === "SPAN" && vsig.style.getPropertyValue("display") === "inline-block" && vsig.clientWidth === 260 &&
		vdoc.visible(vsig).includes(DATE));

	const offRec = newRecord();
	await rendering(ctx.R(offRec), "substance_policy", SHORT_DATA, undefined);
	const onRec = newRecord();
	const onShort = await rendering(ctx.R(onRec), "substance_policy", SHORT_DATA, "true");
	check("§3 flag on, a short name: it renders, nothing is swapped", !onShort.error && Boolean(onRec.docs[0]) && onRec.docs[0].created.size === 0);
	check("§3 flag on, a short name: the page prints exactly as with the flag off",
		Boolean(onRec.docs[0]) && Boolean(offRec.docs[0]) && onRec.docs[0].painted() === offRec.docs[0].painted());
}

// ── §4 flag on: the check ───────────────────────────────────────────────────
async function g4Check(ctx) {
	const { check } = ctx;
	const R = ctx.R(newRecord());
	const fields = { text: { "Made-up name": LONG_NAME, "Made-up note": ADDRESS }, requiredText: ["Made-up name"] };
	const verified = { verified: ["Made-up name", "Made-up note"] };
	const attempt = (report, f = fields) => {
		const warns = [];
		const realWarn = console.warn;
		console.warn = (...a) => warns.push(a.map(String).join(" "));
		try { R.assertDocumentFilled("made_up_doc", f, report); return { error: null, warns }; }
		catch (error) { return { error, warns }; }
		finally { console.warn = realWarn; }
	};
	const cut = attempt({ ...verified, clipped: ["Made-up name"] });
	check("§4 a required label reported clipped is refused (DOCUMENT_FIELDS_UNFILLED)", Boolean(cut.error) && cut.error.code === "DOCUMENT_FIELDS_UNFILLED", cut.error && cut.error.message);
	check("§4 ...the labels ride on the error", Boolean(cut.error) && JSON.stringify(cut.error.clippedLabels) === JSON.stringify(["Made-up name"]));
	check("§4 ...the message names the document and the label, says trying again won't help, and carries no value",
		Boolean(cut.error) && cut.error.message.includes("\"made_up_doc\"") && cut.error.message.includes("\"Made-up name\"") &&
		/Trying again will not help/.test(cut.error.message) && !cut.error.message.includes(LONG_NAME) && !cut.error.message.includes("Annabel"));
	check("§4 ...one log line, naming the document and the label, with no value",
		cut.warns.length === 1 && cut.warns[0].includes("made_up_doc") && cut.warns[0].includes("Made-up name") && leaks(cut.warns[0]).length === 0, cut.warns);
	check("§4 a report without `clipped` (the flag-off shape) passes", !attempt(verified).error);
	check("§4 a clipped label that isn't required passes", !attempt({ ...verified, clipped: ["Made-up note"] }).error);
	const empty = { text: { "Made-up name": "", "Made-up note": ADDRESS }, requiredText: ["Made-up name"] };
	check("§4 a clipped required label with an empty value (a preview) passes", !attempt({ verified: ["Made-up note"], clipped: ["Made-up name"] }, empty).error);
	const two = attempt({ verified: ["A", "B"], clipped: ["A", "B"] }, { text: { A: "x".repeat(40), B: "y".repeat(40) }, requiredText: ["A", "B"] });
	check("§4 two clipped required labels are both named (plural wording)",
		Boolean(two.error) && two.error.message.includes("fields \"A\", \"B\" do not fit their space") && JSON.stringify(two.error.clippedLabels) === JSON.stringify(["A", "B"]));

	// The substance policy with its signature-and-date box too narrow for one character.
	const rec = newRecord(NARROW);
	const r = await rendering(ctx.R(rec), "substance_policy", LONG_DATA, "true");
	check("§4 flag on, a box too narrow even wrapped: the render is refused (DOCUMENT_FIELDS_UNFILLED)",
		Boolean(r.error) && r.error.code === "DOCUMENT_FIELDS_UNFILLED", r.error ? r.error.message : "rendered");
	check("§4 ...naming the document and the label, with no value in the message",
		Boolean(r.error) && r.error.message.includes("substance_policy") && r.error.message.includes(SLOT) && leaks(r.error.message).length === 0,
		r.error && leaks(r.error.message));
	check("§4 ...and in one log line naming both, with no value",
		r.warns.length === 1 && r.warns[0].includes("substance_policy") && r.warns[0].includes(SLOT) && leaks(r.warns[0]).length === 0, r.warns.length);
	check("§4 ...before any PDF exists, and the page is closed", !rec.calls.includes("pdf") && rec.closed === 1, rec.calls);
	const preview = await rendering(ctx.R(newRecord(NARROW)), "substance_policy", PREVIEW_DATA, "true");
	check("§4 flag on, the same box in a preview (no signature yet): it renders", !preview.error, preview.error && preview.error.message);
	const approved = await rendering(ctx.R(newRecord(NARROW_APPROVED)), "substance_policy", LONG_DATA, "true");
	check("§4 flag on, a non-required slot too narrow: it renders", !approved.error, approved.error && approved.error.message);
}

// ── §5 the failure path in server.js ────────────────────────────────────────
function liftFunction(src, name) {
	const needles = [`\nfunction ${name}(`, `\nasync function ${name}(`];
	const hits = needles.reduce((n, x) => n + (src.split(x).length - 1), 0);
	if (hits !== 1) throw new Error(`expected exactly 1 definition of ${name}() in server.js, found ${hits}`);
	const a = src.indexOf(needles.find((x) => src.includes(x))) + 1;
	return src.slice(a, src.indexOf("\n}\n", a) + 2);
}
function liftRoute(src, head) {
	const needle = `\n${head}`;
	const hits = src.split(needle).length - 1;
	if (hits !== 1) throw new Error(`expected exactly 1 registration ${JSON.stringify(head)}, found ${hits}`);
	const a = src.indexOf(needle) + 1;
	return src.slice(a, src.indexOf("\n});\n", a) + "\n});".length);
}
function liftConst(src, head, close) {
	const needle = `\n${head}`;
	if (src.split(needle).length - 1 !== 1) throw new Error(`expected exactly 1 statement starting ${JSON.stringify(head)}`);
	const a = src.indexOf(needle) + 1;
	return src.slice(a, src.indexOf(close, a) + close.length);
}
function constNumber(src, name) {
	const m = new RegExp(`\\nconst ${name} = (\\d+);`).exec(src);
	if (!m) throw new Error(`no const ${name} in server.js`);
	return Number(m[1]);
}
function tableDdl(src, table) {
	const m = src.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\t\\)`));
	if (!m) throw new Error(`no CREATE TABLE ${table} in server.js`);
	return `CREATE TABLE ${table} (${m[1]}\n)`;
}
function evidenceColumns(src) {
	const m = /for \(const t of \["onboarding_documents", "investor_onboarding_documents"\]\) \{\n\tfor \(const col of \[([\s\S]*?)\]\) \{/.exec(src);
	if (!m) throw new Error("no signing-evidence column list in server.js");
	return [...m[1].matchAll(/"([a-z0-9_]+ [^"]*)"/g)].map((x) => x[1]);
}

let Database = null;
try { Database = require("better-sqlite3"); } catch { /* reported in §5 */ }
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "policy-field-wrap-"));
process.on("exit", () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });
const DOC_NAME = "Substance Policy and Procedure";

// The driver sign route and the failure path it calls, lifted from `src` and
// run against `R`'s renderPolicy on a made-up driver.
function signHarness(src, R, dataDir) {
	const db = new Database(":memory:");
	db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, driver_name TEXT DEFAULT '')");
	db.exec("CREATE TABLE job_applications (id INTEGER PRIMARY KEY, full_name TEXT DEFAULT '', address TEXT DEFAULT '', ssn TEXT DEFAULT '')");
	db.exec("CREATE TABLE driver_onboarding (id INTEGER PRIMARY KEY, user_id INTEGER, application_id INTEGER)");
	db.exec(tableDdl(src, "onboarding_documents"));
	for (const col of ["signed_pdf_url TEXT DEFAULT ''", "signing_error TEXT DEFAULT ''", "signing_failed_at TEXT DEFAULT ''", ...evidenceColumns(src)]) {
		db.exec(`ALTER TABLE onboarding_documents ADD COLUMN ${col}`);
	}
	db.exec(tableDdl(src, "onboarding_doc_alerts"));
	db.exec(tableDdl(src, "dispatch_notifications"));
	db.prepare("INSERT INTO users (id, username, driver_name) VALUES (7, 'made-up-driver', ?)").run(LONG_NAME);
	db.prepare("INSERT INTO job_applications (id, full_name, address) VALUES (70, ?, ?)").run(LONG_NAME, ADDRESS);
	db.prepare("INSERT INTO driver_onboarding (user_id, application_id) VALUES (7, 70)").run();
	db.prepare("INSERT INTO onboarding_documents (user_id, doc_key, doc_name) VALUES (7, 'substance_policy', ?)").run(DOC_NAME);
	const calls = { notices: [], errors: [] };
	const handlers = {};
	const noop = (req, res, next) => next && next();
	const env = {
		app: { post: (p, ...h) => { handlers[p] = h[h.length - 1]; } },
		db, fs, path, crypto,
		DATA_DIR: dataDir,
		requireAuth: noop,
		onboardingSignLimiter: noop,
		imageLimits: require(path.join(ROOT, "lib", "image-size.js")),
		readTransmittedConsent: () => ({ agreed: 1, text: "Made-up consent wording." }),
		signerNetworkEvidence: () => ({ ip: "127.0.0.1", ipSource: "socket", userAgent: "made-up agent" }),
		renderPolicy: R.renderPolicy,
		fillW9Form: async () => null,
		EVIDENCE_DATE_TZ: "UTC",
		SIGNING_EVIDENCE_VERSION: constNumber(src, "SIGNING_EVIDENCE_VERSION"),
		SIGNED_ARTIFACT_MIN_BYTES: constNumber(src, "SIGNED_ARTIFACT_MIN_BYTES"),
		checkAndCompleteOnboarding: async () => ({ status: "documents_pending" }),
		emitDispatchNotice: (n) => { calls.notices.push(n); },
		console: { error: (...a) => calls.errors.push(a.map(String).join(" ")), warn() {}, log() {} },
	};
	const body = [
		liftConst(src, "const insertDispatchNotification = db.prepare(", "\n);"),
		...["writeSignedArtifact", "alertOnboardingDocFailure", "resolveOnboardingDocAlert", "sha256File"].map((n) => liftFunction(src, n)),
		liftRoute(src, SIGN_HEAD),
	].join("\n");
	const names = Object.keys(env);
	new Function(...names, `"use strict";\n${body}`)(...names.map((k) => env[k]));
	return { db, calls, handler: handlers[SIGN_ROUTE] };
}

async function sign(h, flag) {
	const result = { status: 200, body: undefined };
	const res = {
		status(c) { result.status = c; return res; },
		json(b) { result.body = JSON.parse(JSON.stringify(b)); return res; },
	};
	const req = {
		params: { userId: "7", docKey: "substance_policy" },
		body: { signatureText: LONG_NAME, consent: { agreed: true } },
		session: { user: { id: 7 } },
	};
	const saved = process.env[FLAG];
	if (flag === undefined) delete process.env[FLAG]; else process.env[FLAG] = flag;
	const warns = [];
	const realWarn = console.warn;
	console.warn = (...a) => warns.push(a.map(String).join(" "));
	try { await h.handler(req, res); } finally {
		console.warn = realWarn;
		if (saved === undefined) delete process.env[FLAG]; else process.env[FLAG] = saved;
	}
	return { ...result, warns };
}

async function g5Server(ctx) {
	const { check } = ctx;
	if (!Database) { check("§5 better-sqlite3 loads (run npm ci under the .nvmrc Node)", false); return; }
	let n = 0;
	const dir = () => fs.mkdtempSync(path.join(TMP, `sign-${++n}-`));

	// writeSignedArtifact() on its own.
	try {
		const wsa = new Function("fs", "crypto", "SIGNED_ARTIFACT_MIN_BYTES", "sha256File",
			`"use strict";\n${liftFunction(ctx.serverSrc, "writeSignedArtifact")}\nreturn writeSignedArtifact;`)(fs, crypto, 1000, () => "");
		const refusal = Object.assign(new Error("made-up refusal"), { code: "DOCUMENT_FIELDS_UNFILLED", clippedLabels: [SLOT] });
		let thrown = null;
		try { await wsa({ render: async () => { throw refusal; }, signedPath: path.join(dir(), "x.pdf"), publicUrl: "/x", label: DOC_NAME }); } catch (e) { thrown = e; }
		check("§5 writeSignedArtifact() keeps the code and the clipped labels of a refused render",
			Boolean(thrown) && thrown.code === "DOCUMENT_FIELDS_UNFILLED" && JSON.stringify(thrown.clippedLabels) === JSON.stringify([SLOT]) &&
			thrown.message === `${DOC_NAME}: made-up refusal`);
		let other = null;
		try { await wsa({ render: async () => { throw Object.assign(new Error("made-up"), { code: "DOCUMENT_FIELDS_UNFILLED" }); }, signedPath: path.join(dir(), "y.pdf"), publicUrl: "/y", label: DOC_NAME }); } catch (e) { other = e; }
		check("§5 ...and adds none to a refusal without them", Boolean(other) && other.clippedLabels === undefined);
	} catch (e) {
		check("§5 writeSignedArtifact() lifts from server.js", false, e.message);
	}

	// The driver signs; the box is too narrow even wrapped.
	let h;
	try { h = signHarness(ctx.serverSrc, ctx.R(newRecord(NARROW)), dir()); } catch (e) { check("§5 the sign route lifts from server.js", false, e.message); return; }
	const r = await sign(h, "true");
	check("§5 a cut-off refusal answers 503 DOCUMENT_FIELDS_UNFILLED, not retryable",
		r.status === 503 && r.body && r.body.code === "DOCUMENT_FIELDS_UNFILLED" && r.body.retryable === false, r.body);
	check("§5 ...the driver is told staff have it and to wait before signing again, with no value",
		Boolean(r.body) && /Our team has been told; please wait to hear from them before signing it again\./.test(r.body.error || "") &&
		!/try again in a moment/.test(r.body.error || "") && leaks(JSON.stringify(r.body)).length === 0);
	const row = h.db.prepare("SELECT signed, signed_pdf_url, signing_error, signing_failed_at, signature_text FROM onboarding_documents WHERE user_id = 7").get();
	check("§5 ...the document stays unsigned with no file, the signature kept",
		row.signed === 0 && row.signed_pdf_url === "" && row.signature_text === LONG_NAME && row.signing_failed_at !== "");
	check("§5 ...signing_error (the staff screen's \"Why it failed\") names the document and the label and says trying again won't help",
		row.signing_error.startsWith(`${DOC_NAME}: "substance_policy" was not produced`) && row.signing_error.includes(`"${SLOT}"`) &&
		/Trying again will not help until the template gives it more room\./.test(row.signing_error), row.signing_error);
	check("§5 ...signing_error carries no value", leaks(row.signing_error).length === 0, leaks(row.signing_error));
	const alert = h.db.prepare("SELECT doc_key, doc_name, reason, resolved_at FROM onboarding_doc_alerts").all();
	check("§5 ...one open alert row, its reason the same text",
		alert.length === 1 && alert[0].doc_key === "substance_policy" && alert[0].reason === row.signing_error && alert[0].resolved_at === null, alert.length);
	const notes = h.db.prepare("SELECT type, title, body FROM dispatch_notifications").all();
	check("§5 ...one staff notice naming the document and the label, with no value",
		notes.length === 1 && notes[0].type === "onboarding-doc-failed" && notes[0].title.includes(DOC_NAME) && notes[0].body.includes(SLOT) &&
		leaks(notes[0].title + notes[0].body).length === 0, notes.length);
	check("§5 ...the live notice carries no value", h.calls.notices.length === 1 && leaks(JSON.stringify(h.calls.notices)).length === 0);
	const actionLines = h.calls.errors.filter((l) => l.startsWith("[onboarding] ACTION NEEDED"));
	check("§5 ...the server's log line names the document and the label, with no value",
		actionLines.length === 1 && actionLines[0].includes("substance_policy") && actionLines[0].includes(SLOT) && leaks(actionLines[0]).length === 0, h.calls.errors.length);
	check("§5 ...the renderer's log line names both, with no value",
		r.warns.length === 1 && r.warns[0].includes("substance_policy") && r.warns[0].includes(SLOT) && leaks(r.warns[0]).length === 0, r.warns.length);

	// Any other failure keeps today's answer.
	const h2 = signHarness(ctx.serverSrc, ctx.R(newRecord(RENAMED)), dir());
	const r2 = await sign(h2, "true");
	check("§5 a missing label keeps today's answer: 503, \"try again in a moment\", retryable",
		r2.status === 503 && r2.body && r2.body.retryable === true && /please try again in a moment/.test(r2.body.error || ""), r2.body);

	// With room, a long name signs and its PDF holds the date.
	const rec3 = newRecord();
	const h3 = signHarness(ctx.serverSrc, ctx.R(rec3), dir());
	const r3 = await sign(h3, "true");
	const signed = h3.db.prepare("SELECT signed, signed_pdf_url, signing_error FROM onboarding_documents WHERE user_id = 7").get();
	const slot = rec3.docs[0] ? one(rec3.docs[0], SLOT) : null;
	check("§5 flag on, with room: the long name signs (signed, stored, no error)",
		r3.status === 200 && r3.body && r3.body.success === true && signed.signed === 1 && signed.signed_pdf_url !== "" && signed.signing_error === "", r3.body);
	check("§5 ...and the stored copy's slot prints the date", Boolean(slot) && rec3.docs[0].visible(slot).includes(TODAY));
}

// ── §6 mutants ──────────────────────────────────────────────────────────────
const GROUPS = [g1Flag, g2FlagOff, g3Wrap, g4Check, g5Server];
// The wrap step's block as the source has it, for the mutant that moves it.
const WRAP_STEP = (() => {
	const a = RENDERER_SRC.indexOf("\t\t// --- 6. Wrap a value too long for its input");
	const b = RENDERER_SRC.indexOf("\t\tconst pdf = await page.pdf(");
	return a >= 0 && b > a ? RENDERER_SRC.slice(a, b) : "\u0000no wrap step in this renderer\u0000";
})();
const MUTANTS = [
	{ name: "no swap: the span never replaces the input", renderer: [["\t\tinput.replaceWith(span);\n", ""]] },
	{ name: "swap ignoring overflow: every filled text input becomes a span", renderer: [["isTextInput(el) && el.value !== \"\" && overflows(el)", "isTextInput(el) && el.value !== \"\""]] },
	{ name: "the check reads the value only: clipped labels are ignored", renderer: [["isAsked(text[label]) && clipped.has(label)", "isAsked(text[label]) && false"]] },
	{ name: "the page reports nothing clipped", renderer: [["{ clipped.push(label); break; }", "{ break; }"]] },
	{ name: "the flag ignored: always on", renderer: [[`return env.${FLAG} === "true";`, "return true;"]] },
	{ name: "the flag ignored: always off", renderer: [[`return env.${FLAG} === "true";`, "return false;"]] },
	{ name: "the flag loosened: any case of true", renderer: [[`return env.${FLAG} === "true";`, `return String(env.${FLAG} || "").toLowerCase() === "true";`]] },
	{ name: "the value leaks into the refusal message", renderer: [["`\"${docKey}\" was not produced: its required field", "`\"${docKey}\" was not produced (${cut.map((label) => text[label]).join(\", \")}): its required field"]] },
	{ name: "the value leaks into the log line", renderer: [["still cut off after wrapping`", "still cut off after wrapping: ${cut.map((label) => text[label]).join(\", \")}`"]] },
	{ name: "a non-required clipped label is refused too", renderer: [["const cut = required.filter(", "const cut = Object.keys(text).filter("]] },
	{ name: "the input's width is not kept", renderer: [["span.style.setProperty(\"width\", `${width}px`);", "void width;"]] },
	{ name: "the input's bottom rule is not kept", renderer: [["if (now.getPropertyValue(p) !== was[p]) span.style.setProperty(p, was[p]);", "void now;"]] },
	{ name: "the input's text styles are not copied", renderer: [["for (const p of TEXT_STYLES) span.style.setProperty(p, was[p]);", ""]] },
	{ name: "the span does not wrap", renderer: [["span.style.setProperty(\"white-space\", \"normal\", \"important\");", ""]] },
	{ name: "a slot in text keeps the wrapping box (nothing flows inline)", renderer: [["const inText = new Set(long.filter(sitsInText));", "const inText = new Set();"]] },
	{ name: "every slot flows inline, those on a line of their own too", renderer: [["const inText = new Set(long.filter(sitsInText));", "const inText = new Set(long);"]] },
	{ name: "blank text (an nbsp) beside a slot counts as a sentence", renderer: [["n.data.trim() !== \"\"", "n.data !== \"\""]] },
	{ name: "a block element beside a slot counts as a sentence", renderer: [["/^inline/.test(getComputedStyle(n).getPropertyValue(\"display\"))", "true"]] },
	{ name: "an inline element (a label) beside a slot doesn't count", renderer: [["n.nodeType === 1 && /^inline/", "n.nodeType === -1 && /^inline/"]] },
	{ name: "a block (or flex) slot beside text flows inline too", renderer: [["const inline = was.display !== \"block\" && inText.has(input);", "const inline = inText.has(input);"]] },
	{ name: "an inline span gets the input's width pinned too", renderer: [["if (!inline && Math.abs(", "if (Math.abs("]] },
	{ name: "only labelled inputs are wrapped", renderer: [["document.querySelectorAll(\"input\")", "document.querySelectorAll(\"input[aria-label]\")"]] },
	{ name: "the wrap step moved ahead of the table and vehicle-row steps", renderer: [[WRAP_STEP, ""], ["\t\t// --- 5a. Clone table rows", `${WRAP_STEP}\t\t// --- 5a. Clone table rows`]] },
	{ name: "writeSignedArtifact() drops the clipped labels", server: [["\t\tif (Array.isArray(err.clippedLabels)) e.clippedLabels = err.clippedLabels;\n", ""]] },
	{ name: "the sign route ignores a cut-off refusal", server: [["const cutOff = Array.isArray(genErr.clippedLabels) && genErr.clippedLabels.length > 0;", "const cutOff = false;"]] },
	{ name: "the sign route calls every failure cut off", server: [["const cutOff = Array.isArray(genErr.clippedLabels) && genErr.clippedLabels.length > 0;", "const cutOff = true;"]] },
];

function applyEdits(src, edits) {
	let s = src;
	for (const [from, to] of edits) {
		const n = s.split(from).length - 1;
		if (n !== 1) return { src: null, why: `edit applies ${n} times: ${from.slice(0, 60)}` };
		s = s.replace(from, () => to);
	}
	return { src: s, why: null };
}

function contextFor(rendererSrc, serverSrc, check) {
	return { rendererSrc, serverSrc, check, R: (rec) => loadRenderer(rendererSrc, rec) };
}

async function runGroups(ctx, groups) {
	for (const g of groups) {
		try { await g(ctx); } catch (e) { ctx.check(`${g.name} ran to the end`, false, e.message); }
	}
}

async function g6Mutants(rendererSrc, serverSrc) {
	for (const m of MUTANTS) {
		const r = applyEdits(rendererSrc, m.renderer || []);
		const s = applyEdits(serverSrc, m.server || []);
		if (!r.src || !s.src) { realCheck(`§6 mutant applies: ${m.name}`, false, r.why || s.why); continue; }
		let misses = 0;
		const quiet = (name, cond) => { if (!cond) misses++; };
		await runGroups(contextFor(r.src, s.src, quiet), GROUPS);
		realCheck(`§6 mutant caught: ${m.name}`, misses > 0, `${misses} cases flipped`);
	}
}

(async () => {
	const SERVER_SRC = require("./lib/server-source").serverSource();
	const real = contextFor(RENDERER_SRC, SERVER_SRC, realCheck);
	section("1. the flag"); await runGroups(real, [g1Flag]);
	section("2. flag off: today's render path"); await runGroups(real, [g2FlagOff]);
	section("3. flag on: the wrap"); await runGroups(real, [g3Wrap]);
	section("4. flag on: the required-label check"); await runGroups(real, [g4Check]);
	section("5. the failure path in server.js"); await runGroups(real, [g5Server]);
	section("6. mutants"); await g6Mutants(RENDERER_SRC, SERVER_SRC);
	out(`\n${passed} passed, ${failed} failed`);
	process.exit(failed ? 1 : 0);
})().catch((e) => {
	out(`FAIL  the runner stopped: ${e && e.stack ? e.stack : e}`);
	process.exit(1);
});
