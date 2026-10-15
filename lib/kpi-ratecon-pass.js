"use strict";
// THE KPI JOB'S RATE-CON PASS: one pass over the delivered loads' rate-con PDFs
// that feeds two parsers, the freight weight (lib/kpi-weight.js, table
// kpi_load_weights) and the stated miles (lib/kpi-ratecon-miles.js, table
// kpi_load_ratecon_miles, R10).
//
//   ensureTables(db)
//   runRateconPass({ db, loads, day, timeZone, deadlineMs, maxLoads, weightTextRule,
//                    openSources, readText, within, pause, now })
//       -> { driveFetches, checked, codes }
//   checkedToday(db, day, timeZone, nowMs) -> loads checked that business day
//
// WHICH LOADS. Delivered loads with a Load ID that are a candidate for either
// table, newest first:
//   weight  no row yet; or a not_found / error row older than 30 days; or a
//           no_text row from an earlier text rule; and Details state no weight
//   miles   no row under the current MILES_TEXT_RULE; or a not_found / error row
//           older than 30 days (Details never stand in for a rate con's miles)
//
// ONE DOWNLOAD, TWO PARSERS. A load's first source (the stored RATECON document,
// else the newest matching Drive file; the server supplies `openSources`) is read
// once and its text goes to both parsers. The weight keeps that answer. Only the
// miles parser reads the NEXT source (the next-newest Drive file from the same
// list), and only when the first gave no_text or not_found: at most 2 downloads
// a load, never after ok, none_stated, no_miles or conflict.
//
// CRASH SAFETY. Before anything is fetched, the load gets an 'error' row in each
// table it is a candidate for, so a file that takes the process down is not
// fetched again for 30 days. A failure is stored as 'error' with a code for the
// run; never its message.
//
// THE BUDGET. maxLoads per business day (APP_TIMEZONE), whatever the number of
// runs: the loads already checked that day in EITHER table count against it,
// once each. The nightly run passes NIGHTLY_MAX_LOADS (40); the one-off
// backfill BACKFILL_MAX_LOADS (200).
//
// No file name and no text from a document is kept: rows hold figures, a
// status, a file id and a size.
//
// Takes the database handle and the I/O it needs as arguments (openSources,
// readText); no network or file access of its own. Requires lib/kpi-weight.js,
// lib/kpi-ratecon-miles.js and lib/app-time.js, all pure.

const kpiWeight = require("./kpi-weight");
const kpiRateconMiles = require("./kpi-ratecon-miles");
const { dayInZone } = require("./app-time");

const MILES_TEXT_RULE = 1;
const NIGHTLY_MAX_LOADS = 40;
const BACKFILL_MAX_LOADS = 200;
const RETRY_MS = 30 * 24 * 60 * 60 * 1000;
const DELIVERED_RE = /^(delivered|completed|pod received)$/i;
// Statuses after which the miles parser reads the next source.
const NEXT_SOURCE_STATUSES = new Set(["no_text", "not_found"]);

// One row per load: the stated loaded and empty miles of its rate con. load_id
// is the normalised key (lowercase, leading '#' dropped). status: ok |
// none_stated | no_miles | conflict | no_text | too_large | not_found | error;
// not_found and error are tried again after 30 days, every other status is
// final under its text_rule.
const MILES_TABLE_DDL = `
	CREATE TABLE IF NOT EXISTS kpi_load_ratecon_miles (
		load_id TEXT PRIMARY KEY,
		loaded_miles REAL,
		empty_miles REAL,
		status TEXT NOT NULL,
		file_id TEXT NOT NULL DEFAULT '',
		file_size INTEGER,
		checked_at TEXT NOT NULL,
		text_rule INTEGER NOT NULL DEFAULT 1
	)
`;

function ensureTables(db) {
	db.exec(MILES_TABLE_DDL);
}

const finite = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const youngerThanRetry = (row, nowMs) => nowMs - Date.parse(row.checked_at) < RETRY_MS;

