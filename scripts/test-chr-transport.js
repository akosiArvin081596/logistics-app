#!/usr/bin/env node
// lib/chr-transport.js: the one way a C.H. Robinson request could leave LogisX
// (R5 PR 3-shell: plan 10-28 §4.9 and PR 3, the cases that need no CHR docs;
// addendum §4.2). Against a fake CHR on 127.0.0.1 (scripts/e2e/fake-chr.cjs)
// with a made-up wire, since CHR's real one comes with PR 3-wire.
//
//   §1  as shipped: no CHR host and no wire, so never ready, fully configured or
//       not; nothing is requested
//   §2  the URL gate: https only, to a listed host, no user info; an http or
//       off-list URL keeps the transport off and requests nothing
//   §3  outcomes: 2xx SENT; 401 drops the token and tries once more, then
//       AUTH_FAILED; 429 with Retry-After (capped at an hour); 408 and 5xx
//       CHR_UNAVAILABLE; any other 4xx REJECTED; CHR's codes only from the closed
//       table (empty: OTHER); a bad token answer
//   §4  outbound safety: a redirect is never followed; an oversized answer is cut
//       (declared or streamed); a slow answer times out; a reset socket is NETWORK
//   §5  H1's canary: in 2xx, 4xx and 5xx bodies, a token-error body, a response
//       header, a redirect URL and a socket reset, it reaches no result; through
//       the sweep, no row, state, audit, notice or log line; a configured carrier
//       code reaches only the request the fake receives
//   §6  the token lives in memory only: never in a result, reused until it ages,
//       fetched fresh by a connection test, which sends no load data
//   §7  the source: one fetch (the global one), no other network module, no
//       environment, an empty host list and code table as shipped
//   §8  mutants: a transport that keeps a body, follows a redirect, takes an
//       off-list host, or skips the size cap fails its check
//
// Made-up data only. No network beyond the loopback listener.
//   node scripts/test-chr-transport.js      # exits 1 on any failure
"use strict";

const fs = require("fs");
const path = require("path");
const { createRequire } = require("module");
const Database = require("better-sqlite3");

const ROOT = path.join(__dirname, "..");
const TRANSPORT_FILE = path.join(ROOT, "lib", "chr-transport.js");
const TRANSPORT_SRC = fs.existsSync(TRANSPORT_FILE) ? fs.readFileSync(TRANSPORT_FILE, "utf8") : "";
const libRequire = createRequire(TRANSPORT_FILE);
const fakeChr = require(path.join(__dirname, "e2e", "fake-chr.cjs"));

let pass = 0;
const failures = [];
const make = () => ({ pass: 0, failures: [] });
let C = { pass: 0, failures };
function eq(actual, expected, label) {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) { C.pass++; return; }
	C.failures.push(`${label}\n      expected ${e}\n      actual   ${a}`);
}
function ok(cond, label) { eq(Boolean(cond), true, label); }
function section(t) { console.log(`\n${t}`); }

function loadTransport(text) {
	const mod = { exports: {} };
	new Function("require", "module", "exports", text)(libRequire, mod, mod.exports);
	return mod.exports;
}

const CANARY = "canary-chr-text-7731";
const CARRIER = "made-up-carrier-0042";
const MADE_UP_PAYLOAD = Object.freeze({ loadNumber: "123456789", event: "departed_pickup", stop: { kind: "pickup", index: 1 }, eventAt: "2026-11-02T15:01:00Z" });

async function withFake(fn) {
	const fake = await fakeChr.startFakeChr();
	try { return await fn(fake); } finally { await fake.close(); }
}

