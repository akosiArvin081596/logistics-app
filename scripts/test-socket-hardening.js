#!/usr/bin/env node
/**
 * Live-update (Socket.IO) connections: who may open one, how large a client
 * message may be, and which rooms an identity joins.
 *
 * WHAT IS ASSERTED, each a way this can silently stop being true:
 *   §1 ORIGIN, on real handshakes over loopback, long-polling AND WebSocket,
 *      through the SHIPPED `new Server()` statement and
 *      liveUpdateHandshakeAllowed(), with the session cookie Secure (as in
 *      production) and not (as in dev). Refused: a foreign Origin, the bare
 *      logisx.com host and a sibling logisx.com host, another environment's
 *      host, `Origin: null`, the app's own Origin behind a proxy that does not
 *      forward Host, the app's host on another port (directly or through
 *      X-Forwarded-Host), plain HTTP while the cookie is Secure, no Origin with
 *      a Sec-Fetch-Site other than same-origin, a dev proxy that rewrites the
 *      port, and JSONP long-polling with or without an Origin. Allowed: the
 *      app's own origin, no Origin at all (and with Sec-Fetch-Site:
 *      same-origin), a DRIVER_MOBILE_ORIGINS entry, the Vite dev proxy (which
 *      keeps the browser's Host), plain HTTP in dev, an nginx hop naming the
 *      public host in X-Forwarded-Host, a proxy that writes the default port
 *      out (in Host or X-Forwarded-Host), staging, and the old hostname. A
 *      refused handshake never opens a connection; a real client from
 *      elsewhere never connects; refusals are logged once a minute with a
 *      running total and the header values clipped; the public tracker
 *      connects and receives from the app's own origin, and not from elsewhere
 *   §2 SIZE: the cap is 16 KB and is what `new Server()` is given; every
 *      legitimate client message, measured with the client's own encoder, is
 *      far below it, and the numbers in the comment beside the cap are the
 *      measured ones; a message exactly at the cap is accepted and one byte
 *      more disconnects that client, over WebSocket and over long-polling;
 *      other connections carry on
 *   §3 ROOMS, on the SHIPPED connection handler with real sockets: every
 *      identity, whatever its driver name or username and whatever names it
 *      registers, joins only its role's room and its own identity rooms, and
 *      receives only their events; chat through the SHIPPED POST /api/messages
 *      reaches the dispatch room and each party's rooms exactly once per
 *      socket, and a role room never by name, whatever the recipient is
 *      called or spelled like; a driver target spelled like another kind's
 *      room reaches no one; a register payload that is not a string is read
 *      as no name
 *   §4 SOURCE pins (comment-stripped): every room argument in server.js is a
 *      role-room literal or a room helper (the public tracker's `load:` rooms
 *      live in their own namespace); every driver-addressed event goes through
 *      driverRoom() and chat through chatRooms(); every emit target taken from
 *      a request (POST /api/dispatch, …/reassign, /api/messages) is exactly its
 *      helper call; `register` joins exactly the expected rooms; lib/ names no
 *      room; the only emit to every socket is the dev reload; the helpers'
 *      spelling, and what they make of any value a request can carry; the
 *      handshake rule and the cap are what `new Server()` is given; every
 *      socket.on() in either connection handler is wrapped in socketHandler()
 *      and the tracker reads a string load id only
 *   §5 RESILIENCE: a fault in one socket event handler is caught, leaving the
 *      process up and the socket usable (both namespaces); a non-string
 *      tracker load id is ignored and a valid subscribe still works
 *   §6 DISCRIMINATION: a mutant per protective clause, each must be caught,
 *      and each mutated run must still reach the end of its scenario
 *
 * Runs the SHIPPED code: the `new Server()` statement and the cap, the
 * handshake rule with originIsSelf() and the Express request view over a real
 * Express app carrying server.js's own `trust proxy` line, the room helpers,
 * the "connection" handlers of both namespaces, requireAuth and
 * POST /api/messages, all lifted out of server.js and run on a real Socket.IO
 * server with real socket.io-client connections (client/node_modules, which
 * `npm ci` at the repo root installs through the postinstall). The session is
 * a request header the harness reads, standing in for express-session, whose
 * part in this is scripts/test-session-sockets.js's subject. Loopback on
 * 127.0.0.1:0: no fixed port, no app.db, no network.
 *
 * Run: node scripts/test-socket-hardening.js    # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { once } = require("events");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");

let pass = 0;
const failures = [];
const ok = (cond, msg) => { if (cond) pass++; else failures.push(msg); };

// The shipped code logs on purpose (the refusal line is asserted in §1). Keep
// it out of the run's output; replay the tail only on failure.
const logs = [];
const realConsole = { log: console.log, warn: console.warn, error: console.error };
console.log = (...a) => logs.push(a.join(" "));
console.warn = (...a) => logs.push(a.join(" "));
console.error = (...a) => logs.push(a.join(" "));
function restoreConsole() {
	console.log = realConsole.log;
	console.warn = realConsole.warn;
	console.error = realConsole.error;
}
function die(msg) {
	restoreConsole();
	console.error(`FAILED: ${msg}`);
	process.exit(1);
}

// Anything thrown outside a scenario's own try/finally is recorded, so it
// fails the run with a message rather than a stack trace.
let phase = "shipped";
const uncaught = [];
process.on("uncaughtException", (err) => uncaught.push(`${phase}: ${err && err.message}`));

let express, SocketServer, ioClient, clientParser;
try {
	express = require("express");
	SocketServer = require("socket.io").Server;
} catch (e) {
	die(`a server dependency did not load (${e.message}); run npm ci under the .nvmrc Node`);
}
try {
	const fromClient = (name) => require(require.resolve(name, { paths: [path.join(ROOT, "client")] }));
	ioClient = fromClient("socket.io-client");
	clientParser = fromClient("socket.io-parser");
} catch (e) {
	die(`socket.io-client did not load from client/node_modules (${e.message}); npm ci at the repo root installs it through the postinstall`);
}

// ── lift the shipped code ───────────────────────────────────────────────────
const occurrences = (hay, needle) => hay.split(needle).length - 1;
// A statement from its exact head to the `});` that closes it in column 0.
function liftStatement(head, src = SRC) {
	const hits = occurrences(src, head);
	if (hits !== 1) die(`expected exactly 1 statement starting ${JSON.stringify(head)}, found ${hits} (a server.js without this change is the pre-fix source)`);
	const a = src.indexOf(head);
	const end = src.indexOf("\n});", a);
	if (end < 0) die(`no column-0 "});" after ${head}`);
	return src.slice(a, end + "\n});".length);
}
// A top-level function declaration, to the `}` that closes it in column 0.
function liftFunction(head) {
	const needle = `\n${head}`;
	const hits = occurrences(SRC, needle);
	if (hits !== 1) die(`expected exactly 1 definition starting ${JSON.stringify(head)}, found ${hits} (a server.js without this change is the pre-fix source)`);
	const a = SRC.indexOf(needle) + 1;
	const end = SRC.indexOf("\n}\n", a);
	if (end < 0) die(`no column-0 "}" after ${head}`);
	return SRC.slice(a, end + 2);
}
// The arrow function handed to `X.on("connection", …)`.
function liftHandler(head, prefix) {
	const stmt = liftStatement(head);
	if (!stmt.startsWith(prefix) || !stmt.endsWith(");")) die(`unexpected shape for ${head}`);
	return stmt.slice(prefix.length, -2);
}
function liftLine(re, label) {
	const m = SRC.match(re);
	if (!m) die(`could not locate ${label}`);
	return m[0];
}

// Everything a mutant may target, by name.
const SRCS = {
	cap: liftLine(/\nconst SOCKET_MAX_MESSAGE_BYTES = [^\n]+;/, "SOCKET_MAX_MESSAGE_BYTES"),
	serverOpts: liftStatement("const io = new Server(server, {"),
	origin: [
		"function originIsSelf(req, origin) {",
		"function auditHeaderValue(raw, max) {",
		"function liveUpdateHandshakeAllowed(req, callback) {",
		"function originHostIsExact(req, origin) {",
		"function expressRequestView(req) {",
	].map(liftFunction).join("\n"),
	rooms: [
		"function identityRoomKey(name) {",
		"function driverRoom(name) {",
		"function userRoom(username) {",
		"function chatRooms(from, to) {",
	].map(liftFunction).join("\n"),
	ioHandler: liftHandler('io.on("connection", (socket) => {', 'io.on("connection", '),
	tracker: liftHandler('publicTrack.on("connection", (socket) => {', 'publicTrack.on("connection", '),
	messages: liftStatement('app.post("/api/messages", requireAuth, driverWriteLimiter, (req, res) => {'),
	guard: ["function socketHandler(event, fn) {", "function logSocketHandlerFault(event, err) {"].map(liftFunction).join("\n"),
};
const TRUST_PROXY_SRC = liftLine(/\napp\.set\("trust proxy", 1\);/, 'app.set("trust proxy", 1)');
const LOAD_ID_RE_SRC = liftLine(/\nconst LOAD_ID_RE = [^\n]+;/, "LOAD_ID_RE");
const REQUIRE_AUTH_SRC = liftFunction("function requireAuth(req, res, next) {");

const buildRooms = (sources) =>
	new Function(`${sources.rooms}\nreturn { identityRoomKey, driverRoom, userRoom, chatRooms };`)();
// The SHIPPED handler guard, so it wraps the real listeners here rather than a
// stand-in. logSocketHandlerFault is lifted with it and logs through the
// console this runner already captures.
const buildGuard = (sources) =>
	new Function(`${sources.guard}\nreturn socketHandler;`)();
// The shipped connection handler. The two session helpers it calls are
// scripts/test-session-sockets.js's subject: here every session is live and
// none must change its password unless a scenario injects one that does.
const buildIoHandler = (sources, rooms, { mustChange = () => false } = {}) =>
	new Function("currentMustChangePassword", "liveSessionIds", "identityRoomKey", "driverRoom", "userRoom", "socketHandler", `return (${sources.ioHandler});`)(
		mustChange, (sids) => new Set(sids), rooms.identityRoomKey, rooms.driverRoom, rooms.userRoom, buildGuard(sources));

// ── frames, measured with the CLIENT's own encoder ──────────────────────────
// Bytes on the wire for one packet: Engine.IO's one-byte "message" type, then
// the Socket.IO packet as the client encodes it. That is a WebSocket message,
// and a long-polling request body carrying just that packet.
const encoder = new clientParser.Encoder();
const { PacketType } = clientParser;
const frameBytes = (packet) => 1 + Buffer.byteLength(encoder.encode(packet)[0]);
const eventFrame = (nsp, data) => frameBytes({ type: PacketType.EVENT, nsp, data });
// A `register` name whose frame is exactly `bytes` long (ASCII, which JSON
// does not escape, so every character is one byte).
function registerNameOfFrame(bytes) {
	const base = eventFrame("/", ["register", ""]);
	return "x".repeat(bytes - base);
}
function measuredFrames() {
	const f = {
		connect: frameBytes({ type: PacketType.CONNECT, nsp: "/" }),
		connectTracker: frameBytes({ type: PacketType.CONNECT, nsp: "/public-track" }),
		register200: eventFrame("/", ["register", "N".repeat(200)]),
		register200Wide: eventFrame("/", ["register", "é".repeat(200)]),
		subscribe: eventFrame("/public-track", ["subscribe", { loadId: "L".repeat(40) }]),
		unsubscribe: eventFrame("/public-track", ["unsubscribe", { loadId: "L".repeat(40) }]),
	};
	// One long-polling request carrying all of them: the packets joined by
	// Engine.IO's one-byte record separator.
	const batch = [f.connect, f.register200, f.connectTracker, f.subscribe, f.unsubscribe];
	f.batch = batch.reduce((a, b) => a + b, 0) + (batch.length - 1);
	return f;
}

// ── the world: one loopback server built from `sources` ────────────────────
// Sessions, keyed by the x-test-user header. Usernames are unique, so
// `unlinked`, which shares one with `desk`, gets a world of its own.
const USERS = {
	root: { id: 1, username: "root", role: "Super Admin", driverName: "" },
	ops: { id: 2, username: "investor", role: "Dispatcher", driverName: "" },
	mike: { id: 3, username: "mike", role: "Investor", driverName: "" },
	desk: { id: 4, username: "dispatch", role: "Investor", driverName: "" },
	dDispatch: { id: 5, username: "d.dispatch", role: "Driver", driverName: "Dispatch" },
	dInvestor: { id: 6, username: "d.investor", role: "Driver", driverName: "Investor" },
	dMike: { id: 7, username: "d.mike", role: "Driver", driverName: "Mike" },
	bob: { id: 8, username: "bob", role: "Driver", driverName: "Bob Driver" },
	lone: { id: 9, username: "lone.driver", role: "Driver", driverName: "" },
	unlinked: { id: 10, username: "dispatch", role: "Driver", driverName: "" },
};
const ALLOWLIST = ["https://driver-mobile.example"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// `secureCookie` is SESSION_COOKIE_SECURE: true as in production (NODE_ENV),
// false as in dev and in the loopback clients here, whose pages are plain HTTP.
// `mustChange` / `loadIdRe` let the resilience scenario feed the real handlers
// a fault (a session flag read that throws, a regex whose test throws).
async function startWorld({ sources = SRCS, secureCookie = false, mustChange = () => false, loadIdRe = null } = {}) {
	const app = express();
	new Function("app", TRUST_PROXY_SRC)(app); // server.js's own `trust proxy` line
	app.use(express.json());
	app.use((req, res, next) => {
		req.session = { user: USERS[req.headers["x-test-user"]] };
		next();
	});
	const server = http.createServer(app);

	const origin = new Function("app", "DRIVER_MOBILE_ORIGINS", "SESSION_COOKIE_SECURE",
		`${sources.origin}\nreturn { liveUpdateHandshakeAllowed };`)(app, ALLOWLIST, secureCookie);
	const { io, cap } = new Function("Server", "server", "liveUpdateHandshakeAllowed",
		`${sources.cap}\n${sources.serverOpts}\nreturn { io, cap: SOCKET_MAX_MESSAGE_BYTES };`)(SocketServer, server, origin.liveUpdateHandshakeAllowed);
	// Stands in for express-session on engine requests (server.js mounts the
	// real one with io.engine.use, which likewise runs before allowRequest).
	io.engine.use((req, res, next) => {
		const key = req.headers["x-test-user"];
		const user = USERS[key];
		req.session = user ? { user: { ...user } } : {};
		req.sessionID = user ? `sid-${key}` : undefined;
		next();
	});
	const w = { app, server, io, cap, port: 0, clients: [], engineConnections: 0, received: [] };
	io.engine.on("connection", () => { w.engineConnections++; });

	const rooms = buildRooms(sources);
	w.rooms = rooms;
	io.on("connection", buildIoHandler(sources, rooms, { mustChange }));
	// What each socket sent, with its size on the wire. onAny runs before the
	// handlers, in the same tick, so once a packet is recorded here the shipped
	// handler has already been handed it.
	io.on("connection", (socket) => {
		socket.onAny((event, ...args) => w.received.push({ id: socket.id, event, args, bytes: eventFrame("/", [event, ...args]) }));
	});
	// LOAD_ID_RE is injectable so the resilience scenario can hand the tracker a
	// regex whose test throws, to prove the guard wraps the tracker handler too.
	const LOAD_ID_RE = loadIdRe || new Function(`${LOAD_ID_RE_SRC}\nreturn LOAD_ID_RE;`)();
	io.of("/public-track").on("connection", new Function("LOAD_ID_RE", "socketHandler", `return (${sources.tracker});`)(LOAD_ID_RE, buildGuard(sources)));

	// POST /api/messages on the real requireAuth. The INSERT and the
	// notification row are stubs: this asks where the message is pushed.
	let seq = 0;
	const db = { prepare: () => ({ run: () => ({ lastInsertRowid: ++seq }) }) };
	const insertNotification = { run: () => ({ lastInsertRowid: ++seq }) };
	const requireAuth = new Function(`${REQUIRE_AUTH_SRC}\nreturn requireAuth;`)();
	new Function("app", "requireAuth", "driverWriteLimiter", "db", "insertNotification", "io", "chatRooms", sources.messages)(
		app, requireAuth, (req, res, next) => next(), db, insertNotification, io, rooms.chatRooms);

	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	w.port = server.address().port;
	w.selfOrigin = `http://127.0.0.1:${w.port}`;
	w.close = async () => {
		for (const c of w.clients) { try { c.disconnect(); } catch { /* already closed */ } }
		const closed = new Promise((resolve) => io.close(() => resolve()));
		if (server.closeAllConnections) server.closeAllConnections();
		// Bounded: a close that never completes must not hold the runner.
		await Promise.race([closed, sleep(1000)]);
	};
	return w;
}

