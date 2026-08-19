#!/usr/bin/env node
/**
 * Tests for the concurrency gate and shutdown reaping in lib/pdf-browser.js.
 *
 * WHY THIS EXISTS. The module is a singleton BROWSER, not a singleton renderer:
 * every caller reached newPage() unserialized, so open Chromium tabs were bounded
 * by nothing. Two routes carried their own in-flight caps covering 2 of ~14 render
 * paths. Separately, production held two Chromium processes started 2026-08-01,
 * ppid=1, alive through ~150 app restarts — close() was losing a race with SIGKILL
 * and orphaning them.
 *
 * The properties that must hold, each of which is a way this can go wrong:
 *   §1 the gate bounds OPEN PAGES, and the slot returns when the page CLOSES
 *   §2 a failed open never keeps its slot        (else the gate ratchets shut)
 *   §3 a browser death releases everything       (same, via the crash path)
 *   §4 the wait is bounded and then REFUSES      (never past the 20 s client budget)
 *   §5 the slot is acquired OUTSIDE the retry loop, so queue wait is not scored
 *      as event-loop stall — the trap that would turn contention into double work
 *   §6 shutdown force-kills a browser that will not close in time
 *
 * Uses a fake browser, so it is fast and needs no Chromium. §5 is asserted
 * textually against the source, because it is a property of WHERE the call sits.
 *
 * Run: node scripts/test-pdf-render-gate.js
 */
const fs = require("fs");
const path = require("path");
const Module = require("module");

const SRC_PATH = path.join(__dirname, "..", "lib", "pdf-browser.js");
const SRC = fs.readFileSync(SRC_PATH, "utf8");

const failures = [];
let pass = 0;
const ok = (cond, msg) => { if (cond) pass++; else failures.push(msg); };

// ── a fake puppeteer, so no Chromium is launched ────────────────────────────
function loadModuleWithFakePuppeteer(fake) {
  const orig = Module.prototype.require;
  Module.prototype.require = function (id) {
    if (id === "puppeteer") return fake;
    return orig.apply(this, arguments);
  };
  delete require.cache[require.resolve(SRC_PATH)];
  try { return require(SRC_PATH); }
  finally { Module.prototype.require = orig; delete require.cache[require.resolve(SRC_PATH)]; }
}

function makeFakeBrowser({ failOpen = false, closeHangs = false } = {}) {
  const listeners = {};
  const killed = { value: false };
  const proc = { pid: 999999, get killed() { return killed.value; } };
  const browser = {
    isConnected: () => true,
    process: () => proc,
    on: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); },
    emit: (ev) => (listeners[ev] || []).forEach((f) => f()),
    close: () => (closeHangs ? new Promise(() => {}) : Promise.resolve()),
    newPage: async () => {
      if (failOpen) throw new Error("newPage exploded");
      const pl = {};
      return {
        setContent: async () => {},
        evaluateHandle: async () => {},
        once: (ev, fn) => { (pl[ev] = pl[ev] || []).push(fn); },
        close: async () => { (pl.close || []).forEach((f) => f()); },
      };
    },
  };
  return { browser, proc, killed };
}
const fakePuppeteer = (opts) => {
  const made = makeFakeBrowser(opts);
  return { made, launch: async () => made.browser };
};

