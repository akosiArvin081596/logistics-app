"use strict";

// What has changed for drivers, in plain words. A PR that changes what a driver can see adds one
// entry at the end of RELEASES, and that is the whole of marking a release driver-facing: the
// latest id is the current release, and a driver reads it at their next sign-in, once their session
// from before it has ended. Nobody is signed out for it. No new entry, no note, so a fix no driver
// can see disturbs nobody.
//
//   id     "YYYY-MM-DD-some-words", in order, never reused: sessions and seen rows hold it
//   title  one short line
//   notes  the lines he reads: a string is for every driver; { text, needs } only for a driver
//          with that part of the app, since a note about a tab he hasn't got would mislead him
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

// Is a session on an older release, so that its notes wait for the next sign-in? Only a session with
// no id, or one the list knows is older. An id the list doesn't hold was signed in under a release
// since rolled back: nobody can say it's older, and holding its notes back would gain nothing. An
// empty list has nothing to be behind. After any sign-in this answers false.
function sessionIsBehind(sessionRelease, list = RELEASES) {
	const latest = latestReleaseId(list);
	if (!latest) return false;
	if (typeof sessionRelease !== "string" || sessionRelease === "") return true;
	const held = list.findIndex((r) => r.id === sessionRelease);
	return held !== -1 && held < list.length - 1;
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

module.exports = { RELEASES, NEEDS, APP_TOUR_ROW, latestReleaseId, sessionIsBehind, unseenReleases, isMarkableId };
