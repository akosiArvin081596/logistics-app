// scripts/docs/driver-video-storyboard.js — the ten driver clips.
//
// One clip per task, so a driver can rewatch just the bit they forgot and one
// screen changing only costs one re-record.
//
// `say` is THE source of truth: it becomes the voice-over script AND (trimmed to
// `caption`) the burned-in on-screen line, so the two cannot drift.
//
// ⚠️ WORDING RULES THIS FILE MUST KEEP, ALL THREE VERIFIED AGAINST THE CODE:
//
//  1. STATUS IS AUTOMATIC. server.js:36662 — "arrival statuses, so a completion
//     status can never be auto-written." The ELD geofence moves At Shipper,
//     In Transit and At Receiver on its own; the buttons are a MANUAL FALLBACK.
//     Never tell a driver they must tap at every stop.
//  2. DELIVERED IS THE EXCEPTION, and it is POD-gated. That is the one moment
//     the app genuinely needs the driver, and clip 06 is built around it.
//  3. THE PHONE DOES NOT TRACK THE TRUCK. Tracking is the ELD in the cab.
//     Phone location only sharpens THIS phone's moving map; useDriverPosition.js
//     makes no write call of any kind and POST /api/location is a 410 stub.
//
// ⚠️ BUTTON LABEL != STATUS VALUE. The buttons read "Arrived at Shipper" and
// "Arrived at Receiver" while the statuses read "At Shipper" / "At Receiver".
// Captions quote the BUTTON.

"use strict";

const DEMO = "566293352";   // Howard Reddie's demo load
// ---------------------------------------------------------------------------
// The closing card. Rendered by the runner via page.setContent(), at the same
// 414x896 phone frame as every other clip, so it cuts together seamlessly.
// Large type and high contrast, for the same reason the captions are 26px.
const OUTRO_HTML = `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{width:414px;height:896px;background:#070b18;color:#fff;overflow:hidden;
       font-family:-apple-system,"Helvetica Neue",Arial,sans-serif;
       display:flex;flex-direction:column;justify-content:center;padding:44px 34px}
  .brand{font-size:34px;font-weight:800;letter-spacing:-.5px;margin-bottom:6px}
  .brand span{color:#4da3ff}
  .kicker{font-size:19px;color:#8fa3c8;margin-bottom:38px}
  li{list-style:none;display:flex;gap:14px;align-items:flex-start;margin-bottom:26px;
     font-size:21px;line-height:1.36;font-weight:600;
     opacity:0;transform:translateY(14px);transition:opacity .5s ease,transform .5s ease}
  li.on{opacity:1;transform:none}
  .dot{flex:0 0 12px;height:12px;margin-top:8px;border-radius:50%;background:#FFC400}
  .sign{margin-top:26px;font-size:26px;font-weight:800;color:#FFC400;
        opacity:0;transform:translateY(14px);transition:opacity .6s ease,transform .6s ease}
  .sign.on{opacity:1;transform:none}
  .rule{height:3px;background:linear-gradient(90deg,#4da3ff,#FFC400);border-radius:2px;
        width:0;transition:width .8s ease;margin-bottom:30px}
  .rule.on{width:88px}
</style>
<div class="brand">Logis<span>X</span></div>
<div class="kicker">Before you go</div>
<div class="rule" id="r"></div>
<ul>
  <li id="i0"><span class="dot"></span><span>Your status updates itself &mdash; the truck reports where you are</span></li>
  <li id="i1"><span class="dot"></span><span>Upload your POD at the receiver &mdash; that one is on you</span></li>
  <li id="i2"><span class="dot"></span><span>Log receipts while you're still standing there</span></li>
  <li id="i3"><span class="dot"></span><span>Something looks wrong? Message dispatch</span></li>
</ul>
<div class="sign" id="s">Drive safe out there.</div>
<script>
  window.__outro = (n) => {
    if (n === 0) document.getElementById('r').classList.add('on');
    if (n >= 1 && n <= 4) document.getElementById('i' + (n - 1)).classList.add('on');
    if (n === 5) document.getElementById('s').classList.add('on');
  };
<\/script>`;