async function checkShipped(t, Tr) {
	const prev = C;
	C = t;
	try {
		eq([Tr.CHR_HOSTS, Tr.CHR_CODES], [[], []], "§1 as shipped: no CHR host and no CHR code (PR 3-wire copies them from CHR's docs)");
		let calls = 0;
		const spy = async () => { calls++; throw new Error("no request may start"); };
		const full = { baseUrl: "https://chr.example.test", tokenUrl: "https://chr.example.test/made-up/token", clientId: "made-up-client-0001", clientSecret: "made-up-secret-0001", carrierCode: CARRIER };
		const shipped = Tr.createTransport({ connection: full, fetchImpl: spy });
		eq([shipped.configured(), shipped.ready()], [true, false], "§1 fully configured, yet not ready: no host and no wire");
		eq((await shipped.send(MADE_UP_PAYLOAD)).resultCode, "NOT_CONFIGURED", "§1 send(): NOT_CONFIGURED");
		eq((await shipped.testConnection()).resultCode, "NOT_CONFIGURED", "§1 testConnection(): NOT_CONFIGURED");
		const withHostNoWire = Tr.createTransport({ connection: full, hosts: [fakeChr.FAKE_HOST], fetchImpl: spy });
		eq(withHostNoWire.ready(), false, "§1 a host alone is not enough: no wire, not ready");
		eq(calls, 0, "§1 ...and nothing was requested");
	} finally {
		C = prev;
	}
}

async function checkUrlGate(t, Tr) {
	const prev = C;
	C = t;
	try {
		const h = [fakeChr.FAKE_HOST];
		eq([
			Tr.hostAllowed("https://chr.example.test/x", h), Tr.hostAllowed("http://chr.example.test/x", h), Tr.hostAllowed("https://other.example.test/x", h),
			Tr.hostAllowed("https://made-up:pw@chr.example.test/x", h), Tr.hostAllowed("https://CHR.EXAMPLE.TEST/x", h), Tr.hostAllowed("not a url", h),
			Tr.hostAllowed("https://chr.example.test.evil.test/x", h),
		], [true, false, false, false, true, false, false], "§2 hostAllowed(): https to a listed host only, no user info, the exact name");
		await withFake(async (fake) => {
			for (const [label, conn] of [
				["an http base URL", { ...fake.connection, baseUrl: "http://chr.example.test" }],
				["an off-list token URL", { ...fake.connection, tokenUrl: "https://other.example.test/made-up/token" }],
				["no client secret", { ...fake.connection, clientSecret: "" }],
			]) {
				const tr = Tr.createTransport({ connection: conn, hosts: h, wire: fakeChr.MADE_UP_WIRE, fetchImpl: fake.fetch });
				eq([tr.ready(), (await tr.send(MADE_UP_PAYLOAD)).resultCode], [false, "NOT_CONFIGURED"], `§2 ${label}: not ready, NOT_CONFIGURED`);
			}
			eq(fake.requests.length, 0, "§2 ...and the fake received nothing");
		});
	} finally {
		C = prev;
	}
}

const live = (Tr, fake, over = {}) => Tr.createTransport({ connection: fake.connection, hosts: [fakeChr.FAKE_HOST], wire: fakeChr.MADE_UP_WIRE, fetchImpl: fake.fetch, ...over });
const brief = (r) => [r.resultCode, r.httpStatus, r.chrCode, r.retryAfterS];

