#!/usr/bin/env node
// scripts/docs/capture-driver-video.js — records the driver-app instructional
// clips: real MP4s of the real app, with burned-in captions, plus the voice-over
// script and a measured .vtt for every clip.
//
// Sibling of capture-driver-guide.js, NOT a mode inside it. The still runner's
// 21 beats are one continuous journey whose ARRAY ORDER IS ITS FILENAMES AND ITS
// STATE MACHINE; clips must instead be independently re-recordable, which is the
// opposite contract. They share their machinery through ./lib/.
//
//   node scripts/docs/capture-driver-video.js --list
//   node scripts/docs/capture-driver-video.js --dry            # script only, no browser
//   node scripts/docs/capture-driver-video.js --only=03
//   node scripts/docs/capture-driver-video.js
//
// ⚠️ RUN THE SERVER WITH THE ELD POLLERS OFF:
//     ROUTEMATE_ENABLED=false LINXUP_ENABLED=false PORT=3100 \
//       SPREADSHEET_ID=156Y5-OUUEZspiY7dRsJZ57iyKWLJAjdVP8a4yw0PMN0 npm start
//   The geofence is LIVE on this data — load_status_history shows 566293352
//   climbing At Shipper -> In Transit -> At Receiver with source:'geofence'. Left
//   on, tryGeofenceAdvance() can move the load mid-take and the clip films a
//   status the narration is not describing. Stored telemetry is untouched by the
//   flag, so the map pin and the fuel level still work (the position route's
//   visibility window is 14 DAYS, not minutes).

"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const puppeteer = require("puppeteer");

const {
	PHONE, IPHONE_UA, arg, has, assertSafeTarget, login, makeApi, sleep, resolveHandle,
} = require("./lib/driver-guide-runtime");
const { FX_SOURCE, CAPTION_MAX_CHARS } = require("./lib/video-fx");
const { makeStateOps } = require("./lib/state-ops");
const CLIPS = require("./driver-video-storyboard");

const BASE = arg("base", "http://localhost:3100");
const DRIVER = { username: arg("user", "LogisX-0621"), password: arg("pass", "Password123!") };
const ADMIN = { username: arg("admin", "super_admin"), password: arg("adminpass", "Password123!") };
const ONLY = (arg("only", "") || "").split(",").map((s) => s.trim()).filter(Boolean);
const KEEP_WEBM = has("keep-webm");
const FPS = Number(arg("fps", "30"));

const ROOT = path.join(__dirname, "..", "..", "docs", "driver-video");
const DIR = {
	clips: path.join(ROOT, "clips"),
	raw: path.join(ROOT, ".raw"),
	script: path.join(ROOT, "script"),
	captions: path.join(ROOT, "captions"),
};

// Human voice-over runs 2.5-3.0 words/sec. The existing voiceover/*.txt RUN TIME
// figures imply 4.0-4.9 w/s, i.e. they are ~1.6x optimistic — measured against
// their own word counts.
//
// ⚠️ 2.35, not 2.75, and deliberately at the SLOW end of natural speech: the
// audience is drivers in their 50s and 60s, many watching once, on a phone, in a
// cab. The cost of pacing too slow is a longer clip; the cost of pacing too fast
// is a driver who does not learn the POD step. The floor below is 2.2s for the
// same reason — a caption that flashes past cannot be read twice.
const WORDS_PER_SEC = 2.35;
const words = (s) => (s || "").trim().split(/\s+/).filter(Boolean).length;
const sayMs = (s) => Math.max(2200, Math.ceil((words(s) / WORDS_PER_SEC) * 1000));

// ---------------------------------------------------------------------------

function pad(n) { return String(n).padStart(2, "0"); }
function clipNo(i) { return pad(i + 1); }

function listClips() {
	CLIPS.forEach((c, i) => {
		const est = c.beats.reduce((a, b) => a + (b.dwell || sayMs(b.say)), 0);
		console.log(`  ${clipNo(i)}  ${c.id.padEnd(26)} ${String(Math.round(est / 1000)).padStart(3)}s  ${words(c.beats.map((b) => b.say).join(" "))} words`);
	});
}

function selected() {
	return CLIPS.map((c, i) => ({ clip: c, i }))
		.filter(({ c, i }) => !ONLY.length || ONLY.includes(clipNo(i)) || ONLY.includes(CLIPS[i].id));
}

