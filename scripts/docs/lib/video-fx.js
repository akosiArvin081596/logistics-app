// scripts/docs/lib/video-fx.js — the in-page overlay the video recorder draws with.
//
// Everything here is injected INTO the page and captured natively by
// page.screencast(). Nothing is burned in afterwards with ffmpeg, for two
// reasons that both come down to trust:
//
//   - TIMING. The same script that drives the UI sets the caption, so a caption
//     cannot drift from the action it describes. An SRT authored up-front
//     desynchronises the moment any dwell changes.
//   - MEASUREMENT. Because the runner stamps the clock at each caption change,
//     the .vtt sidecar it emits is measured rather than estimated. That is the
//     one thing burn-in cannot give you.
//
// ⚠️⚠️ THE HEARTBEAT IS NOT DECORATION — WITHOUT IT THE RECORDER WRITES A
// ZERO-BYTE FILE.
//
// CDP emits `Page.screencastFrame` only when the page COMPOSITES. A static page
// composites once, on first paint. Puppeteer's ScreenRecorder pipes frames
// through `bufferCount(2, 1)`, so it needs at least TWO frames before it writes
// anything at all — and it fills static dwells by duplicating the held frame
// between real ones. Record a page that is merely sitting there and you get
// exactly one frame, zero duplicated frames, and a 0-byte .webm with no error
// anywhere: `screencast()` resolves, `stop()` resolves, ffmpeg exits 0.
//
// Measured on this app, 2026-09-03, recording a static /login for 4 s:
//     no heartbeat -> cdpFrames=1    bytes=0
//     heartbeat    -> cdpFrames=244  bytes=124327
//
// So a permanently-animating 2px element is what keeps the compositor awake and
// the frame grid honest. It is 1% opaque and pointer-events:none, and at 2px in
// the top-left corner it is invisible in the encoded frame.

"use strict";

// The FX root must out-rank everything the app teleports to <body>:
// DriveModeOverlay sits at z-index 99999 and ConfirmModal at 200. A caption
// explaining a modal has to be readable OVER that modal, so this is deliberate.
const FX_Z = 2147483000;

// Caption copy longer than this wraps to a third line and pushes the band over
// the control it is describing. The runner hard-fails at --dry rather than
// letting that reach a take.
//
// ⚠️ Lowered 84 -> 68 when the audience was confirmed as drivers in their 50s
// and 60s: the caption type went up to 26px for legibility, so fewer characters
// fit on a line. Raising this without shrinking the font brings the third line
// — and the occlusion — straight back.
const CAPTION_MAX_CHARS = 68;

/**
 * The whole overlay, as a string evaluated in the page. Written as a string (not
 * a function reference) so it can go through page.evaluateOnNewDocument() and
 * survive every navigation, then be re-asserted idempotently before each use.
 */
