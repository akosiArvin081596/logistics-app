#!/usr/bin/env node
// lib/free-mail-domains.js: the one free, consumer and ISP mail list automatic
// invoice drafts use (the auto-invoice rules and the draft engine).
//
//   §1 the families it must hold: webmail; the US ISPs (the eight approved, the
//      AT&T legacy domains, Spectrum/Road Runner regional domains, Frontier,
//      Windstream, CenturyLink, Optimum and the rest); Canadian and Mexican mail;
//      and every entry of the draft engine's own list (870eb5f), so the union lost
//      nothing
//   §2 matching: exact, any subdomain, a provider's name under any country
//      suffix, in any case; and the domains it must not take
//   §3 the file is pure and pinned: no require, no I/O, and its sha256 is the
//      one the draft engine's copy must have (change both, move the pin)
//   §4 lib/auto-invoice-rules.js uses this list, not a copy
//
//   node scripts/test-free-mail-domains.js      # exits 1 on any failure
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const FILE = path.join(ROOT, "lib", "free-mail-domains.js");
const F = require(FILE);
const rules = require(path.join(ROOT, "lib", "auto-invoice-rules.js"));

// The file both branches carry, byte for byte.
const PINNED_SHA256 = "37957eecd99251a31cc75df3f7997e7ce9dba6f50ea0dad883dbe5f02ee4c043";

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

// ------------------------------------------------------------------ §1
section("§1  the families");
const FAMILIES = {
	webmail: ["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com", "ymail.com", "rocketmail.com",
		"aol.com", "aim.com", "icloud.com", "me.com", "mac.com", "proton.me", "pm.me", "protonmail.com", "protonmail.ch", "gmx.com", "gmx.net",
		"mail.com", "zoho.com", "zohomail.com", "yandex.com", "yandex.ru", "mail.ru", "qq.com", "163.com", "yahoo.ne.jp", "fastmail.com"],
	approvedUsIsps: ["att.net", "sbcglobal.net", "bellsouth.net", "comcast.net", "verizon.net", "cox.net", "charter.net", "earthlink.net"],
	attLegacy: ["pacbell.net", "swbell.net", "ameritech.net", "flash.net", "prodigy.net", "snet.net", "nvbell.net", "wans.net"],
	usIsps: ["juno.com", "netzero.net", "netzero.com", "rr.com", "roadrunner.com", "twc.com", "spectrum.net", "optonline.net", "optimum.net",
		"windstream.net", "frontier.com", "frontiernet.net", "centurylink.net", "centurytel.net", "q.com", "qwest.net", "embarqmail.com",
		"xfinity.com", "suddenlink.net", "mediacombb.net", "cableone.net", "wowway.com", "rcn.com", "tds.net"],
	spectrumRegional: ["nc.rr.com", "triad.rr.com", "tampabay.rr.com", "socal.rr.com", "twcny.rr.com", "austin.rr.com", "cfl.rr.com"],
	canada: ["shaw.ca", "rogers.com", "sympatico.ca", "bell.net", "videotron.ca", "telus.net", "cogeco.ca", "eastlink.ca", "hotmail.ca",
		"live.ca", "yahoo.ca"],
	mexico: ["prodigy.net.mx", "hotmail.com.mx", "live.com.mx", "yahoo.com.mx", "outlook.com.mx"],
	reviewSpain: ["hotmail.es", "outlook.es", "yahoo.co.in"],
};
for (const [family, domains] of Object.entries(FAMILIES)) {
	const missing = domains.filter((d) => !F.isFreeMailDomain(d));
	eq(missing, [], `§1 ${family}: every domain is free mail`);
}
// The draft engine's list as it stood on feat/broker-invoice-engine at 870eb5f.
const ENGINE_DOMAINS = ["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com", "ymail.com",
	"rocketmail.com", "aol.com", "icloud.com", "me.com", "mac.com", "proton.me", "pm.me", "protonmail.com",
	"protonmail.ch", "gmx.com", "gmx.net", "mail.com", "zoho.com", "zohomail.com", "yandex.com", "yandex.ru",
	"comcast.net", "att.net", "sbcglobal.net", "bellsouth.net", "verizon.net", "cox.net", "charter.net", "earthlink.net"];
