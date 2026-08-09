#!/usr/bin/env node
/**
 * scripts/verify-n8n-behaviour.js — READ-ONLY assertions about the live
 * "Dispatch v2 (Fixed)" workflow (ydFgTSFpKTyyZbXW).
 *
 * WHY THIS EXISTS, AND WHY IT IS SMALLER THAN WHAT IT REPLACES
 *
 *   scripts/verify-all-patches.js (deleted in PR #220) asserted 10 things. Three
 *   of them described a workflow that no longer exists — LlamaParse's parse_mode,
 *   the "Retry Counter" that polled LlamaParse jobs, and the LlamaParse-era
 *   attachment plumbing — so it reported failures against a workflow that was
 *   CORRECT. A checker that cries wolf gets muted, and a muted checker is worse
 *   than none, so it was removed wholesale.
 *
 *   But four of its assertions covered behaviour that is still live, load-bearing,
 *   and had no automated verifier left. Those four are restored here, plus one
 *   invariant that cost a real load. Nothing in this file asserts anything about
 *   LlamaParse, its fallback chain, or nodes deleted with it.
 *
 *   The rule for adding to this file: assert behaviour that a past incident
 *   proved matters, in the most structural form available (prefer "the only edge
 *   into X is Y" over "edge A is absent" — the first survives new nodes, the
 *   second has to be extended every time someone adds a path).
 *
 * READ-ONLY IS STRUCTURAL, NOT A CONVENTION
 *   - `get()` is the only network call and hard-refuses any method but GET.
 *   - Nothing here builds a request body, so there is no PUT/PATCH to misfire.
 *   - NEVER add a credential call. `PATCH /credentials/:id` overwrites the
 *     credential immediately — it has broken rate-con ingestion twice (2026-08-05
 *     and 2026-08-06, Gemini key kzlHx6lePVcSV9B8, API_KEY_INVALID), and the
 *     downstream errors look like unrelated node failures. There is no read-only
 *     "test" verb for a credential; do not go looking for one.
 *
 * Usage:
 *   N8N_API_KEY=... node scripts/verify-n8n-behaviour.js [--strict] [--verbose]
 *   node scripts/verify-n8n-behaviour.js --fixture path/to/workflow.json
 *
 *   Load the key into the env var; never paste it on a command line that lands in
 *   shell history, and never commit it:
 *     export N8N_API_KEY=$(security find-generic-password -s n8n-api-key -w)
 *     export N8N_API_KEY=$(jq -r '.n8n.api_key' ~/Documents/Credentials/credentials.json)
 *
 *   --fixture reads a workflow JSON off disk instead of the API: no key, no
 *   network. That is how the checker's own red path is tested (a checker that has
 *   only ever been seen green is an untested checker), and it lets a workflow
 *   export be verified before anyone considers applying it.
 *
 * Exit 0 when no check FAILS. Advisories (see check 5) do not fail the run unless
 * --strict is passed.
 */

"use strict";

const N8N_BASE = process.env.N8N_BASE_URL || "https://sandhub.app.n8n.cloud";
const WORKFLOW_ID = process.env.N8N_WORKFLOW_ID || "ydFgTSFpKTyyZbXW";
const API_KEY = process.env.N8N_API_KEY;
const STRICT = process.argv.includes("--strict");
const VERBOSE = process.argv.includes("--verbose");
const FIXTURE = (() => {
	const i = process.argv.indexOf("--fixture");
	return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
})();

if (!API_KEY && !FIXTURE) {
	console.error("N8N_API_KEY env var required (or pass --fixture PATH). Load it (do not echo it):");
	console.error("  export N8N_API_KEY=$(security find-generic-password -s n8n-api-key -w)");
	console.error("  export N8N_API_KEY=$(jq -r '.n8n.api_key' ~/Documents/Credentials/credentials.json)");
	process.exit(1);
}

/** The ONLY network call. GET only — see the header note. */
async function get(path) {
	const method = "GET";
	if (method !== "GET") throw new Error("this script is read-only");
	const res = await fetch(`${N8N_BASE}/api/v1${path}`, { method, headers: { "X-N8N-API-KEY": API_KEY } });
	const text = await res.text();
	// n8n error bodies never contain the key, but slice anyway so a verbose
	// upstream error cannot dump anything large into a CI log.
	if (!res.ok) throw new Error(`GET ${path} -> ${res.status}\n${text.slice(0, 400)}`);
	return text ? JSON.parse(text) : {};
}

