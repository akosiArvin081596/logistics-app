"use strict";
// Voice notes (POST /api/messages/voice): is this upload AAC audio in an MP4
// file, and how long is it? Pure: a Buffer in, an answer out (no fs, DB or
// network).
//
// THE BYTES DECIDE. The client's Content-Type, a file name or a duration it
// claims are never read. A voice note is:
//   - at most VOICE_NOTE_MAX_BYTES (4 MB)                  else 413 VOICE_NOTE_TOO_LARGE
//   - an MP4 whose first box is ftyp with an allowed major brand, whose
//     top-level boxes are all in TOP_LEVEL_BOXES, with exactly one moov holding
//     exactly one trak, whose handler is "soun" and whose one sample entry is
//     mp4a carrying AAC (an esds with object type 0x40, or 0x66-0x68)
//                                                         else 415 UNSUPPORTED_AUDIO_TYPE
//   - between 0.5 s and 180.5 s long (3:00 plus encoder rounding)
//                                                         else 422 VOICE_NOTE_TOO_SHORT / _TOO_LONG
//
// THE LENGTH IS COUNTED, NEVER READ FROM A HEADER. A plain file sums its stts
// entries (count x delta); a fragmented file (what MediaRecorder writes) sums
// every trun sample's duration (its own, else the tfhd default, else the trex
// default). mdhd, mvhd and mehd declare a duration too and are never used:
// Chrome's own files declare 1023 ticks for 3.16 s of audio. The ticks are in
// the mdhd timescale; a timescale of 0, or a length that is not a finite
// positive number, is refused before the range check, and every comparison is
// written so NaN fails it. The AAC frame count must agree: samples x 1024 /
// sample rate (from the esds AudioSpecificConfig, else the mp4a entry's 16.16
// field) within 2% of the counted length.
//
// BOUNDED. At most MAX_BOXES boxes are walked in all; every box size is checked
// against its parent's end (64-bit sizes too; size 0 only as the last top-level
// box); every entry count is checked against the bytes left in its box before a
// single entry is read; at most MAX_SAMPLES samples in all (3:00 of 48 kHz AAC
// is about 8,440 frames).
//
// NO METADATA LEAVES. The bytes handed back are a copy in which every udta,
// meta and uuid box inside moov, trak, mdia, minf, stbl, moof and traf (where a
// phone could put a location or a device name), and every free/skip payload,
// is rewritten in place as a zero-filled "free" box: same size, so every sample
// offset still holds. The caller's buffer is never changed.

const VOICE_NOTE_MAX_BYTES = 4 * 1024 * 1024;
const MIN_SECONDS = 0.5;
const MAX_SECONDS = 180.5;
const MAX_BOXES = 10000;
const MAX_SAMPLES = 20000;
const AAC_FRAME_SAMPLES = 1024;
const FRAME_TOLERANCE = 0.02;

const ALLOWED_BRANDS = Object.freeze(["isom", "iso2", "iso3", "iso4", "iso5", "iso6", "mp41", "mp42", "M4A "]);
const TOP_LEVEL_BOXES = new Set(["ftyp", "moov", "moof", "mdat", "free", "skip", "sidx", "mfra", "styp"]);
const BLANKED_BOXES = new Set(["udta", "meta", "uuid", "free", "skip"]);
// MPEG-4 Audio, and the three MPEG-2 AAC profiles.
const AAC_OBJECT_TYPES = new Set([0x40, 0x66, 0x67, 0x68]);
const AAC_SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

class Refusal extends Error {
	constructor(status, code, reason) {
		super(reason);
		this.status = status;
		this.code = code;
	}
}
const unsupported = (reason) => new Refusal(415, "UNSUPPORTED_AUDIO_TYPE", reason);

