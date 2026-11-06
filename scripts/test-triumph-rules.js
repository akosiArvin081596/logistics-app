#!/usr/bin/env node
// lib/triumph-rules.js: the pure rules of a factored load's batch.
//
//   §1 submitMode(): off, dry or live, and the one reader of its three settings
//   §2 parseNoaLines(): the assignment lines, word for word, four of them or refused
//   §3 the CSV: exact headers and order, CRLF and no BOM, each field's limits and
//      refusals, INVAMT from whole cents, a comma in DTR_NAME quoted and nowhere else
//   §4 the names: the PDF named for INVOICE#, the CSV unique and plain
//   §5 the size rule: 921,599 passes, 921,600 fails; a setting can only lower it
//   §6 rule 7: a deny-list hit in any composed value refuses, and no reader refuses
//   §7 the debtor: a person's map by domain, and the rate con must print that name
//   §8 the whole-number rate-con test
//   §9 the document rule: what goes in a batch, in what order, and what can't be missing
//   §10 the free checks, in order, each with its code
//   §11 no remit address in the code: the lines live in a setting
//
// Made-up values only. Pure: no server, port, database or network.
//   node scripts/test-triumph-rules.js      # exits 1 on any failure
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const RULES_FILE = path.join(ROOT, "lib", "triumph-rules.js");
if (!fs.existsSync(RULES_FILE)) {
	console.log("FAIL  lib/triumph-rules.js is missing: submitMode(), the assignment lines, the CSV and the batch rules don't exist");
	process.exit(1);
}
const rules = require(RULES_FILE);
const autoRules = require(path.join(ROOT, "lib", "auto-invoice-rules.js"));
const { createRedactor } = require(path.join(ROOT, "lib", "chr-events.js"));

let pass = 0;
const failures = [];
function eq(actual, expected, label) {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) { pass++; return; }
	failures.push(`${label}\n      expected ${e}\n      actual   ${a}`);
}
const ok = (cond, label) => eq(Boolean(cond), true, label);
const section = (t) => console.log(`\n${t}`);

// ---------------------------------------------------------------- §1
section("§1 submitMode()");
{
	const mode = (env, opts) => rules.submitMode(env, opts);
	const LIVE = { TRIUMPH_SUBMIT_ENABLED: "true", TRIUMPH_SUBMIT_DRY_RUN: "false", TRIUMPH_LIVE_CONFIRMED_ON: "2026-11-05" };
	eq(mode({}), "off", "§1 nothing set: off");
	eq(mode(undefined), "off", "§1 no environment: off");
	eq(mode(null), "off", "§1 a null environment: off");
	for (const v of ["false", "TRUE", "True", "1", "yes", "on", ""]) eq(mode({ ...LIVE, TRIUMPH_SUBMIT_ENABLED: v }), "off", `§1 TRIUMPH_SUBMIT_ENABLED ${JSON.stringify(v)}: off, whatever the others say`);
	eq(mode({ TRIUMPH_SUBMIT_ENABLED: "true" }), "dry", "§1 ENABLED alone: dry, so a lone switch can never send");
	eq(mode({ ...LIVE, TRIUMPH_SUBMIT_DRY_RUN: undefined }), "dry", "§1 no dry-run setting: dry");
	for (const v of ["true", "FALSE", "False", "0", "no", "off", ""]) eq(mode({ ...LIVE, TRIUMPH_SUBMIT_DRY_RUN: v }), "dry", `§1 TRIUMPH_SUBMIT_DRY_RUN ${JSON.stringify(v)}: dry`);
	eq(mode({ TRIUMPH_SUBMIT_ENABLED: "true", TRIUMPH_SUBMIT_DRY_RUN: "false" }), "dry", "§1 \"false\" with no date stays dry: the app can't see go-live");
	for (const v of ["", "  ", "2026-02-30", "2026-13-01", "11/05/2026", "2026-11-5", "today", "yes", "2026-11-05T00:00:00Z"]) {
		eq(mode({ ...LIVE, TRIUMPH_LIVE_CONFIRMED_ON: v }), "dry", `§1 a date that isn't one (${JSON.stringify(v)}): dry`);
	}
	eq(mode(LIVE), "live", "§1 all three: live");
	eq(mode({ TRIUMPH_SUBMIT_ENABLED: " true ", TRIUMPH_SUBMIT_DRY_RUN: " false ", TRIUMPH_LIVE_CONFIRMED_ON: " 2026-11-05 " }), "live", "§1 each is trimmed, as the automatic job's reader trims");
	eq(mode(LIVE, { replica: true }), "off", "§1 a replica is off, whatever its settings say");

	// The one reader: nothing else in the app reads these three.
	const NAMES = /TRIUMPH_SUBMIT_ENABLED|TRIUMPH_SUBMIT_DRY_RUN|TRIUMPH_LIVE_CONFIRMED_ON/;
	const code = (src) => src.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
	const readers = fs.readdirSync(path.join(ROOT, "lib")).filter((f) => f.endsWith(".js") && NAMES.test(code(fs.readFileSync(path.join(ROOT, "lib", f), "utf8"))));
	eq(readers.filter((f) => f !== "replica-rules.js"), ["triumph-rules.js"], "§1 of lib/, only lib/triumph-rules.js reads them (lib/replica-rules.js only lists them)");
	ok(!NAMES.test(code(fs.readFileSync(path.join(ROOT, "server.js"), "utf8"))), "§1 server.js doesn't read them");
}