const POD_FIXTURE = require("path").join(__dirname, "fixtures", "sample-pod.png");

module.exports = [
	// =========================================================================
	{
		id: "signing-in",
		title: "Signing in",
		route: "/login",
		anonymous: true,
		settle: 1600,
		beats: [
			{
				say: "Welcome to LogisX — the app you'll use for every load you run for us. Everything starts on this sign-in screen.",
				caption: "Everything starts here",
				spot: [{ sel: "form" }],
			},
			{
				say: "Your username is not your name. It is a driver ID that dispatch gives you. On most accounts it looks like LogisX, a dash, and four numbers. It never changes. Save it in your phone.",
				caption: "Your username is a driver ID, not your name",
				do: async (page, h) => {
					await h.type({ sel: 'input[autocomplete="username"]' }, "LogisX-0621");
				},
			},
			{
				say: "Type your password, and tap Sign In. If you've forgotten it, don't guess — call dispatch and they'll reset it for you.",
				caption: "Type your password, then tap SIGN IN",
				do: async (page, h) => {
					await h.type({ sel: 'input[autocomplete="current-password"]' }, "Password123!");
					await h.tap({ text: "SIGN IN", exact: false });
					await h.settle(3200);
				},
				dwell: 9000,
			},
			{
				say: "And you're in. This is your Loads list — home base for everything you do in the app.",
				caption: "You're in. This is your Loads list",
			},
		],
	},

	// =========================================================================
	{
		id: "your-loads-list",
		title: "Your loads list",
		reset: async (ops) => ops.freeActiveSlot(DEMO),
		beats: [
			{
				say: "Your loads sit in three tabs. Active is what you are running now. Pending is a load dispatch has offered you, that you have not answered yet. Historical is everything you have finished.",
				caption: "Three tabs: Active, Pending, Historical",
				spot: [{ sel: ".load-sub-tabs" }],
			},
			{
				say: "Each card shows the load number, where it's going from and to, and your pickup and delivery dates. Tap any card to open the full load.",
				caption: "Tap any card to open the full load",
				spot: [{ sel: ".load-card" }],
			},
			{
				say: "If you're looking for an older load, tap Filter and search by load number, city, or date.",
				caption: "Tap Filter to search by number, city or date",
				do: async (page, h) => { await h.point({ sel: ".filter-toggle" }); },
			},
		],
	},

	// =========================================================================
	{
		id: "accept-or-decline",
		title: "Accepting or declining a load",
		note:
			"Filmed on the LOAD CARD, not the detail page. LoadDetail's Accept/Decline sit " +
			"~344px below the fold on a 896px viewport (measured y=1240), so every take " +
			"depended on a scroll landing and one silently tapped the Messages tab instead. " +
			"The card buttons are on screen from the first frame — and the card is where a " +
			"driver actually meets the offer.",
		reset: async (ops) => {
			await ops.freeActiveSlot(DEMO);
			return ops.redispatch(DEMO);
		},
		open: async (page, h) => { await h.subTab("Pending"); },
		beats: [
			{
				say: "When dispatch offers you a load it lands in Pending, and you get an alert on your phone.",
				caption: "New offers land in Pending",
				spot: [{ text: "Pending", exact: false }],
			},
			{
				say: "The card tells you the load number, where it is going from and to, and your pickup and delivery dates. Read that before you answer.",
				caption: "Read the card before you answer",
				spot: [{ sel: ".load-card" }],
				dwell: 9000,
			},
			{
				say: "Two buttons sit right on the card. Decline, and Accept.",
				caption: "Two buttons, right on the card",
				do: async (page, h) => { await h.point({ sel: ".load-card .action-btn.decline" }); },
			},
			{
				say: "If you cannot run it, tap Decline. It asks you to confirm, then the load goes back to the board for another driver. Nothing bad happens — dispatch would far rather know early.",
				caption: "Can't run it? Decline — tell dispatch early",
				dwell: 11000,
			},
			{
				say: "If you can run it, tap Accept.",
				caption: "If you can run it, tap Accept",
				do: async (page, h) => { await h.tap({ sel: ".load-card .action-btn.accept" }); await h.settle(3200); },
				dwell: 8000,
			},
			{
				say: "The load moves straight into your Active tab, and it is yours to run.",
				caption: "It moves to Active — the load is yours",
				do: async (page, h) => { await h.subTab("Active"); await h.settle(2400); },
				dwell: 8000,
			},
		],
	},

	// =========================================================================
	{
		id: "your-load-at-a-glance",
		title: "Your load at a glance",
		reset: async (ops) => {
			await ops.freeActiveSlot(DEMO);
			return ops.setSheetStatus(DEMO, "Assigned");
		},
		open: async (page, h) => { await h.subTab("Active"); await h.openLoad(DEMO); },
		beats: [
			{
				say: "Open a load and the first thing you get is the map. The blue dot is your truck.",
				caption: "The blue dot is your truck",
				do: async (page, h) => { await h.section("Route Map"); await h.settle(2600); },
				dwell: 7000,
			},
			{
				say: "That blue dot comes from the black box wired into your truck — the ELD. It sends your position by itself, all day. You don't have to do anything. You don't have to keep the app open. And you do not have to share your phone's location for us to see you.",
				caption: "The dot comes from your truck, not your phone",
				dwell: 11000,
			},
			{
				say: "Tap Navigate for turn-by-turn directions, spoken out loud. That is the one place the app uses your phone's location. It stays on your phone. It only steers this map.",
				caption: "Tap Navigate for spoken directions",
				at: "top",
				do: async (page, h) => { await h.point({ text: "Navigate", exact: false }, { at: "top" }); },
			},
			{
				say: "Scroll down for Pickup Details and Drop-off Details — the addresses, the appointment times, and who to ask for.",
				caption: "Pickup and Drop-off Details are further down",
				expect: { section: "Pickup Details" },
				do: async (page, h) => {
					// ⚠️ The Route Map above is ~350px tall; with it open there is not
					// enough travel left to lift the pickup panel clear of the caption
					// band, so the beat narrated detail you could only just glimpse.
					await h.closeSection("Route Map");
					await h.openSection("Pickup Details");
					await h.settle(1200);
				},
				dwell: 9000,
			},
			{
				say: "Drop-off Details sits right underneath, with the same for the receiver. And every address has a copy button, so you can paste it into whatever you navigate with.",
				caption: "Every address has a copy button",
				do: async (page, h) => {
					await h.closeSection("Pickup Details");
					await h.openSection("Drop-off Details");
				},
				expect: { section: "Drop-off Details" },
				dwell: 9000,
			},
		],
	},

	// =========================================================================
	{
		id: "fuel-and-diesel-stops",
		title: "Fuel range and diesel stops",
		reset: async (ops) => ops.setSheetStatus(DEMO, "Assigned"),
		open: async (page, h) => {
			await h.subTab("Active");
			await h.openLoad(DEMO);
			await h.scrollSafe({ text: "Fuel", exact: false }, { instant: true });
		},
		beats: [
			{
				say: "Open the Fuel section and the app tells you whether this run actually fits in your tank.",
				caption: "Does this run fit in your tank?",
				do: async (page, h) => { await h.openSection("Fuel", { settle: 4200 }); },
				dwell: 11000,
			},
			{
				say: "The big number is the miles you can count on before you need to refuel. It's the low end of the range, not the best case — so if it says you'll make it, you'll make it.",
				caption: "The low end of the range, not the best case",
				dwell: 9000,
			},
			{
				say: "Underneath is your fuel level, the gallons left in the tank, and your truck number. All of it read straight from the truck itself.",
				caption: "Fuel level and gallons, read from your truck",
				expect: { section: "Fuel" },
				do: async (page, h) => { await h.scrollSafe({ text: "Gallons left", exact: false }); },
			},
			{
				say: "Then the diesel stops along your route. These are truck stops — places you can actually get the truck into and fuel at a truck lane, not corner gas stations. Each one shows the live pump price where we have it, how far off your route it is, and the cheapest is tagged.",
				caption: "Truck stops on your route, with live pump prices",
				expect: { text: "CHEAPEST", exact: false },
				do: async (page, h) => { await h.scrollSafe({ sel: ".dfp-refresh" }); await h.settle(1200); },
				dwell: 9000,
			},
		],
	},

	// =========================================================================
	{
		id: "status-updates-itself",
		title: "Your status updates itself",
		note:
			"THE most important clip. Drivers routinely believe they must tap at every stop; " +
			"tryGeofenceAdvance() moves the status from the truck's own ELD position. Land the " +
			"'you don't have to do this' line clearly, then the button as a backup.",
		reset: async (ops) => {
			await ops.freeActiveSlot(DEMO);
			return ops.setSheetStatus(DEMO, "At Shipper");
		},
		open: async (page, h) => {
			await h.subTab("Active");
			await h.openLoad(DEMO);
			await h.openSection("Update Status");
		},
		beats: [
			{
				say: "Here's the part most drivers get wrong, so it's worth thirty seconds. You do not have to update your status. Your truck does it for you.",
				caption: "You don't have to update your status",
				expect: { sel: ".stepper" },
				spot: [{ sel: ".stepper" }],
				dwell: 9000,
			},
			{
				say: "These six steps are your load start to finish: Heading to Shipper, At Shipper, Loading, In Transit, At Receiver, Delivered.",
				caption: "Six steps, start to finish",
				dwell: 9000,
			},
			{
				say: "The black box in your truck reports where you are. Pull into the shipper, and the app moves you to At Shipper by itself. Pull out loaded, and it moves you to In Transit. Reach the receiver, and it marks you At Receiver. You tap nothing.",
				caption: "Arrive, and the app moves the step by itself",
				dwell: 13000,
			},
			{
				say: "So the blue button underneath is your backup, not your job. If you've arrived and the app hasn't caught up — a weak signal, or the ELD is slow — tap it.",
				caption: "The button is your backup, not your job",
				at: "top",
				do: async (page, h) => { await h.point({ sel: ".action-btn.primary" }, { at: "top" }); },
				dwell: 9000,
			},
			{
				say: "It always asks you to confirm first, so you can't move a load by accident.",
				caption: "It always asks you to confirm",
				at: "top",
				do: async (page, h) => {
					await h.tap({ sel: ".action-btn.primary" }, { at: "top" });
					await h.settle(2600);
				},
				dwell: 7000,
			},
			{
				say: "Confirm, and the step ticks over.",
				caption: "Confirm — and the step ticks over",
				at: "top",
				do: async (page, h) => {
					await h.tap({ sel: ".confirm-dialog .btn-primary" }, { at: "top" });
					// ⚠️ > the toast's 3s life, so the confirmation is never clipped
					// mid-fade and a later toast cannot overwrite it.
					await h.settle(3600);
				},
				dwell: 7000,
			},
			{
				say: "That's the whole thing. Arrive, do your job, and let the truck handle the paperwork.",
				caption: "Arrive, do your job, let the truck do the paperwork",
			},
		],
	},

	// =========================================================================
	{
		id: "upload-your-pod",
		title: "Uploading your POD — the one step that's on you",
		note:
			"The emotional centre of the series. Everything else is automatic; this is the " +
			"one thing that genuinely needs the driver, and it gates their pay as well as ours.",
		reset: async (ops) => {
			await ops.freeActiveSlot(DEMO);
			// ⚠️ STATUS DOWN FIRST. DELETE /api/documents/:id answers 409
			// LAST_POD_ON_DELIVERED_LOAD while the load is still Delivered and this
			// is its only POD.
			await ops.setSheetStatus(DEMO, "At Receiver");
			return ops.clearPods(DEMO);
		},
		open: async (page, h) => {
			await h.subTab("Active");
			await h.openLoad(DEMO);
			await h.openSection("Update Status");
		},
		beats: [
			{
				say: "You'll reach the receiver and the app will mark you At Receiver on its own, like every step before it. But the last one is different.",
				caption: "The last step is different",
				dwell: 8000,
			},
			{
				say: "Delivered is the only status the app will never set for you. Look — five steps ticked, one to go, and there's no Delivered button. Instead it asks for a Proof of Delivery.",
				caption: "There's no Delivered button — it wants your POD first",
				spot: [{ sel: ".status-collapse-body" }],
				dwell: 11000,
			},
			{
				say: "That is on purpose, and you cannot tap past it. The signed paperwork is what we bill the customer with. No paperwork means no bill. That holds up your pay just as much as ours.",
				caption: "No paperwork means no bill — and no pay",
				dwell: 11000,
			},
			{
				say: "So open Documents, leave the type on Proof of Delivery, and tap Scan Document.",
				caption: "Open Documents and tap Scan Document",
				expect: { section: "Documents" },
				do: async (page, h) => { await h.openSection("Documents", { settle: 1800 }); },
				dwell: 8000,
			},
			{
				say: "Take a picture of the signed paperwork. The app straightens it and cleans it up for you. That is why you use Scan Document instead of a plain photo — brokers send back a crooked, shadowy picture.",
				caption: "Scan Document straightens and cleans the page",
				do: async (page, h) => { await h.uploadTo({ sel: ".doc-upload .scan-btn" }, POD_FIXTURE); await h.settle(4000); },
				dwell: 12000,
			},
			{
				say: "Then tap Upload. Once it's through, the Delivered button appears — and that load is done.",
				caption: "Tap Upload, and the Delivered button appears",
				do: async (page, h) => { await h.tap({ text: "Upload", exact: false }); await h.settle(3600); },
				dwell: 9000,
			},
		],
	},

	// =========================================================================
	{
		id: "log-an-expense",
		title: "Logging a fuel receipt",
		reset: async (ops) => ops.setSheetStatus(DEMO, "In Transit"),
		open: async (page, h) => { await h.subTab("Active"); await h.openLoad(DEMO); },
		beats: [
			{
				say: "Bought fuel, paid a toll, or had a repair on the road? Log it against the load while you're still standing there — open the load and tap Expenses.",
				caption: "Log it while you're still standing there",
				expect: { section: "Expenses" },
				do: async (page, h) => { await h.openSection("Expenses", { settle: 2000 }); },
				dwell: 9000,
			},
			{
				say: "Pick the type, take a picture of the receipt, and the app reads it for you. The amount, the date, the store, the city and the state all fill themselves in.",
				caption: "Take a picture — the app fills it in for you",
				dwell: 9000,
			},
			{
				say: "Always check what it filled in. It's very good, but it isn't perfect, and you can correct any field before you submit.",
				caption: "Always check what it filled in — you can fix any field",
				dwell: 7000,
			},
			{
				say: "Then tap Submit Expense. If you accidentally log the same receipt twice, the app catches it and asks — it won't quietly double up.",
				caption: "Tap Submit Expense — duplicates get caught",
				do: async (page, h) => { await h.point({ text: "Submit Expense" }); },
			},
		],
	},

	// =========================================================================
	{
		id: "alerts-and-messages",
		title: "Alerts and messaging dispatch",
		open: async (page, h) => { await h.tab("Alerts"); },
		beats: [
			{
				say: "The Alerts tab is everything the app wants to tell you — a new load offered, or a status that moved on its own when you arrived somewhere.",
				caption: "Alerts: new loads, and statuses that moved",
				dwell: 8000,
			},
			{
				say: "Tap any alert and it takes you straight to the load it's about.",
				caption: "Tap an alert to jump to that load",
			},
			{
				say: "And Messages is your direct line to dispatch. Type, send, and it's on their screen.",
				caption: "Messages is your direct line to dispatch",
				do: async (page, h) => { await h.tab("Messages"); await h.settle(2400); },
				dwell: 7000,
			},
			{
				say: "If you're on a load, dispatch sees which load you're asking about, so you don't have to explain which one.",
				caption: "Dispatch sees which load you're asking about",
			},
		],
	},

	// =========================================================================
	{
		id: "your-kit-and-truck",
		title: "Your kit and your truck",
		note:
			"The Kit page is taller than three viewports. This clip SCROLLS it — narrating " +
			"'your licence, your medical card and every contract you've signed' over a static " +
			"shot of the profile card promises content the clip never shows.",
		open: async (page, h) => { await h.tab("Kit"); },
		beats: [
			{
				say: "The Kit tab is your paperwork, and it is the one to remember at a scale or an inspection.",
				caption: "Kit is your paperwork — remember it at inspections",
				expect: { text: "Driver Kit", exact: false },
				dwell: 7000,
			},
			{
				say: "At the top is you — your name, your carrier, your truck and how we reach you.",
				caption: "At the top is you, and your truck",
				expect: { text: "Carrier Name", exact: false },
				dwell: 7000,
			},
			{
				say: "Scroll down and you get Truck Documents — the registration, the insurance and the IFTA papers for the truck you are in. Tap View, and show them straight off your phone.",
				caption: "Truck Documents — registration, insurance, IFTA",
				expect: { text: "Truck Documents", exact: false },
				do: async (page, h) => { await h.reveal({ steps: 1, hold: 1800 }); },
				dwell: 11000,
			},
			{
				say: "Keep going and you will find your own licence and medical card, and every contract you have signed with us, so you always have a copy on you.",
				caption: "Your licence, medical card and signed contracts",
				do: async (page, h) => { await h.reveal({ steps: 2, hold: 2000 }); },
				dwell: 12000,
			},
			{
				say: "And anything the office has shared with you sits at the bottom. If your truck changes, all of this changes with it, so you are always showing the right papers.",
				caption: "Change truck, and the papers change with it",
				do: async (page, h) => { await h.reveal({ steps: 2, hold: 1800 }); },
				dwell: 11000,
			},
		],
	},

	// =========================================================================
	{
		id: "invoices-and-getting-paid",
		title: "Invoices and getting paid",
		open: async (page, h) => { await h.tab("Invoices"); },
		beats: [
			{
				say: "The Invoices tab is how you get paid. Each week's invoice covers the loads you completed in that week.",
				caption: "Each week's invoice covers that week's loads",
				dwell: 7000,
			},
			{
				say: "You can make one yourself with the button. But you usually do not need to. The system makes it and sends it for you, on its own, every Friday evening.",
				caption: "It is made and sent for you every Friday",
				dwell: 9000,
			},
			{
				say: "The deadline that matters to you is Friday, six-thirty in the evening, Central time. Anything you log after that lands on next week's invoice.",
				caption: "Deadline: Friday 6:30 PM Central",
				dwell: 9000,
			},
			{
				say: "Tap any invoice to see the loads on it, the receipts you sent in, and to open the PDF. If something looks wrong, message dispatch before the week closes. It is far easier to fix then.",
				caption: "Something wrong? Tell dispatch before the week closes",
				dwell: 9000,
			},
		],
		outro: { caption: "That's the app. Drive safe out there.", dwell: 2600 },
	},

	// =========================================================================
	// CLOSING CARD
	//
	// A rendered page rather than the app: the series ends on the four things a
	// driver has to remember, and none of them is a screen. `html` makes the
	// runner setContent() instead of navigating, so this needs no session and no
	// staging. Captions are blank on purpose — the card IS the text.
	// =========================================================================
	{
		id: "before-you-go",
		title: "Before you go",
		html: OUTRO_HTML,
		settle: 900,
		beats: [
			{ say: "So that is the app.", caption: "", dwell: 3200,
			  do: async (page, h) => { await page.evaluate("window.__outro(0)"); } },
			{ say: "Your status looks after itself — the truck reports where you are.", caption: "", dwell: 5200,
			  do: async (page, h) => { await page.evaluate("window.__outro(1)"); } },
			{ say: "Upload your POD at the receiver. That is the one step that is genuinely on you, and it is what gets you paid.", caption: "", dwell: 6600,
			  do: async (page, h) => { await page.evaluate("window.__outro(2)"); } },
			{ say: "Log your receipts while you are still standing there.", caption: "", dwell: 4600,
			  do: async (page, h) => { await page.evaluate("window.__outro(3)"); } },
			{ say: "And if anything looks wrong, message dispatch. Do not sit on it.", caption: "", dwell: 5200,
			  do: async (page, h) => { await page.evaluate("window.__outro(4)"); } },
			{ say: "That is everything. Drive safe out there.", caption: "", dwell: 5000,
			  do: async (page, h) => { await page.evaluate("window.__outro(5)"); } },
		],
	},
];
