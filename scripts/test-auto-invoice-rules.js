#!/usr/bin/env node
// lib/auto-invoice-rules.js: the rules the automatic invoice-draft job and its
// report share (AUTO_INVOICE_DRAFTS_ENABLED).
//
//   §1  modes and settings: off unless ENABLED is exactly "true"; real drafts only
//       with SHADOW exactly "false"; caps default 12 / 60
//   §2  load keys, statuses, addresses and domains; Bison and normalizeEmail()
//       read as lib/broker-invoice.js reads them; opt-outs
//   §3  the recipient rule: Bison's setting, or a documents email on exactly the
//       sheet broker Email's domain, which a person confirmed and isn't free
//       mail; everything else goes to a person. The free-mail list; the
//       confirmed list refuses free mail
//   §4  Job Tracking columns, on a production-shaped header row
//   §5  local records by load key, and the facts the free checks read
//   §6  the free checks, in order
//   §7  a load seen for the first time: baseline, already drafted, opted out,
//       off gap, then the free checks
//   §8  engine refusals, retry backoff, login pauses, caps
//   §9  "draft made, load changed": the fingerprint and its difference
//   §10 server.js parity: the completed and cancelled patterns, the load key, the
//       rate-con types and the draft route's date and email columns
//   §11 the module stays pure
//
// Made-up data only. No network, no database, no files written.
//   node scripts/test-auto-invoice-rules.js      # exits 1 on any failure
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const R = require(path.join(ROOT, "lib", "auto-invoice-rules.js"));
const brokerInvoice = require(path.join(ROOT, "lib", "broker-invoice.js"));

let pass = 0;
const failures = [];
function eq(actual, expected, label) {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) { pass++; return; }
	failures.push(`${label}\n      expected ${e}\n      actual   ${a}`);
}
function ok(cond, label) { eq(Boolean(cond), true, label); }
function section(t) { console.log(`\n${t}`); }

const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;

// ------------------------------------------------------------------ §1
section("§1  modes and settings");
eq(R.readMode({}), "off", "§1 nothing set: off");
eq(R.readMode({ AUTO_INVOICE_DRAFTS_ENABLED: "TRUE" }), "off", "§1 ENABLED must be exactly \"true\"");
eq(R.readMode({ AUTO_INVOICE_DRAFTS_ENABLED: "1" }), "off", "§1 ENABLED=1 is off");
eq(R.readMode({ AUTO_INVOICE_DRAFTS_ENABLED: "true" }), "shadow", "§1 a lone ENABLED=true is shadow, never drafts");
eq(R.readMode({ AUTO_INVOICE_DRAFTS_ENABLED: " true ", AUTO_INVOICE_DRAFTS_SHADOW: "no" }), "shadow", "§1 SHADOW=no is still shadow");
eq(R.readMode({ AUTO_INVOICE_DRAFTS_ENABLED: "true", AUTO_INVOICE_DRAFTS_SHADOW: "0" }), "shadow", "§1 SHADOW=0 is still shadow");
eq(R.readMode({ AUTO_INVOICE_DRAFTS_ENABLED: "true", AUTO_INVOICE_DRAFTS_SHADOW: "false" }), "on", "§1 ENABLED=true and SHADOW=false: real drafts");
eq(R.readMode({ AUTO_INVOICE_DRAFTS_ENABLED: "false", AUTO_INVOICE_DRAFTS_SHADOW: "false" }), "off", "§1 SHADOW=false alone does nothing");
eq(R.readCaps({}), { maxPerHour: 12, maxPerDay: 60, perSweep: 2 }, "§1 caps default to 12 an hour, 60 a day, 2 a sweep");
eq(R.readCaps({ AUTO_INVOICE_MAX_PER_HOUR: "5", AUTO_INVOICE_MAX_PER_DAY: "20" }), { maxPerHour: 5, maxPerDay: 20, perSweep: 2 }, "§1 caps from the settings");
eq(R.readCaps({ AUTO_INVOICE_MAX_PER_HOUR: "0", AUTO_INVOICE_MAX_PER_DAY: "-3" }), { maxPerHour: 12, maxPerDay: 60, perSweep: 2 }, "§1 a zero or negative cap takes the default");
eq(R.readCaps({ AUTO_INVOICE_MAX_PER_HOUR: "1e3", AUTO_INVOICE_MAX_PER_DAY: "lots" }), { maxPerHour: 12, maxPerDay: 60, perSweep: 2 }, "§1 a cap that isn't a whole number takes the default");

