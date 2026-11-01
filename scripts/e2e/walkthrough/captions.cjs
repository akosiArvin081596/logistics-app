// Captions for the driver app walkthrough: storyboard `say` text -> cues -> WebVTT, and the
// storyboard lint. Pure (no fs, network or clock), so the recorder, its --dry and
// --captions-only modes and scripts/test-driver-walkthrough-media.js all share one copy.
"use strict";

// Paced for drivers in their 50s and 60s (docs/driver-video/README.md, "Audience").
const PACE_WPS = 2.35;
const CUE_FLOOR_MS = 2200;
const LINE_MAX = 42;
const LINES_MAX = 2;
const SAY_MAX_CHARS = 300;
// A breath after each beat's last caption, before the next action starts.
const TAIL_MS = 700;
// Under the app header, clear of the tab bar and the bottom action buttons.
const CUE_SETTINGS = "line:12% align:center size:92%";

const wordCount = (text) => (String(text).match(/\S+/g) || []).length;

// Greedy wrap at spaces. null when one word alone is longer than a line.
function wrap(text, max = LINE_MAX) {
	const out = [];
	let line = "";
	for (const w of String(text).trim().split(/\s+/)) {
		if (w.length > max) return null;
		if (!line) line = w;
		else if (line.length + 1 + w.length <= max) line += " " + w;
		else { out.push(line); line = w; }
	}
	if (line) out.push(line);
	return out;
}

// One cue's lines: one line when it fits; else the break that leaves both lines in bounds,
// after punctuation when there is one, otherwise the most even split, top line not shorter.
function layoutCue(text) {
	const t = String(text).trim().replace(/\s+/g, " ");
	if (t.length <= LINE_MAX) return [t];
	const words = t.split(" ");
	let best = null;
	for (let i = 1; i < words.length; i++) {
		const a = words.slice(0, i).join(" ");
		const b = words.slice(i).join(" ");
		if (a.length > LINE_MAX || b.length > LINE_MAX) continue;
		const score = (/[.,:;?!]$/.test(a) ? 0 : 1000) + Math.abs(a.length - b.length) + (a.length < b.length ? 50 : 0);
		if (!best || score < best.score) best = { score, lines: [a, b] };
	}
	return best ? best.lines : null;
}

const fits = (text) => {
	const lines = layoutCue(text);
	return !!lines && lines.length <= LINES_MAX;
};

// A long phrase cut into pieces that each fit one cue (word boundaries only).
function chunkPhrase(phrase) {
	const lines = wrap(phrase);
	if (!lines) return null;
	const out = [];
	for (let i = 0; i < lines.length; i += LINES_MAX) out.push(lines.slice(i, i + LINES_MAX).join(" "));
	return out;
}

// `say` -> cue texts: sentences first, commas next, words last; then neighbours merged
// while the merged text still fits one cue.
function splitCues(say) {
	const text = String(say || "").trim().replace(/\s+/g, " ");
	if (!text) return [];
	const pieces = [];
	for (const sentence of text.split(/(?<=[.?!:])\s+/)) {
		if (fits(sentence)) { pieces.push(sentence); continue; }
		for (const part of sentence.split(/(?<=,)\s+/)) {
			if (fits(part)) { pieces.push(part); continue; }
			const chunks = chunkPhrase(part);
			if (!chunks) throw new Error(`a word in "${part}" is longer than ${LINE_MAX} characters`);
			pieces.push(...chunks);
		}
	}
	const cues = [];
	for (const p of pieces) {
		const last = cues[cues.length - 1];
		if (last !== undefined && fits(`${last} ${p}`)) cues[cues.length - 1] = `${last} ${p}`;
		else cues.push(p);
	}
	return cues;
}

const cueFloorMs = (text) => Math.max(CUE_FLOOR_MS, Math.ceil((wordCount(text) / PACE_WPS) * 1000));

// What a beat needs on screen: its cues, each with its floor, and the shortest beat that
// holds them all at the pace and the floor.
function beatPlan(beat) {
	const cues = splitCues(beat.say).map((text) => ({ text, lines: layoutCue(text), words: wordCount(text), floorMs: cueFloorMs(text) }));
	const captionMs = cues.length ? cues.reduce((s, c) => s + c.floorMs, 0) + TAIL_MS : 0;
	return { cues, minMs: Math.max(beat.holdMs || 0, captionMs, cues.length ? 0 : 1500) };
}