// The child boxes between `start` and `end`: { type, start, body, end }.
function boxesIn(buf, start, end, ctx, { topLevel = false } = {}) {
	const out = [];
	let p = start;
	while (p < end) {
		if (end - p < 8) throw unsupported("a box header runs past its parent");
		ctx.boxes += 1;
		if (ctx.boxes > MAX_BOXES) throw unsupported(`more than ${MAX_BOXES} boxes`);
		let size = buf.readUInt32BE(p);
		const type = buf.toString("latin1", p + 4, p + 8);
		let header = 8;
		if (size === 1) {
			if (end - p < 16) throw unsupported("a 64-bit box header runs past its parent");
			const large = buf.readBigUInt64BE(p + 8);
			if (large > BigInt(end - p)) throw unsupported("a 64-bit box size runs past its parent");
			size = Number(large);
			header = 16;
		} else if (size === 0) {
			if (!topLevel) throw unsupported("a box of size 0 inside another box");
			size = end - p;
		}
		if (size < header || size > end - p) throw unsupported(`a ${JSON.stringify(type)} box runs past its parent`);
		out.push({ type, start: p, body: p + header, end: p + size });
		p += size;
	}
	return out;
}

// Rewrites metadata-capable boxes as zero-filled "free" boxes, in place, and
// returns the boxes that remain meaningful.
function blankMetadata(buf, boxes) {
	return boxes.filter((b) => {
		if (!BLANKED_BOXES.has(b.type)) return true;
		buf.write("free", b.start + 4, "latin1");
		buf.fill(0, b.body, b.end);
		return false;
	});
}
const only = (boxes, type, where) => {
	const hits = boxes.filter((b) => b.type === type);
	if (hits.length !== 1) throw unsupported(`${where} must hold exactly one ${type} (found ${hits.length})`);
	return hits[0];
};
const optional = (boxes, type, where) => {
	const hits = boxes.filter((b) => b.type === type);
	if (hits.length > 1) throw unsupported(`${where} holds more than one ${type}`);
	return hits[0] || null;
};
// A full box's version byte, and that its body has `need` bytes.
function fullBox(buf, b, need) {
	if (b.end - b.body < Math.max(4, need)) throw unsupported(`a ${b.type} box is too short`);
	return { version: buf[b.body], flags: buf.readUIntBE(b.body + 1, 3) };
}
// `count` entries of `size` bytes from `at`, inside box `b`.
function entriesFit(b, at, count, size) {
	if (!(count >= 0) || at > b.end || count * size > b.end - at) throw unsupported(`a ${b.type} entry count runs past its box`);
}

// A descriptor in an esds: [tag, payload start, payload end].
function descriptor(buf, p, end) {
	if (p + 2 > end) throw unsupported("an esds descriptor runs past its box");
	const tag = buf[p];
	let len = 0;
	let q = p + 1;
	for (let i = 0; i < 4; i++) {
		if (q >= end) throw unsupported("an esds descriptor length runs past its box");
		const byte = buf[q++];
		len = (len << 7) | (byte & 0x7f);
		if (!(byte & 0x80)) break;
		if (i === 3) throw unsupported("an esds descriptor length is too long");
	}
	if (len > end - q) throw unsupported("an esds descriptor runs past its box");
	return { tag, body: q, end: q + len };
}
// The AAC sample rate an esds names (its AudioSpecificConfig), checking the
// object type is AAC. Null when the config carries no rate it can read.
function esdsSampleRate(buf, esds) {
	fullBox(buf, esds, 4);
	const es = descriptor(buf, esds.body + 4, esds.end);
	if (es.tag !== 0x03) throw unsupported("the esds holds no ES descriptor");
	if (es.end - es.body < 3) throw unsupported("the ES descriptor is too short");
	const flags = buf[es.body + 2];
	let p = es.body + 3;
	if (flags & 0x80) p += 2;
	if (flags & 0x40) { if (p >= es.end) throw unsupported("the ES descriptor URL runs past it"); p += 1 + buf[p]; }
	if (flags & 0x20) p += 2;
	if (p >= es.end) throw unsupported("the ES descriptor holds no decoder config");
	const dc = descriptor(buf, p, es.end);
	if (dc.tag !== 0x04 || dc.end - dc.body < 13) throw unsupported("the esds holds no decoder config");
	if (!AAC_OBJECT_TYPES.has(buf[dc.body])) throw unsupported(`the audio is not AAC (object type 0x${buf[dc.body].toString(16)})`);
	if (dc.end - dc.body < 15) return null;
	const dsi = descriptor(buf, dc.body + 13, dc.end);
	if (dsi.tag !== 0x05 || dsi.end - dsi.body < 2) return null;
	// AudioSpecificConfig: 5 bits object type (31 = 6 more), 4 bits frequency
	// index (15 = a 24-bit rate follows).
	let bits = 0;
	const read = (n) => {
		let v = 0;
		for (let i = 0; i < n; i++) {
			const at = dsi.body + (bits >> 3);
			if (at >= dsi.end) throw unsupported("the AAC config runs past its descriptor");
			v = (v << 1) | ((buf[at] >> (7 - (bits & 7))) & 1);
			bits++;
		}
		return v;
	};
	if (read(5) === 31) read(6);
	const index = read(4);
	if (index === 15) return read(24);
	return index < AAC_SAMPLE_RATES.length ? AAC_SAMPLE_RATES[index] : null;
}