async function checkOutcomes(t, Tr) {
	const prev = C;
	C = t;
	try {
		await withFake(async (fake) => {
			const tr = live(Tr, fake);
			eq(tr.ready(), true, "§3 the fake's made-up host on the list, a wire: ready");
			fake.script("update", [
				{ status: 200, body: { ok: true } }, { status: 500 }, { status: 503 }, { status: 408 }, { status: 429, headers: { "retry-after": "120" } },
				{ status: 429, headers: { "retry-after": "99999" } }, { status: 400, body: { code: "MADE_UP_CODE" } }, { status: 404 }, { status: 422, body: "plain text" },
			]);
			const got = [];
			for (let i = 0; i < 9; i++) got.push(brief(await tr.send(MADE_UP_PAYLOAD)));
			eq(got, [
				["SENT", 200, "", null], ["CHR_UNAVAILABLE", 500, "", null], ["CHR_UNAVAILABLE", 503, "", null], ["CHR_UNAVAILABLE", 408, "", null],
				["RATE_LIMITED", 429, "", 120], ["RATE_LIMITED", 429, "", 3600], ["REJECTED", 400, "OTHER", null], ["REJECTED", 404, "", null], ["REJECTED", 422, "", null],
			], "§3 2xx, 5xx, 408, 429 (Retry-After kept, capped at an hour), other 4xx; a code not in CHR's closed table is OTHER");
			eq(fake.requests.filter((r) => r.kind === "token").length, 1, "§3 one token for all nine");
			const at = new Date(Date.now() + 90 * 1000).toUTCString();
			fake.script("update", [{ status: 429, headers: { "retry-after": at } }]);
			const r = await tr.send(MADE_UP_PAYLOAD);
			ok(r.retryAfterS >= 85 && r.retryAfterS <= 91, `§3 Retry-After as an HTTP date: about 90 s (${r.retryAfterS})`);
		});
		await withFake(async (fake) => {
			const tr = live(Tr, fake);
			fake.script("update", [{ status: 401 }, { status: 200, body: { ok: true } }]);
			eq(brief(await tr.send(MADE_UP_PAYLOAD)), ["SENT", 200, "", null], "§3 a 401: the token dropped, a new one fetched, one more try: SENT");
			eq(fake.requests.map((x) => x.kind), ["token", "update", "token", "update"], "§3 ...two tokens, two tries");
			const auth = fake.requests.filter((x) => x.kind === "update").map((x) => x.headers.authorization);
			eq(auth, ["Bearer made-up-token-1", "Bearer made-up-token-2"], "§3 ...the second try with the new token");
			fake.script("update", [{ status: 401 }, { status: 401 }]);
			eq(brief(await tr.send(MADE_UP_PAYLOAD)), ["AUTH_FAILED", 401, "", null], "§3 a 401 again: AUTH_FAILED (the sender pauses)");
			fake.script("update", [{ status: 403 }]);
			eq((await tr.send(MADE_UP_PAYLOAD)).resultCode, "AUTH_FAILED", "§3 a 403: AUTH_FAILED, no retry");
		});
		await withFake(async (fake) => {
			const tr = live(Tr, fake);
			fake.script("token", [{ status: 401, body: { error: "made-up" } }]);
			eq(brief(await tr.send(MADE_UP_PAYLOAD)), ["AUTH_FAILED", 401, "", null], "§3 the token endpoint's 401: AUTH_FAILED");
			fake.script("token", [{ status: 200, body: { nothing: true } }]);
			eq(brief(await tr.send(MADE_UP_PAYLOAD)), ["BAD_RESPONSE", 200, "", null], "§3 a token answer without a token: BAD_RESPONSE");
			eq(fake.requests.filter((x) => x.kind === "update").length, 0, "§3 ...and no update went without a token");
		});
	} finally {
		C = prev;
	}
}

async function checkSafety(t, Tr) {
	const prev = C;
	C = t;
	try {
		await withFake(async (fake) => {
			const tr = live(Tr, fake, { timeoutMs: 300 });
			fake.script("update", [{ status: 307, redirectTo: fakeChr.PATHS.elsewhere }, { status: 302, redirectTo: fakeChr.PATHS.elsewhere }]);
			eq([(await tr.send(MADE_UP_PAYLOAD)).resultCode, (await tr.send(MADE_UP_PAYLOAD)).resultCode], ["REDIRECT_REFUSED", "REDIRECT_REFUSED"], "§4 a 307 and a 302: REDIRECT_REFUSED");
			eq(fake.requests.filter((x) => x.kind === "elsewhere").length, 0, "§4 ...and the redirect's target was never asked");
			fake.script("update", [{ status: 200, bytes: Tr.MAX_BYTES + 10 }]);
			eq((await tr.send(MADE_UP_PAYLOAD)).resultCode, "TOO_LARGE", "§4 an answer past the cap: TOO_LARGE");
			fake.script("update", [{ status: 200, bytes: Tr.MAX_BYTES + 10, headers: { "transfer-encoding": "chunked" } }]);
			eq((await tr.send(MADE_UP_PAYLOAD)).resultCode, "TOO_LARGE", "§4 ...streamed with no length: TOO_LARGE");
			fake.script("update", [{ status: 200, delayMs: 1200, body: { ok: true } }]);
			eq((await tr.send(MADE_UP_PAYLOAD)).resultCode, "TIMEOUT", "§4 a slow answer: TIMEOUT");
			fake.script("update", [{ destroy: true }]);
			eq((await tr.send(MADE_UP_PAYLOAD)).resultCode, "NETWORK", "§4 a reset socket: NETWORK");
			ok(Tr.RETRYABLE.includes("TIMEOUT") && Tr.RETRYABLE.includes("NETWORK") && !Tr.RETRYABLE.includes("REDIRECT_REFUSED") && !Tr.RETRYABLE.includes("TOO_LARGE"),
				"§4 timeouts and network errors are tried again; a redirect or an oversized answer is not");
		});
	} finally {
		C = prev;
	}
}