// ── raw handshakes, headers exactly as given ────────────────────────────────
const EIO = "/socket.io/?EIO=4";
function httpRequest(port, method, urlPath, headers, body) {
	return new Promise((resolve) => {
		const r = http.request({ host: "127.0.0.1", port, method, path: urlPath, headers, agent: false }, (res) => {
			let text = "";
			res.setEncoding("utf8");
			res.on("data", (c) => { text += c; });
			res.on("end", () => resolve({ status: res.statusCode, body: text }));
		});
		r.on("error", (e) => resolve({ status: `error:${e.code || e.message}`, body: "" }));
		if (body !== undefined) r.write(body);
		r.end();
	});
}
// A long-polling handshake. 200 with an open packet ("0{…") when admitted.
const pollHandshake = (w, headers, extra = "") => httpRequest(w.port, "GET", `${EIO}&transport=polling${extra}`, headers);
// A long-polling write on an open connection.
const pollWrite = (w, sid, body) => httpRequest(w.port, "POST", `${EIO}&transport=polling&sid=${sid}`,
	{ "content-type": "text/plain;charset=UTF-8", "content-length": Buffer.byteLength(body) }, body);
// A WebSocket handshake as a browser sends one: 101 when the server switched
// protocols, otherwise what it answered.
function wsHandshake(w, headers) {
	return new Promise((resolve) => {
		const r = http.request({
			host: "127.0.0.1", port: w.port, method: "GET", path: `${EIO}&transport=websocket`, agent: false,
			headers: {
				Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13",
				"Sec-WebSocket-Key": crypto.randomBytes(16).toString("base64"), ...headers,
			},
		});
		r.on("upgrade", (res, socket) => { socket.destroy(); resolve(101); });
		r.on("response", (res) => { res.resume(); resolve(res.statusCode); });
		r.on("error", (e) => resolve(`error:${e.code || e.message}`));
		r.end();
	});
}
const admittedPoll = (res) => res.status === 200 && res.body.startsWith("0{");
const refusedPoll = (res) => res.status === 403 && res.body.includes("CROSS_SITE_REFUSED");

// ── real clients ────────────────────────────────────────────────────────────
function waitFor(emitter, event, ms = 2000) {
	return new Promise((resolve) => {
		const on = (...args) => { clearTimeout(t); resolve(args); };
		const t = setTimeout(() => { emitter.off(event, on); resolve(null); }, ms);
		emitter.once(event, on);
	});
}
async function waitUntil(pred, ms = 2000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (pred()) return true;
		await sleep(5);
	}
	return pred();
}
// A browser tab. Resolves once it has connected or been refused.
async function openClient(w, { user = null, origin = w.selfOrigin, transports = ["websocket"], nsp = "" } = {}) {
	const extraHeaders = {};
	if (user) extraHeaders["x-test-user"] = user;
	if (origin) extraHeaders.origin = origin;
	const s = ioClient.io(`http://127.0.0.1:${w.port}${nsp}`, { transports, reconnection: false, forceNew: true, extraHeaders });
	w.clients.push(s);
	const c = { s, user, id: null, got: [], reasons: [], refused: false };
	s.onAny((event, ...args) => c.got.push([event, args]));
	s.on("disconnect", (reason) => c.reasons.push(reason));
	const outcome = await Promise.race([
		waitFor(s, "connect").then((v) => (v ? "connect" : null)),
		waitFor(s, "connect_error").then((v) => (v ? "refused" : null)),
	]);
	if (outcome === "connect") c.id = s.id; // captured now: cleared on disconnect
	c.refused = outcome === "refused";
	return c;
}
const serverSocket = (w, id, nsp = "/") => (id ? w.io.of(nsp).sockets.get(id) || null : null);
const inRoom = (w, room, id, nsp = "/") => { const r = w.io.of(nsp).adapter.rooms.get(room); return !!(r && r.has(id)); };
const roomsOf = (w, c) => { const s = serverSocket(w, c.id); return s ? [...s.rooms].filter((r) => r !== c.id).sort() : null; };
const sameSet = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);
async function receives(socket, event, fire) {
	const p = waitFor(socket, event);
	fire();
	return !!(await p);
}
// Every client has seen marker `n`. Socket.IO keeps one socket's packets in
// order, so anything sent to a socket before the marker has arrived by then.
async function barrier(w, clients, n) {
	w.io.emit("__marker", n);
	return waitUntil(() => clients.every((c) => c.got.some(([e, a]) => e === "__marker" && a[0] === n)));
}
const copies = (c, event, pred = () => true) => c.got.filter(([e, a]) => e === event && pred(a[0])).length;
function chat(w, user, body) {
	const data = JSON.stringify(body);
	return httpRequest(w.port, "POST", "/api/messages", {
		"content-type": "application/json", "content-length": Buffer.byteLength(data),
		"x-test-user": user, "x-requested-with": "XMLHttpRequest",
	}, data);
}