// ---------------------------------------------------------------- §2
section("§2 parseNoaLines()");
{
	const FOUR = ["MADE-UP NOTICE LINE ONE", "THIS INVOICE IS MADE UP AND PAYABLE TO, A MADE-UP FACTOR,", "EXAMPLE FACTOR LLC", "PO DRAWER 000, NOWHERE, ZZ  00000-0000"];
	eq(rules.parseNoaLines(FOUR.join("\n")), { ok: true, lines: FOUR }, "§2 four lines, each as written, the two spaces before the ZIP kept");
	eq(rules.parseNoaLines(FOUR.join("\r\n")).lines, FOUR, "§2 CRLF between them");
	eq(rules.parseNoaLines(FOUR.join("\\n")).lines, FOUR, "§2 a written \\n, as dotenv hands over an unquoted value");
	eq(rules.parseNoaLines(`\n  ${FOUR[0]}  \n\n${FOUR[1]}\n${FOUR[2]}\n\n${FOUR[3]}\n`).lines, FOUR, "§2 blank lines and each line's ends don't count");
	for (const [label, raw] of [
		["unset", undefined], ["null", null], ["empty", ""], ["blank", "   \n  "],
		["one line", FOUR[0]], ["three lines", FOUR.slice(0, 3).join("\n")], ["five lines", [...FOUR, "ONE TOO MANY"].join("\n")],
		["a line past the limit", [...FOUR.slice(0, 3), "X".repeat(rules.NOA_LINE_MAX + 1)].join("\n")],
		["a control character", [...FOUR.slice(0, 3), "MADE\u0007UP"].join("\n")],
		["a format character", [...FOUR.slice(0, 3), "MADE​UP"].join("\n")],
	]) {
		eq(rules.parseNoaLines(raw), { ok: false, code: "NOA_UNCONFIGURED" }, `§2 ${label}: NOA_UNCONFIGURED, and the answer carries none of its words`);
	}
	eq(rules.parseNoaLines([...FOUR.slice(0, 3), "X".repeat(rules.NOA_LINE_MAX)].join("\n")).ok, true, "§2 a line at the limit is kept");
	eq(rules.NOA_LINE_COUNT, 4, "§2 four lines");
	// Through the app's own settings reader, in the form the settings template gives.
	const dotenv = require(path.join(ROOT, "node_modules", "dotenv"));
	const written = FOUR.join("\\n");
	eq(rules.parseNoaLines(dotenv.parse(`TRIUMPH_NOA_LINES="${written}"\n`).TRIUMPH_NOA_LINES).lines, FOUR, "§2 double quotes in a settings file: word for word, the two spaces kept");
	eq(rules.parseNoaLines(dotenv.parse(`TRIUMPH_NOA_LINES=${written}\n`).TRIUMPH_NOA_LINES).lines, FOUR, "§2 no quotes: the same four lines");
}

