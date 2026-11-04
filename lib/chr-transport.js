"use strict";
// The one way a C.H. Robinson request could leave LogisX. It is built before
// CHR's documents exist: its host list is empty and it has no wire format (how a
// token is asked for, where an update goes, what CHR's error codes are), so it
// is never ready and sends nothing. PR 3-wire fills both from CHR's docs, after
// a plan revision and Arvin's go-ahead.
//
// What it enforces whatever the wire turns out to be: https only, to a host on
// the fixed list; a redirect is never followed; a timeout; a response-size cap;
// the token in memory only, never stored, returned or logged. From any answer it
// keeps only the allowlisted result: the HTTP status, LogisX's own result code
// (chosen from the status and the kind of failure, never from CHR's text), a
// code from CHR's closed table (none yet: anything else is OTHER) and a
// Retry-After capped at an hour. No body text, header, URL, error message or
// stack is kept.

// CHR's hosts and error codes, copied from CHR's docs in PR 3-wire.
const CHR_HOSTS = Object.freeze([]);
const CHR_CODES = Object.freeze([]);
const RESULT_CODES = Object.freeze([
	"SENT", "DUPLICATE", "AUTH_FAILED", "RATE_LIMITED", "CHR_UNAVAILABLE", "TIMEOUT", "NETWORK", "REDIRECT_REFUSED", "TOO_LARGE", "REJECTED",
	"BAD_RESPONSE", "NOT_CONFIGURED",
]);
// Tried again with backoff; everything else but SENT is final until a person acts.
const RETRYABLE = Object.freeze(["RATE_LIMITED", "CHR_UNAVAILABLE", "TIMEOUT", "NETWORK"]);
const TIMEOUT_MS = 15 * 1000;
const MAX_BYTES = 64 * 1024;
const RETRY_AFTER_MAX_S = 3600;
const TOKEN_MARGIN_MS = 60 * 1000;
const CONNECTION_FIELDS = Object.freeze(["baseUrl", "tokenUrl", "clientId", "clientSecret", "carrierCode"]);

function hostAllowed(url, hosts) {
	let u;
	try { u = new URL(String(url || "")); } catch { return false; }
	return u.protocol === "https:" && !u.username && !u.password && hosts.includes(u.hostname.toLowerCase());
}

// LogisX's own result code from the status alone.
function classifyStatus(status) {
	if (status >= 200 && status < 300) return "SENT";
	if (status >= 300 && status < 400) return "REDIRECT_REFUSED";
	if (status === 401 || status === 403) return "AUTH_FAILED";
	if (status === 429) return "RATE_LIMITED";
	if (status === 408 || (status >= 500 && status < 600)) return "CHR_UNAVAILABLE";
	if (status >= 400 && status < 500) return "REJECTED";
	return "BAD_RESPONSE";
}

// Retry-After as whole seconds, 0 to an hour, or null: a number of seconds or
// an HTTP date, nothing else.
function retryAfterSeconds(value, nowMs) {
	const v = String(value == null ? "" : value).trim().slice(0, 64);
	if (!v) return null;
	if (/^\d{1,10}$/.test(v)) return Math.min(Number(v), RETRY_AFTER_MAX_S);
	const at = Date.parse(v);
	if (!Number.isFinite(at)) return null;
	return Math.max(0, Math.min(Math.ceil((at - nowMs) / 1000), RETRY_AFTER_MAX_S));
}

// The kind of a failed fetch, by its type and name, never by its message.
function failureKind(err) {
	if (err && (err.name === "AbortError" || err.name === "TimeoutError")) return "TIMEOUT";
	if (err && err.code === "CHR_TOO_LARGE") return "TOO_LARGE";
	return "NETWORK";
}

