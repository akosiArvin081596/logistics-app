"use strict";
// One receipt-OCR job, in its own process — started by runReceiptOcrChild() in
// server.js, which is the only caller. It receives { image, cachePath, langPath }
// once, says { ready: true } when the model has loaded, replies { text } or
// { error }, and exits. Anything that goes wrong in here ends this process,
// never the server: the parent kills it at a deadline and treats a silent exit
// as a failed job — and, only if `ready` never came, as a damaged model.
const fs = require("fs");

function reply(message) {
	try {
		process.send(message, () => process.exit(0));
	} catch {
		process.exit(1);
	}
}

process.once("message", async (job) => {
	try {
		if (!job || !Buffer.isBuffer(job.image)) throw new Error("no image");
		const { createWorker } = require("tesseract.js");
		if (job.cachePath) fs.mkdirSync(job.cachePath, { recursive: true });
		const worker = await createWorker("eng", 1, {
			langPath: job.langPath || undefined,
			cachePath: job.cachePath || undefined,
			// A failed job reports through its own rejection (caught below) — never
			// by throwing from the engine's message listener.
			errorHandler: () => {},
		});
		process.send({ ready: true });
		const { data } = await worker.recognize(job.image);
		reply({ text: String((data && data.text) || "") });
	} catch (err) {
		reply({ error: String((err && err.message) || err).slice(0, 300) });
	}
});

// The server went away (restart, deploy): nobody is waiting for an answer.
process.on("disconnect", () => process.exit(0));
