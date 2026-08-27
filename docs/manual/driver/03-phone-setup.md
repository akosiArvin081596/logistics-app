# Phone Setup

The LogisX app runs in your phone's browser. This chapter is the difference between "the app keeps logging me out" and "everything just works."

## Choose the right browser

LogisX works in any modern browser, but some are better than others on a phone:

| Phone | Recommended | Avoid |
|---|---|---|
| **Android** | **Chrome** (it's the default) | Older Samsung Internet, Opera Mini, anything pre-2020 |
| **iPhone** | **Safari** (it's the default) | Chrome on iPhone is fine but uses Safari under the hood anyway |

If you don't know what browser you're using, you're probably on the default — that's fine.

**Internet Explorer is not supported.** If your phone has only IE (rare these days), get a real browser from your app store.

## Bookmark the app

Open the browser and go to `app.logisx.com`. Then:

- **iPhone:** tap the **Share** button → **Add to Home Screen.** You get a tappable icon on your home screen that opens straight to the app.
- **Android:** tap the **⋮** menu → **Add to Home screen** (or **Install app**, depending on your browser).

This is worth doing. You'll open the app 50 times a week — a one-tap shortcut saves you typing.

## Grant location access

**Your phone is not what tracks you.** Position comes from the **ELD in your truck**, which reports on its own about once a minute. Dispatch, the geofence, the customer's tracking link and your pay all run off that — with the app closed, the phone locked, or location permission denied.

So there is nothing you need to grant, and nothing you need to leave running, for tracking to work.

### The one time your phone's location is used

When you tap **Navigate** on a load. Turn-by-turn directions need a far more precise and frequent position than the ELD gives, so the browser will ask at that moment. Tap **Allow.**

That position stays on your phone. It is never sent to LogisX and never affects tracking, pay or the geofence.

If you decline, navigation still shows the route and the written directions — you just don't get the moving arrow or the spoken turns. If you tapped Block by mistake:

- **Chrome (Android):** tap the lock icon in the address bar → **Permissions** → **Location** → toggle on.
- **Safari (iPhone):** Settings → Safari → Location → Allow. Or Settings → Privacy → Location Services → Safari Websites → While Using.

Then tap **Navigate** again — the app can only ask while you're tapping something, so re-granting on its own won't restart it.

## Closing the app is safe

Phones suspend background tabs to save battery, and that is fine here. Because tracking comes from the truck, closing the tab does **not** stop your position updating, does **not** stop the geofence advancing your status, and does **not** affect your pay.

What a suspended tab does pause is the live stuff *on your screen*: new messages and load alerts won't pop up until you come back. Reopen the app and it reconnects in a few seconds and catches up on anything you missed.

The one exception is **Navigate** — turn-by-turn needs the screen on and the app in front. The app asks the phone to keep the screen awake while you're navigating, and releases it when you exit.

## Save battery

The app is light when you're not navigating — it isn't running GPS in the background, because it doesn't need to.

- **Plug in while navigating.** Turn-by-turn keeps the screen on and uses your phone's GPS continuously; that is the one battery-hungry mode.
- **Reduce screen brightness** when you don't need to see it.
- **Exit Drive Mode when you're parked** — tap ✕. That releases the screen lock and stops the GPS watcher.

## Data usage

LogisX uses very little data. Average driver-day: 10-30 MB. The app:

- Sends **no** position data at all — that comes from the truck's ELD, over the ELD's own connection.
- Receives short status messages — no images or video stream.
- Loads small UI updates.

POD photo uploads are the biggest single transfer — a typical phone photo is 2-5 MB. You'll do 1-3 of these per day.

If you're on a metered plan, this is nothing. If you're tethering or using a hotspot, also nothing.

## Notifications

The app uses **in-app notifications** rather than your phone's push system. That means:

- When a new load is assigned, you'll see a badge on the **Loads** tab and a brief banner across the top of the screen.
- When a dispatcher sends you a message, you'll see a badge on the **Messages** tab.
- You will **not** get a OS-level push notification that lights up the lock screen.

Why no push notifications? Because phone push requires an installed app (and platform approvals). LogisX runs in the browser, which doesn't have the same capability.

In practice this means: **check the app periodically** when you're on duty. If dispatch needs you urgently, they'll call.

## What to do if the app feels slow

Most "the app is slow" reports turn out to be one of:

1. **Bad cell signal.** Check the signal bars. If you're in fringe coverage, the app will struggle.
2. **The phone is hot.** Phones throttle their CPU when they overheat. Move the phone out of direct sun.
3. **Too many tabs open.** Close the browser tabs you don't need.
4. **Old browser cache.** Once a month, clear the cache. (Chrome: Settings → Privacy → Clear browsing data → Cached images and files. Safari: Settings → Safari → Clear History and Website Data.)

If none of those help, message dispatch — there may be a server-side issue.

## Multiple devices

You can sign in on more than one device at the same time — for example, your phone in the cab and a tablet at home. Everything stays in sync. Logging out on one device doesn't log you out on the other.

This is useful for two scenarios:

- **Backup phone.** If your primary dies, sign in on your secondary while you charge.
- **Cab tablet.** Some drivers prefer a 7" or 10" tablet on a dash mount for the bigger screen. Same app, same login.

Don't lend your password to anyone, including your spouse or another driver. Each driver should have their own account.
