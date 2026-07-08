// Expense Intelligence — pure filtering/aggregation core.
//
// Single point of contact for expense filtering/aggregation — used by
// /api/expenses/analytics, the /api/expenses/all extensions, the AI query
// executor (lib/expense-ai.js), and scripts/backfill-expense-vendor.js.
// Keep every expense-money question flowing through here so the analytics
// dashboard, the AI answers, and the backfill all agree.
//
// Deliberately pure and deterministic: NO network, NO Gemini, NO requires.
// Callers hand in a better-sqlite3 `db` where data access is needed. Every
// SQL fragment built in this module is fully parameterized — no caller
// string is ever concatenated into SQL.

// Matches server.js:5539 EXPENSE_PNL_FILTER — deliberate, documented
// duplication (this module must not require server.js; keep the two strings
// in lockstep). An expense an admin set to 'Rejected' was explicitly denied
// and must never count financially. COALESCE keeps legacy NULL/'' rows and
// 'Pending'/'Approved' counted; only 'Rejected' is dropped.
const PNL_FILTER = "COALESCE(status, '') != 'Rejected'";

// Canonical expense types (superset of the driver form's list — includes
// "Wear & Tear" for admin-entered rows).
const EXPENSE_TYPES = ["Fuel", "Repair", "Maintenance", "Wear & Tear", "Toll", "Food", "Other"];

// The 9 US Census divisions — the region vocabulary the AI query layer and
// the analytics filters share. Values are 2-letter USPS codes (DC counted
// under South Atlantic, matching the Census Bureau).
const REGIONS = {
	"Pacific": ["AK", "CA", "HI", "OR", "WA"],
	"Mountain": ["AZ", "CO", "ID", "MT", "NV", "NM", "UT", "WY"],
	"West North Central": ["IA", "KS", "MN", "MO", "ND", "NE", "SD"],
	"West South Central": ["AR", "LA", "OK", "TX"],
	"East North Central": ["IL", "IN", "MI", "OH", "WI"],
	"East South Central": ["AL", "KY", "MS", "TN"],
	"New England": ["CT", "MA", "ME", "NH", "RI", "VT"],
	"Middle Atlantic": ["NJ", "NY", "PA"],
	"South Atlantic": ["DC", "DE", "FL", "GA", "MD", "NC", "SC", "VA", "WV"],
};

// Case-insensitive region-name → states lookup. Returns a fresh array (never
// the REGIONS value itself) or null when the name isn't a known division.
function resolveRegionToStates(region) {
	if (typeof region !== "string" || !region.trim()) return null;
	const want = region.trim().toLowerCase();
	for (const [name, states] of Object.entries(REGIONS)) {
		if (name.toLowerCase() === want) return [...states];
	}
	return null;
}

// ---------------------------------------------------------------------------
// Vendor normalization
// ---------------------------------------------------------------------------

