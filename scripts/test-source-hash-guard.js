#!/usr/bin/env node
// `sourceHash` must not be a way to burn a receipt hash, and DUPLICATE_RECEIPT
// must not be a cross-driver oracle.
//
// WHY THIS EXISTS. POST /api/expenses accepts `sourceHash` from any authenticated
// non-Investor, validates it only as 64 hex characters, and writes it VERBATIM as
// `receipt_hash` — it is never checked against the bytes received, and it cannot
// be: the whole reason it exists is that the stored payload is no longer
// byte-stable (bulk images go through ScanKit, which silently falls back to the
// raw image when it is down or out of credits, so hashing the server-side payload
// alone would let the same receipt back in under a new hash and double-book the
// P&L). Once idx_expenses_receipt_hash became UNIQUE, that made a payload-less
// `sourceHash` a PERMANENT BURN: pre-register a hash and the receipt's real filer
// gets a hard 409 DUPLICATE_RECEIPT with no race to rescue them and no way to file
// the expense at all.
//
// ⚠️ "JUST IGNORE sourceHash" IS NOT THE FIX and would re-open the double-booking
// above. The fix is that it is honoured ONLY when a `data:` payload accompanies it
// — which bulk upload always sends (BulkReceiptScan.saveOne posts `photoData`
// beside it) and which a payload-less pre-registration by definition cannot.
//
// The second half is the DUPLICATE_RECEIPT lookup, which was fleet-wide: any
// authenticated caller could probe an arbitrary hash and be told whether it is
// booked AND the expense id holding it. It is now scoped to the filing driver,
// exactly as the POSSIBLE_DUPLICATE check beside it already was.
//
// ⚠️ THE PAIRED CLAIM THIS FILE MUST PROVE, or the scoping reads as a weakening:
// scoping narrows the MESSAGE, never the ENFORCEMENT. idx_expenses_receipt_hash
// is UNIQUE over `receipt_hash <> ''` FLEET-WIDE, so a cross-driver collision is
// still refused — it just arrives via the constraint instead of the pre-check.
// Section 4 runs the real index text from server.js to show that.
//
// The guard is EXTRACTED from server.js and executed, never reimplemented. No
// network, no sheet; an in-memory SQLite, and app.db is never opened.
//
//   node scripts/test-source-hash-guard.js     # exits 1 on any failure

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Database = require("better-sqlite3");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");

let pass = 0, fail = 0;
const failures = [];
function check(label, actual, expected) {
	const a = JSON.stringify(actual), e = JSON.stringify(expected);
	if (a === e) { pass++; return; }
	fail++;
	failures.push(`  ${label}\n      expected ${e}\n      actual   ${a}`);
}
function section(t) { console.log(`\n${t}`); }
function guarded(label, fn) {
	try { fn(); } catch (err) { fail++; failures.push(`  ${label}\n      threw: ${err.message}`); }
}

// ── extraction ──────────────────────────────────────────────────────────────
// The receipt-hash decision, lifted verbatim out of the POST /api/expenses
// handler between two anchors whose occurrence count is asserted — so a refactor
// that moves or renames either end fails the run rather than silently testing
// nothing.
const HASH_BLOCK_START = '\n\t\tlet receiptHash = "";\n';
const HASH_BLOCK_END = "\n\t\tif (sourceHash) receiptHash = sourceHash;\n";
function extractHashBlock() {
	const starts = SRC.split(HASH_BLOCK_START).length - 1;
	const ends = SRC.split(HASH_BLOCK_END).length - 1;
	if (starts !== 1 || ends !== 1) {
		throw new Error(`expected exactly 1 receipt-hash block, found ${starts} start / ${ends} end anchors`);
	}
	const i = SRC.indexOf(HASH_BLOCK_START);
	const j = SRC.indexOf(HASH_BLOCK_END);
	if (j < i) throw new Error("receipt-hash block anchors are out of order");
	return SRC.slice(i + 1, j + HASH_BLOCK_END.length);
}
const HASH_BLOCK = extractHashBlock();

