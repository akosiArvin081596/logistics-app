// LOCAL REPLICA MODE (LOCAL_REPLICA=1): run the app on a local copy of
// production (its database, Google Sheets, uploaded files and non-secret
// settings, pulled by `npm run replica:pull`) to reproduce an issue first-hand,
// with nothing able to reach a real person or a real service.
//
// server.js calls boot() first thing after its umask, before dotenv and before
// any module that could open a connection. Outside replica mode boot() returns
// null and touches nothing, so every other run behaves exactly as before.
//
// In replica mode boot():
//   1. refuses to start (exit 1, naming each reason) on a server (pm2 in the
//      environment, running as root, the app or the working directory under a
//      server path such as /var/www, a hosting host name), with
//      NODE_ENV=production, with any outbound credential set
//      (lib/replica-rules.js), with BIND_HOST other than loopback, or when the
//      database, the data folder, the Sheets working copy, the settings file or
//      the guard log is not under ~/LogisX-replica/;
//   2. installs a process-wide network guard: every socket connect, DNS query
//      and fetch() to anything but this machine's loopback is refused before a
//      packet leaves, and each refusal is appended to the guard log, so an empty
//      log is the proof that nothing was attempted;
//   3. installs a file guard that refuses to read a .env file or a Google
//      service-account key (service-account-key.json, or whatever
//      GOOGLE_APPLICATION_CREDENTIALS names), and records any attempt in the
//      same log;
//   4. makes dotenv a no-op, so the repo's .env (a worktree carries a local-dev
//      one) is never loaded, and loads ~/LogisX-replica/settings.env instead
//      (production's non-secret settings), filling only names not already set.
//
// The returned object is what server.js consults: the paths of the working
// copy, the fake Google Sheets (lib/replica-sheets.js), the fetch() that
// refuses every outbound call, the scheduled-job switch, and the banner every
// page carries.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const rules = require("./replica-rules");

const BANNER_TEXT = "LOCAL COPY OF PRODUCTION";
const BANNER_ID = "logisx-replica-banner";

// Where a server keeps an app; a replica never runs from, or writes to, any of
// them. (A developer Mac has none of these.)
const SERVER_PATH_PREFIXES = Object.freeze(["/var/www", "/srv", "/opt", "/root", "/etc", "/usr", "/home/deploy", "/home/nodeapp"]);
// Host names hosting providers give their machines.
const SERVER_HOSTNAME_RE = /^srv\d+(\.|$)|\.cloud$|(^|[.-])vps([.-]|$)/i;
// pm2 puts these in every process it starts.
const PM2_ENV_MARKERS = Object.freeze(["pm_id", "PM2_HOME", "PM2_USAGE", "PM2_JSON_PROCESSING", "PM2_INTERACTOR_PROCESSING"]);

function replicaRoot(home) {
	return path.join(home, "LogisX-replica");
}

function realpathOrNull(p) {
	try { return fs.realpathSync(p); } catch { return null; }
}

// The real path of `p`, or of its nearest existing ancestor joined with the
// rest: a file the app is about to create still resolves symlinks above it.
function resolveReal(p) {
	const abs = path.resolve(p);
	const real = realpathOrNull(abs);
	if (real) return real;
	const parent = path.dirname(abs);
	if (parent === abs) return abs;
	return path.join(resolveReal(parent), path.basename(abs));
}

