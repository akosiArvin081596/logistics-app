"use strict";
// One number for the image children the server runs at once (a decode in a process of its own), and
// the upload lane's share of it. Three lanes start such children:
//   the receipt lane (lib/receipt-images.js): one at a time, by its own queue;
//   way 1's lane (lib/triumph-batch-recompress.js): one at a time, by its own chain, only inside the
//     Triumph job and only while TRIUMPH_BATCH_IMAGE_RECOMPRESS_ENABLED is on;
//   the upload lane (lib/pod-upload-shape.js): the POD and BOL photos shaped at upload.
// The first two are not changed here. Their slots are held for them by number (`reserved`), whether
// or not their child is running, so the upload lane never takes one and never makes them wait: it
// holds what is left, and never more than IMAGE_CHILD_CAP - 1.
//
// take() answers a release function (call it once, when the child has ended), BUSY when the queue is
// full, or null when the job must not start: its upload's time ran out while it waited, or its
// upload has answered (`live()` false). A job is checked again at the moment its turn comes, so a job
// whose upload has answered never starts.

const IMAGE_CHILD_CAP = 3;
// Uploads waiting for a slot at once; one more is answered BUSY at once (the page goes as it came).
const UPLOAD_QUEUE_CAP = 20;
const BUSY = "busy";

function createUploadSlots({ cap = IMAGE_CHILD_CAP, reserved = 1, queueCap = UPLOAD_QUEUE_CAP, now = Date.now } = {}) {
	const max = Math.max(1, Math.min(cap - 1, cap - reserved));
	let held = 0;
	let started = 0;
	const waiting = [];

	function releaser() {
		let done = false;
		return () => {
			if (done) return;
			done = true;
			held -= 1;
			grant();
		};
	}

	function grant() {
		while (held < max && waiting.length) {
			const w = waiting.shift();
			clearTimeout(w.timer);
			if (!w.live()) {
				w.resolve(null);
				continue;
			}
			held += 1;
			started += 1;
			w.resolve(releaser());
		}
	}

	function take({ until = Infinity, live = () => true } = {}) {
		const stillLive = () => Boolean(live()) && now() < until;
		if (!stillLive()) return Promise.resolve(null);
		if (held < max && !waiting.length) {
			held += 1;
			started += 1;
			return Promise.resolve(releaser());
		}
		if (waiting.length >= queueCap) return Promise.resolve(BUSY);
		return new Promise((resolve) => {
			const w = { resolve, live: stillLive, timer: null };
			if (Number.isFinite(until)) {
				w.timer = setTimeout(() => {
					const at = waiting.indexOf(w);
					if (at >= 0) waiting.splice(at, 1);
					resolve(null);
				}, Math.max(0, until - now()));
				if (w.timer && typeof w.timer.unref === "function") w.timer.unref();
			}
			waiting.push(w);
		});
	}

	return Object.freeze({
		take,
		stats: () => ({ max, held, waiting: waiting.length, started }),
	});
}

module.exports = { IMAGE_CHILD_CAP, UPLOAD_QUEUE_CAP, BUSY, createUploadSlots };