const FX_SOURCE = `(() => {
  if (window.__vfx) return;

  const Z = ${FX_Z};
  const style = document.createElement('style');
  style.id = '__vfx_style';
  style.textContent = \`
    @keyframes __vfx_hb_spin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }
    @keyframes __vfx_ripple  { from { transform: scale(.7); opacity:.95 } to { transform: scale(2.2); opacity:0 } }

    /* ⚠️ The compositor heartbeat. See the header comment — removing this
       silently produces a 0-byte recording. */
    #__vfx_hb {
      position: fixed; left: 0; top: 0; width: 2px; height: 2px;
      opacity: .01; pointer-events: none; z-index: \${Z + 1};
      background: #000; will-change: transform;
      animation: __vfx_hb_spin 1s linear infinite;
    }

    #__vfx_root {
      position: fixed; inset: 0; pointer-events: none; z-index: \${Z};
      font-family: -apple-system, "Helvetica Neue", Arial, sans-serif;
    }

    #__vfx_cap {
      position: absolute; left: 0; right: 0; bottom: 0;
      padding: 20px 20px calc(22px + env(safe-area-inset-bottom, 0px));
      background: linear-gradient(180deg, rgba(6,10,24,0) 0%, rgba(6,10,24,.93) 20%, rgba(6,10,24,.99) 100%);
      border-top: 2px solid #FFC400;
      /* 26px at 414 CSS px = 52 device px at 2x. Sized for a 60-year-old
         driver watching on a phone in a cab, not for a designer at a desk. */
      font-size: 26px; line-height: 1.34; font-weight: 700;
      color: #fff; text-align: center; text-wrap: balance;
      text-shadow: 0 1px 2px rgba(0,0,0,.6);
      /* Two lines are reserved permanently so a 1-line caption followed by a
         2-line one does not make the band jump mid-take. */
      min-height: 2.68em;
      opacity: 0; transform: translateY(8px);
      transition: opacity 220ms ease, transform 220ms ease;
    }
    #__vfx_cap.on { opacity: 1; transform: none }
    #__vfx_cap.top {
      bottom: auto; top: 0; border-top: 0; border-bottom: 2px solid #FFC400;
      padding: calc(14px + env(safe-area-inset-top, 0px)) 22px 16px;
      background: linear-gradient(0deg, rgba(6,10,24,0) 0%, rgba(6,10,24,.93) 20%, rgba(6,10,24,.99) 100%);
      transform: translateY(-8px);
    }
    #__vfx_cap.top.on { transform: none }

    #__vfx_cur {
      position: absolute; left: 0; top: 0; width: 46px; height: 46px; margin: -23px 0 0 -23px;
      border-radius: 50%; background: rgba(255,255,255,.30);
      border: 3px solid rgba(255,255,255,.95);
      box-shadow: 0 2px 14px rgba(0,0,0,.55), inset 0 0 0 8px rgba(255,196,0,.70);
      opacity: 0; transform: translate3d(-200px,-200px,0);
      transition: transform 620ms cubic-bezier(.22,.61,.36,1), opacity 200ms linear;
    }
    #__vfx_cur.on { opacity: 1 }
    #__vfx_cur.tap::after {
      content: ''; position: absolute; inset: -6px; border-radius: 50%;
      border: 3px solid #FFC400; animation: __vfx_ripple 420ms ease-out forwards;
    }

    #__vfx_spot { position: absolute; inset: 0; opacity: 0; transition: opacity 250ms ease }
    #__vfx_spot.on { opacity: 1 }
  \`;
  document.head.appendChild(style);

  const hb = document.createElement('div');
  hb.id = '__vfx_hb';
  document.documentElement.appendChild(hb);

  const root = document.createElement('div');
  root.id = '__vfx_root';
  root.innerHTML =
    '<div id="__vfx_spot"></div><div id="__vfx_cur"></div><div id="__vfx_cap"></div>';
  document.documentElement.appendChild(root);

  const cap  = root.querySelector('#__vfx_cap');
  const cur  = root.querySelector('#__vfx_cur');
  const spot = root.querySelector('#__vfx_spot');

  const easeInOutCubic = (t) => (t < .5 ? 4*t*t*t : 1 - Math.pow(-2*t + 2, 3) / 2);

  // The app's scroller is <main class="main">, NOT window. window.scrollTo() is a
  // silent no-op here — the same trap the screenshot runner documents.
  function scrollerOf(el) {
    let n = el && el.parentElement;
    while (n && n !== document.body) {
      const s = getComputedStyle(n);
      if (/(auto|scroll)/.test(s.overflowY) && n.scrollHeight > n.clientHeight + 4) return n;
      n = n.parentElement;
    }
    return document.querySelector('main.main') || document.scrollingElement || document.body;
  }

  window.__vfx = {
    CAPTION_MAX_CHARS: ${CAPTION_MAX_CHARS},

    caption(text, at) {
      cap.classList.toggle('top', at === 'top');
      if (!text) { cap.classList.remove('on'); return; }
      cap.textContent = text;
      // force a style flush so the transition actually runs
      void cap.offsetWidth;
      cap.classList.add('on');
    },

    /** Where the caption band is, so scrolling can keep targets clear of it. */
    bandInset(at) {
      const r = cap.getBoundingClientRect();
      return cap.classList.contains('on') ? { top: at === 'top' ? r.height : 0,
                                              bottom: at === 'top' ? 0 : r.height }
                                          : { top: 0, bottom: 0 };
    },

    cursorTo(x, y) {
      cur.classList.add('on');
      cur.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0)';
    },
    cursorTap()  { cur.classList.add('tap'); },
    cursorClear(){ cur.classList.remove('tap'); },
    cursorHide() { cur.classList.remove('on'); },

    /** Dim everything but the named rects, matching screenshots-annotated/. */
    spotlight(rects) {
      if (!rects || !rects.length) { spot.classList.remove('on'); spot.innerHTML = ''; return; }
      const W = innerWidth, H = innerHeight;
      const holes = rects.map(r =>
        '<rect x="' + r.x + '" y="' + r.y + '" width="' + r.w + '" height="' + r.h +
        '" rx="10" fill="#000"/>').join('');
      const rings = rects.map(r =>
        '<rect x="' + r.x + '" y="' + r.y + '" width="' + r.w + '" height="' + r.h +
        '" rx="10" fill="none" stroke="#FFC400" stroke-width="3"/>').join('');
      spot.innerHTML =
        '<svg width="' + W + '" height="' + H + '" style="position:absolute;inset:0">' +
          '<defs><mask id="__vfx_m">' +
            '<rect width="' + W + '" height="' + H + '" fill="#fff"/>' + holes +
          '</mask></defs>' +
          '<rect width="' + W + '" height="' + H + '" fill="rgba(6,10,24,.55)" mask="url(#__vfx_m)"/>' +
          rings +
        '</svg>';
      void spot.offsetWidth;
      spot.classList.add('on');
    },

    /** Eased scroll returning a promise — page.evaluate awaits it, so the
     *  runner blocks for the real duration. Chrome's native behavior:'smooth'
     *  is not duration-controllable and is too fast to read on video. */
    scrollTo(el, opts) {
      opts = opts || {};
      const sc = scrollerOf(el);
      const inset = opts.inset || { top: 0, bottom: 0 };
      const er = el.getBoundingClientRect();
      const sr = sc === document.body || sc === document.scrollingElement
        ? { top: 0, height: innerHeight } : sc.getBoundingClientRect();
      const safeTop = sr.top + inset.top + 12;
      const safeBot = sr.top + sr.height - inset.bottom - 12;
      let delta = 0;
      if (opts.align === 'top') {
        // ⚠️ Used after expanding an accordion. Scrolling the HEADER "into view"
        // leaves the freshly-revealed CONTENT below the fold and behind the
        // caption band — which is exactly what made the Pickup Details and Fuel
        // beats narrate detail the viewer could not see. Pin the content's TOP to
        // the safe top instead, so the whole panel is on screen.
        delta = er.top - safeTop;
      } else if (er.bottom > safeBot) delta = er.bottom - safeBot;
      else if (er.top < safeTop) delta = er.top - safeTop;
      if (Math.abs(delta) < 2) return Promise.resolve(0);
      if (opts.instant) { sc.scrollTop += delta; return Promise.resolve(delta); }
      const from = sc.scrollTop, dur = opts.ms || 800, t0 = performance.now();
      return new Promise((done) => {
        const step = (now) => {
          const p = Math.min(1, (now - t0) / dur);
          sc.scrollTop = from + delta * easeInOutCubic(p);
          p < 1 ? requestAnimationFrame(step) : done(delta);
        };
        requestAnimationFrame(step);
      });
    },
  };
})()`;

module.exports = { FX_SOURCE, FX_Z, CAPTION_MAX_CHARS };
