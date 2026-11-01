// The driver app walkthrough video: every made-up value it shows (DEMO) and every caption it
// carries (each beat's `say`). plant.cjs writes only DEMO values; driver-walkthrough.mjs films
// the chapters in order; captions.cjs turns `say` plus the measured beat times into the VTT.
// Wording changes go here, then `driver-walkthrough.mjs --captions-only`; never edit the VTT.
"use strict";

// Every name carries "Example", "Sample" or "Demo"; loads are LX-2xxxx, phones 555-01xx,
// mail @example.com (scripts/test-driver-walkthrough-media.js lints all of it).
const DEMO = Object.freeze({
	driver: Object.freeze({
		name: "Casey Example",
		username: "casey.example",
		phone: "555-0142",
		email: "casey.example@example.com",
		city: "Dallas",
		state: "TX",
		// Days since onboarding: past the 14-day "Welcome to the Team!" card.
		onboardedDaysAgo: 60,
	}),
	truck: Object.freeze({ unit: "T-101", make: "Demo", model: "Sample Tractor", year: "2022" }),
	dispatch: "Dispatch",
	// Day offsets are from the business day the plant runs on (APP_TIMEZONE).
	loads: Object.freeze([
		Object.freeze({
			key: "delivered", id: "LX-20311", status: "Delivered", details: "Dry van", trailer: "TR-5502",
			pickupInfo: "Sample Foods DC", pickupAddress: "100 Example Way, Dallas, TX", pickupDay: -9, pickupTime: "7:30",
			dropInfo: "Demo Grocers Warehouse", dropAddress: "500 Demo Pkwy, Oklahoma City, OK", dropDay: -8, dropTime: "13:00",
			assignedDay: -10, completedDay: -8, payment: "$1,180.00",
		}),
		Object.freeze({
			key: "active", id: "LX-20398", status: "In Transit", details: "Dry van", trailer: "TR-5501",
			pickupInfo: "Sample Foods DC", pickupAddress: "100 Example Way, Dallas, TX", pickupDay: -1, pickupTime: "8:00",
			dropInfo: "Demo Grocers Warehouse", dropAddress: "200 Sample Rd, Memphis, TN", dropDay: 0, dropTime: "14:00",
			assignedDay: -2, completedDay: null, payment: "$1,450.00",
		}),
		Object.freeze({
			key: "pending", id: "LX-20417", status: "Dispatched", details: "Reefer", trailer: "TR-5507",
			pickupInfo: "Example Paper Mill", pickupAddress: "300 Demo Ave, Little Rock, AR", pickupDay: 2, pickupTime: "7:00",
			dropInfo: "Sample Supply Hub", dropAddress: "400 Example Blvd, Atlanta, GA", dropDay: 3, dropTime: "15:00",
			assignedDay: 0, completedDay: null, payment: "$1,720.00",
		}),
	]),
	// Seen in Messages: one note from dispatch and the driver's reply, then the line typed on camera.
	messages: Object.freeze([
		Object.freeze({ from: "dispatch", text: "Morning Casey. The receiver says door 12 when you check in.", minutesAgo: 55, read: false }),
		Object.freeze({ from: "driver", text: "Got it, thanks. About 30 minutes out.", minutesAgo: 52, read: true }),
	]),
	typedMessage: "Checked in at door 12. Waiting to unload.",
	// Seen in Alerts. Titles and bodies follow what the server writes for each type.
	notifications: Object.freeze([
		Object.freeze({ type: "geofence", title: "At Receiver — Load LX-20398", body: "You have arrived at the delivery location", minutesAgo: 40, read: false }),
		Object.freeze({ type: "message", title: "New message from Dispatch", body: "Morning Casey. The receiver says door 12 when you check in.", minutesAgo: 55, read: false }),
		Object.freeze({ type: "load-assigned", title: "New Load Assigned: LX-20417", body: "Little Rock, AR → Atlanta, GA", minutesAgo: 120, read: true }),
	]),
	// Seen in Kit > Truck Documents (file names only; no file is served or opened).
	truckDocuments: Object.freeze([
		Object.freeze({ docType: "Registration", fileName: "T-101 registration (sample).pdf", notes: "Sample document" }),
		Object.freeze({ docType: "Insurance", fileName: "T-101 insurance card (sample).pdf", notes: "Sample document" }),
	]),
	// Last full Saturday-to-Friday week. Totals are made up; the server works out "your pay".
	invoice: Object.freeze({ number: "INV-DEMO-1042", status: "Submitted", days: 5, ratePerDay: 250, earnings: 1250, receipts: 412.5 }),
	// Typed on camera into the expense form.
	expense: Object.freeze({ type: "Fuel", amount: "412.50", gallons: "98.2", vendor: "Example Fuel Stop" }),
	// Drawn at run time; both say they are not real documents.
	props: Object.freeze({
		podTitle: "BILL OF LADING / PROOF OF DELIVERY",
		receiptTitle: "SAMPLE RECEIPT",
		notReal: "SAMPLE — NOT A REAL DOCUMENT",
	}),
});

const loadByKey = (key) => DEMO.loads.find((l) => l.key === key);