async function checkCanary(t, Tr) {
	const prev = C;
	C = t;
	try {
		const results = [];
		await withFake(async (fake) => {
			const tr = live(Tr, fake, { connection: { ...fake.connection, carrierCode: CARRIER } });
			fake.script("update", [
				{ status: 200, body: { ok: true, note: CANARY, code: CANARY } },
				{ status: 400, body: { error: CANARY, code: CANARY } },
				{ status: 502, body: `${CANARY} upstream` },
				{ status: 200, headers: { "x-made-up": CANARY }, body: { ok: true } },
				{ status: 307, redirectTo: `/made-up/elsewhere?${CANARY}` },
				{ destroy: true },
			]);
			for (let i = 0; i < 6; i++) results.push(await tr.send(MADE_UP_PAYLOAD));
			const tr2 = live(Tr, fake);
			fake.script("token", [{ status: 400, body: { error: CANARY } }]);
			results.push(await tr2.send(MADE_UP_PAYLOAD));
			eq(JSON.stringify(results).includes(CANARY), false, "§5 the canary in 2xx, 4xx and 5xx bodies, a header, a redirect URL, a reset and a token error: in no result");
			eq(results.every((r) => JSON.stringify(Object.keys(r)) === JSON.stringify(["httpStatus", "resultCode", "chrCode", "retryAfterS", "remoteRef"])), true,
				"§5 ...each result exactly the allowlisted fields");
			eq(JSON.stringify(results).includes(CARRIER), false, "§5 the configured carrier code: in no result");
			const sentTo = fake.requests.filter((x) => x.kind === "update").map((x) => x.body).join("\n");
			ok(sentTo.includes(CARRIER), "§5 ...only in the request the fake received (where the made-up wire puts it)");
		});
		// Through the sweep: a canary answer leaves no trace in the database, the audit or the log.
		await withFake(async (fake) => {
			const W = require(path.join(ROOT, "lib", "chr-sweep.js"));
			const S = require(path.join(ROOT, "lib", "chr-store.js"));
			const I = require(path.join(ROOT, "lib", "chr-integration.js"));
			const db = new Database(":memory:");
			db.exec(`CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT '', updated_by TEXT NOT NULL DEFAULT '');
				CREATE TABLE server_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT '');
				CREATE TABLE load_status_history (id INTEGER PRIMARY KEY AUTOINCREMENT, load_id TEXT NOT NULL, old_status TEXT DEFAULT '', new_status TEXT NOT NULL, source TEXT DEFAULT 'manual', actor TEXT DEFAULT '', changed_at TEXT, reason TEXT DEFAULT '');`);
			S.ensureSchema(db);
			const clock = Date.parse("2026-11-02T15:00:00Z");
			const config = I.chrConfig({ updatesEnabled: true, sendEnabled: true, liveAllEnabled: true, connection: { ...fake.connection, carrierCode: CARRIER } });
			S.writeSettings(db, { ...S.DEFAULT_SETTINGS, milestones: "live" }, { by: "made_up_admin", nowIso: new Date(clock).toISOString() });
			S.writeState(db, { ...S.readState(db), lastMode: "live", lastTickAt: new Date(clock).toISOString(), firstEnabledAt: "2026-11-01T00:00:00.000Z", sendOnAt: new Date(clock).toISOString() }, new Date(clock).toISOString());
			const payload = JSON.stringify(MADE_UP_PAYLOAD);
			const ins = db.prepare(`INSERT INTO chr_events (load_id, kind, event, stop_kind, stop_index, event_at, verify, idem_key, payload_json, mode, status, next_attempt_at, created_at, updated_at)
				VALUES ('123456789', 'milestone', 'departed_pickup', 'pickup', 1, ?, 'confirmed', ?, ?, 'live', 'pending', ?, ?, ?)`);
			const iso = new Date(clock).toISOString();
			for (let i = 0; i < 4; i++) ins.run(iso, `ms|123456789|departed_pickup|p1|h${i + 1}`, payload, iso, iso, iso);
			fake.script("update", [{ status: 400, body: { error: CANARY } }, { status: 500, body: CANARY }, { status: 200, headers: { "x-made-up": CANARY }, body: { note: CANARY } }, { destroy: true }]);
			const audits = [];
			const logs = [];
			const notices = [];
			const transport = Tr.createTransport({ connection: { ...fake.connection, carrierCode: CARRIER }, hosts: [fakeChr.FAKE_HOST], wire: fakeChr.MADE_UP_WIRE, fetchImpl: fake.fetch });
			const sweep = W.createSweep({
				db, config, transport, now: () => clock,
				readSheet: async () => new Map([["123456789", { loadKey: "123456789", loadId: "123456789", brokerDomain: "chrobinson.com", trailer: "", pickupAddress: "", dropoffAddress: "", driverName: "Made Up Driver" }]]),
				stopPointsFor: () => null, truckResolver: () => ({ forDriverAt: () => null }), deviceResolver: () => ({ vehicleForTruckAt: () => "" }),
				logAudit: (a, action, e, id, details) => audits.push({ action, details }), notify: (n) => notices.push(n),
				log: { info: (...a) => logs.push(a.join(" ")), warn: (...a) => logs.push(a.join(" ")), error: (...a) => logs.push(a.join(" ")) },
			});
			await sweep.tick();
			const rows = db.prepare("SELECT * FROM chr_events").all();
			const dump = [JSON.stringify(rows), ...db.prepare("SELECT value FROM server_state").all().map((r) => r.value), JSON.stringify(audits), JSON.stringify(notices), ...logs].join("\n");
			eq(rows.map((r) => r.status), ["failed", "pending", "sent", "pending"], "§5 the sweep ran the four answers (refused, unavailable, sent, reset)");
			eq([dump.includes(CANARY), dump.includes(CARRIER)], [false, false], "§5 ...and neither the canary nor the carrier code is in a row, the state, an audit row, a notice or a log line");
		});
	} finally {
		C = prev;
	}
}