// ------------------------------------------------------------------ §2
section("§2  keys, statuses, addresses, domains");
eq(R.loadKey("  #LD-TEST-0001 "), "ld-test-0001", "§2 load key: trimmed, lower case, '#' dropped");
eq(R.loadKey("##7"), "#7", "§2 only one leading '#' is dropped (normLoadKey)");
for (const s of ["Delivered", "completed", " POD Received "]) ok(R.isCompletedStatus(s), `§2 "${s}" is completed`);
for (const s of ["Delivered - late", "Not Delivered", "In Transit", "", "Completed?"]) ok(!R.isCompletedStatus(s), `§2 "${s}" is not completed (anchored)`);
for (const s of ["Cancel", "canceled", "CANCELLED"]) ok(R.isCancelledStatus(s), `§2 "${s}" is cancelled`);
ok(!R.isCancelledStatus("Cancelled by broker"), "§2 cancelled is anchored too");

const EMAILS = [
	"ops@example-broker.test", " Billing@Example-Broker.Test> ", "ap@example-factor.test.", "no-at-sign.example.test",
	"two@@example.test", "", null, "a@b", "x@sub.example-broker.test;", "Name <ops@example-broker.test>",
	"ops@bisontransport.com", "OPS@BISONTRANSPORT.COM", "ops@notbisontransport.com", "ops@bisontransport.com.example.test",
];
// isBisonEmail() is isBisonLoad() on a readable address, except that a lookalike
// domain (notbisontransport.com) is not Bison for automatic drafts.
const BISON_LOOKALIKES = ["ops@notbisontransport.com"];
for (const e of EMAILS) {
	eq(R.normalizeEmail(e), brokerInvoice.normalizeEmail(e), `§2 normalizeEmail(${JSON.stringify(e)}) matches lib/broker-invoice.js`);
	const want = BISON_LOOKALIKES.includes(e) ? false : brokerInvoice.isBisonLoad({ email: e }) && Boolean(R.emailDomain(e));
	eq(R.isBisonEmail(e), want, `§2 isBisonEmail(${JSON.stringify(e)})`);
}
for (const [e, want] of [["ops@bisontransport.com", true], ["ops@ap.bisontransport.com", true], ["OPS@BisonTransport.COM", true],
	["ops@notbisontransport.com", false], ["ops@bisontransport.com.example.test", false], ["ops@bison-transport.com", false], ["bisontransport.com", false]]) {
	eq(R.isBisonEmail(e), want, `§2 Bison is the real domain or its subdomains only: ${e} -> ${want}`);
}
eq(R.recipientRule({ brokerEmail: "ops@notbisontransport.com", bisonRecipient: "ap@example-bison-ap.test", documentsEmail: "billing@notbisontransport.com" }).code,
	"BROKER_DOMAIN_UNCONFIRMED", "§2 a Bison lookalike needs a confirmed domain like any broker, never Bison's inbox");
eq(R.emailDomain(" Billing@Example-Broker.Test> "), "example-broker.test", "§2 the domain is the part after '@', lower case");
eq(R.emailDomain("x@sub.example-broker.test;"), "sub.example-broker.test", "§2 a subdomain is kept as written");
eq(R.emailDomain("no-at-sign.example.test"), "", "§2 no '@': no domain");
eq(R.emailDomain("a@b"), "", "§2 a domain without a dot: none");
eq(R.emailDomain("x@-bad-.test"), "", "§2 a malformed domain: none");
eq(R.emailDomain("x".repeat(300) + "@example.test"), "", "§2 an over-long address: none");
ok(R.domainOptedOut("example-broker.test", ["example-broker.test"]), "§2 opted out: exact domain");
ok(R.domainOptedOut("ap.example-broker.test", ["example-broker.test"]), "§2 opted out: a subdomain of an opted-out domain");
ok(!R.domainOptedOut("example-broker.test.evil.test", ["example-broker.test"]), "§2 not opted out: a domain that only starts the same");
ok(!R.domainOptedOut("myexample-broker.test", ["example-broker.test"]), "§2 not opted out: a domain that only ends the same");
ok(!R.domainOptedOut("", ["example-broker.test"]), "§2 no domain is never opted out");
eq(R.normalizeOptOutDomains(["Example-Broker.Test", " example-factor.test ", "example-broker.test", "@example-other.test"]),
	{ ok: true, domains: ["example-broker.test", "example-factor.test", "example-other.test"] }, "§2 opt-outs: lower case, each once, sorted, a leading '@' dropped");
eq(R.normalizeOptOutDomains(["example-broker.test", "not a domain"]).code, "OPT_OUT_INVALID", "§2 opt-outs: one bad entry refuses the list");
eq(R.normalizeOptOutDomains("example-broker.test").code, "OPT_OUT_INVALID", "§2 opt-outs: a string is not a list");
eq(R.normalizeOptOutDomains([42]).code, "OPT_OUT_INVALID", "§2 opt-outs: a number is not a domain");
eq(R.normalizeOptOutDomains(Array.from({ length: 201 }, (_, i) => `d${i}.example.test`)).code, "OPT_OUT_TOO_MANY", "§2 opt-outs: at most 200");
eq(R.normalizeOptOutDomains([]), { ok: true, domains: [] }, "§2 opt-outs: an empty list clears them");

