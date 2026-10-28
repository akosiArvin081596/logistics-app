// Free, consumer and ISP mail: anyone can hold an address there, so a broker
// Email on one of these says nothing about who may bill that broker. Automatic
// invoice drafts never treat such a domain as a broker's own (the auto-invoice
// rules and the draft engine both read this one list).
//
// isFreeMailDomain(domain) is true for a listed domain or any subdomain of one
// ("nc.rr.com", "mail.yahoo.com"), and for a listed provider's own name under
// any country suffix ("yahoo.co.uk", "hotmail.com.mx", "gmx.de"). Missing an
// entry is not unsafe on its own: a domain nobody confirmed drafts nothing.
//
// Pure: no requires, no I/O. This file is shared byte for byte between the
// auto-invoice and draft-engine branches; scripts/test-free-mail-domains.js pins
// its sha256, so a change here is made in one place and the pin moved with it.

"use strict";

const FREE_MAIL_DOMAINS = Object.freeze([
	// Webmail
	"126.com", "163.com", "aim.com", "aol.com", "email.com", "fastmail.com", "gmail.com", "gmx.com", "gmx.de", "gmx.net",
	"gmx.us", "googlemail.com", "hotmail.ca", "hotmail.co.uk", "hotmail.com", "hotmail.com.mx", "hotmail.es", "hushmail.com",
	"icloud.com", "inbox.com", "live.ca", "live.com", "live.com.mx", "mac.com", "mail.com", "mail.ru", "me.com", "msn.com",
	"outlook.com", "outlook.es", "passport.com", "pm.me", "proton.me", "protonmail.ch", "protonmail.com", "qq.com",
	"rocketmail.com", "tuta.io", "tutanota.com", "usa.com", "yahoo.ca", "yahoo.co.in", "yahoo.co.uk", "yahoo.com",
	"yahoo.com.mx", "yahoo.ne.jp", "yandex.com", "yandex.ru", "ymail.com", "zoho.com", "zohomail.com",
	// US ISPs, the eight approved first among them
	"att.net", "bellsouth.net", "charter.net", "comcast.net", "cox.net", "earthlink.net", "sbcglobal.net", "verizon.net",
	"ameritech.net", "flash.net", "nvbell.net", "pacbell.net", "prodigy.net", "snet.net", "swbell.net", "wans.net",
	"cableone.net", "centurylink.net", "centurytel.net", "embarqmail.com", "frontier.com", "frontiernet.net", "juno.com",
	"mediacombb.net", "netzero.com", "netzero.net", "optimum.net", "optonline.net", "q.com", "qwest.net", "rcn.com",
	"roadrunner.com", "rr.com", "spectrum.net", "suddenlink.net", "tds.net", "twc.com", "windstream.net", "wowway.com",
	"xfinity.com",
	// Canadian and Mexican consumer and ISP mail
	"bell.net", "cogeco.ca", "eastlink.ca", "prodigy.net.mx", "rogers.com", "shaw.ca", "sympatico.ca", "telus.net",
	"videotron.ca",
]);

// Providers whose own name marks free mail under any country suffix.
const FREE_MAIL_PROVIDERS = Object.freeze([
	"aol", "gmail", "gmx", "googlemail", "hotmail", "icloud", "live", "msn", "outlook", "protonmail", "rocketmail", "yahoo",
	"yandex", "ymail", "zoho",
]);

// Second-level labels of country suffixes ("co.uk", "com.mx", "ne.jp").
const COUNTRY_SECOND_LEVEL = Object.freeze(["ac", "co", "com", "gob", "ne", "net", "or", "org"]);

function isFreeMailDomain(domain) {
	const d = String(domain == null ? "" : domain).trim().toLowerCase().replace(/\.+$/, "");
	if (!d || d.length > 253) return false;
	if (FREE_MAIL_DOMAINS.some((f) => d === f || d.endsWith("." + f))) return true;
	let labels = d.split(".").filter(Boolean);
	if (labels.length < 2) return false;
	const last = labels[labels.length - 1];
	if (labels.length >= 3 && last.length === 2 && COUNTRY_SECOND_LEVEL.includes(labels[labels.length - 2])) labels = labels.slice(0, -2);
	else labels = labels.slice(0, -1);
	return FREE_MAIL_PROVIDERS.includes(labels[labels.length - 1]);
}

module.exports = { FREE_MAIL_DOMAINS, FREE_MAIL_PROVIDERS, isFreeMailDomain };
