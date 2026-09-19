#!/usr/bin/env node
/**
 * The Linxup speed-unit drift guard — `accumulateUnitSample()` /
 * `judgeSpeedUnit()` / `unitVerdictIsAlarming()` in lib/linxup-push.js.
 *
 * WHY THIS EXISTS. Linxup speed arrives as a bare number and the unit is a
 * config guess (`LINXUP_SPEED_UNIT`, whose `default:` case silently falls back
 * to mph). A wrong unit is invisible to every existing check: the
 * `speed_outlier` filter derives speed from GPS distance/time and NEVER reads
 * the reported `speed` field, so 105 km/h read as mph stores 46.9 m/s and sails
 * under the 53.6 m/s ceiling. The damage lands on driver pay, which counts a day
 * worked at speed > 2.235 m/s — i.e. wire value > 5. A km/h feed over-counts
 * paid days; an already-m/s feed under-counts them.
 *
 * The unit itself is CONFIRMED mph (commit ef85a3b, re-verified 2026-09-19
 * against 2,343 production rows). This guard is about a FUTURE change.
 *
 * WHAT IS ASSERTED:
 *   §1 accumulation — window guards, purity, hostile input
 *   §2 the bands, including that they deliberately do NOT tile the number line
 *   §3 end-to-end on synthetic tracks at each candidate unit
 *   §4 alarm policy — "I don't know" is never an alarm
 *   §5 real production ratios stay `consistent` (regression pin)
 *   §6 wiring in server.js — observe-only, both write paths tagged
 *   §7 DISCRIMINATION — defang each clause, require the verdict to flip
 *
 * Pure: no server, no app.db, no network. geolib is used for real geometry
 * (already a dependency) so the synthetic tracks are not self-referential.
 *
 * Run: node scripts/test-linxup-speed-unit.js
 */

const fs = require("fs");
const path = require("path");
const geolib = require("geolib");

const LIB_PATH = path.join(__dirname, "..", "lib", "linxup-push.js");
const LIB_SRC = fs.readFileSync(LIB_PATH, "utf8");
const SRV_SRC = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

let failed = 0;
function ok(name, cond) {
	if (cond) console.log(`ok    ${name}`);
	else { console.log(`FAIL  ${name}`); failed++; }
}

// Rebuild the module from source so §7 can mutate it. The module has zero
// require() calls, so this is a faithful reconstruction, not a stub.
function buildLib(src = LIB_SRC) {
	const mod = { exports: {} };
	new Function("module", "exports", "require", src)(mod, mod.exports, require);
	return mod.exports;
}
const L = buildLib();
const dist = (a, b) => geolib.getDistance(a, b);

// --- synthetic track -------------------------------------------------------
// A straight run north at a constant ground speed. `speedFactor` is what a
// WRONG unit assumption would do to the stored value: 1 = correct (m/s after
// conversion), 0.6216 = feed was km/h read as mph, 2.2369 = feed was already m/s.
const MPH_TO_MPS = 0.44704, KMH_TO_MPS = 0.277778;
const AS_KMH = KMH_TO_MPS / MPH_TO_MPS;   // 0.6216
const AS_MPS = 1 / MPH_TO_MPS;            // 2.2369

function track({ pings = 400, dtSec = 60, groundMps = 29, speedFactor = 1, startLat = 32.7 } = {}) {
	const out = [];
	let lat = startLat, t = 1_700_000_000_000;
	for (let i = 0; i < pings; i++) {
		out.push({ latitude: lat, longitude: -96.8, speed: groundMps * speedFactor, location_date_ms: t });
		// metres north -> degrees latitude
		lat += (groundMps * dtSec) / 111_320;
		t += dtSec * 1000;
	}
	return out;
}
function runTrack(rows, lib = L, opts) {
	let acc = null;
	for (let i = 1; i < rows.length; i++) acc = lib.accumulateUnitSample(acc, rows[i - 1], rows[i], dist, opts);
	return { acc, verdict: lib.judgeSpeedUnit(acc) };
}

// ===========================================================================
console.log("\n§1  accumulateUnitSample()");
// ===========================================================================
const a = { latitude: 32.7, longitude: -96.8, speed: 29, location_date_ms: 1000 };
const b = { latitude: 32.71, longitude: -96.8, speed: 29, location_date_ms: 61000 };

ok("a pair inside the window is counted", L.accumulateUnitSample(null, a, b, dist).samples === 1);
ok("it does NOT mutate the accumulator it is given", (() => {
	const seed = { samples: 5, reportedM: 100, gpsM: 100 };
	L.accumulateUnitSample(seed, a, b, dist);
	return seed.samples === 5 && seed.reportedM === 100;
})());
ok("a gap SHORTER than the window is ignored",
	L.accumulateUnitSample(null, a, { ...b, location_date_ms: 1001 }, dist).samples === 0);
ok("⚠️ a gap LONGER than the window is ignored — otherwise a parked stretch " +
	"adds GPS distance with no matching reported speed and fakes a low ratio",
	L.accumulateUnitSample(null, a, { ...b, location_date_ms: 1000 + 60 * 60 * 1000 }, dist).samples === 0);
