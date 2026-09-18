# LogisX Driver Training Videos — Final Set

12 short videos that teach a driver how to use the app.
**8 minutes 24 seconds total. 22 MB.**

---

## What to do

**The file names are exactly the same as before. Just overwrite.**

1. Copy all 12 videos from `clips/` over your old ones.
2. Say **yes / Replace** when it asks.
3. `12-before-you-go.mp4` is new — there is no old file to replace, it just gets
   added to the end.

That's it. Nothing is renamed and nothing is left over.

### Old file → new file

| Your old file | Replace with | |
|---|---|---|
| `01-signing-in.mp4` | `01-signing-in.mp4` | same name |
| `02-your-loads-list.mp4` | `02-your-loads-list.mp4` | same name |
| `03-accept-or-decline.mp4` | `03-accept-or-decline.mp4` | same name |
| `04-your-load-at-a-glance.mp4` | `04-your-load-at-a-glance.mp4` | same name |
| `05-fuel-and-diesel-stops.mp4` | `05-fuel-and-diesel-stops.mp4` | same name |
| `06-status-updates-itself.mp4` | `06-status-updates-itself.mp4` | same name |
| `07-upload-your-pod.mp4` | `07-upload-your-pod.mp4` | same name |
| `08-log-an-expense.mp4` | `08-log-an-expense.mp4` | same name |
| `09-alerts-and-messages.mp4` | `09-alerts-and-messages.mp4` | same name |
| `10-your-kit-and-truck.mp4` | `10-your-kit-and-truck.mp4` | same name |
| `11-invoices-and-getting-paid.mp4` | `11-invoices-and-getting-paid.mp4` | same name |
| *(none)* | `12-before-you-go.mp4` | **NEW — add it** |

Same applies to `script/` and `captions/` if you use them: same names, overwrite,
plus one new file 12.

⚠️ **If an old video does NOT get overwritten, you have a name that no longer
exists** — delete it. Every video in the current set is one of the 12 above.

---

## The videos

| # | File | Length | What it teaches |
|---|---|---|---|
| 01 | `01-signing-in.mp4` | 0:40 | Signing in |
| 02 | `02-your-loads-list.mp4` | 0:32 | Finding your loads |
| 03 | `03-accept-or-decline.mp4` | 0:48 | Accepting or declining a load |
| 04 | `04-your-load-at-a-glance.mp4` | 0:48 | Map, pickup and drop-off details |
| 05 | `05-fuel-and-diesel-stops.mp4` | 0:39 | Fuel range and **truck stops** to fuel at |
| 06 | `06-status-updates-itself.mp4` | 1:00 | **Your status updates itself** |
| 07 | `07-upload-your-pod.mp4` | 0:59 | **Uploading your POD** |
| 08 | `08-log-an-expense.mp4` | 0:35 | Logging a receipt |
| 09 | `09-alerts-and-messages.mp4` | 0:29 | Alerts and messaging dispatch |
| 10 | `10-your-kit-and-truck.mp4` | 0:48 | Your paperwork and truck documents |
| 11 | `11-invoices-and-getting-paid.mp4` | 0:36 | Invoices and getting paid |
| 12 | `12-before-you-go.mp4` | 0:30 | Closing summary |

**Videos 06 and 07 are the important ones.** Together they teach the single
thing drivers get wrong: the app moves your status by itself, and the only step
that needs you is uploading the POD — which is what gets you paid.

---

## The other folders

- **The spoken words** for each video are in `../script/` — one file per video.
  Use these if you want to record a voice-over. The words already appear on
  screen, so you do not need them to use the videos.
- **Subtitle files** are in `../captions/`. Only needed if you upload to YouTube
  or Vimeo and want subtitles you can switch on and off.

⚠️ **The videos themselves are not in git** — they are regenerated with
`npm run docs:video`, and shared through Drive. This folder is the changelog.

---

## Playing them

They play on iPhone, Android, laptops and Slack. Nothing to install.

The words appear on screen, so **they work with the sound off** — useful in a
noisy truck stop.

---

## Update — 5 Sep

**Video 05 was re-recorded** after Deshorn reported the fuel panel offering
regular gas stations. The app was ranking a cheap convenience store above a real
truck stop, so the list came back as a grocery store and a row of Casey's with no
Pilot or Love's in it. That is fixed: the panel now returns **truck stops only** —
places a truck can actually pull into and fuel at a truck lane — and falls back to
a regular station only if a lane genuinely has none, clearly marked
"Not a truck stop".

Video 05 now shows Pilot Travel Center and Love's Travel Stop with live pump
prices. **Replace video 05 with this one.**

⚠️ The app fix itself is **not deployed yet** — the video shows the corrected
behaviour, so ship the fix before showing the video to drivers.

---

## Two things to know

**These videos show real customer and pay information.** They are for LogisX
drivers only. Do not post them publicly or send them outside the company.

**Six small details are made up**, because the real ones are not on the machine
these were recorded on: the driver's street address, phone, cell, email, and two
dispatch messages. Everything else — the load, the route, the fuel readings, the
prices, the invoices, the truck paperwork — is real. If you want those six to be
real, send Howard Reddie's actual contact details and videos 09 and 10 can be
redone in a couple of minutes.

---

## If something needs changing

Any single video can be re-recorded on its own without touching the others.
Say which one and what should change.