// ------------------------------------------------------------------ §3
section("§3  the recipient rule");
const sheet = "ops@example-broker.test";
const CONFIRMED = ["example-broker.test", "ap.example-broker.test"];
const rr = (o) => R.recipientRule({ confirmedDomains: CONFIRMED, ...o });
eq(rr({ brokerEmail: sheet, documentsEmail: "billing@example-broker.test" }),
	{ ok: true, to: "billing@example-broker.test", source: "ratecon" }, "§3 a documents email on the broker's own confirmed domain drafts");
eq(rr({ brokerEmail: sheet, documentsEmail: "Billing@EXAMPLE-BROKER.test." }).ok, true, "§3 the domain is compared in lower case");
eq(rr({ brokerEmail: sheet, documentsEmail: "ap@example-factor.test" }), { ok: false, code: "RECIPIENT_DOMAIN_MISMATCH" }, "§3 another domain: a person");
eq(rr({ brokerEmail: sheet, documentsEmail: "billing@ap.example-broker.test" }), { ok: false, code: "RECIPIENT_DOMAIN_MISMATCH" }, "§3 a subdomain: a person");
eq(rr({ brokerEmail: "ops@ap.example-broker.test", documentsEmail: "billing@example-broker.test" }), { ok: false, code: "RECIPIENT_DOMAIN_MISMATCH" }, "§3 a parent domain: a person");
eq(rr({ brokerEmail: "Ops desk", documentsEmail: "billing@example-broker.test" }), { ok: false, code: "NO_BROKER_EMAIL" }, "§3 a sheet Email with no domain: a person (NO_BROKER_EMAIL)");
eq(rr({ brokerEmail: sheet, documentsEmail: "" }), { ok: false, code: "NO_BILLING_EMAIL" }, "§3 no documents email (the default inbox would be used): a person");
eq(rr({ brokerEmail: sheet, documentsEmail: "see attached" }), { ok: false, code: "NO_BILLING_EMAIL" }, "§3 a documents 'email' that isn't one: a person");
eq(R.recipientRule({ brokerEmail: sheet, documentsEmail: "billing@example-broker.test" }), { ok: false, code: "BROKER_DOMAIN_UNCONFIRMED" },
	"§3 the domains match but nobody confirmed it: a person (rate-con text never chooses alone)");
eq(rr({ brokerEmail: "ops@example-other.test", documentsEmail: "billing@example-other.test" }), { ok: false, code: "BROKER_DOMAIN_UNCONFIRMED" }, "§3 a domain not on the confirmed list: a person");
eq(R.recipientRule({ brokerEmail: "ops@sub.example-broker.test", documentsEmail: "billing@sub.example-broker.test", confirmedDomains: ["example-broker.test"] }),
	{ ok: false, code: "BROKER_DOMAIN_UNCONFIRMED" }, "§3 confirming a domain confirms no subdomain of it");
eq(R.recipientRule({ brokerEmail: "made-up-dispatch@gmail.com", documentsEmail: "made-up-billing@gmail.com", confirmedDomains: ["gmail.com"] }),
	{ ok: false, code: "BROKER_EMAIL_FREEMAIL" }, "§3 a free-mail broker Email: a person, even if somehow on the list");
eq(rr({ brokerEmail: "made-up-ops@Outlook.com", documentsEmail: "billing@example-broker.test" }), { ok: false, code: "BROKER_EMAIL_FREEMAIL" }, "§3 free mail is matched in lower case");
eq(R.recipientRule({ brokerEmail: "ops@bisontransport.com", bisonRecipient: "" }), { ok: false, code: "RECIPIENT_UNCONFIGURED" }, "§3 Bison with no recipient setting: a person");
eq(R.recipientRule({ brokerEmail: "ops@bisontransport.com", bisonRecipient: "ap@example-bison-ap.test", documentsEmail: "billing@example-factor.test" }),
	{ ok: true, to: "ap@example-bison-ap.test", source: "bison" }, "§3 Bison: only the setting, never the rate con's address, and no confirmation needed");
for (const d of ["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com", "ymail.com", "aol.com", "icloud.com",
	"me.com", "mac.com", "proton.me", "protonmail.com", "gmx.com", "mail.com", "zoho.com", "yandex.com", "mail.yahoo.com"]) ok(R.isFreemailDomain(d), `§3 ${d} is free mail`);
for (const d of ["example-broker.test", "bisontransport.com", "notgmail.com", "gmail.com.example.test", ""]) ok(!R.isFreemailDomain(d), `§3 ${JSON.stringify(d)} is not free mail`);
eq(R.normalizeConfirmedDomains([" Example-Broker.TEST", "@example-other.test", "example-broker.test"]), { ok: true, domains: ["example-broker.test", "example-other.test"] }, "§3 the confirmed list: lower case, each once, sorted");
eq(R.normalizeConfirmedDomains(["example-broker.test", "Gmail.com"]).code, "CONFIRMED_DOMAIN_FREEMAIL", "§3 a free-mail domain is refused from the confirmed list");
eq(R.normalizeConfirmedDomains(["mail.yahoo.com"]).code, "CONFIRMED_DOMAIN_FREEMAIL", "§3 and so is a free-mail subdomain");
eq([R.normalizeConfirmedDomains("example-broker.test").code, R.normalizeConfirmedDomains(["not a domain"]).code], ["CONFIRMED_DOMAINS_INVALID", "CONFIRMED_DOMAINS_INVALID"], "§3 a list that isn't one is refused whole");

