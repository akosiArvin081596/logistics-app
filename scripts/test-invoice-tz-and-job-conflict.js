#!/usr/bin/env node
/**
 * Tests for the three fixes in this PR.
 *
 *   1. GET /api/db/download carries refuseCrossOrigin — the MONEY tier, on a GET.
 *      SESSION_COOKIE_SAMESITE defaults to `lax`, and lax still attaches the
 *      cookie to a top-level cross-site GET *navigation*, so one link a Super
 *      Admin follows triggered a ~313 MB db.backup() and left a full copy of
 *      every SSN and account number in os.tmpdir(). Source assertion, because
 *      the failure mode is "a later edit drops the middleware", which no
 *      behavioural test of the guard itself can see. The COUNT lives in
 *      scripts/test-csrf-guard.js (7); this names the route.
 *
 *   2. generateInvoiceNumber() minted a DIFFERENT invoice number for the same
 *      week depending on the server's timezone — REAL, because that string is
 *      both the PDF filename and the row identity in `invoices.pdf_file_name`,
 *      which has no unique index. `new Date("YYYY-MM-DD")` is UTC midnight while
 *      `new Date(year, 0, 1)` is server-LOCAL midnight, and the week arithmetic
 *      subtracted one from the other. Section 3 also pins the property that
 *      matters more than correctness here: the fix must NOT restate history, so
 *      every day must reproduce today's UTC (production) answer byte for byte.
 *
 *   3. isAfterDeadline() used the toLocaleString -> new Date() round trip that
 *      the comment beside houstonStamp() condemns. LATENT, and this suite says
 *      so rather than overclaiming: replayed against the true instant of 18:30
 *      America/Chicago it disagreed 0 times in all 418 IANA zones. What section
 *      4 does prove is that the OLD form's verdict is a function of whatever the
 *      runtime's ICU emits — an unparseable rendering makes it return "not late"
 *      forever, silently — and that the new form cannot be, because it never
 *      re-parses its own output.
 *
 *   4. PUT /api/driver/status no longer 409s ACTIVE_JOB_CONFLICT on the caller's
 *      OWN load. The scan excluded only the caller's row INDEX, but `dataRows`
 *      is readJobTrackingSnapshot() — the raw whole-tab read, so deduplicateLoads()
 *      has not run and duplicates are present by construction. Unreachable on
 *      production data today (no duplicated id has two live rows), so section 5
 *      proves it against a CONSTRUCTED fixture and, in the same breath, that a
 *      genuine second load still 409s.
 *
 * WHY IT LOADS THE CODE OUT OF server.js SOURCE. Same reason as its five
 * siblings: server.js opens SQLite, reads a service-account key and starts
 * listening on import. Extracting the text exercises THE CODE THAT SHIPS rather
 * than a copy that can drift, and each extraction asserts it is found exactly
 * once so a rename fails loudly instead of silently testing nothing.
 *
 * WHAT IS REAL: generateInvoiceNumber(), isAfterDeadline(), normalizeDriverName(),
 * normLoadKey() and the one-active-job block lifted verbatim out of the
 * PUT /api/driver/status handler. Only `db` (the sequence COUNT), `Date` (a test
 * must not wait for Friday) and `res` (to capture the 409) are injected.
 *
 * DISCRIMINATION. Sections 3-5 each run the PRE-FIX implementation against the
 * same assertions and require it to FAIL. A test that passes on both the broken
 * and the fixed code has not tested anything.
 *
 * Run: node scripts/test-invoice-tz-and-job-conflict.js
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const SERVER = path.join(__dirname, "..", "server.js");
const SRC = fs.readFileSync(SERVER, "utf8");

// ---------------------------------------------------------------- extraction
function extractAt(needle, label) {
	const hits = SRC.split(needle).length - 1;
	if (hits !== 1) throw new Error(`expected exactly 1 ${label} in server.js, found ${hits}`);
	const start = SRC.indexOf(needle) + (needle.startsWith("\n") ? 1 : 0);
	let depth = 0, seen = false;
	for (let j = SRC.indexOf("{", start); j < SRC.length; j++) {
		if (SRC[j] === "{") { depth++; seen = true; }
		else if (SRC[j] === "}") { depth--; if (seen && depth === 0) return SRC.slice(start, j + 1); }
	}
	throw new Error(`unbalanced braces extracting ${label}`);
}
const extract = (name) => extractAt(`\nfunction ${name}(`, `definition of ${name}()`);
const extractConst = (name) => {
	const m = SRC.match(new RegExp(`\\nconst ${name} = [^\\n]+;`, "g")) || [];
	if (m.length !== 1) throw new Error(`expected exactly 1 \`const ${name}\`, found ${m.length}`);
	return m[0];
};

// The one-active-job guard is INLINE in the route handler, not a function, so it
// is lifted by its own opening line and brace-matched. Anchoring on the regex
// literal rather than a comment keeps the extraction tied to the code.
const ACTIVE_JOB_ANCHOR = "\t\tif (/^at shipper$/i.test(newStatus)) {";
const ACTIVE_JOB_BLOCK = extractAt(ACTIVE_JOB_ANCHOR, "one-active-job block");

// ------------------------------------------------------------------ sandboxes
// generateInvoiceNumber reads a COUNT off `invoices` for the sequence suffix;
// only the -NN suffix depends on it, and every assertion here is about the
// -YYYYWww half, so a fixed 0 keeps the suffix at -01 throughout.
const dbStub = { prepare: () => ({ get: () => ({ cnt: 0 }) }) };
const S = new Function("db", [
	extract("generateInvoiceNumber"),
	extract("isAfterDeadline"),
	extract("normalizeDriverName"),
	extractConst("normLoadKey"),
	"return { generateInvoiceNumber, isAfterDeadline, normalizeDriverName, normLoadKey };",
].join("\n"))(dbStub);
const { generateInvoiceNumber, normalizeDriverName, normLoadKey } = S;

// isAfterDeadline calls `new Date()` for "now". Re-bind it in its own scope so a
// test can name an instant instead of waiting for a Friday evening.
const ISO_AFTER_DEADLINE_SRC = extract("isAfterDeadline");
function afterDeadlineAt(weekEndDate, nowMs, DateImpl) {
	const D = DateImpl || class extends Date {
		constructor(...a) { return a.length ? new Date(...a) : new Date(nowMs); }
	};
	return new Function("Date", `${ISO_AFTER_DEADLINE_SRC}\nreturn isAfterDeadline;`)(D)(weekEndDate);
}

// The shipped block, wrapped so `return res.status(409)...` is capturable.
function makeActiveJobGuard(blockSrc) {
	const body = `${blockSrc}\nreturn null;`;
	const fn = new Function(
		"headers", "dataRows", "rowIndex", "loadId", "driverName", "statusIdx", "newStatus",
		"normalizeDriverName", "normLoadKey", "res", body,
	);
	return (args) => fn(
		args.headers, args.dataRows, args.rowIndex, args.loadId, args.driverName,
		args.statusIdx, args.newStatus, normalizeDriverName, normLoadKey,
		{ status: (code) => ({ json: (b) => ({ code, body: b }) }) },
	);
}
const activeJobGuard = makeActiveJobGuard(ACTIVE_JOB_BLOCK);

// ------------------------------------------- the PRE-FIX implementations
// Verbatim copies of what shipped before this change, used ONLY to prove these
// assertions discriminate. If one of these ever starts passing, the fix is gone.
function oldInvoiceWeek(weekStart) {
	const d = new Date(weekStart);
	const year = d.getFullYear();
	const jan1 = new Date(year, 0, 1);
	const days = Math.floor((d - jan1) / 86400000);
	const weekNum = Math.ceil((days + jan1.getDay() + 1) / 7);
	return `${year}W${String(weekNum).padStart(2, "0")}`;
}
const OLD_IS_AFTER_DEADLINE_SRC = `function isAfterDeadline(weekEndDate) {
	const nowStr = new Date().toLocaleString("en-US", { timeZone: "America/Chicago" });
	const now = new Date(nowStr);
	const deadline = new Date(weekEndDate + "T18:30:00");
	return now > deadline;
}`;
function oldAfterDeadlineAt(weekEndDate, nowMs, DateImpl) {
	const D = DateImpl || class extends Date {
		constructor(...a) { return a.length ? new Date(...a) : new Date(nowMs); }
	};
	return new Function("Date", `${OLD_IS_AFTER_DEADLINE_SRC}\nreturn isAfterDeadline;`)(D)(weekEndDate);
}
// The pre-fix one-active-job block: excludes the caller's ROW, never their LOAD.
const OLD_ACTIVE_JOB_BLOCK = `		if (/^at shipper$/i.test(newStatus)) {
			const driverCol = headers.findIndex((h) => /driver/i.test(h));
			if (driverCol !== -1) {
				const activeRe = /^(heading to shipper|at shipper|loading|in transit|at receiver)$/i;
				const driverNameNorm = normalizeDriverName(driverName);
				const hasActive = dataRows.some((row, i) => {
					const rIdx = i + 2;
					if (rIdx === rowIndex) return false;
					const drv = normalizeDriverName(row[driverCol]);
					const sts = (row[statusIdx] || "").trim();
					return drv === driverNameNorm && activeRe.test(sts);
				});
				if (hasActive) {
					return res.status(409).json({
						code: "ACTIVE_JOB_CONFLICT",
						error: "You already have an active job. Complete it before starting another.",
					});
				}
			}
		}`;
const oldActiveJobGuard = makeActiveJobGuard(OLD_ACTIVE_JOB_BLOCK);

// -------------------------------------------------------------------- runner
let pass = 0, fail = 0;
const failures = [];
const CHILD = process.env.INVOICE_TZ_CHILD === "1";
function check(label, got, want) {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (ok) { pass++; if (!CHILD) console.log(`  ok   ${label}`); }
	else {
		fail++;
		failures.push(`  FAIL ${label}\n     got:  ${JSON.stringify(got)}\n     want: ${JSON.stringify(want)}`);
		if (!CHILD) console.log(`  FAIL ${label}`);
	}
}
function section(t) { if (!CHILD) console.log(`\n${t}\n`); }

// The real 26-column Job Tracking header row, so /load.?id|job.?id/i and
// /driver/i resolve the same columns the shipped route resolves.
const PROD_HEADERS = ["Contract ID", "Load ID", "Broker Contact Name", "Broker Phone", "Driver",
	"Truck", "Trailer", "Owner ID", "Pickup Location", "Delivery Location", "Pickup Date",
	"Job Status", "  Payment  ", "Rate Per Mile", "Distance", "Notes", "Broker Email",
	"Pickup Ref", "Delivery Ref", "Commodity", "Assigned Date", "Status Update Date",
	"Completion Date", "Weight", "Equipment", "Miles"];
const LOAD_ID = PROD_HEADERS.indexOf("Load ID");
const STATUS = PROD_HEADERS.indexOf("Job Status");
const DRIVER = PROD_HEADERS.indexOf("Driver");
const row = (loadId, driver, status) => {
	const r = new Array(PROD_HEADERS.length).fill("");
	r[LOAD_ID] = loadId; r[DRIVER] = driver; r[STATUS] = status;
	return r;
};

// A day-key corpus that covers every shape the two bugs live on.
const DAYS = [];
for (let t = Date.UTC(2024, 0, 1); t <= Date.UTC(2028, 11, 31); t += 86400000) {
	DAYS.push(new Date(t).toISOString().slice(0, 10));
}
const weekOf = (ymd) => generateInvoiceNumber("Shorn King", ymd).replace(/^INV-SK-/, "").replace(/-\d+$/, "");

// ============================================================ CHILD MODE
// Sections 3 and 4 re-run this file under other timezones. In child mode it
// prints one JSON line and exits, so the parent can require byte-identity.
if (CHILD) {
	const out = {
		weeks: DAYS.map(weekOf),
		// The PRE-FIX arithmetic, evaluated in this child's frame. Emitting it here
		// rather than computing it in the parent is what makes both the
		// no-restatement proof and the discrimination proof independent of whatever
		// zone the person running this suite happens to be in — the pre-fix bug is
		// invisible in UTC and in every POSITIVE-offset zone, so a parent-frame
		// comparison silently proves nothing on a Tokyo or a Manila laptop.
		oldWeeks: DAYS.map(oldInvoiceWeek),
		numbers: ["2026-08-08", "2026-01-03", "2025-12-27"].map((d) => generateInvoiceNumber("Shorn King", d)),
		// Friday 2026-08-07 18:30 CT is 2026-08-07T23:30Z. One minute either side.
		deadline: [
			afterDeadlineAt("2026-08-07", Date.parse("2026-08-07T23:29:00Z")),
			afterDeadlineAt("2026-08-07", Date.parse("2026-08-07T23:31:00Z")),
			// ...and across both 2026 DST transitions.
			afterDeadlineAt("2026-03-13", Date.parse("2026-03-13T23:29:00Z")),
			afterDeadlineAt("2026-03-13", Date.parse("2026-03-14T00:31:00Z")),
			afterDeadlineAt("2026-11-06", Date.parse("2026-11-07T00:29:00Z")),
			afterDeadlineAt("2026-11-07", Date.parse("2026-11-07T00:31:00Z")),
		],
	};
	process.stdout.write(JSON.stringify(out));
	process.exit(0);
}

// ==================================================== 1. the db-download guard
section("1. GET /api/db/download carries the money-tier CSRF guard");

const dbDownloadLine = SRC.split("\n").find(
	(l) => l.startsWith("app.get(") && l.includes('"/api/db/download"'));
check("route registered: GET /api/db/download", Boolean(dbDownloadLine), true);
check("refuseCrossOrigin is mounted on it",
	Boolean(dbDownloadLine) && dbDownloadLine.includes("refuseCrossOrigin"), true);
// The TIER matters, not merely "a guard": refuseCrossSite tolerates
// Sec-Fetch-Site: same-site, so a sibling-subdomain XSS would still walk off with
// the whole database. This asserts nobody downgrades it later.
check("...and it is NOT the looser cost tier",
	Boolean(dbDownloadLine) && !/refuseCrossSite/.test(dbDownloadLine), true);
check("requireRole precedes the guard (a 403 must not spend the limiter)",
	Boolean(dbDownloadLine)
		&& dbDownloadLine.indexOf("requireRole") < dbDownloadLine.indexOf("refuseCrossOrigin"), true);
check("the guard precedes dbAdminLimiter, matching the fuel-gallons convention",
	Boolean(dbDownloadLine)
		&& dbDownloadLine.indexOf("refuseCrossOrigin") < dbDownloadLine.indexOf("dbAdminLimiter"), true);
// The temp copy is a full ~313 MB dump of every SSN and account number. res.download's
// callback fires on EVERY terminal outcome including an aborted transfer (express
// sendfile: onaborted/onerror/onend all route into it), so the unlink covers the
// abort path — but only while it stays unconditional on the error argument.
const dbDownloadBody = extractAt('\napp.get("/api/db/download"', "GET /api/db/download route");
check("the temp copy is unlinked on completion AND on abort",
	/res\.download\(tmpPath, "app\.db", \(\) => \{\s*try \{ fs\.unlinkSync\(tmpPath\); \} catch \{\}\s*\}\)/.test(dbDownloadBody), true);
check("...and on a backup failure before any transfer starts",
	/\.catch\(\(err\) => \{\s*try \{ fs\.unlinkSync\(tmpPath\); \} catch \{\}/.test(dbDownloadBody), true);
check("the temp copy is written to os.tmpdir(), never the repo tree",
	/path\.join\(os\.tmpdir\(\), `app_backup-/.test(dbDownloadBody), true);
// The other two /api/db/* routes are reads of bounded size and are deliberately
// NOT given the guard — it is the COST, not the verb, that decides. Pinned so a
// later "consistency" sweep is a deliberate choice rather than a drive-by.
for (const r of ["/api/db/tables", "/api/db/query/:table"]) {
	const line = SRC.split("\n").find((l) => l.startsWith("app.get(") && l.includes(`"${r}"`));
	check(`${r} is still registered`, Boolean(line), true);
	check(`...and deliberately does NOT carry refuseCrossOrigin`,
		Boolean(line) && !line.includes("refuseCrossOrigin"), true);
}

// ================================================== 2. the invoice number shape
section("2. generateInvoiceNumber() still produces the shape everything keys on");

check("full number, initials + week + sequence",
	generateInvoiceNumber("Shorn King", "2026-08-08"), "INV-SK-2026W32-01");
check("three initials max", generateInvoiceNumber("Mary Jane Watson Parker", "2026-08-08"), "INV-MJW-2026W32-01");
check("punctuation is stripped from initials", generateInvoiceNumber("O'Brien", "2026-08-08"), "INV-O-2026W32-01");
check("a slash in a name cannot reach the PDF path",
	/[/\\]/.test(generateInvoiceNumber("a/b c/d", "2026-08-08")), false);

// ============================== 3. the invoice number does not depend on the zone
section("3. ...and it is the SAME number in every timezone — and the same one as today");

// (a) The frames must agree. Under the pre-fix code they did not.
const ZONES = ["UTC", "America/Chicago", "America/New_York", "Asia/Tokyo", "Europe/Berlin", "Pacific/Auckland"];
const runChild = (tz) => JSON.parse(execFileSync(process.execPath, [__filename], {
	env: { ...process.env, TZ: tz, INVOICE_TZ_CHILD: "1" }, maxBuffer: 1 << 28,
}).toString());
const perZone = {};
for (const z of ZONES) perZone[z] = runChild(z);
for (const z of ZONES.slice(1)) {
	check(`week identity is byte-identical under TZ=${z} (${DAYS.length} days)`,
		perZone[z].weeks.join(","), perZone.UTC.weeks.join(","));
	check(`...and so are the full invoice numbers under TZ=${z}`,
		perZone[z].numbers.join(","), perZone.UTC.numbers.join(","));
}

// (b) ⚠️ THE FIX MUST NOT RESTATE HISTORY. Production runs UTC, so every number
// already minted must still be reproducible. Assert the fix's output equals the
// PRE-FIX output evaluated in the UTC frame, on every day in the corpus.
const restated = DAYS.filter((d, i) => perZone.UTC.weeks[i] !== perZone.UTC.oldWeeks[i]);
check(`no existing invoice number changes (checked on all ${DAYS.length} days)`, restated, []);

// (c) DISCRIMINATION, in a NAMED frame. The pre-fix bug is invisible in UTC and
// in every positive-offset zone (local midnight Jan 1 lands BEFORE the UTC
// midnight being measured, so the day count is unchanged) — it only bites in the
// Americas, which is precisely where a LogisX laptop is. America/Chicago is
// therefore the frame this is asserted in, not the runner's own.
const CHI = perZone["America/Chicago"];
const divergedDays = DAYS.filter((d, i) => CHI.oldWeeks[i] !== CHI.weeks[i]);
check("MUTANT: under TZ=America/Chicago the pre-fix code mints a different week",
	divergedDays.length > 0, true);
check("MUTANT: ...on Sundays (the bulk of them)",
	divergedDays.filter((d) => new Date(d + "T12:00:00Z").getUTCDay() === 0).length > 100, true);
check("MUTANT: ...and on every Jan 1, where the YEAR itself moves",
	divergedDays.filter((d) => d.endsWith("-01-01")).length, 5);
check("MUTANT: 2026-01-01 reads 2025W53 under the pre-fix code in Chicago",
	CHI.oldWeeks[DAYS.indexOf("2026-01-01")], "2025W53");
check("...where the fix reads 2026W01, the same as production",
	CHI.weeks[DAYS.indexOf("2026-01-01")], "2026W01");
check("MUTANT: 2026-08-09 (a Sunday) reads 2026W32 under the pre-fix code in Chicago",
	CHI.oldWeeks[DAYS.indexOf("2026-08-09")], "2026W32");
// Named, so the report is reproducible regardless of the runner's own zone.
check("the fix reads 2026-01-01 as 2026W01 (production's answer)", weekOf("2026-01-01"), "2026W01");
check("the fix reads 2026-08-09 (a Sunday) as 2026W33", weekOf("2026-08-09"), "2026W33");
check("the fix reads 2026-08-08 (its Saturday) as 2026W32", weekOf("2026-08-08"), "2026W32");

// ==================================================== 4. the submission deadline
section("4. isAfterDeadline() is Friday 18:30 America/Chicago, whatever the server");

// Friday 2026-08-07 18:30:00 CDT === 2026-08-07T23:30:00Z.
check("one minute before the cutoff is not late",
	afterDeadlineAt("2026-08-07", Date.parse("2026-08-07T23:29:00Z")), false);
check("one minute after the cutoff is late",
	afterDeadlineAt("2026-08-07", Date.parse("2026-08-07T23:31:00Z")), true);
check("the cutoff second itself is not yet late",
	afterDeadlineAt("2026-08-07", Date.parse("2026-08-07T23:30:00Z")), false);
// CST (UTC-6) in winter: 2026-01-09 18:30 CST === 2026-01-10T00:30:00Z.
check("winter (CST) — one minute before",
	afterDeadlineAt("2026-01-09", Date.parse("2026-01-10T00:29:00Z")), false);
check("winter (CST) — one minute after",
	afterDeadlineAt("2026-01-09", Date.parse("2026-01-10T00:31:00Z")), true);
check("a week ending days ago is late", afterDeadlineAt("2026-07-31", Date.parse("2026-08-07T12:00:00Z")), true);
check("a week ending days ahead is not", afterDeadlineAt("2026-08-14", Date.parse("2026-08-07T12:00:00Z")), false);
// Malformed input kept its pre-fix answer: Invalid Date compared false ("not late").
check("a malformed week end is not late (unchanged from the pre-fix answer)",
	afterDeadlineAt("not-a-date", Date.parse("2030-01-01T00:00:00Z")), false);
check("...and neither is an empty one", afterDeadlineAt("", Date.parse("2030-01-01T00:00:00Z")), false);
for (const z of ZONES.slice(1)) {
	check(`the same verdicts under TZ=${z}`, perZone[z].deadline.join(","), perZone.UTC.deadline.join(","));
}

// DISCRIMINATION. The old form's verdict is a function of what the runtime's ICU
// emits, because it RE-PARSES its own formatted output. ICU 72 (Node 18.13+)
// began rendering en-US with U+202F before AM/PM; on a V8 that rejects it the
// expression yields Invalid Date and `Invalid > deadline` is false — so the
// cutoff never fires and every invoice reads on time, with no error anywhere.
// Modelled by a Date whose toLocaleString returns something unparseable.
class HostileLocaleDate extends Date {
	constructor(...a) { super(...(a.length ? a : [Date.parse("2026-08-07T23:59:00Z")])); }
	toLocaleString() { return "   nonsense  "; }
}
check("MUTANT: the pre-fix form silently reads 'not late' when it cannot re-parse its own output",
	oldAfterDeadlineAt("2026-08-07", 0, HostileLocaleDate), false);
check("...while the fix is unaffected, because it never re-parses a formatted string",
	afterDeadlineAt("2026-08-07", 0, HostileLocaleDate), true);
check("the shipped isAfterDeadline no longer calls toLocaleString at all",
	/toLocaleString/.test(ISO_AFTER_DEADLINE_SRC), false);
check("...and uses the file's existing Intl/formatToParts convention",
	/Intl\.DateTimeFormat[\s\S]*formatToParts/.test(ISO_AFTER_DEADLINE_SRC), true);

// ============================================ 5. the false ACTIVE_JOB_CONFLICT
section("5. PUT /api/driver/status does not 409 a driver off their own load");

const AT_SHIPPER = "At Shipper";
// ⚠️ THE FIXTURE IS THE BUG. `dataRows` comes from readJobTrackingSnapshot(),
// the RAW whole-tab read — deduplicateLoads() has NOT run — so two live rows for
// one load id are present by construction. Row 2 is the caller's; row 3 is a
// second copy of the SAME load, same driver, already In Transit.
const dupRows = [
	row("562620213", "Shorn King", "Dispatched"),
	row("562620213", "Shorn King", "In Transit"),
];
check("a duplicate row for the caller's OWN load no longer conflicts",
	activeJobGuard({
		headers: PROD_HEADERS, dataRows: dupRows, rowIndex: 2, loadId: "562620213",
		driverName: "Shorn King", statusIdx: STATUS, newStatus: AT_SHIPPER,
	}), null);
// DISCRIMINATION: the pre-fix block 409s on that identical fixture.
check("MUTANT: the pre-fix block 409s on the same fixture",
	(oldActiveJobGuard({
		headers: PROD_HEADERS, dataRows: dupRows, rowIndex: 2, loadId: "562620213",
		driverName: "Shorn King", statusIdx: STATUS, newStatus: AT_SHIPPER,
	}) || {}).code, 409);

// The '#' spelling is how a duplicate usually arises (Job Tracking stores both
// "513987502" and "#513987502"), so a raw string compare would miss exactly the
// common case. This is why the skip runs through normLoadKey().
const hashRows = [
	row("562620213", "Shorn King", "Dispatched"),
	row("#562620213", "Shorn King", "In Transit"),
];
check("...including when the duplicate is spelled with a leading '#'",
	activeJobGuard({
		headers: PROD_HEADERS, dataRows: hashRows, rowIndex: 2, loadId: "562620213",
		driverName: "Shorn King", statusIdx: STATUS, newStatus: AT_SHIPPER,
	}), null);
// ...and with the spellings the other way round, so the '#' is on the row being
// SKIPPED rather than the row being written. The active copy has to be the OTHER
// row for this to test anything, which is why it is its own fixture.
const hashRowsRev = [
	row("#562620213", "Shorn King", "In Transit"),
	row("562620213", "Shorn King", "Dispatched"),
];
check("...and the reverse spelling too",
	activeJobGuard({
		headers: PROD_HEADERS, dataRows: hashRowsRev, rowIndex: 3, loadId: "562620213",
		driverName: "Shorn King", statusIdx: STATUS, newStatus: AT_SHIPPER,
	}), null);
check("MUTANT: the pre-fix block 409s on the reverse spelling too",
	(oldActiveJobGuard({
		headers: PROD_HEADERS, dataRows: hashRowsRev, rowIndex: 3, loadId: "562620213",
		driverName: "Shorn King", statusIdx: STATUS, newStatus: AT_SHIPPER,
	}) || {}).code, 409);

// ⚠️ THE GUARD MUST STILL GUARD. A genuinely different load, same driver, active
// -> 409. If this ever passes as null the fix has been widened into a removal.
const realConflict = [
	row("562620213", "Shorn King", "Dispatched"),
	row("999888777", "Shorn King", "In Transit"),
];
check("a genuine SECOND load still 409s",
	(activeJobGuard({
		headers: PROD_HEADERS, dataRows: realConflict, rowIndex: 2, loadId: "562620213",
		driverName: "Shorn King", statusIdx: STATUS, newStatus: AT_SHIPPER,
	}) || {}).code, 409);
check("...with the code the driver app already handles",
	(activeJobGuard({
		headers: PROD_HEADERS, dataRows: realConflict, rowIndex: 2, loadId: "562620213",
		driverName: "Shorn King", statusIdx: STATUS, newStatus: AT_SHIPPER,
	}) || {}).body.code, "ACTIVE_JOB_CONFLICT");
check("a genuine second load conflicts under the pre-fix block too (no behaviour lost)",
	(oldActiveJobGuard({
		headers: PROD_HEADERS, dataRows: realConflict, rowIndex: 2, loadId: "562620213",
		driverName: "Shorn King", statusIdx: STATUS, newStatus: AT_SHIPPER,
	}) || {}).code, 409);

// Another DRIVER's active load is not this driver's conflict, duplicated or not.
check("another driver's active load is irrelevant",
	activeJobGuard({
		headers: PROD_HEADERS,
		dataRows: [row("562620213", "Shorn King", "Dispatched"), row("999888777", "Howard Reddie", "In Transit")],
		rowIndex: 2, loadId: "562620213", driverName: "Shorn King",
		statusIdx: STATUS, newStatus: AT_SHIPPER,
	}), null);
// Name normalisation is unchanged — a spacing/case variant of the SAME driver on
// a DIFFERENT load must still conflict, or the fix would have widened by accident.
check("a case/spacing variant of the same driver on another load still conflicts",
	(activeJobGuard({
		headers: PROD_HEADERS,
		dataRows: [row("562620213", "Shorn King", "Dispatched"), row("999888777", "  shorn   KING ", "Loading")],
		rowIndex: 2, loadId: "562620213", driverName: "Shorn King",
		statusIdx: STATUS, newStatus: AT_SHIPPER,
	}) || {}).code, 409);

// A blank load id must NOT make the skip swallow every id-less row. It cannot
// happen through the route (resolveLoadBinding rung 1 refuses a blank id first),
// which is exactly why the guard is asserted rather than assumed.
check("a blank caller load id does not disable the guard",
	(activeJobGuard({
		headers: PROD_HEADERS,
		dataRows: [row("", "Shorn King", "Dispatched"), row("", "Shorn King", "In Transit")],
		rowIndex: 2, loadId: "", driverName: "Shorn King",
		statusIdx: STATUS, newStatus: AT_SHIPPER,
	}) || {}).code, 409);
// A row carrying no load id is not "the caller's own load" and stays in the scan.
check("an id-less active row still conflicts",
	(activeJobGuard({
		headers: PROD_HEADERS,
		dataRows: [row("562620213", "Shorn King", "Dispatched"), row("", "Shorn King", "At Receiver")],
		rowIndex: 2, loadId: "562620213", driverName: "Shorn King",
		statusIdx: STATUS, newStatus: AT_SHIPPER,
	}) || {}).code, 409);

// Every non-"At Shipper" transition bypasses the block entirely, unchanged.
for (const st of ["In Transit", "Delivered", "Loading", "At Receiver"]) {
	check(`"${st}" never reaches the one-active-job scan`,
		activeJobGuard({
			headers: PROD_HEADERS, dataRows: realConflict, rowIndex: 2, loadId: "562620213",
			driverName: "Shorn King", statusIdx: STATUS, newStatus: st,
		}), null);
}
// A sheet with no Driver column cannot judge the rule; it is skipped, as before.
check("no Driver column — the scan is skipped, not guessed",
	activeJobGuard({
		headers: PROD_HEADERS.map((h) => (/driver/i.test(h) ? "Operator" : h)),
		dataRows: realConflict, rowIndex: 2, loadId: "562620213",
		driverName: "Shorn King", statusIdx: STATUS, newStatus: AT_SHIPPER,
	}), null);

// The shipped block must resolve the id column the same way every other load
// lookup does, and must not have quietly reverted to a row-index-only skip.
check("the shipped scan skips on the LOAD ID, not only the row index",
	/normLoadKey\(\(row \|\| \[\]\)\[loadIdIdx\]\) === callerLoadKey/.test(ACTIVE_JOB_BLOCK), true);
check("...and resolves the id column with the app-wide header regex",
	/loadIdIdx = headers\.findIndex\(\(h\) => \/load\.\?id\|job\.\?id\/i\.test\(h\)\)/.test(ACTIVE_JOB_BLOCK), true);
check("...and keeps the row-index skip as well",
	/if \(rIdx === rowIndex\) return false;/.test(ACTIVE_JOB_BLOCK), true);

// ------------------------------------------------------------------- verdict
console.log("\n" + "=".repeat(60));
if (fail) {
	console.log(`FAILURES (${fail}):`);
	for (const f of failures) console.log(f);
	console.log(`\n${pass} passed, ${fail} failed`);
	process.exit(1);
}
console.log(`ALL PASS\n${pass} passed, 0 failed`);
