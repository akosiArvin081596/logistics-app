"use strict";
// ===========================================================================
// THE DAILY INTEGRITY CHECK — read-only watchers over Job Tracking and app.db,
// run by server.js every day at 8:00 AM on the business clock (APP_TIMEZONE,
// US Eastern) and by scripts/integrity-check.js --print by hand.
//
//   1. a load whose Pickup Appointment became blank after having a value;
//   2. a load whose Assigned Date changed after it was first set;
//   3. a NEW Assigned Date written by n8n (a new load, or a changed value since
//      the previous run) that is not in Eastern time;
//   4. an approved receipt on no invoice, submitted more than 7 days ago.
//
// Checks 1 and 2 need memory: the job keeps one table of its own,
// integrity_check_loads (load id, the Pickup Appointment and Assigned Date it
// last saw, first and last seen). That table is the ONLY thing it writes: never
// the sheet, an invoice, a payout or any other row. The first run records every
// load and reports nothing for checks 1-3 (a baseline, said in its log line).
// Each change is reported once: the state then holds the new value. Job
// Tracking is read through the caller's reader (getJobTrackingCached() in
// server.js, whose object is shared and is never mutated here).
//
// CHECK 3, AND WHY IT USES THE EMAIL'S OWN DATE HEADER. n8n's JOB DETAILS ENTRY
// node writes Assigned Date as
//   new Date($('Email Input').item.json.date).toLocaleString('en-US', { timeZone: 'America/New_York' })
// ("10/6/2026, 9:21:43 AM"), the rate-con email's Date header on a wall clock
// with no zone; until 2026-10-09 the zone was America/Chicago. The wall clock
// alone cannot say which zone wrote it. The Drive archive's createdTime is when
// n8n RAN, not when the email was sent: measured on 95 executions it trails the
// Date header by 23-312 s, but an n8n outage or a replay delays it by any
// amount, and a delay of about an hour reads exactly like Central time. The
// Date header is what n8n formatted, so a stamp is compared with each inbound
// rate-con email's Date header, TO THE SECOND: equal to its Eastern wall clock
// is fine; equal to it at another US or UTC offset (CANDIDATE_OFFSETS_MIN) is
// reported, with the offset and how far from Eastern it is; neither is
// "unmatched" (counted in the log line, never reported). The mailbox is read like
// reconcileRateCons() reads it (EXAMINE and BODY.PEEK, inbound mail only), back
// to the previous run. Only stamps of n8n's shape are checked: the app's own
// stamp (appStamp(), "10/09/2026 9:21:43") and date-only values are not n8n's.
//
// CHECK 4 leaves out receipts booked (EXPENSE_PERIOD_EXPR, passed in by the
// caller) to a closed month (period_locks 'locked'): closed months are final as
// recorded and their data problems are not raised (product decision,
// 2026-10-02). A reopened month is open. "On an invoice" is any invoice row not
// soft-deleted, whatever its status. There is no approval stamp on a receipt, so
// its age is from when it was submitted (created_at).
//
// Email: one per run with findings, through the caller's sendEmail, to the one
// inbox the caller names (ADMIN_NOTIFY_EMAIL); unset, nothing is sent and the
// log line says so. A failed send records nothing, so the run is repeated
// (dailyTicker() retries after 15 minutes, at most 3 times a day) and nothing
// is lost. A clean run logs exactly one line.
// ===========================================================================

const appTime = require("./app-time");

const STATE_TABLE = "integrity_check_loads";
const RUN_HOUR = 8;
const RECEIPT_DAYS = 7;
const RETRY_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const LIST_MAX = 50;
const DAY_MS = 86400000;

// The UTC offsets (minutes) a non-Eastern n8n stamp could have been written at:
// UTC (n8n's server clock when no timeZone is given) and the US zones' standard
// and daylight offsets, -5 h (Central daylight, n8n's zone until 2026-10-09) to
// -10 h. Offsets, not zone names: nothing in lib/ names a zone but the business
// one (scripts/test-app-timezone-switch.js), and an offset is what a wall clock
// and an instant together can prove.
const CANDIDATE_OFFSETS_MIN = [0, -300, -360, -420, -480, -540, -600];

// --- the state table ---------------------------------------------------------