// The one sample entry: mp4a carrying AAC. Returns its sample rate.
function audioSampleRate(buf, stsd, ctx) {
	fullBox(buf, stsd, 8);
	if (buf.readUInt32BE(stsd.body + 4) !== 1) throw unsupported("the track must have exactly one sample entry");
	const [entry] = boxesIn(buf, stsd.body + 8, stsd.end, ctx);
	if (!entry || entry.type !== "mp4a") throw unsupported(`the sample entry is ${entry ? JSON.stringify(entry.type) : "missing"}, not mp4a`);
	if (entry.end - entry.body < 28) throw unsupported("the mp4a entry is too short");
	const soundVersion = buf.readUInt16BE(entry.body + 8);
	const fieldRate = buf.readUInt16BE(entry.body + 24);
	const childStart = entry.body + (soundVersion === 1 ? 44 : soundVersion === 0 ? 28 : -1);
	if (childStart < entry.body || childStart > entry.end) throw unsupported("an mp4a entry this app does not read");
	const kids = boxesIn(buf, childStart, entry.end, ctx);
	let esds = kids.find((k) => k.type === "esds") || null;
	const wave = kids.find((k) => k.type === "wave");
	if (!esds && wave) esds = boxesIn(buf, wave.body, wave.end, ctx).find((k) => k.type === "esds") || null;
	if (!esds) throw unsupported("the mp4a entry carries no AAC config (esds)");
	const configRate = esdsSampleRate(buf, esds);
	return configRate || fieldRate;
}