(async () => {
  // ───────────────────────────────── §1 the gate bounds OPEN pages
  {
    process.env.PDF_MAX_INFLIGHT = "2";
    process.env.PDF_QUEUE_WAIT_MS = "0"; // refuse immediately, no queue
    const fp = fakePuppeteer();
    const m = loadModuleWithFakePuppeteer(fp);

    const p1 = await m.openPageWithContent("<p>1</p>");
    const p2 = await m.openPageWithContent("<p>2</p>");
    ok(m.renderSlotStats().inflight === 2, "§1 two open pages should occupy two slots");

    let refused = null;
    try { await m.openPageWithContent("<p>3</p>"); } catch (e) { refused = e; }
    ok(refused && refused.code === "PDF_RENDERER_BUSY",
      "§1 a third concurrent open must be refused, not admitted — the cap is the point");
    ok(refused && refused.status === 503, "§1 the refusal must carry a status the routes can map");

    // …and closing a page must GIVE THE SLOT BACK.
    await p1.close();
    ok(m.renderSlotStats().inflight === 1, "§1 closing a page did not release its slot");
    const p3 = await m.openPageWithContent("<p>3</p>");
    ok(p3, "§1 the freed slot should admit the next caller");
    await p2.close(); await p3.close();
    ok(m.renderSlotStats().inflight === 0, "§1 all slots should be back");
  }

  // ───────────────────────────────── §2 a FAILED open must not keep a slot
  {
    process.env.PDF_MAX_INFLIGHT = "1";
    process.env.PDF_QUEUE_WAIT_MS = "0";
    const m = loadModuleWithFakePuppeteer(fakePuppeteer({ failOpen: true }));
    for (let i = 0; i < 3; i++) {
      try { await m.openPageWithContent("<p>x</p>"); } catch { /* expected */ }
    }
    ok(m.renderSlotStats().inflight === 0,
      `§2 LEAK: a throwing open kept its slot — the gate ratchets shut after ${m.renderSlotStats().inflight} failure(s)`);
  }

  // ───────────────────────────────── §3 a browser death releases everything
  {
    process.env.PDF_MAX_INFLIGHT = "2";
    process.env.PDF_QUEUE_WAIT_MS = "0";
    const fp = fakePuppeteer();
    const m = loadModuleWithFakePuppeteer(fp);
    await m.openPageWithContent("<p>1</p>");
    await m.openPageWithContent("<p>2</p>");
    ok(m.renderSlotStats().inflight === 2, "§3 precondition: both slots taken");
    fp.made.browser.emit("disconnected"); // Chromium crashed / was OOM-killed
    ok(m.renderSlotStats().inflight === 0,
      "§3 LEAK: a browser crash left slots held for pages that no longer exist");
  }

  // ───────────────────────────────── §4 the wait is bounded, then refuses
  {
    process.env.PDF_MAX_INFLIGHT = "1";
    process.env.PDF_QUEUE_WAIT_MS = "150";
    const m = loadModuleWithFakePuppeteer(fakePuppeteer());
    const held = await m.openPageWithContent("<p>held</p>");
    const t0 = Date.now();
    let err = null;
    try { await m.openPageWithContent("<p>queued</p>"); } catch (e) { err = e; }
    const waited = Date.now() - t0;
    ok(err && err.code === "PDF_RENDERER_BUSY", "§4 a wait that expires must refuse");
    ok(waited >= 140, `§4 it should actually WAIT for a slot, not refuse instantly (waited ${waited} ms)`);
    ok(waited < 1500, `§4 the wait must be bounded — 20 s is the client's budget (waited ${waited} ms)`);

    // A slot freed while someone waits must be handed straight over.
    const p = m.openPageWithContent("<p>next</p>");
    setTimeout(() => held.close(), 20);
    ok(await p.then(() => true).catch(() => false),
      "§4 a slot released while a caller waits must be handed over, not re-raced");
  }

  // ───────────────────── §5 acquired OUTSIDE the retry loop (textual)
  {
    // Queue wait inside the loop would be measured by the stall sampler and
    // scored as event-loop stall, so contention would trigger the cold-start
    // retry and every queued render would do its work twice.
    const acquire = SRC.indexOf("await acquireRenderSlot()");
    const loop = SRC.indexOf("for (let attempt = 0; attempt < 2; attempt++)");
    const sampler = SRC.indexOf("const sampler = startLoopStallSampler()");
    ok(acquire > 0 && loop > 0 && sampler > 0, "§5 the three landmarks should all exist");
    ok(acquire < loop, "§5 the slot must be acquired BEFORE the retry loop");
    ok(acquire < sampler, "§5 the slot must be acquired BEFORE the stall sampler starts");
    ok(/page\.once\("close", releaseSlot\)/.test(SRC),
      "§5 the slot must be released by the page's close event, not when the function returns");
  }

  // ───────────────────────────────── §6 shutdown force-kills a hung close
  {
    process.env.PDF_CLOSE_TIMEOUT_MS = "100";
    const fp = fakePuppeteer({ closeHangs: true });
    const m = loadModuleWithFakePuppeteer(fp);
    await m.openPageWithContent("<p>x</p>");
    const killedPids = [];
    const realKill = process.kill;
    process.kill = (pid, sig) => { killedPids.push([pid, sig]); };
    try { await m.shutdownBrowser(); } finally { process.kill = realKill; }
    ok(killedPids.some(([pid, sig]) => pid === 999999 && sig === "SIGKILL"),
      "§6 ORPHAN: close() hung and shutdown did not force-kill — this is how two browsers survived 18 days of restarts");
    ok(m.renderSlotStats().inflight === 0, "§6 shutdown should release the gate too");
  }

  console.log(`\n${"=".repeat(64)}`);
  if (failures.length) {
    console.log(`FAILURES (${failures.length}):`);
    failures.forEach((f) => console.log(`  ✗ ${f}`));
    console.log(`\n${pass} passed, ${failures.length} failed`);
    process.exit(1);
  }
  console.log(`✓ ${pass} assertions passed`);
})();