function hasTable(db, name) {
	return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

function ensureStateTable(db) {
	db.exec(`
		CREATE TABLE IF NOT EXISTS ${STATE_TABLE} (
			load_id TEXT PRIMARY KEY,
			pickup_appointment TEXT NOT NULL DEFAULT '',
			assigned_date TEXT NOT NULL DEFAULT '',
			first_seen_at TEXT NOT NULL,
			last_seen_at TEXT NOT NULL
		)
	`);
}

// Map load key -> its state row; empty when the table does not exist yet (the
// CLI never creates it).
function readState(db) {
	const out = new Map();
	if (!hasTable(db, STATE_TABLE)) return out;
	for (const r of db.prepare(`SELECT load_id, pickup_appointment, assigned_date, first_seen_at, last_seen_at FROM ${STATE_TABLE}`).all()) {
		out.set(r.load_id, r);
	}
	return out;
}

// When the last completed run recorded its loads (ISO), or null.
function lastRunAt(db) {
	if (!hasTable(db, STATE_TABLE)) return null;
	const r = db.prepare(`SELECT MAX(last_seen_at) AS t FROM ${STATE_TABLE}`).get();
	return (r && r.t) || null;
}

function commitState(db, loads, nowIso) {
	const upsert = db.prepare(`
		INSERT INTO ${STATE_TABLE} (load_id, pickup_appointment, assigned_date, first_seen_at, last_seen_at)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(load_id) DO UPDATE SET
			pickup_appointment = excluded.pickup_appointment,
			assigned_date = excluded.assigned_date,
			last_seen_at = excluded.last_seen_at
	`);
	db.transaction(() => {
		for (const l of loads) upsert.run(l.key, l.pickup, l.assigned, nowIso, nowIso);
	})();
}

// --- Job Tracking ------------------------------------------------------------

// A load's key the way deduplicateLoads() keys it.
function loadKey(id) {
	return String(id == null ? "" : id).trim().toLowerCase().replace(/^#/, "");
}

function cellText(v) {
	return String(v == null ? "" : v).trim();
}

function columnOf(headers, exact, loose) {
	return headers.find((h) => exact.test(String(h || "").trim())) || headers.find((h) => loose.test(String(h || "")));
}

// [{ key, id, pickup, assigned }] from { headers, data } (parseSheet() rows),
// the bottom row of a repeated load id winning as in deduplicateLoads(). A read
// without the three columns throws: a renamed header must stop the run, not
// report every load as blanked.
function jobTrackingLoads(jt) {
	const headers = (jt && jt.headers) || [];
	const idCol = headers.find((h) => /load.?id|job.?id/i.test(h));
	const puCol = columnOf(headers, /^pickup appointment$/i, /pick.?up.*appo/i);
	const adCol = columnOf(headers, /^assigned date$/i, /assigned.*date|date.*assigned/i);
	const missing = [[idCol, "Load ID"], [puCol, "Pickup Appointment"], [adCol, "Assigned Date"]].filter(([c]) => !c).map(([, n]) => n);
	if (missing.length) throw new Error(`Job Tracking has no ${missing.join(", ")} column`);
	const byKey = new Map();
	for (const row of (jt && jt.data) || []) {
		const id = cellText(row[idCol]);
		const key = loadKey(id);
		if (!key) continue;
		byKey.set(key, { key, id, pickup: cellText(row[puCol]), assigned: cellText(row[adCol]) });
	}
	return [...byKey.values()];
}

// Checks 1 and 2 against the state; newStamps are the Assigned Dates that are
// new since the previous run (check 3's candidates).
function compareLoads(state, loads) {
	const baseline = state.size === 0;
	const pickupBlanked = [];
	const assignedChanged = [];
	const newStamps = [];
	if (!baseline) {
		for (const l of loads) {
			const prev = state.get(l.key);
			if (!prev) {
				if (l.assigned) newStamps.push(l);
				continue;
			}
			if (prev.pickup_appointment && !l.pickup) pickupBlanked.push({ ...l, was: prev.pickup_appointment, firstSeenAt: prev.first_seen_at });
			if (prev.assigned_date && l.assigned !== prev.assigned_date) assignedChanged.push({ ...l, was: prev.assigned_date, firstSeenAt: prev.first_seen_at });
			if (l.assigned && l.assigned !== prev.assigned_date) newStamps.push(l);
		}
	}
	return { baseline, pickupBlanked, assignedChanged, newStamps };
}

// --- check 3 -----------------------------------------------------------------

// toLocaleString('en-US') with a zone: "10/6/2026, 9:21:43 AM" (newer ICU puts a
// narrow no-break space before AM/PM). Bounded quantifiers: sheet text.
const N8N_STAMP_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4}),\s{1,3}(\d{1,2}):(\d{2}):(\d{2})\s{0,3}([AaPp][Mm])$/;

