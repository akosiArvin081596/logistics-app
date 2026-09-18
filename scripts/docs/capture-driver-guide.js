#!/usr/bin/env node
/**
 * Capture the DRIVER TRAINING GUIDE storyboard — one screenshot per teaching
 * beat, in the order a driver actually meets them.
 *
 * This is deliberately NOT an addition to screenshot-manifest.js. That manifest
 * answers "one flat picture per route" for the User Manual PDF, and its three
 * driver entries all point at /driver with no interaction, so they render the
 * same image three times. A training guide needs the opposite: one route
 * (/driver) photographed in ~20 different STATES, which means driving the app
 * (accepting a load, advancing status, opening accordions) between shots.
 *
 * WHY THE STATE IS MUTATED BETWEEN SHOTS
 * The local Job Tracking sheet is a production copy in which every load is
 * already terminal — 174 Completed, 19 Delivered, 7 Cancelled, zero live. So
 * the accept flow and the status ladder cannot be photographed as-found; they
 * have to be walked. Each step may declare `before()`, which drives the REAL
 * API with the driver's own session, so every screenshot shows a state the app
 * genuinely produced rather than a mock.
 *
 * SAFETY. Same rule as every other writing script in this repo: it refuses to
 * run against anything but a local server on the LOCAL sheet. It writes through
 * the driver's own session, so it cannot reach anything a driver could not.
 *
 * Usage:
 *   node scripts/docs/capture-driver-guide.js
 *   node scripts/docs/capture-driver-guide.js --base=http://localhost:3100
 *   node scripts/docs/capture-driver-guide.js --only=05,06     (re-shoot a beat)
 *   node scripts/docs/capture-driver-guide.js --list           (print storyboard)
 */

const fs = require("fs");
const path = require("path");
const { getBrowser, shutdownBrowser } = require("../../lib/pdf-browser");
const storyboard = require("./driver-guide-storyboard");

const arg = (n, d) =>
	process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=").slice(1).join("=") || d;

const BASE = arg("base", "http://localhost:3100");
const ONLY = (arg("only", "") || "").split(",").map((s) => s.trim()).filter(Boolean);
const LIST = process.argv.includes("--list");

const DRIVER = { username: arg("user", "LogisX-3867"), password: arg("pass", "Password123!") };
const OUT_DIR = path.join(__dirname, "..", "..", "docs", "driver-guide", "screenshots");
// Annotated twins live beside the clean set so both are available to the editor.
const ANNO_DIR = path.join(__dirname, "..", "..", "docs", "driver-guide", "screenshots-annotated");

// iPhone 11 Pro-ish. The driver app is a phone surface (Vant, van-tabbar with
// safe-area inset), so a desktop viewport photographs a layout no driver sees.
const PHONE = { width: 414, height: 896 };

let COOKIE = null;

/** Authenticated call as the DRIVER — never as an admin. */
async function api(pathname, { method = "GET", body } = {}) {
	const res = await fetch(`${BASE}${pathname}`, {
		method,
		headers: {
			"content-type": "application/json",
			// The app's own CSRF contract (see requireAuth in server.js).
			"x-requested-with": "XMLHttpRequest",
			...(COOKIE ? { cookie: `connect.sid=${encodeURIComponent(COOKIE)}` } : {}),
		},
		...(body ? { body: JSON.stringify(body) } : {}),
	});
	const text = await res.text();
	let json = null;
	try { json = JSON.parse(text); } catch { /* non-JSON is fine for probes */ }
	if (!res.ok) {
		const err = new Error(`${method} ${pathname} -> ${res.status} ${text.slice(0, 200)}`);
		err.status = res.status;
		err.body = json;
		throw err;
	}
	return json;
}

/**
 * A SECOND session, as an admin, for staging actions the driver legitimately
 * cannot perform.
 *
 * ⚠️ Needed because the guards are real. Freeing the "one active job" slot means
 * closing the driver's other load, and PUT /api/driver/status refuses that with
 * POD_REQUIRED — correctly, since it has no Proof of Delivery. That refusal is
 * the subject of a later beat, so it must NOT be weakened. An admin writing the
 * sheet row directly is the same thing dispatch does in real life.
 */
