#!/usr/bin/env node
// scripts/triumph-batch-recompress-look.js: way 1's Part A (reports/2026-11-19-triumph-batch-recompress-plan.md
// §6), read-only. For one delivered C.H. Robinson load it runs the practice run
// (scripts/triumph-process-rehearsal.js run(): the press's checks as a dry run, then the Triumph job's own
// build), keeps the parts the job hands the batch builder (lib/triumph-batch.js buildBatch(), whose own answer
// goes back to the job unchanged), and measures them with the builder itself: the batch as built today with
// the photo re-compress off, then the steps with it on, whatever the switch says. So the fit is judged on the
// load's measured batch, never on an estimate. A load already pressed, whose own Process with Triumph claim
// stopped at BATCH_TOO_LARGE, is measured with that claim's own invoice, as its Try again would build it; a
// load the press's checks refuse otherwise is not measured, and the line says so with their code.
// It prints counts and codes only: bytes, images, the step, the limit the build was held to (when one is
// set, a lowered TRIUMPH_BATCH_MAX_BYTES from the settings file) and the practice run's own verdict line;
// never a load number, a name, an amount, a file name or any other settings value. It writes and keeps
// nothing beyond what the practice run itself keeps (nothing).
//
// Usage: the practice run's own arguments, run the same way (on the server, from the app directory, with the
// Node pm2 runs it with):
//   node scripts/triumph-batch-recompress-look.js --db=app.db --sheet-id=<id> --load=<load id> [--key=service-account-key.json]
//   --values-json=<file> and --env-file=<file> as the practice run takes them.
// A wrapper that takes several loads (the same ones as the sizing look, most recent first) calls run() for
// each in one process, with the practice run's deps, and labels each load's lines itself.
// Exit codes: 0 measured, 1 an error, 2 refused or not measured (a line says by what).

"use strict";

const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const rehearsal = require(path.join(ROOT, "scripts", "triumph-process-rehearsal.js"));
const batchLib = require(path.join(ROOT, "lib", "triumph-batch.js"));
const rules = require(path.join(ROOT, "lib", "triumph-rules.js"));
const recompressLib = require(path.join(ROOT, "lib", "triumph-batch-recompress.js"));

const HEADER = "Part A, way 1's look: read-only; nothing is marked, armed, numbered, uploaded or kept.";
const BASE = "the base: the job's own build in the practice run, measured by the batch builder itself: the batch as built today with the switch off, then each step merged again with it on";
const CLAIM_SOURCE = "the source: the load's own Process with Triumph claim, stopped at BATCH_TOO_LARGE: its build rehearsed with that claim's own invoice, as its Try again would build it, read-only";
const word = (v) => (/^[A-Z][A-Z0-9_]{0,39}$/.test(String(v)) ? String(v) : "OTHER");
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

// The touched parts' records, summed: images, images left, the step, and the parts' bytes.
function summed(records) {
	const done = (Array.isArray(records) ? records : []).filter(Boolean);
	const sum = (k) => done.reduce((s, r) => s + (Number(r[k]) || 0), 0);
	return { images: sum("images"), left: sum("left"), quality: done.length ? Number(done[0].quality) : 0, before: sum("bytesBefore"), after: sum("bytesAfter") };
}

// The BOL and POD rows the builder merges (each identical file once when the dedupe is on, as it is
// sent), and the photos the whitelist takes among their page images.
async function photosOf(handed) {
	const seen = new Set();
	const out = { images: 0, photos: 0, bytes: 0 };
	for (const d of rules.batchDocuments(handed.documents || [])) {
		if (!recompressLib.TOUCHED_KINDS.has(d.kind) || !Buffer.isBuffer(d.doc.buffer)) continue;
		if (handed.dedupe === true) {
			const h = sha256(d.doc.buffer);
			if (seen.has(h)) continue;
			seen.add(h);
		}
		const s = await recompressLib.survey(d.doc.buffer);
		out.images += s.images;
		out.photos += s.photos.length;
		out.bytes += s.photos.reduce((n, p) => n + p.raw.length, 0);
	}
	return out;
}

