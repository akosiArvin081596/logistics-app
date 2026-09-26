// Read-only tally of what the stored truck photos / CDL files ARE (magic bytes)
// versus what their data-URI label says. Prints formats and ids only — no values.
//   node scripts/e2e/stored-format-audit.cjs <scratch-db>     (a copy inside the work dir)
"use strict";
const paths = require("./paths.cjs");

paths.warnNodeVersion("stored-format-audit");
let Database, dbPath;
try {
	dbPath = paths.workFile(process.argv[2]);
	Database = paths.appRequire("better-sqlite3");
} catch (e) {
	console.error(`stored-format-audit: ${e.message} (pass a scratch DB inside the work dir)`);
	process.exit(2);
}
const db = new Database(dbPath, { readonly: true, fileMustExist: true });

function magic(v) {
	if (!v) return "(empty)";
	const m = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(v);
	if (!m) return "malformed";
	const b = Buffer.from(m[3].slice(0, 64), "base64");
	const h = b.subarray(0, 12).toString("hex");
	let kind;
	if (h.startsWith("ffd8ff")) kind = "jpeg";
	else if (h.startsWith("89504e47")) kind = "png";
	else if (b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP") kind = "webp";
	else if (b.subarray(0, 3).toString() === "GIF") kind = "gif";
	else if (b.subarray(0, 4).toString() === "%PDF") kind = "pdf";
	else if (b.subarray(4, 8).toString() === "ftyp") kind = `iso-bmff(${b.subarray(8, 12).toString()})`;
	else kind = `other:${h.slice(0, 8)}`;
	return `label=${m[1] || "(none)"} bytes=${kind}`;
}

for (const t of db.prepare("SELECT id, photo FROM trucks ORDER BY id").all()) {
	console.log(`truck ${t.id}: ${magic(t.photo)}`);
}
const tally = {};
for (const r of db.prepare("SELECT cdl_front, cdl_back, medical_card FROM job_applications").all()) {
	for (const c of ["cdl_front", "cdl_back", "medical_card"]) {
		const k = `${c}: ${magic(r[c])}`;
		tally[k] = (tally[k] || 0) + 1;
	}
}
for (const [k, n] of Object.entries(tally).sort()) console.log(`${k}  x${n}`);
db.close();
