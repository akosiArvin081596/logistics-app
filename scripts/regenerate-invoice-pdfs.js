// One-shot: regenerate every invoice PDF in place using the current
// service-invoice template, without touching DB rows.
//
// Why: the template was missing slots for the billing-period header,
// so existing invoice PDFs (uploads/invoices/*.pdf) all show the
// literal "[Saturday Date] to [Current Friday Date]" placeholder.
// Fix landed in commit ac89999. This script re-renders the PDFs so
// previously generated invoices read correctly too.
//
// Safety: refuses to overwrite if the recomputed total_earnings
// differs from the DB row (would silently change a paid invoice's
// amount). Pass --force to override per-invoice via interactive
// prompt — not implemented; just edit the script if you really need it.
//
// Usage on the VPS:
//   cd /var/www/logistics-app && node scripts/regenerate-invoice-pdfs.js

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { google } = require("googleapis");
const { renderPolicy } = require("../lib/policy-renderer");

const SPREADSHEET_ID = "1ey1n0AAG0k8k-qwkWh2T_C8VqqY129OQQr7D5wNl7Mo";

function normalizeDriverName(name) {
	return String(name || "").toLowerCase().replace(/\s+/g, " ").trim();
}

async function getSheets() {
	const auth = new google.auth.GoogleAuth({
		keyFile: path.join(__dirname, "..", "service-account-key.json"),
		scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
	});
	const client = await auth.getClient();
	return google.sheets({ version: "v4", auth: client });
}

function parseInvoiceDate(val) {
	if (!val) return null;
	const cleaned = String(val).replace(/^date:\s*/i, "").trim();
	const m = cleaned.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
	if (m) {
		let yr = parseInt(m[3]); if (yr < 100) yr += 2000;
		const d = new Date(yr, parseInt(m[1]) - 1, parseInt(m[2]));
		return isNaN(d) ? null : d;
	}
	const d = new Date(cleaned);
	return isNaN(d) ? null : d;
}

