// Which database an admin script opens: the app's own, as server.js opens it,
// or a copy of it. Used by scripts/create-correction-invoice-draft.js and
// scripts/set-settlement-grace-days.js, which run on the server from the app
// directory.
//
//   - The app's own: DATABASE_PATH from the environment, else from the app
//     directory's .env (read, never loaded into the process), else app.db in
//     the app directory: server.js's `process.env.DATABASE_PATH ||
//     path.join(__dirname, "app.db")` after dotenv.
//   - A copy: any other existing file whose folder is not an app directory (it
//     holds no server.js and no .env), so a script never opens another
//     deployment's database with this checkout's code.

"use strict";

const fs = require("fs");
const path = require("path");
const { createRequire } = require("module");

class DatabaseRefusal extends Error {}

function configuredDbPath(root) {
	let fromFile = "";
	const envFile = path.join(root, ".env");
	if (fs.existsSync(envFile)) {
		const appRequire = createRequire(path.join(root, "server.js"));
		fromFile = appRequire("dotenv").parse(fs.readFileSync(envFile)).DATABASE_PATH || "";
	}
	return process.env.DATABASE_PATH || fromFile || path.join(root, "app.db");
}

// `db`: the --db option, or null for the app's own. Returns
// { scope: "app" | "copy", file } (links resolved) or throws DatabaseRefusal.
function resolveDatabase(db, root) {
	const real = (p) => {
		try { return fs.realpathSync(p); } catch { throw new DatabaseRefusal(`--db ${p} does not exist`); }
	};
	const configured = configuredDbPath(root);
	const appFile = fs.existsSync(configured) ? fs.realpathSync(configured) : path.resolve(configured);
	if (!db || real(db) === appFile) {
		if (!fs.existsSync(appFile)) throw new DatabaseRefusal(`the app's database ${appFile} does not exist`);
		return { scope: "app", file: appFile };
	}
	const file = real(db);
	const dir = path.dirname(file);
	if (fs.existsSync(path.join(dir, "server.js")) || fs.existsSync(path.join(dir, ".env"))) {
		throw new DatabaseRefusal(`refusing ${db}: it sits in another app directory; open this app's own database or a copy outside any app directory`);
	}
	return { scope: "copy", file };
}

module.exports = { configuredDbPath, resolveDatabase, DatabaseRefusal };