// Ordered alias table: array of [canonical, regex] pairs, FIRST match wins.
// Longer / more specific patterns come first; dangerous short tokens
// (\bTA\b, \bQT\b, \bBP\b) are dead LAST so "TACO BELL" never hits TA PETRO
// and "BP" never matches inside another word. Patterns are tested against
// the cleaned-but-not-number-stripped string so brands whose canonical name
// contains digits ("PHILLIPS 66", "7-11", "ONE9") still match.
const VENDOR_ALIASES = [
	// Travel centers / truck stops — most specific first.
	["PILOT FLYING J", /PILOT|FLYING\s*J|\bPFJ\b|\bONE9\b/],
	["LOVE'S", /LOVE'?S\b/],
	["SPEEDCO", /SPEEDCO/],
	["TA PETRO", /TRAVEL\s*CENTERS?\s+OF\s+AMERICA|TA\s+EXPRESS|PETRO\b/],
	["SPEEDWAY", /SPEEDWAY/],
	["CASEY'S", /CASEY'?S\b/],
	["KWIK TRIP", /KWIK\s*TRIP|KWIK\s*STAR/],
	["BUC-EE'S", /BUC[- ]?EE'?S?\b/],
	["MAVERIK", /MAVERIK\b/],
	["QUIKTRIP", /QUIKTRIP|QUICK\s*TRIP/],
	["WAWA", /WAWA/],
	["SHEETZ", /SHEETZ/],
	["RACETRAC", /RACETRAC/],
	["SAPP BROS", /SAPP\s*BROS|SAPP\s*BROTHERS/],
	["ROAD RANGER", /ROAD\s*RANGER/],
	["AMBEST", /AMBEST/],
	["CIRCLE K", /CIRCLE\s*K\b/],
	["7-ELEVEN", /7[- ]?ELEVEN|SEVEN\s*ELEVEN|7[- ]?11\b/],
	// Fuel brands.
	["SHELL", /SHELL/],
	["CHEVRON", /CHEVRON/],
	["EXXON", /EXXON(MOBIL)?/],
	["MOBIL", /\bMOBIL\b/],
	["SUNOCO", /SUNOCO/],
	["MARATHON", /MARATHON/],
	["VALERO", /VALERO/],
	["PHILLIPS 66", /PHILLIPS\s*66/],
	["CONOCO", /CONOCO/],
	["SINCLAIR", /SINCLAIR/],
	["TEXACO", /TEXACO/],
	["ARCO", /\bARCO\b/], // word-bounded: bare /ARCO/ would hit "MARCO'S PIZZA"
	// Dangerous two-letter tokens LAST — standalone words only, and only after
	// everything specific above had its chance.
	["TA PETRO", /\bTA\b/],
	["QUIKTRIP", /\bQT\b/],
	["BP", /\bBP\b/],
];

// Uppercase, strip punctuation (keeping & ' - digits so "BUC-EE'S", "7-11"
// and "PHILLIPS 66" survive), collapse whitespace, and remove store-number
// noise ("#123", "STORE 44", "TRAVEL CENTER 7"...). Trailing bare-number
// tokens are NOT stripped here — see normalizeVendorDetailed.
function cleanVendorString(raw) {
	let s = String(raw == null ? "" : raw).toUpperCase();
	// Store-number refs like "#123" — strip while "#" still exists (the
	// punctuation pass below removes "#").
	s = s.replace(/#\s*\d+/g, " ");
	// Strip punctuation EXCEPT & ' - (letters, digits, spaces kept).
	s = s.replace(/[^A-Z0-9&'\- ]+/g, " ");
	s = s.replace(/\s+/g, " ").trim();
	// Store-number noise with keywords ("STORE 123", "UNIT 7", "TRUCK STOP 44").
	s = s.replace(/\b(STORE|NO|UNIT|TRAVEL CENTER|TRAVEL STOP|TRUCK STOP)\s*#?\s*\d+\b/g, " ");
	return s.replace(/\s+/g, " ").trim();
}

// Drop trailing tokens that are pure digits ("JOE'S DINER 42" → "JOE'S
// DINER"). Tokens containing a hyphen or letters ("7-11", "ONE9") survive.
function stripTrailingNumberTokens(s) {
	const tokens = s.split(" ").filter(Boolean);
	while (tokens.length && /^\d+$/.test(tokens[tokens.length - 1])) tokens.pop();
	return tokens.join(" ");
}

// Full detail: { normalized, aliasHit }. aliasHit=true means the value hit a
// KNOWN brand in the alias table — the backfill uses this to avoid promoting
// free-typed descriptions ("oil change") into vendors. Alias matching runs
// on the cleaned string BEFORE trailing-number stripping so "PHILLIPS 66"
// and "QT 811" both resolve; the number strip only shapes the unknown-brand
// fallback so "JOE'S DINER 42" and "JOE'S DINER" group together.
function normalizeVendorDetailed(raw) {
	const matchable = cleanVendorString(raw);
	if (matchable) {
		for (const [canonical, re] of VENDOR_ALIASES) {
			if (re.test(matchable)) return { normalized: canonical, aliasHit: true };
		}
	}
	const cleaned = stripTrailingNumberTokens(matchable);
	return { normalized: cleaned.length < 3 ? "" : cleaned, aliasHit: false };
}

// Simple wrapper: canonical vendor string, or "" when the input is too short
// / junk to group on.
function normalizeVendor(raw) {
	return normalizeVendorDetailed(raw).normalized;
}

// ---------------------------------------------------------------------------
// Filter SQL builder
// ---------------------------------------------------------------------------

// Build a parameterized WHERE clause for the expenses table.
// filters = { from, to, types, states, driver, truck, q, vendor } — all
// optional, pre-validated by callers. Returns { where, params } where
// `where` ALWAYS starts with "WHERE" (PNL_FILTER guarantees ≥1 condition).
function buildExpenseFilterSql(filters = {}) {
	const f = filters && typeof filters === "object" ? filters : {};
	const conds = [];
	const params = [];

	if (f.from) { conds.push("date >= ?"); params.push(String(f.from)); }
	if (f.to) { conds.push("date <= ?"); params.push(String(f.to)); }
	if (Array.isArray(f.types) && f.types.length) {
		conds.push(`type IN (${f.types.map(() => "?").join(", ")})`);
		params.push(...f.types.map(String));
	}
	if (Array.isArray(f.states) && f.states.length) {
		conds.push(`UPPER(COALESCE(location_state, '')) IN (${f.states.map(() => "?").join(", ")})`);
		params.push(...f.states.map((s) => String(s).trim().toUpperCase()));
	}
	if (f.driver) { conds.push("LOWER(driver) = ?"); params.push(String(f.driver).trim().toLowerCase()); }
	if (f.truck) { conds.push("LOWER(truck_unit) = ?"); params.push(String(f.truck).trim().toLowerCase()); }
	if (f.q) {
		// Escape LIKE wildcards (backslash first via the single-pass class) so
		// user text is always a literal substring match.
		const esc = String(f.q).replace(/[\\%_]/g, (c) => "\\" + c);
		const like = `%${esc}%`;
		conds.push(
			"(vendor LIKE ? ESCAPE '\\' OR vendor_normalized LIKE ? ESCAPE '\\' " +
			"OR description LIKE ? ESCAPE '\\' OR location_city LIKE ? ESCAPE '\\')"
		);
		params.push(like, like, like, like);
	}
	if (f.vendor) { conds.push("vendor_normalized = ?"); params.push(String(f.vendor)); }

	conds.push(PNL_FILTER);
	return { where: "WHERE " + conds.join(" AND "), params };
}

// ---------------------------------------------------------------------------
// Aggregation (fuel-analytics house style: one SELECT, JS reduces, rounded)
// ---------------------------------------------------------------------------

const round0 = (n) => Math.round(n || 0);
const round1 = (n) => Math.round((n || 0) * 10) / 10;
const round2 = (n) => Math.round((n || 0) * 100) / 100;

const EXPENSE_SELECT_COLS =
	"id, date, type, amount, gallons, driver, truck_unit, vendor, vendor_normalized, " +
	"location_city, location_state, location_lat, location_lng";

function fetchExpenseRows(db, filters) {
	const { where, params } = buildExpenseFilterSql(filters);
	return db.prepare(`SELECT ${EXPENSE_SELECT_COLS} FROM expenses ${where}`).all(...params);
}

function newAcc() {
	return { count: 0, spend: 0, gallons: 0, gallonsSpend: 0 };
}
function accumulate(acc, row) {
	acc.count++;
	acc.spend += row.amount || 0;
	const g = row.gallons || 0;
	if (g > 0) {
		acc.gallons += g;
		acc.gallonsSpend += row.amount || 0; // $/gal numerator: only rows with gallons
	}
	return acc;
}
// avgPerGallon = SUM(amount where gallons>0) / SUM(gallons); 0 when no gallons.
function accAvgPerGallon(acc) {
	return acc.gallons > 0 ? acc.gallonsSpend / acc.gallons : 0;
}
function mapAcc(map, key) {
	let acc = map.get(key);
	if (!acc) { acc = newAcc(); map.set(key, acc); }
	return acc;
}
const VALID_MONTH_RE = /^\d{4}-\d{2}$/;

// One SELECT, then JS reduces — mirrors /api/expenses/fuel-analytics.
// Returns the full analytics payload; an empty result set still yields a
// 200-able object (zeros + empty arrays, dateRange from filters or "").
function aggregateExpenses(db, filters = {}) {
	const rows = fetchExpenseRows(db, filters);

	const total = newAcc();
	const byVendorMap = new Map();
	const vendorStates = new Map(); // vendor → Set(states)
	const vendorLastDate = new Map(); // vendor → max date
	const byStateMap = new Map();
	const byMonthMap = new Map();
	const byTypeMap = new Map();
	const byDriverMap = new Map();
	const vendorSet = new Set();
	const stateSet = new Set();
	const locations = [];
	let unknownVendorCount = 0, unknownVendorSpend = 0;
	let noStateCount = 0, noStateSpend = 0;
	let minDate = "", maxDate = "";

	for (const r of rows) {
		accumulate(total, r);
		const amount = r.amount || 0;
		const date = String(r.date || "");
		if (date) {
			if (!minDate || date < minDate) minDate = date;
			if (!maxDate || date > maxDate) maxDate = date;
		}

		const vendorN = String(r.vendor_normalized || "").trim();
		const state = String(r.location_state || "").trim().toUpperCase();

		if (vendorN) {
			vendorSet.add(vendorN);
			accumulate(mapAcc(byVendorMap, vendorN), r);
			if (state) {
				let set = vendorStates.get(vendorN);
				if (!set) { set = new Set(); vendorStates.set(vendorN, set); }
				set.add(state);
			}
			if (date && date > (vendorLastDate.get(vendorN) || "")) vendorLastDate.set(vendorN, date);
		} else {
			unknownVendorCount++;
			unknownVendorSpend += amount;
		}

		if (state) {
			stateSet.add(state);
			accumulate(mapAcc(byStateMap, state), r);
		} else {
			noStateCount++;
			noStateSpend += amount;
		}

		const month = date.substring(0, 7);
		if (VALID_MONTH_RE.test(month)) accumulate(mapAcc(byMonthMap, month), r);

		accumulate(mapAcc(byTypeMap, String(r.type || "").trim()), r);
		accumulate(mapAcc(byDriverMap, String(r.driver || "").trim()), r);

		if (r.location_lat != null && r.location_lng != null) {
			locations.push({
				id: r.id,
				lat: r.location_lat,
				lng: r.location_lng,
				type: r.type,
				amount: round2(amount),
				vendor: String(r.vendor_normalized || r.vendor || ""),
				city: String(r.location_city || "").trim(),
				state,
				date,
				driver: r.driver,
			});
		}
	}

	const spendDesc = (a, b) => b[1].spend - a[1].spend || String(a[0]).localeCompare(String(b[0]));

	const byVendor = [...byVendorMap.entries()]
		.sort(spendDesc)
		.slice(0, 50)
		.map(([vendor, acc]) => ({
			vendor,
			visits: acc.count,
			spend: round0(acc.spend),
			gallons: round1(acc.gallons),
			avgPerGallon: round2(accAvgPerGallon(acc)),
			states: [...(vendorStates.get(vendor) || [])].sort().slice(0, 10),
			lastDate: vendorLastDate.get(vendor) || "",
		}));

	const byState = [...byStateMap.entries()]
		.sort(spendDesc)
		.map(([state, acc]) => ({
			state,
			count: acc.count,
			spend: round0(acc.spend),
			gallons: round1(acc.gallons),
		}));

	const byMonth = [...byMonthMap.entries()]
		.sort(([a], [b]) => a.localeCompare(b)) // month ASC…
		.slice(-24) // …capped to the 24 most-recent months present
		.map(([month, acc]) => ({
			month,
			count: acc.count,
			spend: round0(acc.spend),
			gallons: round1(acc.gallons),
			avgPerGallon: round2(accAvgPerGallon(acc)),
		}));

	const byType = [...byTypeMap.entries()]
		.sort(spendDesc)
		.map(([type, acc]) => ({
			type,
			count: acc.count,
			spend: round0(acc.spend),
			gallons: round1(acc.gallons),
		}));

	const byDriver = [...byDriverMap.entries()]
		.sort(spendDesc)
		.slice(0, 50)
		.map(([driver, acc]) => ({
			driver,
			count: acc.count,
			spend: round0(acc.spend),
			gallons: round1(acc.gallons),
		}));

	locations.sort((a, b) => String(b.date).localeCompare(String(a.date)) || b.id - a.id);

	return {
		summary: {
			totalSpend: round0(total.spend),
			count: total.count,
			totalGallons: round1(total.gallons),
			avgPerGallon: round2(accAvgPerGallon(total)),
			avgExpense: total.count > 0 ? round2(total.spend / total.count) : 0,
			vendorsCount: vendorSet.size,
			statesCount: stateSet.size,
			unknownVendorCount,
			unknownVendorSpend: round0(unknownVendorSpend),
			noStateCount,
			noStateSpend: round0(noStateSpend),
			dateRange: {
				from: minDate || (filters && filters.from) || "",
				to: maxDate || (filters && filters.to) || "",
			},
		},
		byVendor,
		byState,
		byMonth,
		byType,
		byDriver,
		locations: locations.slice(0, 500),
	};
}

// ---------------------------------------------------------------------------
// AI query executor support
// ---------------------------------------------------------------------------

const QUERY_METRICS = new Set(["spend", "count", "gallons", "avg_per_gallon", "avg_amount"]);
const QUERY_GROUP_BYS = new Set(["vendor", "state", "month", "type", "driver", "truck", "none"]);

const COLUMN_LABELS = {
	vendor: "Vendor",
	state: "State",
	month: "Month",
	type: "Type",
	driver: "Driver",
	truck: "Truck",
	visits: "Visits",
	count: "Count",
	spend: "Spend ($)",
	gallons: "Gallons",
	avgPerGallon: "$/gal",
	avgAmount: "Avg ($)",
	totalSpend: "Total Spend ($)",
	totalGallons: "Total Gallons",
};

const COLUMNS_BY_GROUP = {
	vendor: ["vendor", "visits", "spend", "gallons", "avgPerGallon"],
	state: ["state", "count", "spend", "gallons"],
	month: ["month", "count", "spend", "gallons", "avgPerGallon"],
	type: ["type", "count", "spend"],
	driver: ["driver", "count", "spend", "gallons"],
	truck: ["truck", "count", "spend", "gallons"],
	none: ["totalSpend", "count", "totalGallons", "avgPerGallon"],
};

const CHART_HINT_BY_GROUP = {
	month: "line",
	vendor: "bar",
	state: "bar",
	type: "bar",
	driver: "bar",
	truck: "bar",
	none: "none",
};

// Execute a validated AI query spec against the expenses table.
// spec = {
//   metric: 'spend'|'count'|'gallons'|'avg_per_gallon'|'avg_amount',
//   groupBy: 'vendor'|'state'|'month'|'type'|'driver'|'truck'|'none',
//   filters: { types?, states?, region?, driver?, truck?, vendorContains? },
//   sort: 'metric_desc'|'metric_asc'|'label_asc' (default metric_desc),
//   limit: 1..20,
//   resolvedFrom: 'YYYY-MM-DD'|null, resolvedTo: 'YYYY-MM-DD'|null,
// }
// Returns { columns: [{key,label}], rows, chartHint }. Throws on an unknown
// metric/groupBy (defense-in-depth behind the executor's own validation).
function runQuerySpec(db, spec) {
	const s = spec && typeof spec === "object" ? spec : {};
	const metric = String(s.metric || "");
	const groupBy = String(s.groupBy || "");
	if (!QUERY_METRICS.has(metric)) throw new Error(`runQuerySpec: unknown metric "${metric}"`);
	if (!QUERY_GROUP_BYS.has(groupBy)) throw new Error(`runQuerySpec: unknown groupBy "${groupBy}"`);
	const f = s.filters && typeof s.filters === "object" ? s.filters : {};

	// Union of explicit states + the resolved region.
	let states;
	const regionStates = resolveRegionToStates(f.region);
	if ((Array.isArray(f.states) && f.states.length) || regionStates) {
		const set = new Set();
		for (const st of Array.isArray(f.states) ? f.states : []) {
			const v = String(st).trim().toUpperCase();
			if (v) set.add(v);
		}
		for (const st of regionStates || []) set.add(st);
		if (set.size) states = [...set];
	}

	// Gallons only exist on fuel rows — force the type filter so gallon math
	// never dilutes across repair/food rows.
	let types = Array.isArray(f.types) && f.types.length ? f.types.map(String) : undefined;
	if ((metric === "gallons" || metric === "avg_per_gallon") && !types) types = ["Fuel"];

	const rows = fetchExpenseRows(db, {
		from: s.resolvedFrom || undefined,
		to: s.resolvedTo || undefined,
		types,
		states,
		driver: f.driver || undefined,
		truck: f.truck || undefined,
		q: f.vendorContains || undefined,
	});

	// Group in JS (fuel-analytics style).
	const groups = new Map();
	if (groupBy === "none") groups.set("Total", newAcc()); // always emit one row
	for (const r of rows) {
		let key;
		switch (groupBy) {
			case "vendor": key = String(r.vendor_normalized || "").trim() || "Unknown"; break;
			case "state": key = String(r.location_state || "").trim().toUpperCase() || "Unknown"; break;
			case "month":
				key = String(r.date || "").substring(0, 7);
				if (!VALID_MONTH_RE.test(key)) continue; // unparseable date → no month bucket
				break;
			case "type": key = String(r.type || "").trim() || "Unknown"; break;
			case "driver": key = String(r.driver || "").trim() || "Unknown"; break;
			case "truck": key = String(r.truck_unit || "").trim() || "Unknown"; break;
			default: key = "Total";
		}
		accumulate(mapAcc(groups, key), r);
	}

	// Raw (unrounded) metric value per group — used for sorting.
	const metricValue = (acc) => {
		switch (metric) {
			case "count": return acc.count;
			case "gallons": return acc.gallons;
			case "avg_per_gallon": return accAvgPerGallon(acc);
			case "avg_amount": return acc.count > 0 ? acc.spend / acc.count : 0;
			default: return acc.spend; // 'spend'
		}
	};

	const entries = [...groups.entries()];
	if (s.sort === "label_asc") {
		entries.sort(([a], [b]) => String(a).localeCompare(String(b)));
	} else if (s.sort === "metric_asc") {
		entries.sort((a, b) => metricValue(a[1]) - metricValue(b[1]) || String(a[0]).localeCompare(String(b[0])));
	} else { // metric_desc (default)
		entries.sort((a, b) => metricValue(b[1]) - metricValue(a[1]) || String(a[0]).localeCompare(String(b[0])));
	}

	const limit = Math.max(1, Math.min(20, parseInt(s.limit, 10) || 10));
	const columnKeys = [...COLUMNS_BY_GROUP[groupBy]];
	if (metric === "avg_amount") columnKeys.push("avgAmount"); // ONLY for this metric

	const outRows = entries.slice(0, limit).map(([label, acc]) => {
		const row = {};
		for (const key of columnKeys) {
			switch (key) {
				case "vendor": case "state": case "month":
				case "type": case "driver": case "truck":
					row[key] = label; break;
				case "visits": case "count": row[key] = acc.count; break;
				case "spend": case "totalSpend": row[key] = round0(acc.spend); break;
				case "gallons": case "totalGallons": row[key] = round1(acc.gallons); break;
				case "avgPerGallon": row[key] = round2(accAvgPerGallon(acc)); break;
				case "avgAmount": row[key] = acc.count > 0 ? round2(acc.spend / acc.count) : 0; break;
			}
		}
		return row;
	});

	return {
		columns: columnKeys.map((key) => ({ key, label: COLUMN_LABELS[key] || key })),
		rows: outRows,
		chartHint: CHART_HINT_BY_GROUP[groupBy],
	};
}

// ---------------------------------------------------------------------------
// Insights aggregates (feeds the AI "insights" summary)
// ---------------------------------------------------------------------------

// "Today" in a fixed zone — mirrors server.js:5575 localDayInTz (deliberate
// small duplication; this module must stay require-free). en-CA formats as
// "YYYY-MM-DD" directly.
const _dayFmtCache = {};
function localDayInTz(ms, tz) {
	let f = _dayFmtCache[tz];
	if (!f) {
		f = _dayFmtCache[tz] = new Intl.DateTimeFormat("en-CA", {
			timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
		});
	}
	return f.format(new Date(ms));
}

// "YYYY-MM" ± n calendar months, pure integer math (no Date/DST surprises).
function shiftMonth(monthStr, delta) {
	const y0 = parseInt(monthStr.slice(0, 4), 10);
	const m0 = parseInt(monthStr.slice(5, 7), 10) - 1 + delta;
	const y = y0 + Math.floor(m0 / 12);
	const m = ((m0 % 12) + 12) % 12;
	return `${y}-${String(m + 1).padStart(2, "0")}`;
}

// Compact aggregates for the AI insights prompt: a 90-day window snapshot
// plus a fixed last-6-calendar-months series (independent of the window).
// The window boundary is computed in America/Chicago — the same zone the
// invoice-week math anchors on — so "today" matches the business day.
function buildInsightsAggregates(db) {
	const DAY_MS = 86400000;
	const tz = "America/Chicago";
	const today = localDayInTz(Date.now(), tz);
	const from90 = localDayInTz(Date.now() - 90 * DAY_MS, tz);

	const rows = db.prepare(
		`SELECT date, type, amount, gallons, status, vendor_normalized, location_state
		 FROM expenses WHERE date >= ? AND ${PNL_FILTER}`
	).all(from90);

	let totalSpend = 0;
	let pendingCount = 0;
	let missingVendor = 0;
	let missingState = 0;
	const vendorMap = new Map();
	const stateMap = new Map();
	const typeMap = new Map();

	for (const r of rows) {
		const amount = r.amount || 0;
		totalSpend += amount;
		if (String(r.status || "").trim().toLowerCase() === "pending") pendingCount++;
		const vendor = String(r.vendor_normalized || "").trim();
		if (vendor) accumulate(mapAcc(vendorMap, vendor), r);
		else missingVendor++;
		const state = String(r.location_state || "").trim().toUpperCase();
		if (state) accumulate(mapAcc(stateMap, state), r);
		else missingState++;
		accumulate(mapAcc(typeMap, String(r.type || "").trim()), r);
	}

	const count = rows.length;
	const pct = (n) => (count > 0 ? Math.round((n / count) * 100) : 0);
	const spendDesc = (a, b) => b[1].spend - a[1].spend || String(a[0]).localeCompare(String(b[0]));

	// Last 6 calendar months (zero-filled, ASC), regardless of the 90-day window.
	const curMonth = today.slice(0, 7);
	const months = [];
	for (let i = 5; i >= 0; i--) months.push(shiftMonth(curMonth, -i));
	const monthAcc = new Map(months.map((m) => [m, newAcc()]));
	const monthRows = db.prepare(
		`SELECT date, amount, gallons FROM expenses WHERE date >= ? AND ${PNL_FILTER}`
	).all(`${months[0]}-01`);
	for (const r of monthRows) {
		const acc = monthAcc.get(String(r.date || "").substring(0, 7));
		if (acc) accumulate(acc, r);
	}
	const monthly = months.map((m) => {
		const acc = monthAcc.get(m);
		return {
			month: m,
			spend: round0(acc.spend),
			gallons: round1(acc.gallons),
			avgPerGallon: round2(accAvgPerGallon(acc)),
		};
	});

	// Month-over-month: last FULL month vs the one before (the current month
	// is partial). null when either month has no spend.
	const lastFullSpend = monthAcc.get(months[4]).spend; // curMonth − 1
	const prevSpend = monthAcc.get(months[3]).spend; // curMonth − 2
	const momSpendChangePct =
		lastFullSpend > 0 && prevSpend > 0
			? Math.round(((lastFullSpend - prevSpend) / prevSpend) * 100)
			: null;

	return {
		windowDays: 90,
		totalSpend: round0(totalSpend),
		count,
		pendingCount,
		missingVendorPct: pct(missingVendor),
		missingStatePct: pct(missingState),
		topVendors: [...vendorMap.entries()].sort(spendDesc).slice(0, 5)
			.map(([vendor, acc]) => ({ vendor, spend: round0(acc.spend), visits: acc.count })),
		topStates: [...stateMap.entries()].sort(spendDesc).slice(0, 5)
			.map(([state, acc]) => ({ state, spend: round0(acc.spend), count: acc.count })),
		byType: [...typeMap.entries()].sort(spendDesc)
			.map(([type, acc]) => ({ type, spend: round0(acc.spend), count: acc.count })),
		monthly,
		momSpendChangePct,
	};
}

module.exports = {
	EXPENSE_TYPES,
	REGIONS,
	resolveRegionToStates,
	normalizeVendor,
	normalizeVendorDetailed,
	buildExpenseFilterSql,
	aggregateExpenses,
	runQuerySpec,
	buildInsightsAggregates,
};