// The beat's cues laid over [startMs, endMs]: each gets its floor, and the time left is
// shared by word count, so no cue runs faster than the pace or shorter than the floor.
function timeBeatCues(startMs, endMs, beat) {
	const { cues } = beatPlan(beat);
	if (!cues.length) return [];
	const span = endMs - startMs;
	const floors = cues.reduce((s, c) => s + c.floorMs, 0);
	if (span < floors) {
		throw new Error(`beat "${beat.id}" lasted ${span} ms but its captions need ${floors} ms: re-record that chapter (--only)`);
	}
	const words = cues.reduce((s, c) => s + c.words, 0) || 1;
	const extra = span - floors;
	const out = [];
	let t = startMs;
	cues.forEach((c, i) => {
		const end = i === cues.length - 1 ? endMs : Math.round(t + c.floorMs + (extra * c.words) / words);
		out.push({ startMs: Math.round(t), endMs: end, lines: c.lines, text: c.text });
		t = end;
	});
	return out;
}

// Every cue of the video, from timeline.json (measured beat times, per chapter) and the
// storyboard's text. Chapters play in storyboard order, one after another.
function buildCues(timeline, chapters) {
	const recorded = new Map((timeline && timeline.chapters || []).map((c) => [c.id, c]));
	const cues = [];
	let offset = 0;
	for (const ch of chapters) {
		const rec = recorded.get(ch.id);
		if (!rec) throw new Error(`chapter ${ch.n} (${ch.id}) is not in timeline.json: record it first`);
		const byId = new Map(ch.beats.map((b) => [b.id, b]));
		for (const b of rec.beats) {
			const beat = byId.get(b.id);
			if (!beat) throw new Error(`timeline.json has beat "${b.id}" in chapter ${ch.id}, which the storyboard no longer has: re-record it (--only=${ch.id})`);
			for (const c of timeBeatCues(b.startMs, b.endMs, beat)) cues.push({ ...c, startMs: c.startMs + offset, endMs: c.endMs + offset });
		}
		const missing = ch.beats.filter((b) => !rec.beats.some((r) => r.id === b.id)).map((b) => b.id);
		if (missing.length) throw new Error(`chapter ${ch.id} in timeline.json lacks beat(s) ${missing.join(", ")}: re-record it (--only=${ch.id})`);
		offset += rec.durationMs;
	}
	return { cues, durationMs: offset };
}

