#!/usr/bin/env node
/**
 * scripts/test-voice-note-mp4.js — what lib/voice-note-mp4.js accepts as a voice
 * note, and the length it measures.
 *
 * A voice note is AAC audio in an MP4 file, checked from its BYTES (never the
 * client's type or a file name), at most 4 MB, 0.5 s to 180.5 s long. The length
 * is counted from the sample-table entries (stts in a plain file, every trun in a
 * fragmented one), never from a header's declared duration, and the AAC frame
 * count must agree with it within 2%.
 *
 *   §1 the Chrome fixture (Chrome's fake microphone, a generated tone): accepted,
 *      3.16 s; its header durations are never read
 *   §2 other formats and broken files: WebM, Ogg, MP3, WAV, HTML renamed, a
 *      video track, two tracks, a truncated box, a box past the end, a 64-bit
 *      size overflow, more than 10,000 boxes (in bounded time), no AAC config
 *   §3 lengths: 180.4 s accepted and 181 s refused (plain and fragmented), under
 *      0.5 s refused, timescale 0 refused, a NaN length refused, a frame count
 *      off by 5% refused, entry counts that run past their box refused, 20,001
 *      samples refused, over 4 MB refused
 *   §4 metadata: a udta / meta box (where a phone could put a location) is
 *      blanked in the bytes the checker hands back; the caller's buffer is
 *      untouched
 *
 * Made-up audio only. Run: node scripts/test-voice-note-mp4.js
 */

"use strict";
const fx = require("./lib/voice-note-fixtures");

let failed = 0;
const ok = (name, cond) => {
	if (cond) console.log(`ok    ${name}`);
	else { failed++; console.log(`FAIL  ${name}`); }
};

let mp4 = null;
try { mp4 = require("../lib/voice-note-mp4"); } catch (err) { ok(`lib/voice-note-mp4.js loads (${err.message})`, false); }
const check = (buf) => (mp4 ? mp4.checkVoiceNote(buf) : { ok: false, code: "MISSING" });
const refusedWith = (r, code, status) => !!r && r.ok === false && r.code === code && (status === undefined || r.status === status);
const near = (a, b, tol) => Number.isFinite(a) && Math.abs(a - b) <= tol;

// §1 the Chrome fixture
{
	const r = check(fx.chromeFixture());
	ok("§1 the Chrome fixture is accepted", r.ok === true);
	ok("§1 ...measured 3.16 s (+/- 0.05)", r.ok === true && near(r.durationMs / 1000, 3.16, 0.05));
	ok("§1 ...148 AAC frames at 48 kHz", r.ok === true && r.samples === 148 && r.sampleRate === 48000);
	const hour = fx.withHeaderDuration(fx.chromeFixture(), 3600 * 48000);
	const h = check(hour);
	ok("§1 a header duration of 1 hour with 3.16 s of real entries: accepted, measured 3.16 s", h.ok === true && near(h.durationMs / 1000, 3.16, 0.05));
	const plainHour = check(fx.buildPlain({ mdhdDuration: 3600 * 48000 }));
	ok("§1 ...the same for a plain file (mdhd says 1 hour, stts says 3.16 s)", plainHour.ok === true && near(plainHour.durationMs / 1000, 3.16, 0.05));
	ok("§1 a plain file of 148 frames is accepted, 3.16 s", (() => { const p = check(fx.buildPlain()); return p.ok === true && near(p.durationMs / 1000, 3.16, 0.05); })());
	for (const brand of ["iso5", "mp42", "M4A "]) {
		ok(`§1 the major brand "${brand}" is accepted`, check(fx.buildPlain({ brand })).ok === true);
	}
	ok("§1 an unknown major brand is refused", refusedWith(check(fx.buildPlain({ brand: "qt  " })), "UNSUPPORTED_AUDIO_TYPE", 415));
}