let failures = 0, advisories = 0, assertions = 0;
const ok = (m) => { assertions++; console.log("  [ok]   " + m); };
const bad = (m) => { assertions++; failures++; console.log("  [FAIL] " + m); };
const warn = (m) => { assertions++; advisories++; console.log("  [warn] " + m); };
const head = (m) => console.log("\n" + m);
const check = (cond, okMsg, failMsg) => (cond ? ok(okMsg) : bad(failMsg));

// --- code-node source analysis (check 5) -----------------------------------

function stripComments(src) {
	return String(src || "")
		.replace(/\/\*[\s\S]*?\*\//g, " ")
		.replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** Every `return <expr>;` in the source, as trimmed expression text. */
function returnExpressions(src) {
	return [...stripComments(src).matchAll(/\breturn\b([\s\S]*?);/g)].map((m) => m[1].trim()).filter(Boolean);
}

/**
 * Does the node walk its OWN input items, i.e. can its output length track its
 * input length? That is the property pairedItem exists to describe.
 *
 * Deliberately NOT "does it contain a loop": Pick Thread PDF loops over the
 * messages inside ONE Gmail thread and its private flattenParts() helper ends
 * in `return out`, neither of which has anything to do with n8n item tracing.
 * An earlier draft keyed on loops-and-accumulators and failed that node — a
 * textbook false alarm of exactly the kind that got the old checker deleted.
 */
const PER_ITEM_PATTERNS = [
	/\bitems\s*\[/,
	/\bitems\s*\.\s*length\b/,
	/\bitems\s*\.\s*(?:map|forEach|flatMap)\s*\(/,
	/\bfor\s*\(\s*(?:const|let|var)\s+[\w{}[\],\s]+\s+of\s+(?:items|\$input\.all\(\))/,
	/\$input\.all\(\)\s*\.\s*(?:map|forEach|flatMap)\s*\(/,
];
function walksOwnItems(code) {
	if (PER_ITEM_PATTERNS.some((re) => re.test(code))) return true;
	// $input.all() stashed in a variable and then iterated.
	return /\$input\.all\(\)/.test(code) && /\b(?:for|while)\s*\(|\.\s*(?:map|forEach|flatMap)\s*\(/.test(code);
}

/**
 * Classifies a Code node against the pairedItem invariant.
 *
 *   conforms   — sets pairedItem explicitly, or is a pure passthrough
 *                (`return $input.all()` / `return $('X').all()`), where the
 *                returned items already carry their own tracing.
 *   violation  — emits output derived from its own input items with no
 *                pairedItem. This is the shape that lost load 563593554, and
 *                the only tier that fails the run.
 *   advisory   — emits a fixed item set built from `.first()` or constants, so
 *                its output length does not track its input. Latent rather than
 *                live: it only misbehaves when reached with more than one input
 *                item, at which point it is independently buggy anyway (it drops
 *                the extras). Reported, never failed unless --strict.
 */
function classifyPairedItem(src) {
	const code = stripComments(src);
	if (/\bpairedItem\s*:/.test(code)) return "conforms";
	const rets = returnExpressions(code);
	if (!rets.length) return "conforms";                 // emits nothing of its own
	const passthrough = rets.every((r) => /^\$input\.all\(\)$/.test(r) || /^\$\([^)]*\)\.all\(\)$/.test(r));
	if (passthrough) return "conforms";
	return walksOwnItems(code) ? "violation" : "advisory";
}

// ---------------------------------------------------------------------------

(async () => {
	const wf = FIXTURE
		? JSON.parse(require("fs").readFileSync(FIXTURE, "utf8"))
		: await get(`/workflows/${WORKFLOW_ID}`);
	const nodes = wf.nodes || [];
	const conn = wf.connections || {};

	console.log(`n8n behavioural checks — "${wf.name}" (${WORKFLOW_ID})`);
	console.log(`  ${nodes.length} nodes · active=${wf.active} · ${FIXTURE ? `fixture ${FIXTURE}` : N8N_BASE}`);

	const find = (name) => nodes.find((n) => n.name === name);
	const branch = (from, i) => conn[from] && conn[from].main && conn[from].main[i];
	const edge = (from, i, to) => !!(branch(from, i) || []).some((e) => e.node === to);
	/** Every edge landing on `to`, as {from, branch}. Order-independent. */
	function inbound(to) {
		const out = [];
		for (const [from, c] of Object.entries(conn)) {
			(c.main || []).forEach((b, i) => (b || []).forEach((e) => { if (e.node === to) out.push({ from, branch: i }); }));
		}
		return out;
	}
	const assignmentsOf = (node) =>
		(node.parameters && (node.parameters.assignments && node.parameters.assignments.assignments)) ||
		(node.parameters && node.parameters.fields && node.parameters.fields.values) || [];
	const assignByName = (node, needle) =>
		assignmentsOf(node).find((a) => String(a.name || a.fieldName || "").includes(needle));

	// -----------------------------------------------------------------------
	// 1. "Addresses Ready?" guard — never hand a placeholder address to the
	//    distance step. Without it, a rate-con-less row ("Awaiting Rate Con")
	//    goes to the AI Agent and comes back with a fabricated distance and
	//    therefore a fabricated rate-per-mile.
	// -----------------------------------------------------------------------
	head("1. Addresses Ready? guard");
	const guard = find("Addresses Ready?");
	check(!!guard, '"Addresses Ready?" node present', '"Addresses Ready?" node MISSING');
	if (guard) {
		check(edge("JOB DETAILS ENTRY", 0, "Addresses Ready?"),
			"JOB DETAILS ENTRY[0] -> Addresses Ready?",
			"JOB DETAILS ENTRY success branch does NOT reach Addresses Ready? — the guard is bypassed");
		check(edge("Addresses Ready?", 0, "AI Agent"),
			"Addresses Ready?[true] -> AI Agent",
			"Addresses Ready? TRUE branch does NOT reach AI Agent");
		check(edge("Addresses Ready?", 1, "Update Job Tracking (Distance)"),
			"Addresses Ready?[false] -> Update Job Tracking (Distance) (skips the distance estimate)",
			"Addresses Ready? FALSE branch does NOT reach Update Job Tracking (Distance)");

		const conds = (guard.parameters.conditions && guard.parameters.conditions.conditions) || [];
		const lefts = conds.map((c) => String(c.leftValue || ""));
		check(lefts.some((l) => l.includes("Pickup Address")) && lefts.some((l) => l.includes("Drop-off Address")),
			"guard tests BOTH Pickup Address and Drop-off Address",
			"guard does not test both address fields (got: " + lefts.join(" | ").slice(0, 160) + ")");
		check(conds.some((c) => String(c.rightValue || "") === "Awaiting Rate Con"),
			'guard knows the "Awaiting Rate Con" sentinel',
			'guard no longer compares against "Awaiting Rate Con" — the sentinel Normalize Load Fields writes');
		check(((guard.parameters.conditions || {}).combinator || "and") === "and",
			"conditions combine with AND (every field must be real)",
			"conditions combine with OR — one good address would let a placeholder through");
	}

	// -----------------------------------------------------------------------
	// 2. Mark-Read completeness gate — an email is only marked read once the
	//    row is actually complete. Marking read early is unrecoverable: n8n's
	//    Gmail Trigger selects on unread + starred, so a prematurely-read email
	//    is never reprocessed and the load is simply gone.
	// -----------------------------------------------------------------------
	head("2. Mark-Read completeness gate");
	const gate = find("Critical Fields Complete?");
	check(!!gate, '"Critical Fields Complete?" node present', '"Critical Fields Complete?" node MISSING');
	if (gate) {
		const c0 = ((gate.parameters.conditions || {}).conditions || [])[0] || {};
		const left = String(c0.leftValue || "");
		check(left.includes("Normalize Load Fields") && /output(\.|\['?)Rate/.test(left),
			"gate reads Normalize Load Fields output.Rate",
			"gate no longer reads output.Rate (got: " + left.slice(0, 140) + ")");
		check(((c0.operator || {}).operation || "") === "notEmpty",
			"gate operator is notEmpty (an empty Rate does not pass)",
			"gate operator is '" + ((c0.operator || {}).operation || "none") + "', not notEmpty — a blank Rate would pass");
		check(edge("Update Job Tracking (Distance)", 0, "Critical Fields Complete?"),
			"Update Job Tracking (Distance)[0] -> Critical Fields Complete?",
			"Update Job Tracking (Distance) does NOT route through the gate");
		check(edge("Critical Fields Complete?", 0, "Mark Read (Processing)"),
			"Critical Fields Complete?[true] -> Mark Read (Processing)",
			"gate TRUE branch does NOT reach Mark Read (Processing)");
		check(edge("Critical Fields Complete?", 1, "Build Failure Context"),
			"Critical Fields Complete?[false] -> Build Failure Context (alerts instead of dropping)",
			"gate FALSE branch is dead — an incomplete row is silently discarded, which is the bug this gate exists for");

		// The structural form of "nothing marks the email read early". This
		// subsumes the old checker's two named forbidden edges (Google Drive ->
		// Mark Read, Extract from Email Body -> Mark Read (No Attachment)) and,
		// unlike them, keeps holding when someone adds a new path.
		const inMarkRead = inbound("Mark Read (Processing)");
		const onlyGate = inMarkRead.length > 0 &&
			inMarkRead.every((e) => e.from === "Critical Fields Complete?" && e.branch === 0);
		check(onlyGate,
			`the gate's TRUE branch is the ONLY thing that marks an email read (${inMarkRead.length} inbound edge)`,
			"Mark Read (Processing) is reachable without the gate, from: " +
				inMarkRead.filter((e) => e.from !== "Critical Fields Complete?").map((e) => `${e.from}[${e.branch}]`).join(", "));
	}

	// -----------------------------------------------------------------------
	// 3. Bison lane fallback — Bison rate cons for the Barilla lane omit the
	//    street addresses; without this the row lands address-less, fails the
	//    guard in check 1, and never gets a distance.
	// -----------------------------------------------------------------------
	head("3. Bison lane fallback in Normalize Load Fields");
	const norm = find("Normalize Load Fields");
	check(!!norm, '"Normalize Load Fields" node present', '"Normalize Load Fields" node MISSING');
	if (norm) {
		const pickup = String((assignByName(norm, "Pickup Address") || {}).value || "");
		const dropoff = String((assignByName(norm, "Drop-off Address") || {}).value || "");
		check(pickup.includes("bisontransport.com") && /ames/i.test(pickup),
			"Pickup Address carries the Bison/Ames fallback",
			"Pickup Address lost the Bison lane fallback");
		check(dropoff.includes("bisontransport.com") && /grand\s*prairie/i.test(dropoff),
			"Drop-off Address carries the Bison/Grand Prairie fallback",
			"Drop-off Address lost the Bison lane fallback");
		check(/barilla/i.test(pickup) && /barilla/i.test(dropoff),
			"both fallbacks are scoped to the Barilla lane, not to every Bison load",
			"a Bison fallback is no longer scoped by shipper — it would stamp this lane onto unrelated Bison loads");
		// Couples check 1 to check 3: the guard keys on the exact string written here.
		check(pickup.includes("Awaiting Rate Con") && dropoff.includes("Awaiting Rate Con"),
			'both still emit the "Awaiting Rate Con" sentinel that Addresses Ready? tests',
			'the "Awaiting Rate Con" sentinel is gone here, so the Addresses Ready? guard tests a string nothing writes');
	}

	// -----------------------------------------------------------------------
	// 4. Driver column excluded from JOB DETAILS ENTRY — ingestion must never
	//    write a driver. Dispatching from the dashboard is what emits the socket
	//    event and the driver notification; a name written straight to the sheet
	//    is a silently-assigned load, and on re-ingest it overwrites the
	//    dispatcher's real assignment.
	// -----------------------------------------------------------------------
	head("4. Driver column NOT written by JOB DETAILS ENTRY");
	const jde = find("JOB DETAILS ENTRY");
	check(!!jde, '"JOB DETAILS ENTRY" node present', '"JOB DETAILS ENTRY" node MISSING');
	if (jde) {
		const cols = ((jde.parameters || {}).columns || {}).value || {};
		// /driver/i, not an exact "Driver" key: "Driver Name" is the same mistake.
		const driverish = Object.keys(cols).filter((k) => /driver/i.test(k) && String(cols[k] || "") !== "");
		check(driverish.length === 0,
			`no driver column among the ${Object.keys(cols).length} columns it writes`,
			"JOB DETAILS ENTRY writes driver column(s): " + driverish.join(", ") + " — this overwrites dispatcher assignments");
	}

	// -----------------------------------------------------------------------
	// 5. pairedItem on every Code node that emits items.
	//
	//    This lost load 563593554. C.H. Robinson sends the same confirmation
	//    twice ~25s apart, so both land in one Gmail poll. `Prep PDF Base64`
	//    pushed items with no pairedItem — which n8n tolerates at exactly ONE
	//    item (it assumes everything pairs to item 0) and not at two. The item
	//    trace then breaks and every downstream `$('Node').item` throws: the
	//    sheet write threw AND the failure alert threw, so there was no row and
	//    no alert. Deterministic on any multi-item poll, not intermittent.
	// -----------------------------------------------------------------------
	head("5. pairedItem on Code nodes that emit items");
	const codeNodes = nodes.filter((n) => n.type === "n8n-nodes-base.code");
	check(codeNodes.length > 0, `${codeNodes.length} Code node(s) found`, "no Code nodes found — workflow shape unrecognised");
	for (const n of codeNodes) {
		const verdict = classifyPairedItem((n.parameters || {}).jsCode);
		const src = String((n.parameters || {}).jsCode || "");
		if (verdict === "conforms") {
			if (VERBOSE || /\bpairedItem\s*:/.test(stripComments(src))) ok(`${n.name}: sets pairedItem`);
			else ok(`${n.name}: passthrough (returned items keep their own tracing)`);
		} else if (verdict === "advisory") {
			const from = inbound(n.name).map((e) => `${e.from}[${e.branch}]`).join(", ") || "unconnected";
			warn(`${n.name}: emits a fixed literal item with no pairedItem (fed by ${from}). ` +
				"Latent — it only breaks if this node is ever reached with >1 input item, " +
				"and it would drop the extras anyway. Advisory, not a failure.");
		} else {
			bad(`${n.name}: builds items from its input with NO pairedItem — this is the shape that lost load 563593554`);
		}
	}

	// -----------------------------------------------------------------------
	// 6. Every failure path terminates somewhere. A Code-node error with no
	//    error branch kills the whole execution (seen live), and the workflow's
	//    errorWorkflow backstop is dead — "Dispatch v2 Error Alert" lives in the
	//    personal project while this workflow lives in the team project, and
	//    callerPolicy: workflowsFromSameOwner refuses that. So the in-workflow
	//    error branches are the only alerting there is.
	// -----------------------------------------------------------------------
	head("6. Failure paths terminate in an alert");
	const errorNodes = nodes.filter((n) => n.onError === "continueErrorOutput");
	check(errorNodes.length > 0, `${errorNodes.length} node(s) configured with an error output`, "no node has continueErrorOutput — every failure now kills the execution");
	for (const n of errorNodes) {
		const wired = (branch(n.name, 1) || []).map((e) => e.node);
		check(wired.length > 0,
			`${n.name}: error branch wired -> ${wired.join(", ")}`,
			`${n.name}: onError=continueErrorOutput but branch[1] is UNWIRED — errors vanish silently`);
	}
	check(edge("Build Failure Context", 0, "Send Failure Alert"),
		"Build Failure Context -> Send Failure Alert",
		"Build Failure Context does NOT reach Send Failure Alert — nothing alerts");
	check(inbound("Send Failure Alert").length > 0,
		`Send Failure Alert is reachable (${inbound("Send Failure Alert").length} inbound edge)`,
		"Send Failure Alert is orphaned — no failure can ever alert");

	// -----------------------------------------------------------------------
	const failed = failures > 0 || (STRICT && advisories > 0);
	console.log("\n" + "-".repeat(72));
	console.log(`6 checks · ${assertions} assertions · ${failures} failed · ${advisories} advisory${STRICT ? " (--strict: advisories fail)" : ""}`);
	console.log(failed ? "=== FAILED ===" : "=== ALL CHECKS PASSED ===");
	process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
