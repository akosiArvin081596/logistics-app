#!/usr/bin/env node
// replica:pull's local steps (scripts/replica/pull.sh):
//   node pull-local.js progress <label> <log>   reads rsync --progress output on
//                                          stdin and shows it as one status line
//                                          (a line every 30 s when not on a
//                                          terminal); file names are never shown
//                                          or logged, rsync's stats and errors
//                                          are both
//   node pull-local.js unpack <incoming>   decompresses the .zst files the server
//                                          made (compress.js) and checks each
//                                          against the size and SHA-256 the server
//                                          recorded in compress.json
//   node pull-local.js verify <incoming>   the download is whole: the database
//                                          passes SQLite's quick_check, the
//                                          Sheets copy and settings are there
//   node pull-local.js finish <incoming>   records the copied files' counts and
//                                          sizes in the manifest, then prints
//                                          the summary (names and counts only)
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { pipeline } = require("stream/promises");
const { paths, DATA_FOLDERS, readJson, writePrivate, dirStats, mib, fail } = require("./common");
const { FILES: COMPRESSED_FILES } = require("./remote/compress");

// rsync's --progress line: bytes so far, percent, rate, time left (GNU rsync
// and openrsync print the same shape; GNU puts commas in the bytes).
const PROGRESS = /^\s*([\d,]+)\s+(\d{1,3})%\s+(\S+\/s)\s+(\d+:\d{2}:\d{2})/;
// Lines passed through as they are: --stats, and rsync's own errors.
const PASS = /^(Number of |Total |Literal data|Matched data|Unmatched data|File list |sent \d|total size is|(open)?rsync( error| warning)?:)/;