ok("a negative speed is refused", L.accumulateUnitSample(null, { ...a, speed: -1 }, b, dist).samples === 0);
ok("a null/undefined fix does not throw",
	L.accumulateUnitSample(null, null, b, dist).samples === 0 &&
	L.accumulateUnitSample(null, a, undefined, dist).samples === 0);
ok("a non-finite timestamp is refused",
	L.accumulateUnitSample(null, { ...a, location_date_ms: NaN }, b, dist).samples === 0);
ok("accumulation is additive across pairs", (() => {
	const one = L.accumulateUnitSample(null, a, b, dist);
	const two = L.accumulateUnitSample(one, a, b, dist);
	return two.samples === 2 && Math.abs(two.gpsM - one.gpsM * 2) < 1;
})());

// ===========================================================================
console.log("\n§2  judgeSpeedUnit() bands");
// ===========================================================================
const judge = (ratio, samples = 500, gpsM = 50000) =>
	L.judgeSpeedUnit({ samples, gpsM, reportedM: gpsM * ratio }).verdict;

ok("ratio 1.00 -> consistent", judge(1.0) === "consistent");
ok("ratio 0.96 -> consistent (production sits here)", judge(0.96) === "consistent");
ok("ratio 0.62 -> looks_kmh", judge(0.62) === "looks_kmh");
ok("ratio 2.24 -> looks_mps", judge(2.24) === "looks_mps");
ok("⚠️ the bands deliberately do NOT tile the number line — a ratio between " +
	"them is inconclusive, never a guess",
	judge(0.78) === "inconclusive" && judge(1.6) === "inconclusive" && judge(3.5) === "inconclusive");
ok("too few samples -> insufficient_data, whatever the ratio",
	judge(0.62, 5, 50000) === "insufficient_data");
ok("⚠️ too little GROUND COVERED -> insufficient_data — a parked truck " +
	"integrates 0/0 and must never produce a verdict",
	judge(0.62, 500, 10) === "insufficient_data");
ok("a null accumulator is insufficient_data, not a crash",
	L.judgeSpeedUnit(null).verdict === "insufficient_data");
ok("the ratio is reported for a human to sanity-check", L.judgeSpeedUnit({ samples: 500, gpsM: 50000, reportedM: 31000 }).ratio === 0.62);

// ===========================================================================
console.log("\n§3  end-to-end on synthetic tracks");
// ===========================================================================
ok("a correct mph feed reads consistent", runTrack(track({ speedFactor: 1 })).verdict.verdict === "consistent");
ok("a km/h feed read as mph is CAUGHT as looks_kmh",
	runTrack(track({ speedFactor: AS_KMH })).verdict.verdict === "looks_kmh");
ok("an already-m/s feed read as mph is CAUGHT as looks_mps",
	runTrack(track({ speedFactor: AS_MPS })).verdict.verdict === "looks_mps");
ok("a stationary vehicle never produces a verdict",
	runTrack(track({ groundMps: 0, speedFactor: 1 })).verdict.verdict === "insufficient_data");
ok("a short trip never produces a verdict", runTrack(track({ pings: 10 })).verdict.verdict === "insufficient_data");
ok("slow city driving at the correct unit is still consistent",
	runTrack(track({ groundMps: 8, pings: 2000 })).verdict.verdict === "consistent");

// ===========================================================================
console.log("\n§4  alarm policy");
// ===========================================================================
ok("looks_kmh and looks_mps alarm",
	L.unitVerdictIsAlarming("looks_kmh") && L.unitVerdictIsAlarming("looks_mps"));
ok("⚠️ consistent / inconclusive / insufficient_data do NOT alarm — treating " +
	'"I do not know" as "something is wrong" is how a monitor gets muted',
	!L.unitVerdictIsAlarming("consistent") &&
	!L.unitVerdictIsAlarming("inconclusive") &&
	!L.unitVerdictIsAlarming("insufficient_data"));
ok("an unknown verdict string does not alarm", !L.unitVerdictIsAlarming("banana") && !L.unitVerdictIsAlarming(undefined));

// ===========================================================================
console.log("\n§5  production regression pin");
// Measured 2026-09-19 over 5 real vehicles (2 Linxup, 3 Routemate). If a band
// edit ever makes one of these read as an alarm, the detector is worse than none.
// ===========================================================================
for (const [vid, ratio] of [
	["18000505841 (linxup)", 1.001], ["18000507597 (linxup)", 1.002],
	["2Y_aT… (routemate)", 1.009], ["wL8e5… (routemate)", 0.958], ["x78f4… (routemate)", 0.990],
]) {
	ok(`real feed ${vid} ratio ${ratio} stays consistent`, judge(ratio) === "consistent");
}

// ===========================================================================
console.log("\n§6  server.js wiring");
// ===========================================================================
ok("the additive `source` column migration is present",
	/ALTER TABLE routemate_telemetry ADD COLUMN source TEXT DEFAULT ''/.test(SRV_SRC));
