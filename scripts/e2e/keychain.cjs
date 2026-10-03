// The harness's logins: names and ids in the logins file, passwords in the
// macOS Keychain. No password is ever written to a file or printed.
//
//   logins file   <work dir>/logins.json (LOGINS_FILE overrides), chmod 600:
//                 { "superAdmin": { "username", "userId" }, "driver": { …, "truckId",
//                 "applicationId" }, "investor": {…}, "investor2": {…}, "dispatcher": {…} }
//                 written by setup-db.cjs. An entry may name its own Keychain item
//                 with "keychain": { "service", "account" } (a staging login:
//                 { "service": "logisx-staging" }); otherwise it is service
//                 logisx-e2e-local (E2E_KEYCHAIN_SERVICE overrides), account = the
//                 entry's key.
//   Keychain      read with `security find-generic-password -w` when a run starts,
//                 kept in memory only; written with `security -i`, whose commands
//                 arrive on stdin, so a password is never in any process's argv.
//
// creds.json, the old file that held the passwords themselves, is deleted by
// setup-db.cjs wherever it finds one.
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

const ROLES = ["superAdmin", "driver", "investor", "investor2", "dispatcher"];
const DEFAULT_SERVICE = () => process.env.E2E_KEYCHAIN_SERVICE || "logisx-e2e-local";
const LEGACY_CREDS = "creds.json";

function loginsFile(work) {
	return process.env.LOGINS_FILE || path.join(work, "logins.json");
}

function itemFor(key, entry) {
	const k = (entry && entry.keychain) || {};
	if (k.service) return { service: String(k.service), account: k.account ? String(k.account) : null };
	return { service: DEFAULT_SERVICE(), account: key };
}

function requireSecurity() {
	const r = spawnSync("security", ["help"], { stdio: "ignore" });
	if (r.error) throw new Error("the macOS `security` tool is not available: the harness keeps its passwords in the Keychain");
}

// The password of a Keychain item, or null when there is none.
function readPassword({ service, account }) {
	const args = ["find-generic-password", "-s", service, ...(account ? ["-a", account] : []), "-w"];
	try {
		return execFileSync("security", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).replace(/\n$/, "") || null;
	} catch {
		return null;
	}
}

// Store (or replace) a password, then read it back. The quoting covers the
// harness's own passwords (base64url); anything else is refused.
function storePassword({ service, account }, password) {
	for (const [name, v] of [["service", service], ["account", account], ["password", password]]) {
		if (!/^[A-Za-z0-9._-]+$/.test(String(v || ""))) throw new Error(`refusing to store a Keychain item: its ${name} has characters the harness does not use`);
	}
	const r = spawnSync("security", ["-i"], { input: `add-generic-password -U -s "${service}" -a "${account}" -w "${password}"\n`, encoding: "utf8" });
	if (r.status !== 0) throw new Error(`security add-generic-password failed for ${service}/${account}`);
	if (readPassword({ service, account }) !== password) throw new Error(`the Keychain item ${service}/${account} did not read back`);
}

// The logins file with each entry's password filled from the Keychain (in
// memory). An entry whose Keychain item is missing is an error naming the item,
// never a password.
function loadLogins(file) {
	const logins = JSON.parse(fs.readFileSync(file, "utf8"));
	for (const key of ROLES) {
		const entry = logins[key];
		if (!entry) continue;
		if ("password" in entry) throw new Error(`${file} holds a password (${key}); passwords live in the Keychain only. Delete the file and run setup-db.cjs again`);
		const item = itemFor(key, entry);
		const pw = readPassword(item);
		if (!pw) throw new Error(`no Keychain password for ${key} (service ${item.service}${item.account ? `, account ${item.account}` : ""}); run setup-db.cjs, or add it to the Keychain`);
		Object.defineProperty(entry, "password", { value: pw, enumerable: false });
	}
	return logins;
}

// Delete the old password file(s): <work dir>/creds.json and $CREDS_FILE.
function removeLegacyCreds(work) {
	const removed = [];
	for (const f of [path.join(work, LEGACY_CREDS), process.env.CREDS_FILE].filter(Boolean)) {
		if (fs.existsSync(f)) { fs.unlinkSync(f); removed.push(f); }
	}
	return removed;
}

module.exports = { ROLES, loginsFile, itemFor, readPassword, storePassword, loadLogins, removeLegacyCreds, requireSecurity, DEFAULT_SERVICE };
