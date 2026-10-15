// Which database an admin script opens: the app's own, as server.js opens it,
// or a copy of it. Used by scripts/create-correction-invoice-draft.js and
// scripts/set-settlement-grace-days.js, which run on the server from the app
// directory.
//
//   - The app's own: DATABASE_PATH from the environment, else from the app
//     directory's .env (read, never loaded into the process), else app.db in
//     the app directory: server.js's `process.env.DATABASE_PATH ||
//     path.join(__dirname, "app.db")` after dotenv. Refused while LOCAL_REPLICA
//     is set to anything but an "off" value: a replica's database holds real
//     people's data and is never treated as the app's own.
//   - A copy: any other existing file outside the repository (`root`) whose
//     folder is not an app directory (it holds no server.js and no .env), so a
//     script never opens another deployment's database with this checkout's
//     code, and never puts a copy's files into the repository.

"use strict";

const fs = require("fs");
const path = require("path");
const { createRequire } = require("module");

class DatabaseRefusal extends Error {}

// LOCAL_REPLICA as lib/replica-mode.js reads it, except that a stray value
// counts as set here (a script refuses rather than guesses).
function replicaFlagSet(env) {
	const v = env.LOCAL_REPLICA;
	if (v === undefined || v === null) return false;
	return !/^(|0|false|no|off)$/i.test(String(v).trim());
}

function configuredDbPath(root, env = process.env) {
	let fromFile = "";
	const envFile = path.join(root, ".env");
	if (fs.existsSync(envFile)) {
		const appRequire = createRequire(path.join(root, "server.js"));
		fromFile = appRequire("dotenv").parse(fs.readFileSync(envFile)).DATABASE_PATH || "";
	}
	return env.DATABASE_PATH || fromFile || path.join(root, "app.db");
}

const inside = (p, base) => p === base || p.startsWith(`${base}${path.sep}`);

// True when `p` (resolved, links followed as far as they exist) is in `root`.
function insideRoot(p, root) {
	const realRoot = fs.realpathSync(root);
	let probe = path.resolve(p);
	try { probe = fs.realpathSync(probe); } catch { /* checked by its caller */ }
	return inside(probe, realRoot);
}

// `db`: the --db option, or null for the app's own. Returns
// { scope: "app" | "copy", file } (links resolved) or throws DatabaseRefusal.
function resolveDatabase(db, root, { env = process.env } = {}) {
	const replica = replicaFlagSet(env);
	const replicaRefusal = "LOCAL_REPLICA is set, so the app's database here is a replica's and is never treated as the app's own; name a plain copy outside the repository with --db";
	if (replica && !db) throw new DatabaseRefusal(replicaRefusal);
	const real = (p) => {
		try { return fs.realpathSync(p); } catch { throw new DatabaseRefusal(`--db ${p} does not exist`); }
	};
	const configured = configuredDbPath(root, env);
	const appFile = fs.existsSync(configured) ? fs.realpathSync(configured) : path.resolve(configured);
	if (!db || real(db) === appFile) {
		if (replica) throw new DatabaseRefusal(replicaRefusal);
		if (!fs.existsSync(appFile)) throw new DatabaseRefusal(`the app's database ${appFile} does not exist`);
		return { scope: "app", file: appFile };
	}
	const file = real(db);
	if (insideRoot(file, root)) throw new DatabaseRefusal(`refusing ${db}: a copy inside the repository; put the copy outside it`);
	const dir = path.dirname(file);
	if (fs.existsSync(path.join(dir, "server.js")) || fs.existsSync(path.join(dir, ".env"))) {
		throw new DatabaseRefusal(`refusing ${db}: it sits in another app directory; open this app's own database or a copy outside any app directory`);
	}
	return { scope: "copy", file };
}

module.exports = { configuredDbPath, resolveDatabase, replicaFlagSet, insideRoot, DatabaseRefusal };