function weightWanted(load, row, nowMs, weightTextRule) {
	if (row) {
		const retry = ((row.status === "not_found" || row.status === "error") && !youngerThanRetry(row, nowMs))
			|| (row.status === "no_text" && (Number(row.text_rule) || 1) < weightTextRule);
		if (!retry) return false;
	}
	return kpiWeight.parseWeight(load.detailsText).status !== "ok";
}

function milesWanted(row, nowMs) {
	if (!row) return true;
	if ((Number(row.text_rule) || 0) < MILES_TEXT_RULE) return true;
	return (row.status === "not_found" || row.status === "error") && !youngerThanRetry(row, nowMs);
}

// Loads checked on business day `day`, in either table, each once.
function checkedToday(db, day, timeZone, nowMs) {
	const since = new Date(nowMs - 2 * 86400000).toISOString();
	const ids = new Set();
	for (const table of ["kpi_load_weights", "kpi_load_ratecon_miles"]) {
		for (const r of db.prepare(`SELECT load_id, checked_at FROM ${table} WHERE checked_at >= ?`).all(since)) {
			const ms = Date.parse(r.checked_at);
			if (Number.isFinite(ms) && dayInZone(new Date(ms), timeZone) === day) ids.add(r.load_id);
		}
	}
	return ids.size;
}

// A source's text, once: { text, size } or { status, size } when too large.
function readSource(src, readText) {
	const size = finite(src.fileSize) != null ? src.fileSize : src.buffer.length;
	if (size > kpiWeight.MAX_PDF_BYTES) return { status: "too_large", size };
	return { text: readText(src.buffer), size };
}

function weightFrom(read) {
	if (read.status) return { status: read.status, weightLb: null };
	const cls = kpiWeight.classifyPdfText(read.text, read.size);
	if (cls !== "ok") return { status: cls, weightLb: null };
	const w = kpiWeight.parseWeight(read.text);
	if (w.status === "ok") return { status: "ok", weightLb: w.weightLb };
	return { status: w.status === "conflict" ? "conflict" : "no_weight", weightLb: null };
}

function milesFrom(read) {
	if (read.status) return { status: read.status, loadedMiles: null, emptyMiles: null };
	return kpiRateconMiles.milesFromPdfText(read.text, read.size);
}