// ---------------------------------------------------------------- §3
section("§3 the CSV");
{
	const ROW = { debtorName: "Example Broker LLC", invoiceId: "11022026-7", invoiceDate: "11/02/2026", po: "LD-TEST-0001", billedTotal: "$2,150.00" };
	const made = (over = {}) => rules.csvRow({ ...ROW, ...over });
	const code = (over) => { const r = made(over); return r.ok ? "ok" : `${r.code}:${r.field}`; };
	eq(rules.CSV_HEADER, "DTR_NAME,INVOICE#,INV_DATE,PO,INVAMT", "§3 the header, exactly, in order, unquoted");
	eq([...rules.CSV_HEADERS], ["DTR_NAME", "INVOICE#", "INV_DATE", "PO", "INVAMT"], "§3 the five columns in order");
	const text = rules.csvText(made().row);
	eq(text, "DTR_NAME,INVOICE#,INV_DATE,PO,INVAMT\r\nExample Broker LLC,11022026-7,11/02/2026,LD-TEST-0001,2150.00\r\n", "§3 the file, byte for byte: one row, CRLF line endings");
	ok(!Buffer.from(text, "utf8").subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), "§3 no BOM");

	// A comma in the debtor's name: RFC 4180 quoted, read back as one field.
	const parse = (line) => {
		const out = [];
		let cur = "";
		let quoted = false;
		for (let i = 0; i < line.length; i++) {
			const ch = line[i];
			if (quoted) {
				if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') quoted = false; else cur += ch;
			} else if (ch === '"') quoted = true;
			else if (ch === ",") { out.push(cur); cur = ""; } else cur += ch;
		}
		out.push(cur);
		return out;
	};
	const commaRow = made({ debtorName: "Example Broker, LLC" }).row;
	const commaText = rules.csvText(commaRow);
	eq(commaText, "DTR_NAME,INVOICE#,INV_DATE,PO,INVAMT\r\n\"Example Broker, LLC\",11022026-7,11/02/2026,LD-TEST-0001,2150.00\r\n", "§3 a comma in DTR_NAME: that one field quoted");
	eq(parse(commaText.split("\r\n")[1]), ["Example Broker, LLC", "11022026-7", "11/02/2026", "LD-TEST-0001", "2150.00"], "§3 ...and it reads back as five fields");
	eq(commaRow.DTR_NAME, "Example Broker, LLC", "§3 ...the row keeps the name itself, for the rate-con check");
	ok(!rules.csvText(made({ debtorName: "No Comma Broker Inc" }).row).includes('"'), "§3 a name with no comma has no quotes");

	// DTR_NAME
	eq(code({ debtorName: "X".repeat(rules.DTR_NAME_MAX) }), "ok", "§3 DTR_NAME at 100 characters");
	eq(code({ debtorName: "X".repeat(rules.DTR_NAME_MAX + 1) }), "FIELD_UNUSABLE:DTR_NAME", "§3 DTR_NAME at 101: refused");
	eq(code({ debtorName: `${"X".repeat(rules.DTR_NAME_MAX - 1)},` }), "ok", "§3 ...a comma doesn't change the limit: the name's own 100");
	for (const [label, v] of [["empty", ""], ["null", null], ["a quote", 'Example "Broker"'], ["a CR", "Example\rBroker"], ["an LF", "Example\nBroker"], ["a tab", "Example\tBroker"],
		["a leading tab", "\tExample"], ["a leading =", "=SUM(A1)"], ["a leading +", "+Example"], ["a leading -", "-Example"], ["a leading @", "@Example"],
		["a non-ASCII letter", "Exámple Broker"], ["a non-printable", "Example\u0007Broker"], ["a leading space", " Example"], ["a trailing space", "Example "]]) {
		eq(code({ debtorName: v }), "FIELD_UNUSABLE:DTR_NAME", `§3 DTR_NAME with ${label}: FIELD_UNUSABLE`);
	}
	// INVOICE#
	eq(code({ invoiceId: "1".repeat(rules.INVOICE_MAX) }), "ok", "§3 INVOICE# at 100 characters");
	eq(code({ invoiceId: "1".repeat(rules.INVOICE_MAX + 1) }), "FIELD_UNUSABLE:INVOICE#", "§3 INVOICE# at 101: refused");
	for (const v of ["", null, "11022026,7", 'A"1', "A 1", "../A1", "A/1", "A\\1", ".A1", "-A1", "=A1", "A1\n", "Ä1"]) {
		eq(code({ invoiceId: v }), "FIELD_UNUSABLE:INVOICE#", `§3 INVOICE# ${JSON.stringify(v)}: refused, it names the file too`);
	}
	// INV_DATE
	eq(code({ invoiceDate: "02/29/2028" }), "ok", "§3 INV_DATE on a leap day");
	for (const v of ["", null, "02/30/2026", "13/01/2026", "2026-11-02", "1/2/2026", "11/02/26", "11/02/2026 09:00", "11-02-2026"]) {
		eq(code({ invoiceDate: v }), "FIELD_UNUSABLE:INV_DATE", `§3 INV_DATE ${JSON.stringify(v)}: refused`);
	}
	// PO
	eq(code({ po: "A".repeat(40) }), "ok", "§3 PO at 40 characters");
	eq(code({ po: "A".repeat(41) }), "PO_UNUSABLE:PO", "§3 PO at 41: PO_UNUSABLE");
	for (const v of ["", null, "LD,1", "LD 1", 'LD"1', "-LD1", "=LD1", "LD_1", "LD.1", "#LD1", "LD1\r"]) {
		eq(code({ po: v }), "PO_UNUSABLE:PO", `§3 PO ${JSON.stringify(v)}: PO_UNUSABLE`);
	}
	// INVAMT, from whole cents
	for (const [printed, written] of [["$2,150.00", "2150.00"], ["$19.99", "19.99"], ["$0.07", "0.07"], ["$1.10", "1.10"], ["1.00", "1.00"], ["$1,000,000.00", "1000000.00"], ["$4.35", "4.35"], ["$1.15", "1.15"], ["$1,005.70", "1005.70"]]) {
		eq(made({ billedTotal: printed }).row && made({ billedTotal: printed }).row.INVAMT, written, `§3 INVAMT of ${printed} is ${written}, with no "$", no comma and no float's rounding`);
	}
	for (const v of ["", null, undefined, "$0.00", "0", "-$1.00", "($5.00)", "$1,000,000.01", "1,800.00 / 1,875.00", "$12.345", "USD 5", "abc"]) {
		eq(code({ billedTotal: v }), "FIELD_UNUSABLE:INVAMT", `§3 INVAMT of ${JSON.stringify(v)}: refused`);
	}
	eq(rules.INVAMT_MAX_CENTS, 100000000, "§3 at most 1,000,000.00");
}

