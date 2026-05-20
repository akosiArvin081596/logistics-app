# Customer Tracking Links

Every active load has a public tracking URL that brokers and shippers can use to follow the load themselves. This chapter is how to share it and what they see.

## What the public tracker is

The public tracker is a customer-facing page at `app.logisx.com/track/<LoadID>` that shows the status of a single load to anyone who knows the Load ID. No login required.

This solves the constant "where is my load?" calls from brokers. Send them the URL once and they can check whenever they want.

## What the customer sees

When a broker or shipper opens the tracker for a load, they see:

- **Current load status** — Dispatched, In Transit, At Receiver, Delivered, etc.
- **Driver's last known location** on a map (redacted to "stale" if no update in 2+ hours).
- **ETA** at destination, with on-time or delayed indicator.
- **Pickup and delivery addresses** — city, state, ZIP.
- **Truck unit number** — useful for security at delivery sites.

What they **don't** see:

- **Driver name.** Hidden.
- **Driver phone.** Hidden.
- **Broker name** (yours or anyone else's).
- **Rate or any financial info.**
- **Internal notes from dispatch.**

This is a deliberate whitelist. The page exposes only what's appropriate for customer eyes.

## Sharing the link

For each load:

1. **Open the load** from Active Loads.
2. **Click the Copy tracking link button** in the detail view.
3. **Paste into an email, text message, or chat** to the broker or shipper.

The link looks like `https://app.logisx.com/track/LD-3492`. You can shorten it via a URL shortener if you want, but it's already pretty clean.

Once shared, the customer can refresh it freely. The page is rate-limited but the limit is generous (60 requests per 15 minutes per browser) — they can refresh as often as they want during a delivery.

## When to share the link

Two scenarios:

**Proactively at booking.** When you accept a load from a broker, include the tracking link in your confirmation email. The broker can pass it to the customer. Fewer "where is my load?" calls.

**Reactively on demand.** When a broker calls asking for status, give them the link. "I'll text you a link you can refresh." Sets you up for fewer future calls about the same load.

Either way, the link is one of your easiest tools for reducing repetitive customer calls.

## What if the customer reports the page is broken

A few things to check:

**"Load not found."** They typed the Load ID wrong. Confirm the Load ID with them and re-send the link.

**"The map isn't loading."** Could be a Google Maps API issue (rare) or their browser. Have them try a different browser; refresh.

**"The status is stale."** The driver's phone isn't reporting. Either they're indoors with no signal, or they've closed the tab. The tracker shows "last known position" with a timestamp — if it's been hours, the customer is right to be concerned. Investigate and update them.

**"It's showing 'Delivered' but I haven't received it."** Either the geofence misfired (driver was near but not at the receiver), or the load was delivered to the wrong location. Investigate immediately.

## What you can't do via the tracker

The tracker is read-only. There's no:

- **Customer login** to leave notes.
- **Reschedule button.**
- **Driver contact button.**
- **Two-way communication.**

Anything the customer wants to do beyond watching has to go through you. That's intentional — the customer doesn't have an account, so they have no way to authenticate any action.

## Internal preview

You can preview what the customer sees yourself, even while logged in. Just navigate to `/track/<LoadID>` in your own browser. The same page renders. You see the customer-facing view exactly as they'd see it.

This is useful when:

- **Verifying what the customer sees** before sharing.
- **Troubleshooting** when a customer reports something looking wrong.
- **Demo'ing** the tracker to a new broker or shipper.

## Privacy

A few practical points:

- **The Load ID is the only credential.** Anyone with the URL can view. Treat Load IDs as semi-public — they're shared with brokers, drivers, and customers as part of normal business.
- **No PII leaks.** Driver name, phone, broker info, rate — none of it is on the public page. Even if the URL is shared widely, no sensitive data is exposed.
- **Search engines won't index it.** The page sets `X-Robots-Tag: noindex, nofollow`, so it won't appear in Google search results.
- **Rate limited.** A bad actor can't scrape every Load ID in sequence — the rate limiter kicks in. (And even if they did, they'd only get city-level position and status, nothing sensitive.)

## Brokers who hate it

Some brokers will say "just call me with updates instead of sending a link." Fine. Some prefer phone. The link is a tool, not a mandate.

Other brokers love it and will start asking for tracking links automatically. Have your copy-and-paste workflow ready.

## A few specific use cases

**Multi-stop loads.** The tracker shows current status of the load as a whole. Mid-trip stops (a multi-pickup or multi-drop) aren't called out separately. If a customer needs per-stop visibility, you'll have to message them with each update.

**Loads with overnight stops.** When a driver parks for the night, the tracker shows the last known position (the truck stop). The next morning when they start moving, the tracker updates.

**Loads with reefer monitoring.** The LogisX tracker doesn't currently show reefer temperature. If a customer needs that, route to your reefer monitoring vendor (separate system).

**Loads with security escort.** Some high-value loads have specific tracking requirements. The standard tracker is usually enough; if not, route to specialized tools.

## Pro tips

- **Send the link in your booking confirmation.** Set the expectation early.
- **Use the customer view yourself.** Once a day, glance at the customer tracker for an active load. It catches things you might not see in the dispatcher view (a stale position, a status that hasn't moved).
- **Don't send the dashboard URL by accident.** `app.logisx.com/dashboard` would prompt a login — useless for the customer. Always copy from the **Copy tracking link** button.
- **For repeat customers, the same Load ID format**. Some brokers ask for ID formatting consistency. Confirm with them at the start of the relationship.