// What the steps did, in one line.
function stepsLine(on, before, limit) {
	const after = on.ok ? on.batchBytes : on.pdfBytes + on.csvBytes;
	const tail = (s) => `${plural(s.images, "page image")} re-compressed, ${s.left} left; the BOL and POD parts ${s.before} → ${s.after} bytes`;
	if (on.ok) {
		const s = summed(on.parts.map((p) => p.recompressed));
		return `re-compressed: fits at quality ${s.quality}: ${before} → ${after} bytes, within the limit (${limit - after} to spare); ${tail(s)}`;
	}
	if (on.floorReached === true) {
		const s = summed(on.recompressed);
		const floor = recompressLib.STEPS[recompressLib.STEPS.length - 1];
		if (!s.images) return `re-compressed: stops at the floor (quality ${floor}): no copy was smaller at any step; the batch stays at ${before} bytes, over the limit by ${before - limit} bytes`;
		// The record is the last step that kept a copy, which a failing child can leave above the floor.
		const kept = s.quality === floor ? "" : ` (copies last kept at quality ${s.quality})`;
		return `re-compressed: stops at the floor (quality ${floor}): ${before} → ${after} bytes, over the limit by ${after - limit} bytes; ${tail(s)}${kept}`;
	}
	const why = {
		UNREACHABLE: "re-compressed: not tried: the batch is over by at least its photos' bytes, so no step can fit",
		TOO_MANY: `re-compressed: not tried: more than ${recompressLib.MAX_IMAGES} photos`,
		OUT_OF_TIME: "re-compressed: stopped: the batch's time budget ran out",
		MERGE_FAILED: "re-compressed: stopped: a step's merge failed",
	};
	return why[on.recompressSkipped] || `re-compressed: not measured (${word(on.code)})`;
}

async function run({ argv = [], deps = {} } = {}) {
	const real = batchLib.buildBatch;
	let handed = null;
	batchLib.buildBatch = async (a) => {
		if (!handed) handed = a;
		return real(a);
	};
	let practice;
	try {
		// A load already pressed is measured only when its own claim stopped at BATCH_TOO_LARGE.
		practice = await rehearsal.run({ argv, deps: { ...deps, stoppedClaim: true } });
	} finally {
		batchLib.buildBatch = real;
	}
	const said = (practice.lines || []).filter((l) => !/^Process with Triumph, practice run:/.test(l));
	const last = said.length ? said[said.length - 1] : "no verdict";
	// A refusal's own words can name a path, so only the fact is said.
	if (/^REFUSED:/.test(last)) return { code: 2, lines: [HEADER, `the practice run: refused (code ${Number(practice.code)})`, "not measured: the practice run refused the run"] };
	const lines = [HEADER, `the practice run: ${last} (code ${Number(practice.code)})`];
	if (practice.fromClaim === true) lines.push(CLAIM_SOURCE);
	if (!handed) {
		const pressed = /^the press's checks: would refuse it \(([A-Z][A-Z0-9_]{0,39})\)$/.exec(last);
		const m = /\(([A-Z][A-Z0-9_]{0,39})\)$/.exec(last);
		lines.push(pressed ? `not measured: the press's checks refused it (${pressed[1]})` : `not measured: the build stopped before the batch was put together (${m ? m[1] : "no code"})`);
		return { code: 2, lines };
	}
	const a = { ...handed, recompressor: null };
	const base = await real({ ...a, recompress: false });
	if (!base.ok && base.code !== "BATCH_TOO_LARGE") {
		lines.push(`not measured: the batch builder stopped before the size rule (${word(base.code)})`);
		return { code: 2, lines };
	}
	const limit = Math.min(Number(a.maxBytes) || rules.BATCH_MAX_BYTES, rules.BATCH_MAX_BYTES);
	const before = base.ok ? base.batchBytes : base.pdfBytes + base.csvBytes;
	lines.push(BASE);
	lines.push(base.ok ? `the batch as built today: ${before} bytes, within the limit of ${limit} (${limit - before} to spare)` : `the batch as built today: ${before} bytes, over the limit of ${limit} by ${before - limit} bytes`);
	const photos = await photosOf(a);
	lines.push(`the photos the steps would take: ${photos.photos} of ${plural(photos.images, "page image")} on the BOL and POD pages (${photos.bytes} bytes)`);
	if (base.ok) {
		lines.push("re-compressed: not needed: the batch is within the limit as built today");
		return { code: 0, lines };
	}
	lines.push(stepsLine(await real({ ...a, recompress: true }), before, limit));
	return { code: 0, lines };
}

module.exports = { run, summed, stepsLine };

if (require.main === module) {
	run({ argv: process.argv.slice(2) })
		.then(({ code, lines }) => {
			for (const l of lines) console.log(l);
			process.exit(code);
		})
		.catch((err) => {
			console.error(`ERROR: ${err && err.code ? word(err.code) : "the look failed"}`);
			process.exit(1);
		});
}