// The title and outro cards (HTML in the same 390 x 844 viewport). The poster is taken
// from the title card at 1.5 s, so it shows no app data.
const CARDS = Object.freeze({
	title: Object.freeze({
		heading: "How to use the LogisX driver app",
		lines: Object.freeze(["About 4 minutes", "Captions on"]),
		footnote: "Every name, load and address in this video is made up.",
	}),
	outro: Object.freeze({
		heading: "Remember",
		lines: Object.freeze([
			"Your status updates itself.",
			"Upload your POD at delivery.",
			"Log receipts under the load.",
			"Questions? Message dispatch.",
		]),
		footnote: "Every name, load and address in this video is made up.",
	}),
});

// Chapters in film order. `say` is the caption for that beat; a beat without `say` is
// filmed with no caption. `holdMs` asks for a longer beat than the captions need.
const CHAPTERS = Object.freeze([
	{ n: 0, id: "title", title: "Title", beats: [
		{ id: "card", say: "How to use the LogisX driver app. About 4 minutes.", holdMs: 4200 },
	] },
	{ n: 1, id: "signin", title: "Signing in", beats: [
		{ id: "open", say: "Sign in with the username and password dispatch gave you." },
		{ id: "username", say: "Type your username." },
		{ id: "password", say: "Then your password. It shows as dots." },
		{ id: "tap", say: "Tap Sign In. Your loads open first." },
		{ id: "help", say: "Can't sign in? Call dispatch." },
	] },
	{ n: 2, id: "loads", title: "Your loads", beats: [
		{ id: "tabs", say: "Your loads sit under three tabs: Active, Pending and Historical." },
		{ id: "active", say: "Active is the load you're running now." },
		{ id: "pending", say: "Pending holds new loads from dispatch." },
		{ id: "historical", say: "Historical lists the loads you've finished." },
	] },
	{ n: 3, id: "accept", title: "Accept or decline", beats: [
		{ id: "card", say: "A new load shows its route and its pickup and delivery dates." },
		{ id: "buttons", say: "Tap Accept to take it, or Decline if you can't run it." },
		{ id: "accept", say: "Once accepted, it moves to Active." },
	] },
	{ n: 4, id: "loadpage", title: "Your load page", beats: [
		{ id: "open", say: "Tapping a load opens its page, with its number and status at the top." },
		{ id: "sections", say: "Tap a section's title to open or close it." },
		{ id: "pickup", say: "Pickup Details shows the shipper, the address and your appointment." },
		{ id: "times", say: "Appointment times are the facility's local time." },
		{ id: "dropoff", say: "Drop-off Details shows where it delivers." },
	] },
	{ n: 5, id: "status", title: "Status updates itself", beats: [
		{ id: "stepper", say: "This bar shows where the load is. Right now it's In Transit." },
		{ id: "eld", say: "The ELD, the black box in your truck, moves the status by itself at each stop." },
		{ id: "phone", say: "Your phone doesn't track the truck. The ELD does." },
		{ id: "fallback", say: "If a stop is missed, use the button. It's only a backup." },
		{ id: "confirm", say: "Tap it, then Confirm." },
		{ id: "pod", say: "Delivered is the one step that needs you: upload your POD first." },
	] },
	{ n: 6, id: "pod", title: "Upload the POD", beats: [
		{ id: "open", say: "Open Documents to add your paperwork." },
		{ id: "type", say: "Proof of Delivery is already picked as the type." },
		{ id: "photo", say: "Tap Scan Document to use the camera, or Upload File for a saved photo." },
		{ id: "upload", say: "Then tap Upload. Dispatch needs it to close out the load." },
		{ id: "delivered", say: "Now Delivered is ready when you finish." },
	] },
	{ n: 7, id: "receipts", title: "Receipts and fuel", beats: [
		{ id: "open", say: "Log fuel, tolls and repairs under the load, in Expenses." },
		{ id: "photo", say: "Add a photo of the receipt." },
		{ id: "amount", say: "Enter the amount, and for fuel, the gallons." },
		{ id: "submit", say: "Tap Submit Expense. It's filed under this load." },
		{ id: "window", say: "You can add receipts until 7 days after delivery." },
	] },
	{ n: 8, id: "messages", title: "Alerts and messages", beats: [
		{ id: "alerts", say: "Alerts shows updates about your loads." },
		{ id: "messages", say: "Messages go straight to dispatch." },
		{ id: "send", say: "Type a note and tap send." },
	] },
	{ n: 9, id: "kit", title: "Your Kit", beats: [
		{ id: "open", say: "Your Kit keeps your papers in one place." },
		{ id: "docs", say: "Truck papers for inspections, your CDL, and the contracts you signed." },
	] },
	{ n: 10, id: "invoice", title: "Weekly invoice", beats: [
		{ id: "open", say: "Invoices is where you send your weekly invoice." },
		{ id: "week", say: "Pick the week with the arrows." },
		{ id: "generate", say: "Tap Generate Weekly Invoice by Friday, 6:30 PM Eastern." },
		{ id: "history", say: "Past invoices are listed below. Tap one to open its PDF." },
	] },
	{ n: 11, id: "wrapup", title: "Wrap-up", beats: [
		{ id: "card", say: "Remember: your status updates itself, upload your POD, log your receipts, and message dispatch.", holdMs: 9000 },
	] },
]);

function chapterBy(ref) {
	const s = String(ref);
	return CHAPTERS.find((c) => String(c.n) === s || c.id === s) || null;
}

module.exports = { DEMO, CARDS, CHAPTERS, chapterBy, loadByKey };
