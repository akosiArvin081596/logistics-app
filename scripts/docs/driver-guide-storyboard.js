/**
 * The DRIVER TRAINING GUIDE storyboard — the beats, in the order a driver meets
 * them on a real load. Consumed by capture-driver-guide.js.
 *
 * Each beat is:
 *   id       — filename stem; the numbering is the array order
 *   title    — what this beat teaches (also the voice-over file's heading)
 *   route    — defaults to /driver
 *   anonymous— capture WITHOUT the session cookie (the login screen)
 *   before   — async ({api}) => note; drives the REAL API to reach the state
 *   prep     — async (page, h) => void; drives the UI (tabs, accordions)
 *   settle / delay / fullPage
 *
 * ⚠️ THE ORDER IS LOAD-BEARING, not cosmetic. `before` hooks mutate shared
 * state, so the beats form one continuous journey: DEMO-GUIDE-001 must be
 * accepted before it can advance, and it climbs the status ladder one beat at a
 * time. `one-active-job` sits AFTER `status-in-transit` on purpose — it opens
 * the SECOND demo load to photograph the refusal that PUT /api/driver/status
 * raises while the first is still rolling, so it only reproduces once the first
 * load is genuinely active.
 *
 * ⚠️ Staging is a PRECONDITION, not something these beats do. Both DEMO-GUIDE
 * rows must exist as `Dispatched` with no `load_responses`, and the driver must
 * have no other active load. On this local copy the real load 7086762 sat at
 * "At Receiver" inside a FINALIZED July, so neither the driver route nor an
 * admin sheet edit could retire it — the period had to be reopened, the row
 * completed, and the period re-finalized. Re-shooting one beat with --only
 * after a full run is safe; re-running the whole storyboard needs that staging
 * redone first.
 */

// The demo load created for this guide, and the real load that starts active.
// ⚠️ Howard Reddie, not Shorn King. Deshorn's correction: the guide must show
// real data, never an empty state. Shorn's truck reports fuel_pct = null (a
// sensor dropout), so the Fuel beat rendered "this truck's ELD isn't reporting
// a fuel level" — a blank screen that teaches nothing. LogisX-#33 reports a
// real level against a configured 203-gallon tank, so the range is on screen.
const DRIVER_NAME = "Howard Reddie";

// ⚠️ REAL LOADS, not synthetic rows. Deshorn: "Use real data... show em the
// actual thing." Since the LOCAL sheet is now an exact copy of production's
// Job Tracking, this driver has two genuine loads — real shipper, real
// reference numbers, real commodity and appointment times. The invented
// DEMO-GUIDE rows were deleted; nothing on screen is made up.
//   566293352  Dispatched  HEB (HOUSTON REC) -> Valliant Mill      (the walk)
//   566076070  In Transit  HEB Reverse Logistics -> Fresh-Pak      (the queue)
const DEMO = { loadId: "566293352" };
// A second dispatched load, used only to photograph the "one active job" refusal.
const DEMO2 = { loadId: "566076070" };

