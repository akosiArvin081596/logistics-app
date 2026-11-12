#!/usr/bin/env node
/**
 * The business clock's switch to US Central (the Central time plan, made-up data
 * only): APP_TIMEZONE=America/Chicago with APP_TIMEZONE_FROM=2026-11-18T02:00:00Z,
 * Tue Nov 17, 8:00 PM CST. Times keep their numbers on the Central clock, and
 * nothing past moves.
 *
 *   §1 the settings: unset is US Eastern with no switch and no warning; a zone
 *      without APP_TIMEZONE_FROM is refused (US Eastern, one warning); a moment in
 *      the wrong shape, before the Eastern era or set alone is refused or ignored
 *      (one warning); both make the switch, Eastern before the instant and Central
 *      from it; "now" is the zone in force when the process starts.
 *   §2 stamps keep their written date and read their true instant on the clock
 *      that wrote them (lib/load-haul.js, appNoonMs()): Houston's to 2026-10-08,
 *      Eastern's to the switch, Central's after it; the hour the switch repeats
 *      (20:00-20:59 on Nov 17) reads as its first, Eastern instant, and Nov 17 is
 *      25 hours long.
 *   §3 every reader of a stored instant keeps a pre-switch item's day, week and
 *      month after the switch: a handover at 11:30 PM CT on Oct 31 stays in
 *      November (E9), the truck held at noon on Nov 16 keeps its driver (E13),
 *      and the pay-rate, receipt submission, auto-approve, fuel event, payment
 *      report, IFTA, truck charge, trip, owner-operator and KPI days.
 *   §4 after the switch the 11 PM-midnight CT hour is the Central day (E1-E4, E6,
 *      E10), for "now" and for every reader above.
 *   §5 fixed times on the Central clock: the cutoff at 6:30 PM and the batch at
 *      7:00 PM CT, the close at 00:00 CT, the Personal sweep Saturday 06:00, the
 *      integrity check 08:00, the day-off ELD check 06:00, and KPI at 03:00 and
 *      Monday 08:00 CT.
 *   §6 words follow the zone: the KPI schedule and week rule, the integrity
 *      email, the grace-days script's label.
 *   §7 the integrity check: an n8n still on Eastern after the switch is caught in
 *      winter and in summer (-240), a pre-switch Eastern stamp is not flagged, and
 *      with the settings unset -240 is no candidate.
 *   §8 the browser's half: the session answer carries the era only once a switch
 *      is set, so with the settings unset it is byte for byte as before.
 *   §9 settings unset: each changed reader gives the answer of the code it
 *      replaced, over a grid of instants and wall clocks around both DST changes,
 *      the seam hour and the planned switch.
 *
 * Every scenario runs in its own child process (the settings are read once per
 * process) under TZ=UTC, America/Chicago and Asia/Manila; the three must agree.
 * Functions are lifted out of server.js source. Nothing is written anywhere.
 *
 *   node scripts/test-central-time-switch.js        # exits 1 on any failure
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const FROM = "2026-11-18T02:00:00Z";
const FROM_ISO = "2026-11-18T02:00:00.000Z";
const NY = "America/New_York";
const CHI = "America/Chicago";
const ZONES = ["UTC", "America/Chicago", "Asia/Manila"];
const SCENARIOS = {
	unset: {},
	zoneOnly: { APP_TIMEZONE: CHI },
	fromOnly: { APP_TIMEZONE_FROM: FROM },
	badShape: { APP_TIMEZONE: CHI, APP_TIMEZONE_FROM: "2026-11-18 02:00" },
	beforeEra: { APP_TIMEZONE: CHI, APP_TIMEZONE_FROM: "2026-10-08T23:00:00Z" },
	// Both settings, the process started an hour before the moment.
	before: { APP_TIMEZONE: CHI, APP_TIMEZONE_FROM: FROM, FAKE_START: "2026-11-18T01:00:00Z" },
	// Both settings, the process restarted at the moment (the switch-on).
	after: { APP_TIMEZONE: CHI, APP_TIMEZONE_FROM: FROM, FAKE_START: "2026-11-18T02:00:30Z" },
};

// ───────────────────────────────────────────────────────────── the child
function child(scenario) {
	const warnings = [];
	const realWarn = console.warn;
	console.warn = (msg) => warnings.push(String(msg));
	const realNow = Date.now;
	if (process.env.FAKE_START) { const t = Date.parse(process.env.FAKE_START); Date.now = () => t; }
	const appTime = require(path.join(ROOT, "lib", "app-time.js"));
	const ZONE = appTime.appTimeZone();
	Date.now = realNow;
	const loadHaul = require(path.join(ROOT, "lib", "load-haul.js"));
	const ownerOperator = require(path.join(ROOT, "lib", "owner-operator.js"));
	const tripWorkDays = require(path.join(ROOT, "lib", "trip-work-days.js"));
	const ic = require(path.join(ROOT, "lib", "integrity-check.js"));
	const kpiSchedule = require(path.join(ROOT, "lib", "kpi-schedule.js"));
	const kpiCatalog = require(path.join(ROOT, "lib", "kpi-catalog.js"));
	const kpiMetrics = require(path.join(ROOT, "lib", "kpi-metrics.js"));
	const timeOff = require(path.join(ROOT, "lib", "time-off-eld-check.js"));
	console.warn = realWarn;
	const Database = require(path.join(ROOT, "node_modules", "better-sqlite3"));
	const SRC = require("./lib/server-source").serverSource();

	const out = [];
	const check = (name, fn, want) => {
		let got;
		try { got = fn(); } catch (err) { got = `threw: ${String(err && err.message).split("\n")[0]}`; }
		out.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want });
	};
	const ms = (iso) => Date.parse(iso);
	const wall = (tz, y, mo, d, h, mi = 0, s = 0) => appTime.wallClockToMs(tz, y, mo, d, h, mi, s);

	// server.js functions, lifted, on a zone and a clock.
	const lift = (name) => {
		const needle = `\nfunction ${name}(`;
		const at = SRC.indexOf(needle);
		if (at < 0) throw new Error(`server.js has no function ${name}(`);
		let i = SRC.indexOf("{", SRC.indexOf(")", at));
		let depth = 0;
		for (; i < SRC.length; i++) {
			if (SRC[i] === "{") depth++;
			else if (SRC[i] === "}" && --depth === 0) break;
		}
		return SRC.slice(at + 1, i + 1);
	};
	const NAMES = ["appDay", "appStamp", "appNoonMs", "appTodayKey", "appMonthKey", "getWeekRange", "isAfterDeadline",
		"mostRecentInvoiceFriday", "assignmentMonthKey", "invoiceSeqDayKey", "sheetDayKey", "kpiInstantDay", "iftaDefaultStartIso",
		"graceEndsAt", "isPastGrace", "personalSweepDueMs", "loadPayRateIndex", "receiptSubmittedDaySql"];
	const LIFTED = NAMES.map(lift).join("\n");
	const RFC2822_MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
	// `zone`: server.js's APP_TIMEZONE (appTime.appTimeZone() at boot); `nowIso`: the clock.
	const build = ({ zone = ZONE, nowIso = null, db = null, rates = [] } = {}) => {
		const RealDate = Date;
		const nowMs = nowIso ? RealDate.parse(nowIso) : RealDate.now();
		const Clock = class extends RealDate {
			constructor(...a) { if (a.length) super(...a); else super(nowMs); }
			static now() { return nowMs; }
		};
		return new Function("Date", "APP_TIMEZONE", "appTime", "RFC2822_MONTHS", "db", "currentPayRates",
			`${LIFTED}\nreturn { ${NAMES.join(", ")} };`)(Clock, zone, appTime, RFC2822_MONTHS, db, () => rates);
	};
	const S = build();
	const at = (nowIso) => build({ nowIso });
	// One expression of server.js (or of `within`, a piece of it), run as written.
	const expr = (re, label, within = SRC) => {
		const m = re.exec(within);
		if (!m) throw new Error(`server.js has no ${label}`);
		return m[1];
	};
	const FUEL_DAY_RE = /\n\t+local_day: ([^\n]+),\n/;
	const fuelDayExpr = () => expr(FUEL_DAY_RE, "fuel event local_day in detectAndPersistFuelEvents()", lift("detectAndPersistFuelEvents"));
	const evalWith = (code, names, values) => new Function(...names, `return (${code});`)(...values);
	const routeSrc = (head) => {
		const a = SRC.indexOf(head);
		if (a < 0) throw new Error(`server.js has no ${head}`);
		return SRC.slice(a, SRC.indexOf("\n});", a) + 4);
	};

	// Made-up instants.
	const OCT31_LATE = "2026-11-01T04:30:00Z"; // Sat Oct 31 11:30 PM CDT = Sun Nov 1 12:30 AM EDT
	const OCT31_LATE_SQL = "2026-11-01 04:30:00";
	const NOV30_LATE = "2026-12-01T05:30:00Z"; // Mon Nov 30 11:30 PM CST = Tue Dec 1 12:30 AM EST
	const NOV30_LATE_SQL = "2026-12-01 05:30:00";
	const SWITCH_NIGHT = "2026-11-18T05:30:00Z"; // Tue Nov 17 11:30 PM CST, after the switch

	// ── §1 the settings
	const sw = typeof appTime.appTimeZoneSwitch === "function" ? appTime.appTimeZoneSwitch() : "none: no appTimeZoneSwitch()";
	const swShape = (x) => (x && typeof x === "object" ? { zone: x.zone, before: x.before, from: x.from } : x);
	const zoneAtSafe = (iso) => (typeof appTime.businessZoneAt === "function" ? appTime.businessZoneAt(new Date(iso)) : "none: no businessZoneAt()");
	if (scenario === "unset") {
		check("§1 unset: the zone is US Eastern", () => ZONE, NY);
		check("§1 unset: no switch", () => sw, null);
		check("§1 unset: no warning", () => warnings, []);
		check("§1 unset: every instant reads on US Eastern", () => [OCT31_LATE, FROM, NOV30_LATE].map(zoneAtSafe), [NY, NY, NY]);
	} else if (scenario === "zoneOnly") {
		check("§1 APP_TIMEZONE=America/Chicago without APP_TIMEZONE_FROM: refused, the zone stays US Eastern", () => ZONE, NY);
		check("§1 ...no switch", () => sw, null);
		check("§1 ...with one warning naming the missing moment", () => [warnings.length, /APP_TIMEZONE_FROM/.test(warnings[0] || "")], [1, true]);
		check("§1 ...and no instant is re-read", () => [OCT31_LATE, NOV30_LATE].map(zoneAtSafe), [NY, NY]);
	} else if (scenario === "fromOnly") {
		check("§1 APP_TIMEZONE_FROM alone: US Eastern, no switch", () => [ZONE, sw], [NY, null]);
		check("§1 ...with one warning", () => [warnings.length, /APP_TIMEZONE_FROM/.test(warnings[0] || "")], [1, true]);
	} else if (scenario === "badShape" || scenario === "beforeEra") {
		check(`§1 ${scenario === "badShape" ? "a moment that is not an ISO instant in UTC" : "a moment before the Eastern era began (2026-10-09 00:00 EDT)"}: refused, US Eastern, no switch`, () => [ZONE, sw], [NY, null]);
		check("§1 ...with one warning", () => warnings.length, 1);
	} else if (scenario === "before") {
		check("§1 both set, the process started before the moment: \"now\" stays US Eastern until a restart", () => ZONE, NY);
		check("§1 ...with one warning saying so", () => [warnings.length, /after this process started/.test(warnings[0] || "")], [1, true]);
		check("§1 ...the switch is known: Eastern before the instant, Central from it", () => [swShape(sw), zoneAtSafe("2026-11-18T01:59:59.999Z"), zoneAtSafe(FROM)], [{ zone: CHI, before: NY, from: FROM_ISO }, NY, CHI]);
	} else if (scenario === "after") {
		check("§1 both set, the process restarted at the moment: \"now\" is US Central", () => ZONE, CHI);
		check("§1 ...with no warning", () => warnings, []);
		check("§1 ...the switch: Central from APP_TIMEZONE_FROM, Eastern before it", () => [swShape(sw), zoneAtSafe("2026-11-18T01:59:59.999Z"), zoneAtSafe(FROM), zoneAtSafe(NOV30_LATE)], [{ zone: CHI, before: NY, from: FROM_ISO }, NY, CHI, CHI]);
	}

	if (scenario === "after") {
		// ── §2 stamps on the clock that wrote them
		const stamp = (v, opts) => { const r = loadHaul.parseSheetInstant(v, opts); return r ? [new Date(r.ms).toISOString(), r.day] : null; };
		check("§2 a Houston-era stamp (Oct 2) reads Houston's clock, as always", () => stamp("10/02/2026 9:05:00"), [new Date(wall(CHI, 2026, 10, 2, 9, 5)).toISOString(), "2026-10-02"]);
		check("§2 an Eastern-era stamp (Mon Nov 16 11:30 PM) reads Eastern's clock after the switch: 04:30 UTC", () => stamp("11/16/2026 23:30:00"), ["2026-11-17T04:30:00.000Z", "2026-11-16"]);
		check("§2 the evening of the switch, 7:59 PM: Eastern, before the moment", () => stamp("11/17/2026 19:59:00"), ["2026-11-18T00:59:00.000Z", "2026-11-17"]);
		check("§2 the hour the switch repeats, 8:30 PM: its first instant, Eastern's (01:30 UTC)", () => stamp("11/17/2026 20:30:00"), ["2026-11-18T01:30:00.000Z", "2026-11-17"]);
		check("§2 9:30 PM that evening is past the moment on either clock: Central's (03:30 UTC)", () => stamp("11/17/2026 21:30:00"), ["2026-11-18T03:30:00.000Z", "2026-11-17"]);
		check("§2 a Central-era stamp (Mon Nov 30 11:30 PM) reads Central's clock: 05:30 UTC Dec 1, date kept", () => stamp("11/30/2026 23:30:00"), ["2026-12-01T05:30:00.000Z", "2026-11-30"]);
		check("§2 a bare Nov 16 ends at its Eastern midnight", () => stamp("11/16/2026"), ["2026-11-17T04:59:59.999Z", "2026-11-16"]);
		check("§2 a bare Nov 17 ends at its Central midnight: the switch day is 25 hours", () => stamp("11/17/2026"), ["2026-11-18T05:59:59.999Z", "2026-11-17"]);
		check("§2 a zone the caller names still wins", () => stamp("11/16/2026 23:30:00", { tz: CHI }), ["2026-11-17T05:30:00.000Z", "2026-11-16"]);
		check("§2 noon stands for a day: 17:00 UTC before 2026-10-09, Eastern noon to the switch day, Central noon after",
			() => ["2026-04-17", "2026-10-14", "2026-11-16", "2026-11-17", "2026-11-18", "2026-11-30"].map((d) => new Date(S.appNoonMs(d)).toISOString()),
			["2026-04-17T17:00:00.000Z", "2026-10-14T16:00:00.000Z", "2026-11-16T17:00:00.000Z", "2026-11-17T17:00:00.000Z", "2026-11-18T18:00:00.000Z", "2026-11-30T18:00:00.000Z"]);
		check("§2 a stamp keeps its written day on every server reader", () => [S.sheetDayKey("11/17/2026 20:30:00"), S.sheetDayKey("11/16/2026 23:30:00")], ["2026-11-17", "2026-11-16"]);

		// ── §3 pre-switch instants keep their reading
		check("§3 E9 a handover at 11:30 PM CT on Oct 31 keeps its Eastern month (November) after the switch", () => S.assignmentMonthKey(OCT31_LATE), "2026-11");
		const held = loadHaul.buildTruckAtResolver([
			{ driver_name: "Made-up Driver A", start_date: "2026-11-02T12:00:00.000Z", end_date: "2026-11-16T17:30:00.000Z", truck_id: 900, unit: "T-900" },
			{ driver_name: "Made-up Driver B", start_date: "2026-11-16T17:30:00.000Z", end_date: "", truck_id: 900, unit: "T-900" },
		]);
		const truckAt = (driver, day) => { const h = held.forDriverAt(driver, S.appNoonMs(day)); return h ? h.truck_id : null; };
		check("§3 E13 T-900 handed over at 12:30 PM EST on Nov 16: at noon that day driver A still held it", () => [truckAt("Made-up Driver A", "2026-11-16"), truckAt("Made-up Driver B", "2026-11-16")], [900, null]);
		const rateDb = { prepare: () => ({ all: () => [
			{ subject: "driver", subject_key: "made-up driver", rate: 250, effective_from: "2026-10-01T15:00:00.000Z" },
			{ subject: "driver", subject_key: "made-up driver", rate: 300, effective_from: "2026-11-01T04:30:00.000Z" },
		] }) };
		check("§3 P5 a rate saved at 11:30 PM CT on Oct 31 still starts on Nov 1 (its Eastern day)", () => {
			const idx = build({ db: rateDb }).loadPayRateIndex();
			return [idx.at("driver", "made-up driver", "2026-10-31"), idx.at("driver", "made-up driver", "2026-11-01")];
		}, [250, 300]);
		const memDb = new Database(":memory:");
		check("§3 C6 a receipt submitted at 11:30 PM CT on Oct 31 keeps its Eastern submission day; one after the switch takes its Central day", () => {
			const sql = build({ db: memDb }).receiptSubmittedDaySql().replace("COALESCE(NULLIF(timestamp, ''), created_at)", "?");
			return [memDb.prepare(`SELECT ${sql} AS d`).get(OCT31_LATE_SQL).d, memDb.prepare(`SELECT ${sql} AS d`).get(NOV30_LATE_SQL).d];
		}, ["2026-11-01", "2026-11-30"]);
		check("§3 C9 auto-approval's day of a submission, as lib/receipt-auto-approve-pass.js reads it", () => {
			const code = /const appDay = deps\.appDay \|\| \((\(d\) => .+)\);\n/.exec(fs.readFileSync(path.join(ROOT, "lib", "receipt-auto-approve-pass.js"), "utf8"));
			if (!code) throw new Error("no default appDay in lib/receipt-auto-approve-pass.js");
			const reader = evalWith(code[1], ["appTime"], [appTime]);
			return [reader(new Date(OCT31_LATE)), reader(new Date(NOV30_LATE))];
		}, ["2026-11-01", "2026-11-30"]);
		const fuelDay = fuelDayExpr();
		check("§3 F5 a fill at 11:30 PM CT on Oct 31 keeps its Eastern day on a re-scan; one after the switch takes its Central day",
			() => [OCT31_LATE, NOV30_LATE].map((iso) => evalWith(fuelDay, ["appTime", "APP_TIMEZONE", "appDay", "e"], [appTime, ZONE, S.appDay, { startMs: ms(iso) }])), ["2026-11-01", "2026-11-30"]);
		check("§3 D10 the payment report prints a payment made at 11:30 PM CT on Oct 31 on its Eastern day", () => {
			const body = /(const fmtPaidDay = \(s\) => \{[\s\S]*?\n\t\t\};)/.exec(routeSrc('app.get("/api/invoices/report/pdf"'));
			if (!body) throw new Error("no fmtPaidDay in the payment report route");
			const fmtPaidDay = new Function("appTime", "APP_TIMEZONE", "fmtDay", `${body[1]}\nreturn fmtPaidDay;`)(appTime, ZONE, (s) => String(s).slice(0, 10));
			return [fmtPaidDay("2026-11-01T04:30:00.000Z"), fmtPaidDay("2026-12-01T05:30:00.000Z")];
		}, ["2026-11-01", "2026-11-30"]);
		check("§3 F9 an IFTA ping at 11:30 PM CT on Oct 31 counts on its Eastern day; one after the switch on its Central day", () => {
			const line = /\n\t+const day = (appTime\.[^\n]+);\n/.exec(routeSrc('app.get("/api/compliance/ifta/state-detail"'));
			if (!line) throw new Error("no day line in the IFTA state detail");
			return [OCT31_LATE, NOV30_LATE].map((iso) => evalWith(line[1], ["appTime", "APP_TIMEZONE", "curr"], [appTime, ZONE, { location_date_ms: ms(iso) }]));
		}, ["2026-11-01", "2026-11-30"]);
		check("§3 F9 the IFTA default From for December, Oct 1, starts at Eastern midnight (Oct 1 was on the Eastern clock)", () => at("2026-12-10T15:00:00Z").iftaDefaultStartIso(), "2026-10-01T04:00:00.000Z");
		const truckDay = expr(/createdDayRuleFromEnv\(process\.env, (\(ms\) => .+?), \(msg\) =>/, "truck charge day reader");
		check("§3 P14 a truck created at 11:30 PM CT on Oct 31 starts charging on its Eastern day",
			() => [OCT31_LATE, NOV30_LATE].map((iso) => evalWith(truckDay, ["appTime", "APP_TIMEZONE", "appDay"], [appTime, ZONE, S.appDay])(ms(iso))), ["2026-11-01", "2026-11-30"]);
		const tap = (sqlAt) => (tripWorkDays.firstPickupTap([{ new_status: "At Shipper", changed_at: sqlAt, source: "driver", actor: "made-up driver" }], { zone: ZONE }) || {}).day;
		check("§3 P4 a pickup tapped at 11:30 PM CT on Oct 31 stays on its Eastern trip day", () => [tap(OCT31_LATE_SQL), tap(NOV30_LATE_SQL)], ["2026-11-01", "2026-11-30"]);
		check("§3 P4 a trip's days: a tap before the switch on its Eastern day, after it on its Central day", () => {
			const t = tripWorkDays.tripDaysForLoad([
				{ new_status: "At Shipper", changed_at: OCT31_LATE_SQL, source: "driver", actor: "made-up driver" },
				{ new_status: "Delivered", changed_at: "2026-11-01 15:00:00", source: "driver", actor: "made-up driver" },
			], { zone: ZONE, window: { start: "2026-11-01", end: "2026-11-01", pickup: "2026-11-01", assigned: "2026-11-01" } });
			return t && t.days;
		}, ["2026-11-01"]);
		check("§3 P13 an owner-operator stamp at 11:30 PM CT on Oct 31 keeps its Eastern day (ISO and SQLite shapes)",
			() => [ownerOperator.ooStampDay("2026-11-01T04:30:00.000Z", ZONE), ownerOperator.ooStampDay(OCT31_LATE_SQL, ZONE), ownerOperator.ooStampDay(NOV30_LATE_SQL, ZONE)], ["2026-11-01", "2026-11-01", "2026-11-30"]);
		check("§3 S20 the KPI series reads a stored instant on the clock of its time", () => [S.kpiInstantDay(OCT31_LATE_SQL, ZONE), S.kpiInstantDay(NOV30_LATE_SQL, ZONE)], ["2026-11-01", "2026-11-30"]);
		check("§3 a week that straddles the switch (Sat Nov 14-Fri Nov 20): Nov 14 at 11:30 PM CT is Sunday's (Eastern), Nov 18 at 11:30 PM CT is Wednesday's (Central)",
			() => ["2026-11-15T05:30:00Z", "2026-11-19T05:30:00Z"].map((iso) => [S.kpiInstantDay(iso, ZONE), S.getWeekRange(S.kpiInstantDay(iso, ZONE)).weekStart]), [["2026-11-15", "2026-11-14"], ["2026-11-18", "2026-11-14"]]);

		// ── §4 after the switch: the 11 PM-midnight CT hour is the Central day
		check("§4 E1 a delivery at Sun Nov 29 11:30 PM CST is stamped Sunday", () => S.appStamp(new Date("2026-11-30T05:30:00Z")), "11/29/2026 23:30:00");
		check("§4 E2 Sun Jan 31 2027 11:30 PM CST completes in January", () => S.appStamp(new Date("2027-02-01T05:30:00Z")), "01/31/2027 23:30:00");
		check("§4 E3 Fri Dec 4 11:30 PM CST: the completion's day is Friday, billed in that week", () => S.getWeekRange(S.sheetDayKey(S.appStamp(new Date("2026-12-05T05:30:00Z")))), { weekStart: "2026-11-28", weekEnd: "2026-12-04" });
		check("§4 E4 Generate at Fri Dec 4 11:30 PM CST bills the week ending Dec 4", () => at("2026-12-05T05:30:00Z").getWeekRange(), { weekStart: "2026-11-28", weekEnd: "2026-12-04" });
		check("§4 E6 a load added at Mon Nov 30 11:30 PM CST is assigned in November", () => [S.appDay(new Date(NOV30_LATE)), at(NOV30_LATE).appMonthKey()], ["2026-11-30", "2026-11"]);
		check("§4 E10 a CHR invoice minted then is numbered for Nov 30", () => S.invoiceSeqDayKey(new Date(NOV30_LATE)), "11302026");
		check("§4 the switch evening itself: 11:30 PM CST on Nov 17 is still Tuesday", () => [S.appDay(new Date(SWITCH_NIGHT)), appTime.businessDayOf(new Date(SWITCH_NIGHT)), at(SWITCH_NIGHT).appTodayKey()], ["2026-11-17", "2026-11-17", "2026-11-17"]);
		check("§4 a handover at Mon Nov 30 11:30 PM CST starts in November", () => S.assignmentMonthKey(NOV30_LATE), "2026-11");

		// ── §5 fixed times on the Central clock
		check("§5 the cutoff is Friday 6:30 PM CT: 6:29:59 PM CST on time, 6:30:01 PM late", () => [at("2026-11-21T00:29:59Z").isAfterDeadline("2026-11-20"), at("2026-11-21T00:30:01Z").isAfterDeadline("2026-11-20")], [false, true]);
		check("§5 the batch is Friday 7:00 PM CT: 6:59:59 PM CST last week's, 7:00 PM this week's", () => [at("2026-11-21T00:59:59Z").mostRecentInvoiceFriday(), at("2026-11-21T01:00:00Z").mostRecentInvoiceFriday()], ["2026-11-13", "2026-11-20"]);
		check("§5 November (14 grace days) closes at 00:00 CT Dec 15", () => [at("2026-12-15T05:59:59Z").isPastGrace("2026-11", 14), at("2026-12-15T06:00:00Z").isPastGrace("2026-11", 14)], [false, true]);
		check("§5 the Personal sweep of the week of Nov 21 is Saturday Nov 28 06:00 CST", () => new Date(S.personalSweepDueMs("2026-11-21")).toISOString(), "2026-11-28T12:00:00.000Z");
		check("§5 the integrity check is due from 08:00 CST", () => [ic.dueSlot({ now: new Date("2026-11-19T13:59:59Z"), lastRunAt: null, timeZone: ZONE }), ic.dueSlot({ now: new Date("2026-11-19T14:00:00Z"), lastRunAt: null, timeZone: ZONE })], [null, ms("2026-11-19T14:00:00Z")]);
		check("§5 the day-off ELD check is due from 06:00 CST", () => [timeOff.timeOffCheckDue({ nowMs: ms("2026-11-19T11:59:59Z"), timeZone: ZONE, lastDay: "2026-11-18" }).due, timeOff.timeOffCheckDue({ nowMs: ms("2026-11-19T12:00:00Z"), timeZone: ZONE, lastDay: "2026-11-18" }).due], [false, true]);
		check("§5 the KPI snapshot is 03:00 CST and the digest Monday 08:00 CST", () => [new Date(kpiSchedule.snapshotSlot(ms("2026-11-19T15:00:00Z"), ZONE).slotMs).toISOString(), new Date(kpiSchedule.digestSlot(ms("2026-11-23T20:00:00Z"), ZONE).slotMs).toISOString()], ["2026-11-19T09:00:00.000Z", "2026-11-23T14:00:00.000Z"]);

		// ── §6 words follow the zone
		check("§6 the KPI schedule names Central", () => kpiSchedule.scheduleText(ZONE), { snapshot: "Daily at 3:00 AM Central", digest: "Mondays at 8:00 AM Central" });
		check("§6 the KPI week rule names the US Central calendar", () => {
			const r = kpiMetrics.buildKpiResponse({ asOfDay: "2026-11-19", timeZone: ZONE, snapshots: [], series: [], approvals: [], weekly: true, weeklyRows: [] });
			return /Load dates use the US Central calendar;/.test(r.weekly && r.weekly.weekRule) && !/Eastern/.test(r.weekly.weekRule);
		}, true);
		check("§6 the grace-days script labels the close CT", () => (appTime.zoneWords(ZONE) || {}).short, "CT");
	}

	if (scenario === "after" || scenario === "unset") {
		// ── §7 the integrity check (§9 for unset)
		const one = (assigned, date) => ic.classifyStamps([{ id: "LD-MADEUP-1", assigned }], [{ date }], { appZone: ZONE });
		const verdict = (c) => (c.ok.length ? "ok" : c.wrong.length ? `wrong ${c.wrong[0].label}` : "unmatched");
		if (scenario === "after") {
			check("§7 after the switch, an n8n still on Eastern in winter is caught, an hour ahead of Central", () => verdict(one("11/30/2026, 10:21:43 AM", "Mon, 30 Nov 2026 09:21:43 -0600")), "wrong UTC-05:00, 1 hour ahead of Central");
			check("§7 ...and in summer (-240, Eastern daylight time)", () => verdict(one("3/15/2027, 10:21:43 AM", "Mon, 15 Mar 2027 09:21:43 -0500")), "wrong UTC-04:00, 1 hour ahead of Central");
			check("§7 ...the email's time is shown on the Central clock", () => { const w = one("11/30/2026, 10:21:43 AM", "Mon, 30 Nov 2026 09:21:43 -0600").wrong[0]; return [w.expected, /9:21:43/.test(w.eastern)]; }, ["Central", true]);
			check("§7 a pre-switch Eastern stamp is not flagged after the switch", () => verdict(one("11/16/2026, 9:21:43 AM", "Mon, 16 Nov 2026 09:21:43 -0500")), "ok");
			check("§7 a Central stamp after the switch is fine", () => verdict(one("11/30/2026, 9:21:43 AM", "Mon, 30 Nov 2026 09:21:43 -0600")), "ok");
			check("§7 a Central stamp before the switch is still caught, an hour behind Eastern", () => verdict(one("11/16/2026, 8:21:43 AM", "Mon, 16 Nov 2026 09:21:43 -0500")), "wrong UTC-06:00, 1 hour behind Eastern");
			check("§6 the integrity email names Central", () => {
				const z = one("11/30/2026, 10:21:43 AM", "Mon, 30 Nov 2026 09:21:43 -0600");
				const report = ic.buildReport({ now: new Date("2026-11-30T14:00:00Z"), appZone: ZONE, baseline: false, loadsSeen: 1, cmp: { pickupBlanked: [], assignedChanged: [], newStamps: [] }, zone: { ...z, checked: 1, skipped: "" }, receipts: { stale: [], reportedOpen: 0 } });
				return [/Assigned Date not in Central time/.test(report.text), /in Central it is "/.test(report.text), /Eastern/.test(report.text)];
			}, [true, true, false]);
		} else {
			check("§9 unset: an Eastern summer stamp is fine", () => verdict(one("3/15/2027, 9:21:43 AM", "Mon, 15 Mar 2027 09:21:43 -0400")), "ok");
			check("§9 unset: -240 is no candidate on the Eastern clock (a winter stamp an hour ahead stays unmatched)", () => verdict(one("12/1/2026, 10:00:00 AM", "Tue, 01 Dec 2026 09:00:00 -0500")), "unmatched");
			check("§9 unset: a Central stamp is still reported in Eastern's words", () => verdict(one("12/1/2026, 8:00:00 AM", "Tue, 01 Dec 2026 09:00:00 -0500")), "wrong UTC-06:00, 1 hour behind Eastern");
			check("§9 unset: the KPI words and week rule are Eastern's, as before", () => [kpiSchedule.scheduleText(ZONE), kpiMetrics.buildKpiResponse({ asOfDay: "2026-11-19", timeZone: ZONE, snapshots: [], series: [], approvals: [], weekly: true, weeklyRows: [] }).weekly.weekRule === kpiCatalog.WEEK_RULE],
				[{ snapshot: "Daily at 4:00 AM Eastern", digest: "Mondays at 9:00 AM Eastern" }, true]);
		}
	}

	// ── §8 the browser's half
	if (scenario === "after" || scenario === "unset") {
		check(`§8 ${scenario}: the session answer when signed out`, () => {
			const decl = /\n(const APP_TIMEZONE_SWITCH = [^\n]+\nconst APP_TIMEZONE_ERA = [^\n]*(?:\n\t[^\n]*)*)\n/.exec(SRC);
			if (!decl) throw new Error("server.js builds no APP_TIMEZONE_ERA");
			const ERA = new Function("appTime", `${decl[1]}\nreturn APP_TIMEZONE_ERA;`)(appTime);
			let handler = null;
			new Function("app", "APP_TIMEZONE", "APP_TIMEZONE_ERA", "MESSAGE_VOICE_NOTES_ENABLED", routeSrc('app.get("/api/auth/session"'))({ get: (p, h) => { handler = h; } }, ZONE, ERA, false);
			let body = null;
			handler({ session: {} }, { json: (b) => { body = b; } });
			return JSON.stringify(body);
		}, scenario === "unset"
			? JSON.stringify({ authenticated: false, appTimeZone: NY })
			: JSON.stringify({ authenticated: false, appTimeZone: CHI, appTimeZoneEra: { before: NY, from: FROM_ISO } }));
	}

	// ── §9 unset: each changed reader against the code it replaced
	if (scenario === "unset") {
		const instants = [];
		for (let t = ms("2026-10-31T12:00:00Z"); t <= ms("2026-11-02T12:00:00Z"); t += 17 * 60 * 1000) instants.push(t);
		for (let t = ms("2026-11-17T12:00:00Z"); t <= ms("2026-11-19T12:00:00Z"); t += 13 * 60 * 1000) instants.push(t);
		for (let t = ms("2027-03-13T12:00:00Z"); t <= ms("2027-03-15T12:00:00Z"); t += 19 * 60 * 1000) instants.push(t);
		const nyDay = (t) => appTime.dayInZone(new Date(t), NY);
		const sql = (t) => new Date(t).toISOString().slice(0, 19).replace("T", " ");
		const differs = (fn) => instants.filter((t) => { try { return !fn(t); } catch { return true; } }).length;
		check("§9 unset: businessZoneAt / businessDayOf are US Eastern for every instant", () => differs((t) => appTime.businessZoneAt(t) === NY && appTime.businessDayOf(new Date(t)) === nyDay(t)), 0);
		check("§9 unset: assignmentMonthKey() is appDay().slice(0, 7), as before", () => differs((t) => S.assignmentMonthKey(new Date(t).toISOString()) === nyDay(t).slice(0, 7)), 0);
		check("§9 unset: kpiInstantDay(), ooStampDay() and the trip day are the Eastern day, as before", () => differs((t) => S.kpiInstantDay(sql(t), NY) === nyDay(t) && ownerOperator.ooStampDay(sql(t), NY) === nyDay(t)
			&& (tripWorkDays.firstPickupTap([{ new_status: "At Shipper", changed_at: sql(t), source: "driver", actor: "made-up" }], { zone: NY }) || {}).day === nyDay(t)), 0);
		const fuelDay = fuelDayExpr();
		check("§9 unset: the fuel event day is appDay() of its start, as before", () => differs((t) => evalWith(fuelDay, ["appTime", "APP_TIMEZONE", "appDay", "e"], [appTime, NY, S.appDay, { startMs: t }]) === S.appDay(new Date(t))), 0);
		const days = [];
		for (let t = ms("2026-10-01T12:00:00Z"); t <= ms("2027-04-01T12:00:00Z"); t += 86400000) days.push(new Date(t).toISOString().slice(0, 10));
		check("§9 unset: appNoonMs() is Eastern noon for every day from 2026-10-09, 17:00 UTC before, as before", () => days.filter((d) => {
			const [y, m, dd] = d.split("-").map(Number);
			const old = d < "2026-10-09" ? Date.UTC(y, m - 1, dd, 17) : wall(NY, y, m, dd, 12);
			return S.appNoonMs(d) !== old;
		}).length, 0);
		check("§9 unset: a stamp's instant is Eastern's wall clock (Houston's before 2026-10-09), as before", () => days.filter((d) => {
			const [y, m, dd] = d.split("-").map(Number);
			const v = `${m}/${dd}/${y} 23:30:00`;
			const r = loadHaul.parseSheetInstant(v);
			return !r || r.ms !== wall(d < "2026-10-09" ? CHI : NY, y, m, dd, 23, 30, 0);
		}).length, 0);
		check("§9 unset: businessWallClockToMs() is wallClockToMs() on the zone given", () => days.filter((d) => {
			const [y, m, dd] = d.split("-").map(Number);
			return [0, 1, 12, 20, 23].some((h) => appTime.businessWallClockToMs(NY, y, m, dd, h, 30, 0) !== wall(NY, y, m, dd, h, 30, 0));
		}).length, 0);
	}

	process.stdout.write(JSON.stringify(out));
}

// ──────────────────────────────────────────────────────────── the parent
if (process.argv[2] === "--child") {
	child(process.argv[3]);
	process.exit(0);
}

let pass = 0;
const failures = [];
const results = {};
for (const [scenario, settings] of Object.entries(SCENARIOS)) {
	const runs = [];
	for (const tz of ZONES) {
		const env = { ...process.env, TZ: tz };
		delete env.APP_TIMEZONE;
		delete env.APP_TIMEZONE_FROM;
		delete env.FAKE_START;
		Object.assign(env, settings);
		const r = spawnSync(process.execPath, [__filename, "--child", scenario], { env, encoding: "utf8", timeout: 120000 });
		let parsed = null;
		try { parsed = JSON.parse(r.stdout); } catch { parsed = null; }
		if (!parsed) failures.push(`[${scenario} TZ=${tz}] the child wrote no result (exit ${r.status}): ${String(r.stderr || "").trim().split("\n").slice(-1)[0]}`);
		runs.push({ tz, parsed });
	}
	const first = runs[0].parsed || [];
	results[scenario] = first;
	console.log(`\n${scenario} (${Object.entries(settings).map(([k, v]) => `${k}=${v}`).join(" ") || "both settings unset"})`);
	for (const x of first) {
		if (x.ok) pass++;
		else failures.push(`[${scenario}] ${x.name}\n      got  ${JSON.stringify(x.got)}\n      want ${JSON.stringify(x.want)}`);
		console.log(`  ${x.ok ? "ok  " : "FAIL"} ${x.name}`);
	}
	const same = runs.every((r) => JSON.stringify(r.parsed) === JSON.stringify(first));
	if (same) pass++; else failures.push(`[${scenario}] the process zones disagree: ${ZONES.join(", ")}`);
	console.log(`  ${same ? "ok  " : "FAIL"} the same answers under TZ=${ZONES.join(", ")}`);
}

if (failures.length) {
	console.error(`\nFAILURES (${failures.length}):`);
	for (const f of failures) console.error(`  ✗ ${f}`);
	console.error(`\n${pass} passed, ${failures.length} failed`);
	process.exit(1);
}
console.log(`\n✓ ${pass} checks passed`);