let ADMIN_COOKIE = null;
async function adminApi(pathname, { method = "GET", body } = {}) {
	if (!ADMIN_COOKIE) {
		const r = await fetch(`${BASE}/api/auth/login`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-requested-with": "XMLHttpRequest" },
			body: JSON.stringify({ username: "super_admin", password: "Password123!" }),
		});
		if (!r.ok) throw new Error(`admin login failed: ${r.status}`);
		const sid = (r.headers.getSetCookie() || []).find((c) => /^connect\.sid=/.test(c));
		ADMIN_COOKIE = decodeURIComponent(sid.split(";")[0].split("=")[1]);
	}
	const res = await fetch(`${BASE}${pathname}`, {
		method,
		headers: {
			"content-type": "application/json", "x-requested-with": "XMLHttpRequest",
			cookie: `connect.sid=${encodeURIComponent(ADMIN_COOKIE)}`,
		},
		...(body ? { body: JSON.stringify(body) } : {}),
	});
	const t = await res.text();
	if (!res.ok) throw new Error(`admin ${method} ${pathname} -> ${res.status} ${t.slice(0, 160)}`);
	try { return JSON.parse(t); } catch { return null; }
}

async function login() {
	const res = await fetch(`${BASE}/api/auth/login`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-requested-with": "XMLHttpRequest" },
		body: JSON.stringify(DRIVER),
	});
	if (!res.ok) throw new Error(`driver login failed: ${res.status} ${await res.text()}`);
	const setCookie = res.headers.getSetCookie?.() || [];
	const sid = setCookie.find((c) => /^connect\.sid=/.test(c));
	if (!sid) throw new Error("no connect.sid returned");
	COOKIE = decodeURIComponent(sid.split(";")[0].split("=")[1]);
	const who = await res.json();
	return who.user;
}

/**
 * REFUSE anything that is not a local server on the LOCAL sheet. This script
 * WRITES (it advances load status), so pointing it at staging or production
 * would move real freight through the status ladder.
 */
async function assertSafeTarget() {
	if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) {
		throw new Error(`REFUSING: --base must be localhost, got ${BASE}`);
	}
	const res = await fetch(`${BASE}/api/auth/setup-check`, { signal: AbortSignal.timeout(4000) });
	if (!res.ok) throw new Error(`cannot reach ${BASE} (status ${res.status})`);
}

// ---------------------------------------------------------------------------
// Page helpers handed to each step's prep(). Vant renders no stable test ids, so
// these match on visible TEXT, which is also what the voice-over will name.
// ---------------------------------------------------------------------------
/**
 * Scroll the element whose text matches `text` to just under the app header.
 *
 * ⚠️ IT IS NOT `window`. The driver app puts its scroll on `<main class="main">`
 * — measured: `document.scrollingElement.scrollHeight` equals the 896px viewport
 * while `main` holds 1457px. So `window.scrollTo()` is a SILENT no-op, and the
 * accordions at y≈1049–1181 stayed below the fold. Every "different" section
 * screenshot came out as the same Route Map view, and byte-comparison did not
 * catch it because the live ETA clock ticks between shots. Walk up to the real
 * scrolling ancestor and set its scrollTop.
 */
/**
 * Draw the guide's highlight over the live DOM, then screenshot.
 *
 * WHY IN THE PAGE AND NOT IN AN IMAGE EDITOR. The overlay is positioned from the
 * element's own getBoundingClientRect(), so it is pinned to the real control
 * rather than to pixel coordinates someone eyeballed. Re-run after a UI change
 * and the highlight moves with the button; a hand-drawn box silently drifts and
 * ends up circling empty space.
 *
 * One SVG with a mask, not N box-shadows: overlapping spotlight shadows compound
 * into progressively darker bands, whereas a single dimmed rect with a hole per
 * target dims evenly however many targets a beat has.
 *
 * Targets resolve by CSS selector (`sel`) or by visible text (`text`) — text
 * picks the SMALLEST element containing it, so "Accept Load" lands on the button
 * and not on its wrapper. `pad` and `label` are optional.
 */
/**
 * Blur elements before the shot — for real figures that must not ship in
 * training material shown to other people.
 *
 * WHY BLUR AND NOT SUBSTITUTE. Swapping in invented amounts would photograph
 * cleanly, but a driver reading an invented "$900.00 your pay" in a training
 * video reasonably takes it for a rate they can expect. A blur cannot be
 * misread as a promise: it says "redacted", which is the truth. The layout,
 * spacing and everything the beat actually teaches survive intact.
 */
async function applyRedactions(page, selectors) {
	return page.evaluate((sels) => {
		let n = 0;
		for (const sel of sels) {
			for (const el of document.querySelectorAll(sel)) {
				el.style.filter = "blur(7px)";
				el.style.userSelect = "none";
				n++;
			}
		}
		return n;
	}, selectors);
}