// ── §1 origin cases ─────────────────────────────────────────────────────────
const HOST = "app.logisx.com";
const SELF = `https://${HOST}`;
const ORIGIN_CASES = [
	// [name, request headers, admitted?, session cookie Secure (production)?]
	["foreign", { Host: HOST, Origin: "https://elsewhere.example" }, false, true],
	["bareDomain", { Host: HOST, Origin: "https://logisx.com" }, false, true],
	["siblingHost", { Host: HOST, Origin: "https://investors.logisx.com" }, false, true],
	["otherEnvironment", { Host: "staging-app.logisx.com", Origin: SELF }, false, true],
	["nullOrigin", { Host: HOST, Origin: "null" }, false, true],
	["hostNotForwarded", { Host: "127.0.0.1:3000", Origin: SELF }, false, true],
	["otherPort", { Host: HOST, Origin: `${SELF}:8443` }, false, true],
	["otherPortInHost", { Host: `${HOST}:8443`, Origin: SELF }, false, true],
	["forwardedOtherPort", { Host: "127.0.0.1:3000", "X-Forwarded-Host": HOST, Origin: `${SELF}:8443` }, false, true],
	["plainHttpWhileSecure", { Host: HOST, Origin: `http://${HOST}` }, false, true],
	["noOriginSameSite", { Host: HOST, "Sec-Fetch-Site": "same-site" }, false, true],
	["noOriginCrossSite", { Host: HOST, "Sec-Fetch-Site": "cross-site" }, false, true],
	["noOriginNoInitiator", { Host: HOST, "Sec-Fetch-Site": "none" }, false, true],
	["self", { Host: HOST, Origin: SELF }, true, true],
	["noOrigin", { Host: HOST }, true, true],
	["noOriginSameOrigin", { Host: HOST, "Sec-Fetch-Site": "same-origin" }, true, true],
	["allowlisted", { Host: HOST, Origin: ALLOWLIST[0] }, true, true],
	["nginxForwardedHost", { Host: "127.0.0.1:3000", "X-Forwarded-Host": HOST, Origin: SELF }, true, true],
	// A proxy that writes the default port out (`$host:$server_port`).
	["defaultPortInHost", { Host: `${HOST}:443`, Origin: SELF }, true, true],
	["defaultPortForwarded", { Host: "127.0.0.1:3000", "X-Forwarded-Host": `${HOST}:443`, Origin: SELF }, true, true],
	["staging", { Host: "staging-app.logisx.com", Origin: "https://staging-app.logisx.com" }, true, true],
	["oldHostname", { Host: "logistics-app.abedubas.dev", Origin: "https://logistics-app.abedubas.dev" }, true, true],
	// Dev: the session cookie is not Secure, and pages are plain HTTP. Vite's
	// /socket.io proxy keeps the browser's Host; a proxy that rewrote the port
	// would be refused here, which is why the port is held on this path only.
	["viteKeepsHost", { Host: "localhost:5173", Origin: "http://localhost:5173" }, true, false],
	["plainHttpDev", { Host: "localhost:3000", Origin: "http://localhost:3000" }, true, false],
	["portRewritten", { Host: "localhost:3000", Origin: "http://localhost:5173" }, false, false],
];

