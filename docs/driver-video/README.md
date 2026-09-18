# Driver app — instructional video series

Eleven short clips, one per task, that teach a driver how to use `/driver`.
**7m 31s total**, MP4 (H.264), phone-shaped, with burned-in captions so they work
with the sound off.

Regenerate with `npm run docs:video`. Iterate wording with `npm run docs:video:script`
(no browser, seconds).

| # | Clip | Length |
|---|---|---|
| 01 | signing-in | 41 s |
| 02 | your-loads-list | 33 s |
| 03 | accept-or-decline | 48 s |
| 04 | your-load-at-a-glance | 45 s |
| 05 | fuel-and-diesel-stops | 38 s |
| 06 | **status-updates-itself** | 61 s |
| 07 | **upload-your-pod** | 59 s |
| 08 | log-an-expense | 36 s |
| 09 | alerts-and-messages | 29 s |
| 10 | your-kit-and-truck | 32 s |
| 11 | invoices-and-getting-paid | 37 s |

Clips **06** and **07** are the pair that carry the series: everything is automatic
*except* the POD, and the POD is what gates the driver's own pay.

⚠️ **Clip 03 films the LOAD CARD, not the load detail page.** LoadDetail's
Accept/Decline sit ~344px below the fold on a 896px viewport (measured y=1240 vs
innerHeight 896), so every take depended on a scroll landing — and one silently
tapped the **Messages tab** instead, because `touchscreen.tap()` CLAMPS an
off-viewport coordinate into the viewport rather than failing. The card's buttons
are on screen from the first frame. `tap()` now re-measures immediately before
tapping and refuses an off-viewport target out loud; do not remove either guard.

**Demo data is curated, deliberately.** The refresh scrubber writes
`address="REDACTED"`, `email="<id>.driver@invalid"`, `phone="555-0100"` — correct
for a sanitized copy, but on screen they read as a BROKEN APP, which is the one
thing this video must not do. `drivers_directory` id=6 carries presentable values
(555-01xx stays in the reserved fictional range), and two dispatch messages that
were a developer introducing himself were rewritten as a real dispatch exchange.

## Output

```
clips/     NN-<id>.mp4    H.264 High, yuv420p, 828x1792, 30fps, +faststart, no audio
script/    NN-<id>.txt    voice-over script — RUN TIME is MEASURED, not estimated
captions/  NN-<id>.vtt    cue timings stamped during the take, so exact
.raw/                     intermediate VP9 .webm, only with --keep-webm
```

`say` in `scripts/docs/driver-video-storyboard.js` is the single source of truth:
it becomes the spoken script AND (trimmed to `caption`) the burned-in line, so the
two cannot drift.

## Recording

```bash
# 1. a server the recorder may write to, with the pollers OFF and scanning ON
ROUTEMATE_ENABLED=false LINXUP_ENABLED=false SCANKIT_ENABLED=true \
  PORT=3111 SPREADSHEET_ID=156Y5-OUUEZspiY7dRsJZ57iyKWLJAjdVP8a4yw0PMN0 npm start

# 2. record
npm run docs:video -- --base=http://localhost:3111            # all
npm run docs:video -- --base=http://localhost:3111 --only=06  # just one
```

Requires `ffmpeg` on PATH (`brew install ffmpeg`).

## Five things that will waste your afternoon

**1. A static page records a ZERO-BYTE file.** CDP emits a frame only when the page
composites; `ScreenRecorder` needs two before it writes anything. Measured on a
static `/login` for 4 s: `cdpFrames=1, bytes=0`. `lib/video-fx.js` injects a
permanently-animating 2px element to keep the compositor awake — with it,
`cdpFrames=244, bytes=124327`. **Do not remove the heartbeat.**

**2. Without `--force-device-scale-factor=2` you silently record the TOP-LEFT
QUARTER.** `page.screencast()` measures the viewport with `deviceScaleFactor: 0`
then restores it in a fire-and-forget deferral, so the recorder is built at
414x896 while Chrome emits 828x1792 — and its first filter is
`crop='min(414,iw):min(896,ih):0:0'`. Verified: absent -> 414x896, present ->
828x1792. No error either way.

**3. Puppeteer's `format:'mp4'` is VP9 in an MP4 container, which iPhones will not
play.** It spreads the same `libvpx` args as webm. The extension looks right while
failing on exactly the devices drivers use. The runner therefore records VP9 webm
and transcodes to H.264 with ffmpeg. **Do not "simplify" that away.**

**4. Turn the ELD pollers off before recording.** The geofence is live on this data
(`load_status_history` shows 566293352 climbing with `source:'geofence'`), so
`tryGeofenceAdvance()` can move the load mid-take and the clip films a status the
narration is not describing. Stored telemetry is unaffected, so the map pin and
fuel level still work — the position route's visibility window is **14 days**.

**5. A refreshed environment has nothing to film.** It is a copy of production, and
production has no live freight mid-ladder. Measured 2026-09-03: one non-terminal
load in the whole sheet, and both demo loads `Delivered` with PODs attached. Every
clip therefore stages its own preconditions via `lib/state-ops.js`.
⚠️ **Order is load-bearing** — walk the status DOWN before clearing PODs, or
`DELETE /api/documents/:id` answers 409 `LAST_POD_ON_DELIVERED_LOAD`.

## Accuracy rules the narration must keep

- **Status is automatic.** `server.js:36662` — *"arrival statuses, so a completion
  status can never be auto-written."* The buttons are a **manual fallback**. Never
  tell a driver they must tap at every stop.
- **Delivered is the exception**, and it is POD-gated.
- **The phone does not track the truck.** The ELD does. `useDriverPosition.js` makes
  no write call of any kind and `POST /api/location` is a 410 stub. Phone location
  only steers the on-phone map.
- **Button label != status value.** Buttons read `Arrived at Shipper` /
  `Arrived at Receiver`; statuses read `At Shipper` / `At Receiver`. Captions quote
  the **button**.

## Audience

Written for drivers in their 50s and 60s: caption type is 26px (52 device px at
2x), narration is paced at **2.35 words/sec** (the slow end of natural speech),
captions hold a 2.2 s floor, and jargon is defined on first use — "the black box
wired into your truck" before "ELD", "signed paperwork" before "POD".

⚠️ **Contains real customer and pay data** — the recordings are unredacted by
decision, for internal driver training only. Do not distribute outside the company.