// ------------------------------------------------------------------ §4
section("§4  Job Tracking columns");
const HEADERS = ["Contract ID", "Load ID", "Details", "Trailer Number", "Driver", "Pickup Info", "Pickup Address", "Pickup Appointment",
	"Drop-off Info", "Drop-off Address", "Drop-off Appointment", "Job Status", "Phase of Progress", "Carrier Stage", "Broker Contact Name",
	"Phone Number", "Email", "Assigned Date", "Status Update Date", "Completion Date", "Location Link", "Documents", "  Payment  ", "Truck", "Owner ID"];
eq(R.jobColumns(HEADERS), {
	loadIdCol: "Load ID", statusCol: "Job Status", emailCol: "Email", completionCol: "Completion Date",
	deliveryDateCol: "Status Update Date", paymentCol: "  Payment  ", trailerCol: "Trailer Number",
}, "§4 the production-shaped header row");
eq(R.jobColumns(["Load ID", "Status", "Drop-off Appointment"]).deliveryDateCol, "Drop-off Appointment", "§4 no stamp column: the drop-off appointment, as the draft route reads it");
eq(R.jobColumns(["Load ID", "Status Update Date", "Job Status"]).statusCol, "Job Status", "§4 the status column is never a date column");
eq(R.jobColumns([]).loadIdCol, null, "§4 no headers: no columns");

// ------------------------------------------------------------------ §5
section("§5  records and facts");
const DOCS = [
	{ id: 3, load_id: "#LD-TEST-0001", type: "POD", file_name: "pod-a.pdf", drive_file_id: "", drive_url: "/uploads/pod-a.pdf", uploaded_at: "2026-10-01 12:00:00" },
	{ id: 1, load_id: "ld-test-0001", type: "pod", file_name: "pod-b.pdf", drive_file_id: "", drive_url: "", uploaded_at: "2026-10-01 12:00:00" },
	{ id: 5, load_id: "LD-TEST-0001", type: "Rate Con", file_name: "rc.pdf", drive_file_id: "drv-1", drive_url: "", uploaded_at: "2026-09-28 12:00:00" },
	{ id: 6, load_id: "LD-TEST-0001", type: "BOL", file_name: "bol.pdf", drive_file_id: "", drive_url: "", uploaded_at: "2026-10-01 12:00:00" },
	{ id: 7, load_id: "", type: "POD", file_name: "orphan.pdf" },
];
const index = R.indexRecords({
	documents: DOCS,
	drafts: [{ id: 1, load_id: "#LD-TEST-0002" }],
	deletedLoads: [{ load_id: "#LD-TEST-0004" }],
});
const one = index.get("ld-test-0001");
eq(one.pods.map((d) => d.id), [3, 1], "§5 both spellings of a load's POD rows are one load");
eq(one.rateCons.map((d) => d.id), [5], "§5 a rate-con row is filed as a rate con; a BOL is neither");
eq(index.get("ld-test-0002").drafts.length, 1, "§5 a draft row by '#id' belongs to the load");
ok(!index.has("ld-test-0003"), "§5 advance lines are not read here (they come through their own module)");
eq(index.get("ld-test-0004").deleted, true, "§5 a soft-deleted load is marked");
ok(!index.has(""), "§5 a row with no load id is never filed");
const UP = path.join(path.sep, "srv", "example", "uploads");
eq(R.documentLocalPath(UP, { drive_url: "/uploads/pod-a.pdf" }), path.join(UP, "pod-a.pdf"), "§5 a POD's local file: the /uploads/ name");
eq(R.documentLocalPath(UP, { drive_url: "", file_name: "pod-b.pdf" }), path.join(UP, "pod-b.pdf"), "§5 no /uploads/ url: the file name");
eq(R.documentLocalPath(UP, { drive_url: "/uploads/../../secret.txt" }), null, "§5 a name that leaves the uploads folder is refused");
eq(R.documentLocalPath(UP, { drive_url: "", file_name: "" }), null, "§5 no name: no local file");

const ROW = {
	"Load ID": "LD-TEST-0001", "Job Status": "Delivered", Email: "ops@example-broker.test", "Status Update Date": "10/01/2026 9:00:00",
	"Completion Date": "10/01/2026 9:00:00", "  Payment  ": "$1,250.00", "Trailer Number": "tr-001 ",
};
const cols = R.jobColumns(HEADERS);
const facts = R.loadFacts({ row: ROW, cols, records: one, optOutDomains: [], closedMonths: [], completionDay: "2026-10-01", podReadable: (d) => d.id === 3 ? true : null });
eq([facts.loadId, facts.completed, facts.live, facts.brokerDomain, facts.isBison, facts.pods, facts.podsUnreadable, facts.paymentCents, facts.trailer],
	["LD-TEST-0001", true, true, "example-broker.test", false, 2, 0, 125000, "TR001"], "§5 the facts of a delivered load");
