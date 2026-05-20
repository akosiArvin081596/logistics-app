# The Live Tracking Map

The tracking map at `/tracking` is your eyes on the fleet. It shows every truck currently on a load, their position updating in real time, and what they're doing.

## Opening the map

Sidebar → **Tracking**. The map loads centered on your fleet (usually a wide US view if trucks are scattered, zoomed in if they're clustered).

![Tracking Map](screenshots/dispatcher-tracking.png)

## What you see

Each truck on the road appears as a **blue marker** at its current GPS position. As the driver moves, the marker glides smoothly to the new position instead of jumping — easier to read at a glance.

Click any marker to see:

- **Driver name** and truck unit number.
- **Current speed** (if available).
- **Last update time.**
- **Load ID** they're working.
- **Link to the load detail.**

You'll also see, for the currently-selected truck:

- **Green pin** — pickup origin.
- **Red pin** — destination.
- **Orange dashed line** — the path the driver has already traveled.
- **Blue solid line** — the remaining route to destination.

This gives you a story: where they started, where they are, where they're going.

## Reading the map

A few patterns worth recognizing:

**Driver moving smoothly along a highway.** Everything's normal. The blue line shows their progress matches the planned route.

**Driver stopped for an extended time.** Either parked (truck stop, rest area, on-duty break), at the pickup waiting, or at delivery. Click the marker for context.

**Driver moving slowly in a city.** Yard congestion, urban traffic, or close to a pickup/delivery. Normal.

**Driver going off-route.** Could be deliberate (fuel stop, detour around closure, personal break) or accidental (wrong turn). Worth a message if it persists.

**Driver hasn't moved in a long time but isn't at a stop.** Could mean: stopped to address an issue, signal dropped (the position is the last known), or something's gone wrong. Message them.

**Marker is dim or shows old timestamp.** The driver's position hasn't updated recently. Phone is offline, signal is bad, or the tab was closed. Wait a minute; if it doesn't refresh, message them.

## ETA estimation

For each active load, the system calculates an ETA at the destination based on the driver's current position, route, and average speed. Click a load (or its truck marker) to see the ETA.

The ETA is compared to the scheduled delivery appointment to flag:

- **On time** — green indicator.
- **Delayed** — red indicator.

When a load goes from on-time to delayed, you'll see a notification. That's your cue to either message the driver about a delay or — if you can do something — speed things up.

## Multiple trucks at once

Looking at the whole fleet:

- All markers visible at once. Zoom in to see clustered trucks separately.
- Click any to see its details panel.
- If two drivers are at the same location (rare but happens), their markers may overlap. Zoom in to separate.

You can also drag the map to focus on a region (a single state, a city, the bottom of a long route).

## When the map looks wrong

A few cases:

**A truck appears in the wrong place.** Could be:
- GPS error (especially in urban canyons or after long indoor stretches).
- The driver tab is closed and the position is stale.
- The driver swapped phones and the new one hasn't reported yet.

Message the driver: "Where are you actually?" Their answer plus their position confirm or fix the picture.

**A truck doesn't appear at all.** They haven't reported GPS recently. Possibilities:
- Tab is closed.
- Phone is off.
- Signal is bad in their area.
- They forgot to grant location permission.

Message them to confirm they're online.

**The route line goes through impossible places.** The route is calculated by Google Maps; sometimes it picks an odd path. The truck is following whatever GPS unit they're using, not necessarily the LogisX-rendered route. The route line is a guide, not a turn-by-turn instruction.

## What dispatch can do from the map

Beyond viewing, the map is also actionable:

- **Click a truck → click the load link** → opens the load detail, where you can update status, reassign, or take any other action.
- **Right-click a truck** (on desktop) → quick options menu (varies by platform).

## When to look at the map

Throughout the day:

- **Morning** to confirm overnight drivers ended up where you expected.
- **Mid-day** to spot anything unusual.
- **Before answering broker calls** so you can give an accurate position.

You don't need to stare at the map all day. The notifications and dashboard surface what needs attention. The map is for the deeper "what's going on with X" questions.

## The customer tracking link

The same map data drives the public customer tracker. When you share a load's tracking URL with a broker or shipper:

- They see a simplified view (status, ETA, last known position).
- They don't see other trucks, driver names, or financial info.
- They can refresh it freely (rate-limited but generous).

This is the easiest way to defuse a "where is my load?" call from a broker — send them the link and let them watch.

## Pro tips

- **Refresh if the map looks stale.** Most of the time it's live, but a long open tab can drift.
- **Filter by load if you only care about one.** Click the load on Active Loads → its detail view shows the same tracking with focus on just that truck.
- **Zoom out before sharing your screen.** If you're presenting to leadership, show the whole fleet first, then zoom in for specifics.
- **Use it as a sanity check before approving anything.** If a driver claims to be in Atlanta and the map shows them in Birmingham, you have a question.

## When the map is wrong about a driver

GPS isn't perfect. If a driver disputes their position on the map ("I'm at the receiver, not parked at the gas station"), they're usually right. Trust the driver's voice over the map's last data point. The map is a tool; the driver is in the truck.