// ── the scenarios. Each sets named properties, all true on the shipped code ──
const SCENARIOS = {
	// §1
	async origin(sources, p) {
		const w = await startWorld({ sources });
		const prod = await startWorld({ sources, secureCookie: true });
		try {
			const admitted = new Map([[w, 0], [prod, 0]]);
			for (const [name, headers, allowed, secure] of ORIGIN_CASES) {
				const at = secure ? prod : w;
				const poll = await pollHandshake(at, headers);
				const ws = await wsHandshake(at, headers);
				p[`${name}Poll`] = allowed ? admittedPoll(poll) : refusedPoll(poll);
				p[`${name}Ws`] = allowed ? ws === 101 : ws !== 101;
				if (allowed) admitted.set(at, admitted.get(at) + 2);
			}
			// JSONP long-polling is refused whatever it carries.
			p.jsonpNoOriginRefused = refusedPoll(await pollHandshake(prod, { Host: HOST }, "&j=0"));
			p.jsonpSelfRefused = refusedPoll(await pollHandshake(prod, { Host: HOST, Origin: SELF }, "&j=0"));
			// A refused handshake opens nothing: only the admitted ones did.
			await sleep(20);
			p.refusedOpensNothing = w.engineConnections === admitted.get(w) && prod.engineConnections === admitted.get(prod);

			// Real clients. The default namespace needs a session to stay up.
			const elsewhere = await openClient(w, { user: "root", origin: "https://elsewhere.example" });
			p.clientFromElsewhereRefused = elsewhere.refused && !elsewhere.id && w.io.of("/").sockets.size === 0;
			const self = await openClient(w, { user: "root" });
			self.s.emit("register", "dispatch");
			const joined = await waitUntil(() => inRoom(w, "dispatch", self.id));
			p.clientFromSelfConnects = !!self.id && joined &&
				(await receives(self.s, "dispatch-notification", () => w.io.to("dispatch").emit("dispatch-notification", { n: 1 })));
			p.originRan = true;
		} finally { await w.close(); await prod.close(); }
	},

	// §1, the refusal log
	async logging(sources, p) {
		const w = await startWorld({ sources });
		try {
			delete globalThis.__liveUpdateRefusedCount;
			delete globalThis.__liveUpdateRefusedLoggedAt;
			const from = logs.length;
			const lines = () => logs.slice(from).filter((l) => l.startsWith("LIVE-UPDATE:"));
			// The case the line exists for: this app's own pages behind a proxy that
			// does not forward Host.
			await pollHandshake(w, { Host: "127.0.0.1:3000", Origin: SELF });
			await pollHandshake(w, { Host: HOST, Origin: "https://elsewhere.example" });
			await wsHandshake(w, { Host: HOST, Origin: "https://elsewhere.example" });
			const first = lines();
			p.refusalLoggedOnce = first.length === 1 && first[0].startsWith("LIVE-UPDATE: 1 handshake(s) refused") &&
				first[0].includes(`Origin=${SELF} Host=127.0.0.1:3000 X-Forwarded-Host=(absent)`);
			// A minute on, the next refusal logs again, with the running total.
			globalThis.__liveUpdateRefusedLoggedAt = Date.now() - 61000;
			const longOrigin = `https://elsewhere.example/${"x".repeat(5000)}`;
			await pollHandshake(w, { Host: HOST, Origin: longOrigin });
			const both = lines();
			p.refusalLogKeepsTotal = both.length === 2 && both[1].startsWith("LIVE-UPDATE: 4 handshake(s) refused");
			p.refusalLogClipsHeaders = both.length === 2 && both[1].includes(`Origin=${longOrigin.slice(0, 200)}... `) &&
				!both[1].includes(longOrigin.slice(0, 201));
			p.loggingRan = true;
		} finally { await w.close(); }
	},

	// §1, the public tracker
	async tracker(sources, p) {
		const w = await startWorld({ sources });
		try {
			const t = await openClient(w, { nsp: "/public-track" });
			t.s.emit("subscribe", { loadId: "L-100" });
			const subscribed = await waitUntil(() => inRoom(w, "load:L-100", t.id, "/public-track"));
			p.trackerFromSelfReceives = !!t.id && subscribed &&
				(await receives(t.s, "tracker-update", () => w.io.of("/public-track").to("load:L-100").emit("tracker-update", { lat: 1 })));
			const away = await openClient(w, { nsp: "/public-track", origin: "https://elsewhere.example" });
			p.trackerFromElsewhereRefused = away.refused && !away.id;
			p.trackerRan = true;
		} finally { await w.close(); }
	},

	// §2
	async size(sources, p) {
		const w = await startWorld({ sources });
		try {
			p.capIs16KB = w.cap === 16 * 1024;
			p.serverGivenCap = w.io.engine.opts.maxHttpBufferSize === w.cap;
			const f = measuredFrames();
			const legit = [f.connect, f.connectTracker, f.register200, f.register200Wide, f.subscribe, f.unsubscribe, f.batch];
			p.legitimateFarBelowCap = legit.every((b) => b * 20 <= w.cap);

			const sent = (c, bytes) => w.received.some((r) => r.id === c.id && r.event === "register" && r.bytes === bytes);
			// WebSocket: exactly the cap is one message the server takes; one byte
			// more ends that client's connection, and the message never arrives.
			const ws = await openClient(w, { user: "bob" });
			ws.s.emit("register", registerNameOfFrame(w.cap));
			p.wsAtCapAccepted = (await waitUntil(() => sent(ws, w.cap))) && !!serverSocket(w, ws.id) && ws.s.connected;
			ws.s.emit("register", registerNameOfFrame(w.cap + 1));
			p.wsOverCapDisconnects = (await waitUntil(() => ws.reasons.length > 0)) && !serverSocket(w, ws.id) && !sent(ws, w.cap + 1);

			// Long-polling, through the real client the same way.
			const lp = await openClient(w, { user: "bob", transports: ["polling"] });
			lp.s.emit("register", registerNameOfFrame(w.cap));
			p.pollAtCapAccepted = (await waitUntil(() => sent(lp, w.cap))) && lp.s.connected;
			lp.s.emit("register", registerNameOfFrame(w.cap + 1));
			p.pollOverCapDisconnects = (await waitUntil(() => lp.reasons.length > 0, 4000)) && !sent(lp, w.cap + 1);

			// ...and the request body itself, to the byte: a no-op packet padded to
			// the cap is taken, one byte more is answered 413.
			const hs = await pollHandshake(w, { Host: HOST });
			const sid = admittedPoll(hs) ? JSON.parse(hs.body.slice(1)).sid : "";
			const atCap = await pollWrite(w, sid, "6" + "x".repeat(w.cap - 1));
			const over = await pollWrite(w, sid, "6" + "x".repeat(w.cap));
			p.pollBodyAtCapTaken = atCap.status === 200 && atCap.body === "ok";
			p.pollBodyOverCapRefused = over.status === 413;

			// Everyone else carries on.
			const other = await openClient(w, { user: "root" });
			other.s.emit("register", "dispatch");
			p.othersCarryOn = (await waitUntil(() => inRoom(w, "dispatch", other.id))) &&
				(await receives(other.s, "dispatch-notification", () => w.io.to("dispatch").emit("dispatch-notification", { n: 2 })));
			p.sizeRan = true;
		} finally { await w.close(); }
	},

	// §3
	async rooms(sources, p) {
		const w = await startWorld({ sources });
		try {
			const who = ["root", "ops", "mike", "desk", "dDispatch", "dInvestor", "dMike", "bob", "lone"];
			const c = {};
			for (const k of who) c[k] = await openClient(w, { user: k });
			const all = who.map((k) => c[k]);
			// What each app sends as its pages mount (the driver app sends the
			// driver name, or the username for an account without one), then every
			// name that belongs to someone else or to a role, then a sentinel.
			const own = { root: "dispatch", ops: "dispatch", mike: "investor", desk: "investor", dDispatch: "Dispatch",
				dInvestor: "Investor", dMike: "Mike", bob: "Bob Driver", lone: "lone.driver" };
			const others = ["dispatch", " DISPATCH ", "Dispatch", "investor", "Investor", "mike", "Mike", "root", "Bob Driver", "lone.driver"];
			for (const k of who) {
				c[k].s.emit("register", own[k]);
				for (const name of others) c[k].s.emit("register", name);
				c[k].s.emit("register", "__sentinel__");
			}
			const settled = await waitUntil(() => all.every((x) => w.received.some((r) => r.id === x.id && r.args[0] === "__sentinel__")));
			const expected = {
				root: ["dispatch", "user:root"],
				ops: ["dispatch", "user:investor"],
				mike: ["investor", "user:mike"],
				desk: ["investor", "user:dispatch"],
				dDispatch: ["driver:dispatch"],
				dInvestor: ["driver:investor"],
				dMike: ["driver:mike"],
				bob: ["driver:bob driver"],
				lone: ["user:lone.driver"],
			};
			const actual = Object.fromEntries(who.map((k) => [k, roomsOf(w, c[k])]));
			p.roomsExact = settled && who.every((k) => sameSet(actual[k], expected[k]));
			p.roomsDetail = JSON.stringify(actual);

			// Role events, and driver events sent the way every shipped site sends
			// them (driverRoom(<driver name>); §4 pins that each site does).
			const R = w.rooms;
			w.io.to("dispatch").emit("dispatch-notification", { n: 3 });
			w.io.to("investor").emit("investor:changed");
			w.io.to(R.driverRoom("Mike")).emit("load-assigned", { k: "mike" });
			w.io.to(R.driverRoom("Dispatch")).emit("load-cancelled", { k: "dispatch" });
			w.io.to(R.driverRoom("Investor")).emit("fuel-low", { k: "investor" });
			w.io.to(R.driverRoom(" BOB DRIVER ")).emit("geofence-trigger", { k: "bob" });
			// A driver value from a request (POST /api/dispatch, …/reassign) that
			// is spelled like another kind's room still names a driver room.
			w.io.to(R.driverRoom("user:mike")).emit("load-assigned", { k: "forged" });
			// Chat, through the shipped route. `to` comes from the request body.
			const posts = [
				await chat(w, "bob", { to: "Investor", message: "m1" }),
				await chat(w, "root", { from: "Dispatch", to: "Mike", message: "m2" }),
				await chat(w, "mike", { from: "mike", to: "admin", message: "m3" }),
				await chat(w, "dDispatch", { to: "Dispatch", message: "m4" }),
				await chat(w, "root", { from: "Dispatch", to: "lone.driver", message: "m5" }),
				await chat(w, "root", { to: "Dispatch", message: "m6" }),
				await chat(w, "bob", { to: "dispatch", message: "m7" }),
				await chat(w, "bob", { to: "investor", message: "m8" }),
				await chat(w, "bob", { to: "driver:mike", message: "m9" }),
				await chat(w, "bob", { to: "user:mike", message: "m10" }),
			];
			const delivered = posts.every((r) => r.status === 200) && (await barrier(w, all, 1));
			const receivers = (event, pred) => who.filter((k) => copies(c[k], event, pred) > 0).sort();
			const msg = (m) => (x) => x && x.message === m;

			p.dispatchEventsToDispatchersOnly = delivered && sameSet(receivers("dispatch-notification"), ["ops", "root"]);
			p.investorEventsToInvestorsOnly = delivered && sameSet(receivers("investor:changed"), ["desk", "mike"]);
			p.driverMikeOwnEventOnly = delivered && sameSet(receivers("load-assigned", (x) => x.k === "mike"), ["dMike"]);
			p.driverDispatchOwnEventOnly = delivered && sameSet(receivers("load-cancelled", (x) => x.k === "dispatch"), ["dDispatch"]);
			p.driverInvestorOwnEventOnly = delivered && sameSet(receivers("fuel-low", (x) => x.k === "investor"), ["dInvestor"]);
			p.driverRoomNormalised = delivered && sameSet(receivers("geofence-trigger", (x) => x.k === "bob"), ["bob"]);
			// A chat party is a NAME: a role's name reaches the identities of that
			// name, never the role's room.
			p.chatByRoleNameSparesRoleRoom = delivered && sameSet(receivers("new-message", msg("m1")), ["bob", "dInvestor", "ops", "root"]);
			// The dispatch desk to a name: both identities of that name (each reads
			// this thread over HTTP too), the dispatch room, and no other account.
			p.chatFromDeskReachesParties = delivered && sameSet(receivers("new-message", msg("m2")), ["dMike", "mike", "ops", "root"]);
			p.chatFromInvestorSparesRoleNames = delivered && sameSet(receivers("new-message", msg("m3")), ["dMike", "mike", "ops", "root"]);
			p.chatDriverNamedDispatchToDesk = delivered && sameSet(receivers("new-message", msg("m4")), ["ops", "root"]);
			p.chatReachesUnlinkedDriver = delivered && sameSet(receivers("new-message", msg("m5")), ["lone", "ops", "root"]);
			// A driver writing to the desk's name reaches the dispatch room (which
			// has every message) and its own rooms, and no other account.
			p.chatToDispatchByDriver = delivered && sameSet(receivers("new-message", msg("m7")), ["bob", "ops", "root"]);
			// ...and to a role's name: that name's identities, never the role's room.
			p.chatToInvestorByDriver = delivered && sameSet(receivers("new-message", msg("m8")), ["bob", "dInvestor", "ops", "root"]);
			// A recipient spelled like a room of another kind reaches no one else.
			p.chatForgedRoomNamesReachNoOne = delivered && sameSet(receivers("new-message", msg("m9")), ["bob", "ops", "root"]) &&
				sameSet(receivers("new-message", msg("m10")), ["bob", "ops", "root"]);
			p.forgedDriverTargetReachesNoOne = delivered && receivers("load-assigned", (x) => x.k === "forged").length === 0;
			p.chatOncePerSocket = delivered && ["m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8", "m9", "m10"].every((m) => who.every((k) => copies(c[k], "new-message", msg(m)) <= 1)) &&
				copies(c.root, "new-message", msg("m6")) === 1;
			p.roomsRan = true;
		} finally { await w.close(); }
	},

	// §3, a driver account with no driver name, which registers its username
	async unlinked(sources, p) {
		const w = await startWorld({ sources });
		try {
			const root = await openClient(w, { user: "root" });
			const u = await openClient(w, { user: "unlinked" });
			root.s.emit("register", "dispatch");
			u.s.emit("register", "dispatch"); // the driver app sends the username here
			u.s.emit("register", "__sentinel__");
			root.s.emit("register", "__sentinel__");
			const settled = await waitUntil(() => [root, u].every((x) => w.received.some((r) => r.id === x.id && r.args[0] === "__sentinel__")));
			p.unlinkedJoinsOwnRoomOnly = settled && sameSet(roomsOf(w, u), ["user:dispatch"]) && sameSet(roomsOf(w, root), ["dispatch", "user:root"]);
			w.io.to("dispatch").emit("dispatch-notification", { n: 4 });
			const delivered = await barrier(w, [root, u], 2);
			p.unlinkedGetsNoDispatchEvents = delivered && copies(u, "dispatch-notification") === 0 && copies(root, "dispatch-notification") === 1;
			p.unlinkedRan = true;
		} finally { await w.close(); }
	},

	// §3, a register payload that is not a string. A fake socket, so the call is
	// synchronous and its outcome is observed directly.
	async nonString(sources, p) {
		const rooms = buildRooms(sources);
		const handler = buildIoHandler(sources, rooms);
		const s = { request: { session: { user: { ...USERS.bob } }, sessionID: "sid-bob" }, data: {}, rooms: new Set(), handlers: {} };
		s.disconnect = () => { s.disconnected = true; };
		s.on = (ev, cb) => { s.handlers[ev] = cb; };
		s.join = (room) => { s.rooms.add(room); };
		handler(s);
		// register is wrapped in the guard, so a fault would be caught, not
		// re-thrown; a non-string handled cleanly must raise NO caught fault. The
		// count distinguishes "read as no name" from "threw and was swallowed".
		const faultCount = () => (globalThis.__socketHandlerFaults && globalThis.__socketHandlerFaults.register && globalThis.__socketHandlerFaults.register.count) || 0;
		const faultsBefore = faultCount();
		for (const v of [5, 0, true, false, null, undefined, {}, [], ["dispatch"], { trim: 1 }, "Bob Driver"]) s.handlers.register(v);
		p.nonStringNameSafe = faultCount() === faultsBefore && !s.disconnected && sameSet([...s.rooms], ["driver:bob driver"]);
		p.nonStringRan = true;
	},

	// §5 RESILIENCE: a fault in one event handler stays contained. `uncaught`
	// collects anything that escapes to the process (this runner installs an
	// uncaughtException listener that records instead of exiting, so a fault
	// that WOULD end production shows here as `uncaught` growing).
	async resilience(sources, p) {
		// Default namespace: a session-flag read that throws. The guard must
		// catch it, keep the process up and leave the socket usable — a later
		// register, once the fault clears, still joins.
		{
			let boom = true;
			const w = await startWorld({ sources, mustChange: () => { if (boom) throw new Error("injected handler fault"); return false; } });
			try {
				const bobRoom = w.rooms.driverRoom("Bob Driver");
				const before = uncaught.length;
				const c = await openClient(w, { user: "bob" });
				c.s.emit("register", "Bob Driver"); // throws inside the guard
				await sleep(150);
				p.throwingHandlerNoCrash = !!c.id && c.s.connected && uncaught.length === before && !inRoom(w, bobRoom, c.id);
				boom = false; // the fault clears
				c.s.emit("register", "Bob Driver");
				p.connectionUsableAfterThrow = (await waitUntil(() => inRoom(w, bobRoom, c.id))) && uncaught.length === before;
			} finally { await w.close(); }
		}
		// The tracker: a non-string load id is ignored, the server stays up, and
		// a valid subscribe still works.
		{
			const w = await startWorld({ sources });
			try {
				const before = uncaught.length;
				const t = await openClient(w, { nsp: "/public-track" });
				for (const bad of [{ loadId: { toString: 5 } }, { loadId: 123 }, { loadId: {} }, { loadId: ["L-1"] }, {}, null]) t.s.emit("subscribe", bad);
				await sleep(120);
				const stillUp = !!t.id && t.s.connected && uncaught.length === before;
				t.s.emit("subscribe", { loadId: "L-777" });
				const subscribed = await waitUntil(() => inRoom(w, "load:L-777", t.id, "/public-track"));
				p.trackerNonStringIgnoredServerUp = stillUp && subscribed &&
					(await receives(t.s, "tracker-update", () => w.io.of("/public-track").to("load:L-777").emit("tracker-update", { lat: 5 })));
			} finally { await w.close(); }
		}
		// The tracker guard itself: a load-id check that throws is caught, so the
		// process stays up. A regex whose test throws stands in for any fault.
		{
			const w = await startWorld({ sources, loadIdRe: { test() { throw new Error("injected regex fault"); } } });
			try {
				const before = uncaught.length;
				const t = await openClient(w, { nsp: "/public-track" });
				t.s.emit("subscribe", { loadId: "L-1" }); // reaches the throwing test
				await sleep(150);
				p.trackerHandlerGuarded = !!t.id && t.s.connected && uncaught.length === before;
			} finally { await w.close(); }
		}
		p.resilienceRan = true;
	},

	// §4, run over the source (a mutant may replace it)
	async pins(sources, p) {
		const roomProblems = roomPinProblems(sources.fullSrc || SRC);
		p.roomPinsHold = roomProblems.length === 0;
		p.roomPinProblems = roomProblems.join("\n     ");
		const guardProblems = handlerGuardProblems(sources.fullSrc || SRC);
		p.handlerGuardsHold = guardProblems.length === 0;
		p.handlerGuardProblems = guardProblems.join("\n     ");
		p.pinsRan = true;
	},
};