/** Fail loudly on copy that would wrap to a third line and cover the control. */
function lintCaptions() {
	const bad = [];
	CLIPS.forEach((c, i) => c.beats.forEach((b, j) => {
		const text = b.caption ?? b.say;
		if (text && text.length > CAPTION_MAX_CHARS)
			bad.push(`  ${clipNo(i)}/${c.id} beat ${j + 1}: ${text.length} chars (max ${CAPTION_MAX_CHARS})\n     ${text}`);
	}));
	if (bad.length) {
		console.error(`\n✗ ${bad.length} caption(s) too long — they would wrap over the control:\n${bad.join("\n")}`);
		process.exit(1);
	}
}

// ---------------------------------------------------------------------------
// artifacts

function writeScript(clip, i, cues, measuredMs) {
	const body = [
		`CLIP       : ${clipNo(i)}-${clip.id}.mp4`,
		`SCREEN     : ${clip.title}`,
		`RUN TIME   : ${(measuredMs / 1000).toFixed(1)} seconds (measured, not estimated)`,
		`WORDS      : ${words(clip.beats.map((b) => b.say).join(" "))} @ ${WORDS_PER_SEC} w/s`,
		"",
		"--- VOICE-OVER SCRIPT ---",
		"",
		clip.beats.map((b) => b.say).join("\n\n"),
		"",
		"--- ON-SCREEN CUES ---",
		"",
		...cues.map((c) => `- ${c}`),
	];
	if (clip.note) body.push("", "--- PRODUCTION NOTE ---", "", clip.note);
	fs.writeFileSync(path.join(DIR.script, `${clipNo(i)}-${clip.id}.txt`), body.join("\n") + "\n");
}

const vttStamp = (ms) => {
	const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60;
	const s = Math.floor(ms / 1000) % 60, cs = Math.floor(ms % 1000);
	return `${pad(h)}:${pad(m)}:${pad(s)}.${String(cs).padStart(3, "0")}`;
};

function writeVtt(clip, i, cues) {
	const lines = ["WEBVTT", ""];
	cues.forEach((c, n) => {
		lines.push(String(n + 1), `${vttStamp(c.start)} --> ${vttStamp(c.end)}`, c.text, "");
	});
	fs.writeFileSync(path.join(DIR.captions, `${clipNo(i)}-${clip.id}.vtt`), lines.join("\n"));
}

/** VP9/webm -> H.264/mp4. Mandatory: Puppeteer's own `format:'mp4'` is VP9 in an
 *  MP4 container (it spreads the same libvpx args), which iOS Safari will not
 *  decode — the extension would look right while failing on drivers' phones. */
function transcode(webm, mp4) {
	return new Promise((res, rej) => {
		const p = spawn("ffmpeg", [
			"-y", "-loglevel", "error", "-i", webm,
			// ⚠️ libx264 REFUSES an odd width or height ("width not divisible by 2")
			// and takes the whole clip with it. A page that lays out at an unexpected
			// scale — one missing its viewport meta did exactly this at 1959x4241 —
			// must not be able to fail the encode, so round down to even here.
			"-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
			"-c:v", "libx264", "-preset", "slow", "-crf", "20",
			"-pix_fmt", "yuv420p", "-profile:v", "high", "-level", "4.0",
			"-movflags", "+faststart", "-r", String(FPS), "-an", mp4,
		]);
		let err = "";
		p.stderr.on("data", (d) => (err += d));
		p.on("close", (code) => (code === 0 ? res() : rej(new Error(`ffmpeg exit ${code}: ${err.slice(0, 400)}`))));
	});
}

// ---------------------------------------------------------------------------
// page helpers

