#!/usr/bin/env node
// Read-only report for automatic broker invoice drafts (AUTO_INVOICE_DRAFTS_ENABLED).
//
// Without --retro: the shadow-week report, the "what would change" report before
// real drafts are switched on. It reads the shadow log the job keeps in shadow mode
// (auto_invoice_shadow) for loads first seen completed in a window, beside the
// drafts people made (load_invoice_drafts):
//   - the verdict split with reasons;
//   - WOULD_ATTEMPT loads drafted by hand, compared as below (A / B / C), and (D)
//     those nobody drafted in the window;
//   - hand drafts on loads the job would have waited on, skipped or handed to a
//     person, by verdict;
//   - the median hours from first seen completed to the first hand draft;
//   - per broker domain: first seen, WOULD_ATTEMPT, drafted by hand;
//   - from the claims (once real drafts ran, e.g. after a rollback), every claim
//     whose draft may be in Gmail unrecorded and every reserved number not used:
//     load suffix and invoice number, so a person can check Gmail.
//
//   node scripts/auto-invoice-shadow-report.js --db=<app.db> [--since=YYYY-MM-DD] [--until=YYYY-MM-DD] [--json]
//
// --retro: the sizing run, on a copy of production (the replica). For every load
// delivered in a window it asks what the automatic job would have done, by the
// job's own rules (lib/auto-invoice-rules.js), as if no hand draft existed, and
// sets that beside the drafts people made with the Draft Invoice button:
//   - delivered loads in the window, and the button drafts made in it;
//   - the WOULD_ATTEMPT / WOULD_WAIT / WOULD_NEED_ATTENTION / WOULD_SKIP split,
//     with reason codes;
//   - for WOULD_ATTEMPT loads drafted by hand: (A) the hand draft went where the
//     job would send it and nothing was edited, (B) the recipient rule would hand
//     it to a person, (C) fields were edited (named, never their values);
//   - per broker domain: delivered loads, WOULD_ATTEMPT, loads with a button
//     draft, button drafts made in the window.
// The delivered day is the sheet's Completion Date, else the upload time of the
// load's first live POD row, else "date unknown" (counted on their own). The
// closed-month check is not applied: a month closed today was open when the load
// was delivered. Opt-outs are none (none are set yet) and Bison's recipient is
// taken as configured (production sets it).
//
//   node scripts/auto-invoice-shadow-report.js --retro --db=<app.db>
//     (--sheets-json=<sheets.json> | --values-json=<values.json>)
//     [--uploads=<uploads dir>] [--since=YYYY-MM-DD] [--until=YYYY-MM-DD] [--json]
//
// --db: opened read-only (a missing file is refused, never created).
// --sheets-json: a replica Sheets working copy (scripts/replica: format 1, the
// spreadsheet whose role is "main", its "Job Tracking" tab); --values-json: a saved
// values.get of Job Tracking ({ values: [...] }). --uploads: the folder the POD
// files live in; without it a POD row counts as readable and the report says so.
// --since/--until: calendar days in APP_TIMEZONE (US Eastern unless set),
// inclusive; the default is the 60 days ending today (both modes).
//
// Writes nothing, opens no connection, reads no settings file: the sheet comes from
// the file given, parsed by server.js's own parseSheet(), deduplicateLoads() and
// sheetDayKey(), lifted at run time (scripts/lib/server-lift.js). Load IDs are
// shown as their last four characters; broker domains only, never an address, a
// name or an amount (the shadow-week report's Gmail check list shows invoice
// numbers). Exit 0; 2 on a refused argument; 1 on any other failure.

"use strict";

const fs = require("fs");
const path = require("path");
const rules = require("../lib/auto-invoice-rules");
const ledger = require("../lib/auto-invoice-ledger");
const appTime = require("../lib/app-time");
const { closure } = require("./lib/server-lift");