function measure(input) {
	if (!Buffer.isBuffer(input) || input.length === 0) throw unsupported("no audio was sent");
	if (input.length > VOICE_NOTE_MAX_BYTES) throw new Refusal(413, "VOICE_NOTE_TOO_LARGE", "the voice note is over 4 MB");
	if (input.length < 16 || input.toString("latin1", 4, 8) !== "ftyp") throw unsupported("not an MP4 file");
	const buf = Buffer.from(input);
	const ctx = { boxes: 0 };

	let top = boxesIn(buf, 0, buf.length, ctx, { topLevel: true });
	for (const b of top) {
		if (!TOP_LEVEL_BOXES.has(b.type)) throw unsupported(`a top-level ${JSON.stringify(b.type)} box`);
	}
	if (top[0].type !== "ftyp" || top.filter((b) => b.type === "ftyp").length !== 1) throw unsupported("the ftyp box must come first, once");
	if (top[0].end - top[0].body < 8) throw unsupported("the ftyp box is too short");
	const brand = buf.toString("latin1", top[0].body, top[0].body + 4);
	if (!ALLOWED_BRANDS.includes(brand)) throw unsupported(`the major brand ${JSON.stringify(brand)} is not taken`);
	top = blankMetadata(buf, top);

	const moov = only(top, "moov", "the file");
	const moovKids = blankMetadata(buf, boxesIn(buf, moov.body, moov.end, ctx));
	const trak = only(moovKids, "trak", "moov");
	const trakKids = blankMetadata(buf, boxesIn(buf, trak.body, trak.end, ctx));
	const tkhd = only(trakKids, "tkhd", "the track");
	const tk = fullBox(buf, tkhd, 24);
	const trackId = buf.readUInt32BE(tkhd.body + (tk.version === 1 ? 20 : 12));
	const mdia = only(trakKids, "mdia", "the track");
	const mdiaKids = blankMetadata(buf, boxesIn(buf, mdia.body, mdia.end, ctx));
	const hdlr = only(mdiaKids, "hdlr", "mdia");
	fullBox(buf, hdlr, 12);
	const handler = buf.toString("latin1", hdlr.body + 8, hdlr.body + 12);
	if (handler !== "soun") throw unsupported(`the track is ${JSON.stringify(handler)}, not sound`);
	const mdhd = only(mdiaKids, "mdhd", "mdia");
	const md = fullBox(buf, mdhd, 24);
	const timescale = buf.readUInt32BE(mdhd.body + (md.version === 1 ? 20 : 12));
	if (!(timescale > 0)) throw unsupported("the track's timescale is 0");
	const minf = only(mdiaKids, "minf", "mdia");
	const minfKids = blankMetadata(buf, boxesIn(buf, minf.body, minf.end, ctx));
	const stbl = only(minfKids, "stbl", "minf");
	const stblKids = blankMetadata(buf, boxesIn(buf, stbl.body, stbl.end, ctx));
	const sampleRate = audioSampleRate(buf, only(stblKids, "stsd", "stbl"), ctx);

	let samples = 0;
	let ticks = 0;
	const addSamples = (count, duration) => {
		samples += count;
		if (samples > MAX_SAMPLES) throw unsupported(`more than ${MAX_SAMPLES} samples`);
		ticks += count * duration;
	};

	// The sample table (a plain file's samples; empty in a fragmented one).
	const stts = only(stblKids, "stts", "stbl");
	fullBox(buf, stts, 8);
	const sttsCount = buf.readUInt32BE(stts.body + 4);
	entriesFit(stts, stts.body + 8, sttsCount, 8);
	for (let i = 0; i < sttsCount; i++) {
		const at = stts.body + 8 + i * 8;
		addSamples(buf.readUInt32BE(at), buf.readUInt32BE(at + 4));
	}
	const sttsSamples = samples;
	const stsz = optional(stblKids, "stsz", "stbl");
	if (stsz) {
		fullBox(buf, stsz, 12);
		const fixed = buf.readUInt32BE(stsz.body + 4);
		const count = buf.readUInt32BE(stsz.body + 8);
		if (fixed === 0) entriesFit(stsz, stsz.body + 12, count, 4);
		if (count !== sttsSamples) throw unsupported("the sample-size table and the time table disagree");
	}
	const stz2 = optional(stblKids, "stz2", "stbl");
	if (stz2) {
		fullBox(buf, stz2, 12);
		const field = buf[stz2.body + 7];
		const count = buf.readUInt32BE(stz2.body + 8);
		if (![4, 8, 16].includes(field)) throw unsupported("an stz2 field size this app does not read");
		entriesFit(stz2, stz2.body + 12, Math.ceil((count * field) / 8), 1);
	}
	for (const [type, size] of [["stsc", 12], ["stco", 4], ["co64", 8]]) {
		const b = optional(stblKids, type, "stbl");
		if (!b) continue;
		fullBox(buf, b, 8);
		entriesFit(b, b.body + 8, buf.readUInt32BE(b.body + 4), size);
	}

	// Fragments: every trun's sample durations.
	const mvex = optional(moovKids, "mvex", "moov");
	let trexDuration = 0;
	if (mvex) {
		const trexes = boxesIn(buf, mvex.body, mvex.end, ctx).filter((b) => b.type === "trex");
		for (const trex of trexes) {
			fullBox(buf, trex, 24);
			if (buf.readUInt32BE(trex.body + 4) !== trackId) throw unsupported("a trex for a track the file does not have");
			trexDuration = buf.readUInt32BE(trex.body + 12);
		}
	}
	for (const moof of top.filter((b) => b.type === "moof")) {
		const moofKids = blankMetadata(buf, boxesIn(buf, moof.body, moof.end, ctx));
		for (const traf of moofKids.filter((b) => b.type === "traf")) {
			const trafKids = blankMetadata(buf, boxesIn(buf, traf.body, traf.end, ctx));
			const tfhd = only(trafKids, "tfhd", "traf");
			const th = fullBox(buf, tfhd, 8);
			if (buf.readUInt32BE(tfhd.body + 4) !== trackId) throw unsupported("a fragment for a track the file does not have");
			let at = tfhd.body + 8;
			if (th.flags & 0x1) at += 8;
			if (th.flags & 0x2) at += 4;
			let defaultDuration = trexDuration;
			if (th.flags & 0x8) {
				if (at + 4 > tfhd.end) throw unsupported("the tfhd box is too short");
				defaultDuration = buf.readUInt32BE(at);
				at += 4;
			}
			if (th.flags & 0x10) at += 4;
			if (th.flags & 0x20) at += 4;
			if (at > tfhd.end) throw unsupported("the tfhd box is too short");
			for (const trun of trafKids.filter((b) => b.type === "trun")) {
				const tr = fullBox(buf, trun, 8);
				const count = buf.readUInt32BE(trun.body + 4);
				let p = trun.body + 8;
				if (tr.flags & 0x1) p += 4;
				if (tr.flags & 0x4) p += 4;
				const perSample = 4 * [0x100, 0x200, 0x400, 0x800].filter((f) => tr.flags & f).length;
				entriesFit(trun, p, count, perSample);
				if (tr.flags & 0x100) {
					for (let i = 0; i < count; i++) addSamples(1, buf.readUInt32BE(p + i * perSample));
				} else {
					if (!(defaultDuration > 0) && count > 0) throw unsupported("a fragment's samples have no duration");
					addSamples(count, defaultDuration);
				}
			}
		}
	}

	const seconds = ticks / timescale;
	const lengthProblem = lengthRefusal(seconds);
	if (lengthProblem) throw new Refusal(lengthProblem.status, lengthProblem.code, lengthProblem.reason);
	if (!(sampleRate > 0)) throw unsupported("the audio's sample rate is 0");
	const framesSeconds = (samples * AAC_FRAME_SAMPLES) / sampleRate;
	if (!(Math.abs(framesSeconds - seconds) <= seconds * FRAME_TOLERANCE)) {
		throw unsupported(`the AAC frame count (${framesSeconds.toFixed(2)} s) disagrees with the sample table (${seconds.toFixed(2)} s)`);
	}
	return { ok: true, durationMs: Math.round(seconds * 1000), seconds, samples, sampleRate, brand, bytes: buf };
}