function n8nStampParts(text) {
	const m = N8N_STAMP_RE.exec(String(text == null ? "" : text).slice(0, 40).trim());
	if (!m) return null;
	const h12 = Number(m[4]);
	if (h12 < 1 || h12 > 12) return null;
	const pm = /^p/i.test(m[7]);
	return { year: Number(m[3]), month: Number(m[1]), day: Number(m[2]), hour: (h12 % 12) + (pm ? 12 : 0), minute: Number(m[5]), second: Number(m[6]) };
}

const wallFormatters = new Map();
function wallClock(ms, timeZone) {
	let f = wallFormatters.get(timeZone);
	if (!f) {
		f = new Intl.DateTimeFormat("en-US", {
			timeZone, year: "numeric", month: "numeric", day: "numeric",
			hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23",
		});
		wallFormatters.set(timeZone, f);
	}
	const p = {};
	for (const x of f.formatToParts(new Date(ms))) p[x.type] = x.value;
	return { year: Number(p.year), month: Number(p.month), day: Number(p.day), hour: Number(p.hour) % 24, minute: Number(p.minute), second: Number(p.second) };
}

function sameWallClock(a, b) {
	return a.year === b.year && a.month === b.month && a.day === b.day && a.hour === b.hour && a.minute === b.minute && a.second === b.second;
}

function emailInstant(email) {
	const ms = Date.parse(String((email && email.date) || "").slice(0, 200).replace(/^Date:\s*/i, ""));
	return Number.isFinite(ms) ? ms : null;
}

function wallClockAsUtcMs(p) {
	return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}