// wire (PR 3-wire): { tokenRequest(connection), tokenFrom(json),
// updateRequest({ payload, reference, token, connection }), codeFrom(json),
// remoteRefFrom(json) }, each request being { url, init }. Without it nothing
// is ever ready. fetchImpl is for runners only; the app always uses the global
// fetch, which a replica's network guard answers.
function createTransport({ connection = {}, hosts = CHR_HOSTS, wire = null, fetchImpl = null, timeoutMs = TIMEOUT_MS, maxBytes = MAX_BYTES, now = () => Date.now() } = {}) {
	const conn = {};
	for (const k of CONNECTION_FIELDS) conn[k] = typeof connection[k] === "string" ? connection[k].trim() : "";
	const allow = Object.freeze((Array.isArray(hosts) ? hosts : []).map((h) => String(h).toLowerCase()));
	const doFetch = typeof fetchImpl === "function" ? fetchImpl : (...a) => globalThis.fetch(...a);
	let token = null;

	const configured = () => Boolean(conn.baseUrl && conn.tokenUrl && conn.clientId && conn.clientSecret);
	const ready = () => configured() && wire !== null && hostAllowed(conn.baseUrl, allow) && hostAllowed(conn.tokenUrl, allow);

	// One request: { status, retryAfterS, json } or { failed: code }. The body is
	// read up to the cap and parsed for the wire's own use; it is never returned
	// to a caller of this module, stored or logged.
	async function outbound(req) {
		if (!req || !hostAllowed(req.url, allow)) return { failed: "NOT_CONFIGURED" };
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), timeoutMs);
		try {
			// "manual": a redirect comes back as its 3xx answer and is refused by
			// its status, never followed.
			const res = await doFetch(req.url, { ...(req.init || {}), redirect: "manual", signal: ctrl.signal });
			const declared = Number(res.headers.get("content-length"));
			if (Number.isFinite(declared) && declared > maxBytes) {
				try { await res.body.cancel(); } catch { /* nothing to keep */ }
				return { failed: "TOO_LARGE", status: res.status };
			}
			const chunks = [];
			let size = 0;
			if (res.body) {
				const reader = res.body.getReader();
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					size += value.byteLength;
					if (size > maxBytes) {
						try { await reader.cancel(); } catch { /* nothing to keep */ }
						return { failed: "TOO_LARGE", status: res.status };
					}
					chunks.push(value);
				}
			}
			let json = null;
			try { json = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { json = null; }
			return { status: res.status, retryAfterS: retryAfterSeconds(res.headers.get("retry-after"), now()), json };
		} catch (err) {
			return { failed: failureKind(err) };
		} finally {
			clearTimeout(timer);
		}
	}

	const result = (fields) => ({ httpStatus: null, resultCode: "BAD_RESPONSE", chrCode: "", retryAfterS: null, remoteRef: "", ...fields });

	// The allowlisted result of one answer.
	function resultOf(r) {
		if (r.failed) return result({ httpStatus: Number.isInteger(r.status) ? r.status : null, resultCode: r.failed });
		const code = classifyStatus(r.status);
		const raw = wire && typeof wire.codeFrom === "function" && r.json ? wire.codeFrom(r.json) : "";
		const chrCode = raw ? (CHR_CODES.includes(raw) ? raw : "OTHER") : "";
		const ref = code === "SENT" && wire && typeof wire.remoteRefFrom === "function" && r.json ? wire.remoteRefFrom(r.json) : "";
		return result({ httpStatus: r.status >= 100 && r.status <= 599 ? r.status : null, resultCode: code, chrCode, retryAfterS: r.retryAfterS, remoteRef: typeof ref === "string" ? ref : "" });
	}

	async function freshToken() {
		const r = await outbound(wire.tokenRequest(conn));
		if (r.failed || r.status < 200 || r.status >= 300) return { error: resultOf(r) };
		const t = r.json ? wire.tokenFrom(r.json) : null;
		if (!t || typeof t.value !== "string" || !t.value) return { error: result({ httpStatus: r.status, resultCode: "BAD_RESPONSE" }) };
		const life = Number.isFinite(t.expiresInS) && t.expiresInS > 0 ? t.expiresInS * 1000 : 0;
		token = { value: t.value, expiresAtMs: now() + Math.max(0, life - TOKEN_MARGIN_MS) };
		return { token: token.value };
	}

	async function currentToken() {
		if (token && token.expiresAtMs > now()) return { token: token.value };
		return freshToken();
	}

	// One update: a 401 drops the token and tries once more with a new one.
	async function send(payload, { reference = "" } = {}) {
		if (!ready()) return result({ resultCode: "NOT_CONFIGURED" });
		for (let attempt = 0; attempt < 2; attempt++) {
			const t = await currentToken();
			if (t.error) return t.error;
			const r = await outbound(wire.updateRequest({ payload, reference, token: t.token, connection: conn }));
			if (!r.failed && r.status === 401 && attempt === 0) { token = null; continue; }
			return resultOf(r);
		}
		return result({ resultCode: "AUTH_FAILED", httpStatus: 401 });
	}

	// A token only: no load data leaves.
	async function testConnection() {
		if (!ready()) return result({ resultCode: "NOT_CONFIGURED" });
		token = null;
		const t = await freshToken();
		return t.error || result({ resultCode: "SENT", httpStatus: 200 });
	}

	return Object.freeze({
		configured,
		ready,
		send,
		testConnection,
		dropToken: () => { token = null; },
	});
}

module.exports = {
	CHR_HOSTS,
	CHR_CODES,
	RESULT_CODES,
	RETRYABLE,
	TIMEOUT_MS,
	MAX_BYTES,
	RETRY_AFTER_MAX_S,
	CONNECTION_FIELDS,
	hostAllowed,
	classifyStatus,
	retryAfterSeconds,
	failureKind,
	createTransport,
};
