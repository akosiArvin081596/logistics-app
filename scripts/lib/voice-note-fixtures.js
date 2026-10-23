"use strict";
// Made-up MP4 audio files for the voice-note runners (scripts/test-voice-note-
// mp4.js, scripts/test-voice-note-routes.js). Every file is built box by box
// here, so each case names exactly the structure it tests. No recording of a
// person: the one real file, scripts/fixtures/voice-note-chrome-fake-mic.m4a, is
// Chrome's fake microphone (a generated tone, 3.16 s of AAC at 48 kHz, as
// MediaRecorder wrote it).

const fs = require("fs");
const path = require("path");

const CHROME_FIXTURE = path.join(__dirname, "..", "fixtures", "voice-note-chrome-fake-mic.m4a");
const chromeFixture = () => fs.readFileSync(CHROME_FIXTURE);

const u32 = (...ns) => {
	const b = Buffer.alloc(4 * ns.length);
	ns.forEach((n, i) => b.writeUInt32BE(n >>> 0, i * 4));
	return b;
};
const u16 = (...ns) => {
	const b = Buffer.alloc(2 * ns.length);
	ns.forEach((n, i) => b.writeUInt16BE(n & 0xffff, i * 2));
	return b;
};
const asBuf = (p) => (Buffer.isBuffer(p) ? p : Buffer.from(p, "latin1"));
function box(type, ...parts) {
	const body = Buffer.concat(parts.map(asBuf));
	const head = Buffer.alloc(8);
	head.writeUInt32BE(8 + body.length, 0);
	head.write(type, 4, "latin1");
	return Buffer.concat([head, body]);
}
function full(type, version, flags, ...parts) {
	const vf = Buffer.alloc(4);
	vf[0] = version;
	vf.writeUIntBE(flags, 1, 3);
	return box(type, vf, ...parts);
}

// The sampling-frequency index an AudioSpecificConfig names.
const FREQ_INDEX = { 96000: 0, 88200: 1, 64000: 2, 48000: 3, 44100: 4, 32000: 5, 24000: 6, 22050: 7, 16000: 8, 12000: 9, 11025: 10, 8000: 11 };
function esds(sampleRate, { oti = 0x40 } = {}) {
	const fi = FREQ_INDEX[sampleRate] ?? 3;
	const asc = (2 << 11) | (fi << 7) | (1 << 3); // AAC-LC, mono
	return full("esds", 0, 0, Buffer.from([
		0x03, 25, 0x00, 0x01, 0x00,
		0x04, 17, oti, 0x15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
		0x05, 2, (asc >> 8) & 0xff, asc & 0xff,
		0x06, 1, 0x02,
	]));
}
function mp4a(sampleRate, { withEsds = true, oti = 0x40, fieldRate = sampleRate } = {}) {
	return box("mp4a",
		Buffer.alloc(6), u16(1),
		Buffer.alloc(8),
		u16(1, 16, 0, 0),
		u32(((fieldRate & 0xffff) << 16) >>> 0),
		withEsds ? esds(sampleRate, { oti }) : Buffer.alloc(0));
}
const ftyp = (brand = "isom") => box("ftyp", brand, u32(512), "isomiso2mp41");
const mvhd = (timescale, duration) => full("mvhd", 0, 0, u32(0, 0, timescale, duration), Buffer.alloc(80));
const tkhd = (trackId) => full("tkhd", 0, 3, u32(0, 0, trackId, 0, 0), Buffer.alloc(60));
const mdhd = (timescale, duration) => full("mdhd", 0, 0, u32(0, 0, timescale, duration), u16(0x55c4, 0));
const hdlr = (handler) => full("hdlr", 0, 0, u32(0), handler, u32(0, 0, 0), "SoundHandler\0");
const stts = (entries, { count = entries.length } = {}) => full("stts", 0, 0, u32(count), ...entries.map(([c, d]) => u32(c, d)));
const stsz = (count) => full("stsz", 0, 0, u32(100, count));