function vttTime(ms) {
	const t = Math.max(0, Math.round(ms));
	const h = Math.floor(t / 3600000);
	const m = Math.floor((t % 3600000) / 60000);
	const s = Math.floor((t % 60000) / 1000);
	const pad = (n, w = 2) => String(n).padStart(w, "0");
	return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(t % 1000, 3)}`;
}

function formatVtt(cues) {
	const blocks = cues.map((c, i) => `${i + 1}\n${vttTime(c.startMs)} --> ${vttTime(c.endMs)} ${CUE_SETTINGS}\n${c.lines.join("\n")}\n`);
	return `WEBVTT\n\n${blocks.join("\n")}`;
}

function formatTranscript(chapters) {
	const out = ["How to use the LogisX driver app (transcript)", ""];
	for (const ch of chapters) {
		const said = ch.beats.map((b) => b.say).filter(Boolean);
		if (!said.length) continue;
		out.push(`${ch.title}`, ...said.map((s) => `  ${s}`), "");
	}
	return out.join("\n");
}

// --------------------------------------------------------------------- the storyboard lint

// Capitalised words a caption or card may use mid-sentence: the app's own labels and
// everyday words. Anything else must come from DEMO, so no real name can slip in.
const ALLOWED_WORDS = new Set((
	"LogisX ELD POD CDL PDF PM I Active Pending Historical Accept Decline Sign In Proof Delivery Pickup Details " +
	"Drop-off Documents Expenses Expense Submit Upload Scan Document File Delivered Transit Arrived Receiver Confirm " +
	"Alerts Messages Kit Invoices Generate Weekly Invoice Friday Eastern Captions Remember Questions Message " +
	"Load Fuel Status Got"
).split(" "));

const DEMO_TEXT_KEYS = ["name", "username", "city", "state", "unit", "make", "model", "id", "trailer", "pickupInfo", "pickupAddress",
	"dropInfo", "dropAddress", "number", "vendor", "docType", "fileName", "title", "body", "text"];

function demoStrings(demo) {
	const out = [];
	const walk = (v, key) => {
		if (typeof v === "string") { if (!key || DEMO_TEXT_KEYS.includes(key) || key === "dispatch" || key === "typedMessage") out.push(v); return; }
		if (Array.isArray(v)) { v.forEach((x) => walk(x, key)); return; }
		if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k);
	};
	walk(demo, null);
	return out;
}

// Mid-sentence capitalised words outside ALLOWED_WORDS and `extra`.
function strangers(text, extra) {
	const found = [];
	const tokens = String(text).match(/[A-Za-z][A-Za-z'’-]*|[.?!:]/g) || [];
	let sentenceStart = true;
	for (const tok of tokens) {
		if (/^[.?!:]$/.test(tok)) { sentenceStart = true; continue; }
		const cap = /^[A-Z]/.test(tok);
		if (cap && !sentenceStart && !ALLOWED_WORDS.has(tok) && !extra.has(tok)) found.push(tok);
		sentenceStart = false;
	}
	return found;
}

const MADE_UP_NAME = /Example|Sample|Demo|DEMO/;

function lintDemo(DEMO) {
	const p = [];
	const d = DEMO.driver;
	if (!MADE_UP_NAME.test(d.name)) p.push(`DEMO.driver.name "${d.name}" does not read as made up`);
	if (!/^[a-z]+\.example$/.test(d.username)) p.push(`DEMO.driver.username "${d.username}" is not <name>.example`);
	if (!/^555-01\d\d$/.test(d.phone)) p.push(`DEMO.driver.phone "${d.phone}" is not 555-01xx`);
	if (!/^[a-z.]+@example\.com$/.test(d.email)) p.push(`DEMO.driver.email "${d.email}" is not @example.com`);
	if (!/^T-\d{3}$/.test(DEMO.truck.unit)) p.push(`DEMO.truck.unit "${DEMO.truck.unit}" is not T-nnn`);
	if (!MADE_UP_NAME.test(`${DEMO.truck.make} ${DEMO.truck.model}`)) p.push("DEMO.truck make/model does not read as made up");
	if (!MADE_UP_NAME.test(DEMO.invoice.number)) p.push(`DEMO.invoice.number "${DEMO.invoice.number}" does not read as made up`);
	if (!MADE_UP_NAME.test(DEMO.expense.vendor)) p.push(`DEMO.expense.vendor "${DEMO.expense.vendor}" does not read as made up`);
	const ids = new Set();
	for (const l of DEMO.loads) {
		if (!/^LX-2\d{4}$/.test(l.id)) p.push(`load "${l.id}" is not LX-2xxxx`);
		if (ids.has(l.id)) p.push(`load "${l.id}" is listed twice`);
		ids.add(l.id);
		if (!/^TR-55\d\d$/.test(l.trailer)) p.push(`load ${l.id}: trailer "${l.trailer}" is not TR-55xx`);
		for (const k of ["pickupInfo", "dropInfo"]) if (!MADE_UP_NAME.test(l[k])) p.push(`load ${l.id}: ${k} "${l[k]}" does not read as made up`);
		for (const k of ["pickupAddress", "dropAddress"]) {
			const street = String(l[k]).split(",")[0];
			if (!MADE_UP_NAME.test(street)) p.push(`load ${l.id}: ${k} street "${street}" does not read as made up`);
		}
	}
	for (const doc of DEMO.truckDocuments) if (!/\(sample\)/.test(doc.fileName)) p.push(`truck document "${doc.fileName}" is not marked (sample)`);
	return p;
}

// Load numbers, phone numbers and mail addresses in any text must be DEMO's own.
function lintNumbers(text, DEMO, where) {
	const p = [];
	const ok = new Set([...DEMO.loads.map((l) => l.id), ...DEMO.loads.map((l) => l.trailer), DEMO.truck.unit, DEMO.invoice.number]);
	for (const m of String(text).match(/\b[A-Z]{1,5}(?:-[A-Z]{1,5})?-?\d{3,}\b/g) || []) if (!ok.has(m)) p.push(`${where}: "${m}" looks like a load or unit number DEMO does not have`);
	for (const m of String(text).match(/\b\d{6,}\b/g) || []) p.push(`${where}: "${m}" looks like a real load number`);
	for (const m of String(text).match(/\(?\b\d{3}\)?[-. ]\d{3}[-. ]\d{4}\b|\b\d{3}-\d{4}\b/g) || []) if (!/^555-01\d\d$/.test(m)) p.push(`${where}: "${m}" is not a 555-01xx number`);
	for (const m of String(text).match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) || []) if (!/@example\.com$/.test(m)) p.push(`${where}: "${m}" is not an example.com address`);
	return p;
}

function lintStoryboard({ DEMO, CARDS, CHAPTERS }) {
	const p = [...lintDemo(DEMO)];
	const demoWords = new Set(demoStrings(DEMO).flatMap((s) => s.match(/[A-Za-z][A-Za-z'’-]*/g) || []));
	for (const s of demoStrings(DEMO)) p.push(...lintNumbers(s, DEMO, "DEMO"));
	for (const m of DEMO.messages) for (const w of strangers(m.text, demoWords)) p.push(`DEMO message "${m.text}" names "${w}"`);
	const seenN = new Set();
	const seenId = new Set();
	CHAPTERS.forEach((ch, i) => {
		if (ch.n !== i) p.push(`chapter ${ch.id} is number ${ch.n}, expected ${i} (film order)`);
		if (seenN.has(ch.n) || seenId.has(ch.id)) p.push(`chapter ${ch.n} ${ch.id} is listed twice`);
		seenN.add(ch.n);
		seenId.add(ch.id);
		const beatIds = new Set();
		for (const b of ch.beats) {
			const where = `chapter ${ch.id}, beat ${b.id}`;
			if (beatIds.has(b.id)) p.push(`${where}: beat listed twice`);
			beatIds.add(b.id);
			if (!b.say) continue;
			if (b.say.length > SAY_MAX_CHARS) p.push(`${where}: say is longer than ${SAY_MAX_CHARS} characters`);
			if (/[<>&]|-->/.test(b.say)) p.push(`${where}: say holds a character WebVTT would need escaped (< > & or -->)`);
			let cues = [];
			try { cues = beatPlan(b).cues; } catch (e) { p.push(`${where}: ${e.message}`); }
			for (const c of cues) {
				if (!c.lines || c.lines.length > LINES_MAX || c.lines.some((l) => l.length > LINE_MAX)) p.push(`${where}: cue "${c.text}" does not fit ${LINES_MAX} lines of ${LINE_MAX}`);
				if (c.words / (c.floorMs / 1000) > PACE_WPS + 1e-9) p.push(`${where}: cue "${c.text}" is faster than ${PACE_WPS} words/s`);
			}
			for (const w of strangers(b.say, demoWords)) p.push(`${where}: "${w}" is a name the storyboard does not hold in DEMO`);
			p.push(...lintNumbers(b.say, DEMO, where));
		}
	});
	for (const [key, card] of Object.entries(CARDS)) {
		for (const t of [card.heading, ...card.lines, card.footnote]) {
			for (const w of strangers(t, demoWords)) p.push(`card ${key}: "${w}" is a name the storyboard does not hold in DEMO`);
			p.push(...lintNumbers(t, DEMO, `card ${key}`));
		}
	}
	return p;
}

// The shortest the video can be: every beat at its caption floor, no action time.
function estimate(CHAPTERS) {
	const rows = CHAPTERS.map((ch) => ({ n: ch.n, id: ch.id, title: ch.title, minMs: ch.beats.reduce((s, b) => s + beatPlan(b).minMs, 0) }));
	return { rows, totalMs: rows.reduce((s, r) => s + r.minMs, 0) };
}

module.exports = {
	PACE_WPS, CUE_FLOOR_MS, LINE_MAX, LINES_MAX, CUE_SETTINGS, TAIL_MS,
	wordCount, wrap, layoutCue, splitCues, cueFloorMs, beatPlan, timeBeatCues, buildCues,
	vttTime, formatVtt, formatTranscript, lintStoryboard, lintDemo, strangers, estimate,
};
