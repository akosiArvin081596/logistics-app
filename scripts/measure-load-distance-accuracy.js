#!/usr/bin/env node
/**
 * measure-load-distance-accuracy.js — how wrong is the LLM's guessed mileage?
 *
 * WHY THIS EXISTS
 * ---------------
 * Email-ingested loads get their distance and rate-per-mile from the n8n
 * workflow's `AI Agent` node (Gemini + Structured Output Parser). That node has
 * NO tools wired (`ai_tool` appears nowhere in the workflow's connections), so
 * when its prompt says "Calculate the driving distance between the two
 * locations" the model is answering from memory — there is no Distance Matrix
 * call anywhere on that path. The drag-and-drop path
 * (`POST /api/loads/from-ratecon`) measures the same quantity for real via
 * `calculateRatePerMile()` in `lib/ratecon-load.js`.
 *
 * This script quantifies the gap: it replays each stored LLM answer against a
 * real Distance Matrix measurement of the same origin/destination and reports
 * the error distribution, the bias, and the dollar effect on rate-per-mile.
 *
 * STRICTLY READ-ONLY
 * ------------------
 *   * Sheets auth requests the `spreadsheets.readonly` scope, so this process
 *     cannot write to the sheet even by accident.
 *   * Nothing is written back anywhere. Stored distances are NOT corrected —
 *     many sit in locked settlement periods and restating them is the owner's
 *     decision, not this script's.
 *
 * COST
 * ----
 * One billed Distance Matrix ELEMENT per sampled load. The sample is
 * deliberately capped (`--limit`, default 40) and de-duplicated to unique
 * origin/destination pairs, because repeats measure the same route twice and
 * bill twice. `--dry-run` does the whole linking + sampling pass and prints what
 * it WOULD measure without calling Google at all — run that first.
 *
 * USAGE
 *   node scripts/measure-load-distance-accuracy.js --dry-run
 *   node scripts/measure-load-distance-accuracy.js --limit 40
 *   node scripts/measure-load-distance-accuracy.js --limit 40 --json out.json
 *
 * ENV
 *   GOOGLE_MAPS_API_KEY   required unless --dry-run (never printed)
 *   SPREADSHEET_ID        optional; defaults to the production sheet (read-only)
 *   SERVICE_ACCOUNT_KEY   optional path; defaults to ./service-account-key.json
 */

