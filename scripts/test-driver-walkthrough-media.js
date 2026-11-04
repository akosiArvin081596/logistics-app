#!/usr/bin/env node
// The driver app walkthrough video (scripts/e2e/driver-walkthrough.mjs) and its committed files.
//   §1 The storyboard: every DEMO value reads as made up, captions name nobody outside DEMO,
//      every cue fits 2 lines of 42 characters at no more than 2.35 words a second.
//   §2 The caption builder on a made-up timeline: floors, pace, order, chapter offsets, errors.
//   §3 The MP4 box reader on a buffer built here, so §4's verdicts rest on a tested reader.
//   §5 The plant's pure parts: the sheet rows it adds hold DEMO values only (run before §4).
//   §4 The three files in client/src/assets/driver-videos/ (or --media-dir=<dir>): the MP4 is
//      H.264 with no sound, faststart, at most 12 MB, 120-300 s long and as long as the title
//      card says; the VTT is the storyboard's text, timed by the rules; the poster is a 390 px
//      JPEG of at most 150 KB; the client's size note matches the file.
// No network, no browser, no ffmpeg; reads files only.
"use strict";

const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const REPO = path.resolve(__dirname, "..");
const WT = path.join(REPO, "scripts", "e2e", "walkthrough");
const cap = require(path.join(WT, "captions.cjs"));
const { DEMO, CARDS, CHAPTERS } = require(path.join(WT, "storyboard.cjs"));
const ASSETS = path.join(REPO, "client", "src", "assets", "driver-videos");
const NAMES = {
	mp4: "logisx-driver-app-walkthrough.mp4",
	vtt: "logisx-driver-app-walkthrough.en.vtt",
	poster: "logisx-driver-app-walkthrough-poster.jpg",
};
const MP4_MAX_BYTES = 12_000_000;
const POSTER_MAX_BYTES = 150_000;
const VTT_MAX_BYTES = 64 * 1024;

const mediaArg = process.argv.slice(2).find((a) => a.startsWith("--media-dir="));
const MEDIA = mediaArg ? path.resolve(mediaArg.slice("--media-dir=".length)) : ASSETS;
const COMMITTED = !mediaArg;

let failures = 0;
const ok = (name, cond, detail) => {
	if (cond) console.log(`  ok   ${name}`);
	else { failures++; console.log(`  FAIL ${name}${detail !== undefined ? `  (${typeof detail === "string" ? detail : JSON.stringify(detail)})` : ""}`); }
};
const eq = (name, actual, expected) => ok(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
const throws = (name, fn, re) => {
	try { fn(); ok(name, false, "no error"); } catch (e) { ok(name, re.test(e.message), e.message); }
};

// ------------------------------------------------------------------------- MP4 box reader
const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "edts", "udta", "dinf"]);
function readBoxes(buf, start = 0, end = buf.length, depth = 0) {
	const out = [];
	let at = start;
	while (at + 8 <= end) {
		let size = buf.readUInt32BE(at);
		const type = buf.toString("latin1", at + 4, at + 8);
		let head = 8;
		if (size === 1) { size = Number(buf.readBigUInt64BE(at + 8)); head = 16; }
		else if (size === 0) size = end - at;
		if (size < head || at + size > end) throw new Error(`box "${type}" at ${at} runs past its parent`);
		const box = { type, start: at, size, body: at + head };
		if (CONTAINERS.has(type) && depth < 8) box.children = readBoxes(buf, box.body, at + size, depth + 1);
		if (type === "stsd") {
			const count = buf.readUInt32BE(box.body + 4);
			box.entries = [];
			let e = box.body + 8;
			for (let i = 0; i < count && e + 8 <= at + size; i++) {
				box.entries.push(buf.toString("latin1", e + 4, e + 8));
				e += buf.readUInt32BE(e);
			}
		}
		out.push(box);
		at += size;
	}
	return out;
}
const child = (box, type) => (box && box.children || []).find((b) => b.type === type) || null;
const all = (boxes, type) => boxes.flatMap((b) => [...(b.type === type ? [b] : []), ...all(b.children || [], type)]);

