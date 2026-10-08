#!/usr/bin/env node
// replica:pull, on the server, step 2d: the manifest of what was copied, from
// where and as of when: the commit production runs, its Node version and time
// zone, every table's row count in the copy, and the summaries the scrub,
// settings and Sheets steps printed (names and counts only).
//
//   node manifest.js --app=<app dir> --dir=/root/logisx-replica-tmp/<stamp> --stamp=<stamp>
"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

function arg(name) {
	const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
	return hit ? hit.slice(name.length + 3) : undefined;
}

function readStep(dir, step) {
	const f = path.join(dir, `${step}.json`);
	return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null;
}

function rowCounts(Database, file) {
	const db = new Database(file, { readonly: true, fileMustExist: true });
	try {
		const out = {};
		const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);
		for (const t of tables) out[t] = db.prepare(`SELECT COUNT(*) AS c FROM "${t.replace(/"/g, '""')}"`).get().c;
		return out;
	} finally {
		db.close();
	}
}

if (require.main === module) {
	try {
		const appDir = arg("app");
		const dir = arg("dir");
		const stamp = arg("stamp");
		if (!appDir || !dir || !stamp) throw new Error("usage: manifest.js --app=<app dir> --dir=<pull folder> --stamp=<stamp>");
		const Database = require(path.join(appDir, "node_modules", "better-sqlite3"));
		const dotenv = require(path.join(appDir, "node_modules", "dotenv"));
		const envFile = path.join(appDir, ".env");
		const env = fs.existsSync(envFile) ? dotenv.parse(fs.readFileSync(envFile)) : {};
		const commit = execFileSync("git", ["-C", appDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
		const manifest = {
			format: 1,
			stamp,
			snapshotAt: new Date().toISOString(),
			production: {
				commit,
				node: process.version,
				// The app's TZ setting when it has one, else the server's zone.
				timeZone: (env.TZ || "").trim() || Intl.DateTimeFormat().resolvedOptions().timeZone,
				timeZoneSource: (env.TZ || "").trim() ? "TZ in the app's settings" : "the server's time zone",
			},
			database: { rows: rowCounts(Database, path.join(dir, "app.db")) },
			scrub: readStep(dir, "scrub"),
			settings: readStep(dir, "settings"),
			sheets: readStep(dir, "sheets-summary"),
		};
		fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600, flag: "wx" });
		console.log(JSON.stringify({ step: "manifest", commit, node: manifest.production.node, timeZone: manifest.production.timeZone, tables: Object.keys(manifest.database.rows).length }));
	} catch (err) {
		console.error(`manifest: ${err.message}`);
		process.exit(1);
	}
}

module.exports = { rowCounts };