function helpers(page, state) {
	const fx = (fn, ...a) => page.evaluate(`window.__vfx.${fn}(${a.map((x) => JSON.stringify(x)).join(",")})`);

	const H = {
		settle: (ms) => sleep(ms),

		async caption(text, at) {
			await fx("caption", text || "", at || "bottom");
			state.mark(text || "");
		},

		async scrollSafe(target, opts = {}) {
			const el = await resolveHandle(page, target);
			if (!el) return;
			const inset = await page.evaluate(`window.__vfx.bandInset(${JSON.stringify(opts.at || "bottom")})`);
			await page.evaluate((e, o) => window.__vfx.scrollTo(e, o), el, { ...opts, inset });
			await sleep(opts.instant ? 60 : 120);
			await el.dispose();
		},

		/**
		 * Move the cursor onto a control without activating it.
		 *
		 * ⚠️ THE OFF-VIEWPORT TAP IS THE BUG THIS GUARDS. getBoundingClientRect()
		 * happily returns a y BELOW the fold for a control that was never scrolled
		 * to, and page.touchscreen.tap() then CLAMPS that into the viewport — so
		 * the tap silently lands on whatever sits at the bottom edge, which in this
		 * app is the bottom nav. Clip 03 filmed the Messages tab while narrating
		 * "tap Accept Load", and nothing warned, because a tap did happen.
		 *
		 * So: scroll, re-measure, and if it is STILL outside the viewport fall back
		 * to the element's own scrollIntoView and measure once more. If it cannot be
		 * brought on-screen, return null and say so loudly rather than tap a lie.
		 */
		async point(target, opts = {}) {
			const el = await resolveHandle(page, target);
			if (!el) { console.log(`     ! point: no match for ${JSON.stringify(target)}`); return null; }
			await H.scrollSafe(target, opts);

			const vp = page.viewport();
			const onScreen = (b) => b && b.y >= 0 && b.y + b.height <= vp.height + 1 && b.x >= 0;

			let box = await el.boundingBox();
			if (!onScreen(box)) {
				await page.evaluate((e) => e.scrollIntoView({ block: "center", behavior: "smooth" }), el);
				await sleep(900);
				box = await el.boundingBox();
			}
			if (!onScreen(box)) {
				console.log(`     ! point: ${JSON.stringify(target)} is OFF-VIEWPORT (${box ? `y=${Math.round(box.y)}` : "no box"}) — refusing to tap`);
				await el.dispose();
				return null;
			}
			await fx("cursorTo", Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2));
			await sleep(740);
			return { el, box };
		},

		/** Point, ripple, then a REAL touch tap — the viewport is isMobile/hasTouch,
		 *  so a touch gives Vant its genuine :active state and the tap reads true. */
		async tap(target, opts = {}) {
			const hit = await H.point(target, opts);
			if (!hit || !hit.box) return false;
			await fx("cursorTap");
			await sleep(220);

			// ⚠️ RE-MEASURE. point() measured ~1s ago (cursor travel + ripple), and a
			// box that has since moved sends the tap somewhere else entirely — a
			// scroll settling, a lazy panel expanding, a re-render. Tapping a stale
			// rect is how clip 03 hit the Messages tab while narrating "Accept Load".
			const fresh = await hit.el.boundingBox();
			const vp2 = page.viewport();
			const box = fresh && fresh.y >= 0 && fresh.y + fresh.height <= vp2.height + 1 ? fresh : null;
			if (!box) {
				console.log(`     ! tap: ${JSON.stringify(target)} moved off-viewport before the tap — skipped`);
				await hit.el.dispose();
				return false;
			}
			const { x, y, width, height } = box;
			await page.touchscreen.tap(Math.round(x + width / 2), Math.round(y + height / 2))
				.catch(async () => { await hit.el.click().catch(() => {}); });
			await sleep(200);
			await fx("cursorClear");
			await hit.el.dispose();
			state.cue(`tap "${typeof target === "string" ? target : target.text || target.sel}"`);
			return true;
		},

		/** Visible typing — a real keypress cadence reads as a person, and the app's
		 *  v-model only fires on real input events anyway. */
		async type(target, text, opts = {}) {
			const el = await resolveHandle(page, target);
			if (!el) { console.log(`     ! type: no match for ${JSON.stringify(target)}`); return; }
			await H.scrollSafe(target, opts);
			const box = await el.boundingBox();
			if (box) {
				await fx("cursorTo", Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2));
				await sleep(560);
				await fx("cursorTap");
				await page.touchscreen.tap(Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2)).catch(() => {});
				await sleep(160);
				await fx("cursorClear");
			}
			await el.type(text, { delay: 55 });
			await el.dispose();
			state.cue(`type into ${typeof target === "string" ? target : target.sel || target.text}`);
		},

		/**
		 * Tap a REAL upload control and satisfy the file chooser it opens.
		 *
		 * ⚠️ Deliberately NOT uploadFile() on the hidden input. Every document path
		 * ends in <input type=file>.click(), and driving the input directly would
		 * skip the button the driver actually presses — the video would teach a
		 * gesture that does not exist. waitForFileChooser lets the tap be genuine
		 * while the OS dialog is answered for us.
		 */
		async uploadTo(target, filePath) {
			const [chooser] = await Promise.all([
				page.waitForFileChooser({ timeout: 15000 }),
				H.tap(target),
			]).catch(async (e) => {
				console.log(`     ! uploadTo: ${e.message}`);
				return [null];
			});
			if (chooser) await chooser.accept([filePath]);
			state.cue(`upload ${require("path").basename(filePath)}`);
		},

		async spot(targets) {
			const list = Array.isArray(targets) ? targets : [targets];
			const rects = [];
			for (const t of list) {
				const el = await resolveHandle(page, t);
				if (!el) continue;
				const b = await el.boundingBox();
				if (b) rects.push({ x: Math.round(b.x - 6), y: Math.round(b.y - 6), w: Math.round(b.width + 12), h: Math.round(b.height + 12) });
				await el.dispose();
			}
			await fx("spotlight", rects);
			if (rects.length) state.cue(`highlight ${rects.length} element(s)`);
		},
		clearSpot: () => fx("spotlight", []),
		hideCursor: () => fx("cursorHide"),

		/** Bottom-nav tab by visible label. */
		// ⚠️ Both carry a trailing count badge in the same element — a sub-tab's
		// textContent is "Active3", not "Active" — so these MUST be non-exact.
		tab: (label) => H.tap({ text: label, exact: false }),
		subTab: (label) => H.tap({ text: label, exact: false }),
		/**
		 * Expand an accordion AND bring its content on screen.
		 *
		 * ⚠️ Prefer this over section() for any beat that narrates what is INSIDE
		 * the panel. section() only guarantees the header is visible; the revealed
		 * rows land below the fold, behind the caption band.
		 */
		async openSection(title, opts = {}) {
			await H.section(title);
			await sleep(opts.settle ?? 1500);
			// A tap can miss when a preceding collapse reflows the page under it, so
			// confirm the panel really opened and retry once before narrating it.
			const isOpen = () => page.evaluate((t) => {
				const el = Array.from(document.querySelectorAll(".van-collapse-item__title"))
					.find((n) => (n.textContent || "").trim().toLowerCase().includes(t.toLowerCase()));
				return el ? el.getAttribute("aria-expanded") === "true" : null;
			}, title);
			if ((await isOpen()) === false) {
				console.log(`     ! openSection("${title}") did not open — retrying`);
				await H.tapSection(title);
				await sleep(1200);
			}
			const body = await page.evaluateHandle((t) => {
				const head = Array.from(document.querySelectorAll(".van-collapse-item__title"))
					.find((n) => (n.textContent || "").trim().toLowerCase().includes(t.toLowerCase()));
				if (!head) return null;
				const item = head.closest(".van-collapse-item");
				return item && (item.querySelector(".van-collapse-item__content") || item);
			}, title);
			const el = body.asElement();
			if (!el) { await body.dispose(); return false; }
			const inset = await page.evaluate(`window.__vfx.bandInset(${JSON.stringify(opts.at || "bottom")})`);
			await page.evaluate((e, o) => window.__vfx.scrollTo(e, o), el, { align: "top", inset, ms: 700 });
			await sleep(260);
			await el.dispose();
			return true;
		},

		/**
		 * Walk a LONG page from top to bottom so the viewer actually sees it.
		 *
		 * ⚠️ The Driver Kit is taller than three viewports. Narrating "your licence,
		 * your medical card and every contract you've signed" over a static shot of
		 * the profile card promises content the clip never shows.
		 */
		async reveal(opts = {}) {
			const steps = opts.steps ?? 3;
			const hold = opts.hold ?? 1500;
			for (let i = 0; i < steps; i++) {
				const more = await page.evaluate((frac) => {
					const sc = document.querySelector("main.main") || document.scrollingElement;
					if (!sc) return false;
					const max = sc.scrollHeight - sc.clientHeight;
					if (max <= 4) return false;
					const to = Math.min(max, sc.scrollTop + sc.clientHeight * frac);
					const from = sc.scrollTop;
					if (to - from < 4) return false;
					const t0 = performance.now(), dur = 900;
					const ease = (x) => (x < .5 ? 4*x*x*x : 1 - Math.pow(-2*x+2,3)/2);
					return new Promise((done) => {
						const step = (now) => {
							const p = Math.min(1, (now - t0) / dur);
							sc.scrollTop = from + (to - from) * ease(p);
							p < 1 ? requestAnimationFrame(step) : done(sc.scrollTop < max - 4);
						};
						requestAnimationFrame(step);
					});
				}, opts.frac ?? 0.62);
				await sleep(hold);
				if (!more) break;
			}
		},

		/**
		 * Resolve an accordion header BY BEING an accordion header.
		 *
		 * ⚠️ Do not route these through the generic text resolver. It returns the
		 * SHORTEST text match, and on the load page "Fuel" matches the header chip
		 * "⛽ Fuel ?" (y=17) long before the Fuel accordion (y=887) — so the tap
		 * landed on the chip and the panel silently stayed shut.
		 */
		async collapseTitle(title) {
			const h = await page.evaluateHandle((t) => {
				return Array.from(document.querySelectorAll(".van-collapse-item__title"))
					.find((n) => (n.textContent || "").trim().toLowerCase().includes(t.toLowerCase())) || null;
			}, title);
			const el = h.asElement();
			if (!el) { await h.dispose(); return null; }
			return el;
		},

		/** Tap an accordion header, scrolling it into view first. */
		async tapSection(title) {
			const el = await H.collapseTitle(title);
			if (!el) { console.log(`     ! tapSection: no accordion titled "${title}"`); return false; }
			const inset = await page.evaluate('window.__vfx.bandInset("bottom")');
			await page.evaluate((e, o) => window.__vfx.scrollTo(e, o), el, { inset, ms: 600 });
			await sleep(240);
			let box = await el.boundingBox();
			const vp = page.viewport();
			if (!box || box.y < 0 || box.y + box.height > vp.height) {
				await page.evaluate((e) => e.scrollIntoView({ block: "center" }), el);
				await sleep(500);
				box = await el.boundingBox();
			}
			if (!box) { await el.dispose(); return false; }
			await fx("cursorTo", Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2));
			await sleep(620);
			await fx("cursorTap");
			await sleep(200);
			await page.touchscreen.tap(Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2)).catch(() => {});
			await sleep(200);
			await fx("cursorClear");
			await el.dispose();
			state.cue(`tap section "${title}"`);
			return true;
		},

		/** Collapse an accordion that is open — used to make room for the next one. */
		async closeSection(title) {
			const open = await page.evaluate((t) => {
				const el = Array.from(document.querySelectorAll(".van-collapse-item__title"))
					.find((n) => (n.textContent || "").trim().toLowerCase().includes(t.toLowerCase()));
				return el ? el.getAttribute("aria-expanded") === "true" : null;
			}, title);
			if (open === true) { await H.tapSection(title); await sleep(700); }
			return open;
		},

		section: async (title) => {
			const open = await page.evaluate((t) => {
				const el = Array.from(document.querySelectorAll(".van-collapse-item__title"))
					.find((n) => (n.textContent || "").trim().toLowerCase().includes(t.toLowerCase()));
				return el ? el.getAttribute("aria-expanded") === "true" : null;
			}, title);
			if (open === false) await H.tapSection(title);
			return open;
		},
		async openLoad(loadId) {
			const id = String(loadId).replace(/^#/, "");
			return H.tap({ text: id, exact: false });
		},
	};
	return H;
}

