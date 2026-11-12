"use strict";

// What has changed for drivers, in plain words. A PR that changes what a driver can see adds one
// entry at the end of RELEASES, and that is the whole of marking a release driver-facing: a driver
// reads it right after their next sign-in. Nothing opens on a page already open, and nobody is
// signed out for it. No new entry, no note, so a fix no driver can see disturbs nobody.
//
//   id     "YYYY-MM-DD-some-words", in order, never reused: seen rows hold it
//   title  one short line
//   notes  the lines they read: a string is for every driver; { text, needs } only for a driver
//          with that part of the app, since a note about a tab they haven't got would mislead them
//   tour   the app tour's steps "Show me" walks through (TOUR_STEPS in the client lib)
//
// Every driver reads these as written: no figure, no name, nothing from real data, since a number
// here can't follow a week with time off. scripts/test-driver-release-notices.js pins the list.
// Pure: no database, no network, no process state.

const NEEDS = Object.freeze(["performance"]);

// The seen row of the app tour itself: a first-time driver's offer and the whole tour. Not a
// release id's shape, so no entry can collide with it. The client lib holds the same name.
const APP_TOUR_ROW = "app-tour";

function deepFreeze(value) {
	if (value && typeof value === "object") {
		for (const child of Object.values(value)) deepFreeze(child);
		Object.freeze(value);
	}
	return value;
}

const RELEASES = deepFreeze([
	{
		id: "2026-11-06-my-week",
		title: "Your week and your fuel range",
		notes: [
			{ text: "A bar on the Loads page shows your loads this week. Tap it to see which loads counted and what's left.", needs: "performance" },
			{ text: "Each pickup and each delivery now counts toward your week.", needs: "performance" },
			{ text: "The new Performance tab shows your count, your target and, most weeks, what's required.", needs: "performance" },
			"The top of the app now shows your fuel range when it's known: how many miles you have left until empty.",
		],
		tour: ["loads", "performance", "fuel-range"],
	},
]);

function latestReleaseId(list = RELEASES) {
	return list.length ? list[list.length - 1].id : null;
}

// The notes this driver hasn't answered, newest first, every line as { text, needs? }.
function unseenReleases(seenIds, list = RELEASES) {
	const seen = seenIds instanceof Set ? seenIds : new Set(seenIds || []);
	return list
		.filter((r) => !seen.has(r.id))
		.map((r) => ({
			id: r.id,
			title: r.title,
			notes: r.notes.map((n) => (typeof n === "string" ? { text: n } : { text: n.text, needs: n.needs })),
			tour: [...r.tour],
		}))
		.reverse();
}

// The ids a driver's own app may mark: the list's and the tour's row, nothing it made up.
function isMarkableId(id, list = RELEASES) {
	return id === APP_TOUR_ROW || list.some((r) => r.id === id);
}

// The only ids a driver confirms: a notice the list holds.
function isListedRelease(id, list = RELEASES) {
	return list.some((r) => r.id === id);
}

// Who confirmed which notice, newest notice first, for a Super Admin. Every active Driver account is
// listed, and an inactive one only if they confirmed it. A driver whose row came from their first
// sign-in, or who hasn't signed in yet, starts after the notice and is never asked: their first
// sign-in marks everything listed as seen. `people` are users rows (id, driver_name, full_name,
// disabled_at, last_login_at); `rows` are driver_release_seen rows. Names, states and times only.
function acknowledgementRecord(list, people, rows) {
	const byKey = new Map((rows || []).map((r) => [`${r.user_id}|${r.release_id}`, r]));
	return [...list].reverse().map((r) => {
		const drivers = [];
		for (const p of people || []) {
			const row = byKey.get(`${p.id}|${r.id}`);
			const at = row && row.acknowledged_at ? row.acknowledged_at : null;
			if (!at && String(p.disabled_at ?? "") !== "") continue;
			const startedAfter = !at && ((row && row.seen_at) || String(p.last_login_at ?? "") === "");
			drivers.push({ name: String(p.driver_name || p.full_name || "").trim(), state: at ? "acknowledged" : startedAfter ? "started-after" : "not-yet", at });
		}
		drivers.sort((a, b) => a.name.localeCompare(b.name));
		const acknowledged = drivers.filter((x) => x.state === "acknowledged").length;
		const asked = acknowledged + drivers.filter((x) => x.state === "not-yet").length;
		return { id: r.id, title: r.title, date: r.id.slice(0, 10), acknowledged, asked, drivers };
	});
}

module.exports = { RELEASES, NEEDS, APP_TOUR_ROW, latestReleaseId, unseenReleases, isMarkableId, isListedRelease, acknowledgementRecord };