function offsetText(min) {
	const a = Math.abs(min);
	return `UTC${min < 0 ? "-" : "+"}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
}

// { ok, wrong, unmatched, notN8n }: each stamp ({ id, assigned }) compared with
// each email's Date header, to the second. Equal to the email's wall clock in
// the business zone: ok. Otherwise the stamp read as UTC, minus the email's
// instant, is the offset it was written at; one of CANDIDATE_OFFSETS_MIN (not
// the business zone's own at that instant): wrong. Neither: unmatched.
function classifyStamps(stamps, emails, { appZone = appTime.appTimeZone() } = {}) {
	const instants = [...new Set((emails || []).map(emailInstant).filter((ms) => ms !== null))];
	const out = { ok: [], wrong: [], unmatched: [], notN8n: 0 };
	for (const s of stamps) {
		const parts = n8nStampParts(s.assigned);
		if (!parts) { out.notN8n++; continue; }
		if (instants.some((ms) => sameWallClock(wallClock(ms, appZone), parts))) { out.ok.push(s); continue; }
		const stampMs = wallClockAsUtcMs(parts);
		let hit = null;
		for (const ms of instants) {
			const offsetMin = (stampMs - ms) / 60000;
			if (!CANDIDATE_OFFSETS_MIN.includes(offsetMin)) continue;
			const appOffsetMin = (wallClockAsUtcMs(wallClock(ms, appZone)) - ms) / 60000;
			if (offsetMin === appOffsetMin) continue;
			if (!hit || Math.abs(offsetMin - appOffsetMin) < Math.abs(hit.offsetMin - hit.appOffsetMin)) hit = { ms, offsetMin, appOffsetMin };
		}
		if (!hit) { out.unmatched.push(s); continue; }
		const hours = (hit.appOffsetMin - hit.offsetMin) / 60;
		out.wrong.push({
			...s,
			offset: offsetText(hit.offsetMin),
			hoursBehind: hours,
			label: `${offsetText(hit.offsetMin)}, ${Math.abs(hours)} hour${Math.abs(hours) === 1 ? "" : "s"} ${hours > 0 ? "behind" : "ahead of"} Eastern`,
			emailAt: new Date(hit.ms).toISOString(),
			eastern: new Date(hit.ms).toLocaleString("en-US", { timeZone: appZone }),
		});
	}
	return out;
}

// How far back the mailbox is read: since the previous run, plus two days of
// slack (IMAP SINCE is a date), between 2 and 14 days.
function mailboxDays(previousRunAt, now) {
	const last = previousRunAt ? Date.parse(previousRunAt) : NaN;
	const days = Number.isFinite(last) ? Math.ceil((now.getTime() - last) / DAY_MS) + 2 : 2;
	return Math.max(2, Math.min(14, days));
}

async function checkStampZones(newStamps, readRateConEmails, { appZone, sinceDays }) {
	const candidates = newStamps.filter((s) => n8nStampParts(s.assigned));
	const base = { checked: candidates.length, ok: [], wrong: [], unmatched: [], skipped: null };
	if (!candidates.length) return base;
	if (typeof readRateConEmails !== "function") return { ...base, skipped: "no rate-con mailbox to read (GMAIL_USER / GMAIL_APP_PASSWORD not set)" };
	let emails;
	try {
		emails = await readRateConEmails({ sinceDays });
	} catch (e) {
		return { ...base, skipped: `rate-con mailbox unreadable (${String((e && e.message) || e).slice(0, 200)})` };
	}
	const c = classifyStamps(candidates, emails, { appZone });
	return { ...base, ok: c.ok, wrong: c.wrong, unmatched: c.unmatched };
}

// The mailbox reader for check 3: the rate-con label, read-only (EXAMINE and
// BODY.PEEK in lib/ratecon-reconcile.js), inbound mail only. null without an
// account, so check 3 says it was skipped.
function rateConEmailReader({ user, pass, mailbox, timeoutMs = 2 * 60 * 1000 } = {}) {
	if (!user || !pass) return null;
	return async ({ sinceDays }) => {
		const { fetchRateConSubjects, splitSelfSent } = require("./ratecon-reconcile");
		const fetched = await fetchRateConSubjects({ user, pass, ...(mailbox ? { mailbox } : {}), sinceDays, timeoutMs });
		return splitSelfSent(fetched, user).inbound;
	};
}

// --- check 4 -----------------------------------------------------------------

function staleApprovedReceipts(db, { now, expensePeriodExpr, days = RECEIPT_DAYS } = {}) {
	if (!expensePeriodExpr) throw new Error("staleApprovedReceipts needs the expense month rule (EXPENSE_PERIOD_EXPR)");
	const onInvoice = new Set();
	let unreadableInvoices = 0;
	for (const r of db.prepare("SELECT expense_ids FROM invoices WHERE COALESCE(deleted_at, '') = ''").all()) {
		let ids = null;
		try { ids = JSON.parse(r.expense_ids || "[]"); } catch { ids = null; }
		if (!Array.isArray(ids)) { unreadableInvoices++; continue; }
		for (const x of ids) onInvoice.add(Number(x));
	}
	const locked = new Set(hasTable(db, "period_locks")
		? db.prepare("SELECT period FROM period_locks WHERE status = 'locked'").all().map((r) => r.period)
		: []);
	const cutoff = new Date(now.getTime() - days * DAY_MS).toISOString();
	const rows = db.prepare(`
		SELECT id, type, amount, date, created_at, ${expensePeriodExpr} AS period
		FROM expenses
		WHERE status = 'Approved' AND julianday(created_at) < julianday(?)
		ORDER BY id
	`).all(cutoff);
	const stale = rows
		.filter((r) => !onInvoice.has(Number(r.id)) && !locked.has(r.period))
		.map((r) => ({
			id: r.id, type: r.type, amount: r.amount, date: r.date, createdAt: r.created_at, period: r.period,
			days: Math.floor((now.getTime() - sqliteUtcMs(r.created_at)) / DAY_MS),
		}));
	return { stale, unreadableInvoices };
}

// created_at is CURRENT_TIMESTAMP ("2026-10-08 20:43:33", UTC with no zone) or
// an ISO string; either way an instant.
function sqliteUtcMs(text) {
	const s = String(text || "").trim();
	return Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s.replace(" ", "T")}Z`);
}