ok("the telemetry INSERT carries source", /@dropped_reason, @source/.test(SRV_SRC));
ok("BOTH write paths tag provenance",
	/source: "linxup"/.test(SRV_SRC) && /source: "routemate"/.test(SRV_SRC));
ok("the guard is called from the ingest path", /linxupTrackSpeedUnit\(vehicleId, pos\)/.test(SRV_SRC));
ok("⚠️ it runs on CLEAN fixes only — feeding outliers to the detector blunts it",
	/if \(!droppedReason\) linxupTrackSpeedUnit/.test(SRV_SRC));
ok("⚠️ OBSERVE-ONLY: the guard is invoked AFTER the insert, so no verdict can " +
	"ever prevent a row being written",
	(() => {
		// Anchor on the CALL SITE, not the bare name — `function
		// linxupTrackSpeedUnit(vehicleId, pos)` contains the same substring and
		// is declared earlier in the file, which would invert this comparison.
		const insertAt = SRV_SRC.indexOf("routemate_vehicle_id: vehicleId,");
		const callAt = SRV_SRC.indexOf("if (!droppedReason) linxupTrackSpeedUnit(vehicleId, pos);");
		return insertAt > 0 && callAt > 0 && insertAt < callAt;
	})());
ok("the guard returns nothing the ingest path can branch on",
	/if \(!droppedReason\) linxupTrackSpeedUnit\(vehicleId, pos\);/.test(SRV_SRC) &&
	!/=\s*linxupTrackSpeedUnit\(/.test(SRV_SRC));
ok("the guard body cannot throw into the feed (wrapped in try/catch)",
	/function linxupTrackSpeedUnit[\s\S]{0,400}?try \{/.test(SRV_SRC));
ok("the verdict is surfaced on the health endpoint",
	/speedUnitCheck: linxupHealth\.speedUnit/.test(SRV_SRC));
ok("⚠️ the per-vehicle state is BOUNDED — the ingest path keeps positions whose " +
	"id matched no truck, so the key space is whatever Linxup sends, not our six trucks",
	/const LINXUP_UNIT_MAX_VEHICLES = \d+;/.test(SRV_SRC) &&
	/linxupUnitCap\(linxupUnitState\);/.test(SRV_SRC) &&
	/linxupUnitAlarmed\.size > LINXUP_UNIT_MAX_VEHICLES/.test(SRV_SRC));
ok("alarms are deduped per vehicle+verdict, not per ping",
	/linxupUnitAlarmed\.has\(key\)/.test(SRV_SRC) && /linxupUnitAlarmed\.add\(key\)/.test(SRV_SRC));

// ===========================================================================
console.log("\n§7  DISCRIMINATION — defang each clause, require the verdict to flip");
// A guard test that still passes against a defanged guard is worse than none.
// ===========================================================================
const mutWideBand = buildLib(LIB_SRC.replace(
	'{ verdict: "consistent", lo: 0.80, hi: 1.25 },',
	'{ verdict: "consistent", lo: 0.10, hi: 3.00 },'));
ok("MUTANT: widening the consistent band swallows the km/h case",
	runTrack(track({ speedFactor: AS_KMH }), mutWideBand).verdict.verdict === "consistent");
ok("MUTANT: and swallows the m/s case too",
	runTrack(track({ speedFactor: AS_MPS }), mutWideBand).verdict.verdict === "consistent");

const mutNoSamples = buildLib(LIB_SRC.replace("const UNIT_MIN_SAMPLES = 40;", "const UNIT_MIN_SAMPLES = 0;")
	.replace("const UNIT_MIN_GPS_METERS = 8000;", "const UNIT_MIN_GPS_METERS = 0;"));
ok("MUTANT: dropping the minimum-evidence guards makes a 10-ping trip emit a verdict",
	runTrack(track({ pings: 10 }), mutNoSamples).verdict.verdict !== "insufficient_data");

const mutNoWindow = buildLib(LIB_SRC.replace(
	"if (!Number.isFinite(dtMs) || dtMs < minDtMs || dtMs > maxDtMs) return base;", ""));
ok("MUTANT: removing the dt window lets a long parked gap be counted",
	mutNoWindow.accumulateUnitSample(null, a, { ...b, location_date_ms: 1000 + 60 * 60 * 1000 }, dist).samples === 1);

const mutNoTsGuard = buildLib(LIB_SRC.replace("if (tPrev == null || tCur == null) return base;", ""));
ok("MUTANT: dropping the timestamp resolution lets a NaN stamp fake a valid gap",
	mutNoTsGuard.accumulateUnitSample(null, { ...a, location_date_ms: NaN }, b, dist).samples === 1);

const mutAlarmAll = buildLib(LIB_SRC.replace(
	'return v === "looks_kmh" || v === "looks_mps";', "return v !== \"consistent\";"));
ok("MUTANT: alarming on non-consistent makes inconclusive/insufficient_data page someone",
	mutAlarmAll.unitVerdictIsAlarming("inconclusive") === true &&
	mutAlarmAll.unitVerdictIsAlarming("insufficient_data") === true);

console.log(failed ? `\n${failed} test(s) failed` : "\nall passed");
process.exit(failed ? 1 : 0);