async function runRateconPass(args) {
	const a = args;
	const now = typeof a.now === "function" ? a.now : () => Date.now();
	const within = typeof a.within === "function" ? a.within : (p) => p;
	const pause = typeof a.pause === "function" ? a.pause : async () => {};
	const out = { driveFetches: 0, checked: 0, codes: new Set() };
	const db = a.db;
	const nowMs = now();
	const budget = Math.max(0, (a.maxLoads || NIGHTLY_MAX_LOADS) - checkedToday(db, a.day, a.timeZone, nowMs));

	const weightRows = new Map(db.prepare("SELECT load_id, status, checked_at, text_rule FROM kpi_load_weights").all().map((r) => [r.load_id, r]));
	const milesRows = new Map(db.prepare("SELECT load_id, status, checked_at, text_rule FROM kpi_load_ratecon_miles").all().map((r) => [r.load_id, r]));
	const candidates = [];
	const seen = new Set();
	for (const load of Array.isArray(a.loads) ? a.loads : []) {
		if (!load || !load.loadId || seen.has(load.loadId) || !DELIVERED_RE.test(String(load.status || "").trim())) continue;
		seen.add(load.loadId);
		const weight = weightWanted(load, weightRows.get(load.loadId), nowMs, a.weightTextRule);
		const miles = milesWanted(milesRows.get(load.loadId), nowMs);
		if (weight || miles) candidates.push({ load, weight, miles });
	}
	candidates.sort((x, y) => String(y.load.day || "").localeCompare(String(x.load.day || "")));

	const upsertWeight = db.prepare(`
		INSERT INTO kpi_load_weights (load_id, weight_lb, source, status, file_id, file_size, checked_at, text_rule)
		VALUES (?, ?, 'ratecon_pdf', ?, ?, ?, ?, ?)
		ON CONFLICT(load_id) DO UPDATE SET
			weight_lb = excluded.weight_lb, source = excluded.source, status = excluded.status,
			file_id = excluded.file_id, file_size = excluded.file_size, checked_at = excluded.checked_at, text_rule = excluded.text_rule
	`);
	const upsertMiles = db.prepare(`
		INSERT INTO kpi_load_ratecon_miles (load_id, loaded_miles, empty_miles, status, file_id, file_size, checked_at, text_rule)
		VALUES (?, ?, ?, ?, ?, ?, ?, ${MILES_TEXT_RULE})
		ON CONFLICT(load_id) DO UPDATE SET
			loaded_miles = excluded.loaded_miles, empty_miles = excluded.empty_miles, status = excluded.status,
			file_id = excluded.file_id, file_size = excluded.file_size, checked_at = excluded.checked_at, text_rule = excluded.text_rule
	`);
	const stamp = () => new Date(now()).toISOString();

	for (const c of candidates.slice(0, budget)) {
		if (now() >= a.deadlineMs) {
			out.codes.add("RATECON_TIME_LIMIT");
			break;
		}
		const id = c.load.loadId;
		if (c.weight) upsertWeight.run(id, null, "error", "", null, stamp(), a.weightTextRule);
		if (c.miles) upsertMiles.run(id, null, null, "error", "", null, stamp());
		let weight = { status: "error", weightLb: null, fileId: "", fileSize: null };
		let miles = { status: "error", loadedMiles: null, emptyMiles: null, fileId: "", fileSize: null };
		try {
			const sources = a.openSources(id, out, a.deadlineMs);
			const first = await within(sources.first(), a.deadlineMs - now());
			if (!first) {
				weight = { status: "not_found", weightLb: null, fileId: "", fileSize: null };
				miles = { status: "not_found", loadedMiles: null, emptyMiles: null, fileId: "", fileSize: null };
			} else if (first.status) {
				weight = { status: first.status, weightLb: null, fileId: first.fileId || "", fileSize: finite(first.fileSize) };
				miles = { status: first.status, loadedMiles: null, emptyMiles: null, fileId: first.fileId || "", fileSize: finite(first.fileSize) };
			} else {
				const read = readSource(first, a.readText);
				weight = { ...weightFrom(read), fileId: first.fileId || "", fileSize: read.size };
				miles = { ...milesFrom(read), fileId: first.fileId || "", fileSize: read.size };
			}
			if (c.miles && NEXT_SOURCE_STATUSES.has(miles.status)) {
				const second = await within(sources.next(), a.deadlineMs - now());
				if (second && second.status) {
					miles = { status: second.status, loadedMiles: null, emptyMiles: null, fileId: second.fileId || "", fileSize: finite(second.fileSize) };
				} else if (second) {
					const read = readSource(second, a.readText);
					miles = { ...milesFrom(read), fileId: second.fileId || "", fileSize: read.size };
				}
			}
		} catch (e) {
			weight = { status: "error", weightLb: null, fileId: "", fileSize: null };
			miles = { status: "error", loadedMiles: null, emptyMiles: null, fileId: "", fileSize: null };
			out.codes.add(e && e.kpiCode === "TIME_LIMIT" ? "RATECON_TIME_LIMIT" : "RATECON_FETCH_FAILED");
		}
		if (c.weight) upsertWeight.run(id, finite(weight.weightLb), weight.status, weight.fileId || "", finite(weight.fileSize), stamp(), a.weightTextRule);
		if (c.miles) upsertMiles.run(id, finite(miles.loadedMiles), finite(miles.emptyMiles), miles.status, miles.fileId || "", finite(miles.fileSize), stamp());
		out.checked++;
		await pause();
	}
	return out;
}

module.exports = {
	MILES_TEXT_RULE,
	NIGHTLY_MAX_LOADS,
	BACKFILL_MAX_LOADS,
	RETRY_MS,
	ensureTables,
	checkedToday,
	runRateconPass,
};