// --- the report --------------------------------------------------------------

function escapeHtml(s) {
	return String(s == null ? "" : s)
		.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function shown(v, max = 80) {
	const t = String(v == null ? "" : v).slice(0, 400).replace(/\s+/g, " ").trim();
	return t.length > max ? `${t.slice(0, max)}…` : t;
}
function quoted(v) { return v ? `"${shown(v)}"` : "blank"; }
function money(n) { return Number.isFinite(Number(n)) ? `$${Number(n).toFixed(2)}` : ""; }

function buildReport({ now, appZone, baseline, loadsSeen, cmp, zone, receipts }) {
	const sections = [];
	if (cmp.pickupBlanked.length) {
		sections.push({
			title: "Pickup Appointment became blank",
			lines: cmp.pickupBlanked.map((l) => `Load ${shown(l.id, 40)}: Pickup Appointment was ${quoted(l.was)} and is now blank.`),
		});
	}
	if (cmp.assignedChanged.length) {
		sections.push({
			title: "Assigned Date changed after it was set",
			lines: cmp.assignedChanged.map((l) => `Load ${shown(l.id, 40)}: Assigned Date changed from ${quoted(l.was)} to ${quoted(l.assigned)}.`),
		});
	}
	if (zone.wrong.length) {
		sections.push({
			title: "Assigned Date not in Eastern time",
			lines: zone.wrong.map((w) => `Load ${shown(w.id, 40)}: Assigned Date ${quoted(w.assigned)} is the rate-con email's time at ${w.label}; in Eastern it is "${w.eastern}".`),
		});
	}
	if (receipts.stale.length) {
		sections.push({
			title: `Approved receipts on no invoice for more than ${RECEIPT_DAYS} days`,
			lines: receipts.stale.map((r) => `Receipt #${r.id}: ${shown(r.type, 30) || "receipt"} ${money(r.amount)}, dated ${shown(r.date, 20) || "(no date)"}, submitted ${r.days} days ago, booked to ${shown(r.period, 10)}; on no invoice.`),
		});
	}
	const findings = sections.reduce((n, s) => n + s.lines.length, 0);
	const dayText = appTime.dateTextInZone(now, appZone);
	const subject = `LogisX integrity check (${dayText}): ${findings} issue${findings === 1 ? "" : "s"}`;
	const heading = "Daily integrity check";
	const notes = [];
	if (baseline) notes.push(`First run: the baseline is the Pickup Appointment and Assigned Date of these ${loadsSeen} loads; changes are reported from the next run.`);
	if (zone.skipped && !baseline) notes.push(`Assigned Date time zones were not checked: ${zone.skipped}.`);
	if (zone.unmatched.length) notes.push(`${zone.unmatched.length} new Assigned Date${zone.unmatched.length === 1 ? "" : "s"} matched no rate-con email, so ${zone.unmatched.length === 1 ? "its" : "their"} zone could not be checked: load ${zone.unmatched.map((s) => shown(s.id, 40)).join(", ")}.`);
	if (receipts.unreadableInvoices) notes.push(`${receipts.unreadableInvoices} invoice${receipts.unreadableInvoices === 1 ? " has" : "s have"} an unreadable receipt list.`);
	const capped = (lines) => (lines.length > LIST_MAX ? [...lines.slice(0, LIST_MAX), `…and ${lines.length - LIST_MAX} more.`] : lines);
	const text = [
		`${findings} issue${findings === 1 ? "" : "s"} found by the daily integrity check on ${dayText}.`,
		...sections.flatMap((s) => ["", `${s.title} (${s.lines.length}):`, ...capped(s.lines).map((l) => `  - ${l}`)]),
		...(notes.length ? ["", ...notes] : []),
	].join("\n");
	const bodyHtml = [
		`<p style="margin:0 0 12px;line-height:1.6;color:#334155">${findings} issue${findings === 1 ? "" : "s"} found by the daily integrity check on ${escapeHtml(dayText)}. It only reads; nothing was changed.</p>`,
		...sections.map((s) => `<h3 style="margin:16px 0 8px;font-size:15px;color:#0f172a">${escapeHtml(s.title)} (${s.lines.length})</h3>` +
			`<ul style="margin:0 0 12px;padding-left:20px;line-height:1.6;color:#334155">${capped(s.lines).map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul>`),
		...notes.map((n) => `<p style="margin:0 0 8px;color:#64748b;font-size:13px">${escapeHtml(n)}</p>`),
	].join("\n");
	return {
		findings, subject, heading, text, bodyHtml, notes,
		pickupBlanked: cmp.pickupBlanked, assignedChanged: cmp.assignedChanged, zone, receipts,
	};
}

function idList(items, max = 20) {
	const ids = items.map((x) => shown(x.id, 40));
	return ids.length > max ? `${ids.slice(0, max).join(", ")} and ${ids.length - max} more` : ids.join(", ");
}

// The one log line a run writes.
function logLine(report, { baseline, loadsSeen, delivery, write }) {
	const z = report.zone;
	const zonePart = z.skipped
		? `Assigned Date zones not checked (${z.skipped})`
		: `${z.checked} new n8n Assigned Date${z.checked === 1 ? "" : "s"} checked (${z.ok.length} Eastern, ${z.wrong.length} not Eastern, ${z.unmatched.length} unmatched)`;
	const receiptPart = `${report.receipts.stale.length} approved receipt${report.receipts.stale.length === 1 ? "" : "s"} on no invoice for more than ${RECEIPT_DAYS} days`;
	const head = baseline
		? (write
			? `[integrity-check] baseline taken: ${loadsSeen} loads recorded (Pickup Appointment, Assigned Date); changes are reported from the next run`
			: `[integrity-check] baseline: no state yet, so the first run would record ${loadsSeen} loads (Pickup Appointment, Assigned Date) and report changes from the next run`)
		: report.findings
			? `[integrity-check] ${report.findings} finding${report.findings === 1 ? "" : "s"} over ${loadsSeen} loads`
			: `[integrity-check] clean: ${loadsSeen} loads, no Pickup Appointment blanked, no Assigned Date changed`;
	const parts = [head];
	if (report.pickupBlanked.length) parts.push(`Pickup Appointment blanked: load ${idList(report.pickupBlanked)}`);
	if (report.assignedChanged.length) parts.push(`Assigned Date changed: load ${idList(report.assignedChanged)}`);
	if (z.wrong.length) parts.push(`Assigned Date not Eastern: load ${idList(z.wrong)}`);
	parts.push(zonePart);
	parts.push(report.receipts.stale.length ? `${receiptPart}: receipt ${report.receipts.stale.map((r) => `#${r.id}`).slice(0, 20).join(", ")}${report.receipts.stale.length > 20 ? " and more" : ""}` : receiptPart);
	if (delivery === "sent") parts.push("emailed ADMIN_NOTIFY_EMAIL");
	if (delivery === "unset") parts.push("ADMIN_NOTIFY_EMAIL is not set, so no email was sent");
	return parts.join("; ");
}

// --- the run -----------------------------------------------------------------

// One run. `write` records the state (the server); without it nothing is
// written and nothing is sent (the CLI prints `result.mail`).
async function runIntegrityCheck(opts = {}) {
	const {
		db, readJobTracking, readRateConEmails = null, expensePeriodExpr,
		now = new Date(), write = false, sendEmail = null, to = "", emailHtml = null,
		log = console, appZone = appTime.appTimeZone(),
	} = opts;
	if (write) ensureStateTable(db);
	const previousRunAt = lastRunAt(db);
	const state = readState(db);
	const loads = jobTrackingLoads(await readJobTracking());
	const cmp = compareLoads(state, loads);
	const zone = cmp.baseline
		? { checked: 0, ok: [], wrong: [], unmatched: [], skipped: "baseline run: no Assigned Date is new yet" }
		: await checkStampZones(cmp.newStamps, readRateConEmails, { appZone, sinceDays: mailboxDays(previousRunAt, now) });
	const receipts = staleApprovedReceipts(db, { now, expensePeriodExpr });
	const report = buildReport({ now, appZone, baseline: cmp.baseline, loadsSeen: loads.length, cmp, zone, receipts });
	const recipient = String(to || "").trim();
	const html = report.findings
		? (typeof emailHtml === "function" ? emailHtml({ heading: report.heading, bodyHtml: report.bodyHtml }) : `<h2>${escapeHtml(report.heading)}</h2>\n${report.bodyHtml}`)
		: "";
	const mail = report.findings ? { to: recipient, subject: report.subject, text: report.text, html } : null;

	let delivery = "none";
	if (report.findings) {
		if (!recipient) delivery = "unset";
		else if (!write || typeof sendEmail !== "function") delivery = "print";
		else delivery = (await sendEmail(recipient, report.subject, html)) === true ? "sent" : "failed";
	}
	const line = logLine(report, { baseline: cmp.baseline, loadsSeen: loads.length, delivery, write });
	if (delivery === "failed") {
		log.error(`${line}; the email to ADMIN_NOTIFY_EMAIL failed, so this run is not recorded and will be repeated`);
		return { ok: false, retry: true, baseline: cmp.baseline, report, mail, emailed: false, delivery };
	}
	if (write) commitState(db, loads, now.toISOString());
	log.log(line);
	return { ok: true, baseline: cmp.baseline, report, mail, emailed: delivery === "sent", delivery, logLine: line };
}

// --- the schedule ------------------------------------------------------------

// Today's run time (epoch ms) when a run is due at `now`: past 8:00 AM on the
// business clock today and not yet run since then. Otherwise null. Before 8 AM
// nothing is due, even after a missed day: the next run covers it.
function dueSlot({ now, lastRunAt: last, timeZone = appTime.appTimeZone(), hour = RUN_HOUR }) {
	const [y, m, d] = appTime.dayInZone(now, timeZone).split("-").map(Number);
	const slot = appTime.wallClockToMs(timeZone, y, m, d, hour, 0, 0);
	if (now.getTime() < slot) return null;
	const lastMs = last ? Date.parse(last) : NaN;
	return Number.isFinite(lastMs) && lastMs >= slot ? null : slot;
}

// The function server.js ticks every minute. A run that completes records its
// loads (lastRunAt), so it is not repeated that day, across restarts too. A run
// that fails or throws is retried after `retryMs`, at most `maxAttempts` times
// for that day's slot. Never rejects.
function dailyTicker({ db, run, timeZone = appTime.appTimeZone(), now = () => new Date(), log = console, retryMs = RETRY_MS, maxAttempts = MAX_ATTEMPTS }) {
	let running = false;
	const tries = { slot: 0, count: 0, at: 0, done: 0 };
	return async function tick() {
		if (running) return;
		running = true;
		try {
			const at = now();
			const slot = dueSlot({ now: at, lastRunAt: lastRunAt(db), timeZone });
			if (!slot || tries.done === slot) return;
			if (tries.slot !== slot) Object.assign(tries, { slot, count: 0, at: 0 });
			if (tries.count >= maxAttempts) return;
			if (tries.count && at.getTime() - tries.at < retryMs) return;
			tries.count++;
			tries.at = at.getTime();
			let result = null;
			try {
				result = await run(at);
			} catch (e) {
				log.error(`[integrity-check] run failed (attempt ${tries.count} of ${maxAttempts}):`, (e && e.message) || e);
			}
			if (result && result.ok) tries.done = slot;
			else if (tries.count >= maxAttempts) log.error(`[integrity-check] gave up for today after ${maxAttempts} attempts; the next run is tomorrow at ${RUN_HOUR}:00 AM ${timeZone}`);
		} catch (e) {
			log.error("[integrity-check] tick failed:", (e && e.message) || e);
		} finally {
			running = false;
		}
	};
}

module.exports = {
	STATE_TABLE,
	RUN_HOUR,
	RECEIPT_DAYS,
	CANDIDATE_OFFSETS_MIN,
	ensureStateTable,
	readState,
	lastRunAt,
	loadKey,
	jobTrackingLoads,
	compareLoads,
	n8nStampParts,
	classifyStamps,
	mailboxDays,
	rateConEmailReader,
	staleApprovedReceipts,
	buildReport,
	runIntegrityCheck,
	dueSlot,
	dailyTicker,
};
