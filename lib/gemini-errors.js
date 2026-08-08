// Shared classification of a failed Gemini generateContent call.
//
// One question, one answer, for every Gemini call site: "is this failure the
// same thing as not having a key at all?" The app already ships every AI
// feature dormant when GEMINI_API_KEY is unset — the route answers 503, the
// UI hides the panel, and the rest of the page works. An upstream rejection
// is that same state arriving at runtime, so it has to degrade the same way.
// What it must NOT do is disguise a bug of OURS as "AI unavailable", which is
// why this returns three verdicts and not a boolean.
//
//   'unavailable'  the credential or the quota is the problem. Nothing the
//                  caller sent would have worked, and nothing they can do
//                  fixes it. Route answers 503 exactly as it does for a
//                  missing key.
//   'defect'       WE built a bad request (malformed body, a model name that
//                  doesn't exist, a payload over the limit). Stays loud —
//                  route answers 502 and logs — because it is a bug to fix,
//                  not a service to wait out.
//   'transient'    upstream 5xx / network / timeout. Worth retrying, then 502.
//
// ⚠️ STATUS CODE ALONE IS NOT ENOUGH, and this is the whole reason the module
// exists. Measured against the live API on 2026-08-08:
//
//   revoked / wrong key   -> HTTP 400 INVALID_ARGUMENT, reason API_KEY_INVALID
//   IP-restricted key     -> HTTP 403 PERMISSION_DENIED, reason
//                            API_KEY_IP_ADDRESS_BLOCKED
//
// So a dead key comes back as a **400**, sharing a status code with "the JSON
// you sent is malformed". Bucketing all 400s as our defect leaves the single
// most likely production failure (the key was rotated, revoked, or ran out of
// credits — it has happened here already) surfacing as a 502 the UI cannot
// degrade from. Bucketing all 400s as "unavailable" would hide real bugs. The
// discriminator is google.rpc.ErrorInfo.reason in the response body, so the
// body has to be read, not just the status line.

// google.rpc.ErrorInfo `reason` values that mean "this credential cannot call
// this API", whatever HTTP status Google chose to wrap them in. Matched as a
// set rather than a substring so a future reason has to be added deliberately.
const CREDENTIAL_REASONS = new Set([
	"API_KEY_INVALID",                 // revoked, deleted, or simply wrong
	"API_KEY_IP_ADDRESS_BLOCKED",      // key restricted to other IPs
	"API_KEY_HTTP_REFERRER_BLOCKED",
	"API_KEY_ANDROID_APP_BLOCKED",
	"API_KEY_IOS_APP_BLOCKED",
	"API_KEY_SERVICE_BLOCKED",         // key not permitted to call this API
	"SERVICE_DISABLED",                // API not enabled on the project
	"BILLING_DISABLED",
	"ACCOUNT_STATE_INVALID",
	"CONSUMER_INVALID",
	"CONSUMER_SUSPENDED",
	"RATE_LIMIT_EXCEEDED",
	"RESOURCE_EXHAUSTED",
]);

// Statuses that will fail identically on a second attempt: a malformed request,
// a rejected key, a missing model, an oversized payload, an exhausted quota.
// Retrying these only makes the caller wait N times longer for the same answer
// — and on 429 it actively deepens the hole. Everything else (5xx, network,
// timeout) is worth another go. Kept exported so the per-feature adapters share
// one definition instead of each keeping a private copy.
const NON_RETRYABLE_STATUS = new Set([400, 401, 403, 404, 413, 429]);

// Pull every google.rpc.ErrorInfo `reason` out of an error body. Defensive:
// the body may be empty, HTML from a proxy, or truncated by the caller.
function reasonsFrom(bodyText) {
	if (!bodyText || typeof bodyText !== "string") return [];
	let parsed;
	try { parsed = JSON.parse(bodyText); } catch { return []; }
	const details = parsed && parsed.error && Array.isArray(parsed.error.details) ? parsed.error.details : [];
	return details.map((d) => d && d.reason).filter((r) => typeof r === "string");
}

// (status, bodyText) -> 'unavailable' | 'defect' | 'transient'
function classifyGeminiFailure(status, bodyText) {
	const reasons = reasonsFrom(bodyText);
	// A credential/quota reason is decisive whatever the status — that is the
	// 400-means-dead-key case above, and it keeps working if Google re-wraps
	// the same reason in a different code later.
	if (reasons.some((r) => CREDENTIAL_REASONS.has(r))) return "unavailable";
	// 401 UNAUTHENTICATED / 403 PERMISSION_DENIED / 429 RESOURCE_EXHAUSTED are
	// credential-or-quota by definition even when the body carries no ErrorInfo.
	if (status === 401 || status === 403 || status === 429) return "unavailable";
	// A request we assembled that Google refuses to parse, a model name we chose
	// that does not exist for this project, or a payload we let grow too large.
	// All three are ours to fix and must not read as "the AI is down".
	if (status === 400 || status === 404 || status === 413) return "defect";
	return "transient";
}

// Build the Error a Gemini adapter should throw for a non-OK response, carrying
// the classification so the route can branch without re-parsing anything.
//   .status  the HTTP status Google returned
//   .kind    'unavailable' | 'defect' | 'transient'
//   .reason  the first google.rpc ErrorInfo reason, '' when absent
// The message keeps a clipped slice of the upstream body: it is the only place
// Google's real explanation appears, and diagnosing 2026-08-05's outage turned
// on reading it.
function geminiFailure(status, bodyText) {
	const text = typeof bodyText === "string" ? bodyText : "";
	const err = new Error(`Gemini ${status}: ${text.slice(0, 200)}`);
	err.status = status;
	err.kind = classifyGeminiFailure(status, text);
	err.reason = reasonsFrom(text)[0] || "";
	return err;
}

module.exports = { classifyGeminiFailure, geminiFailure, NON_RETRYABLE_STATUS, CREDENTIAL_REASONS };