// ---------------------------------------------------------------------------

async function main() {
	if (has("list")) { listClips(); return; }
	lintCaptions();

	for (const d of Object.values(DIR)) fs.mkdirSync(d, { recursive: true });

	if (has("dry")) {
		console.log("\nDRY RUN — script + estimates only, no browser, no writes.\n");
		let total = 0;
		for (const { clip, i } of selected()) {
			const est = clip.beats.reduce((a, b) => a + (b.dwell || sayMs(b.say)), 0);
			total += est;
			const w = words(clip.beats.map((b) => b.say).join(" "));
			const flag = est < 30000 ? " (SHORT)" : est > 90000 ? " (LONG)" : "";
			console.log(`  ${clipNo(i)} ${clip.id.padEnd(26)} ~${String(Math.round(est / 1000)).padStart(3)}s  ${String(w).padStart(3)} words${flag}`);
			writeScript(clip, i, clip.beats.flatMap((b) => (b.cue ? [b.cue] : [])), est);
		}
		console.log(`\n  total ~${Math.round(total / 1000)}s across ${selected().length} clip(s)`);
		console.log(`  scripts written to ${path.relative(process.cwd(), DIR.script)}/`);
		return;
	}

	await assertSafeTarget(BASE);
	const drv = await login(BASE, DRIVER.username, DRIVER.password);
	const adm = await login(BASE, ADMIN.username, ADMIN.password);
	// ⚠️ Take the display name from the SESSION, never a constant — that
	// disagreement is what broke the still runner's defaults.
	const driverName = drv.user?.full_name || drv.user?.driverName || drv.user?.username;
	console.log(`\n  driver : ${DRIVER.username} -> "${driverName}"`);
	console.log(`  base   : ${BASE}\n`);

	const api = makeApi(BASE, drv.cookie);
	const adminApi = makeApi(BASE, adm.cookie);
	const ops = makeStateOps({ api, adminApi, driverName });

	const browser = await puppeteer.launch({
		headless: "new",
		args: [
			"--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage",
			// ⚠️ MANDATORY. page.screencast() measures the viewport with
			// deviceScaleFactor forced to 0, then restores the real one in a
			// fire-and-forget deferral. Headless DPR is 1, so the recorder is built
			// at 414x896 while Chrome emits 828x1792 — and its first filter is
			// crop='min(414,iw):min(896,ih):0:0'. Without this flag you silently get
			// the TOP-LEFT QUARTER of every frame. Verified 2026-09-03: absent ->
			// 414x896, present -> 828x1792.
			"--force-device-scale-factor=2",
			"--hide-scrollbars", "--mute-audio",
			"--autoplay-policy=no-user-gesture-required",
			// darwin omits --disable-gpu: with it, networkidle0 never settles on
			// macOS. Same carve-out lib/pdf-browser.js documents.
			...(process.platform === "darwin" ? [] : ["--disable-gpu"]),
		],
	});

	let failures = 0;
	for (const { clip, i } of selected()) {
		const no = clipNo(i);
		const label = `${no}-${clip.id}`;
		console.log(`▶ ${label} — ${clip.title}`);

		try {
			if (clip.reset) console.log(`   stage: ${await clip.reset(ops)}`);
		} catch (e) {
			console.error(`   ✗ staging failed: ${e.message}`);
			failures++; continue;
		}

		const page = await browser.newPage();
		await page.setViewport({ ...PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
		await page.setUserAgent(IPHONE_UA);
		// An `anonymous` clip films the signed-OUT app (the sign-in clip), so it
		// must not carry the session cookie.
		if (!clip.anonymous && !clip.html) await page.setCookie({ name: "connect.sid", value: drv.cookie, url: BASE });
		await page.evaluateOnNewDocument(FX_SOURCE);

		// Geolocation, so the Navigate beat does not park on "Phone location is off".
		try {
			const ctx = browser.defaultBrowserContext();
			await ctx.overridePermissions(BASE, ["geolocation"]);
			await page.setGeolocation({ latitude: 35.106572, longitude: -94.641539 });
		} catch {}

		if (clip.html) await page.setContent(clip.html, { waitUntil: "load" });
		else await page.goto(`${BASE}${clip.route || "/driver"}`, { waitUntil: "networkidle0", timeout: 45000 }).catch(() => {});
		await page.evaluate(FX_SOURCE);           // idempotent re-assert
		await sleep(clip.settle ?? 2500);

		const cues = [];
		const track = [];
		let t0 = 0, cur = null;
		const state = {
			cue: (c) => cues.push(c),
			mark: (text) => {
				const now = Date.now() - t0;
				if (cur) { cur.end = now; track.push(cur); cur = null; }
				if (text) cur = { start: now, end: now, text };
			},
		};
		const h = helpers(page, state);

		// Opening frame BEFORE the recorder starts, so navigation, the aggregate
		// fetch and the map's first paint never reach the video.
		if (clip.open) { try { await clip.open(page, h); } catch (e) { console.log(`   ! open: ${e.message}`); } }
		// open() drives real taps, so park the cursor and clear any highlight before
		// the first frame — otherwise the clip opens on a stale dot.
		await page.evaluate("window.__vfx.cursorHide(); window.__vfx.spotlight([]); window.__vfx.caption('')").catch(() => {});
		await sleep(400);

		const webm = path.join(DIR.raw, `${label}.webm`);
		const mp4 = path.join(DIR.clips, `${label}.mp4`);
		const rec = await page.screencast({ path: webm, fps: FPS, quality: 18 });
		t0 = Date.now();
		await sleep(300);   // anchor the constant-fps grid before anything moves

		const verifyFails = [];
		let beatNo = 0;
		for (const beat of clip.beats) {
			beatNo++;
			const dwell = beat.dwell || sayMs(beat.say);
			const began = Date.now();
			await h.caption(beat.caption ?? beat.say, beat.at);
			if (beat.spot) await h.spot(beat.spot); else await h.clearSpot();
			if (beat.do) { try { await beat.do(page, h); } catch (e) { console.log(`   ! beat: ${e.message}`); } }

			// ⚠️ VERIFY THE NARRATION. A caption that describes a panel the frame
			// does not show is the failure mode this whole file exists to avoid, and
			// it is invisible to every structural check — durations, codecs and file
			// parity all pass while the clip teaches nothing.
			if (beat.expect) {
				const specs = Array.isArray(beat.expect) ? beat.expect : [beat.expect];
				for (const spec of specs) {
					const el = spec.section
						? (await page.evaluateHandle((title) => {
								const head = Array.from(document.querySelectorAll(".van-collapse-item__title"))
									.find((n) => (n.textContent || "").trim().toLowerCase().includes(title.toLowerCase()));
								if (!head || head.getAttribute("aria-expanded") !== "true") return null;
								const item = head.closest(".van-collapse-item");
								return item && item.querySelector(".van-collapse-item__content");
							}, spec.section)).asElement()
						: await resolveHandle(page, spec);
					const box = el ? await el.boundingBox() : null;
					const inset = await page.evaluate(`window.__vfx.bandInset(${JSON.stringify(beat.at || "bottom")})`);
					const vpH = page.viewport().height;
					const top = inset.top, bot = vpH - inset.bottom;
					// ⚠️ "Peeking" is not "visible". The first version of this check passed a
					// Pickup Details panel showing ONE cut-off row above the caption band,
					// because it only asked whether any part of the box crossed the line.
					// Require a real, readable amount of the element to be inside the band.
					const need = Math.min(box ? box.height : 0, 90);
					const shown = box ? Math.min(box.y + box.height, bot) - Math.max(box.y, top) : 0;
					const visible = box && shown >= need - 2;
					if (!visible) {
						verifyFails.push(`${label} beat ${beatNo}: "${String(beat.caption ?? beat.say).slice(0, 46)}…" — ` +
							`${JSON.stringify(spec)} ${box ? `only ${Math.round(shown)}px of ${Math.round(box.height)}px visible at y=${Math.round(box.y)} (band ${Math.round(top)}-${Math.round(bot)})` : "NOT FOUND or section still collapsed"}`);
					}
					if (el) await el.dispose();
				}
			}

			const left = dwell - (Date.now() - began);
			if (left > 0) await sleep(left);
			else console.log(`   ! beat ran ${-left}ms over its ${dwell}ms dwell`);
		}
		if (clip.outro) { await h.caption(clip.outro.caption); await sleep(clip.outro.dwell || 2200); }
		state.mark("");

		const measured = Date.now() - t0;
		await rec.stop();
		await sleep(500);
		await page.close();

		await transcode(webm, mp4);
		if (!KEEP_WEBM) fs.unlinkSync(webm);
		writeScript(clip, i, cues, measured);
		writeVtt(clip, i, track);

		const kb = Math.round(fs.statSync(mp4).size / 1024);
		const band = measured < 30000 ? " (SHORT)" : measured > 90000 ? " (LONG)" : "";
		console.log(`   ✓ ${(measured / 1000).toFixed(1)}s${band}  ${kb} KB  ${path.relative(process.cwd(), mp4)}`);
		if (verifyFails.length) {
			failures++;
			console.log(`   ⚠ ${verifyFails.length} NARRATION/VISIBILITY problem(s):`);
			verifyFails.forEach((v) => console.log(`      ${v}`));
		}
		console.log("");
	}

	await browser.close();
	if (failures) { console.error(`\n${failures} clip(s) failed staging.`); process.exit(1); }
	console.log(`Done. Clips in ${path.relative(process.cwd(), DIR.clips)}/`);
}

main().catch((e) => { console.error("\nFAILED:", e.message); process.exit(1); });