const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------- args
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, dflt) => {
	const i = argv.indexOf(f);
	return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const DRY_RUN = has("--dry-run");
const ALL = has("--all"); // every distinct lane, not a stratified subset
const LIMIT = parseInt(val("--limit", "40"), 10);
const JSON_OUT = val("--json", "");
// A measured lane never changes, so a re-run should never re-bill it. Point
// --cache at a file and repeat runs cost nothing for lanes already seen.
const CACHE_FILE = val("--cache", "");
const CONCURRENCY = 4;

const ROOT = path.resolve(__dirname, "..");
const SHEET_ID =
	process.env.SPREADSHEET_ID || "1ey1n0AAG0k8k-qwkWh2T_C8VqqY129OQQr7D5wNl7Mo";
const KEY_FILE =
	process.env.SERVICE_ACCOUNT_KEY || path.join(ROOT, "service-account-key.json");

// ---------------------------------------------------------------- helpers
const norm = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
const money = (s) => {
	const n = parseFloat(String(s == null ? "" : s).replace(/[$,\s]/g, ""));
	return Number.isFinite(n) ? n : 0;
};
function pct(arr, p) {
	if (!arr.length) return null;
	const a = [...arr].sort((x, y) => x - y);
	const i = (a.length - 1) * p;
	const lo = Math.floor(i), hi = Math.ceil(i);
	return lo === hi ? a[lo] : a[lo] + (a[hi] - a[lo]) * (i - lo);
}
const median = (a) => pct(a, 0.5);

// ---------------------------------------------------------------- sheet read
async function readSheet() {
	// Plain resolution: the script lives in the repo, beside node_modules. Run it
	// from a bare git worktree (no node_modules of its own) with
	// NODE_PATH=<repo>/node_modules.
	const { google } = require("googleapis");
	const auth = new google.auth.GoogleAuth({
		keyFile: KEY_FILE,
		// READONLY on purpose — this script must never be able to write.
		scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
	});
	const sheets = google.sheets({ version: "v4", auth: await auth.getClient() });
	const grab = async (tab) => {
		const r = await sheets.spreadsheets.values.get({
			spreadsheetId: SHEET_ID,
			range: `${tab}!A1:ZZ`,
		});
		return r.data.values || [];
	};
	return { jt: await grab("Job Tracking"), jd: await grab("Job Details") };
}

// ---------------------------------------------------------------- linking
/**
 * The LLM's answer is stored as raw JSON in Job Details' `output` column —
 * NOT in the `Distance` / `Rate Per Mile` columns. (The `Update Job Details
 * (Distance)` node uses mappingMode `autoMapInputData` against a matching
 * column, "Load ID", that does not exist on the Job Details tab; column A's
 * header is blank there. So the whole `{output:{...}}` item auto-maps into the
 * one column whose name it does match: `output`.)
 *
 * Job Tracking is where the load actually lives, and the workflow writes the
 * LLM's route summary into its `Details` column — so that string is the join
 * key back to the load's real pickup/drop-off addresses.
 */
function link(jt, jd) {
	const jtH = jt[0] || [], jdH = jd[0] || [];
	const jti = (n) => jtH.indexOf(n);
	const jdi = (n) => jdH.indexOf(n);

	const byDetails = new Map();
	for (let i = 1; i < jt.length; i++) {
		const r = jt[i];
		const k = norm(r[jti("Details")]);
		if (!k) continue;
		if (!byDetails.has(k)) byDetails.set(k, []);
		byDetails.get(k).push({
			loadId: String(r[jti("Load ID")] || "").trim(),
			pickup: String(r[jti("Pickup Address")] || "").trim(),
			dropoff: String(r[jti("Drop-off Address")] || "").trim(),
			payment: money(r[jti("  Payment  ")]),
			brokerEmail: String(r[jti("Email")] || "").trim(),
			status: String(r[jti("Job Status")] || "").trim(),
		});
	}

	const recs = [];
	for (let i = 1; i < jd.length; i++) {
		const raw = String(jd[i][jdi("output")] || "").trim();
		if (!raw) continue;
		let j;
		try { j = JSON.parse(raw); } catch (e) { continue; }
		if (typeof j.distance !== "number" || !j.details) continue;
		const ms = byDetails.get(norm(j.details)) || [];
		const m = ms.find((x) => x.pickup && x.dropoff) || ms[0] || null;
		recs.push({
			jdRow: i + 1,
			llmDistance: j.distance,
			llmRpm: typeof j.rate_per_mile === "number" ? j.rate_per_mile : null,
			llmPayment: typeof j.Payment === "number" ? j.Payment : null,
			details: j.details,
			loadId: m ? m.loadId : "",
			pickup: m ? m.pickup : "",
			dropoff: m ? m.dropoff : "",
			payment: m ? m.payment : 0,
			brokerEmail: m ? m.brokerEmail : "",
			status: m ? m.status : "",
		});
	}
	return recs;
}

/** Same question asked twice — did the model give the same answer? */
function selfConsistency(recs) {
	const byRoute = new Map();
	for (const r of recs) {
		const k = norm(r.details);
		if (!byRoute.has(k)) byRoute.set(k, []);
		byRoute.get(k).push(r.llmDistance);
	}
	const repeated = [], inconsistent = [];
	for (const [route, answers] of byRoute) {
		if (answers.length < 2) continue;
		repeated.push(route);
		if (new Set(answers).size > 1) {
			const nz = answers.filter((x) => x > 0);
			const mn = Math.min(...nz), mx = Math.max(...nz);
			inconsistent.push({
				route, answers,
				spreadPct: nz.length && mn > 0 ? ((mx - mn) / mn) * 100 : Infinity,
				spreadMiles: nz.length ? mx - mn : 0,
			});
		}
	}
	inconsistent.sort((a, b) => b.spreadPct - a.spreadPct);
	return { repeatedCount: repeated.length, inconsistent };
}

/** Unique O/D pairs, spread across distance bands and brokers. */
function sample(recs, limit) {
	const linked = recs.filter((r) => r.loadId && r.pickup && r.dropoff);
	const seen = new Set(), uniq = [];
	for (const r of linked) {
		const k = norm(r.pickup) + "||" + norm(r.dropoff);
		if (seen.has(k)) continue;
		seen.add(k);
		uniq.push(r);
	}
	const bands = [
		["<100", 0, 100], ["100-300", 100, 300], ["300-600", 300, 600],
		["600-1000", 600, 1000], [">=1000", 1000, Infinity],
	];
	if (ALL) {
		const out = [];
		for (const [name, lo, hi] of bands) {
			for (const r of uniq.filter((x) => x.llmDistance >= lo && x.llmDistance < hi)) {
				out.push({ ...r, band: name });
			}
		}
		return { uniqueAvailable: uniq.length, linked: linked.length, sample: out };
	}
	const per = Math.max(1, Math.ceil(limit / bands.length));
	const out = [];
	for (const [name, lo, hi] of bands) {
		const pool = uniq.filter((r) => r.llmDistance >= lo && r.llmDistance < hi);
		pool.sort((a, b) => (a.brokerEmail || "").localeCompare(b.brokerEmail || ""));
		const take = Math.min(per, pool.length);
		const stride = take ? pool.length / take : 1;
		for (let i = 0; i < take; i++) out.push({ ...pool[Math.floor(i * stride)], band: name });
	}
	return { uniqueAvailable: uniq.length, linked: linked.length, sample: out.slice(0, limit) };
}

// ---------------------------------------------------------------- measure
/**
 * Byte-for-byte the same call `POST /api/loads/from-ratecon` makes
 * (server.js: distancematrix/json, units=imperial), and the same
 * `Math.round(meters / 1609.34)` the app's calculateRatePerMile() applies —
 * so "measured" here is exactly what a drag-and-drop load would have stored.
 */
async function distanceMatrixMiles(origin, destination, apiKey) {
	const url =
		"https://maps.googleapis.com/maps/api/distancematrix/json" +
		`?origins=${encodeURIComponent(origin)}` +
		`&destinations=${encodeURIComponent(destination)}` +
		`&units=imperial&key=${encodeURIComponent(apiKey)}`;
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(), 15000);
	try {
		const resp = await fetch(url, { signal: ctrl.signal });
		const body = await resp.json();
		const el = body && body.rows && body.rows[0] && body.rows[0].elements && body.rows[0].elements[0];
		if (body && body.status && body.status !== "OK") {
			return { ok: false, reason: `TOP:${body.status}` };
		}
		if (!el || el.status !== "OK" || !el.distance) {
			return { ok: false, reason: el ? el.status : "NO_ELEMENT" };
		}
		return { ok: true, miles: Math.round(el.distance.value / 1609.34), text: el.distance.text };
	} catch (e) {
		return { ok: false, reason: e.name === "AbortError" ? "TIMEOUT" : e.message };
	} finally {
		clearTimeout(t);
	}
}