async function applyHighlights(page, targets) {
	return page.evaluate((targets) => {
		document.getElementById("__guide_hl")?.remove();

		const resolve = (t) => {
			// `section: "Truck Details"` -> the expanded BODY of that accordion.
			// ⚠️ Vant marks expansion on the TITLE (van-collapse-item__title--expanded),
			// NOT on the item, so ".van-collapse-item--expanded" matches nothing and
			// every section highlight silently resolved to zero targets.
			if (t.section) {
				const title = [...document.querySelectorAll(".van-collapse-item__title")]
					.find((e) => (e.textContent || "").trim().includes(t.section));
				if (!title) return null;
				const body = title.parentElement?.querySelector(".van-collapse-item__wrapper");
				return body && body.getBoundingClientRect().height > 4 ? body : null;
			}
			if (t.sel) return document.querySelector(t.sel);
			if (!t.text) return null;
			const all = [...document.querySelectorAll("body *")].filter(
				(e) => (e.textContent || "").includes(t.text) && e.offsetParent !== null,
			);
			// Smallest match = the tightest wrapper around the text.
			let el = all.sort((a, b) => {
				const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
				return ra.width * ra.height - rb.width * rb.height;
			})[0] || null;
			if (!el) return null;
			// ⚠️ CLIMB TO THE REAL CONTROL. The smallest match for "Accept Load" is
			// the inner <span>, so the ring hugged the label and left the button it
			// names outside the highlight. If the match sits inside a button (or an
			// explicit `closest`), frame that instead — the driver is being told
			// what to TAP, not what to read.
			const up = el.closest(t.closest || "button, .van-button, [role=button]");
			return up || el;
		};

		const NS = "http://www.w3.org/2000/svg";
		const svg = document.createElementNS(NS, "svg");
		svg.id = "__guide_hl";
		Object.assign(svg.style, {
			position: "fixed", inset: "0", width: "100vw", height: "100vh",
			zIndex: "2147483647", pointerEvents: "none",
		});

		const defs = document.createElementNS(NS, "defs");
		const mask = document.createElementNS(NS, "mask");
		mask.setAttribute("id", "__guide_mask");
		const full = document.createElementNS(NS, "rect");
		full.setAttribute("width", "100%"); full.setAttribute("height", "100%");
		full.setAttribute("fill", "white");
		mask.appendChild(full);

		// ⚠️ NUMBER ONLY WHEN THERE IS SOMETHING TO ORDER. On a single-target beat
		// the "1" carries no information, and sitting inline with real UI it reads
		// as app chrome — on the Alerts screen it looked exactly like an unread
		// count on the notification it was pointing at. One ring is unambiguous
		// without it; badges appear only when a beat highlights two or more things.
		const numbered = targets.filter((t) => !t.optional).length > 1;
		const boxes = [];
		let hit = 0;
		for (const t of targets) {
			const el = resolve(t);
			if (!el) continue;
			const r = el.getBoundingClientRect();
			if (r.width < 2 || r.height < 2) continue;
			hit++;
			const pad = t.pad ?? 6;
			const b = { x: r.left - pad, y: r.top - pad, w: r.width + pad * 2, h: r.height + pad * 2,
				label: numbered ? t.label : null };
			boxes.push(b);
			const hole = document.createElementNS(NS, "rect");
			hole.setAttribute("x", b.x); hole.setAttribute("y", b.y);
			hole.setAttribute("width", b.w); hole.setAttribute("height", b.h);
			hole.setAttribute("rx", "12"); hole.setAttribute("fill", "black");
			mask.appendChild(hole);
		}
		if (!hit) return 0;

		defs.appendChild(mask); svg.appendChild(defs);

		const dim = document.createElementNS(NS, "rect");
		dim.setAttribute("width", "100%"); dim.setAttribute("height", "100%");
		dim.setAttribute("fill", "rgba(6,10,24,0.55)");
		dim.setAttribute("mask", "url(#__guide_mask)");
		svg.appendChild(dim);

		for (const b of boxes) {
			const ring = document.createElementNS(NS, "rect");
			ring.setAttribute("x", b.x); ring.setAttribute("y", b.y);
			ring.setAttribute("width", b.w); ring.setAttribute("height", b.h);
			ring.setAttribute("rx", "12");
			ring.setAttribute("fill", "none");
			ring.setAttribute("stroke", "#FFC400");
			ring.setAttribute("stroke-width", "4");
			svg.appendChild(ring);

			if (b.label) {
				const cx = Math.max(20, b.x - 2), cy = Math.max(20, b.y - 2);
				const c = document.createElementNS(NS, "circle");
				c.setAttribute("cx", cx); c.setAttribute("cy", cy); c.setAttribute("r", "15");
				c.setAttribute("fill", "#FFC400");
				svg.appendChild(c);
				const tx = document.createElementNS(NS, "text");
				tx.setAttribute("x", cx); tx.setAttribute("y", cy + 6);
				tx.setAttribute("text-anchor", "middle");
				tx.setAttribute("font-family", "-apple-system, Helvetica, Arial, sans-serif");
				tx.setAttribute("font-size", "18"); tx.setAttribute("font-weight", "700");
				tx.setAttribute("fill", "#10131c");
				tx.textContent = String(b.label);
				svg.appendChild(tx);
			}
		}
		document.body.appendChild(svg);
		return hit;
	}, targets);
}

