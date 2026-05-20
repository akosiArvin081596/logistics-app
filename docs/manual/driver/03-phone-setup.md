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

The very first time you open the driver app after onboarding, the browser will pop up a **"app.logisx.com wants to know your location"** prompt. Tap **Allow.**

Without GPS:

- Dispatch can't see where you are.
- Your status won't auto-advance when you arrive at pickup or delivery.
- The customer's tracking link won't work for your load.

Tap **Allow.** If you tapped Block by mistake, the app shows a "Location Access Required" lock screen with per-browser instructions to re-enable. Generally:

- **Chrome (Android):** tap the lock icon in the address bar → **Permissions** → **Location** → toggle on.
- **Safari (iPhone):** Settings → Safari → Location → Allow. Or Settings → Privacy → Location Services → Safari Websites → While Using.

After re-enabling, refresh the page.

## Keep the tab alive

Phones aggressively suspend background tabs to save battery. When the tab is suspended:

- GPS reports stop.
- Real-time messages don't arrive.
- Status doesn't auto-update.

To keep things working:

- **Don't close the LogisX tab** during a load. Leave it open.
- **Don't kill the browser app** in the task switcher.
- **iPhone:** lock screen is fine — Safari will keep your tab active. But if you switch to another app for more than a few minutes, iOS may suspend Safari.
- **Android:** similar behavior. Some manufacturers (Samsung, Xiaomi, OnePlus) are especially aggressive — find Settings → Battery → App optimization and exempt Chrome.

If you switch apps and come back to LogisX, it should reconnect within a few seconds. If you've been away for hours, you may need to refresh the page.

## Save battery

Running GPS continuously will drain your battery faster than normal browsing. Tips:

- **Plug in.** Most drivers run the phone on a dash mount with a charger. Do that.
- **Reduce screen brightness** when you don't need to see the screen. The app updates fine even when the screen is dim.
- **Don't run other GPS apps simultaneously.** If your dispatcher's TMS, your fuel app, and LogisX are all asking for GPS, your battery will take a beating. LogisX itself is light — heavy GPS use comes from running multiple apps in parallel.
- **Background apps.** Close apps you don't need. They add up.

## Data usage

LogisX uses very little data. Average driver-day: 10-30 MB. The app:

- Sends a GPS position every 60 seconds or when you've moved 50 meters (whichever happens first).
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