function mp4Facts(buf) {
	const top = readBoxes(buf);
	const moov = top.find((b) => b.type === "moov");
	const facts = { top: top.map((b) => b.type), traks: [], mp4a: false, durationS: null };
	if (!moov) return facts;
	const mvhd = child(moov, "mvhd");
	if (mvhd) {
		const v = buf[mvhd.body];
		const scale = buf.readUInt32BE(mvhd.body + (v === 1 ? 20 : 12));
		const dur = v === 1 ? Number(buf.readBigUInt64BE(mvhd.body + 24)) : buf.readUInt32BE(mvhd.body + 16);
		facts.durationS = scale ? dur / scale : null;
	}
	for (const trak of (moov.children || []).filter((b) => b.type === "trak")) {
		const hdlr = child(child(trak, "mdia"), "hdlr");
		const tkhd = child(trak, "tkhd");
		const stsd = child(child(child(child(trak, "mdia"), "minf"), "stbl"), "stsd");
		let width = null;
		let height = null;
		if (tkhd) {
			const off = buf[tkhd.body] === 1 ? 88 : 76;
			width = buf.readUInt32BE(tkhd.body + off) / 65536;
			height = buf.readUInt32BE(tkhd.body + off + 4) / 65536;
		}
		facts.traks.push({ handler: hdlr ? buf.toString("latin1", hdlr.body + 8, hdlr.body + 12) : null, codecs: stsd ? stsd.entries : [], width, height });
	}
	facts.mp4a = facts.traks.some((t) => t.codecs.includes("mp4a")) || all(moov.children || [], "mp4a").length > 0;
	return facts;
}

// ---------------------------------------------------------------------------- JPEG reader
function jpegFacts(buf) {
	const facts = { soi: buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8, eoi: buf.length > 4 && buf[buf.length - 2] === 0xff && buf[buf.length - 1] === 0xd9, width: null, height: null };
	let at = 2;
	while (facts.soi && at + 4 <= buf.length) {
		if (buf[at] !== 0xff) break;
		const marker = buf[at + 1];
		if (marker === 0xd9 || marker === 0xda) break;
		const len = buf.readUInt16BE(at + 2);
		if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
			facts.height = buf.readUInt16BE(at + 5);
			facts.width = buf.readUInt16BE(at + 7);
			break;
		}
		at += 2 + len;
	}
	return facts;
}

// ----------------------------------------------------------------------------- VTT reader
const TIMING = /^(\d{2}):(\d{2}):(\d{2})\.(\d{3}) --> (\d{2}):(\d{2}):(\d{2})\.(\d{3})(?: (.{0,200}))?$/;
function readVtt(text) {
	if (text.length > VTT_MAX_BYTES) throw new Error(`over ${VTT_MAX_BYTES} bytes`);
	const lines = text.replace(/^﻿/, "").split(/\r?\n/);
	if (lines[0] !== "WEBVTT") throw new Error(`the first line is "${lines[0].slice(0, 20)}", not WEBVTT`);
	const cues = [];
	let i = 1;
	while (i < lines.length) {
		if (!lines[i].trim()) { i++; continue; }
		let line = lines[i];
		if (!TIMING.test(line)) { i++; line = lines[i] || ""; }
		const m = TIMING.exec(line);
		if (!m) throw new Error(`no timing line near line ${i + 1}`);
		const ms = (h, mi, s, f) => ((+h * 60 + +mi) * 60 + +s) * 1000 + +f;
		const cue = { startMs: ms(m[1], m[2], m[3], m[4]), endMs: ms(m[5], m[6], m[7], m[8]), settings: m[9] || "", lines: [] };
		i++;
		while (i < lines.length && lines[i].trim() && cue.lines.length < 10) cue.lines.push(lines[i++]);
		cues.push(cue);
	}
	return cues;
}