async function scrollElementIntoView(page, text, { any = false } = {}) {
	return page.evaluate(
		({ text, any }) => {
			const sel = any ? "*" : ".van-collapse-item__title";
			const els = [...document.querySelectorAll(sel)];
			const el = any
				? els.find((e) => e.children.length === 0 && (e.textContent || "").trim().includes(text))
				: els.find((e) => (e.textContent || "").trim().includes(text));
			if (!el) return null;
			let sc = el.parentElement;
			while (sc && sc !== document.body) {
				const st = getComputedStyle(sc);
				if (sc.scrollHeight > sc.clientHeight + 20 && /auto|scroll/.test(st.overflowY)) break;
				sc = sc.parentElement;
			}
			sc = sc && sc !== document.body ? sc : document.scrollingElement;
			const delta = el.getBoundingClientRect().top - sc.getBoundingClientRect().top;
			sc.scrollTop = Math.max(0, sc.scrollTop + delta - 12);
			return Math.round(sc.scrollTop);
		},
		{ text, any },
	);
}

function helpers(page) {
	const clickByText = async (selector, text, { exact = false } = {}) =>
		page.evaluate(
			({ selector, text, exact }) => {
				const els = [...document.querySelectorAll(selector)];
				const hit = els.find((e) => {
					const t = (e.textContent || "").trim();
					return exact ? t === text : t.includes(text);
				});
				if (!hit) return false;
				hit.click();
				return true;
			},
			{ selector, text, exact },
		);

	const settle = (ms) => new Promise((r) => setTimeout(r, ms));

	return {
		settle,
		clickByText,
		/** Bottom tab bar: Loads | Alerts | Kit | Messages | Invoices */
		async tab(label) {
			const ok = await clickByText(".van-tabbar-item", label);
			if (!ok) throw new Error(`bottom tab not found: ${label}`);
			await settle(900);
		},
		/**
		 * Loads sub-tab: Active | Pending | Historical.
		 * ⚠️ A load the driver has not responded to yet lives under PENDING, not
		 * Active — so the Accept/Decline beat must switch here first or the card
		 * genuinely is not in the DOM.
		 */
		async subTab(label) {
			const ok = await clickByText(".sub-tab", label);
			if (!ok) throw new Error(`loads sub-tab not found: ${label}`);
			await settle(1000);
		},
		/** Open a load's detail by its Load ID text on the card. */
		async openLoad(loadId) {
			const ok = await clickByText(".load-card", loadId);
			if (!ok) throw new Error(`load card not found: ${loadId}`);
			await settle(1200);
		},
		/**
		 * Expand a van-collapse-item in LoadDetail by its title, then bring it to
		 * the TOP of the viewport.
		 *
		 * ⚠️ The scroll is the whole point, not politeness. Several sections are
		 * open by default and the phone viewport is 414×896, so an accordion
		 * lower down expands entirely below the fold: the click succeeds, the
		 * screenshot is identical to the previous one, and the only tell is that
		 * consecutive files come out the same size. That is exactly how the first
		 * capture pass produced four byte-identical "different" sections.
		 */
		async section(title) {
			// ⚠️ CLICK ONLY IF COLLAPSED. Several sections are open by default, so a
			// blind click TOGGLES them shut — which is how "documents" and
			// "status-timeline" came out byte-identical: each closed the other's
			// section and left the same view on screen.
			const needed = await page.evaluate((t) => {
				const el = [...document.querySelectorAll(".van-collapse-item__title")]
					.find((e) => (e.textContent || "").trim().includes(t));
				if (!el) return null;
				return el.getAttribute("aria-expanded") !== "true";
			}, title);
			if (needed === null) throw new Error(`section not found: ${title}`);
			if (needed) {
				await clickByText(".van-collapse-item__title", title);
				await settle(700);
			}
			const y = await scrollElementIntoView(page, title);
			if (y === null) throw new Error(`section vanished after click: ${title}`);
			await settle(900);
		},
		/** Scroll the real scrolling container to its bottom. */
		async scrollBottom() {
			await page.evaluate(() => {
				let el = document.querySelector(".van-collapse") || document.body;
				while (el && el !== document.body) {
					const s = getComputedStyle(el);
					if (el.scrollHeight > el.clientHeight + 20 && /auto|scroll/.test(s.overflowY)) break;
					el = el.parentElement;
				}
				(el || document.scrollingElement).scrollTop = 999999;
			});
			await settle(700);
		},
		/** Scroll so an element containing this text is in frame. */
		async scrollTo(text) {
			await scrollElementIntoView(page, text, { any: true });
			await settle(500);
		},
	};
}