const ROOT = path.join(__dirname, "..");
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DEFAULT_WINDOW_DAYS = 60;
const KNOWN_ARGS = new Set(["retro", "db", "sheets-json", "values-json", "uploads", "since", "until", "json"]);
const SHADOW_ONLY_REFUSED = ["sheets-json", "values-json", "uploads"];
const VERDICT_ORDER = ["WOULD_ATTEMPT", "WOULD_WAIT", "WOULD_NEED_ATTENTION", "WOULD_SKIP"];
const NO_DOMAIN = "(no broker email)";
const NOT_ON_SHEET = "(not on the sheet)";
// The server functions the report reads the sheet with; nothing that reaches
// Google, the mailer or the HTTP server may come along.
const LIFT_ROOTS = ["parseSheet", "deduplicateLoads", "sheetDayKey"];
const LIFT_DENIED = ["getSheets", "sheets", "SPREADSHEET_ID", "KEY_FILE", "server", "io", "sendEmail", "transporter", "getDrive", "db"];

function refused(msg) {
	const e = new Error(msg);
	e.refused = true;
	return e;
}

function parseArgs(argv) {
	const out = {};
	for (const a of argv) {
		const m = /^--([a-z-]{1,20})(?:=(.*))?$/.exec(a);
		if (!m) throw refused(`unknown argument ${JSON.stringify(String(a).slice(0, 40))}`);
		if (!KNOWN_ARGS.has(m[1])) throw refused(`unknown argument --${m[1]}`);
		out[m[1]] = m[2] === undefined ? true : m[2];
	}
	return out;
}