function trak({ trackId = 1, timescale, mdhdDuration = 0, sampleRate, handler = "soun", sttsBox, sampleCount, entry, extra = [] }) {
	const stbl = box("stbl",
		full("stsd", 0, 0, u32(1), entry || mp4a(sampleRate)),
		sttsBox,
		stsz(sampleCount),
		full("stsc", 0, 0, u32(0)),
		full("stco", 0, 0, u32(0)));
	const minf = box("minf", full("smhd", 0, 0, u32(0)), stbl);
	return box("trak", tkhd(trackId), box("mdia", mdhd(timescale, mdhdDuration), hdlr(handler), minf), ...extra);
}

// A plain (not fragmented) file: its length is the sum of its stts entries.
function buildPlain({
	brand = "isom", timescale = 48000, sampleRate = 48000, entries = [[148, 1024]], mdhdDuration = 0,
	handler = "soun", tracks = 1, entry = null, sttsCount, moovExtra = [], trakExtra = [], top = [],
} = {}) {
	const sampleCount = entries.reduce((n, [c]) => n + c, 0);
	const sttsBox = stts(entries, { count: sttsCount ?? entries.length });
	const traks = [];
	for (let i = 0; i < tracks; i++) {
		traks.push(trak({ trackId: i + 1, timescale, mdhdDuration, sampleRate, handler, sttsBox, sampleCount, entry, extra: trakExtra }));
	}
	return Buffer.concat([ftyp(brand), box("moov", mvhd(timescale, mdhdDuration), ...traks, ...moovExtra), ...top, box("mdat", Buffer.alloc(64))]);
}

// A fragmented file, the shape MediaRecorder writes: an empty sample table in
// moov, then moof + mdat pairs whose trun entries carry the sample durations.
function buildFragmented({
	timescale = 48000, sampleRate = 48000, fragments = [{ count: 148, duration: 1024 }], trexDuration = 0, tfhdDuration = 0,
	perSample = true, trunCount, mdhdDuration = 0, tfhdTrackId = 1,
} = {}) {
	const parts = [ftyp("isom"), box("moov",
		mvhd(timescale, mdhdDuration),
		trak({ timescale, mdhdDuration, sampleRate, sttsBox: stts([]), sampleCount: 0 }),
		box("mvex", full("trex", 0, 0, u32(1, 1, trexDuration, 0, 0))))];
	fragments.forEach(({ count, duration }, i) => {
		const tfhdFlags = 0x20000 | (tfhdDuration ? 0x8 : 0);
		const tfhd = full("tfhd", 0, tfhdFlags, u32(tfhdTrackId), tfhdDuration ? u32(tfhdDuration) : Buffer.alloc(0));
		const trunFlags = 0x1 | 0x200 | (perSample ? 0x100 : 0);
		const samples = [];
		for (let s = 0; s < count; s++) samples.push(perSample ? u32(duration, 10) : u32(10));
		const trun = full("trun", 0, trunFlags, u32(trunCount ?? count, 0), ...samples);
		parts.push(box("moof", full("mfhd", 0, 0, u32(i + 1)), box("traf", tfhd, trun)));
		parts.push(box("mdat", Buffer.alloc(10 * count)));
	});
	return Buffer.concat(parts);
}

// The chrome fixture with every mvhd / mdhd / mehd duration rewritten (version
// 1 headers: a 64-bit duration), so a test can prove the header is never read.
function withHeaderDuration(buf, ticks) {
	const out = Buffer.from(buf);
	for (const type of ["mvhd", "mdhd"]) {
		for (let at = out.indexOf(type); at >= 4; at = out.indexOf(type, at + 4)) {
			const body = at + 4;
			if (out[body] === 1) out.writeBigUInt64BE(BigInt(ticks), body + 4 + 8 + 8 + 4);
			else out.writeUInt32BE(ticks >>> 0, body + 4 + 4 + 4 + 4);
		}
	}
	return out;
}

module.exports = {
	CHROME_FIXTURE, chromeFixture, box, full, u32, u16, ftyp, mp4a, esds, stts, buildPlain, buildFragmented, withHeaderDuration,
};