// { ok: false, status, code, reason } for a measured length in seconds, or
// null when it is in range.
// NaN, Infinity, 0 and negatives are refused as not audio; written so NaN
// fails every comparison it meets.
function lengthRefusal(seconds) {
	if (!(Number.isFinite(seconds) && seconds > 0)) return { ok: false, status: 415, code: "UNSUPPORTED_AUDIO_TYPE", reason: "the audio's length could not be measured" };
	if (!(seconds >= MIN_SECONDS)) return { ok: false, status: 422, code: "VOICE_NOTE_TOO_SHORT", reason: "the voice note is under half a second" };
	if (!(seconds <= MAX_SECONDS)) return { ok: false, status: 422, code: "VOICE_NOTE_TOO_LONG", reason: "the voice note is over 3 minutes" };
	return null;
}

// { ok: true, durationMs, seconds, samples, sampleRate, brand, bytes } for a
// voice note (`bytes` is the copy to store, metadata blanked), else
// { ok: false, status, code, reason }.
function checkVoiceNote(input) {
	try {
		return measure(input);
	} catch (err) {
		if (err instanceof Refusal) return { ok: false, status: err.status, code: err.code, reason: err.message };
		return { ok: false, status: 415, code: "UNSUPPORTED_AUDIO_TYPE", reason: "the file could not be read" };
	}
}

module.exports = {
	checkVoiceNote,
	lengthRefusal,
	VOICE_NOTE_MAX_BYTES,
	MIN_SECONDS,
	MAX_SECONDS,
	MAX_BOXES,
	MAX_SAMPLES,
	ALLOWED_BRANDS,
	TOP_LEVEL_BOXES,
};
