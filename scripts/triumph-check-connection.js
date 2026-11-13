#!/usr/bin/env node
// Signs in to Triumph's SFTP drop and lists its two folders, read only: the first connection
// (G6, on Arvin's own yes), the monthly check that access still works, and the look at the
// submissions folder after the sample (file names only). The transport's read mode
// (lib/triumph-transfer.js): no write, rename or delete can be asked for.
//
//   node scripts/triumph-check-connection.js [--audit-db=<app.db>] [--json]
//
// The settings are the app's own, from its settings file on the box (TRIUMPH_HOST and the rest;
// lib/triumph-rules.js transportSettings()). It checks the host key against the pinned
// fingerprint before it signs in, with the key alone. A reports folder that is empty, or isn't
// there yet, is no failure: Triumph makes its reports once submissions flow. Nothing is written
// anywhere unless --audit-db names the app's database, which then gets one audit row,
// triumph_connection_checked, with the counts.
//
// Output: whether the sign-in worked, and each folder's file count and names; never the host,
// the user, a folder's path or the key's. Exit 0 signed in; 2 refused (settings missing or
// invalid, or a replica); 1 the connection failed, with its code.
//
// Required as a module (by its runner) it runs nothing and exports run().

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const ACTOR = Object.freeze({ id: 0, username: "triumph-check", role: "system" });

class Refusal extends Error {}

function parseArgs(argv) {
	const out = {};
	for (const a of argv) {
		const m = /^--([a-z-]{1,20})(?:=(.*))?$/s.exec(String(a));
		if (!m) throw new Refusal(`unknown argument: ${String(a).slice(0, 40)}`);
		if (m[1] === "json" && m[2] === undefined) out.json = true;
		else if (m[1] === "audit-db" && m[2]) out["audit-db"] = m[2];
		else throw new Refusal(`unknown or malformed argument: --${m[1]}`);
	}
	return out;
}

// `createTransport` is lib/triumph-transfer.js create(). Answers the folders' names.
async function run(argv, { env = process.env, replica = false, createTransport = (o) => require("../lib/triumph-transfer").create(o), now = () => new Date() } = {}) {
	const args = parseArgs(argv);
	if (args["audit-db"] && !fs.existsSync(path.resolve(args["audit-db"]))) throw new Refusal("--audit-db names no file");
	const transport = createTransport({ env, replica });
	if (replica) throw new Refusal("TRANSPORT_REPLICA: a replica connects to nothing");
	if (!transport.configured) throw new Refusal(`TRANSPORT_UNCONFIGURED: ${[...transport.missing, ...transport.invalid].join(", ")}`);
	const session = await transport.openRead();
	const folders = {};
	try {
		for (const folder of ["submit", "reports"]) {
			try {
				const names = (await session.list(folder)).map((e) => e.name).sort();
				folders[folder] = { count: names.length, names };
			} catch (e) {
				if (e && e.code === "FOLDER_UNSET") folders[folder] = { count: 0, names: [], unset: true };
				else throw e;
			}
		}
	} finally {
		session.close();
	}
	if (args["audit-db"]) {
		const Database = require(path.join(ROOT, "node_modules", "better-sqlite3"));
		const db = new Database(path.resolve(args["audit-db"]), { fileMustExist: true });
		try {
			db.pragma("busy_timeout = 5000");
			db.prepare("INSERT INTO audit_trail (timestamp, user_id, username, role, action, entity, entity_id, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
				.run(now().toISOString(), ACTOR.id, ACTOR.username, ACTOR.role, "triumph_connection_checked", "triumph", "",
					`signed in; submissions ${folders.submit.count} file(s), reports ${folders.reports.unset ? "not set" : `${folders.reports.count} file(s)`}`);
		} finally {
			db.close();
		}
	}
	return { signedIn: true, folders };
}

function textOf(r) {
	const lines = ["Signed in: the host key matched the pinned fingerprint, and the key was accepted."];
	for (const [folder, f] of Object.entries(r.folders)) {
		const label = folder === "submit" ? "submissions" : "reports";
		lines.push(f.unset ? `  ${label}: no folder set` : `  ${label}: ${f.count} file(s)${f.count ? `: ${f.names.join(", ")}` : ""}`);
	}
	return lines.join("\n");
}

async function main(argv) {
	try {
		parseArgs(argv);
		require("dotenv").config({ quiet: true });
		const r = await run(argv, { replica: require("../lib/replica-mode").active() });
		process.stdout.write(`${argv.includes("--json") ? JSON.stringify(r) : textOf(r)}\n`);
		return 0;
	} catch (e) {
		if (e instanceof Refusal) {
			process.stderr.write(`REFUSED: ${e.message}\n`);
			return 2;
		}
		process.stderr.write(`FAILED: ${(e && e.code) || "ERROR"}\n`);
		return 1;
	}
}

if (require.main === module) main(process.argv.slice(2)).then((code) => { process.exitCode = code; });

module.exports = { run, parseArgs, textOf, Refusal };
