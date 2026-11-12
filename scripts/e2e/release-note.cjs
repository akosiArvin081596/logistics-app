// The driver app's notice after a sign-in ("What's new", or a first-time driver's tour offer), answered
// as a driver would. It sits over the whole app until the driver answers it, so every e2e part that signs
// a Driver in through the login form calls this before its next tap.
//
//   await answerReleaseNote(page, { who: 'Step 9 — Driver' })
//
// Returns what it did. Throws, naming the step, when the note or the offer shows and doesn't close after
// its tap, or when the server doesn't take the answer: those are real failures, never skipped.
"use strict";

const DIALOG = '[data-testid="release-dialog"]';
const ACKNOWLEDGE = '[data-testid="release-acknowledge"]';
const SKIP_OFFER = '[data-testid="release-skip-offer"]';
const RELEASE_PATH = "/api/driver/me/release";

const isPost = (pathname) => (r) => {
	try {
		return new URL(r.url()).pathname === pathname && r.request().method() === "POST";
	} catch {
		return false;
	}
};

// What the server has for this driver now, read with the page's own session and outside the page's own
// requests. null (the switch off, or no answer) shows nothing either.
async function due(page) {
	try {
		const r = await page.context().request.get(new URL(RELEASE_PATH, page.url()).href, { headers: { "X-Requested-With": "XMLHttpRequest" }, failOnStatusCode: false, timeout: 20000 });
		if (r.status() !== 200) return null;
		const j = await r.json();
		return { notes: Array.isArray(j && j.notes) ? j.notes.length : 0, offer: !!j && j.tourOffered === true };
	} catch {
		return null;
	}
}

const upNow = (page) => page.locator(DIALOG).first().isVisible().catch(() => false);
async function shows(page, ms) {
	try {
		await page.locator(DIALOG).first().waitFor({ state: "visible", timeout: ms });
		return true;
	} catch {
		return false;
	}
}

// The tap, and the answer it sends.
async function tap(page, who, button, pathname, label) {
	try {
		const [resp] = await Promise.all([page.waitForResponse(isPost(pathname), { timeout: 30000 }), page.locator(DIALOG).first().locator(button).click()]);
		return resp;
	} catch (e) {
		throw new Error(`${who}: ${label} on the driver app's notice sent no answer (${String((e && e.message) || e).split("\n")[0]})`);
	}
}

async function answerOne(page, who) {
	const dialog = page.locator(DIALOG).first();
	if (await dialog.locator(ACKNOWLEDGE).count()) {
		const resp = await tap(page, who, ACKNOWLEDGE, `${RELEASE_PATH}/acknowledge`, "I acknowledge");
		let saved = false;
		try {
			saved = resp.status() === 200 && (await resp.json()).success === true;
		} catch {
			saved = false;
		}
		if (!saved) throw new Error(`${who}: I acknowledge on the driver app's What's new answered ${resp.status()}, so the confirmation wasn't saved`);
		try {
			await page.locator(ACKNOWLEDGE).first().waitFor({ state: "detached", timeout: 15000 });
		} catch {
			throw new Error(`${who}: the driver app's What's new stayed up after I acknowledge was saved`);
		}
		return "What's new acknowledged";
	}
	if (await dialog.locator(SKIP_OFFER).count()) {
		const resp = await tap(page, who, SKIP_OFFER, `${RELEASE_PATH}/seen`, "Skip for now");
		if (resp.status() !== 200) throw new Error(`${who}: Skip for now on the driver app's tour offer answered ${resp.status()}, so the answer wasn't saved`);
		try {
			await page.locator(SKIP_OFFER).first().waitFor({ state: "detached", timeout: 15000 });
		} catch {
			throw new Error(`${who}: the driver app's tour offer stayed up after Skip for now`);
		}
		return "the tour offer skipped";
	}
	throw new Error(`${who}: the driver app's notice is up with neither I acknowledge nor Skip for now`);
}

// waitMs: how long the app may take to show what the server has due, right after a sign-in (its one look
// waits for two reads). Nothing due returns at once; due but never shown means the look said no, and on
// that page nothing shows later.
async function answerReleaseNote(page, { who = "The driver", waitMs = 20000 } = {}) {
	if (!(await upNow(page))) {
		const now = await due(page);
		if (!now || (!now.notes && !now.offer)) return "nothing due";
		if (!(await shows(page, waitMs))) return "due, not shown on this page";
	}
	const done = [await answerOne(page, who)];
	// A saved note can be followed at once by a first-time driver's offer.
	if (done[0] !== "the tour offer skipped") {
		const next = await due(page);
		if (next && next.offer && (await shows(page, 5000))) done.push(await answerOne(page, who));
	}
	if (await upNow(page)) throw new Error(`${who}: the driver app's notice is still up after ${done.join(", then ")}`);
	// The overlay fades out after its content goes.
	await page.waitForTimeout(400);
	console.log(`  ${who}: ${done.join(", then ")} (the driver app's notice after a sign-in)`);
	return done.join(", then ");
}

module.exports = { answerReleaseNote };
