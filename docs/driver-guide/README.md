# Driver Training Guide — screenshots + voice-over scripts

21 numbered screenshots of the driver app, each paired with a voice-over script
of the same name. Play them in order and they walk one load end to end: sign in,
accept, read the load, climb the status ladder, upload the POD, log an expense,
then the other four tabs.

```
screenshots/NN-name.png             clean frame
screenshots-annotated/NN-name.png   same frame, highlighted
voiceover/NN-name.txt               the script for both
```

## Highlights

The annotated set dims the screen and rings the exact control the script names,
with a numbered badge per target. Both frames come from ONE page visit, so they
are pixel-aligned — you can cross-fade from clean to annotated in the edit.

Highlights are declared per beat in `driver-guide-storyboard.js`:

```js
highlight: [{ text: "Accept Load", label: 2 }]   // by visible text
highlight: [{ sel: ".action-btn", label: 1 }]    // by CSS selector
highlight: [{ section: "Documents", label: 1 }]  // an accordion's expanded body
```

They are drawn from the element's own `getBoundingClientRect()`, so a UI change
moves the highlight with the control instead of leaving a hand-drawn box circling
empty space. A `text` target climbs to its enclosing button — the smallest match
for "Accept Load" is the inner span, which would ring the label and miss the
button. `optional: true` suppresses the not-found warning for a target that may
legitimately be off-screen.

**Numbered badges appear only when a beat highlights two or more things.** On a
single-target beat the "1" carries no information, and sitting inline with real
UI it reads as app chrome — on the Alerts screen it looked exactly like an unread
count on the notification it pointed at. One ring is unambiguous on its own.

The runner prints `(hit/total targets)` per beat and warns when a required target
does not resolve, so a silently-unhighlighted frame cannot slip through.

Each script carries the spoken narration, on-screen cues for the editor, and —
where it matters — a production note.

## Regenerating

```bash
# 1. local server on the LOCAL sheet (never production)
PORT=3100 SPREADSHEET_ID=156Y5-OUUEZspiY7dRsJZ57iyKWLJAjdVP8a4yw0PMN0 npm start

# 2. capture
node scripts/docs/capture-driver-guide.js --base=http://localhost:3100
node scripts/docs/capture-driver-guide.js --list        # the storyboard
node scripts/docs/capture-driver-guide.js --only=14     # re-shoot one beat
```

Storyboard: `scripts/docs/driver-guide-storyboard.js`. Runner:
`scripts/docs/capture-driver-guide.js` (refuses any non-localhost target — it
WRITES, because it walks the status ladder).

## ⚠️ Staging is a precondition, not something the runner does

A production copy has **no live loads** — every row is Completed, Delivered or
Cancelled — so the accept flow and the status ladder cannot be photographed
as-found. Before a full re-run the LOCAL sheet needs:

- `DEMO-GUIDE-001` and `DEMO-GUIDE-002`, both `Dispatched`, assigned to the
  guide's driver, with **no** rows in `load_responses`
- that driver holding **no other active load** (`At Shipper` / `Loading` /
  `In Transit` / `At Receiver`), or `PUT /api/driver/status` answers 409 on the
  first `At Shipper`

On the copy this guide was shot from, the blocker was real load `7086762` parked
at `At Receiver` inside a **finalized** July 2026 — neither the driver route nor
an admin sheet edit could retire it, and both refused with `PERIOD_FINALIZED`.
The period had to be reopened, the row set to Completed, and the period
re-finalized. That guard is working correctly; plan around it rather than through
it.

Re-shooting a single beat with `--only` after a good run is safe.

## Two things this guide deliberately documents as-is

1. **The "one active job" refusal has no friendly message.** `StatusStepper`
   declares a `blocked` prop and renders "Complete your current active job before
   starting a new one" — but `LoadDetail`, its only caller, never binds
   `:blocked` and never uses the `hasActiveJob` prop it receives. The hint is
   therefore unreachable and the driver gets a raw 409 instead. Script
   `12-second-load-queued.txt` says "an error" rather than quoting text, so it
   stays accurate whether or not that is fixed. **Re-shoot beat 12 if it is.**

## Redaction

A beat can blur elements before the shot:

```js
redact: [".inv-amount"]
```

It runs BEFORE the clean capture, so real values never reach either file.
Currently used on frame 21 only, to blur a real driver's weekly pay. Blur rather
than substitution on purpose: an invented "$900.00 your pay" in a training video
reads as a rate a driver can expect, whereas a blur plainly says "redacted".
Everything the beat teaches — invoice number, week, status, load count, receipts
filed — stays legible.

2. **The account on screen is a real driver.** These were shot as `Shorn King`
   (`LogisX-3867`), the account with enough history — 112 expenses, 17 invoices —
   for the Invoices and Expenses tabs to look real. The pay column in
   `21-invoices.png` is blurred (see Redaction above); the driver's NAME is still
   in the header of every frame, which is a much lower-sensitivity call but yours
   to make. The database is sanitized (0 leaks
   asserted by `refresh-env.js`), but names and pay figures are not. To reshoot
   under a different account, pass `--user=` / `--pass=` and update the driver
   name in `driver-guide-storyboard.js`.


## ⚠️ Verifying a re-shoot — md5 is NOT enough

The first two capture passes silently produced the SAME screen under different
names, and an md5 comparison called them "all unique". It was wrong: the Route
Map's live ETA clock ticks between shots, so visually identical frames are
byte-different.

Two real bugs hid behind that false pass:

1. **`window` is not the scroller.** The driver app scrolls
   `<main class="main">` — measured, `document.scrollingElement.scrollHeight`
   equals the 896px viewport while `main` holds 1457px. Every `window.scrollTo()`
   was a no-op, so accordions at y≈1049–1181 opened below the fold and six
   "different" sections all photographed as the Route Map.
2. **Blind accordion clicks toggle sections shut.** Several are open by default,
   so clicking one that is already expanded closes it.

Both are fixed in `capture-driver-guide.js` (`scrollElementIntoView` walks up to
the real scrolling ancestor; `section()` checks `aria-expanded` before clicking).

**After any re-shoot, compare perceptually, not by hash:**

```bash
cd docs/driver-guide/screenshots
rm -rf /tmp/ph && mkdir -p /tmp/ph
for f in *.png; do sips -s format bmp -z 32 32 "$f" --out "/tmp/ph/${f%.png}.bmp" >/dev/null 2>&1; done
# then diff the raw pixels pairwise; anything scoring < 0.05 is the same screen
```

Baseline for the current set: closest pair is `10-status-at-shipper` vs
`11-status-loading` at **0.23**, which is correct — the status-ladder beats are
deliberately one screen with the stepper advancing. Nothing scores below 0.2.

## Known blemish

`09-fuel.png` carries a "Checked too many times just now" banner — the fuel/POI
endpoints are rate-limited per user (15-minute window) and repeated capture runs
exhaust it. The teaching content (live diesel prices, cheapest-first, distance
off route) is unaffected. Re-shoot after a 15-minute pause for a clean frame.
That truck's ELD genuinely does not report a fuel level, so the range half needs
a different truck to demonstrate.