// §2 other formats and broken files
{
	const UNSUP = "UNSUPPORTED_AUDIO_TYPE";
	const pad = (b) => Buffer.concat([b, Buffer.alloc(4096, 0x41)]);
	ok("§2 WebM is refused", refusedWith(check(pad(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81]))), UNSUP, 415));
	ok("§2 Ogg is refused", refusedWith(check(pad(Buffer.from("OggS\0\x02\0\0", "latin1"))), UNSUP, 415));
	ok("§2 MP3 (ID3) is refused", refusedWith(check(pad(Buffer.from("ID3\x04\0\0\0\0\0\0", "latin1"))), UNSUP, 415));
	ok("§2 MP3 (frame sync) is refused", refusedWith(check(pad(Buffer.from([0xff, 0xfb, 0x90, 0x64]))), UNSUP, 415));
	ok("§2 WAV is refused", refusedWith(check(pad(Buffer.from("RIFF\x24\0\0\0WAVEfmt ", "latin1"))), UNSUP, 415));
	ok("§2 HTML renamed .m4a is refused", refusedWith(check(Buffer.from("<!doctype html><html><script>alert(1)</script></html>")), UNSUP, 415));
	ok("§2 an empty body is refused", refusedWith(check(Buffer.alloc(0)), UNSUP, 415));
	ok("§2 a non-buffer is refused", refusedWith(check("ftyp"), UNSUP, 415) && refusedWith(check(null), UNSUP, 415));
	ok("§2 an MP4 whose track is video is refused", refusedWith(check(fx.buildPlain({ handler: "vide" })), UNSUP, 415));
	ok("§2 an MP4 with two tracks is refused", refusedWith(check(fx.buildPlain({ tracks: 2 })), UNSUP, 415));
	ok("§2 an mp4a entry with no AAC config (no esds) is refused", refusedWith(check(fx.buildPlain({ entry: fx.mp4a(48000, { withEsds: false }) })), UNSUP, 415));
	ok("§2 an mp4a entry carrying MP3 (object type 0x6B) is refused", refusedWith(check(fx.buildPlain({ entry: fx.mp4a(48000, { oti: 0x6b }) })), UNSUP, 415));
	ok("§2 a sample entry that is not mp4a is refused", refusedWith(check(fx.buildPlain({ entry: fx.box("Opus", Buffer.alloc(28)) })), UNSUP, 415));
	ok("§2 the Chrome fixture cut short (a truncated box) is refused", refusedWith(check(fx.chromeFixture().subarray(0, 5000)), UNSUP, 415));
	{
		const b = fx.chromeFixture();
		b.writeUInt32BE(b.length * 2, 36); // moov's size, past the end
		ok("§2 a box size past the end of the file is refused", refusedWith(check(b), UNSUP, 415));
	}
	{
		const big = Buffer.concat([fx.ftyp(), Buffer.from([0, 0, 0, 1]), Buffer.from("free", "latin1"), Buffer.from([0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), Buffer.alloc(32)]);
		ok("§2 a 64-bit box size overflow is refused", refusedWith(check(big), UNSUP, 415));
		const small = Buffer.concat([fx.ftyp(), Buffer.from([0, 0, 0, 1]), Buffer.from("free", "latin1"), Buffer.from([0, 0, 0, 0, 0, 0, 0, 4]), Buffer.alloc(32)]);
		ok("§2 a 64-bit box size smaller than its header is refused", refusedWith(check(small), UNSUP, 415));
	}
	{
		const plain = fx.buildPlain();
		const zero = Buffer.concat([plain.subarray(0, 28), Buffer.from([0, 0, 0, 0]), Buffer.from("free", "latin1"), plain.subarray(28)]);
		ok("§2 a size-0 box (runs to the end of the file) that swallows the moov is refused", refusedWith(check(zero), UNSUP, 415));
		const tail = Buffer.concat([plain, Buffer.from([0, 0, 0, 0]), Buffer.from("free", "latin1"), Buffer.alloc(16)]);
		ok("§2 ...as the last box it is accepted", check(tail).ok === true);
	}
	{
		const frees = [];
		for (let i = 0; i < 10001; i++) frees.push(fx.box("free"));
		const many = Buffer.concat([fx.ftyp(), ...frees]);
		const t0 = Date.now();
		const r = check(many);
		const ms = Date.now() - t0;
		ok(`§2 more than 10,000 boxes is refused, in bounded time (${ms} ms)`, refusedWith(r, UNSUP, 415) && ms < 2000);
	}
	ok("§2 a top-level box this app does not take (a top-level udta) is refused", refusedWith(check(Buffer.concat([fx.buildPlain(), fx.box("udta", Buffer.alloc(8))])), UNSUP, 415));
	ok("§2 a fragment for a track the file does not have is refused", refusedWith(check(fx.buildFragmented({ tfhdTrackId: 2 })), UNSUP, 415));
}

