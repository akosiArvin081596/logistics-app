"use strict";
// One photo of a Triumph batch re-compressed at a given quality, in its own process: started by
// lib/triumph-batch-recompress.js, the only caller. It receives { image, quality } once, replies
// { jpeg } or { error } exactly once, and exits. The image is decoded and written again as a JPEG
// of the same width and height: there is no resize step. Its bytes come already stripped by
// lib/image-metadata.js, so they hold no EXIF orientation and the decode turns nothing. Anything
// that goes wrong ends this process, never the server: the parent kills it at its deadline.

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
		const quality = Number(job.quality);
		if (!Number.isInteger(quality) || quality < 1 || quality > 100) throw new Error("no quality");
		const { Jimp } = require("jimp");
		const img = await Jimp.read(image);
		if (!(img.bitmap.width > 0 && img.bitmap.height > 0)) throw new Error("no pixels");
		reply({ jpeg: await img.getBuffer("image/jpeg", { quality }) });
	} catch (err) {
		reply({ error: describe(err) });
	}
});

// The server went away (restart, deploy): nobody is waiting for an answer.
process.on("disconnect", () => process.exit(0));