// A file's last progress line ends "(xfer#N, to-check=…)" (GNU: "(xfr#N, …)").
const FILE_DONE = /\(xfe?r#\d+/;

// Shows rsync --progress output as one status line: the bytes so far over all
// files, the rate, and the current file's percent and time left. On a terminal
// the line is redrawn in place; elsewhere it is printed at most once per
// `every` ms, and its latest state once more before the stats. Any other line
// is a file name: never shown, never logged (the uploads folders' names can be
// personal).
function progressFilter({ label, tty, write, log, now = Date.now, every = 30000 }) {
	let rest = "";
	let done = 0;
	let latest = null;
	let shownAt = null;
	let unshown = false;
	let open = false;
	const status = () => `${label}: ${mib(done + latest.bytes)} so far, ${latest.rate}` +
		(latest.pct < 100 ? `; this file ${latest.pct}%, ${latest.eta} left` : "");
	const closeLine = () => {
		if (open) write("\n");
		open = false;
		if (unshown) write(`${status()}\n`);
		unshown = false;
	};
	const segment = (text) => {
		const line = text.trimEnd();
		if (!line.trim()) return;
		const m = PROGRESS.exec(line);
		if (m) {
			latest = { bytes: Number(m[1].replace(/,/g, "")), pct: Number(m[2]), rate: m[3], eta: m[4] };
			if (tty) {
				write(`\r${status()}\x1b[K`);
				open = true;
			} else if (shownAt === null || now() - shownAt >= every) {
				write(`${status()}\n`);
				shownAt = now();
				unshown = false;
			} else {
				unshown = true;
			}
			if (FILE_DONE.test(line)) {
				done += latest.bytes;
				latest = { ...latest, bytes: 0 };
			}
			return;
		}
		if (PASS.test(line.trimStart())) {
			closeLine();
			write(`${line.trimStart()}\n`);
			log(line.trimStart());
		}
	};
	return {
		push(chunk) {
			const parts = (rest + chunk).split(/[\r\n]/);
			rest = parts.pop();
			for (const p of parts) segment(p);
		},
		end() {
			segment(rest);
			rest = "";
			closeLine();
		},
	};
}

function runProgress(label, logFile) {
	if (!label || !logFile) fail("usage: pull-local.js progress <label> <log>");
	const f = progressFilter({
		label,
		tty: !!process.stdout.isTTY,
		write: (s) => process.stdout.write(s),
		log: (line) => fs.appendFileSync(logFile, `${line}\n`, { mode: 0o600 }),
	});
	process.stdin.setEncoding("utf8");
	process.stdin.on("data", (chunk) => f.push(chunk));
	process.stdin.on("end", () => f.end());
}

// Decompresses `src` into `dest` (created, never overwritten) and returns the
// result's size and SHA-256. zstd checks the frame's own checksum on the way.
async function decompressFile(src, dest) {
	if (typeof zlib.createZstdDecompress !== "function") throw new Error(`this Node (${process.version}) has no zstd; use the .nvmrc version (fnm use)`);
	const hash = crypto.createHash("sha256");
	let bytes = 0;
	try {
		await pipeline(
			fs.createReadStream(src),
			zlib.createZstdDecompress(),
			async function* (source) {
				for await (const chunk of source) {
					hash.update(chunk);
					bytes += chunk.length;
					yield chunk;
				}
			},
			fs.createWriteStream(dest, { flags: "wx", mode: 0o600 }),
		);
	} catch (err) {
		if (err.code !== "EEXIST") fs.rmSync(dest, { force: true });
		throw err;
	}
	return { bytes, sha256: hash.digest("hex") };
}

// Each compressed file must arrive at the size the server made it, and
// decompress to the size and SHA-256 the server recorded for the original.
// Anything else fails the pull before the clean snapshot is touched.
async function unpack(incoming, say = console.log) {
	const summaryFile = path.join(incoming, "compress.json");
	if (!fs.existsSync(summaryFile)) throw new Error("the download has no compress.json");
	const summary = readJson(summaryFile);
	const files = Array.isArray(summary.files) ? summary.files : [];
	const names = files.map((f) => f && f.name).sort();
	if (summary.codec !== "zstd" || JSON.stringify(names) !== JSON.stringify([...COMPRESSED_FILES].sort())) {
		throw new Error("compress.json does not list the files the server compresses");
	}
	for (const f of files) {
		const zst = path.join(incoming, `${f.name}.zst`);
		const out = path.join(incoming, f.name);
		if (!fs.existsSync(zst)) throw new Error(`the download has no ${f.name}.zst`);
		const size = fs.statSync(zst).size;
		if (size !== f.compressed) throw new Error(`${f.name}.zst is ${size} bytes, the server made ${f.compressed}: the download is incomplete`);
		let got;
		try {
			got = await decompressFile(zst, out);
		} catch (err) {
			throw new Error(`${f.name}.zst does not decompress (${err.message}): the download is damaged`);
		}
		if (got.bytes !== f.bytes || got.sha256 !== f.sha256) {
			fs.rmSync(out, { force: true });
			throw new Error(`${f.name} decompressed to ${got.bytes} bytes with SHA-256 ${got.sha256}; the server's was ${f.bytes} bytes, ${f.sha256}`);
		}
		fs.rmSync(zst);
		say(`unpacked ${f.name}: ${mib(f.compressed)} downloaded, ${mib(f.bytes)} decompressed, SHA-256 matches the server's`);
	}
}

function verify(incoming) {
	const Database = require(path.join(__dirname, "..", "..", "node_modules", "better-sqlite3"));
	for (const f of ["app.db", "sheets.json", "settings.env", "manifest.json"]) {
		if (!fs.existsSync(path.join(incoming, f))) fail(`the download has no ${f}`);
	}
	const db = new Database(path.join(incoming, "app.db"), { readonly: true, fileMustExist: true });
	const check = db.pragma("quick_check", { simple: true });
	db.close();
	if (check !== "ok") fail(`the downloaded database failed quick_check: ${String(check).slice(0, 200)}`);
	const sheets = readJson(path.join(incoming, "sheets.json"));
	if (sheets.format !== 1 || !Object.keys(sheets.spreadsheets || {}).length) fail("the downloaded Sheets copy is not a replica working copy");
	console.log("download verified: database quick_check ok; Sheets copy and settings present");
}

function finish(incoming) {
	const manifestFile = path.join(incoming, "manifest.json");
	const m = readJson(manifestFile);
	m.pulledAt = new Date().toISOString();
	const compressFile = path.join(incoming, "compress.json");
	if (fs.existsSync(compressFile)) {
		const c = readJson(compressFile);
		m.download = { codec: c.codec, level: c.level, files: c.files };
	}
	m.files = {};
	for (const d of DATA_FOLDERS) m.files[d] = dirStats(paths.data(d));
	writePrivate(manifestFile, JSON.stringify(m, null, 2));

	const rows = m.database.rows;
	console.log(`production commit ${m.production.commit}; Node ${m.production.node}; time zone ${m.production.timeZone} (${m.production.timeZoneSource})`);
	console.log(`database: ${Object.keys(rows).length} tables, ${Object.values(rows).reduce((a, b) => a + b, 0)} rows`);
	for (const s of (m.sheets && m.sheets.spreadsheets) || []) {
		console.log(s.error ? `sheets (${s.role}): not copied (${s.error})` : `sheets (${s.role}): ${s.tabs} tabs, ${s.rows} rows`);
	}
	for (const c of (m.scrub && m.scrub.cleared) || []) console.log(`cleared ${c.table}.${c.column}: ${c.rows} row(s), ${c.how}`);
	if (m.settings) {
		console.log(`settings copied (${m.settings.copied.length}): ${m.settings.copied.join(", ") || "none"}`);
		for (const s of m.settings.skipped) console.log(`settings skipped: ${s.name} (${s.rule})`);
	}
	for (const d of DATA_FOLDERS) console.log(`files ${d}/: ${m.files[d].files} files, ${mib(m.files[d].bytes)}`);
}

if (require.main === module) {
	const [cmd, target, extra] = process.argv.slice(2);
	if (cmd === "progress") runProgress(target, extra);
	else if (!cmd || !target) fail("usage: pull-local.js progress <label> <log> | unpack|verify|finish <incoming folder>");
	else if (cmd === "unpack") unpack(target).catch((err) => fail(err.message));
	else if (cmd === "verify") verify(target);
	else if (cmd === "finish") finish(target);
	else fail(`unknown command ${cmd}`);
}

module.exports = { progressFilter, decompressFile, unpack };