function realDay(s) {
	const m = DAY_RE.exec(String(s || ""));
	if (!m) return false;
	const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
	return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

function addDays(day, n) {
	const [y, m, d] = day.split("-").map(Number);
	return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function windowOf({ since, until, today }) {
	for (const [name, value] of [["since", since], ["until", until]]) {
		if (value !== undefined && !realDay(value)) throw refused(`--${name} must be a calendar day (YYYY-MM-DD)`);
	}
	const end = until || today;
	const start = since || addDays(end, -(DEFAULT_WINDOW_DAYS - 1));
	if (start > end) throw refused("--since is after --until");
	return { since: start, until: end };
}

// The Job Tracking values from a saved values.get or a replica working copy.
function readValues({ valuesJson, sheetsJson }) {
	if (valuesJson && sheetsJson) throw refused("give --sheets-json or --values-json, not both");
	if (!valuesJson && !sheetsJson) throw refused("--sheets-json=<file> or --values-json=<file> is required");
	const file = String(valuesJson || sheetsJson);
	let doc;
	try {
		doc = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch (e) {
		throw refused(`cannot read ${path.basename(file)}: ${e.message.slice(0, 120)}`);
	}
	if (valuesJson) {
		const values = (doc && doc.values) || (doc && doc.data && doc.data.values);
		if (!Array.isArray(values)) throw refused("--values-json holds no values.get answer ({ values: [...] })");
		return values;
	}
	if (!doc || doc.format !== 1 || !doc.spreadsheets || typeof doc.spreadsheets !== "object") {
		throw refused("--sheets-json is not a replica Sheets working copy (format 1)");
	}
	const mains = Object.values(doc.spreadsheets).filter((b) => b && b.role === "main");
	if (mains.length !== 1) throw refused(`--sheets-json must hold exactly one main spreadsheet, found ${mains.length}`);
	const tabs = Array.isArray(mains[0].sheets) ? mains[0].sheets : [];
	const title = (t) => String((t && t.properties && t.properties.title) || "");
	const tab = tabs.find((t) => title(t) === "Job Tracking") || tabs.find((t) => title(t).toLowerCase() === "job tracking");
	if (!tab || !Array.isArray(tab.values)) throw refused("the main spreadsheet has no Job Tracking tab");
	return tab.values;
}

// parseSheet(), deduplicateLoads() and sheetDayKey() as server.js runs them.
function liftSheetHelpers(root = ROOT) {
	const src = fs.readFileSync(path.join(root, "server.js"), "utf8");
	const lifted = closure(src, { roots: LIFT_ROOTS, provided: ["require", "console"], denied: LIFT_DENIED });
	const allowed = { "./lib/app-time": appTime };
	const liftedRequire = (m) => {
		if (!Object.prototype.hasOwnProperty.call(allowed, m)) throw new Error(`lifted code required ${m}, which the report does not load`);
		return allowed[m];
	};
	return new Function("require", "console", `"use strict";\n${lifted.text}\nreturn { ${LIFT_ROOTS.join(", ")} };`)(liftedRequire, console);
}

function openReadOnly(dbPath) {
	const Database = require(path.join(ROOT, "node_modules", "better-sqlite3"));
	let db;
	try {
		db = new Database(dbPath, { readonly: true, fileMustExist: true });
	} catch (e) {
		throw refused(`cannot open the database read-only: ${e.message.slice(0, 120)}`);
	}
	if (!db.readonly) {
		db.close();
		throw refused("the database did not open read-only");
	}
	return db;
}

// A SQLite UTC stamp ("YYYY-MM-DD HH:MM:SS", or ISO with Z) as a business day.
function stampDay(stamp, zone) {
	const ms = Date.parse(stampIso(stamp));
	return Number.isFinite(ms) ? appTime.dayInZone(new Date(ms), zone) : "";
}

function suffix(id) {
	const k = String(id == null ? "" : id).trim();
	return k.length > 4 ? `...${k.slice(-4)}` : k;
}

function median(nums) {
	if (!nums.length) return null;
	const s = [...nums].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function dayDiff(a, b) {
	return Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);
}

// What the hand draft says about the automatic one (domains compared, nothing
// printed): A likely the same, B the recipient rule hands it to a person, C edited.
function compareHandDraft(facts, draft) {
	if (!facts.isBison) {
		const to = rules.emailDomain(draft.recipient);
		if (String(draft.recipient_source || "") === "default" || !to || to !== facts.brokerDomain) return "B";
	}
	return Number(draft.edited) === 1 ? "C" : "A";
}

function emptyVerdicts() {
	return Object.fromEntries(VERDICT_ORDER.map((v) => [v, { count: 0, reasons: {} }]));
}

function tally(verdicts, entry) {
	const bucket = verdicts[entry.verdict];
	bucket.count++;
	if (entry.code) bucket.reasons[entry.code] = (bucket.reasons[entry.code] || 0) + 1;
}

function buildRetro({ values, db, uploadsDir = "", since, until, zone = appTime.appTimeZone(), helpers = liftSheetHelpers(), today = appTime.dayInZone(new Date(), zone) }) {
	const win = windowOf({ since, until, today });
	const inWindow = (day) => Boolean(day) && day >= win.since && day <= win.until;
	const parsed = helpers.parseSheet({ values });
	const rows = helpers.deduplicateLoads(parsed.data, parsed.headers);
	const cols = rules.jobColumns(parsed.headers);
	if (!cols.loadIdCol || !cols.statusCol) throw refused("the Job Tracking copy has no Load ID or status column");
	const records = rules.indexRecords(ledger.readRecords(db));
	const podReadable = uploadsDir
		? (doc) => {
			if (String(doc.drive_file_id || "")) return true;
			const file = rules.documentLocalPath(uploadsDir, doc);
			return Boolean(file) && fs.existsSync(file);
		}
		: null;

	const rowByKey = new Map();
	const loads = [];
	const unknown = [];
	for (const row of rows) {
		const key = rules.loadKey(row[cols.loadIdCol]);
		if (!key) continue;
		rowByKey.set(key, row);
		const rec = records.get(key);
		const completed = rules.isCompletedStatus(row[cols.statusCol]);
		const facts = rules.loadFacts({ row, cols, records: rec, bisonRecipientConfigured: true, podReadable,
			activeAdvanceLines: completed ? ledger.activeAdvanceLines(db, key) : 0 });
		if (!facts.completed || !facts.live) continue;
		let day = helpers.sheetDayKey(cols.completionCol ? row[cols.completionCol] : "");
		let dayFrom = day ? "completion" : "";
		if (!day && rec && rec.pods.length) {
			day = stampDay(rec.pods[0].uploaded_at, zone);
			dayFrom = day ? "pod" : "";
		}
		const verdict = rules.freeVerdict(facts, { checkMonth: false, checkDrafted: false });
		const latestDraft = rec && rec.drafts.length ? rec.drafts[rec.drafts.length - 1] : null;
		const entry = {
			load: suffix(row[cols.loadIdCol]),
			day,
			dayFrom,
			verdict: rules.shadowVerdictOf(verdict.state),
			code: verdict.code,
			domain: facts.brokerDomain || NO_DOMAIN,
			bison: facts.isBison,
			rateConOnFile: facts.rateConIds.length > 0,
			handDrafted: Boolean(latestDraft),
			compare: null,
			editedFields: [],
			daysToHandDraft: null,
		};
		if (latestDraft && entry.verdict === "WOULD_ATTEMPT") {
			entry.compare = compareHandDraft(facts, latestDraft);
			if (entry.compare === "C") entry.editedFields = String(latestDraft.edited_fields || "").split(",").map((f) => f.trim()).filter((f) => /^[A-Za-z]{1,40}$/.test(f));
		}
		// The first draft made on or after the delivered day (an older one belongs
		// to an earlier delivery of the same load).
		const draftDays = rec ? rec.drafts.map((d) => stampDay(d.created_at, zone)).filter((d) => d && day && d >= day).sort() : [];
		if (draftDays.length) entry.daysToHandDraft = dayDiff(day, draftDays[0]);
		if (!day) unknown.push(entry);
		else if (inWindow(day)) loads.push(entry);
	}

	const verdicts = emptyVerdicts();
	loads.forEach((e) => tally(verdicts, e));
	const unknownVerdicts = emptyVerdicts();
	unknown.forEach((e) => tally(unknownVerdicts, e));
	const attempts = loads.filter((e) => e.verdict === "WOULD_ATTEMPT");
	const attemptDetail = {
		bison: attempts.filter((e) => e.bison).length,
		otherWithRateConOnFile: attempts.filter((e) => !e.bison && e.rateConOnFile).length,
		otherRateConFromDriveOrNone: attempts.filter((e) => !e.bison && !e.rateConOnFile).length,
	};
	const compared = attempts.filter((e) => e.compare);
	const editedFields = {};
	for (const e of compared) for (const f of e.editedFields) editedFields[f] = (editedFields[f] || 0) + 1;
	const handDraftCompare = {
		drafted: compared.length,
		A: compared.filter((e) => e.compare === "A").length,
		B: compared.filter((e) => e.compare === "B").length,
		C: compared.filter((e) => e.compare === "C").length,
		editedFields,
	};

	const draftsInWindow = [];
	for (const [key, rec] of records) {
		for (const d of rec.drafts) {
			if (!inWindow(stampDay(d.created_at, zone))) continue;
			const row = rowByKey.get(key);
			const domain = row ? rules.emailDomain(row[cols.emailCol]) || NO_DOMAIN : NOT_ON_SHEET;
			draftsInWindow.push({ key, domain });
		}
	}

	const byDomain = new Map();
	const dom = (d) => {
		let x = byDomain.get(d);
		if (!x) {
			x = { domain: d, delivered: 0, wouldAttempt: 0, withButtonDraft: 0, buttonDraftsInWindow: 0 };
			byDomain.set(d, x);
		}
		return x;
	};
	for (const e of loads) {
		const x = dom(e.domain);
		x.delivered++;
		if (e.verdict === "WOULD_ATTEMPT") x.wouldAttempt++;
		if (e.handDrafted) x.withButtonDraft++;
	}
	for (const d of draftsInWindow) dom(d.domain).buttonDraftsInWindow++;
	const perDomain = [...byDomain.values()].sort((a, b) => b.delivered - a.delivered || b.buttonDraftsInWindow - a.buttonDraftsInWindow || a.domain.localeCompare(b.domain));

	const daysToDraft = loads.map((e) => e.daysToHandDraft).filter((n) => Number.isFinite(n));
	const out = {
		mode: "retro",
		window: { ...win, zone },
		podFilesChecked: Boolean(uploadsDir),
		delivered: {
			inWindow: loads.length,
			byCompletionDate: loads.filter((e) => e.dayFrom === "completion").length,
			byPodUpload: loads.filter((e) => e.dayFrom === "pod").length,
			dateUnknown: unknown.length,
		},
		buttonDrafts: {
			inWindow: draftsInWindow.length,
			loads: new Set(draftsInWindow.map((d) => d.key)).size,
			deliveredLoadsWithOne: loads.filter((e) => e.handDrafted).length,
		},
		verdicts,
		attemptDetail,
		handDraftCompare,
		medianDaysToHandDraft: median(daysToDraft),
		perDomain,
		dateUnknown: { count: unknown.length, verdicts: unknownVerdicts },
		loads,
	};
	out.text = textOf(out);
	return out;
}

function reasonText(reasons) {
	const parts = Object.entries(reasons).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([c, n]) => `${c} ${n}`);
	return parts.length ? `: ${parts.join(", ")}` : "";
}

function textOf(r) {
	const w = r.window;
	const lines = [
		`Automatic invoice drafts, retro sizing: loads delivered ${w.since} to ${w.until} (${w.zone})`,
		`Delivered loads in the window: ${r.delivered.inWindow} (Completion Date ${r.delivered.byCompletionDate}, POD upload time ${r.delivered.byPodUpload}); date unknown: ${r.delivered.dateUnknown}, counted separately below`,
		`Button drafts made in the window: ${r.buttonDrafts.inWindow}, on ${r.buttonDrafts.loads} loads; delivered loads in the window with a button draft: ${r.buttonDrafts.deliveredLoadsWithOne}`,
		"What the job would have done (as if nobody had drafted them; the month check is not applied):",
		...VERDICT_ORDER.map((v) => `  ${v.padEnd(21)} ${String(r.verdicts[v].count).padStart(4)}${reasonText(r.verdicts[v].reasons)}`),
		`  WOULD_ATTEMPT detail: Bison ${r.attemptDetail.bison}; other brokers with a rate con on file ${r.attemptDetail.otherWithRateConOnFile}; other brokers whose rate con would come from Drive, or is missing ${r.attemptDetail.otherRateConFromDriveOrNone}`,
		`Of the WOULD_ATTEMPT loads, ${r.handDraftCompare.drafted} have a button draft: (A) likely the same draft ${r.handDraftCompare.A}; (B) the recipient rule hands it to a person ${r.handDraftCompare.B}; (C) edited by hand ${r.handDraftCompare.C}${reasonText(r.handDraftCompare.editedFields)}`,
		`Median days from delivered to the first button draft: ${r.medianDaysToHandDraft === null ? "none" : r.medianDaysToHandDraft}`,
		"Per broker domain: delivered / WOULD_ATTEMPT / with a button draft / button drafts made in the window",
		...r.perDomain.map((d) => `  ${d.domain.padEnd(40)} ${String(d.delivered).padStart(4)} ${String(d.wouldAttempt).padStart(4)} ${String(d.withButtonDraft).padStart(4)} ${String(d.buttonDraftsInWindow).padStart(4)}`),
		`Date unknown (completed, no Completion Date and no POD upload): ${r.dateUnknown.count}`,
		...VERDICT_ORDER.filter((v) => r.dateUnknown.verdicts[v].count).map((v) => `  ${v.padEnd(21)} ${String(r.dateUnknown.verdicts[v].count).padStart(4)}${reasonText(r.dateUnknown.verdicts[v].reasons)}`),
		r.podFilesChecked
			? "POD files: checked in the uploads folder given (a row with a Drive copy counts as readable)."
			: "POD files: not checked (no --uploads); every POD row counts as readable.",
	];
	return lines.join("\n");
}

// ── the shadow-week report ──────────────────────────────────────────────────

function parseFacts(json) {
	try {
		const f = JSON.parse(json || "{}");
		return f && typeof f === "object" ? f : {};
	} catch {
		return {};
	}
}

function buildShadow({ db, since, until, zone = appTime.appTimeZone(), today = appTime.dayInZone(new Date(), zone) }) {
	const win = windowOf({ since, until, today });
	const inWindow = (day) => Boolean(day) && day >= win.since && day <= win.until;
	const out = { mode: "shadow", window: { ...win, zone }, shadowLog: ledger.hasTable(db, ledger.SHADOW) };
	const records = rules.indexRecords(ledger.readRecords(db));
	const rows = out.shadowLog
		? ledger.listShadow(db).filter((r) => r.verdict !== "BASELINE" && inWindow(stampDay(r.first_seen_at, zone)))
		: [];
	const verdicts = emptyVerdicts();
	const loads = [];
	for (const r of rows) {
		const facts = parseFacts(r.facts_json);
		const rec = records.get(r.load_key);
		const firstMs = Date.parse(r.first_seen_at);
		const later = rec ? rec.drafts.filter((d) => Date.parse(stampIso(d.created_at)) >= firstMs) : [];
		const draft = later[0] || null;
		const entry = {
			load: suffix(r.load_id || r.load_key),
			firstSeen: stampDay(r.first_seen_at, zone),
			verdict: r.verdict,
			code: r.reason_code,
			domain: String(facts.domain || "") || NO_DOMAIN,
			bison: Boolean(facts.bison),
			handDrafted: Boolean(draft),
			compare: null,
			editedFields: [],
			hoursToHandDraft: draft ? Math.round((Date.parse(stampIso(draft.created_at)) - firstMs) / 360000) / 10 : null,
		};
		if (draft && r.verdict === "WOULD_ATTEMPT") {
			entry.compare = compareHandDraft({ isBison: entry.bison, brokerDomain: String(facts.domain || "") }, draft);
			if (entry.compare === "C") entry.editedFields = String(draft.edited_fields || "").split(",").map((f) => f.trim()).filter((f) => /^[A-Za-z]{1,40}$/.test(f));
		}
		tally(verdicts, entry);
		loads.push(entry);
	}
	const attempts = loads.filter((e) => e.verdict === "WOULD_ATTEMPT");
	const compared = attempts.filter((e) => e.compare);
	const editedFields = {};
	for (const e of compared) for (const f of e.editedFields) editedFields[f] = (editedFields[f] || 0) + 1;
	out.firstSeen = loads.length;
	out.verdicts = verdicts;
	out.handDraftCompare = {
		drafted: compared.length,
		A: compared.filter((e) => e.compare === "A").length,
		B: compared.filter((e) => e.compare === "B").length,
		C: compared.filter((e) => e.compare === "C").length,
		D: attempts.length - compared.length,
		editedFields,
	};
	out.handDraftsOnOtherVerdicts = Object.fromEntries(VERDICT_ORDER.filter((v) => v !== "WOULD_ATTEMPT").map((v) => [v, loads.filter((e) => e.verdict === v && e.handDrafted).length]));
	out.medianHoursToHandDraft = median(loads.map((e) => e.hoursToHandDraft).filter((n) => Number.isFinite(n)));
	const byDomain = new Map();
	for (const e of loads) {
		const x = byDomain.get(e.domain) || { domain: e.domain, firstSeen: 0, wouldAttempt: 0, handDrafted: 0 };
		x.firstSeen++;
		if (e.verdict === "WOULD_ATTEMPT") x.wouldAttempt++;
		if (e.handDrafted) x.handDrafted++;
		byDomain.set(e.domain, x);
	}
	out.perDomain = [...byDomain.values()].sort((a, b) => b.firstSeen - a.firstSeen || a.domain.localeCompare(b.domain));
	// Claims a person should check in Gmail: a draft that may be there unrecorded,
	// or a number reserved and not used.
	out.checkGmail = ledger.hasTable(db, ledger.CLAIMS)
		? ledger.listClaims(db).filter((c) => c.state !== "drafted" && c.invoice_id && !c.number_voided_at).map((c) => ({
			load: suffix(c.load_id || c.load_key),
			invoiceId: c.invoice_id,
			state: c.state,
			code: c.reason_code,
			mayBeInGmail: c.stage === "appending" || c.stage === "appended",
		}))
		: [];
	out.loads = loads;
	out.text = shadowText(out);
	return out;
}

// A SQLite stamp as an ISO instant (UTC when it carries no zone).
function stampIso(stamp) {
	const s = String(stamp || "").trim();
	return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(s) ? `${s.replace(" ", "T")}Z` : s;
}

function shadowText(r) {
	const w = r.window;
	if (!r.shadowLog) return `Automatic invoice drafts, shadow report ${w.since} to ${w.until} (${w.zone}): no shadow log in this database (shadow mode never ran).`;
	const c = r.handDraftCompare;
	return [
		`Automatic invoice drafts, shadow report: loads first seen completed ${w.since} to ${w.until} (${w.zone})`,
		`Loads first seen in the window: ${r.firstSeen}`,
		...VERDICT_ORDER.map((v) => `  ${v.padEnd(21)} ${String(r.verdicts[v].count).padStart(4)}${reasonText(r.verdicts[v].reasons)}`),
		`WOULD_ATTEMPT drafted by hand: ${c.drafted}: (A) likely the same draft ${c.A}; (B) the recipient rule hands it to a person ${c.B}; (C) edited by hand ${c.C}${reasonText(c.editedFields)}; (D) not drafted by hand ${c.D}`,
		`Hand drafts on loads the job would not have drafted: ${VERDICT_ORDER.filter((v) => v !== "WOULD_ATTEMPT").map((v) => `${v} ${r.handDraftsOnOtherVerdicts[v]}`).join(", ")}`,
		`Median hours from first seen completed to the hand draft: ${r.medianHoursToHandDraft === null ? "none" : r.medianHoursToHandDraft}`,
		"Per broker domain: first seen / WOULD_ATTEMPT / drafted by hand",
		...r.perDomain.map((d) => `  ${d.domain.padEnd(40)} ${String(d.firstSeen).padStart(4)} ${String(d.wouldAttempt).padStart(4)} ${String(d.handDrafted).padStart(4)}`),
		r.checkGmail.length
			? `Check in Gmail (${r.checkGmail.length}): ${r.checkGmail.map((x) => `load ${x.load} invoice ${x.invoiceId} (${x.state}${x.code ? ` ${x.code}` : ""}${x.mayBeInGmail ? ", may be in Gmail" : ", number not used"})`).join("; ")}`
			: "Check in Gmail: nothing (no draft may be there unrecorded, no reserved number unused).",
	].join("\n");
}

function run(argv) {
	const args = parseArgs(argv);
	if (typeof args.db !== "string" || !args.db) throw refused("--db=<app.db> is required");
	for (const k of ["sheets-json", "values-json", "uploads", "since", "until"]) {
		if (args[k] === true) throw refused(`--${k} needs a value`);
	}
	if (!args.retro) {
		const given = SHADOW_ONLY_REFUSED.filter((k) => args[k] !== undefined);
		if (given.length) throw refused(`--${given[0]} is for --retro only; the shadow-week report reads the database alone`);
		windowOf({ since: args.since, until: args.until, today: appTime.dayInZone(new Date(), appTime.appTimeZone()) });
		const shadowDb = openReadOnly(path.resolve(args.db));
		try {
			return { args, out: buildShadow({ db: shadowDb, since: args.since, until: args.until }) };
		} finally {
			shadowDb.close();
		}
	}
	const values = readValues({ valuesJson: args["values-json"], sheetsJson: args["sheets-json"] });
	const uploadsDir = args.uploads ? path.resolve(args.uploads) : "";
	if (uploadsDir && !(fs.existsSync(uploadsDir) && fs.statSync(uploadsDir).isDirectory())) throw refused("--uploads is not a folder");
	const db = openReadOnly(path.resolve(args.db));
	try {
		return { args, out: buildRetro({ values, db, uploadsDir, since: args.since, until: args.until }) };
	} finally {
		db.close();
	}
}

function main() {
	let result;
	try {
		result = run(process.argv.slice(2));
	} catch (e) {
		if (!e.refused) {
			console.error(`FAILED: ${e.stack || e.message}`);
			process.exit(1);
		}
		console.error(`REFUSED: ${e.message}`);
		process.exit(2);
	}
	const { args, out } = result;
	if (args.json) {
		const { text: _text, ...json } = out;
		console.log(JSON.stringify(json, null, 2));
	} else {
		console.log(out.text);
	}
}

if (require.main === module) main();

module.exports = { buildRetro, buildShadow, readValues, liftSheetHelpers, windowOf, compareHandDraft, run };