async function pool(items, n, fn) {
	const out = new Array(items.length);
	let i = 0;
	await Promise.all(
		Array.from({ length: Math.min(n, items.length) }, async () => {
			while (i < items.length) {
				const k = i++;
				out[k] = await fn(items[k], k);
			}
		})
	);
	return out;
}

// ---------------------------------------------------------------- report
function report(measured, meta) {
	const ok = measured.filter((m) => m.measuredMiles > 0);
	const absErr = ok.map((m) => Math.abs(m.llmDistance - m.measuredMiles));
	const pctErr = ok.map((m) => ((m.llmDistance - m.measuredMiles) / m.measuredMiles) * 100);
	const absPctErr = pctErr.map(Math.abs);

	console.log("\n================ ERROR DISTRIBUTION ================");
	console.log(`measured OK            : ${ok.length} of ${measured.length}`);
	console.log(`median |error|         : ${median(absErr).toFixed(1)} mi`);
	console.log(`p90 |error|            : ${pct(absErr, 0.9).toFixed(1)} mi`);
	console.log(`max |error|            : ${Math.max(...absErr).toFixed(1)} mi`);
	console.log(`median |% error|       : ${median(absPctErr).toFixed(1)}%`);
	console.log(`p90 |% error|          : ${pct(absPctErr, 0.9).toFixed(1)}%`);

	const meanSigned = pctErr.reduce((a, b) => a + b, 0) / pctErr.length;
	const high = pctErr.filter((p) => p > 0).length;
	console.log("\n---------------- BIAS vs NOISE ----------------");
	console.log(`mean SIGNED % error    : ${meanSigned >= 0 ? "+" : ""}${meanSigned.toFixed(1)}%`);
	console.log(`median SIGNED % error  : ${median(pctErr) >= 0 ? "+" : ""}${median(pctErr).toFixed(1)}%`);
	console.log(`reads HIGH (overstates): ${high}/${pctErr.length} (${((high / pctErr.length) * 100).toFixed(0)}%)`);
	console.log(`reads LOW  (understates): ${pctErr.length - high}/${pctErr.length}`);

	const over10 = absPctErr.filter((p) => p > 10).length;
	const over25 = absPctErr.filter((p) => p > 25).length;
	console.log("\n---------------- MIS-PRICING ----------------");
	console.log(`|error| > 10%          : ${over10}/${ok.length} (${((over10 / ok.length) * 100).toFixed(0)}%)`);
	console.log(`|error| > 25%          : ${over25}/${ok.length} (${((over25 / ok.length) * 100).toFixed(0)}%)`);

	console.log("\n---------------- WORST CASES ----------------");
	const worst = [...ok].sort(
		(a, b) => Math.abs((b.llmDistance - b.measuredMiles) / b.measuredMiles) -
			Math.abs((a.llmDistance - a.measuredMiles) / a.measuredMiles)
	).slice(0, 12);
	for (const w of worst) {
		const pe = ((w.llmDistance - w.measuredMiles) / w.measuredMiles) * 100;
		const pay = w.payment || w.llmPayment || 0;
		const rpmLlm = w.llmDistance > 0 ? pay / w.llmDistance : 0;
		const rpmReal = pay / w.measuredMiles;
		console.log(
			`  load ${w.loadId || "(unlinked)"}  ${w.details}\n` +
			`     stored ${w.llmDistance} mi  vs measured ${w.measuredMiles} mi   (${pe >= 0 ? "+" : ""}${pe.toFixed(0)}%)\n` +
			`     $${pay.toFixed(0)} → RPM shown $${rpmLlm.toFixed(2)} vs true $${rpmReal.toFixed(2)}  (off by $${Math.abs(rpmLlm - rpmReal).toFixed(2)}/mi)`
		);
	}

	console.log("\n---------------- RATE-PER-MILE IMPACT ----------------");
	const rpmDeltas = [];
	for (const m of ok) {
		const pay = m.payment || m.llmPayment || 0;
		if (pay <= 0 || m.llmDistance <= 0) continue;
		rpmDeltas.push({ d: Math.abs(pay / m.llmDistance - pay / m.measuredMiles), loadId: m.loadId });
	}
	const ds = rpmDeltas.map((x) => x.d);
	if (ds.length) {
		console.log(`loads with a payment   : ${ds.length}`);
		console.log(`median RPM error       : $${median(ds).toFixed(2)}/mi`);
		console.log(`p90 RPM error          : $${pct(ds, 0.9).toFixed(2)}/mi`);
		console.log(`worst RPM error        : $${Math.max(...ds).toFixed(2)}/mi`);
		console.log(`RPM off by >$0.25/mi   : ${ds.filter((x) => x > 0.25).length}/${ds.length}`);
	}
	return { ok: ok.length, medianAbs: median(absErr), p90Abs: pct(absErr, 0.9), meanSigned, over10, over25, meta };
}