function isInside(child, parent) {
	const rel = path.relative(parent, child);
	return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

// Judged on the path as given and as resolved, with macOS's /private prefix
// (where /var and /etc really live) taken off, so no spelling slips past.
function underServerPath(p) {
	const forms = [path.resolve(p), resolveReal(p)].flatMap((f) => [f, f.replace(/^\/private(?=\/)/, "")]);
	return forms.some((f) => SERVER_PATH_PREFIXES.some((prefix) => f === prefix || f.startsWith(prefix + "/")));
}

// The replica's paths, from its environment. Pure apart from reading `home`.
function replicaPaths(env, home) {
	const root = replicaRoot(home);
	const task = env.LOGISX_REPLICA_TASK || "default";
	return {
		root,
		task,
		db: env.DATABASE_PATH || "",
		dataDir: env.LOGISX_REPLICA_DATA_DIR || "",
		sheets: env.LOGISX_REPLICA_DATA_DIR ? path.join(env.LOGISX_REPLICA_DATA_DIR, "sheets.json") : "",
		settings: env.LOGISX_REPLICA_SETTINGS || path.join(root, "settings.env"),
		guardLog: env.LOGISX_REPLICA_GUARD_LOG || path.join(root, "logs", `outbound-${task}.log`),
	};
}

// Everything that makes this run unsafe as a replica, as plain sentences that
// name no value. Empty when it may start. `ctx` is injectable for the runner:
// { env, appDir, cwd, uid, hostname, home }.
function refusals(ctx) {
	const env = ctx.env || {};
	const out = [];
	const paths = replicaPaths(env, ctx.home);

	if (String(env.NODE_ENV || "").trim().toLowerCase() === "production") out.push("NODE_ENV is production");
	const pm2 = PM2_ENV_MARKERS.filter((k) => env[k] !== undefined);
	if (pm2.length) out.push(`it is running under pm2 (${pm2.join(", ")} set): a replica never runs on a server`);
	if (ctx.uid === 0) out.push("it is running as root: a replica never runs on a server");
	for (const [what, p] of [["the app directory", ctx.appDir], ["the working directory", ctx.cwd]]) {
		if (p && underServerPath(p)) out.push(`${what} (${path.resolve(p)}) is under a server path`);
	}
	if (ctx.hostname && SERVER_HOSTNAME_RE.test(ctx.hostname)) out.push(`the host name (${ctx.hostname}) looks like a server's`);

	if (!env.LOGISX_REPLICA_TASK || !rules.isValidTask(env.LOGISX_REPLICA_TASK)) {
		out.push("LOGISX_REPLICA_TASK must name the working copy (lower-case letters, digits and dashes)");
	}
	const rootReal = realpathOrNull(paths.root);
	if (!rootReal) {
		out.push(`the replica folder ${paths.root} does not exist (run npm run replica:pull)`);
	} else {
		const appReal = ctx.appDir ? resolveReal(ctx.appDir) : "";
		if (appReal && (rootReal === appReal || isInside(rootReal, appReal))) out.push(`the replica folder ${rootReal} is inside the app directory`);
		const need = [
			["DATABASE_PATH (the database)", paths.db],
			["LOGISX_REPLICA_DATA_DIR (uploads and the other data folders)", paths.dataDir],
			["the Google Sheets working copy", paths.sheets],
			["the settings file", paths.settings],
			["the outbound guard log", paths.guardLog],
		];
		for (const [what, p] of need) {
			if (!p) { out.push(`${what} is not set`); continue; }
			const real = resolveReal(p);
			if (!isInside(real, rootReal)) out.push(`${what} (${real}) is not under ${rootReal}`);
			else if (appReal && isInside(real, appReal)) out.push(`${what} (${real}) is inside the app directory`);
		}
		if (paths.settings && !fs.existsSync(paths.settings)) out.push(`the settings file ${paths.settings} does not exist (run npm run replica:pull)`);
		if (paths.db && !fs.existsSync(paths.db)) out.push(`the database ${paths.db} does not exist (start the replica with npm run replica:start)`);
		if (paths.sheets && !fs.existsSync(paths.sheets)) out.push(`the Google Sheets working copy ${paths.sheets} does not exist (start the replica with npm run replica:start)`);
	}

	const creds = rules.outboundCredentialsSet(env);
	if (creds.length) out.push(`outbound credentials are set: ${creds.join(", ")} (a replica runs with none; start it with npm run replica:start)`);
	const bind = String(env.BIND_HOST || "").trim();
	if (bind && !isLoopbackHost(bind)) out.push(`BIND_HOST is ${bind}: a replica listens on loopback only`);
	return out;
}

// --- Loopback -------------------------------------------------------------

function isLoopbackHost(host) {
	let h = String(host == null ? "" : host).trim().toLowerCase();
	if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
	if (h === "" || h === "localhost" || h.endsWith(".localhost")) return true;
	if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
	if (h === "::1" || h === "0:0:0:0:0:0:0:1") return true;
	return /^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

// --- The record of refused attempts ----------------------------------------

// The first stack frame outside this file and Node's internals: who asked.
function callerOf(stack) {
	const lines = String(stack || "").split("\n").slice(1);
	for (const l of lines) {
		if (l.includes(__filename) || l.includes("node:") || l.includes("(internal/")) continue;
		const m = l.match(/\(?([^()\s]+:\d+:\d+)\)?\s*$/);
		if (m) return m[1];
	}
	return "unknown";
}

// The log exists from the start (empty, 0600), so an empty file is the record
// that nothing was attempted rather than a sign that nothing was logged.
function makeRecorder(logPath) {
	fs.closeSync(fs.openSync(logPath, "a", 0o600));
	const recorder = {
		count: 0,
		record(entry) {
			recorder.count += 1;
			const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
			try { fs.appendFileSync(logPath, line + "\n", { mode: 0o600 }); } catch (err) {
				console.error(`[replica-guard] could not write ${logPath}: ${err.message}`);
			}
			console.error(`[replica-guard] REFUSED ${entry.via} ${entry.target} (from ${entry.caller})`);
		},
	};
	return recorder;
}

function refusalError(via, target) {
	const err = new Error(`local replica: ${via} to ${target} refused (no outbound connections from a replica)`);
	err.code = "REPLICA_OUTBOUND_REFUSED";
	return err;
}

// --- The network guard ------------------------------------------------------

const GUARDED = Symbol.for("logisx.replica.guarded");

// Where a Socket#connect call is headed: { path } for a pipe or Unix socket,
// else { host, port }. net.connect() hands connect() one normalized array.
function socketTarget(args) {
	let a = args;
	if (Array.isArray(a[0])) a = a[0];
	const first = a[0];
	if (first && typeof first === "object") {
		if (first.path) return { path: String(first.path) };
		return { host: first.host || first.hostname || "localhost", port: first.port };
	}
	if (typeof first === "string" && !/^\d+$/.test(first)) return { path: first };
	return { host: typeof a[1] === "string" ? a[1] : "localhost", port: first };
}

function installNetworkGuard(recorder) {
	const net = require("net");
	const dns = require("dns");
	const refuse = (via, target) => {
		const err = refusalError(via, target);
		recorder.record({ via, target, caller: callerOf(new Error().stack) });
		return err;
	};

	if (!net.Socket.prototype.connect[GUARDED]) {
		const connect = net.Socket.prototype.connect;
		const guardedConnect = function (...args) {
			const t = socketTarget(args);
			if (t.path !== undefined || isLoopbackHost(t.host)) return connect.apply(this, args);
			const err = refuse("socket connect", `${t.host}:${t.port}`);
			process.nextTick(() => this.destroy(err));
			return this;
		};
		guardedConnect[GUARDED] = true;
		net.Socket.prototype.connect = guardedConnect;
	}

	if (!dns.lookup[GUARDED]) {
		const lookup = dns.lookup;
		const guardedLookup = function (hostname, options, callback) {
			const cb = typeof options === "function" ? options : callback;
			if (isLoopbackHost(hostname)) return lookup.apply(dns, arguments);
			const err = refuse("dns lookup", String(hostname));
			if (typeof cb === "function") process.nextTick(() => cb(err));
			return {};
		};
		guardedLookup[GUARDED] = true;
		dns.lookup = guardedLookup;
		const pLookup = dns.promises.lookup;
		dns.promises.lookup = function (hostname, ...rest) {
			if (isLoopbackHost(hostname)) return pLookup.call(dns.promises, hostname, ...rest);
			return Promise.reject(refuse("dns lookup", String(hostname)));
		};
		const lookupService = dns.lookupService;
		dns.lookupService = function (address, port, callback) {
			if (isLoopbackHost(address)) return lookupService.apply(dns, arguments);
			const err = refuse("dns lookupService", String(address));
			if (typeof callback === "function") process.nextTick(() => callback(err));
			return {};
		};
		// Every resolve*() and reverse() asks a DNS server, so none is allowed.
		const isQuery = (name) => /^resolve/.test(name) || name === "reverse";
		const wrapCallback = (holder, name) => {
			const fn = holder[name];
			if (typeof fn !== "function") return;
			holder[name] = function (...args) {
				const cb = args[args.length - 1];
				const err = refuse(`dns ${name}`, String(args[0]));
				if (typeof cb === "function") process.nextTick(() => cb(err));
				return {};
			};
		};
		const wrapPromise = (holder, name) => {
			const fn = holder[name];
			if (typeof fn !== "function") return;
			holder[name] = function (...args) { return Promise.reject(refuse(`dns ${name}`, String(args[0]))); };
		};
		for (const name of Object.keys(dns)) if (isQuery(name)) wrapCallback(dns, name);
		for (const name of Object.getOwnPropertyNames(dns.Resolver.prototype)) if (isQuery(name)) wrapCallback(dns.Resolver.prototype, name);
		for (const name of Object.keys(dns.promises)) if (isQuery(name)) wrapPromise(dns.promises, name);
		for (const name of Object.getOwnPropertyNames(dns.promises.Resolver.prototype)) if (isQuery(name)) wrapPromise(dns.promises.Resolver.prototype, name);
	}

	if (typeof globalThis.fetch === "function" && !globalThis.fetch[GUARDED]) {
		const realFetch = globalThis.fetch;
		const guardedFetch = function (input, init) {
			const u = urlOf(input);
			if (u && (u.protocol === "data:" || u.protocol === "blob:" || isLoopbackHost(u.hostname))) return realFetch.call(this, input, init);
			const err = refuse("fetch", u ? `${u.protocol}//${u.host}` : "an unreadable URL");
			return Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: err }));
		};
		guardedFetch[GUARDED] = true;
		globalThis.fetch = guardedFetch;
	}
}