/** Find a load's current sheet row + status through the driver's own payload. */
async function findLoad({ api }, loadId) {
	const data = await api(`/api/driver/${encodeURIComponent(DRIVER_NAME)}`);
	const hit = (data.loads || []).find(
		(l) => String(l["Load ID"] || "").replace(/^#/, "") === String(loadId).replace(/^#/, ""),
	);
	if (!hit) throw new Error(`load ${loadId} not in driver payload`);
	return { rowIndex: hit._rowIndex, status: (hit["Job Status"] || "").trim(), load: hit };
}

async function setStatus(ctx, loadId, newStatus) {
	const { rowIndex } = await findLoad(ctx, loadId);
	await ctx.api("/api/driver/status", {
		method: "PUT",
		body: { rowIndex, loadId, newStatus },
	});
	return `${loadId} -> ${newStatus}`;
}

module.exports = [
	// -----------------------------------------------------------------------
	// GETTING IN
	// -----------------------------------------------------------------------
	{
		id: "login",
		highlight: [{ sel: "form", pad: 10, label: 1 }],
		title: "Signing in to LogisX",
		route: "/login",
		anonymous: true,
		settle: 1500,
	},

	// -----------------------------------------------------------------------
	// THE LOADS TAB — home base
	// -----------------------------------------------------------------------
	{
		id: "loads-list",
		highlight: [{ sel: ".load-sub-tabs", label: 1 }, { sel: ".load-card", label: 2 }],
		title: "Your Loads list — home base",
		// ⚠️ LAND ON A TAB THAT HAS CARDS. Staging completes the driver's only
		// active load so the demo load can climb the ladder, which leaves Active
		// empty — and the home-screen beat photographed "No loads in this
		// category" while its script talked through the anatomy of a load card.
		// Pending holds the two demo loads at this point, so the card is real and
		// the beat flows straight into the Accept/Decline one.
		prep: async (page, h) => { await h.subTab("Pending"); },
		settle: 3000,
		delay: 600,
	},
	{
		id: "new-load-card",
		highlight: [{ text: "Decline Load", label: 1 }, { text: "Accept Load", label: 2 }],
		title: "A new load arrives — Accept or Decline",
		before: async (ctx) => {
			// Make sure the demo load is genuinely un-responded so the buttons show.
			const { status } = await findLoad(ctx, DEMO.loadId);
			return `${DEMO.loadId} is ${status}`;
		},
		prep: async (page, h) => {
			await h.subTab("Pending");
			await h.openLoad(DEMO.loadId);
			// ⚠️ The Accept / Decline buttons render at the BOTTOM of LoadDetail,
			// past the fold. Without this the beat photographs the top of the load
			// and shows neither button — which is the one thing it exists to teach.
			await h.scrollTo("Accept Load");
		},
		delay: 800,
	},
	{
		id: "load-accepted",
		highlight: [{ sel: ".van-collapse-item__title", pad: 8, label: 1 }],
		title: "After you Accept — the load is yours",
		before: async (ctx) => {
			const { rowIndex } = await findLoad(ctx, DEMO.loadId);
			try {
				await ctx.api("/api/driver/respond", {
					method: "POST",
					body: { loadId: DEMO.loadId, rowIndex, response: "accepted" },
				});
				return "accepted";
			} catch (e) {
				if (e.status === 409) return "already accepted";
				throw e;
			}
		},
		prep: async (page, h) => { await h.openLoad(DEMO.loadId); },
		delay: 800,
	},

	// -----------------------------------------------------------------------
	// READING THE LOAD — every accordion section
	// -----------------------------------------------------------------------
	{
		id: "route-map",
		highlight: [{ text: "Navigate", label: 1 }],
		title: "Route Map — where you are going",
		prep: async (page, h) => { await h.openLoad(DEMO.loadId); await h.section("Route Map"); },
		delay: 3500,
	},
	{
		id: "pickup-details",
		highlight: [{ section: "Pickup Details", pad: 4, label: 1 }],
		title: "Pickup Details — shipper, address, appointment",
		prep: async (page, h) => { await h.openLoad(DEMO.loadId); await h.section("Pickup Details"); },
		delay: 700,
	},
	{
		id: "dropoff-details",
		highlight: [{ section: "Drop-off Details", pad: 4, label: 1 }],
		title: "Drop-off Details — receiver, address, appointment",
		prep: async (page, h) => { await h.openLoad(DEMO.loadId); await h.section("Drop-off Details"); },
		delay: 700,
	},
	{
		id: "truck-details",
		highlight: [{ section: "Truck Details", pad: 4, label: 1 }],
		title: "Truck Details — the unit assigned to you",
		prep: async (page, h) => { await h.openLoad(DEMO.loadId); await h.section("Truck Details"); },
		delay: 900,
	},

	{
		// ⚠️ SPLIT IN TWO. The fuel panel is far taller than the 896px viewport, so
		// one beat could not hold the range AND the diesel stops — the third
		// highlight fell off the bottom while the narration was still describing
		// it. Deshorn's note was exactly this: the highlight must match the
		// section being explained. One screen, one subject, one script.
		id: "fuel-range",
		highlight: [
			{ sel: ".dfp-hero", pad: 6, label: 1 },
			{ sel: ".dfp-verdict", pad: 6, label: 2 },
		],
		title: "Fuel — how far you can actually go",
		prep: async (page, h) => { await h.openLoad(DEMO.loadId); await h.section("Fuel"); },
		delay: 1600,
	},
	{
		id: "fuel-stops",
		highlight: [
			{ sel: ".dfp-section-title", pad: 6, label: 1 },
			{ sel: ".dfp-stop.cheapest", pad: 6, label: 2 },
		],
		title: "Fuel — where to fill up, cheapest first",
		prep: async (page, h) => {
			await h.openLoad(DEMO.loadId);
			await h.section("Fuel");
			await h.scrollTo("Live pump prices");
		},
		delay: 1600,
	},

	// -----------------------------------------------------------------------
	// THE STATUS LADDER
	// -----------------------------------------------------------------------
	{
		id: "status-at-shipper",
		highlight: [{ sel: ".status-stepper, .stepper, .steps", pad: 6, label: 1 }],
		title: "Arrived at Shipper — your first status update",
		before: async (ctx) => {
			// ⚠️ Free the slot first, and it takes an ADMIN to do it. The driver's
			// other real load is In Transit, and one-active-job makes "At Shipper"
			// 409. The driver route cannot close it either — no POD on that load,
			// so it answers POD_REQUIRED. That guard is the subject of a later beat
			// and must not be weakened, so an admin writes the sheet row instead,
			// exactly as dispatch would.
			const other = await findLoad(ctx, DEMO2.loadId);
			if (!/delivered|completed/i.test(other.status)) {
				const jt = await ctx.adminApi(
					`/api/data?sheet=${encodeURIComponent("Job Tracking")}&limit=200&page=3`);
				const hdrs = jt.headers;
				const vals = hdrs.map((h) => other.load[h] ?? "");
				vals[hdrs.indexOf("Job Status")] = "Completed";
				await ctx.adminApi(
					`/api/data/${other.rowIndex}?sheet=${encodeURIComponent("Job Tracking")}`,
					{ method: "PUT", body: { values: vals } });
			}
			return setStatus(ctx, DEMO.loadId, "At Shipper");
		},
		prep: async (page, h) => { await h.openLoad(DEMO.loadId); },
		delay: 900,
	},
	{
		id: "status-loading",
		highlight: [{ sel: ".action-btn", label: 1 }],
		title: "Loading — while freight is going on the trailer",
		before: async (ctx) => setStatus(ctx, DEMO.loadId, "Loading"),
		prep: async (page, h) => { await h.openLoad(DEMO.loadId); },
		delay: 900,
	},
	{
		id: "status-in-transit",
		highlight: [{ sel: ".action-btn", label: 1 }],
		title: "In Transit — rolling to the receiver",
		before: async (ctx) => setStatus(ctx, DEMO.loadId, "In Transit"),
		prep: async (page, h) => { await h.openLoad(DEMO.loadId); },
		delay: 900,
	},
	{
		// ⚠️ MERGED. There was a separate "Arrived at Receiver" beat before this
		// one; a 32×32 pixel comparison scored the two at 0.00 — byte-different
		// only because the live ETA clock ticks. They are the same screen: the
		// moment the load reaches At Receiver, the POD gate is already what the
		// Update Status card renders. One screen, one beat, one script.
		id: "at-receiver-pod-gate",
		highlight: [{ sel: ".upload-hint", pad: 8, label: 1 }],
		title: "Arrived at Receiver — and why Delivered is not offered yet",
		before: async (ctx) => setStatus(ctx, DEMO.loadId, "At Receiver"),
		prep: async (page, h) => { await h.openLoad(DEMO.loadId); },
		delay: 900,
	},

	// -----------------------------------------------------------------------
	// PAPERWORK AND MONEY
	// -----------------------------------------------------------------------
	{
		id: "documents",
		highlight: [{ section: "Documents", pad: 4, label: 1 }],
		title: "Documents — uploading your POD and BOL",
		prep: async (page, h) => { await h.openLoad(DEMO.loadId); await h.section("Documents"); },
		delay: 1000,
	},
	{
		id: "expenses",
		highlight: [{ section: "Expenses", pad: 4, label: 1 }],
		title: "Expenses — logging fuel, tolls and repairs",
		prep: async (page, h) => { await h.openLoad(DEMO.loadId); await h.section("Expenses"); },
		delay: 1000,
	},
	{
		id: "status-timeline",
		highlight: [{ section: "Status Timeline", pad: 4, label: 1 }],
		title: "Status Timeline — the record of your stops",
		prep: async (page, h) => { await h.openLoad(DEMO.loadId); await h.section("Status Timeline"); },
		delay: 1000,
	},

	// -----------------------------------------------------------------------
	// THE OTHER FOUR TABS
	// -----------------------------------------------------------------------
	{
		id: "alerts",
		highlight: [{ sel: ".notif-group .van-cell", pad: 4, label: 1 }],
		title: "Alerts — dispatch notifications",
		prep: async (page, h) => { await h.tab("Alerts"); },
		delay: 900,
	},
	{
		id: "kit",
		highlight: [{ sel: ".section-header", pad: 8, label: 1 }],
		title: "Kit — your licence, medical card and truck documents",
		prep: async (page, h) => { await h.tab("Kit"); },
		delay: 1400,
	},
	{
		id: "messages",
		highlight: [{ sel: ".chat-recipient", pad: 8, label: 1 }],
		title: "Messages — talking to dispatch",
		prep: async (page, h) => { await h.tab("Messages"); },
		delay: 1000,
	},
	{
		id: "invoices",
		highlight: [{ text: "Generate Weekly Invoice", label: 1 }],
		// ⚠️ This is the one frame that puts a REAL driver's weekly pay on screen,
		// in a guide every other driver will watch. The beat teaches the anatomy
		// of the invoice list — number, week, status, load count — none of which
		// needs the actual amount legible.
		redact: [".inv-amount"],
		title: "Invoices — your weekly pay",
		prep: async (page, h) => { await h.tab("Invoices"); },
		delay: 1400,
	},
];