// ---------------------------------------------------------------- §4
section("§4 the names");
{
	const at = new Date("2026-11-02T15:04:05.678Z");
	eq(rules.pdfName("11022026-7"), "11022026-7.pdf", "§4 the PDF is named for INVOICE#");
	eq(rules.csvName("11022026-7", at), "logisx_20261102T150405Z_11022026-7.csv", "§4 the CSV: its UTC second and the invoice number");
	ok(/^[A-Za-z0-9._-]+$/.test(rules.csvName("SAMPLE-0001", at)), "§4 ...in plain characters");
	ok(rules.csvName("11022026-7", at) !== rules.csvName("11022026-7", new Date(at.getTime() + 1000)), "§4 ...a later second is another name");
	ok(rules.csvName("11022026-7", at) !== rules.csvName("11022026-8", at), "§4 ...another invoice is another name");
}

// ---------------------------------------------------------------- §5
section("§5 the size rule");
{
	eq(rules.BATCH_MAX_BYTES, 921599, "§5 the limit: under 921,600, the PDF and the CSV together");
	eq(rules.sizeRefusal(921599 - 300, 300), null, "§5 921,599 in all passes");
	eq(rules.sizeRefusal(921600 - 300, 300), { ok: false, code: "BATCH_TOO_LARGE", pdfBytes: 921300, csvBytes: 300, maxBytes: 921599 }, "§5 921,600 in all fails: BATCH_TOO_LARGE, with the sizes");
	eq(rules.sizeRefusal(921599, 1).code, "BATCH_TOO_LARGE", "§5 ...the CSV's bytes count");
	eq(rules.sizeRefusal(1, 0, 2000000), null, "§5 a small batch under a larger number passes");
	eq(rules.sizeRefusal(921600, 0, 2000000).maxBytes, 921599, "§5 ...and a caller's larger number can't lift the limit");
	eq(rules.batchMaxBytes({}), 921599, "§5 no setting: the limit");
	eq(rules.batchMaxBytes({ TRIUMPH_BATCH_MAX_BYTES: "500000" }), 500000, "§5 the setting lowers it");
	for (const v of ["921600", "9999999", "0", "-1", "abc", "1e6", "", " "]) {
		eq(rules.batchMaxBytes({ TRIUMPH_BATCH_MAX_BYTES: v }), 921599, `§5 the setting ${JSON.stringify(v)} can't raise it or unset it`);
	}
}