function urlOf(input) {
	try {
		if (typeof input === "string") return new URL(input);
		if (input && typeof input.href === "string") return new URL(input.href);
		if (input && typeof input.url === "string") return new URL(input.url);
	} catch { /* an unparseable URL is refused below */ }
	return null;
}

// --- The file guard ---------------------------------------------------------

function isGuardedFile(p, env) {
	if (p == null || typeof p === "number") return false;
	let s;
	try { s = p instanceof URL ? p.pathname : Buffer.isBuffer(p) ? p.toString() : String(p); } catch { return false; }
	const base = path.basename(s);
	if (base === "service-account-key.json") return true;
	if (base === ".env" || (/^\.env\./.test(base) && base !== ".env.example")) return true;
	const gac = env.GOOGLE_APPLICATION_CREDENTIALS;
	return !!gac && path.resolve(s) === path.resolve(gac);
}

function installFileGuard(recorder, env) {
	if (fs.readFileSync[GUARDED]) return;
	const refuse = (via, p) => {
		const err = new Error(`local replica: ${via} of ${path.basename(String(p))} refused (a replica never reads .env files or Google keys)`);
		err.code = "EACCES";
		recorder.record({ via, target: String(p), caller: callerOf(new Error().stack) });
		return err;
	};
	const sync = (holder, name) => {
		const fn = holder[name];
		holder[name] = function (p, ...rest) {
			if (isGuardedFile(p, env)) throw refuse(`file ${name}`, p);
			return fn.call(this, p, ...rest);
		};
		holder[name][GUARDED] = true;
	};
	const callback = (holder, name) => {
		const fn = holder[name];
		holder[name] = function (p, ...rest) {
			if (isGuardedFile(p, env)) {
				const err = refuse(`file ${name}`, p);
				const cb = rest[rest.length - 1];
				if (typeof cb === "function") { process.nextTick(() => cb(err)); return undefined; }
				throw err;
			}
			return fn.call(this, p, ...rest);
		};
	};
	const promise = (holder, name) => {
		const fn = holder[name];
		holder[name] = function (p, ...rest) {
			if (isGuardedFile(p, env)) return Promise.reject(refuse(`file ${name}`, p));
			return fn.call(this, p, ...rest);
		};
	};
	sync(fs, "readFileSync");
	sync(fs, "openSync");
	sync(fs, "createReadStream");
	callback(fs, "readFile");
	callback(fs, "open");
	promise(fs.promises, "readFile");
	promise(fs.promises, "open");
}