function fmtLocalDate(d) {
	return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

async function regenerate(db, sheets, invoice) {
	const { id, invoice_number, driver, week_start, week_end, total_earnings: storedTotal, pdf_file_name } = invoice;
	const driverName = driver;

	console.log(`\n[invoice ${id}] ${invoice_number} | driver=${driverName} | ${week_start}..${week_end}`);

	// --- Re-fetch sheet rows for this driver/week ---
	const resp = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: "Job Tracking" });
	const rows = resp.data.values || [];
	if (rows.length < 2) { console.log("  ! Job Tracking empty — skipping"); return; }
	const headers = rows[0];
	const data = rows.slice(1).map((r, i) => {
		const obj = {};
		headers.forEach((h, j) => { obj[h] = r[j] || ""; });
		obj._rowIndex = i + 2;
		return obj;
	});

	const driverCol = headers.find(h => /driver/i.test(h));
	const statusCol = headers.find(h => /^(job[\s._-]?)?status$/i.test(h));
	const loadIdCol = headers.find(h => /load.?id|job.?id/i.test(h));
	const dateCol = headers.find(h => /status.*update.*date|completion.*date|drop.?off.*date|deliv.*date/i.test(h))
		|| headers.find(h => /date/i.test(h));
	const pickupCol = headers.find(h => /pickup.*appo|pickup.*date/i.test(h));
	const dropoffCol = headers.find(h => /drop.?off.*appo|drop.?off.*date|deliv.*appoint/i.test(h));
	const completionCol = headers.find(h => /completion.*date|status.*update.*date/i.test(h));

	const completedRe = /delivered|completed|pod received/i;
	const nameNorm = normalizeDriverName(driverName);
	const weekLoads = data.filter(row => {
		if (!driverCol || normalizeDriverName(row[driverCol]) !== nameNorm) return false;
		if (!statusCol || !completedRe.test(row[statusCol])) return false;
		if (!dateCol) return true;
		const rawDate = (row[dateCol] || "").replace(/^date:\s*/i, "").trim();
		if (!rawDate) return true;
		const parsed = new Date(rawDate);
		if (isNaN(parsed.getTime())) return true;
		const dateStr = parsed.toISOString().split("T")[0];
		return dateStr >= week_start && dateStr <= week_end;
	});

	const loadMap = new Map();
	for (const load of weekLoads) {
		const lid = loadIdCol ? (load[loadIdCol] || "") : "";
		if (lid) loadMap.set(lid, load);
		else loadMap.set(`_row_${load._rowIndex}`, load);
	}
	const uniqueLoads = [...loadMap.values()];
	if (uniqueLoads.length === 0) { console.log("  ! No completed loads found — skipping"); return; }

	// --- Active-day algorithm (mirrors endpoint) ---
	const dailyRate = 250;
	const activeDaySet = new Set();
	const dayLoadMap = {};
	for (const load of uniqueLoads) {
		const pickup = parseInvoiceDate(pickupCol ? load[pickupCol] : null);
		let dropoff = parseInvoiceDate(dropoffCol ? load[dropoffCol] : null);
		if (!dropoff && completionCol && /delivered|completed|pod received/i.test(load[statusCol] || "")) {
			dropoff = parseInvoiceDate(load[completionCol]);
		}
		if (!pickup) continue;
		const start = new Date(pickup); start.setHours(12, 0, 0, 0);
		const end = dropoff ? new Date(dropoff) : new Date(pickup);
		end.setHours(12, 0, 0, 0);
		if (end < start) end.setTime(start.getTime());
		const cur = new Date(start);
		const lid = loadIdCol ? (load[loadIdCol] || "") : "";
		while (cur <= end) {
			const ds = fmtLocalDate(cur);
			if (ds >= week_start && ds <= week_end) {
				activeDaySet.add(ds);
				if (!dayLoadMap[ds]) dayLoadMap[ds] = [];
				if (lid && !dayLoadMap[ds].includes(lid)) dayLoadMap[ds].push(lid);
			}
			cur.setDate(cur.getDate() + 1);
		}
	}

	const activeDays = activeDaySet.size;
	const computedTotal = activeDays * dailyRate;
	console.log(`  recomputed active_days=${activeDays} total=$${computedTotal.toFixed(2)} (DB stored: $${Number(storedTotal).toFixed(2)})`);

	if (Math.abs(computedTotal - Number(storedTotal)) > 0.01) {
		console.log(`  ! Total mismatch — REFUSING to overwrite (would change historical amount). Skipping.`);
		return;
	}

	// --- Build daysMap (Sat–Fri grid) ---
	const DAY_NAMES = ["Saturday", "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
	const daysMap = {};
	for (const d of DAY_NAMES) daysMap[d] = { loadBol: "", total: 0, completed: false };
	for (const ds of activeDaySet) {
		const dt = new Date(ds + "T12:00:00");
		const jsDay = dt.getDay();
		const templateDay = DAY_NAMES[(jsDay + 1) % 7];
		const entry = daysMap[templateDay];
		entry.total += dailyRate;
		entry.completed = true;
		const bols = dayLoadMap[ds] || [];
		entry.loadBol = entry.loadBol
			? `${entry.loadBol}, ${bols.join(", ")}`.replace(/, $/, "")
			: bols.join(", ");
	}

	// --- Provider info from local SQLite ---
	const driverUser = db.prepare("SELECT id FROM users WHERE LOWER(driver_name) = LOWER(?)").get(driverName);
	const payInfo = driverUser
		? db.prepare("SELECT * FROM driver_payment_info WHERE user_id = ?").get(driverUser.id)
		: null;
	const driverRow = db.prepare(
		"SELECT address, city, state, zip, phone, cell FROM drivers_directory WHERE LOWER(driver_name) = LOWER(?)"
	).get(driverName);
	const providerAddress = driverRow
		? [driverRow.address, driverRow.city, driverRow.state, driverRow.zip].filter(Boolean).join(", ")
		: "";
	const providerPhone = driverRow ? (driverRow.phone || driverRow.cell || "") : "";

	// Use the original invoice's submission date (created_at) so the doc stays
	// historically consistent — only the billing-period dates are the actual fix here.
	const createdAt = db.prepare("SELECT datetime(created_at) AS c FROM invoices WHERE id = ?").get(id).c;
	const submissionDate = new Date(createdAt + "Z").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
	const fmtWeekDate = (s) =>
		new Date(s + "T12:00:00").toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

	// --- Render PDF ---
	const pdfBuffer = await renderPolicy("service_invoice", {
		driverName,
		businessName: driverName,
		providerAddress,
		providerPhone,
		invoiceNumberSuffix: invoice_number.replace(/^INV-/, ""),
		submissionDate,
		signatureDate: submissionDate,
		billingPeriodStart: fmtWeekDate(week_start),
		billingPeriodEnd: fmtWeekDate(week_end),
		totalDue: computedTotal,
		bankOnFile: payInfo?.bank_name || "",
		accountType: (payInfo?.account_type || "").toLowerCase(),
		days: daysMap,
		hasEldData: true,
		hasBol: true,
		hasDvir: true,
		hasFuelReceipts: true,
	});

	const pdfPath = path.join(__dirname, "..", "uploads", "invoices", pdf_file_name);
	fs.writeFileSync(pdfPath, pdfBuffer);
	console.log(`  ✓ wrote ${pdfPath} (${pdfBuffer.length} bytes)`);
}

(async () => {
	const db = new Database(path.join(__dirname, "..", "app.db"), { readonly: true });
	const sheets = await getSheets();

	const invoices = db.prepare(
		"SELECT id, invoice_number, driver, week_start, week_end, total_earnings, pdf_file_name FROM invoices ORDER BY id ASC"
	).all();

	console.log(`Found ${invoices.length} invoice(s) to regenerate`);

	for (const inv of invoices) {
		try {
			await regenerate(db, sheets, inv);
		} catch (err) {
			console.error(`  ! Error on invoice ${inv.id}:`, err.message);
		}
	}

	db.close();
	console.log("\nDone.");
	process.exit(0);
})();
