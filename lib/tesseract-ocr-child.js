"use strict";
// One receipt-OCR job, in its own process — started by runReceiptOcrChild() in
// server.js, which is the only caller. It receives { image, cachePath, langPath }
// once, says { ready: true } when the model has loaded, replies { text } or
// { error } exactly once, and exits. Anything that goes wrong in here ends this
// process, never the server: the parent kills it at a deadline, and treats a job
// that failed before `ready` — reported or a silent exit — as a damaged model.
const fs = require("fs");

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
	let ready = false;
	try {
		if (!job || !Buffer.isBuffer(job.image)) throw new Error("no image");
		const { createWorker } = require("tesseract.js");
		if (job.cachePath) fs.mkdirSync(job.cachePath, { recursive: true });
		const worker = await createWorker("eng", 1, {
			langPath: job.langPath || undefined,
			cachePath: job.cachePath || undefined,
			// Failures arrive here instead of being thrown from the engine's message
			// listener. One that arrives before the model has loaded IS the answer: a
			// model that cannot be fetched or read leaves createWorker() waiting for
			// good, and the server would otherwise wait out its whole deadline.
			errorHandler: (err) => { if (!ready) reply({ error: describe(err) }); },
		});
		ready = true;
		process.send({ ready: true });
		const { data } = await worker.recognize(job.image);
		reply({ text: String((data && data.text) || "") });
	} catch (err) {
		reply({ error: describe(err) });
	}
});

// The server went away (restart, deploy): nobody is waiting for an answer.
process.on("disconnect", () => process.exit(0));
