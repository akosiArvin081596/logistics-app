#!/usr/bin/env node
// replica:pull's local steps (scripts/replica/pull.sh):
//   node pull-local.js progress <label> <log>   reads rsync --progress output on
//                                          stdin and shows it as one status line
//                                          (a line every 30 s when not on a
//                                          terminal); file names are never shown
//                                          or logged; rsync's stats are, as they
//                                          are, and its and ssh's errors are,
//                                          with names, paths and hosts taken out
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
// --stats lines, whole: each ends in a number (openrsync and GNU rsync). They
// count only from "Number of files:" on, which rsync prints after the last
// file name.
const STATS_START = /^Number of files: [\d,]+( \(.*\))?$/;
const STATS = [
	/^Number of [a-z ]+: [\d,]+( \([a-z]+: [\d,]+(, [a-z]+: [\d,]+)*\))?$/,
	/^Total [a-z ]+: [\d,.]+( [A-Za-z]+)?$/,
	/^(Literal|Matched|Unmatched) data: [\d,.]+( [A-Za-z]+)?$/,
	/^File list [a-z ]+: [\d,.]+( [A-Za-z]+)?$/,
	/^sent [\d,.]+ bytes +received [\d,.]+ bytes +[\d,.]+ bytes\/sec$/,
	/^total size is [\d,.]+ +speedup is [\d,.]+$/,
];
// rsync's and ssh's own errors (openrsync prints "rsync(<pid>): error: …").
// They are shown and logged through redact(), as a failed pull's reason.
const ERROR = /^((open)?rsync(\(\d+\))?( error| warning)?: |ssh: |kex_exchange_identification: |sign_and_send_pubkey: |client_loop: |Received disconnect |Disconnected from |Connection (closed|reset|timed out) |Host key verification failed|Permission denied \()/;

// The last part of an openrsync error that is only words: a reason, not a path.
const REASON = /^[A-Za-z][A-Za-z ,'-]*( \(\d+\))?\.?$/;

// An error line without the names in it: quoted text, paths, addresses and
// hosts become placeholders. Of openrsync's "error: <path>: …: <reason>" only
// a reason that is only words stays.
function redact(line) {
	const rs = /^((?:open)?rsync\(\d+\): (?:error|warning): )(.*)$/.exec(line);
	if (rs) {
		const parts = rs[2].split(": ");
		const reason = REASON.test(parts[parts.length - 1]) ? parts[parts.length - 1] : "<…>";
		line = `${rs[1]}${parts.length > 1 ? "<…>: " : ""}${reason}`;
	}
	return line
		.replace(/"[^"]*"|'[^']*'/g, '"<…>"')
		.replace(/(^|[\s(=])\/[^\s:"')]+/g, "$1<path>")
		.replace(/\b\d{1,3}(\.\d{1,3}){3}\b/g, "<address>")
		.replace(/\b[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){2,7}\b|(?:\b[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)?::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*\b)?/gi, "<address>")
		.replace(/\bhost(name)? (?!<)[^\s:]+/g, "host$1 <host>")
		.replace(/\b(from|by) (?!<)(?=[\w.-]*[.\d])[\w.-]+/g, "$1 <host>");
}

// A file's last progress line ends "(xfer#N, to-check=…)" (GNU: "(xfr#N, …)").
const FILE_DONE = /\(xfe?r#\d+/;

// Shows rsync --progress output as one status line: the bytes so far over all
// files, the rate, and the current file's percent and time left. On a terminal
// the line is redrawn in place; elsewhere it is printed at most once per
// `every` ms, and its latest state once more before the stats. rsync's stats
// pass as they are, and its and ssh's errors pass redacted, to the screen and
// the log. Any other line is a file name: never shown, never logged (the
// uploads folders' names can be personal).
function progressFilter({ label, tty, write, log, now = Date.now, every = 30000 }) {
	let rest = "";
	let done = 0;
	let latest = null;
	let shownAt = null;
	let unshown = false;
	let open = false;
	let inStats = false;
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
		const bare = line.trim();
		if (STATS_START.test(bare)) inStats = true;
		let pass = null;
		if (inStats && STATS.some((re) => re.test(bare))) pass = bare;
		else if (ERROR.test(bare)) pass = redact(bare);
		if (pass !== null) {
			closeLine();
			write(`${pass}\n`);
			log(pass);
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
// result's size and SHA-256. zstd checks the frame's checksum only when the
// frame is whole: a cut-off file can decompress short without an error, so the
// size and SHA-256 comparison in unpack() is what decides.
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
// Anything else fails the pull before the clean snapshot is touched, and
// removes every file this run decompressed. The .zst files go only once every
// file has matched.
async function unpack(incoming, say = console.log) {
	const summaryFile = path.join(incoming, "compress.json");
	if (!fs.existsSync(summaryFile)) throw new Error("the download has no compress.json");
	const summary = readJson(summaryFile);
	const files = Array.isArray(summary.files) ? summary.files : [];
	const names = files.map((f) => f && f.name).sort();
	if (summary.codec !== "zstd" || JSON.stringify(names) !== JSON.stringify([...COMPRESSED_FILES].sort())) {
		throw new Error("compress.json does not list the files the server compresses");
	}
	const written = [];
	try {
		for (const f of files) {
			const zst = path.join(incoming, `${f.name}.zst`);
			const out = path.join(incoming, f.name);
			if (!fs.existsSync(zst)) throw new Error(`the download has no ${f.name}.zst`);
			if (fs.existsSync(out)) throw new Error(`${f.name} is already in the download folder; nothing was overwritten`);
			const size = fs.statSync(zst).size;
			if (size !== f.compressed) throw new Error(`${f.name}.zst is ${size} bytes, the server made ${f.compressed}: the download is incomplete`);
			let got;
			try {
				got = await decompressFile(zst, out);
			} catch (err) {
				throw new Error(`${f.name}.zst does not decompress (${err.message}): the download is damaged`);
			}
			written.push(out);
			if (got.bytes !== f.bytes || got.sha256 !== f.sha256) {
				throw new Error(`${f.name} decompressed to ${got.bytes} bytes with SHA-256 ${got.sha256}; the server's was ${f.bytes} bytes, ${f.sha256}`);
			}
		}
	} catch (err) {
		for (const out of written) fs.rmSync(out, { force: true });
		throw err;
	}
	for (const f of files) {
		fs.rmSync(path.join(incoming, `${f.name}.zst`));
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
