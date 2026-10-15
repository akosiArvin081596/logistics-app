"use strict";
// One receipt-image re-encode, in its own process — started by
// lib/receipt-images.js, the only caller. It receives { image, maxEdge, quality,
// retryQuality, maxBytes } once, replies { jpeg } or { error } exactly once, and
// exits. The image is decoded (jimp applies its EXIF orientation as it reads),
// scaled down — never up — so its long edge is at most maxEdge, and written as a
// new JPEG from the decoded pixels: no EXIF, XMP, GPS, ICC profile or PNG text
// chunk is carried over. A JPEG over maxBytes is written once more at
// retryQuality; still over, it is refused. Anything that goes wrong ends this
// process, never the server: the parent kills it at its deadline.

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
		const maxEdge = Number(job.maxEdge) > 0 ? Number(job.maxEdge) : 1600;
		const maxBytes = Number(job.maxBytes) > 0 ? Number(job.maxBytes) : 1.5 * 1024 * 1024;
		const { Jimp } = require("jimp");
		const img = await Jimp.read(image);
		const { width, height } = img.bitmap;
		if (!(width > 0 && height > 0)) throw new Error("no pixels");
		const scale = Math.min(1, maxEdge / Math.max(width, height));
		if (scale < 1) img.resize({ w: Math.max(1, Math.round(width * scale)), h: Math.max(1, Math.round(height * scale)) });
		let jpeg = await img.getBuffer("image/jpeg", { quality: Number(job.quality) || 80 });
		if (jpeg.length > maxBytes) jpeg = await img.getBuffer("image/jpeg", { quality: Number(job.retryQuality) || 60 });
		if (jpeg.length > maxBytes) throw new Error("re-encoded image is still over the size cap");
		reply({ jpeg });
	} catch (err) {
		reply({ error: describe(err) });
	}
});

// The server went away (restart, deploy): nobody is waiting for an answer.
process.on("disconnect", () => process.exit(0));