// The winner re-read from the UNIQUE-constraint catch path — the SECOND door onto
// the same oracle. Pulled out as SQL text and executed below, so this is the
// shipped query and not a paraphrase of it.
function extractWinnerSql() {
	const at = SRC.indexOf("Name the winner if we can");
	if (at < 0) throw new Error("the constraint-path winner re-read was not found");
	const m = /`(\s*SELECT id FROM expenses[\s\S]*?)`/.exec(SRC.slice(at, at + 2500));
	if (!m) throw new Error("could not extract the winner SELECT");
	return m[1];
}
const WINNER_SQL = extractWinnerSql();

// A named function's source, anchored on a newline + `function name(` so a mention
// in a comment or at a call site cannot be mistaken for the definition. The hit
// count is asserted, so a rename fails the run instead of silently extracting
// nothing. Used by section 3b to run the shipped migration predicate.
function extractFn(name) {
	const needle = `\nfunction ${name}(`;
	const hits = SRC.split(needle).length - 1;
	if (hits !== 1) throw new Error(`expected exactly 1 definition of ${name}() in server.js, found ${hits}`);
	const start = SRC.indexOf(needle) + 1;
	let depth = 0;
	for (let j = SRC.indexOf("{", start); j < SRC.length; j++) {
		if (SRC[j] === "{") depth++;
		else if (SRC[j] === "}") { depth--; if (depth === 0) return SRC.slice(start, j + 1); }
	}
	throw new Error(`unbalanced braces extracting ${name}()`);
}

// The UNIQUE-index migration's collision pre-flight, as SQL text, so section 3b
// runs the shipped query rather than a paraphrase of the condition that decides
// whether the migration SKIPS.
const PREFLIGHT_SQL = (() => {
	const m = /db\.prepare\(`(\s*SELECT receipt_hash, COUNT\(\*\) AS n[\s\S]*?HAVING n > 1\s*)`\)/.exec(SRC);
	if (!m) throw new Error("the receipt_hash migration pre-flight SELECT was not found");
	return m[1];
})();