// ------------------------------------------------------------------------------- sections
function storyboard() {
	console.log("§1 the storyboard: made-up values, caption fit and pace");
	eq("lintStoryboard finds no problem", cap.lintStoryboard({ DEMO, CARDS, CHAPTERS }), []);
	eq("chapters are numbered 0..11 in film order", CHAPTERS.map((c) => c.n), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
	ok("every captioned beat's cues fit 2 x 42", CHAPTERS.every((c) => c.beats.every((b) => !b.say || cap.beatPlan(b).cues.every((q) => q.lines && q.lines.length <= 2 && q.lines.every((l) => l.length <= 42)))));
	const est = cap.estimate(CHAPTERS).totalMs / 1000;
	ok(`the captions alone fit under the 300 s cap (${est.toFixed(1)} s)`, est < 300);
	ok("the title card says the video is made-up data", /made up/.test(CARDS.title.footnote));
	// The lint itself catches what it is for (planted samples, never shipped).
	const bad = JSON.parse(JSON.stringify({ DEMO, CARDS, CHAPTERS }));
	bad.DEMO.driver.name = "Jordan Smith";
	bad.DEMO.driver.phone = "214-555-0199";
	bad.DEMO.loads[0].id = "123456789";
	bad.CHAPTERS[1].beats[0].say = "Call Quorvex dispatch at 214-555-0199 about load 123456789.";
	bad.CHAPTERS[2].beats[0].say = "This sentence is far too long to fit on two caption lines of forty-two characters each, so it must be split.";
	const found = cap.lintStoryboard(bad).join("\n");
	ok("…a real-looking driver name is refused", /driver\.name "Jordan Smith"/.test(found), found);
	ok("…a phone outside 555-01xx is refused", /214-555-0199/.test(found));
	ok("…a 9-digit load number is refused", /123456789/.test(found));
	ok("…a company name outside DEMO in a caption is refused", /"Quorvex"/.test(found));
	ok("…a long caption is split, not refused", !/far too long/.test(found));
	const mail = JSON.parse(JSON.stringify({ DEMO, CARDS, CHAPTERS }));
	mail.DEMO.driver.email = "casey@example.org";
	ok("…a mail address outside example.com is refused", /example\.org/.test(cap.lintStoryboard(mail).join("\n")));
}

function builder() {
	console.log("§2 the caption builder on a made-up timeline");
	eq("vttTime formats hours, minutes, seconds and milliseconds", cap.vttTime(3723004), "01:02:03.004");
	eq("a short line stays one line", cap.layoutCue("Type your username."), ["Type your username."]);
	eq("a two-sentence cue breaks after the full stop", cap.layoutCue("Then your password. It shows as dots."), ["Then your password. It shows as dots."]);
	const long = "Sign in with the username and password dispatch gave you, then tap the button below.";
	const cues = cap.splitCues(long);
	ok("a long say splits into cues that each fit 2 x 42", cues.length >= 2 && cues.every((c) => { const l = cap.layoutCue(c); return l && l.length <= 2 && l.every((x) => x.length <= 42); }), cues);
	eq("…and no word is lost", cues.join(" "), long);
	const beat = { id: "b", say: long };
	const plan = cap.beatPlan(beat);
	const timed = cap.timeBeatCues(1000, 1000 + plan.minMs + 2000, beat);
	ok("cues run back to back from the beat's start to its end", timed[0].startMs === 1000 && timed[timed.length - 1].endMs === 1000 + plan.minMs + 2000 && timed.every((c, i) => i === 0 || c.startMs === timed[i - 1].endMs));
	ok("each cue holds at least 2.2 s", timed.every((c) => c.endMs - c.startMs >= 2200));
	ok("no cue runs faster than 2.35 words/s", timed.every((c) => cap.wordCount(c.text) / ((c.endMs - c.startMs) / 1000) <= 2.35 + 1e-6));
	throws("a beat shorter than its captions need is refused", () => cap.timeBeatCues(0, 1000, beat), /re-record/);
	const chapters = [
		{ n: 0, id: "a", title: "A", beats: [{ id: "x", say: "First chapter caption." }] },
		{ n: 1, id: "b", title: "B", beats: [{ id: "y" }, { id: "z", say: "Second chapter caption." }] },
	];
	const timeline = { chapters: [
		{ id: "a", durationMs: 5000, beats: [{ id: "x", startMs: 0, endMs: 5000 }] },
		{ id: "b", durationMs: 7000, beats: [{ id: "y", startMs: 0, endMs: 2000 }, { id: "z", startMs: 2000, endMs: 7000 }] },
	] };
	const built = cap.buildCues(timeline, chapters);
	eq("chapters are offset by the ones before them", built.cues.map((c) => [c.startMs, c.endMs]), [[0, 5000], [7000, 12000]]);
	eq("the total is the chapters' sum", built.durationMs, 12000);
	const vtt = cap.formatVtt(built.cues);
	ok("the VTT starts WEBVTT and carries the placement", vtt.startsWith("WEBVTT\n\n1\n00:00:00.000 --> 00:00:05.000 line:12% align:center size:92%\nFirst chapter caption.\n"), vtt.slice(0, 120));
	eq("the VTT reads back as written", readVtt(vtt).map((c) => [c.startMs, c.endMs, c.lines.join(" ")]), [[0, 5000, "First chapter caption."], [7000, 12000, "Second chapter caption."]]);
	throws("a chapter missing from the timeline is refused", () => cap.buildCues({ chapters: [timeline.chapters[0]] }, chapters), /not in timeline\.json/);
	throws("a beat the storyboard no longer has is refused", () => cap.buildCues({ chapters: [timeline.chapters[0], { ...timeline.chapters[1], beats: [...timeline.chapters[1].beats, { id: "gone", startMs: 7000, endMs: 8000 }] }] }, chapters), /no longer has/);
}

function boxReader() {
	console.log("§3 the MP4 box reader on a buffer built here");
	const box = (type, ...parts) => { const body = Buffer.concat(parts); const h = Buffer.alloc(8); h.writeUInt32BE(8 + body.length); h.write(type, 4, "latin1"); return Buffer.concat([h, body]); };
	const u32 = (...n) => { const b = Buffer.alloc(4 * n.length); n.forEach((v, i) => b.writeUInt32BE(v, i * 4)); return b; };
	const mvhd = (scale, dur) => { const b = Buffer.alloc(100); b.writeUInt32BE(scale, 12); b.writeUInt32BE(dur, 16); return box("mvhd", b); };
	const tkhd = (w, h) => { const b = Buffer.alloc(84); b.writeUInt32BE(w * 65536, 76); b.writeUInt32BE(h * 65536, 80); return box("tkhd", b); };
	const hdlr = (t) => box("hdlr", u32(0, 0), Buffer.from(t, "latin1"), Buffer.alloc(13));
	const stsd = (codec) => box("stsd", u32(0, 1), box(codec, Buffer.alloc(78)));
	const trak = (t, codec, w, h) => box("trak", tkhd(w, h), box("mdia", hdlr(t), box("minf", box("stbl", stsd(codec)))));
	const ftyp = box("ftyp", Buffer.from("isom", "latin1"), u32(512), Buffer.from("isomavc1", "latin1"));
	const good = Buffer.concat([ftyp, box("moov", mvhd(1000, 225000), trak("vide", "avc1", 780, 1688)), box("mdat", Buffer.alloc(32))]);
	const f = mp4Facts(good);
	eq("top-level order ftyp, moov, mdat", f.top, ["ftyp", "moov", "mdat"]);
	eq("one video track, avc1, 780 x 1688", f.traks, [{ handler: "vide", codecs: ["avc1"], width: 780, height: 1688 }]);
	eq("duration from mvhd", f.durationS, 225);
	ok("no mp4a", !f.mp4a);
	const sound = mp4Facts(Buffer.concat([ftyp, box("moov", mvhd(1000, 1000), trak("vide", "avc1", 780, 1688), trak("soun", "mp4a", 0, 0)), box("mdat")]));
	ok("a sound track is seen", sound.mp4a && sound.traks.some((t) => t.handler === "soun"));
	eq("mdat before moov is seen", mp4Facts(Buffer.concat([ftyp, box("mdat"), box("moov", mvhd(1, 1))])).top, ["ftyp", "mdat", "moov"]);
	throws("a box that runs past its parent is refused", () => readBoxes(Buffer.concat([ftyp, Buffer.from([0, 0, 1, 0, 0x6d, 0x6f, 0x6f, 0x76])])), /runs past/);
	const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0x03, 0x4c, 0x01, 0x86, 1, 1, 0x11, 0, 0xff, 0xd9]);
	eq("the JPEG reader finds SOI, EOI and the SOF size", jpegFacts(jpeg), { soi: true, eoi: true, width: 390, height: 844 });
}