eq(R.loadFacts({ row: ROW, cols, records: one, podReadable: (d) => d.id !== 1 }).podsUnreadable, 1, "§5 a POD row whose file can't be read is counted");
eq(R.loadFacts({ row: null, cols, records: one }).live, false, "§5 a load gone from the sheet is not live");
eq(R.loadFacts({ row: { ...ROW, "Job Status": "Cancelled" }, cols }).live, false, "§5 a cancelled load is not live");
eq(R.loadFacts({ row: ROW, cols, records: index.get("ld-test-0004") }).live, false, "§5 a soft-deleted load is not live");
eq(R.loadFacts({ row: ROW, cols, records: one, optOutDomains: ["example-broker.test"] }).optedOut, true, "§5 the broker's domain is opted out");
eq([R.loadFacts({ row: ROW, cols, records: one, activeAdvanceLines: 2 }).activeAdvanceLines, R.loadFacts({ row: ROW, cols, records: one }).activeAdvanceLines], [2, 0], "§5 the advance lines given, none by default");

// ------------------------------------------------------------------ §6
section("§6  the free checks");
const ready = { live: true, completed: true, drafts: 0, optedOut: false, brokerDomain: "example-broker.test", brokerEmailFreemail: false, brokerDomainConfirmed: true,
	closedMonths: [], hasDeliveryDate: true, activeAdvanceLines: 0, isBison: false, bisonRecipientConfigured: false, pods: 1, podsUnreadable: 0 };
const fv = (over, opts) => R.freeVerdict({ ...ready, ...over }, opts);
eq(fv({ brokerDomainConfirmed: false, pods: 0 }), { state: "needs_attention", code: "BROKER_DOMAIN_UNCONFIRMED" }, "§6 a broker domain nobody confirmed: a person, before anything is spent");
eq(fv({ brokerEmailFreemail: true, brokerDomainConfirmed: false }), { state: "needs_attention", code: "BROKER_EMAIL_FREEMAIL" }, "§6 a free-mail broker Email: a person");
eq(fv({ brokerDomainConfirmed: false }, { assumeConfirmed: true }), { state: "queued", code: "" }, "§6 assumeConfirmed (the retro report's second split)");
eq(fv({ brokerEmailFreemail: true }, { assumeConfirmed: true }).code, "BROKER_EMAIL_FREEMAIL", "§6 free mail is never assumed confirmed");
eq(fv({ isBison: true, bisonRecipientConfigured: true, brokerDomainConfirmed: false }), { state: "queued", code: "" }, "§6 Bison needs no confirmed domain");
eq(fv({ optedOut: true, brokerDomainConfirmed: false }).code, "BROKER_OPTED_OUT", "§6 opted out outranks unconfirmed");
eq(fv({ brokerDomain: "", brokerDomainConfirmed: false }).code, "NO_BROKER_EMAIL", "§6 no broker Email outranks unconfirmed");
eq(R.loadFacts({ row: { "Load ID": "LD-TEST-0001", "Job Status": "Delivered", Email: "ops@example-broker.test" }, cols: R.jobColumns(["Load ID", "Job Status", "Email"]),
	confirmedDomains: ["example-broker.test"] }).brokerDomainConfirmed, true, "§5 facts: the confirmed list confirms the broker's exact domain");
eq(R.loadFacts({ row: { "Load ID": "LD-TEST-0001", "Job Status": "Delivered", Email: "made-up@yahoo.com" }, cols: R.jobColumns(["Load ID", "Job Status", "Email"]) }).brokerEmailFreemail,
	true, "§5 facts: a free-mail broker Email");