// §3 lengths
{
	const frames = (sec) => Math.round((sec * 48000) / 1024);
	ok("§3 a plain file of 180.4 s is accepted", (() => { const r = check(fx.buildPlain({ entries: [[frames(180.4), 1024]] })); return r.ok === true && near(r.durationMs / 1000, 180.4, 0.05); })());
	ok("§3 a plain file of 181 s is refused (too long, 422)", refusedWith(check(fx.buildPlain({ entries: [[frames(181), 1024]] })), "VOICE_NOTE_TOO_LONG", 422));
	ok("§3 trun totals of 180.4 s are accepted", (() => {
		const n = frames(180.4);
		const r = check(fx.buildFragmented({ fragments: [{ count: n - 100, duration: 1024 }, { count: 100, duration: 1024 }] }));
		return r.ok === true && near(r.durationMs / 1000, 180.4, 0.05);
	})());
	ok("§3 trun totals of 181 s are refused (too long)", refusedWith(check(fx.buildFragmented({ fragments: [{ count: frames(181) - 100, duration: 1024 }, { count: 100, duration: 1024 }] })), "VOICE_NOTE_TOO_LONG", 422));
	ok("§3 under 0.5 s is refused (too short, 422)", refusedWith(check(fx.buildPlain({ entries: [[20, 1024]] })), "VOICE_NOTE_TOO_SHORT", 422));
	ok("§3 no samples at all is refused", (() => { const r = check(fx.buildPlain({ entries: [] })); return r.ok === false; })());
	ok("§3 a trun without per-sample durations takes the tfhd default", (() => { const r = check(fx.buildFragmented({ perSample: false, tfhdDuration: 1024 })); return r.ok === true && near(r.durationMs / 1000, 3.16, 0.05); })());
	ok("§3 ...else the trex default", (() => { const r = check(fx.buildFragmented({ perSample: false, trexDuration: 1024 })); return r.ok === true && near(r.durationMs / 1000, 3.16, 0.05); })());
	ok("§3 ...and with no duration anywhere it is refused", refusedWith(check(fx.buildFragmented({ perSample: false })), "UNSUPPORTED_AUDIO_TYPE", 415));
	ok("§3 an mdhd timescale of 0 is refused (415)", refusedWith(check(fx.buildPlain({ timescale: 0 })), "UNSUPPORTED_AUDIO_TYPE", 415));
	if (mp4 && typeof mp4.lengthRefusal === "function") {
		ok("§3 a length that comes out NaN is refused, never let through as in range", refusedWith(mp4.lengthRefusal(NaN), "UNSUPPORTED_AUDIO_TYPE", 415));
		ok("§3 ...Infinity, 0 and a negative length too", [Infinity, 0, -1].every((s) => refusedWith(mp4.lengthRefusal(s), "UNSUPPORTED_AUDIO_TYPE", 415)));
		ok("§3 ...and an in-range length passes", mp4.lengthRefusal(3.16) === null);
	} else {
		ok("§3 lib/voice-note-mp4.js exports lengthRefusal()", false);
	}
	ok("§3 a frame count off by 5% from the entry-summed length is refused", refusedWith(check(fx.buildPlain({ entries: [[148, 1075]] })), "UNSUPPORTED_AUDIO_TYPE", 415));
	ok("§3 ...within 1% it is accepted", check(fx.buildPlain({ entries: [[148, 1034]] })).ok === true);
	ok("§3 a mismatched sample rate (field says 48 kHz, frames are 44.1 kHz) is refused", refusedWith(check(fx.buildPlain({ timescale: 44100, sampleRate: 48000, entries: [[148, 1024]] })), "UNSUPPORTED_AUDIO_TYPE", 415));
	ok("§3 an stts entry count that runs past its box is refused", refusedWith(check(fx.buildPlain({ sttsCount: 1000 })), "UNSUPPORTED_AUDIO_TYPE", 415));
	ok("§3 a trun sample count that runs past its box is refused", refusedWith(check(fx.buildFragmented({ trunCount: 1000 })), "UNSUPPORTED_AUDIO_TYPE", 415));
	{
		const r = check(fx.buildPlain({ timescale: 48000, entries: [[20001, 16]] }));
		ok("§3 20,001 samples is refused (the sample cap)", refusedWith(r, "UNSUPPORTED_AUDIO_TYPE", 415) && /sample/i.test(String(r.reason || "")));
	}
	{
		const huge = Buffer.concat([fx.buildPlain(), fx.box("free", Buffer.alloc(4 * 1024 * 1024))]);
		ok("§3 more than 4 MB is refused (413)", refusedWith(check(huge), "VOICE_NOTE_TOO_LARGE", 413));
	}
	ok("§3 44.1 kHz audio in a 44.1 kHz timescale is accepted", (() => { const r = check(fx.buildPlain({ timescale: 44100, sampleRate: 44100, entries: [[136, 1024]] })); return r.ok === true && near(r.durationMs / 1000, 3.16, 0.05); })());
}

// §4 metadata
{
	const loc = Buffer.from("\xa9xyz+40.7128-074.0060/", "latin1");
	const input = fx.buildPlain({ moovExtra: [fx.box("udta", fx.box("\xa9xyz", loc))], trakExtra: [fx.box("meta", Buffer.alloc(4), fx.box("hdlr", Buffer.alloc(20)))] });
	const copy = Buffer.from(input);
	const r = check(input);
	ok("§4 a file with udta and meta boxes is accepted", r.ok === true);
	ok("§4 ...and the bytes handed back hold no udta, meta or location text", r.ok === true && Buffer.isBuffer(r.bytes)
		&& r.bytes.indexOf("udta") < 0 && r.bytes.indexOf("meta") < 0 && r.bytes.indexOf("+40.7128") < 0);
	ok("§4 ...the same length (offsets kept)", r.ok === true && r.bytes.length === input.length);
	ok("§4 ...and the caller's buffer is untouched", input.equals(copy));
	const back = r.ok === true ? check(r.bytes) : { ok: false };
	ok("§4 the blanked bytes still check out, same length", back.ok === true && back.durationMs === r.durationMs);
}

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
