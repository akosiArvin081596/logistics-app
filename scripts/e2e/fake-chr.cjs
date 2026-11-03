// A fake C.H. Robinson for the runners (and, once PR 3-wire gives the transport
// CHR's real wire format, the browser harness): an HTTP server on 127.0.0.1 that
// answers a made-up token endpoint and a made-up update endpoint from scripted
// answers, and records every request it gets. Nothing here knows CHR's real API:
// MADE_UP_WIRE is a stand-in shaped like lib/chr-transport.js's wire, used only
// by runners until CHR's docs arrive.
//
//   const fake = await startFakeChr()
//   fake.script("update", [{ status: 500 }, { status: 200, body: { ok: true } }])
//   createTransport({ connection: fake.connection, hosts: [FAKE_HOST], wire: MADE_UP_WIRE, fetchImpl: fake.fetch })
//
// fake.fetch maps https://chr.example.test/<path> to the local server and passes
// every option through (redirect, signal), so the transport's own https and
// host checks run as written and the real fetch does the rest. An answer:
// { status, body (object or string), headers, delayMs, bytes (a body of that
// many bytes), redirectTo (a Location on the same fake), destroy (reset the
// socket) }. Made-up values only.
"use strict";

const http = require("http");

const FAKE_HOST = "chr.example.test";
const FAKE_ORIGIN = `https://${FAKE_HOST}`;
const PATHS = Object.freeze({ token: "/made-up/token", update: "/made-up/updates", elsewhere: "/made-up/elsewhere" });

const MADE_UP_WIRE = Object.freeze({
	tokenRequest: (c) => ({
		url: c.tokenUrl,
		init: {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ grant_type: "client_credentials", client_id: c.clientId, client_secret: c.clientSecret }).toString(),
		},
	}),
	tokenFrom: (json) => (json && typeof json.access_token === "string" ? { value: json.access_token, expiresInS: Number(json.expires_in) } : null),
	updateRequest: ({ payload, reference, token, connection }) => ({
		url: `${connection.baseUrl}${PATHS.update}`,
		init: {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
			body: JSON.stringify({ ...payload, reference, ...(connection.carrierCode ? { carrier: connection.carrierCode } : {}) }),
		},
	}),
	codeFrom: (json) => (json && typeof json.code === "string" ? json.code : ""),
	remoteRefFrom: () => "",
});

function startFakeChr() {
	const queues = { token: [], update: [] };
	const fallback = { token: { status: 200, body: { access_token: "made-up-token-1", expires_in: 3600 } }, update: { status: 200, body: { ok: true } } };
	const requests = [];
	let tokenCount = 0;
	const server = http.createServer((req, res) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			const kind = req.url === PATHS.token ? "token" : req.url === PATHS.update ? "update" : req.url === PATHS.elsewhere ? "elsewhere" : "other";
			requests.push({ kind, method: req.method, url: req.url, headers: { ...req.headers }, body: Buffer.concat(chunks).toString("utf8") });
			if (kind === "elsewhere" || kind === "other") { res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); return; }
			const a = queues[kind].length ? queues[kind].shift() : (kind === "token" ? { ...fallback.token, body: { access_token: `made-up-token-${++tokenCount}`, expires_in: 3600 } } : fallback.update);
			const answer = () => {
				if (a.destroy) { req.socket.destroy(); return; }
				const headers = { ...(a.headers || {}) };
				if (a.redirectTo) headers.location = `${FAKE_ORIGIN}${a.redirectTo}`;
				let body = "";
				if (a.bytes) body = "x".repeat(a.bytes);
				else if (typeof a.body === "string") body = a.body;
				else if (a.body !== undefined) { body = JSON.stringify(a.body); headers["content-type"] = headers["content-type"] || "application/json"; }
				res.writeHead(a.status || 200, headers);
				res.end(body);
			};
			if (a.delayMs) setTimeout(answer, a.delayMs); else answer();
		});
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const local = `http://127.0.0.1:${server.address().port}`;
			const fake = {
				requests,
				connection: { baseUrl: FAKE_ORIGIN, tokenUrl: `${FAKE_ORIGIN}${PATHS.token}`, clientId: "made-up-client-0001", clientSecret: "made-up-secret-0001" },
				script(kind, answers) { queues[kind] = answers.slice(); },
				// The made-up host to the local server; anything else is refused here, so
				// a request to another host can never leave the machine.
				fetch(url, init) {
					const u = new URL(String(url));
					if (u.hostname !== FAKE_HOST) return Promise.reject(new TypeError("fake-chr: not the made-up host"));
					return globalThis.fetch(`${local}${u.pathname}${u.search}`, init);
				},
				close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }),
			};
			resolve(fake);
		});
	});
}

module.exports = { FAKE_HOST, FAKE_ORIGIN, PATHS, MADE_UP_WIRE, startFakeChr };
