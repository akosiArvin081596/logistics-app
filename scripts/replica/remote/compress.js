#!/usr/bin/env node
// replica:pull, on the server, step 2e: the database copy and the Sheets copy
// are compressed for the download, which then moves about a sixth of the bytes.
//
//   node compress.js --stamp=<stamp>
//
// In /root/logisx-replica-tmp/<stamp>/ (the pull's own folder), app.db and
// sheets.json each become <name>.zst: zstd level 6, one thread, a checksum in
// the frame. The SHA-256 and size of each original, taken in the same pass, go
// to compress.json, and pull.sh checks the decompressed files against them
// before the new snapshot replaces the old one. The originals are then
// removed. It runs after manifest.js (which counts the copy's rows) and reads
// nothing outside the folder. Node's built-in zstd (22.15 and later), so
// nothing is installed on the server.
//
// scripts/test-replica-snapshot.js runs it on temporary files; for that runner
// only, --parent points it at a temporary folder.
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { pipeline } = require("stream/promises");
const rules = require(fs.existsSync(path.join(__dirname, "replica-rules.js")) ? "./replica-rules" : "../../../lib/replica-rules");

const FILES = ["app.db", "sheets.json"];
const LEVEL = 6;

function arg(name) {
	const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
	return hit ? hit.slice(name.length + 3) : undefined;
}

// Compresses `src` into `dest` (created, never overwritten) and returns the
// original's size and SHA-256.
async function compressFile(src, dest) {
	if (typeof zlib.createZstdCompress !== "function") throw new Error(`this Node (${process.version}) has no zstd; 22.15 or later is needed`);
	const hash = crypto.createHash("sha256");
	let bytes = 0;
	await pipeline(
		fs.createReadStream(src),
		async function* (source) {
			for await (const chunk of source) {
				hash.update(chunk);
				bytes += chunk.length;
				yield chunk;
			}
		},
		zlib.createZstdCompress({
			params: {
				[zlib.constants.ZSTD_c_compressionLevel]: LEVEL,
				[zlib.constants.ZSTD_c_checksumFlag]: 1,
				[zlib.constants.ZSTD_c_nbWorkers]: 0,
			},
		}),
		fs.createWriteStream(dest, { flags: "wx", mode: 0o600 }),
	);
	fs.chmodSync(dest, 0o600);
	return { bytes, sha256: hash.digest("hex"), compressed: fs.statSync(dest).size };
}

async function compressFolder(dir) {
	const summary = { step: "compress", codec: "zstd", level: LEVEL, files: [] };
	for (const name of FILES) {
		const src = path.join(dir, name);
		const dest = `${src}.zst`;
		if (!fs.existsSync(src)) throw new Error(`${name} is missing`);
		if (fs.existsSync(dest)) throw new Error(`${name}.zst already exists`);
		summary.files.push({ name, ...(await compressFile(src, dest)) });
	}
	fs.writeFileSync(path.join(dir, "compress.json"), JSON.stringify(summary, null, 2), { mode: 0o600, flag: "wx" });
	for (const name of FILES) fs.rmSync(path.join(dir, name));
	return summary;
}

if (require.main === module) {
	(async () => {
		const stamp = arg("stamp");
		if (!stamp) throw new Error("usage: compress.js --stamp=<stamp>");
		if (!rules.isValidStamp(stamp)) throw new Error("the stamp must be letters, digits, _ and -, starting with a letter or digit");
		const dir = path.join(arg("parent") || rules.REMOTE_TMP_PARENT, stamp);
		const summary = await compressFolder(dir);
		console.log(JSON.stringify({ step: "compress", level: summary.level, files: summary.files.map((f) => ({ name: f.name, mib: +(f.bytes / 1048576).toFixed(1), compressedMib: +(f.compressed / 1048576).toFixed(1) })) }));
	})().catch((err) => {
		console.error(`compress: ${err.message}`);
		process.exit(1);
	});
}

module.exports = { compressFile, compressFolder, FILES, LEVEL };