// ---------------------------------------------------------------- main
async function main() {
	console.log("Reading sheet (READ-ONLY)…");
	const { jt, jd } = await readSheet();
	const recs = link(jt, jd);
	console.log(`LLM-answered loads found (Job Details.output): ${recs.length}`);

	const sc = selfConsistency(recs);
	console.log("\n================ SELF-CONSISTENCY ================");
	console.log("(the same route asked more than once — a real measurement cannot disagree with itself)");
	console.log(`routes asked >1 time   : ${sc.repeatedCount}`);
	console.log(`gave DIFFERENT answers : ${sc.inconsistent.length} (${sc.repeatedCount ? ((sc.inconsistent.length / sc.repeatedCount) * 100).toFixed(0) : 0}%)`);
	for (const s of sc.inconsistent.slice(0, 8)) {
		console.log(`  ${s.route}\n     answers=[${s.answers.join(", ")}]  spread=${s.spreadMiles} mi`);
	}

	const { uniqueAvailable, linked, sample: chosen } = sample(recs, LIMIT);
	console.log(`\nlinked to a load with both addresses: ${linked}`);
	console.log(`unique origin/destination pairs      : ${uniqueAvailable}`);
	console.log(`sampling                             : ${chosen.length} (=${chosen.length} billed elements)`);

	if (DRY_RUN) {
		console.log("\n--dry-run: NOT calling Google. Would measure:");
		for (const c of chosen) console.log(`  [${c.band}] ${c.loadId}  ${c.pickup}  ->  ${c.dropoff}   (stored ${c.llmDistance} mi)`);
		return;
	}

	const apiKey = process.env.GOOGLE_MAPS_API_KEY;
	if (!apiKey) {
		console.error("GOOGLE_MAPS_API_KEY is not set — refusing to run. Use --dry-run to inspect the sample.");
		process.exit(1);
	}

	const cache = CACHE_FILE && fs.existsSync(CACHE_FILE)
		? JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"))
		: {};
	const ckey = (c) => norm(c.pickup) + "||" + norm(c.dropoff);
	const toBill = chosen.filter((c) => !(ckey(c) in cache)).length;
	console.log(`\nMeasuring ${chosen.length} routes (${chosen.length - toBill} cached, ${toBill} billed)…`);

	const measured = await pool(chosen, CONCURRENCY, async (c) => {
		const k = ckey(c);
		if (k in cache) return { ...c, measuredMiles: cache[k], cached: true };
		const r = await distanceMatrixMiles(c.pickup, c.dropoff, apiKey);
		if (!r.ok) {
			console.log(`  ! ${c.loadId}: ${r.reason}`);
			return { ...c, measuredMiles: 0, failReason: r.reason };
		}
		cache[k] = r.miles;
		return { ...c, measuredMiles: r.miles, measuredText: r.text };
	});
	if (CACHE_FILE) fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 1));

	const summary = report(measured, { sampled: chosen.length, uniqueAvailable, linked, totalLlmRows: recs.length });
	if (JSON_OUT) {
		fs.writeFileSync(JSON_OUT, JSON.stringify({ summary, selfConsistency: sc, measured }, null, 2));
		console.log(`\nwrote ${JSON_OUT}`);
	}
}

main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