function plantParts() {
	console.log("§5 the plant writes made-up values only (its pure parts; nothing is planted here)");
	const plant = require(path.join(WT, "plant.cjs"));
	const fixturePath = path.join(REPO, "scripts", "e2e", "fixtures", "e2e-sheets.json");
	const before = fs.readFileSync(fixturePath, "utf8");
	const source = JSON.parse(before);
	const book = plant.sheetsWithDemo(source, "2026-10-30");
	eq("the committed fixture is not changed", fs.readFileSync(fixturePath, "utf8"), before);
	eq("the book passed in is not changed (a copy comes back)", JSON.stringify(source), JSON.stringify(JSON.parse(before)));
	throws("a book that already holds a DEMO load is refused", () => plant.sheetsWithDemo(book, "2026-10-30"), /already holds LX-20311, LX-20398, LX-20417/);
	// POST /api/trucks refuses to assign a driver with an active load in the sheet, so the
	// truck is made before the loads are added (the 2026-10-30 run stopped on exactly that).
	const src = fs.readFileSync(path.join(WT, "plant.cjs"), "utf8");
	const mainSrc = src.slice(src.indexOf("async function main()"));
	ok("the plant makes the account and truck before it adds the loads to the sheet",
		mainSrc.indexOf("makeAccountAndTruck(") > 0 && mainSrc.indexOf("makeAccountAndTruck(") < mainSrc.indexOf("sheetsWithDemo("));
	const main = Object.values(book.spreadsheets).find((s) => s.role === "main");
	const jt = main.sheets.find((s) => s.properties.title === "Job Tracking").values;
	const fixtureRows = Object.values(JSON.parse(before).spreadsheets).find((s) => s.role === "main").sheets.find((s) => s.properties.title === "Job Tracking").values.length;
	const rows = jt.slice(fixtureRows);
	const h = jt[0];
	const col = (row, name) => row[h.indexOf(name)];
	eq("three rows are added, one per DEMO load", rows.map((r) => col(r, "Load ID")), DEMO.loads.map((l) => l.id));
	ok("each row has a cell for every header", rows.every((r) => r.length === h.length));
	eq("every added row is the DEMO driver's", [...new Set(rows.map((r) => col(r, "Driver")))], [DEMO.driver.name]);
	eq("statuses: Delivered, In Transit, Dispatched", rows.map((r) => col(r, "Job Status")), ["Delivered", "In Transit", "Dispatched"]);
	eq("the active load is picked up yesterday and delivers today", [col(rows[1], "Pickup Appointment"), col(rows[1], "Drop-off Appointment")], ["10/29/2026 8:00", "10/30/2026 14:00"]);
	const words = new Set([DEMO, CARDS].flatMap((o) => JSON.stringify(o).match(/[A-Za-z][A-Za-z'’-]*/g) || []));
	const odd = rows.flatMap((r) => r.filter(Boolean).flatMap((cell) => cap.strangers(`. ${cell}`, words).map((w) => `${cell}: ${w}`)));
	eq("no cell names anyone or anything outside DEMO", odd, []);
	const known = new Set(DEMO.loads.flatMap((l) => [l.pickupInfo, l.pickupAddress, l.dropInfo, l.dropAddress]));
	ok("every shipper, receiver and address is a DEMO value", rows.every((r) => ["Pickup Info", "Pickup Address", "Drop-off Info", "Drop-off Address"].every((n) => known.has(col(r, n)))));
	eq("Friday's invoice week is the Saturday-to-Friday before it", plant.lastInvoiceWeek("2026-10-30"), { start: "2026-10-17", end: "2026-10-23" });
	eq("Saturday's is the week that just ended", plant.lastInvoiceWeek("2026-10-31"), { start: "2026-10-24", end: "2026-10-30" });
	eq("Sunday's is the same week", plant.lastInvoiceWeek("2026-11-01"), { start: "2026-10-24", end: "2026-10-30" });
	eq("Thursday's is the week before", plant.lastInvoiceWeek("2026-10-29"), { start: "2026-10-17", end: "2026-10-23" });
	const png = Buffer.from(plant.placeholderIdPng().replace(/^data:image\/png;base64,/, ""), "base64");
	ok("the CDL placeholder is a PNG", png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));
	eq("…240 x 152", [png.readUInt32BE(16), png.readUInt32BE(20)], [240, 152]);
	const badChunks = [];
	for (let at = 8; at + 12 <= png.length;) {
		const len = png.readUInt32BE(at);
		const body = png.subarray(at + 4, at + 8 + len);
		if ((require("zlib").crc32(body) >>> 0) !== png.readUInt32BE(at + 8 + len)) badChunks.push(body.toString("latin1", 0, 4));
		at += 12 + len;
	}
	eq("…and every chunk's CRC is right (a browser shows it)", badChunks, []);
	eq("the signed contracts are the server's five onboarding documents", plant.CONTRACTS.map((c) => c.key), ["contractor_agreement", "equipment_policy", "w9", "mobile_policy", "substance_policy"]);
}

async function media() {
	console.log(`§4 the walkthrough files in ${path.relative(REPO, MEDIA) || MEDIA}${COMMITTED ? "" : " (--media-dir)"}`);
	const file = (k) => path.join(MEDIA, NAMES[k]);
	for (const k of Object.keys(NAMES)) ok(`${NAMES[k]} exists`, fs.existsSync(file(k)));
	if (COMMITTED && fs.existsSync(MEDIA)) eq("the folder holds the three files and nothing else", fs.readdirSync(MEDIA).sort(), Object.values(NAMES).sort());
	if (!Object.keys(NAMES).every((k) => fs.existsSync(file(k)))) return;

	const mp4 = fs.readFileSync(file("mp4"));
	ok(`the MP4 is at most ${MP4_MAX_BYTES / 1e6} MB (${(mp4.length / 1e6).toFixed(2)} MB)`, mp4.length <= MP4_MAX_BYTES);
	let f = null;
	try { f = mp4Facts(mp4); } catch (e) { ok("the MP4's boxes read", false, e.message); }
	if (f) {
		eq("ftyp comes first", f.top[0], "ftyp");
		ok("moov comes before mdat (faststart)", f.top.includes("moov") && f.top.includes("mdat") && f.top.indexOf("moov") < f.top.indexOf("mdat"), f.top);
		eq("exactly one track, video", f.traks.map((t) => t.handler), ["vide"]);
		ok("the video track is H.264 (avc1)", f.traks.length === 1 && f.traks[0].codecs.includes("avc1"), f.traks);
		ok("the video is 780 x 1688", f.traks.length === 1 && f.traks[0].width === 780 && f.traks[0].height === 1688, f.traks);
		ok("no audio (no mp4a)", !f.mp4a);
		ok(`the duration is 120-300 s (${f.durationS && f.durationS.toFixed(1)} s)`, f.durationS >= 120 && f.durationS <= 300);
		const claim = /About (\d+) minutes/.exec(CARDS.title.lines.join(" "));
		if (claim) {
			const m = Number(claim[1]) * 60;
			ok(`the title card's "about ${claim[1]} minutes" holds (within 45 s)`, Math.abs(f.durationS - m) <= 45, `${f.durationS && f.durationS.toFixed(1)} s`);
		}
	}

	let cues = [];
	try { cues = readVtt(fs.readFileSync(file("vtt"), "utf8")); ok(`the VTT reads (${cues.length} cues)`, cues.length > 0); } catch (e) { ok("the VTT reads", false, e.message); }
	if (cues.length) {
		ok("every cue carries the placement settings", cues.every((c) => c.settings === cap.CUE_SETTINGS));
		ok("every cue ends after it starts", cues.every((c) => c.endMs > c.startMs));
		ok("cues are in order and never overlap", cues.every((c, i) => i === 0 || c.startMs >= cues[i - 1].endMs));
		const short = cues.slice(0, -1).filter((c) => c.endMs - c.startMs < 2200);
		eq("every cue but the last holds at least 2.2 s", short.map((c) => c.lines.join(" ")), []);
		eq("every cue is at most 2 lines of 42 characters", cues.filter((c) => c.lines.length < 1 || c.lines.length > 2 || c.lines.some((l) => l.length > 42)).map((c) => c.lines), []);
		eq("no cue runs faster than 2.35 words/s", cues.filter((c) => cap.wordCount(c.lines.join(" ")) / ((c.endMs - c.startMs) / 1000) > 2.35 + 0.01).map((c) => c.lines.join(" ")), []);
		if (f && f.durationS) {
			ok("the last cue ends by the video's end (+0.5 s)", cues[cues.length - 1].endMs <= f.durationS * 1000 + 500);
			// The captions are timed from the same total as the video; a gap means they drift.
			ok("the last cue ends within 0.5 s of the video's end (captions in step)", Math.abs(cues[cues.length - 1].endMs - f.durationS * 1000) <= 500,
				`${cues[cues.length - 1].endMs} ms vs ${Math.round(f.durationS * 1000)} ms`);
		}
		const expected = CHAPTERS.flatMap((c) => c.beats.flatMap((b) => cap.splitCues(b.say).map((t) => cap.layoutCue(t))));
		eq("the cues are the storyboard's text, laid out by the builder (never hand-edited)", cues.map((c) => c.lines), expected);
	}

	const poster = fs.readFileSync(file("poster"));
	const j = jpegFacts(poster);
	ok("the poster is a JPEG (SOI and EOI)", j.soi && j.eoi);
	eq("the poster is 390 px wide", j.width, 390);
	ok(`the poster is at most ${POSTER_MAX_BYTES / 1000} KB (${(poster.length / 1000).toFixed(1)} KB)`, poster.length <= POSTER_MAX_BYTES);

	const lib = path.join(REPO, "client", "src", "lib", "driverVideos.js");
	const assets = path.join(REPO, "client", "src", "lib", "driverVideoAssets.js");
	if (!COMMITTED && !fs.existsSync(lib)) {
		console.log("  --   WALKTHROUGH_APPROX_MB: not checked (client/src/lib/driverVideos.js is PR 1's file and is not here)");
		return;
	}
	let approx = null;
	try { approx = (await import(pathToFileURL(lib).href)).WALKTHROUGH_APPROX_MB; } catch (e) { ok("client/src/lib/driverVideos.js loads", false, e.message); }
	ok(`WALKTHROUGH_APPROX_MB (${approx}) is within 1 MB of the MP4 (${(mp4.length / 1e6).toFixed(2)} MB)`, typeof approx === "number" && Math.abs(approx - mp4.length / 1e6) <= 1);
	if (COMMITTED) {
		const text = fs.existsSync(assets) ? fs.readFileSync(assets, "utf8") : "";
		for (const name of Object.values(NAMES)) ok(`driverVideoAssets.js imports ${name} with ?url`, text.includes(`'../assets/driver-videos/${name}?url'`));
	}
}

(async () => {
	try {
		storyboard();
		builder();
		boxReader();
		plantParts();
		await media();
	} catch (e) {
		failures++;
		console.log(`  FAIL unexpected error: ${e && e.message}`);
	}
	console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
	process.exit(failures ? 1 : 0);
})();