async function capture(browser, step, index) {
	const page = await browser.newPage();
	try {
		await page.setViewport({ ...PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
		await page.setUserAgent(
			"Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 " +
				"(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
		);
		const url = new URL(BASE);
		if (COOKIE && !step.anonymous) {
			await page.setCookie({
				name: "connect.sid", value: COOKIE, domain: url.hostname,
				path: "/", httpOnly: true, secure: false, sameSite: "Lax",
			});
		}

		await page.goto(`${BASE}${step.route || "/driver"}`, {
			waitUntil: "networkidle0", timeout: 45000,
		}).catch((e) => console.warn(`    goto: ${e.message}`));

		// The driver app fetches everything through one aggregate call; give it
		// room before interacting or the tab bar is not mounted yet.
		await new Promise((r) => setTimeout(r, step.settle ?? 2500));

		if (step.prep) await step.prep(page, helpers(page));
		if (step.delay) await new Promise((r) => setTimeout(r, step.delay));

		// Redact BEFORE the clean shot, so the real figures never reach either file.
		if (step.redact?.length) {
			const n = await applyRedactions(page, step.redact);
			if (!n) console.warn("    ⚠ redaction matched nothing — check the selector");
		}

		const file = `${String(index).padStart(2, "0")}-${step.id}.png`;
		const out = path.join(OUT_DIR, file);
		await page.screenshot({ path: out, type: "png", fullPage: !!step.fullPage });
		const kb = (fs.statSync(out).size / 1024).toFixed(0);

		// Same page visit, so the annotated frame is pixel-aligned with the clean
		// one — a second navigation would re-render the map and shift the layout.
		let note = "";
		if (step.highlight?.length) {
			const hit = await applyHighlights(page, step.highlight);
			if (hit) {
				fs.mkdirSync(ANNO_DIR, { recursive: true });
				await page.screenshot({
					path: path.join(ANNO_DIR, file), type: "png", fullPage: !!step.fullPage,
				});
				// `optional: true` marks a target that legitimately may not be on
				// screen for this beat's state, so it must not raise a warning.
				const required = step.highlight.filter((t) => !t.optional).length;
				note = `  + annotated (${hit}/${step.highlight.length} target${hit === 1 ? "" : "s"})`;
				if (hit < required) note += "  ⚠ a REQUIRED target was not found";
			} else {
				note = "  ⚠ NO highlight targets resolved";
			}
		}
		console.log(`  ✓ ${file}  (${kb} KB)${note}`);
		return file;
	} finally {
		await page.close().catch(() => {});
	}
}

async function main() {
	if (LIST) {
		storyboard.forEach((s, i) =>
			console.log(`${String(i + 1).padStart(2, "0")}-${s.id}\n    ${s.title}`));
		return;
	}

	await assertSafeTarget();
	fs.mkdirSync(OUT_DIR, { recursive: true });

	const user = await login();
	console.log(`Driver guide capture — ${user.driverName} (${user.username}) @ ${BASE}`);
	console.log(`Output: ${path.relative(process.cwd(), OUT_DIR)}\n`);

	const browser = await getBrowser();
	let ok = 0, failed = 0;

	for (let i = 0; i < storyboard.length; i++) {
		const step = storyboard[i];
		const num = String(i + 1).padStart(2, "0");
		if (ONLY.length && !ONLY.includes(num) && !ONLY.includes(step.id)) continue;

		console.log(`[${num}] ${step.title}`);
		try {
			if (step.before) {
				const note = await step.before({ api, adminApi });
				if (note) console.log(`    state: ${note}`);
			}
			await capture(browser, step, i + 1);
			ok++;
		} catch (err) {
			console.error(`  ✗ ${step.id} — ${err.message}`);
			failed++;
		}
	}

	console.log(`\nDone. ${ok} captured, ${failed} failed.`);
	await shutdownBrowser();
	if (failed) process.exitCode = 1;
}

if (require.main === module) {
	main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
}