async function checkToken(t, Tr) {
	const prev = C;
	C = t;
	try {
		await withFake(async (fake) => {
			let clock = Date.parse("2026-11-02T15:00:00Z");
			const tr = live(Tr, fake, { now: () => clock });
			fake.script("token", [{ status: 200, body: { access_token: "made-up-token-aa", expires_in: 600 } }, { status: 200, body: { access_token: "made-up-token-bb", expires_in: 600 } }]);
			const r1 = await tr.send(MADE_UP_PAYLOAD);
			clock += 5 * 60 * 1000;
			await tr.send(MADE_UP_PAYLOAD);
			clock += 5 * 60 * 1000;
			await tr.send(MADE_UP_PAYLOAD);
			eq(fake.requests.map((x) => x.kind), ["token", "update", "update", "token", "update"], "§6 the token reused while it is fresh (a minute's margin), then fetched again");
			ok(!JSON.stringify(r1).includes("made-up-token"), "§6 no result holds the token");
			eq(Object.keys(tr), ["configured", "ready", "send", "testConnection", "dropToken"], "§6 the transport is five functions: no token, secret or connection field");
			const before = fake.requests.length;
			const tc = await tr.testConnection();
			eq([tc.resultCode, fake.requests.slice(before).map((x) => x.kind)], ["SENT", ["token"]], "§6 testConnection(): a fresh token only, no update and no load data");
		});
	} finally {
		C = prev;
	}
}