eq(fv({}), { state: "queued", code: "" }, "§6 every check passes: queued");
eq(fv({ live: false, completed: false }), { state: "waiting", code: "LOAD_DROPPED" }, "§6 cancelled or deleted: waiting LOAD_DROPPED");
eq(fv({ completed: false }), { state: "waiting", code: "NOT_COMPLETED" }, "§6 not completed: waiting");
eq(fv({ drafts: 1, optedOut: true }), { state: "skipped", code: "ALREADY_DRAFTED" }, "§6 already drafted, before anything else");
eq(fv({ drafts: 1 }, { checkDrafted: false }), { state: "queued", code: "" }, "§6 checkDrafted:false ignores a hand draft (the retro report)");
eq(fv({ optedOut: true, brokerDomain: "" }), { state: "skipped", code: "BROKER_OPTED_OUT" }, "§6 opted out: skipped");
eq(fv({ brokerDomain: "" }), { state: "needs_attention", code: "NO_BROKER_EMAIL" }, "§6 no broker Email: a person");
eq(fv({ closedMonths: ["2026-09"] }), { state: "needs_attention", code: "CLOSED_MONTH" }, "§6 a closed month: a person");
eq(fv({ closedMonths: null }), { state: "needs_attention", code: "MONTH_UNKNOWN" }, "§6 a month that can't be told: a person");
eq(fv({ closedMonths: undefined }), { state: "needs_attention", code: "MONTH_UNKNOWN" }, "§6 a month nobody checked: a person");
eq(fv({ closedMonths: ["2026-09"] }, { checkMonth: false }), { state: "queued", code: "" }, "§6 checkMonth:false skips the month (the retro report)");
eq(fv({ hasDeliveryDate: false }), { state: "needs_attention", code: "NO_DELIVERY_DATE" }, "§6 no delivery date: a person");
eq(fv({ activeAdvanceLines: 1 }), { state: "needs_attention", code: "ADVANCE_LINES" }, "§6 an advance line: a person");
eq(fv({ isBison: true }), { state: "needs_attention", code: "RECIPIENT_UNCONFIGURED" }, "§6 Bison without its recipient setting: a person");
eq(fv({ isBison: true, bisonRecipientConfigured: true }), { state: "queued", code: "" }, "§6 Bison with its setting: queued");
eq(fv({ pods: 0 }), { state: "waiting", code: "WAITING_POD" }, "§6 no POD: waiting, not an error");
eq(fv({ pods: 2, podsUnreadable: 1 }), { state: "needs_attention", code: "POD_UNREADABLE" }, "§6 a POD row without a readable file: a person");
eq(fv({ pods: 0, activeAdvanceLines: 1 }), { state: "needs_attention", code: "ADVANCE_LINES" }, "§6 a failed free check outranks waiting for the POD");

// ------------------------------------------------------------------ §7
section("§7  a load seen for the first time");
const nv = (over, opts) => R.newClaimVerdict({ ...ready, completionDay: "2026-10-20", ...over }, opts);
const after = { baselineDone: true, baselineDay: "2026-10-15" };
eq(nv({}, { baselineDone: false }), { state: "baseline", code: "" }, "§7 the first on-mode sweep ever: baseline");
eq(nv({ drafts: 0, pods: 0 }, { baselineDone: false }), { state: "baseline", code: "" }, "§7 the baseline takes every completed load, ready or not");
eq(nv({ completionDay: "2026-10-14" }, after), { state: "baseline", code: "" }, "§7 completed on a day before the baseline: baseline");
eq(nv({ completionDay: "2026-10-15" }, after), { state: "queued", code: "" }, "§7 completed on the baseline's day: drafted normally");
eq(nv({ completionDay: "" }, after), { state: "queued", code: "" }, "§7 no Completion Date: first-seen rules");
eq(nv({ drafts: 1 }, { ...after, offGap: true }), { state: "skipped", code: "ALREADY_DRAFTED" }, "§7 drafted by hand is checked before the off gap");
eq(nv({ optedOut: true }, { ...after, offGap: true }), { state: "skipped", code: "BROKER_OPTED_OUT" }, "§7 opted out is checked before the off gap");
eq(nv({}, { ...after, offGap: true }), { state: "needs_attention", code: "OFF_GAP" }, "§7 first sweep after an off gap: a person drafts it");
eq(nv({ pods: 0 }, { ...after, offGap: true }), { state: "needs_attention", code: "OFF_GAP" }, "§7 off gap even before its POD (a person decides)");
eq(nv({ pods: 0 }, after), { state: "waiting", code: "WAITING_POD" }, "§7 otherwise the free checks");
const NOW = Date.parse("2026-10-20T12:00:00Z");
eq(R.isOffGap(new Date(NOW - (2 * HOUR - MIN)).toISOString(), NOW), false, "§7 a sweep 1 h 59 min after the last: no gap");
eq(R.isOffGap(new Date(NOW - 30 * MIN).toISOString(), NOW), false, "§7 a 30-minute restart: no gap");
eq(R.isOffGap(new Date(NOW - (2 * HOUR + MIN)).toISOString(), NOW), true, "§7 2 h 1 min: a gap");
eq(R.isOffGap("", NOW), true, "§7 no last sweep recorded: a gap");
eq(["baseline", "queued", "waiting", "needs_attention", "skipped"].map(R.shadowVerdictOf),
	["BASELINE", "WOULD_ATTEMPT", "WOULD_WAIT", "WOULD_NEED_ATTENTION", "WOULD_SKIP"], "§7 shadow verdicts");