// --- dotenv and the settings file --------------------------------------------

function neutralizeDotenv(appDir) {
	let dotenv;
	try { dotenv = require(require.resolve("dotenv", { paths: [appDir] })); } catch { return; }
	const skipped = () => ({ parsed: {} });
	dotenv.config = skipped;
	dotenv.configDotenv = skipped;
}

// Production's non-secret settings, written by replica:pull. Only names not
// already in the environment are filled, so what replica:start sets wins.
// Returns the NAMES loaded.
function loadSettings(settingsPath, env, appDir) {
	const dotenv = require(require.resolve("dotenv", { paths: [appDir] }));
	const parsed = dotenv.parse(fs.readFileSync(settingsPath));
	const loaded = [];
	for (const [name, value] of Object.entries(parsed)) {
		if (env[name] !== undefined) continue;
		env[name] = value;
		loaded.push(name);
	}
	return loaded.sort();
}

// --- The banner ----------------------------------------------------------------

const BANNER_HTML =
	`<div id="${BANNER_ID}" role="status" aria-live="polite" style="position:fixed;top:0;left:0;right:0;z-index:2147483647;` +
	"background:#b91c1c;color:#fff;font:700 12px/20px system-ui,-apple-system,sans-serif;letter-spacing:.06em;text-align:center;" +
	`pointer-events:none;box-shadow:0 1px 4px rgba(0,0,0,.35)">${BANNER_TEXT} — changes stay on this computer</div>`;