// The UNIQUE index definition. ⚠️ READ ONLY — scripts/test-duplicate-guard.js pins
// this constant's text and executes it; nothing here may change it.
function extractIdxCols() {
	const m = /const RECEIPT_HASH_IDX_COLS = `([^`]+)`/.exec(SRC);
	if (!m) throw new Error("RECEIPT_HASH_IDX_COLS not found");
	return m[1];
}
const IDX_COLS = extractIdxCols();

// ── 1. source contract ──────────────────────────────────────────────────────
section("1. the gate and the scoping are present in the shipped source");

// ⚠️ THE HEADLINE. `receiptHash &&` is the whole fix: it is non-empty EXACTLY when
// a `data:` payload with a non-empty body arrived and was hashed, so it is the one
// predicate that cannot drift from "a payload came with this request".
check("sourceHash is gated on a payload having been received",
	/const sourceHash = receiptHash && \/\^\[a-f0-9\]\{64\}\$\/i\.test\(/.test(HASH_BLOCK), true);
// PAIRED — the hex validation must still be there. A gate that replaced the
// format check rather than joining it would accept arbitrary text into a UNIQUE
// column.
check("...and the 64-hex format check is still applied", /\[a-f0-9\]\{64\}/.test(HASH_BLOCK), true);
check("...and the value is still lowercased before use",
	/\.trim\(\)\.toLowerCase\(\)/.test(HASH_BLOCK), true);

check("the DUPLICATE_RECEIPT pre-check is scoped to the filing driver",
	/LOWER\(TRIM\(COALESCE\(driver, ''\)\)\) = LOWER\(TRIM\(\?\)\)/.test(HASH_BLOCK), true);
check("the constraint-path winner re-read is scoped the same way",
	/LOWER\(TRIM\(COALESCE\(driver, ''\)\)\) = LOWER\(TRIM\(\?\)\)/.test(WINNER_SQL), true);
// ⚠️ ONE PREDICATE, TWO DOORS. If the two ever disagree, the narrower one is
// decorative — the caller simply takes the other route to the same id.
check("...using the IDENTICAL predicate, so one door cannot be wider than the other",
	(HASH_BLOCK.match(/LOWER\(TRIM\(COALESCE\(driver, ''\)\)\) = LOWER\(TRIM\(\?\)\)/g) || []).length >= 1
		&& (WINNER_SQL.match(/LOWER\(TRIM\(COALESCE\(driver, ''\)\)\) = LOWER\(TRIM\(\?\)\)/g) || []).length >= 1, true);

// ⚠️ THE SECOND QUERY — the one that makes the refusal independent of the index.
// It must be FLEET-WIDE (no driver predicate) and must select no id, so there is
// nothing for a later edit to put on the wire by accident.
{
	const m = /`SELECT 1 FROM expenses[\s\S]*?`/.exec(HASH_BLOCK);
	check("a fleet-wide existence test exists beside the scoped one", Boolean(m), true);
	check("...it is scoped to NOTHING but the hash", Boolean(m) && /driver/.test(m[0]), false);
	// ⚠️ `SELECT 1`, never `SELECT id`. The oracle this batch removed was "tell me
	// WHICH expense holds this hash"; a boolean cannot answer it, and a query that
	// never loads the id cannot be made to leak it by a careless response edit.
	check("...and it selects the literal 1, not an id", Boolean(m) && /^`SELECT 1 /.test(m[0]), true);
	check("...and it is bounded", Boolean(m) && /LIMIT 1/.test(m[0]), true);
}
// PAIRED — the two must be separate statements, or "narrow the message, wide the
// enforcement" collapses back into one query that has to do both.
check("the pre-check and the existence test are two separate queries",
	(HASH_BLOCK.match(/db\s*\n?\s*\.prepare\(|db\.prepare\(/g) || []).length >= 2, true);

// The model this copies. Asserted so a future edit that "simplifies" one of them
// is visible as a divergence from the check that was always right.
check("POSSIBLE_DUPLICATE (the model) still scopes to one driver",
	/AND LOWER\(TRIM\(COALESCE\(driver, ''\)\)\) = LOWER\(TRIM\(\?\)\)/.test(SRC), true);

// ⚠️ REQUIRED-ABSENT: the index must stay FLEET-WIDE. Scoping the SELECTs is only
// safe because the constraint is not scoped; adding `driver` to the index would
// turn a message change into a real weakening and make the same receipt bookable
// once per driver.
check("the UNIQUE index is still on receipt_hash alone, not (driver, receipt_hash)",
	IDX_COLS, "expenses(receipt_hash) WHERE receipt_hash <> ''");

// ⚠️ THE CLIENT MUST NOT CLAIM A HASH IT IS NOT BACKING WITH BYTES. The server
// drops a payload-less `sourceHash` (that is the fix), and the drop is silent — so
// a client that sends one anyway loses byte-dedupe on that row without saying so.
// BulkReceiptScan's three processRow failure paths leave `photoData` '' while
// `fileHash` is already set, and such a row is still savable (saveAll validates
// driver/amount/date only), so this is reachable rather than theoretical.
{
	const VUE = fs.readFileSync(
		path.join(ROOT, "client/src/components/dashboard/expenses/BulkReceiptScan.vue"), "utf8");
	check("the bulk client sends sourceHash only when it has a payload",
		/sourceHash: row\.photoData \? \(row\.fileHash \|\| ''\) : '',/.test(VUE), true);
	// PAIRED — and it must still send the payload beside it, or the gate drops
	// every hash and the feature is off.
	check("...and still sends photoData on the same request",
		/photoData: row\.photoData \|\| '',/.test(VUE), true);
}

// ── 2. behaviour of the extracted block ─────────────────────────────────────
section("2. behaviour (the real extracted block, in-memory db)");

const db = new Database(":memory:");
db.exec(`CREATE TABLE expenses (
	id INTEGER PRIMARY KEY AUTOINCREMENT, driver TEXT DEFAULT '', amount REAL DEFAULT 0,
	date TEXT DEFAULT '', receipt_hash TEXT DEFAULT '')`);

function buildRunner(src) {
	const body = src || HASH_BLOCK;
	return new Function("db", "crypto", "req", "photoData", "driver", "res",
		`${body}\n return { ok: true, receiptHash, sourceHash, hashCandidates };`);
}
// res.status(409).json(x) is the block's only early exit; this turns it into a
// value the caller can inspect instead of a written response.
const RES = { status(code) { return { json(body) { return { ok: false, code, body }; } }; } };

const dataUrl = (text) => `data:image/jpeg;base64,${Buffer.from(text).toString("base64")}`;
const payloadHash = (text) => crypto.createHash("sha256").update(Buffer.from(text).toString("base64")).digest("hex");
const HEX_A = "a".repeat(64);
const HEX_B = "b".repeat(64);

const run = (opts, runner) => (runner || buildRunner())(
	db, crypto, { body: { sourceHash: opts.sourceHash } }, opts.photoData, opts.driver, RES);

guarded("sections 2-5 ran", () => {
	// ── the burn primitive ──────────────────────────────────────────────────
	// ⚠️ THE ASSERTION THIS FILE EXISTS FOR. A hash with no payload behind it must
	// reach `receipt_hash` as '' — and '' is outside the PARTIAL unique index
	// (`WHERE receipt_hash <> ''`), so it constrains nothing and burns nothing.
	for (const [label, photoData] of [
		["absent", undefined],
		["empty string", ""],
		["an existing path, not a data URI", "/uploads/expense-receipts/1754000000000-abc123def456.jpg"],
		["a data: URI with an empty body", "data:image/jpeg;base64,"],
		["a non-string", 12345],
	]) {
		const r = run({ sourceHash: HEX_A, photoData, driver: "shorn king" });
		check(`BURN: sourceHash with no payload (${label}) is IGNORED`,
			[r.ok, r.sourceHash, r.receiptHash, r.hashCandidates], [true, "", "", []]);
	}

	// PAIRED — and this is the half that keeps the fix from being "delete the
	// feature". Bulk sends BOTH, and the client's hash must still win, because the
	// stored payload is not byte-stable.
	const bulkPayload = dataUrl("scankit-enhanced-bytes");
	{
		const r = run({ sourceHash: HEX_A, photoData: bulkPayload, driver: "shorn king" });
		check("BULK: payload + hash -> the CLIENT's hash is what gets stored",
			[r.ok, r.sourceHash, r.receiptHash], [true, HEX_A, HEX_A]);
		// ⚠️ And it must genuinely differ from the payload hash, or this case proves
		// nothing: that difference IS the ScanKit instability the feature exists for.
		check("...and it is NOT the payload's own hash", r.receiptHash === payloadHash("scankit-enhanced-bytes"), false);
		// Both hashes are probed, so a receipt logged before sourceHash existed is
		// still recognised.
		check("...while BOTH hashes are still checked for a duplicate",
			r.hashCandidates.slice().sort(), [HEX_A, payloadHash("scankit-enhanced-bytes")].sort());
	}
	// A payload with no sourceHash keeps the original behaviour exactly.
	{
		const r = run({ sourceHash: "", photoData: bulkPayload, driver: "shorn king" });
		check("PAYLOAD ONLY: the server's own payload hash is stored, unchanged",
			[r.ok, r.sourceHash, r.receiptHash], [true, "", payloadHash("scankit-enhanced-bytes")]);
	}
	// A malformed sourceHash is dropped even WITH a payload — the gate joins the
	// format check, it does not replace it.
	{
		const r = run({ sourceHash: "not-a-hash", photoData: bulkPayload, driver: "shorn king" });
		check("a malformed sourceHash is still dropped when a payload IS present",
			[r.sourceHash, r.receiptHash], ["", payloadHash("scankit-enhanced-bytes")]);
	}

	// ── the cross-driver oracle ─────────────────────────────────────────────
	db.prepare("DELETE FROM expenses").run();
	db.prepare("INSERT INTO expenses (id, driver, amount, date, receipt_hash) VALUES (?, ?, ?, ?, ?)")
		.run(4242, "shorn king", 500, "2026-06-03", HEX_B);

	{
		// A different driver probing the same hash: REFUSED, but told nothing about
		// whose row it is. The scoped SELECT declines to name it and the fleet-wide
		// boolean beside it decides the refusal.
		const r = run({ sourceHash: HEX_B, photoData: bulkPayload, driver: "howard reddie" });
		check("ORACLE: another driver is still REFUSED", [r.ok, r.code, r.body.code],
			[false, 409, "DUPLICATE_RECEIPT"]);
		check("...but the response carries NO expense id", "existingId" in r.body, false);
		check("...and no id leaks anywhere else in it", JSON.stringify(r).includes("4242"), false);
		// ⚠️ AND THE TWO 409s MUST BE INDISTINGUISHABLE from the constraint path's
		// unnamed one, or the shape of the answer becomes the oracle instead.
		check("...and the body is exactly the unnamed 409 the constraint path emits",
			r.body, { error: "This receipt was already logged", code: "DUPLICATE_RECEIPT" });
	}
	{
		// PAIRED — the owner still gets the helpful 409 with the id. Scoping must not
		// have simply switched the check off.
		const r = run({ sourceHash: HEX_B, photoData: bulkPayload, driver: "shorn king" });
		check("...while the SAME driver still gets DUPLICATE_RECEIPT", [r.ok, r.code, r.body.code],
			[false, 409, "DUPLICATE_RECEIPT"]);
		check("...naming the row so the admin can find it", r.body.existingId, 4242);
	}
	{
		// The predicate folds case and trims, matching normalizeDriverName()'s
		// behaviour on every other driver join — so the real filer is never refused
		// an answer over a spelling the rest of the app treats as identical.
		const r = run({ sourceHash: HEX_B, photoData: bulkPayload, driver: "  SHORN KING " });
		check("...and case/whitespace variants of the SAME driver still match", r.body && r.body.existingId, 4242);
	}
	{
		// The other door: the constraint-path winner re-read, executed as extracted.
		const stmt = db.prepare(WINNER_SQL);
		check("ORACLE (constraint path): another driver gets no winner id",
			stmt.get(HEX_B, "howard reddie"), undefined);
		check("...while the owner does", (stmt.get(HEX_B, "shorn king") || {}).id, 4242);
		// A blank driver must not become a wildcard that matches the ''-driver rows.
		check("...and a blank driver matches only a blank-driver row",
			stmt.get(HEX_B, ""), undefined);
	}

	// ── 3. enforcement is UNCHANGED (the paired claim) ──────────────────────
	section("3. scoping narrowed the message, NOT the enforcement");

	// The real index text from server.js, on a scratch table. Two DIFFERENT drivers
	// sharing one receipt hash must still be refused — that is what makes the
	// scoped SELECT safe rather than a hole.
	const idx = new Database(":memory:");
	idx.exec(`CREATE TABLE expenses (id INTEGER PRIMARY KEY AUTOINCREMENT, driver TEXT DEFAULT '', receipt_hash TEXT DEFAULT '')`);
	idx.exec(`CREATE UNIQUE INDEX idx_expenses_receipt_hash ON ${IDX_COLS}`);
	idx.prepare("INSERT INTO expenses (driver, receipt_hash) VALUES (?, ?)").run("shorn king", HEX_B);
	let blocked = false;
	try { idx.prepare("INSERT INTO expenses (driver, receipt_hash) VALUES (?, ?)").run("howard reddie", HEX_B); }
	catch (e) { blocked = e.code === "SQLITE_CONSTRAINT_UNIQUE"; }
	check("a CROSS-DRIVER duplicate receipt is still refused, by the index",
		blocked, true);
	// PAIRED — and the empty hash is still exempt, which is what makes a
	// payload-less request harmless rather than a denial-of-service on ''.
	let emptyOk = true;
	try {
		idx.prepare("INSERT INTO expenses (driver, receipt_hash) VALUES (?, ?)").run("a", "");
		idx.prepare("INSERT INTO expenses (driver, receipt_hash) VALUES (?, ?)").run("b", "");
	} catch { emptyOk = false; }
	check("...while '' is outside the partial index, so an ignored sourceHash burns nothing", emptyOk, true);
	idx.close();

	// ── 3b. …AND THE ENFORCEMENT DOES NOT DEPEND ON THAT INDEX ──────────────
	// ⚠️ THE CLAIM IN SECTION 3 IS TRUE AND IT IS NOT SUFFICIENT, which is the whole
	// reason this section exists. "A cross-driver collision is still refused by the
	// UNIQUE index" holds only while the index IS unique — and the migration that
	// makes it unique has a documented SKIP path. Its collision pre-flight looks for
	// duplicate `receipt_hash` values already stored; if it finds any it logs
	// SKIPPED and deliberately leaves the OLD, NON-UNIQUE index in place, because
	// which of two rows sharing a receipt is the real expense is a business question
	// and both are money already booked into a P&L.
	//
	// That is not a hypothetical shape. A refreshed local or staging database seeded
	// from an older production snapshot is exactly the database that skips. On one
	// of those, a driver-scoped pre-check answers "no", the INSERT is unconstrained,
	// and the receipt is DOUBLE-BOOKED into the P&L and the investor payout
	// deduction — the precise defect the index exists to prevent, reintroduced by a
	// change that was only ever meant to close an information leak.
	//
	// So the refusal is decided FLEET-WIDE in code, and only the message is scoped.
	// Everything below runs on a database whose index is non-unique.
	section("3b. the refusal survives a database where the UNIQUE migration SKIPPED");

	// The skip path, read out of the shipped migration rather than assumed.
	check("the migration really does have a SKIP path that keeps the old index",
		/migration SKIPPED[\s\S]{0,400}?non-unique \$\{RECEIPT_HASH_IDX\} is intact and unchanged/.test(SRC), true);

	// A database in the migration-SKIPPED shape: the plain, pre-upgrade index that
	// server.js creates before the migration, and the duplicate rows whose presence
	// makes the migration decline to replace it. Built by a factory because the
	// mutant in section 4 needs its own untouched copy.
	const makeSkipDb = () => {
		const d = new Database(":memory:");
		d.exec(`CREATE TABLE expenses (
			id INTEGER PRIMARY KEY AUTOINCREMENT, driver TEXT DEFAULT '', amount REAL DEFAULT 0,
			date TEXT DEFAULT '', receipt_hash TEXT DEFAULT '')`);
		d.exec("CREATE INDEX idx_expenses_receipt_hash ON expenses(receipt_hash)");
		const ins = d.prepare("INSERT INTO expenses (id, driver, amount, date, receipt_hash) VALUES (?,?,?,?,?)");
		ins.run(11, "shorn king", 500, "2026-06-03", HEX_B);
		ins.run(12, "howard reddie", 500, "2026-06-03", HEX_B);
		return d;
	};
	const skipDb = makeSkipDb();

	{
		// The shipped predicate and the shipped pre-flight, executed on that database.
		const M = new Function("db",
			`${extractFn("receiptHashIndexSql")}\n${extractFn("receiptHashIndexIsCurrent")}
			 return { receiptHashIndexIsCurrent };`)(skipDb);
		check("the migration would run (the index is not yet current)",
			M.receiptHashIndexIsCurrent("idx_expenses_receipt_hash"), false);
		const clashes = skipDb.prepare(PREFLIGHT_SQL).all();
		check("...and its pre-flight finds the collision, so it SKIPS", clashes.length, 1);
		// ⚠️ THE CONTROL WITHOUT WHICH THIS SECTION PROVES NOTHING: on this database a
		// cross-driver duplicate really is insertable, so any refusal below came from
		// the code and not from a constraint.
		let unconstrained = false;
		try {
			skipDb.prepare("INSERT INTO expenses (driver, receipt_hash) VALUES (?, ?)").run("a third driver", HEX_B);
			unconstrained = true;
		} catch { unconstrained = false; }
		check("CONTROL: the index is genuinely non-unique here", unconstrained, true);
		skipDb.prepare("DELETE FROM expenses WHERE driver = 'a third driver'").run();
	}

	{
		// ⚠️ THE ASSERTION THIS SECTION EXISTS FOR. A different driver re-filing a
		// receipt already booked to someone else, on a database with no constraint
		// behind it, must still be refused — by the guard.
		const skipRun = (opts) => buildRunner()(
			skipDb, crypto, { body: { sourceHash: opts.sourceHash } }, opts.photoData, opts.driver, RES);
		const r = skipRun({ sourceHash: HEX_B, photoData: bulkPayload, driver: "a third driver" });
		check("MIGRATION SKIPPED: a cross-driver duplicate is STILL refused",
			[r.ok, r.code, r.body.code], [false, 409, "DUPLICATE_RECEIPT"]);
		check("...still without naming a row", "existingId" in r.body, false);
		// PAIRED — the owner still gets the named 409 on the same database, so the
		// fleet-wide test did not simply swallow the helpful message.
		const own = skipRun({ sourceHash: HEX_B, photoData: bulkPayload, driver: "shorn king" });
		check("...while the owner still gets the id", own.body.existingId, 11);
		// PAIRED — and an unrelated receipt is still ACCEPTED, or "refuses everything"
		// would pass every assertion above.
		const fresh = skipRun({ sourceHash: HEX_A, photoData: dataUrl("a different receipt"), driver: "a third driver" });
		check("...and an unrelated receipt is still accepted", fresh.ok, true);
	}
	skipDb.close();

	// ── 4. mutants ──────────────────────────────────────────────────────────
	section("4. mutants (each must be caught)");

	// ⚠️ "THE NEEDLE NO LONGER MATCHES" IS A VACUOUS MUTANT, NOT A CAUGHT ONE. The
	// usual single `catch { caught = true }` cannot tell the two apart, so a refactor
	// that renames one line turns every mutant below into a permanently-passing
	// no-op, silently. Whether the mutation APPLIED is asserted separately.
	function mutantCaught(label, mutate, probe) {
		let caught = false, applied = true;
		try {
			const mutated = mutate(HASH_BLOCK);
			if (mutated === HASH_BLOCK) { applied = false; }
			else caught = !probe(buildRunner(mutated));
		} catch { caught = true; }
		check(`M: ${label} actually mutated the shipped source`, applied, true);
		check(`M: ${label} is caught`, caught, true);
	}

	// M1 — the payload gate removed, i.e. the burn primitive restored. This is the
	// shipped code as it was before this change.
	mutantCaught("a sourceHash accepted with no payload (the burn primitive)",
		(s) => s.replace("const sourceHash = receiptHash && /^[a-f0-9]{64}$/i.test(",
			"const sourceHash = /^[a-f0-9]{64}$/i.test("),
		(R) => run({ sourceHash: HEX_A, photoData: "", driver: "shorn king" }, R).receiptHash === "");

	// M2 — the driver predicate dropped from the pre-check, i.e. the fleet-wide
	// oracle restored.
	mutantCaught("a fleet-wide DUPLICATE_RECEIPT pre-check",
		(s) => s.replace(/\s*AND LOWER\(TRIM\(COALESCE\(driver, ''\)\)\) = LOWER\(TRIM\(\?\)\)/, ""),
		(R) => run({ sourceHash: HEX_B, photoData: bulkPayload, driver: "howard reddie" }, R).ok === true);

	// M3 — the gate widened to "any string", which accepts an empty photoData as a
	// payload and is the subtlest way back to M1.
	mutantCaught("a gate on the parameter's TYPE rather than on a hashed payload",
		(s) => s.replace("const sourceHash = receiptHash && /^[a-f0-9]{64}$/i.test(",
			"const sourceHash = typeof photoData === \"string\" && /^[a-f0-9]{64}$/i.test("),
		(R) => run({ sourceHash: HEX_A, photoData: "", driver: "shorn king" }, R).receiptHash === "");

	// ⚠️ M5 — THE FLEET-WIDE EXISTENCE TEST DELETED, i.e. the state this batch fixed:
	// the refusal is handed back to the UNIQUE index, and on a database where the
	// migration SKIPPED there is no index to hand it to. Every other assertion in
	// this file still passes against that mutant — sections 2 and 3 both run on a
	// database whose index IS unique — which is exactly why the probe runs on the
	// migration-skipped one. Admitting the row here means the receipt is
	// double-booked into the P&L and the investor payout deduction.
	mutantCaught("a refusal that depends on the UNIQUE index existing",
		(s) => s.replace("const taken = db", "const taken = null && db"),
		(R) => {
			const d = makeSkipDb();
			try {
				return R(d, crypto, { body: { sourceHash: HEX_B } }, bulkPayload, "a third driver", RES).ok !== true;
			} finally { d.close(); }
		});

	// M4 — the client hash accepted but never stored, i.e. the ScanKit instability
	// is back and the same receipt re-enters under a new payload hash. The gate
	// would still "pass" every burn test; this is the paired direction.
	mutantCaught("a client hash that is checked but never stored",
		(s) => s.replace("\t\tif (sourceHash) receiptHash = sourceHash;", "\t\t;"),
		(R) => run({ sourceHash: HEX_A, photoData: bulkPayload, driver: "shorn king" }, R).receiptHash === HEX_A);
});

db.close();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
	console.log("\nFailures:");
	for (const f of failures) console.log(f);
	process.exit(1);
}
