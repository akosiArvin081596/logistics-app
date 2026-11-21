"use strict";
// One POD or BOL photo brought under the page budget at upload, in its own process: started by
// lib/pod-upload-shape.js, the only caller. It receives { image, steps, budget } once, decodes the
// image once, writes it again as a JPEG of the same width and height at each quality in `steps` in
// turn, and replies { jpeg, quality } for the first copy at or under `budget` bytes, { over: true }
// when none is, or { error } — exactly once — and exits. There is no resize step. Its bytes come
// already stripped by lib/image-metadata.js and upright (orientation 1), so the decode turns nothing.
// Anything that goes wrong ends this process, never the server: the parent kills it at its deadline.

let replied = false;
function reply(message) {
	if (replied) return;
	replied = true;
	try {
		process.send(message, () => process.exit(0));
	} catch {
		process.exit(1);
	}
}
const describe = (err) => String((err && err.message) || err).slice(0, 300);

process.once("message", async (job) => {
	try {
		// The parent's Buffer can arrive as a plain Uint8Array over the IPC channel.
		const image = job && job.image instanceof Uint8Array ? Buffer.from(job.image.buffer, job.image.byteOffset, job.image.byteLength) : null;
		if (!image) throw new Error("no image");
		const steps = Array.isArray(job.steps) ? job.steps.map(Number) : [];
		if (!steps.length || steps.some((q) => !Number.isInteger(q) || q < 1 || q > 100)) throw new Error("no steps");
		const budget = Number(job.budget);
		if (!Number.isInteger(budget) || budget < 1) throw new Error("no budget");
		const { Jimp } = require("jimp");
		const img = await Jimp.read(image);
		if (!(img.bitmap.width > 0 && img.bitmap.height > 0)) throw new Error("no pixels");
		for (const quality of steps) {
			const jpeg = await img.getBuffer("image/jpeg", { quality });
			if (jpeg.length <= budget) return reply({ jpeg, quality });
		}
		reply({ over: true });
	} catch (err) {
		reply({ error: describe(err) });
	}
});

// The server went away (restart, deploy): nobody is waiting for an answer.
process.on("disconnect", () => process.exit(0));
