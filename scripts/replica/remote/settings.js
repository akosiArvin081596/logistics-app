#!/usr/bin/env node
// replica:pull, on the server, step 2b: production's NON-SECRET settings, for
// the replica's ~/LogisX-replica/settings.env.
//
//   node settings.js --app=<app dir> --out=/root/logisx-replica-tmp/<stamp>/settings.env
//
// Reads <app dir>/.env with the app's own dotenv and judges every setting with
// lib/replica-rules.js (classifySetting): a name containing KEY, SECRET, TOKEN,
// PASS, CREDENTIAL, PRIVATE, AUTH, SMTP, DSN or WEBHOOK is a secret and is never
// copied, nor is a value that is a URL carrying credentials, nor a runtime
// setting replica:start sets itself (NODE_ENV, PORT, ...). The rest is written,
// file mode 600, and only names are printed: the copied keys, and each skipped
// key with the rule that skipped it. No value is ever printed.
"use strict";

const fs = require("fs");
const path = require("path");
const rules = require(fs.existsSync(path.join(__dirname, "replica-rules.js")) ? "./replica-rules" : "../../../lib/replica-rules");

function arg(name) {
	const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
	return hit ? hit.slice(name.length + 3) : undefined;
}

// One NAME=value line dotenv reads back as exactly `value`: single quotes keep
// a value literal; backticks when it holds a single quote. Null when it cannot
// be written either way.
function envLine(name, value) {
	const v = String(value);
	if (!v.includes("'")) return `${name}='${v}'`;
	if (!v.includes("`")) return `${name}=\`${v}\``;
	return null;
}

function exportSettings(parsed) {
	const copied = [];
	const skipped = [];
	const lines = [];
	for (const name of Object.keys(parsed).sort()) {
		const verdict = rules.classifySetting(name, parsed[name]);
		if (!verdict.copy) { skipped.push({ name, rule: verdict.rule }); continue; }
		const line = envLine(name, parsed[name]);
		if (!line) { skipped.push({ name, rule: "value cannot be quoted for .env" }); continue; }
		lines.push(line);
		copied.push(name);
	}
	return { copied, skipped, text: lines.length ? lines.join("\n") + "\n" : "" };
}

if (require.main === module) {
	try {
		const appDir = arg("app");
		const out = arg("out");
		if (!appDir || !out) throw new Error("usage: settings.js --app=<app dir> --out=<settings.env>");
		const dotenv = require(path.join(appDir, "node_modules", "dotenv"));
		const envFile = path.join(appDir, ".env");
		const parsed = fs.existsSync(envFile) ? dotenv.parse(fs.readFileSync(envFile)) : {};
		const { copied, skipped, text } = exportSettings(parsed);
		fs.writeFileSync(out, text, { mode: 0o600, flag: "wx" });
		console.log(JSON.stringify({ step: "settings", copied, skipped }));
	} catch (err) {
		console.error(`settings: ${err.message}`);
		process.exit(1);
	}
}

module.exports = { exportSettings, envLine };