// ------------------------------------------------------------------ §8
section("§8  refusals, backoff, pauses, caps");
eq(R.classifyRefusal({ code: "NO_BILLING_EMAIL", http: 422 }), { kind: "attention", code: "NO_BILLING_EMAIL", countsAttempt: false }, "§8 NO_BILLING_EMAIL: a person");
eq(R.classifyRefusal({ code: "RECIPIENT_DOMAIN_MISMATCH", http: 422 }).kind, "attention", "§8 RECIPIENT_DOMAIN_MISMATCH: a person");
eq(R.classifyRefusal({ code: "TOTAL_MISMATCH", http: 422, geminiUnavailable: true }), { kind: "temporary", code: "GEMINI_DOWN", countsAttempt: false }, "§8 any refusal while Gemini is down: temporary, no attempt used");
eq(R.classifyRefusal({ code: "RATECON_MISSING", http: 422 }).kind, "ratecon_missing", "§8 no rate con: the 2-hour re-check");
eq(R.classifyRefusal({ code: "RATECON_TOTAL_UNREAD", http: 422 }), { kind: "attention", code: "RATECON_TOTAL_UNREAD", countsAttempt: false }, "§8 no rate-con total read: a person");
eq(R.classifyRefusal({ code: "RATECON_TOTAL_UNREAD", http: 503, geminiUnavailable: true }), { kind: "attention", code: "RATECON_TOTAL_UNREAD", countsAttempt: false },
	"§8 no rate-con total read while Gemini failed or timed out: still a person, never a retry");
ok(R.ATTENTION_REFUSALS.includes("RATECON_TOTAL_UNREAD") && R.REASON_CODES.includes("RATECON_TOTAL_UNREAD"), "§8 RATECON_TOTAL_UNREAD is an attention refusal and a reason code");
eq(R.classifyRefusal({ code: "POD_NOT_FOUND", http: 400 }), { kind: "wait", code: "WAITING_POD", countsAttempt: false }, "§8 the POD went away: waiting");
eq(R.classifyRefusal({ code: "NOT_COMPLETED", http: 400 }).code, "NOT_COMPLETED", "§8 no longer delivered: waiting");
eq(R.classifyRefusal({ code: "RENDERER_BUSY", http: 503 }), { kind: "temporary", code: "RENDERER_BUSY", countsAttempt: false }, "§8 the renderer busy: temporary, no attempt used");
eq(R.classifyRefusal({ code: "", http: 500 }), { kind: "temporary", code: "RETRY_LATER", countsAttempt: true }, "§8 a server error: temporary");
eq(R.classifyRefusal({}), { kind: "temporary", code: "RETRY_LATER", countsAttempt: true }, "§8 no answer at all: temporary");
eq(R.classifyRefusal({ code: "SOMETHING_NEW", http: 409 }), { kind: "attention", code: "DRAFT_REFUSED", countsAttempt: false }, "§8 an unknown refusal: a person, never a retry loop");
eq([1, 2, 3, 4, 0].map(R.retryDelayMs), [15 * MIN, HOUR, 4 * HOUR, null, null], "§8 backoff 15 min, 1 h, 4 h, then a person");
eq([R.ENGINE_WAIT_MAX, R.STALE_RESERVATION_MS], [3, 24 * HOUR], "§8 three engine waits, then a person; a reservation is stale after a day");
eq(["WAITING_POD", "NOT_COMPLETED", "LOAD_DROPPED", ""].map(R.waitAttentionCode), ["POD_UNREADABLE", "NOT_COMPLETED", "LOAD_DROPPED", "DRAFT_REFUSED"],
	"§8 a wait the engine keeps refusing goes to a person: a POD it can't read is POD_UNREADABLE");
for (const c of ["POD_UNREADABLE", "NOT_COMPLETED", "LOAD_DROPPED", "DRAFT_REFUSED", "SETTINGS_UNREADABLE"]) ok(R.REASON_CODES.includes(c), `§8 ${c} is a reason code`);
eq([0, HOUR, 2 * HOUR, 4 * HOUR, 6 * HOUR].map(R.loginPauseMs), [HOUR, 2 * HOUR, 4 * HOUR, 6 * HOUR, 6 * HOUR], "§8 login pause 1 h, doubling, at most 6 h");
const caps = R.readCaps({});
ok(R.capsAllow({ caps }), "§8 caps: nothing in flight");
ok(!R.capsAllow({ caps, inFlight: 1 }), "§8 caps: one draft in flight at a time");
ok(!R.capsAllow({ caps, startedThisSweep: 2 }), "§8 caps: two a sweep");
ok(!R.capsAllow({ caps, draftedLastHour: 12 }), "§8 caps: 12 an hour");
ok(!R.capsAllow({ caps, draftedLastDay: 60 }), "§8 caps: 60 a day");
ok(R.capsAllow({ caps, startedThisSweep: 1, draftedLastHour: 11, draftedLastDay: 59 }), "§8 caps: just under every limit");