// ── §4 SOURCE: every room argument in server.js ─────────────────────────────
// Comment lines and the `//` tail of a line are blanked (newlines kept, so
// line numbers survive); a line's string literals are respected.
function stripComments(src) {
	return src.split("\n").map((line) => {
		const t = line.trim();
		if (t.startsWith("/*") || t.startsWith("*")) return "";
		let quote = null;
		for (let i = 0; i < line.length; i++) {
			const ch = line[i];
			if (quote) {
				if (ch === "\\") { i++; continue; }
				if (ch === quote) quote = null;
				continue;
			}
			if (ch === "'" || ch === '"' || ch === "`") { quote = ch; continue; }
			if (ch === "/" && line[i + 1] === "/") return line.slice(0, i);
		}
		return line;
	}).join("\n");
}
// The index of the `)` closing the `(` at `open`, respecting string literals.
function closeParen(code, open) {
	let depth = 0;
	let quote = null;
	for (let i = open; i < code.length; i++) {
		const ch = code[i];
		if (quote) {
			if (ch === "\\") { i++; continue; }
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === "'" || ch === '"' || ch === "`") { quote = ch; continue; }
		if (ch === "(") depth++;
		else if (ch === ")" && --depth === 0) return i;
	}
	return -1;
}
const lineOf = (code, at) => code.slice(0, at).split("\n").length;
// `helper(…)` as one whole call, nothing after it.
const isCallOf = (arg, names) => {
	const m = arg.match(/^([A-Za-z_$][\w$]*)\s*\(/);
	return !!m && names.includes(m[1]) && closeParen(arg, arg.indexOf("(")) === arg.length - 1;
};
const ROLE_LITERAL = /^"(dispatch|investor)"$/;
const IDENTITY_HELPERS = ["driverRoom", "userRoom", "chatRooms"];
// Events addressed to one driver. Each site must name its room with driverRoom().
const DRIVER_EVENTS = { "load-assigned": 2, "load-cancelled": 2, "fuel-low": 1, "location-update": 2, "geofence-trigger": 1 };

function roomPinProblems(fullSrc) {
	const code = stripComments(fullSrc);
	const problems = [];
	const bad = (at, what) => problems.push(`server.js:${lineOf(code, at)} ${what}`);
	const body = (head) => {
		const a = code.indexOf(head);
		const b = a < 0 ? -1 : code.indexOf("\n});", a);
		return a < 0 || b < 0 ? null : [a, b];
	};
	const defaultNs = body('io.on("connection", (socket) => {');
	const trackerNs = body('publicTrack.on("connection", (socket) => {');
	if (!defaultNs || !trackerNs) return ["could not locate both connection handlers"];
	const within = (at, [a, b]) => at > a && at < b;

	const emits = []; // { helper call text, event }
	const joins = [];
	const toCalls = []; // every `io.to(` argument, before it is judged
	// Every call that names a room: `.to(` on any receiver, the rarer room
	// methods, and `socket.join(` / `socket.leave(`.
	const re = /([\w$)\]]+)\s*\.\s*(to|in|except|socketsJoin|socketsLeave|join|leave)\s*\(/g;
	let m;
	while ((m = re.exec(code))) {
		const [, recv, method] = m;
		const at = m.index;
		if ((method === "join" || method === "leave") && recv !== "socket") {
			// Array#join and friends, EXCEPT inside a connection handler, where
			// the only thing joined is a room.
			if (within(at, defaultNs) || within(at, trackerNs)) bad(at, `${recv}.${method}( inside a connection handler: rooms are joined through \`socket\` only`);
			continue;
		}
		const open = at + m[0].length - 1;
		const close = closeParen(code, open);
		const arg = code.slice(open + 1, close).trim();
		if (method === "to" && recv === "io") toCalls.push({ arg, at });
		if (["in", "except", "socketsJoin", "socketsLeave"].includes(method)) {
			bad(at, `${recv}.${method}(${arg}) — no room method but to/join/leave is used; name the room with a helper and add it here`);
			continue;
		}
		let ns;
		if (method === "to") {
			if (recv === "io") ns = "default";
			else if (recv === "publicTrack") ns = "tracker";
			else { bad(at, `${recv}.to(${arg}) — rooms are reached through io or publicTrack only`); continue; }
		} else if (within(at, defaultNs)) ns = "default";
		else if (within(at, trackerNs)) ns = "tracker";
		else { bad(at, `socket.${method}(${arg}) outside a connection handler`); continue; }

		if (ns === "tracker") {
			if (!/^"load:" \+ [A-Za-z_$][\w$]*$/.test(arg)) bad(at, `public-tracker room ${arg} — must be "load:" + <load id>`);
			continue;
		}
		if (!ROLE_LITERAL.test(arg) && !isCallOf(arg, IDENTITY_HELPERS)) {
			bad(at, `room ${arg} — must be "dispatch", "investor", or driverRoom()/userRoom()/chatRooms()`);
			continue;
		}
		if (method === "join") joins.push(arg);
		if (method === "to") {
			const rest = code.slice(close + 1);
			const e = rest.match(/^\s*\.\s*emit\(\s*["'`]([^"'`$]+)["'`]/);
			emits.push({ arg, event: e ? e[1] : null, at });
		}
	}
	// Per event: driver events through driverRoom(), chat through chatRooms().
	for (const [event, want] of Object.entries(DRIVER_EVENTS)) {
		const sites = emits.filter((x) => x.event === event);
		const viaDriverRoom = sites.filter((x) => isCallOf(x.arg, ["driverRoom"]));
		const other = sites.filter((x) => !isCallOf(x.arg, ["driverRoom"]) && x.arg !== '"dispatch"');
		if (viaDriverRoom.length !== want) problems.push(`"${event}" goes to driverRoom() at ${viaDriverRoom.length} site(s), expected ${want}`);
		for (const x of other) bad(x.at, `"${event}" to ${x.arg} — a driver event goes to driverRoom() or the dispatch room`);
	}
	const chatSites = emits.filter((x) => x.event === "new-message");
	if (chatSites.length !== 1 || !isCallOf(chatSites[0].arg, ["chatRooms"])) problems.push(`"new-message" must be one emit to chatRooms(), found ${chatSites.map((x) => x.arg).join(", ") || "none"}`);
	for (const x of emits) {
		if (isCallOf(x.arg, ["chatRooms"]) && x.event !== "new-message") bad(x.at, `chatRooms() is for chat only, not "${x.event}"`);
		if (isCallOf(x.arg, ["userRoom"])) bad(x.at, `userRoom() emits nothing today; "${x.event}" to ${x.arg} needs a reason and a pin`);
	}
	// Emit targets taken from a request: the driver of POST /api/dispatch and
	// …/reassign, and the chat parties of POST /api/messages. The check above
	// holds every room to a helper; this names the request-fed sites, so a
	// failure says which, and pins that nothing else in those routes names a
	// room but the dispatch room.
	const REQUEST_FED = [
		['app.post("/api/dispatch", ', ["driverRoom(driver)"]],
		['app.post("/api/dispatch/reassign", ', ["driverRoom(newDriver)", "driverRoom(oldDriverKey)"]],
		['app.post("/api/messages", ', ["chatRooms(from, to)"]],
	];
	for (const [head, want] of REQUEST_FED) {
		const range = body(head);
		if (!range) { problems.push(`could not locate ${head.trim()}`); continue; }
		const targets = toCalls.filter((x) => within(x.at, range) && x.arg !== '"dispatch"').map((x) => x.arg);
		if (!sameSet(targets, want)) {
			problems.push(`${head.trim()} request-derived emit targets are ${JSON.stringify(targets)}, expected ${JSON.stringify(want)}: a value from a request reaches a room only through driverRoom()/userRoom()/chatRooms()`);
		}
	}
	// `register` joins exactly these.
	const wantJoins = ['"dispatch"', '"investor"', "userRoom(usernameLower)", "userRoom(usernameLower)", "userRoom(usernameLower)",
		"driverRoom(driverNameLower)", "driverRoom(driverNameLower)"];
	if (!sameSet(joins, wantJoins)) problems.push(`register joins ${JSON.stringify(joins)}, expected ${JSON.stringify(wantJoins)}`);
	// Emits to EVERY socket: only the dev reload. And no other way to a room.
	const broadcasts = code.match(/\b(?:io|publicTrack)\s*\.\s*emit\s*\([^)]*\)/g) || [];
	if (broadcasts.length !== 1 || !/^io\.emit\("reload"\)$/.test(broadcasts[0])) problems.push(`emits to every socket: ${JSON.stringify(broadcasts)}, expected only io.emit("reload")`);
	const ofs = code.match(/\bio\s*\.\s*of\(\s*"[^"]*"\s*\)/g) || [];
	if (!sameSet(ofs, ['io.of("/")', 'io.of("/public-track")'])) problems.push(`io.of() calls ${JSON.stringify(ofs)}, expected io.of("/") (the socket-session helpers) and io.of("/public-track")`);
	if (/\bio\s*\.\s*of\(\s*"\/"\s*\)\s*\.\s*(to|in|emit|except)\b/.test(code)) problems.push('io.of("/") reaches a room or every socket; use io.to() with a helper');
	if (/\bio\s*\.\s*(sockets|local|broadcast)\b|\bsocket\s*\.\s*broadcast\b/.test(code)) problems.push("io.sockets / io.local / io.broadcast / socket.broadcast in use; name rooms with io.to() and a helper");
	// The handshake rule and the cap are what `new Server()` is given.
	const newServers = code.match(/new Server\(/g) || [];
	const opts = (code.match(/\nconst io = new Server\(server, \{\n([\s\S]*?)\n\}\);/) || [])[1] || "";
	if (newServers.length !== 1 || !/^\s*allowRequest: liveUpdateHandshakeAllowed,$/m.test(opts) || !/^\s*maxHttpBufferSize: SOCKET_MAX_MESSAGE_BYTES,$/m.test(opts)) {
		problems.push("`new Server()` must be constructed once, with allowRequest: liveUpdateHandshakeAllowed and maxHttpBufferSize: SOCKET_MAX_MESSAGE_BYTES");
	}
	return problems;
}

// §4 SOURCE: every socket event listener in either connection handler is
// wrapped in socketHandler(), and the tracker reads a string load id only.
function handlerGuardProblems(fullSrc) {
	const code = stripComments(fullSrc);
	const problems = [];
	const handlerBody = (head) => {
		const a = code.indexOf(head);
		const b = a < 0 ? -1 : code.indexOf("\n});", a);
		return a < 0 || b < 0 ? null : code.slice(a, b);
	};
	for (const [label, head] of [["io.on(connection)", 'io.on("connection", (socket) => {'], ["/public-track", 'publicTrack.on("connection", (socket) => {']]) {
		const body = handlerBody(head);
		if (body === null) { problems.push(`could not locate the ${label} handler`); continue; }
		// Every socket.on("EVENT", …) in the body must be socketHandler("EVENT", …).
		const re = /socket\.on\(\s*("[^"]+"|'[^']+'|`[^`]+`)\s*,\s*([A-Za-z_$][\w$]*)?/g;
		let m;
		let seen = 0;
		while ((m = re.exec(body))) {
			seen++;
			if (m[2] !== "socketHandler") problems.push(`${label}: socket.on(${m[1]}, …) is not wrapped in socketHandler() (found ${m[2] || "an inline function"})`);
			else if (!body.startsWith(`socket.on(${m[1]}, socketHandler(${m[1]},`, m.index)) problems.push(`${label}: socket.on(${m[1]}, …) must wrap the SAME event name in socketHandler(${m[1]}, …)`);
		}
		if (!seen) problems.push(`${label}: no socket.on() found — the scan pattern moved`);
	}
	// socketHandler returns a wrapper that CATCHES; it must not hand back the
	// bare handler. A rejected promise from an async handler is caught too.
	const guard = stripComments((() => { try { return SRCS.guard; } catch { return ""; } })());
	if (!/catch\s*\(/.test(guard) || /return fn;/.test(guard)) problems.push("socketHandler() must catch a handler fault, not return the handler bare");
	if (!/typeof\s+.+\.then\s*===\s*"function"/.test(guard)) problems.push("socketHandler() must also catch a returned promise's rejection");
	// The tracker derives its load id from a string only, never String()-coerced.
	const tracker = handlerBody('publicTrack.on("connection", (socket) => {') || "";
	if (!/typeof\s+[A-Za-z_$][\w$.]*\.loadId\s*===\s*"string"/.test(tracker)) problems.push("the tracker must accept a load id only when it is a string");
	if (/String\(\s*[A-Za-z_$][\w$.]*\.loadId/.test(tracker)) problems.push("the tracker must not String()-coerce the load id");
	return problems;
}

// ── properties: [scenario, what it means when false] ────────────────────────
const PROPS = {};
for (const [name, , allowed] of ORIGIN_CASES) {
	const verb = allowed ? "must be admitted" : "must be refused";
	PROPS[`${name}Poll`] = ["origin", `§1 long-polling handshake, case "${name}": ${verb}`];
	PROPS[`${name}Ws`] = ["origin", `§1 WebSocket handshake, case "${name}": ${verb}`];
}
Object.assign(PROPS, {
	jsonpNoOriginRefused: ["origin", "§1 JSONP long-polling with no Origin must be refused"],
	jsonpSelfRefused: ["origin", "§1 JSONP long-polling must be refused even from the app's own origin"],
	refusedOpensNothing: ["origin", "§1 a refused handshake must open no connection"],
	clientFromElsewhereRefused: ["origin", "§1 a real client from another origin must never connect"],
	clientFromSelfConnects: ["origin", "§1 a real client from the app's own origin must connect, join and receive"],
	originRan: ["origin", "§1 the origin scenario must run to the end"],
	refusalLoggedOnce: ["logging", "§1 refusals must be logged once a minute, naming the Origin, Host and X-Forwarded-Host seen"],
	refusalLogKeepsTotal: ["logging", "§1 ...with a running total of refusals"],
	refusalLogClipsHeaders: ["logging", "§1 ...and the header values clipped"],
	loggingRan: ["logging", "§1 the logging scenario must run to the end"],
	trackerFromSelfReceives: ["tracker", "§1 the public tracker must connect from the app's own origin and receive its load's updates"],
	trackerFromElsewhereRefused: ["tracker", "§1 the public tracker must be refused from another origin"],
	trackerRan: ["tracker", "§1 the tracker scenario must run to the end"],
	capIs16KB: ["size", "§2 the cap must be 16 KB"],
	serverGivenCap: ["size", "§2 Engine.IO must be given the cap as maxHttpBufferSize"],
	legitimateFarBelowCap: ["size", "§2 every legitimate client message must be at most a twentieth of the cap"],
	wsAtCapAccepted: ["size", "§2 a WebSocket message exactly at the cap must be accepted"],
	wsOverCapDisconnects: ["size", "§2 a WebSocket message one byte over the cap must disconnect that client, undelivered"],
	pollAtCapAccepted: ["size", "§2 a long-polling message exactly at the cap must be accepted"],
	pollOverCapDisconnects: ["size", "§2 a long-polling message one byte over the cap must disconnect that client, undelivered"],
	pollBodyAtCapTaken: ["size", "§2 a long-polling request body exactly at the cap must be taken"],
	pollBodyOverCapRefused: ["size", "§2 a long-polling request body one byte over the cap must be answered 413"],
	othersCarryOn: ["size", "§2 other connections must carry on"],
	sizeRan: ["size", "§2 the size scenario must run to the end"],
	roomsExact: ["rooms", "§3 every identity must join exactly its role room and its own identity rooms, whatever names it registers"],
	dispatchEventsToDispatchersOnly: ["rooms", "§3 dispatch-room events must reach the Super Admin and the Dispatcher only, whatever any other account is named"],
	investorEventsToInvestorsOnly: ["rooms", "§3 investor-room events must reach investors only, whatever any other account is named"],
	driverMikeOwnEventOnly: ["rooms", "§3 a driver's event must reach that driver only, not an account of the other kind with the same name (fixture dMike)"],
	driverDispatchOwnEventOnly: ["rooms", "§3 a driver's event must reach that driver only (fixture dDispatch)"],
	driverInvestorOwnEventOnly: ["rooms", "§3 a driver's event must reach that driver only (fixture dInvestor)"],
	driverRoomNormalised: ["rooms", "§3 driverRoom() must trim and lower-case, as the emit sites did"],
	chatByRoleNameSparesRoleRoom: ["rooms", "§3 chat addressed to a role's name must reach that name's identities and the dispatch room, never the role's room (m1)"],
	chatFromDeskReachesParties: ["rooms", "§3 chat from the dispatch desk must reach the recipient name's identities and the dispatch room, and no other account (m2)"],
	chatFromInvestorSparesRoleNames: ["rooms", "§3 chat from an investor must reach the parties' rooms and the dispatch room only (m3)"],
	chatDriverNamedDispatchToDesk: ["rooms", "§3 chat to the desk must reach the dispatch room only, whoever sends it (m4)"],
	chatReachesUnlinkedDriver: ["rooms", "§3 chat to a driver's username must reach that driver"],
	chatToDispatchByDriver: ["rooms", "§3 chat a driver addresses to the desk's name must reach the dispatch room and the sender only (m7)"],
	chatToInvestorByDriver: ["rooms", "§3 chat a driver addresses to a role's name must reach that name's identity and the dispatch room, never the role's room (m8)"],
	chatForgedRoomNamesReachNoOne: ["rooms", "§3 a chat recipient spelled like a room of another kind (driver:…, user:…) must reach no one else"],
	forgedDriverTargetReachesNoOne: ["rooms", "§3 a driver target spelled like a user room must reach no one"],
	chatOncePerSocket: ["rooms", "§3 each socket must receive a chat message once"],
	roomsRan: ["rooms", "§3 the rooms scenario must run to the end"],
	unlinkedJoinsOwnRoomOnly: ["unlinked", "§3 a driver with no driver name must join only its own user room (fixture unlinked)"],
	unlinkedGetsNoDispatchEvents: ["unlinked", "§3 ...and receive no dispatch-room event"],
	unlinkedRan: ["unlinked", "§3 the unlinked-driver scenario must run to the end"],
	nonStringNameSafe: ["nonString", "§3 a register payload that is not a string must be read as no name: the caller joins only its own rooms"],
	nonStringRan: ["nonString", "§3 the non-string scenario must run to the end"],
	throwingHandlerNoCrash: ["resilience", "§5 a fault in a socket event handler must not reach the process, and must leave the socket connected"],
	connectionUsableAfterThrow: ["resilience", "§5 ...and once the fault clears, the same socket's next event still works"],
	trackerNonStringIgnoredServerUp: ["resilience", "§5 a non-string tracker load id must be ignored, the server stay up, and a valid subscribe still receive"],
	trackerHandlerGuarded: ["resilience", "§5 a fault inside a tracker handler must be caught, leaving the process up"],
	resilienceRan: ["resilience", "§5 the resilience scenario must run to the end"],
	roomPinsHold: ["pins", "§4 every room argument must be a role literal or a helper"],
	handlerGuardsHold: ["pins", "§4 every socket.on() in either namespace must be wrapped in socketHandler(), and the tracker must read a string load id only"],
	pinsRan: ["pins", "§4 the pins must run"],
});

async function runScenarios(sources, names) {
	const p = {};
	for (const name of names) await SCENARIOS[name](sources, p);
	return p;
}

// ── §5 discrimination ───────────────────────────────────────────────────────
const cut = (from, to) => (s) => s.replace(from, to);
const MUTANTS = [
	{
		name: "no allowRequest: every origin admitted",
		target: "serverOpts",
		mutate: cut(/\n\tallowRequest: liveUpdateHandshakeAllowed,/, ""),
		caughtBy: ["foreignPoll", "foreignWs", "bareDomainWs", "siblingHostPoll", "nullOriginWs", "jsonpNoOriginRefused", "refusedOpensNothing", "clientFromElsewhereRefused", "trackerFromElsewhereRefused"],
	},
	{
		name: "the Origin leg removed",
		target: "origin",
		mutate: cut('if (!originIsSelf(view, origin) || !originHostIsExact(view, origin)) refused = "Origin is not this app";\n\t\t\telse ', ""),
		caughtBy: ["foreignPoll", "foreignWs", "siblingHostWs", "otherEnvironmentPoll", "otherPortPoll", "clientFromElsewhereRefused"],
	},
	{
		name: "the port no longer counts (originIsSelf() alone)",
		target: "origin",
		mutate: cut(" || !originHostIsExact(view, origin)", ""),
		caughtBy: ["otherPortPoll", "otherPortWs", "forwardedOtherPortPoll", "forwardedOtherPortWs", "portRewrittenPoll", "portRewrittenWs"],
	},
	{
		name: "a written-out default port no longer normalised",
		target: "origin",
		mutate: cut("try { return new URL(`${u.protocol}//${v}`).host.toLowerCase(); } catch { return \"\"; }", "return v.toLowerCase();"),
		caughtBy: ["defaultPortInHostPoll", "defaultPortInHostWs", "defaultPortForwardedPoll", "defaultPortForwardedWs"],
	},
	{
		name: "plain HTTP admitted while the session cookie is Secure",
		target: "origin",
		mutate: cut('\n\t\t\telse if (SESSION_COOKIE_SECURE && !/^https:\\/\\//i.test(origin)) refused = "Origin is not HTTPS";', ""),
		caughtBy: ["plainHttpWhileSecurePoll", "plainHttpWhileSecureWs"],
	},
	{
		name: "Sec-Fetch-Site ignored when there is no Origin",
		target: "origin",
		mutate: cut(/\n\t\t\tif \(site && site !== "same-origin"\) refused = [^\n]*;/, ""),
		caughtBy: ["noOriginSameSitePoll", "noOriginSameSiteWs", "noOriginCrossSitePoll", "noOriginNoInitiatorWs"],
	},
	{
		name: "the JSONP leg removed",
		target: "origin",
		mutate: cut('if (typeof query.j === "string") refused = "JSONP long-polling";\n\t\telse ', ""),
		caughtBy: ["jsonpNoOriginRefused"],
	},
	{
		name: "a missing Origin refused",
		target: "origin",
		mutate: cut('if (site && site !== "same-origin") refused', "if (true) refused"),
		caughtBy: ["noOriginPoll", "noOriginWs", "noOriginSameOriginPoll", "pollBodyAtCapTaken"],
	},
	{
		name: "DRIVER_MOBILE_ORIGINS ignored",
		target: "origin",
		mutate: cut("} else if (!DRIVER_MOBILE_ORIGINS.includes(origin)) {", "} else if (true) {"),
		caughtBy: ["allowlistedPoll", "allowlistedWs"],
	},
	{
		name: "a raw Host compare in place of originIsSelf()",
		target: "origin",
		mutate: cut("!originIsSelf(view, origin) || !originHostIsExact(view, origin)", "new URL(origin).host !== headers.host"),
		caughtBy: ["nginxForwardedHostPoll", "nginxForwardedHostWs"],
	},
	{
		name: "refusals not logged",
		target: "origin",
		mutate: (s) => s.replace(/\n\t\tconsole\.warn\([\s\S]*?\n\t\t\);/, ""),
		caughtBy: ["refusalLoggedOnce", "refusalLogKeepsTotal"],
	},
	{
		name: "no maxHttpBufferSize: the 1 MB default",
		target: "serverOpts",
		mutate: cut(/\n\tmaxHttpBufferSize: SOCKET_MAX_MESSAGE_BYTES,/, ""),
		caughtBy: ["serverGivenCap", "wsOverCapDisconnects", "pollOverCapDisconnects", "pollBodyOverCapRefused"],
	},
	{
		name: "register joins the bare driver name",
		target: "ioHandler",
		mutate: cut("if (driverNameLower) socket.join(driverRoom(driverNameLower));", "if (driverNameLower) socket.join(driverNameLower);"),
		caughtBy: ["roomsExact", "dispatchEventsToDispatchersOnly", "investorEventsToInvestorsOnly"],
	},
	{
		name: "register joins the requested name as sent",
		target: "ioHandler",
		mutate: cut(/\n\t\tif \(requested && requested === driverNameLower\) socket\.join\(driverRoom\(driverNameLower\)\);\n\t\tif \(requested && requested === usernameLower\) socket\.join\(userRoom\(usernameLower\)\);/,
			"\n\t\tif (requested && (requested === driverNameLower || requested === usernameLower)) socket.join(requested);"),
		caughtBy: ["roomsExact", "dispatchEventsToDispatchersOnly", "unlinkedJoinsOwnRoomOnly", "unlinkedGetsNoDispatchEvents"],
	},
	{
		name: "userRoom() without its prefix",
		target: "rooms",
		mutate: cut("return `user:${identityRoomKey(username)}`;", "return identityRoomKey(username);"),
		caughtBy: ["roomsExact", "dispatchEventsToDispatchersOnly", "investorEventsToInvestorsOnly", "unlinkedGetsNoDispatchEvents"],
	},
	{
		name: "driverRoom() without its prefix",
		target: "rooms",
		mutate: cut("return `driver:${identityRoomKey(name)}`;", "return identityRoomKey(name);"),
		caughtBy: ["roomsExact", "dispatchEventsToDispatchersOnly", "investorEventsToInvestorsOnly"],
	},
	{
		name: "chatRooms() treats \"Dispatch\" as a person",
		target: "rooms",
		mutate: cut('if (!key || key === "dispatch") continue;', "if (!key) continue;"),
		caughtBy: ["chatFromDeskReachesParties", "chatDriverNamedDispatchToDesk"],
	},
	{
		name: "chat fanned out by the bare names",
		target: "messages",
		mutate: cut("io.to(chatRooms(from, to)).emit(\"new-message\", payload);",
			"const fromRoom = (from || \"\").trim().toLowerCase();\n\t\tconst toRoom = (to || \"\").trim().toLowerCase();\n\t\tif (fromRoom) io.to(fromRoom).emit(\"new-message\", payload);\n\t\tif (toRoom && toRoom !== fromRoom) io.to(toRoom).emit(\"new-message\", payload);\n\t\tif (fromRoom !== \"dispatch\" && toRoom !== \"dispatch\") io.to(\"dispatch\").emit(\"new-message\", payload);"),
		caughtBy: ["chatByRoleNameSparesRoleRoom", "chatFromDeskReachesParties", "chatReachesUnlinkedDriver"],
	},
	{
		name: "register normalises a name without checking its type",
		target: "ioHandler",
		mutate: cut("const requested = identityRoomKey(clientName);", "const requested = (clientName || \"\").trim().toLowerCase();"),
		caughtBy: ["nonStringNameSafe"],
	},
	{
		name: "identityRoomKey() without the type check",
		target: "rooms",
		mutate: cut('return (typeof name === "string" ? name : "").trim().toLowerCase();', "return (name || \"\").trim().toLowerCase();"),
		caughtBy: ["nonStringNameSafe"],
	},
	{
		name: "socketHandler returns the handler bare (no catch)",
		target: "guard",
		mutate: (s) => s.replace(/return function wrappedSocketHandler[\s\S]*?\n\t\};/, "return fn;"),
		caughtBy: ["throwingHandlerNoCrash", "trackerHandlerGuarded"],
	},
	// §4: the pins, over a whole server.js with one site reverted
	...[
		["a load-assigned emit to the bare driver name", "io.to(driverRoom(driver)).emit(\"load-assigned\"", "io.to(driver.trim().toLowerCase()).emit(\"load-assigned\""],
		["a fuel-low emit to the bare key", "io.to(driverRoom(key)).emit(\"fuel-low\"", "io.to(key).emit(\"fuel-low\""],
		["a location-update emit to the bare driver name", "if (driverLower) io.to(driverRoom(driverLower)).emit(\"location-update\", locationPayload);\n\t\t// Same low-fuel", "if (driverLower) io.to(driverLower).emit(\"location-update\", locationPayload);\n\t\t// Same low-fuel"],
		["chat to the bare recipient name", "io.to(chatRooms(from, to)).emit(\"new-message\", payload);", "io.to((to || \"\").trim().toLowerCase()).emit(\"new-message\", payload);"],
		["a reassign emit to the bare new driver", "io.to(driverRoom(newDriver)).emit(\"load-assigned\"", "io.to(newDriver.trim().toLowerCase()).emit(\"load-assigned\""],
		["chat to the dispatch room when the recipient says so", "io.to(chatRooms(from, to)).emit(\"new-message\", payload);", "io.to(to === \"dispatch\" ? \"dispatch\" : chatRooms(from, to)).emit(\"new-message\", payload);"],
		["register joining the bare username", "\t\t\tif (usernameLower) socket.join(userRoom(usernameLower));\n\t\t} else if (role === \"Investor\")", "\t\t\tif (usernameLower) socket.join(usernameLower);\n\t\t} else if (role === \"Investor\")"],
		["a new emit to every socket", "setTimeout(() => io.emit(\"reload\"), 500);", "setTimeout(() => io.emit(\"reload\"), 500);\nio.emit(\"location-update\", {});"],
		["the Server built without the handshake rule", "\tallowRequest: liveUpdateHandshakeAllowed,\n", ""],
	].map(([name, from, to]) => ({
		name: `SOURCE: ${name}`,
		target: "fullSrc",
		mutate: () => (SRC.includes(from) ? SRC.replace(from, to) : SRC),
		caughtBy: ["roomPinsHold"],
	})),
	// §4: the guard pins, over a whole server.js with one site reverted.
	...[
		["the register listener left unwrapped", 'socket.on("register", socketHandler("register", (clientName) => {', 'socket.on("register", (clientName) => {'],
		["the tracker subscribe listener left unwrapped", 'socket.on("subscribe", socketHandler("subscribe", (payload) => {', 'socket.on("subscribe", (payload) => {'],
		["the tracker reading a String()-coerced load id", 'payload && typeof payload.loadId === "string" ? payload.loadId.trim() : ""', '(payload && payload.loadId ? String(payload.loadId) : "").trim()'],
	].map(([name, from, to]) => ({
		name: `SOURCE: ${name}`,
		target: "fullSrc",
		mutate: () => (SRC.includes(from) ? SRC.replace(from, to) : SRC),
		caughtBy: ["handlerGuardsHold"],
	})),
];

(async () => {
	const shipped = await runScenarios(SRCS, Object.keys(SCENARIOS));
	for (const [prop, [, msg]] of Object.entries(PROPS)) ok(shipped[prop] === true, msg);
	if (shipped.roomsExact !== true) failures.push(`     rooms joined: ${shipped.roomsDetail}`);
	if (shipped.roomPinsHold !== true) failures.push(`     ${shipped.roomPinProblems}`);
	if (shipped.handlerGuardsHold !== true) failures.push(`     ${shipped.handlerGuardProblems}`);
	ok(uncaught.length === 0, `no listener may throw on the shipped code: ${uncaught.join("; ")}`);

	// §2: the numbers in the comment beside the cap are the measured ones.
	const f = measuredFrames();
	const capComment = (() => {
		const lines = SRC.slice(0, SRC.indexOf("\nconst SOCKET_MAX_MESSAGE_BYTES = ")).split("\n");
		const out = [];
		for (let i = lines.length - 1; i >= 0 && lines[i].startsWith("//"); i--) out.unshift(lines[i].replace(/^\/\/ ?/, ""));
		return out.join(" ").replace(/\s+/g, " ");
	})();
	ok(capComment.includes(`is ${f.register200} bytes (${f.register200Wide} if every character takes two bytes), a tracker subscribe ${f.subscribe}, and one long-polling request carrying all of them ${f.batch}.`),
		`§2 the comment beside SOCKET_MAX_MESSAGE_BYTES must state the measured sizes: register ${f.register200} (${f.register200Wide} wide), subscribe ${f.subscribe}, batch ${f.batch}`);

	// §4: the helpers' spelling, directly.
	const R = buildRooms(SRCS);
	ok(R.driverRoom(" Mike ") === "driver:mike" && R.userRoom("MIKE") === "user:mike", "§4 driverRoom()/userRoom() must be driver:/user: plus the trimmed, lower-cased name");
	ok(R.driverRoom("x") !== R.userRoom("x"), "§4 a driver room and a user room of one name must differ");
	const roleish = ["dispatch", "Dispatch", " DISPATCH ", "investor", "Investor", "", "   "];
	ok(roleish.every((n) => ![R.driverRoom(n), R.userRoom(n)].some((r) => r === "dispatch" || r === "investor")),
		"§4 no name may make a helper return a role room");
	ok([5, true, null, undefined, {}, [], ["dispatch"]].every((v) => R.identityRoomKey(v) === ""), "§4 identityRoomKey() must read anything but a string as no name");
	ok(JSON.stringify(R.chatRooms("", "")) === '["dispatch"]' && JSON.stringify(R.chatRooms(undefined, null)) === '["dispatch"]',
		"§4 chatRooms() must never be empty (io.to([]) reaches every socket): with no party it is the dispatch room");
	ok(JSON.stringify(R.chatRooms("Dispatch", " Investor ")) === '["dispatch","driver:investor","user:investor"]',
		"§4 chatRooms(): the desk is the dispatch room, any other name its driver and user rooms");
	ok(roleish.every((a) => roleish.every((b) => !R.chatRooms(a, b).includes("investor"))), "§4 chatRooms() must never name the investor role room");
	ok(JSON.stringify(R.chatRooms("Bob", "bob ")) === '["dispatch","driver:bob","user:bob"]', "§4 chatRooms() must list each room once");
	// Values as a request may carry them: role names, another kind's prefix, empty,
	// not a string. Each names a room of the helper's own kind, and chatRooms()
	// adds no role room for any of them: its only role room is the dispatch
	// room, first and once, for every input.
	const hostile = ["dispatch", "Dispatch", " DISPATCH ", "investor", "Investor", "driver:mike", "user:mike", "driver:", "user:", "", "mike", 7, null];
	ok(hostile.every((v) => R.driverRoom(v).startsWith("driver:") && R.userRoom(v).startsWith("user:")),
		"§4 driverRoom()/userRoom() must name a room of their own kind whatever the value");
	ok(R.driverRoom("user:mike") !== R.userRoom("mike") && R.userRoom("driver:mike") !== R.driverRoom("mike"),
		"§4 a value spelled like the other kind's room must not reach it");
	ok(hostile.every((a) => hostile.every((b) => {
		const rooms = R.chatRooms(a, b);
		const want = new Set(["dispatch"]);
		for (const v of [a, b]) {
			const k = R.identityRoomKey(v);
			if (k && k !== "dispatch") { want.add(R.driverRoom(k)); want.add(R.userRoom(k)); }
		}
		return rooms[0] === "dispatch" && rooms.filter((r) => r === "dispatch").length === 1 && !rooms.includes("investor") && sameSet(rooms, [...want]);
	})), "§4 chatRooms(): the dispatch room first and once, then only the driver and user rooms of the parties' names, for every pair of request values");
	for (const file of fs.readdirSync(path.join(ROOT, "lib")).filter((n) => n.endsWith(".js"))) {
		const code = stripComments(fs.readFileSync(path.join(ROOT, "lib", file), "utf8"));
		ok(!/\b(io|publicTrack|socket|nsp)\s*\.\s*(to|in|join|leave|except|socketsJoin|socketsLeave)\s*\(/.test(code) && !/require\(["']socket\.io["']\)/.test(code),
			`§4 lib/${file} must name no Socket.IO room`);
	}

	phase = "mutants";
	for (const m of MUTANTS) {
		const before = m.target === "fullSrc" ? SRC : SRCS[m.target];
		const after = m.mutate(before);
		if (after === before) {
			failures.push(`§5 mutant "${m.name}" did not change the source — its marker text moved`);
			continue;
		}
		const sources = { ...SRCS, [m.target]: after };
		const names = [...new Set(m.caughtBy.map((prop) => PROPS[prop][0]))];
		const got = await runScenarios(sources, names);
		for (const prop of m.caughtBy) {
			ok(shipped[prop] === true && got[prop] === false, `§5 MUTANT NOT CAUGHT — "${m.name}" must flip ${prop} (got ${got[prop]})`);
		}
		// Caught for the right reason: the scenario still ran to its end.
		for (const name of names) ok(got[`${name}Ran`] === true, `§5 mutant "${m.name}" must not stop scenario "${name}" early`);
	}

	restoreConsole();
	if (failures.length) {
		console.error(`\n${failures.length} FAILURE(S):`);
		for (const f of failures) console.error(`  ✗ ${f}`);
		console.error(`\n── last log lines ──\n${logs.slice(-15).join("\n")}`);
		process.exit(1);
	}
	console.log(`test-socket-hardening: ${pass} assertions passed (${MUTANTS.length} mutants caught)`);
	process.exit(0);
})().catch((err) => {
	restoreConsole();
	console.error(`FAILED: ${err && err.stack}`);
	process.exit(1);
});
