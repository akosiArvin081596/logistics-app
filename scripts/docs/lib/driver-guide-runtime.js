// scripts/docs/lib/driver-guide-runtime.js — the machinery the driver-guide
// STILL runner and the driver-guide VIDEO runner both need.
//
// It exists so the hard-won bits live in exactly one place. Chief among them:
// scrollElementIntoView(), which encodes the fact that window.scrollTo() is a
// SILENT NO-OP in this app — the scroller is <main class="main">. That was paid
// for once; copy-pasting it into a second runner is how it rots.

"use strict";

const PHONE = { width: 414, height: 896 };
const IPHONE_UA =
	"Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 " +
	"(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

/** Read a `--name=value` CLI flag. */
function arg(name, dflt) {
	const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
	return hit ? hit.slice(name.length + 3) : dflt;
}
const has = (name) => process.argv.includes(`--${name}`);

/**
 * REFUSE anything that is not a local server. Both runners WRITE — they advance
 * load status and re-dispatch loads — so pointing either at staging or
 * production would move real freight through the status ladder.
 */
async function assertSafeTarget(base) {
	if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base)) {
		throw new Error(`REFUSING: --base must be localhost, got ${base}`);
	}
	const res = await fetch(`${base}/api/auth/setup-check`, { signal: AbortSignal.timeout(4000) });
	if (!res.ok) throw new Error(`cannot reach ${base} (status ${res.status})`);
}

/**
 * Log in and keep the session cookie.
 *
 * ⚠️ Returns the resolved USER, and callers must take the driver's display name
 * from it rather than from a constant. The screenshot runner's `--user` default
 * (LogisX-3867 / Shorn King) had drifted away from its storyboard's hardcoded
 * DRIVER_NAME ("Howard Reddie"), so running it with no flag logged in as one
 * driver and queried the other — every `before()` hook died on a load that was
 * not in the payload. Deriving the name from the session makes that
 * disagreement unrepresentable.
 */
async function login(base, username, password) {
	const res = await fetch(`${base}/api/auth/login`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-requested-with": "XMLHttpRequest" },
		body: JSON.stringify({ username, password }),
	});
	if (!res.ok) throw new Error(`login failed for ${username}: ${res.status} ${await res.text()}`);
	const setCookie = res.headers.getSetCookie?.() || [];
	const sid = setCookie.find((c) => /^connect\.sid=/.test(c));
	if (!sid) throw new Error(`no connect.sid returned for ${username}`);
	const cookie = decodeURIComponent(sid.split(";")[0].split("=")[1]);
	const who = await res.json();
	return { cookie, user: who.user || null };
}

/** A fetch bound to one session cookie. `x-requested-with` is the CSRF header. */
function makeApi(base, cookie) {
	return async function api(path, opts = {}) {
		const res = await fetch(`${base}${path}`, {
			...opts,
			headers: {
				"content-type": "application/json",
				"x-requested-with": "XMLHttpRequest",
				cookie: `connect.sid=${encodeURIComponent(cookie)}`,
				...(opts.headers || {}),
			},
		});
		const text = await res.text();
		let body = null;
		try { body = text ? JSON.parse(text) : null; } catch { body = text; }
		return { ok: res.ok, status: res.status, body };
	};
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Resolve a target the way applyHighlights() already does: an explicit CSS
 * selector, or visible text. There are ZERO data-testid attributes in this
 * client, so text resolution is not a fallback — it IS the contract for most
 * controls. Text matches take the SMALLEST match, then climb to the enclosing
 * button, so "Delivered" finds the button and not the <body> that contains it.
 */
const RESOLVE = `(spec) => {
  if (spec.sel) return document.querySelector(spec.sel);
  if (!spec.text) return null;
  const want = spec.text.trim().toLowerCase();
  const all = Array.from(document.querySelectorAll('button, a, .van-button, [role=button], .sub-tab, .van-collapse-item__title, .van-tabbar-item, label, div, span'));
  const hits = all.filter((el) => {
    const t = (el.textContent || '').trim().toLowerCase();
    if (!t) return false;
    const exact = spec.exact !== false;
    if (exact ? t !== want : !t.includes(want)) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  if (!hits.length) return null;
  hits.sort((a, b) => (a.textContent || '').length - (b.textContent || '').length);
  const el = hits[0];
  return el.closest('button, .van-button, [role=button], .sub-tab, .van-collapse-item__title, .van-tabbar-item') || el;
}`;

async function resolveHandle(page, spec) {
	const target = typeof spec === "string" ? { text: spec } : spec;
	const h = await page.evaluateHandle(`(${RESOLVE})(${JSON.stringify(target)})`);
	const el = h.asElement();
	if (!el) { await h.dispose(); return null; }
	return el;
}

module.exports = {
	PHONE, IPHONE_UA, arg, has, assertSafeTarget, login, makeApi, sleep,
	RESOLVE, resolveHandle,
};