function withBanner(html) {
	const s = String(html);
	if (s.includes(`id="${BANNER_ID}"`)) return s;
	const m = s.match(/<body[^>]*>/i);
	if (!m) return BANNER_HTML + s;
	const at = m.index + m[0].length;
	return s.slice(0, at) + BANNER_HTML + s.slice(at);
}

// Answers every page request (the SPA's routes, "/" and any *.html) with the
// page and the banner in it, so the banner is on every page, the login page
// included. API, upload, socket and asset requests pass through untouched.
function bannerMiddleware(staticRoot) {
	return (req, res, next) => {
		if (req.method !== "GET" && req.method !== "HEAD") return next();
		const p = req.path;
		if (/^\/(api|uploads|socket\.io)(\/|$)/i.test(p)) return next();
		const ext = path.extname(p).toLowerCase();
		let file;
		if (ext === ".html") {
			const candidate = path.join(staticRoot, path.posix.normalize(p).replace(/^(\.\.(\/|$))+/, ""));
			if (!isInside(candidate, staticRoot) || !fs.existsSync(candidate)) return next();
			file = candidate;
		} else if (ext === "") {
			file = path.join(staticRoot, "index.html");
		} else {
			return next();
		}
		fs.readFile(file, "utf8", (err, html) => {
			if (err) return next();
			res.setHeader("Cache-Control", "no-store");
			res.type("html").send(withBanner(html));
		});
	};
}

// --- Boot -----------------------------------------------------------------------

function fail(reasons) {
	console.error("[replica] REFUSING TO START the local replica:");
	for (const r of reasons) console.error(`[replica]   - ${r}`);
	process.exit(1);
}