const ENGINE_PROVIDERS = ["gmail", "googlemail", "outlook", "hotmail", "live", "msn", "yahoo", "ymail", "aol", "icloud", "protonmail", "gmx", "zoho", "yandex"];
eq(ENGINE_DOMAINS.filter((d) => !F.FREE_MAIL_DOMAINS.includes(d)), [], "§1 every domain of the engine's list is in the shared list");
eq(ENGINE_PROVIDERS.filter((p) => !F.FREE_MAIL_PROVIDERS.includes(p)), [], "§1 every provider of the engine's list is in the shared list");
eq(F.FREE_MAIL_DOMAINS.length, new Set(F.FREE_MAIL_DOMAINS).size, "§1 each domain once");
ok(F.FREE_MAIL_DOMAINS.every((d) => d === d.toLowerCase() && /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)), "§1 every entry is a lower-case domain");
ok(Object.isFrozen(F.FREE_MAIL_DOMAINS) && Object.isFrozen(F.FREE_MAIL_PROVIDERS), "§1 the lists are frozen");

// ------------------------------------------------------------------ §2
section("§2  matching");
for (const d of ["GMAIL.com", "mail.yahoo.com", "Yahoo.Co.UK", "hotmail.fr", "gmx.de", "aol.co.uk", "live.com.au", "outlook.jp", "zoho.in",
	"yahoo.com.br", "comcast.net.", " shaw.ca "]) ok(F.isFreeMailDomain(d), `§2 ${JSON.stringify(d)} is free mail`);
for (const d of ["example-broker.test", "bisontransport.com", "notgmail.com", "gmail.com.example.test", "mygmail.com", "yahoo-freight.com",
	"outlook-logistics.com", "live.example.com", "hotmail.example.test", "rr.com.example.test", "", null, "com", "a".repeat(260) + ".com"]) {
	ok(!F.isFreeMailDomain(d), `§2 ${JSON.stringify(d && d.length > 40 ? `${d.slice(0, 12)}…` : d)} is not free mail`);
}

// ------------------------------------------------------------------ §3
section("§3  pure and pinned");
const SRC = fs.readFileSync(FILE);
ok(!/\brequire\s*\(|process\.|\bfetch\s*\(/.test(SRC.toString("utf8")), "§3 no require, process or network");
eq(crypto.createHash("sha256").update(SRC).digest("hex"), PINNED_SHA256,
	"§3 the file's sha256 is the pinned one (the draft engine's copy must match byte for byte; change both and move the pin)");

// ------------------------------------------------------------------ §4
section("§4  the auto-invoice rules use it");
ok(rules.isFreemailDomain === F.isFreeMailDomain, "§4 rules.isFreemailDomain is this module's function");
ok(rules.FREEMAIL_DOMAINS === F.FREE_MAIL_DOMAINS, "§4 rules.FREEMAIL_DOMAINS is this module's list");
eq(rules.normalizeConfirmedDomains(["nc.rr.com"]).code, "CONFIRMED_DOMAIN_FREEMAIL", "§4 the settings refuse a regional Spectrum domain");
eq(rules.recipientRule({ brokerEmail: "made-up-ops@yahoo.com.mx", documentsEmail: "made-up@yahoo.com.mx", confirmedDomains: ["yahoo.com.mx"] }).code,
	"BROKER_EMAIL_FREEMAIL", "§4 the recipient rule refuses a Mexican free-mail broker Email");

console.log(`\n${"=".repeat(64)}`);
if (failures.length) {
	console.log(`FAILURES (${failures.length}):`);
	failures.forEach((f) => console.log(`  ✗ ${f}`));
	console.log(`\n${pass} passed, ${failures.length} failed`);
	process.exit(1);
}
console.log(`✓ ${pass} assertions passed`);
