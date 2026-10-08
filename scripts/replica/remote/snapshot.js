#!/usr/bin/env node
// replica:pull, on the server, step 1: a consistent copy of the live database
// into the pull's temporary folder, without writing to the live database.
//
//   node snapshot.js --app=<app dir> --stamp=<stamp>
//
// The live app.db is opened read-only (better-sqlite3 { readonly: true,
// fileMustExist: true }) and copied with VACUUM INTO, which reads the database
// through SQLite (rows still in the -wal included) and writes only the new
// file: /root/logisx-replica-tmp/<stamp>/app.db. The folder must already exist
// (the pull creates it, mode 700) and the file must not. The production-write
// guard allows this one shape: a read-only connection, VACUUM INTO, one folder
// level under /root/logisx-replica-tmp, a file named app.db.
//
// scripts/test-replica-snapshot.js runs this file against a local WAL database
// and proves the source and its -wal are byte-identical afterwards, that the
// copy carries the rows the WAL still held, and that the connection refuses a
// write (SQLITE_READONLY). For that runner only, --source and --parent point it
// at temporary files.
"use strict";

const fs = require("fs");
const path = require("path");
const rules = require(fs.existsSync(path.join(__dirname, "replica-rules.js")) ? "./replica-rules" : "../../../lib/replica-rules");

function arg(name) {
	const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
	return hit ? hit.slice(name.length + 3) : undefined;
}

function snapshotPath(parent, stamp) {
	if (!rules.isValidStamp(stamp)) throw new Error("the stamp must be letters, digits, _ and -, starting with a letter or digit");
	return path.join(parent, stamp, "app.db");
}

function snapshot({ appDir, source, dest }) {
	const Database = require(path.join(appDir, "node_modules", "better-sqlite3"));
	if (!fs.existsSync(path.dirname(dest))) throw new Error(`${path.dirname(dest)} does not exist`);
	if (fs.existsSync(dest)) throw new Error(`${dest} already exists`);
	const db = new Database(source, { readonly: true, fileMustExist: true });
	try {
		db.prepare("VACUUM INTO ?").run(dest);
	} finally {
		db.close();
	}
	fs.chmodSync(dest, 0o600);
	return { bytes: fs.statSync(dest).size };
}

if (require.main === module) {
	try {
		const appDir = arg("app");
		const stamp = arg("stamp");
		if (!appDir || !stamp) throw new Error("usage: snapshot.js --app=<app dir> --stamp=<stamp>");
		const parent = arg("parent") || rules.REMOTE_TMP_PARENT;
		const dest = snapshotPath(parent, stamp);
		const source = arg("source") || path.join(appDir, "app.db");
		const { bytes } = snapshot({ appDir, source, dest });
		console.log(`snapshot: ${(bytes / 1048576).toFixed(1)} MiB copied read-only with VACUUM INTO`);
	} catch (err) {
		console.error(`snapshot: ${err.message}`);
		process.exit(1);
	}
}

module.exports = { snapshot, snapshotPath };