function checkSource(t) {
	const prev = C;
	C = t;
	try {
		const code = TRANSPORT_SRC.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
		eq((code.match(/\bfetch\s*\(/g) || []).length, 1, "§7 one fetch call in the file");
		ok(/globalThis\.fetch\(\.\.\.a\)/.test(code), "§7 ...the global fetch (a replica's network guard answers it), unless a runner hands one in");
		ok(!/require\(["'](?:https?|net|tls|dns|child_process|fs)["']\)/.test(code), "§7 no http, https, net, tls, dns, child_process or fs");
		ok(!/\bprocess\b/.test(code), "§7 no environment");
		ok(/redirect: "manual"/.test(code) && !/redirect: "follow"/.test(code), "§7 redirects come back as answers, never followed");
		ok(/const CHR_HOSTS = Object\.freeze\(\[\]\);/.test(code) && /const CHR_CODES = Object\.freeze\(\[\]\);/.test(code), "§7 the host list and the code table are empty as shipped");
	} finally {
		C = prev;
	}
}

async function main() {
	if (!TRANSPORT_SRC) {
		console.log("FAIL  lib/chr-transport.js does not exist: there is no CHR transport");
		process.exit(1);
	}
	const Tr = loadTransport(TRANSPORT_SRC);
	const R = { pass: 0, failures };
	section("§1  as shipped");
	await checkShipped(R, Tr);
	section("§2  the URL gate");
	await checkUrlGate(R, Tr);
	section("§3  outcomes");
	await checkOutcomes(R, Tr);
	section("§4  outbound safety");
	await checkSafety(R, Tr);
	section("§5  the canary");
	await checkCanary(R, Tr);
	section("§6  the token");
	await checkToken(R, Tr);
	section("§7  the source");
	checkSource(R);
	pass += R.pass;

	section("§8  mutants");
	const mutate = (from, to) => {
		if (!TRANSPORT_SRC.includes(from)) throw new Error(`mutant: lib/chr-transport.js has no ${JSON.stringify(from)}`);
		return loadTransport(TRANSPORT_SRC.replace(from, to));
	};
	const M = [
		["a result that keeps the body text", mutate("return result({ httpStatus: r.status >= 100 && r.status <= 599 ? r.status : null, resultCode: code,",
			"return result({ body: JSON.stringify(r.json), httpStatus: r.status >= 100 && r.status <= 599 ? r.status : null, resultCode: code,"), checkCanary],
		["a redirect followed", mutate("redirect: \"manual\", signal", "redirect: \"follow\", signal"), checkSafety],
		["any https host", mutate("&& hosts.includes(u.hostname.toLowerCase())", ""), checkUrlGate],
		["no size cap", mutate("if (size > maxBytes) {", "if (false) {"), checkSafety],
		["a CHR code kept whatever it is", mutate("(CHR_CODES.includes(raw) ? raw : \"OTHER\")", "raw"), checkOutcomes],
		["no second try after a 401", mutate("if (!r.failed && r.status === 401 && attempt === 0) { token = null; continue; }", ""), checkOutcomes],
		["a host on the shipped list", mutate("const CHR_HOSTS = Object.freeze([]);", "const CHR_HOSTS = Object.freeze([\"chr.example.test\"]);"), checkShipped],
	];
	for (const [label, mod, check] of M) {
		const t = make();
		let threw = null;
		try { await check(t, mod); } catch (err) { threw = err; }
		const caught = !threw && t.failures.length > 0;
		if (caught) { pass++; console.log(`  ${label}: ${t.failures[0].split("\n")[0]}`); } else failures.push(`§8 caught: ${label}${threw ? ` (threw ${threw.message})` : ` (its check passed: ${t.pass})`}`);
	}
}

main().then(() => {
	console.log(`\n${"=".repeat(64)}`);
	if (failures.length) {
		console.log(`FAILURES (${failures.length}):`);
		failures.forEach((f) => console.log(`  ✗ ${f}`));
		console.log(`\n${pass} passed, ${failures.length} failed`);
		process.exit(1);
	}
	console.log(`✓ ${pass} assertions passed`);
	process.exit(0);
}).catch((err) => {
	console.error(err);
	process.exit(1);
});