// ------------------------------------------------------------------ §9
section("§9  the fingerprint");
const fp = R.fingerprint(facts);
eq(fp, { completed: true, live: true, paymentCents: 125000, brokerEmail: "ops@example-broker.test", trailer: "TR001", podIds: [1, 3], rateConIds: [5] }, "§9 what a draft was made from");
eq(R.fingerprintDiff(fp, R.fingerprint(facts)), [], "§9 nothing changed: no fields");
eq(R.fingerprintDiff(fp, R.fingerprint({ ...facts, completed: false })), ["status"], "§9 set back from Delivered: status");
eq(R.fingerprintDiff(fp, R.fingerprint({ ...facts, paymentCents: 130000, trailer: "TR002" })), ["payment", "trailer"], "§9 payment and trailer");
eq(R.fingerprintDiff(fp, R.fingerprint({ ...facts, brokerEmail: "ap@example-broker.test", podIds: [1, 3, 9], rateConIds: [] })), ["brokerEmail", "pods", "rateCons"], "§9 email, POD and rate-con rows");
eq(R.fingerprintDiff(fp, R.fingerprint({ ...facts, live: false })), ["removed"], "§9 cancelled or deleted");
eq(R.fingerprintDiff(fp, R.fingerprint({ ...facts, paymentCents: 125000 })), [], "§9 the same amount is no change");
eq(R.fingerprintDiff(null, fp), [], "§9 no saved fingerprint: nothing to compare");

// ------------------------------------------------------------------ §10
section("§10 server.js parity");
const SRC = require("./lib/server-source").serverSource();
const regexIn = (name) => {
	const m = new RegExp(`\\nconst ${name} = (/[^\\n]{1,200}/[a-z]*);`).exec(SRC);
	return m ? m[1] : null;
};
eq(regexIn("DISPATCH_COMPLETED_RE"), String(R.COMPLETED_RE), "§10 COMPLETED_RE is DISPATCH_COMPLETED_RE");
eq(regexIn("CANCELED_STATUS_RE"), String(R.CANCELLED_RE), "§10 CANCELLED_RE is CANCELED_STATUS_RE");
const typesLine = /\nconst RATECON_DOC_TYPES = Object\.freeze\((\[[^\]\n]{1,200}\])\);/.exec(SRC);
eq(typesLine ? JSON.parse(typesLine[1]) : null, [...R.RATECON_TYPES], "§10 RATECON_TYPES is RATECON_DOC_TYPES");
for (const t of R.RATECON_TYPES) ok(R.RECORD_SQL.documents.includes(`'${t}'`), `§10 the documents query reads rate-con type ${t}`);
ok(/\nconst normLoadKey = \(id\) => String\(id \|\| ""\)\.trim\(\)\.toLowerCase\(\)\.replace\(\/\^#\/, ""\);/.test(SRC), "§10 normLoadKey() is still trim, lower case, one '#'");
for (const id of ["#LD-TEST-0001", " X ", "##9", "", null]) {
	eq(R.loadKey(id), String(id || "").trim().toLowerCase().replace(/^#/, ""), `§10 loadKey(${JSON.stringify(id)}) is normLoadKey()`);
}
// The draft route's reads live in the shared draft engine.
const DRAFT_SRC = fs.readFileSync(path.join(ROOT, "lib", "broker-invoice-draft.js"), "utf8");
for (const text of [
	"const emailCol = findCol(headers, /^email$/i) || findCol(headers, /broker.*email|email/i);",
	"headers.find((h) => /status.*update.*date|completion.*date/i.test(h)) ||",
	"headers.find((h) => /drop.?off.*date|drop.?off.*appoint|deliv.*date|deliv.*appoint/i.test(h));",
	"\"SELECT * FROM documents WHERE load_id = ? AND UPPER(type) = 'POD' AND deleted_at IS NULL ORDER BY uploaded_at ASC, id ASC\"",
]) ok(DRAFT_SRC.includes(text), `§10 the draft engine still reads ${text.slice(0, 60)}…`);

// ------------------------------------------------------------------ §11
section("§11 the module stays pure");
const MOD = fs.readFileSync(path.join(ROOT, "lib", "auto-invoice-rules.js"), "utf8");
const requires = [...MOD.matchAll(/require\(\s*["']([^"']{1,80})["']\s*\)/g)].map((m) => m[1]).sort();
eq(requires, ["./cell-compare", "./free-mail-domains", "path"], "§11 it requires only path, lib/cell-compare.js and lib/free-mail-domains.js");
ok(!/\bfs\.|process\.env|\bfetch\(|Date\.now\(\)|new Date\(\)/.test(MOD), "§11 no files, environment, network or clock");
eq(R.REASON_CODES.length, new Set(R.REASON_CODES).size, "§11 every reason code once");
for (const c of [...R.ATTENTION_REFUSALS]) ok(R.REASON_CODES.includes(c), `§11 refusal ${c} is a reason code`);

console.log(`\n${"=".repeat(64)}`);
if (failures.length) {
	console.log(`FAILURES (${failures.length}):`);
	failures.forEach((f) => console.log(`  ✗ ${f}`));
	console.log(`\n${pass} passed, ${failures.length} failed`);
	process.exit(1);
}
console.log(`✓ ${pass} assertions passed`);