function boot({ appDir, env = process.env } = {}) {
	const flag = env.LOCAL_REPLICA;
	if (flag === undefined || flag === "" || flag === "0") return null;
	if (flag !== "1") fail([`LOCAL_REPLICA must be 1 to run a replica (or unset/0 for a normal run); it is "${String(flag).slice(0, 20)}"`]);

	const home = os.homedir();
	const ctx = { env, appDir, cwd: process.cwd(), uid: typeof process.getuid === "function" ? process.getuid() : null, hostname: os.hostname(), home };
	// Everything that can be judged before the settings file is read.
	const early = refusals(ctx);
	if (early.length) fail(early);

	const paths = replicaPaths(env, home);
	fs.mkdirSync(path.dirname(paths.guardLog), { recursive: true, mode: 0o700 });
	const recorder = makeRecorder(paths.guardLog);
	installNetworkGuard(recorder);
	installFileGuard(recorder, env);
	neutralizeDotenv(appDir);
	const loaded = loadSettings(paths.settings, env, appDir);
	// Again with the settings in: a hand-edited settings file is held to the
	// same rules (NODE_ENV, credentials, BIND_HOST).
	const late = refusals(ctx);
	if (late.length) fail(late);

	const notStarted = [];
	const offCounts = new Map();
	let fakeSheets = null;
	const replica = {
		root: paths.root,
		task: paths.task,
		dbPath: paths.db,
		dataDir: paths.dataDir,
		sheetsPath: paths.sheets,
		settingsPath: paths.settings,
		guardLog: paths.guardLog,
		settingsLoaded: loaded,
		guard: recorder,
		// A scheduled job server.js would start: in a replica none starts.
		jobNotStarted(name) {
			notStarted.push(name);
			console.log(`[replica] scheduled job not started: ${name}`);
			return false;
		},
		jobsNotStarted() { return notStarted.slice(); },
		// An outbound path the app reached and turned away before any
		// connection. Logged on its first use, then counted.
		off(what) {
			const n = (offCounts.get(what) || 0) + 1;
			offCounts.set(what, n);
			if (n === 1) console.log(`[replica] outbound off: ${what}`);
		},
		offCounts() { return Object.fromEntries(offCounts); },
		// server.js's fetch() in replica mode: nothing leaves, and the caller
		// sees what an unreachable service looks like.
		fetch(input, init) {
			const u = urlOf(input);
			if (u && isLoopbackHost(u.hostname)) return globalThis.fetch(input, init);
			replica.off(`HTTP ${u ? u.host : "request"}`);
			const cause = Object.assign(new Error("local replica: outbound HTTP is off"), { code: "REPLICA_OUTBOUND_OFF" });
			return Promise.reject(Object.assign(new TypeError("fetch failed"), { cause }));
		},
		sheets() {
			if (!fakeSheets) fakeSheets = require("./replica-sheets").createFakeSheets({ file: paths.sheets });
			return fakeSheets;
		},
		bannerMiddleware,
		listening(address) {
			const port = address && typeof address === "object" ? address.port : address;
			console.log(`[replica] ${BANNER_TEXT} listening on http://127.0.0.1:${port} — task ${paths.task}`);
		},
	};
	console.log(`[replica] ${BANNER_TEXT} — task ${paths.task}`);
	console.log(`[replica] database ${paths.db}; files ${paths.dataDir}; Google Sheets: local working copy`);
	console.log(`[replica] settings: ${loaded.length} from ${paths.settings}; the repo .env is not loaded`);
	console.log(`[replica] outbound guard on; refused attempts are logged to ${paths.guardLog}`);
	return replica;
}

module.exports = {
	BANNER_TEXT,
	BANNER_ID,
	boot,
	refusals,
	replicaPaths,
	replicaRoot,
	isLoopbackHost,
	socketTarget,
	isGuardedFile,
	withBanner,
	bannerMiddleware,
	installNetworkGuard,
	installFileGuard,
	makeRecorder,
	SERVER_PATH_PREFIXES,
	SERVER_HOSTNAME_RE,
	PM2_ENV_MARKERS,
};