// ---------------------------------------------------------------- §6
section("§6 rule 7's exact-value check");
{
	const row = rules.csvRow({ debtorName: "Example Broker LLC", invoiceId: "11022026-7", invoiceDate: "11/02/2026", po: "LD-TEST-0001", billedTotal: "$2,150.00" }).row;
	const names = ["11022026-7.pdf", "logisx_20261102T150405Z_11022026-7.csv"];
	// A made-up account number on the real deny list's reader.
	const hits = createRedactor({ denyList: "99887766" }).hits;
	eq(rules.protectedValueRefusal({ row, names, denyHits: hits }), null, "§6 no hit: passes");
	const withPo = rules.csvRow({ debtorName: "Example Broker LLC", invoiceId: "11022026-7", invoiceDate: "11/02/2026", po: "LD-99887766", billedTotal: "$2,150.00" }).row;
	eq(rules.protectedValueRefusal({ row: withPo, names, denyHits: hits }), { ok: false, code: "PROTECTED_VALUE" }, "§6 a hit in a CSV value: PROTECTED_VALUE");
	const withName = rules.csvRow({ debtorName: "Example 99887766 Broker", invoiceId: "11022026-7", invoiceDate: "11/02/2026", po: "LD-TEST-0001", billedTotal: "$2,150.00" }).row;
	eq(rules.protectedValueRefusal({ row: withName, names, denyHits: hits }).code, "PROTECTED_VALUE", "§6 a hit in DTR_NAME");
	eq(rules.protectedValueRefusal({ row, names: ["99887766.pdf"], denyHits: hits }).code, "PROTECTED_VALUE", "§6 a hit in a file name");
	const seen = [];
	rules.protectedValueRefusal({ row, names, denyHits: (v) => { seen.push(v); return false; } });
	eq(seen, ["Example Broker LLC", "11022026-7", "11/02/2026", "LD-TEST-0001", "2150.00", ...names], "§6 each composed value and both file names are read");
	eq(rules.protectedValueRefusal({ row, names }).code, "PROTECTED_VALUE", "§6 no reader: refused, because nothing was checked");
}

// ---------------------------------------------------------------- §7
section("§7 the debtor");
{
	const MAP = { "example-broker.test": "Example Broker LLC" };
	eq(rules.debtorFor("example-broker.test", MAP), { ok: true, name: "Example Broker LLC" }, "§7 the name a person set for the domain");
	eq(rules.debtorFor("EXAMPLE-BROKER.TEST", MAP).name, "Example Broker LLC", "§7 ...a domain's case doesn't matter");
	for (const [label, domain, map] of [["no mapping", "other.test", MAP], ["a subdomain", "ap.example-broker.test", MAP], ["a blank value", "example-broker.test", { "example-broker.test": "  " }], ["no map", "example-broker.test", null], ["no domain", "", MAP], ["an inherited key", "constructor", {}]]) {
		eq(rules.debtorFor(domain, map), { ok: false, code: "DEBTOR_UNMAPPED" }, `§7 ${label}: DEBTOR_UNMAPPED, no fallback`);
	}

	const NAME = "Example Broker LLC";
	const has = (text, name = NAME) => rules.printsDebtorName(name, text);
	ok(has("Carrier: LogisX  Bill to Example Broker LLC, 1 Made Up Way"), "§7 the rate con prints it");
	ok(has("Bill to Example  Broker\nLLC here"), "§7 ...whitespace aside");
	ok(has("BilltoExampleBrokerLLCMade Up Way"), "§7 ...and where the reader runs positioned words together");
	ok(has("Example Broker LLC"), "§7 ...the whole text");
	ok(!has("Bill to EXAMPLE BROKER LLC"), "§7 another case is another form of the name");
	ok(!has("Bill to Example Broker"), "§7 part of it isn't it");
	ok(!has("Bill to Another Broker LLC"), "§7 another broker's name");
	ok(!has("Example Brokerage LLC", "Example Broker"), "§7 inside a longer word isn't it");
	ok(!has("My Example Broker 123", "xample Broker"), "§7 the end of a longer word isn't it");
	ok(!has("Broker 123 Inc", "Broker 12"), "§7 a longer number isn't it");
	ok(has("Example Broker LLCis the broker"), "§7 ...while a word that starts straight after an initialism's capitals is");
	ok(has("Example Broker Inc.Made Up Way", "Example Broker Inc."), "§7 ...and a name ending in a stop");
	ok(!has(""), "§7 a rate con with no text prints nothing");
	ok(!rules.printsDebtorName("", "anything"), "§7 no name prints nowhere");
	ok(has("Bill to Example Broker, LLC", "Example Broker, LLC"), "§7 a name with a comma, as printed");
	eq(rules.debtorNameRefusal(NAME, "Example Broker LLC"), null, "§7 no refusal when it's printed");
	const notOnDoc = rules.debtorNameRefusal(NAME, "Another Broker LLC");
	eq([notOnDoc.ok, notOnDoc.code], [false, "DEBTOR_NAME_NOT_ON_DOC"], "§7 DEBTOR_NAME_NOT_ON_DOC when the text the app reads doesn't hold it");
	ok(/wasn't found in the text the app can read/.test(String(notOnDoc.error)), "§7 FAILS ON THE OLD CODE: ...in words that claim no more than that");
	for (const [label, shown] of [["nothing", ""], ["whitespace", " \n\t "], ["no text at all", undefined]]) {
		const unread = rules.debtorNameRefusal(NAME, shown);
		eq([unread.ok, unread.code], [false, "DEBTOR_NAME_UNREADABLE"], `§7 FAILS ON THE OLD CODE: a file that reads as ${label}: its own code, since the name may be on it`);
		ok(/couldn't be read/.test(String(unread.error)), `§7 FAILS ON THE OLD CODE: ...and words that say the file couldn't be read (${label})`);
	}
}

// ---------------------------------------------------------------- §8
section("§8 the whole-number rate-con test");
{
	const ID = "1234567";
	const OWN = "CARRIER CONFIRMATION Load Number 1234567 Total $2,150.00";
	const test = (over) => {
		const r = rules.rateConRefusal({ primary: { source: "drive", driveFileName: "ratecon 1234567.pdf" }, loadId: ID, rateConNumber: ID, rateConText: () => OWN, ...over });
		return r ? r.code : "ok";
	};
	eq(test({}), "ok", "§8 its file's name, its read's number and its text all say this load");
	eq(test({ primary: { source: "documents" } }), "ok", "§8 a rate-con row on the load stands for the name");
	eq(test({ primary: { source: "drive", driveFileName: "ratecon 12345678.pdf" } }), "RATECON_NAME_MISMATCH", "§8 another load's longer number in the file's name");
	eq(test({ primary: { source: "drive", driveFileName: "ratecon 7234567.pdf" } }), "RATECON_NAME_MISMATCH", "§8 another load's number ending the same");
	eq(test({ primary: { source: "drive", driveFileName: "" } }), "RATECON_NAME_MISMATCH", "§8 a file with no name");
	eq(test({ primary: { source: "drive-content" } }), "RATECON_NAME_MISMATCH", "§8 a file found by reading Drive stands for nothing");
	eq(test({ primary: { source: "documents-bol" } }), "RATECON_NAME_MISMATCH", "§8 a BOL in the rate con's place stands for nothing");
	eq(test({ primary: null }), "RATECON_NAME_MISMATCH", "§8 no file");
	eq(test({ rateConNumber: "12345678" }), "RATECON_NUMBER_MISMATCH", "§8 its read gives a longer number");
	eq(test({ rateConNumber: "1234567-A" }), "RATECON_NUMBER_MISMATCH", "§8 its read gives a suffix");
	eq(test({ rateConNumber: "" }), "RATECON_NUMBER_MISMATCH", "§8 its read gives none");
	eq(test({ rateConText: () => "Load Number 12345678" }), "RATECON_NUMBER_MISMATCH", "§8 its text holds the digits only inside a longer number");
	eq(test({ rateConText: () => "" }), "RATECON_NUMBER_MISMATCH", "§8 a file its reader can't read holds");
	eq(test({ loadId: "" }), "RATECON_NAME_MISMATCH", "§8 no load ID");
	eq(test({ rateConNumber: "#1234567" }), "ok", "§8 the app's own spelling of a load key is the same number");
}

// ---------------------------------------------------------------- §9
section("§9 the document rule");
{
	const doc = (id, type, uploaded_at) => ({ id, type, uploaded_at });
	const rows = [
		doc(1, "POD", "2026-11-02 10:00:00"), doc(2, "Receipt", "2026-11-02 10:00:00"), doc(3, "scale ticket", "2026-11-02 09:00:00"), doc(4, "BOL", "2026-11-02 12:00:00"),
		doc(5, "pod", "2026-11-02 08:00:00"), doc(6, "Other", "2026-11-02 08:00:00"), doc(7, "LUMPER", "2026-11-02 11:00:00"), doc(8, "RATECON", "2026-11-01 08:00:00"),
		doc(9, "Pallet", "2026-11-02 07:00:00"), doc(10, "POD", "2026-11-02 08:00:00"), doc(11, "Lumper Receipt", "2026-11-02 06:00:00"), doc(12, "Pallet Exchange", "2026-11-02 05:00:00"), doc(13, "Scale", "2026-11-02 04:00:00"),
	];
	eq(rules.batchDocuments(rows).map((d) => [d.kind, d.doc.id]), [["bol", 4], ["pod", 5], ["pod", 10], ["pod", 1], ["other", 13], ["other", 12], ["other", 11], ["other", 9], ["other", 3], ["other", 7]],
		"§9 BOLs, then PODs in page order (a tie by id), then lumper, scale and pallet in upload order; no receipt, no \"Other\", no rate-con row");
	eq(rules.batchDocuments(null), [], "§9 no rows");
	eq(rules.documentKind("Other"), null, "§9 a type that isn't on the list goes in no batch");
	const present = { invoice: true, rateCon: true, documents: [{ kind: "pod" }] };
	eq(rules.missingKinds(present), [], "§9 the invoice, the rate con and a POD: nothing missing");
	eq(rules.missingKinds({ ...present, documents: [{ kind: "bol" }] }), [], "§9 ...a BOL does for the POD, as the guide lists them");
	eq(rules.missingKinds({ ...present, invoice: false }), ["invoice"], "§9 no invoice");
	eq(rules.missingKinds({ ...present, rateCon: null }), ["ratecon"], "§9 no rate con");
	eq(rules.missingKinds({ ...present, documents: [{ kind: "other" }] }), ["pod"], "§9 a lumper receipt alone is no POD");
	eq(rules.missingKinds({}), ["invoice", "ratecon", "pod"], "§9 nothing at all");
}

// ---------------------------------------------------------------- §10
section("§10 the free checks");
{
	const cols = autoRules.jobColumns(["Load ID", "Status", "Email", "Delivery Date", "  Payment  "]);
	const row = (over = {}) => ({ "Load ID": "LD-TEST-0001", Status: "Delivered", Email: "ap@example-broker.test", "Delivery Date": "11/02/2026", "  Payment  ": "2150", ...over });
	const records = (over = {}) => ({ pods: [{ id: 1 }], rateCons: [{ id: 2 }], drafts: [], deleted: false, ...over });
	const facts = (over = {}, recs = {}) => ({ ...autoRules.loadFacts({ row: row(over), cols, records: records(recs), confirmedDomains: ["example-broker.test"], closedMonths: [] }) });
	const READY = { debtorName: "Example Broker LLC", hasLines: true };
	const say = (f, opts = READY) => { const v = rules.freeVerdict(f, opts); return `${v.state}${v.code ? ` ${v.code}` : ""}`; };
	eq(say(facts()), "queued", "§10 a delivered load with everything set: queued");
	eq(say(facts({ Status: "In Transit" })), "waiting NOT_COMPLETED", "§10 not completed: waiting");
	eq(say(facts({ Status: "Cancelled" })), "waiting LOAD_DROPPED", "§10 cancelled: waiting");
	eq(say(facts({}, { deleted: true })), "waiting LOAD_DROPPED", "§10 deleted: waiting");
	eq(say(null), "waiting LOAD_DROPPED", "§10 no facts: waiting");
	const drafted = facts({}, { drafts: [{ id: 1 }] });
	eq(say(drafted), "needs_attention ALREADY_INVOICED", "§10 a draft row: ALREADY_INVOICED");
	eq(say(drafted, { ...READY, ownDrafts: 1 }), "queued", "§10 ...unless it's the submission's own");
	eq(say(facts(), { ...READY, inflight: "in_flight" }), "waiting INVOICE_DRAFT_IN_FLIGHT", "§10 a button draft in flight: waiting");
	eq(say(facts(), { ...READY, inflight: "maybe_drafted" }), "needs_attention INVOICE_MAYBE_DRAFTED", "§10 one that may be in Gmail: a person");
	eq(say({ ...facts(), closedMonths: ["2026-10"] }), "needs_attention CLOSED_MONTH", "§10 a closed month");
	eq(say({ ...facts(), closedMonths: undefined }), "needs_attention MONTH_UNKNOWN", "§10 a month it can't tell");
	eq(say({ ...facts(), closedMonths: ["2026-10"] }, { ...READY, checkMonth: false }), "queued", "§10 a report over past loads skips the month");
	eq(say(facts({ "Delivery Date": "" })), "needs_attention NO_DELIVERY_DATE", "§10 no delivery date");
	eq(say({ ...facts(), activeAdvanceLines: 1 }), "needs_attention ADVANCE_LINES", "§10 an advance line");
	eq(say(facts({}, { pods: [] })), "waiting WAITING_POD", "§10 no POD: waiting");
	eq(say({ ...facts(), podsUnreadable: 1 }), "needs_attention POD_UNREADABLE", "§10 a POD that can't be read");
	eq(say(facts({ Email: "" })), "needs_attention NO_BROKER_EMAIL", "§10 no broker email");
	eq(say(facts({ Email: "someone@gmail.com" })), "needs_attention BROKER_EMAIL_FREEMAIL", "§10 a free-mail broker");
	eq(say(facts({ Email: "ap@other-broker.test" })), "needs_attention BROKER_DOMAIN_UNCONFIRMED", "§10 a domain no person confirmed");
	eq(say(facts(), { hasLines: true }), "needs_attention DEBTOR_UNMAPPED", "§10 no debtor name");
	eq(say(facts(), { debtorName: "Example Broker LLC" }), "needs_attention NOA_UNCONFIGURED", "§10 no assignment lines");
	eq(say(facts(), { debtorName: "Example Broker LLC", hasLines: "true" }), "needs_attention NOA_UNCONFIGURED", "§10 ...only a real true says they exist");

	// In the plan's order: the earlier check answers when two hold.
	const all = { ...facts({ Email: "someone@gmail.com", "Delivery Date": "" }, { pods: [], drafts: [{ id: 1 }] }), closedMonths: ["2026-10"], activeAdvanceLines: 1 };
	eq(say(all, { hasLines: false }), "needs_attention ALREADY_INVOICED", "§10 the draft row comes first");
	eq(say({ ...all, drafts: 0 }, { hasLines: false }), "needs_attention CLOSED_MONTH", "§10 then the month");
	eq(say({ ...all, drafts: 0, closedMonths: [] }, { hasLines: false }), "needs_attention NO_DELIVERY_DATE", "§10 then the delivery date");
	eq(say({ ...all, drafts: 0, closedMonths: [], hasDeliveryDate: true }, { hasLines: false }), "needs_attention ADVANCE_LINES", "§10 then an advance line");
	eq(say({ ...all, drafts: 0, closedMonths: [], hasDeliveryDate: true, activeAdvanceLines: 0 }, { hasLines: false }), "waiting WAITING_POD", "§10 then the POD");
	eq(say({ ...all, drafts: 0, closedMonths: [], hasDeliveryDate: true, activeAdvanceLines: 0, pods: 1 }, { hasLines: false }), "needs_attention BROKER_EMAIL_FREEMAIL", "§10 then the broker");
	const everyCode = ["LOAD_DROPPED", "NOT_COMPLETED", "ALREADY_INVOICED", "INVOICE_DRAFT_IN_FLIGHT", "INVOICE_MAYBE_DRAFTED", "CLOSED_MONTH", "MONTH_UNKNOWN", "NO_DELIVERY_DATE", "ADVANCE_LINES", "WAITING_POD", "POD_UNREADABLE",
		"NO_BROKER_EMAIL", "BROKER_EMAIL_FREEMAIL", "BROKER_DOMAIN_UNCONFIRMED", "DEBTOR_UNMAPPED", "NOA_UNCONFIGURED",
		"FIELD_UNUSABLE", "PO_UNUSABLE", "PROTECTED_VALUE", "DOCUMENT_MISSING", "DOCUMENT_UNREADABLE", "MERGE_FAILED", "BATCH_TOO_LARGE", "DEBTOR_NAME_NOT_ON_DOC", "DEBTOR_NAME_UNREADABLE", "RATECON_NAME_MISMATCH", "RATECON_NUMBER_MISMATCH"];
	eq([...rules.REASON_CODES].sort(), [...everyCode].sort(), "§10 every code is on the list, each once");
}

// ---------------------------------------------------------------- §11
section("§11 no remit address in the code");
{
	// The shape of a mailing address: a repo that's public holds the lines only as a setting.
	const ADDRESS = /\bP\.?\s?O\.?\s{0,2}BOX\b|\bD\/B\/A\b|\b[A-Z]{2} {2}\d{5}\b/i;
	const files = [
		...fs.readdirSync(path.join(ROOT, "lib")).filter((f) => /^triumph-.*\.js$/.test(f) || f === "factoring-routes.js" || f === "factoring-store.js").map((f) => path.join("lib", f)),
		...fs.readdirSync(path.join(ROOT, "scripts")).filter((f) => /^triumph-.*\.js$/.test(f)).map((f) => path.join("scripts", f)),
	];
	ok(files.length >= 7, "§11 (fixture) the new modules and scripts were found");
	eq(files.filter((f) => ADDRESS.test(fs.readFileSync(path.join(ROOT, f), "utf8"))), [], "§11 none of them holds an address");
	const parseSrc = fs.readFileSync(RULES_FILE, "utf8");
	ok(!/TRIUMPH_NOA_LINES\s*(\|\||\?\?)/.test(parseSrc) && !/TRIUMPH_NOA_LINES\s*=\s*["'`]/.test(parseSrc), "§11 the setting has no default in code");
	ok(!/require\("(fs|net|http|https|tls|child_process|better-sqlite3|googleapis|ssh2)"\)/.test(parseSrc), "§11 the rules stay pure: no file, network or database");
}

console.log(`\n${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log(`FAIL  ${f}`);
process.exit(failures.length ? 1 : 0);
