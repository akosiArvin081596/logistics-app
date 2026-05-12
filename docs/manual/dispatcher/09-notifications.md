# Notifications

The Notifications tab is the catch-all alert feed. Every system-generated event that involves dispatch lands here in reverse chronological order. This chapter is how to use it without drowning in it.

## What ends up in Notifications

The full list:

- **New load arrived** (from n8n broker email parsing).
- **Load assigned** (when you assigned a load — yes, your own actions log here).
- **Driver accepted a load.**
- **Driver declined a load.**
- **Load reassigned** (driver swap).
- **Load cancelled** (Super Admin action).
- **Load soft-deleted** (Super Admin action).
- **Status updated** (auto-advance or manual).
- **Geofence triggered.**
- **POD uploaded.**
- **Expense submitted.**
- **Expense approved/rejected** (Super Admin action).
- **Driver location update** (selective — typically only when there's a significant event like loss of signal).
- **New message** received from a driver.

Each notification is a row showing:

- **Type** (icon + label).
- **Description** of what happened.
- **Driver** or **load** involved.
- **Timestamp.**
- **Click target** — clicking the notification typically opens the relevant load.

## Reading the feed

The feed updates in real time. New events appear at the top. Read notifications are visually distinct from unread.

Patterns to recognize:

- **A burst of "new load arrived" early in the morning** — brokers sent rate confirmations overnight; n8n processed them in batch.
- **A pair of "load assigned" + "driver accepted"** within minutes — normal assignment flow.
- **A "driver declined" without a follow-up reassignment** — a load needing your attention.
- **A "POD uploaded" near the end of the day** — load nearing closure.

## Clicking through

Every notification with a load ID is clickable. Click → dashboard switches to Active Loads tab and opens that load's detail modal. From there you can take whatever action the notification implies.

This deep-linking is one of the most useful workflow shortcuts. Don't read a notification, then go hunt the load — just click.

## When to clear vs. when to leave

Notifications don't really get "cleared" — they stay in the feed for the historical record. Reading them marks them as read, but they remain.

Some dispatchers mark all as read at the end of each day. Some don't bother. Either is fine.

## Filtering

The feed currently doesn't have built-in filters by type or driver. You see everything mixed together.

If you need to filter:

- **Search bar** at the top of the feed accepts driver names, load IDs, and keywords.
- **Browser Ctrl+F** works as a quick filter for visible items.

For deeper analysis (which is rare), Super Admin has the audit trail tool.

## When notifications surface a problem

The feed is most useful when something has gone wrong. Examples:

**"Status updated to At Receiver" for a load you don't recognize.** Could be a geofence misfire. Click through, verify, correct if needed.

**Multiple "expense submitted" from one driver in a tight window.** They're catching up on receipts. Worth a glance to make sure they look right.

**"Driver declined" with no follow-up assignment.** Someone needs to pick this up. Reassign or escalate.

**"Load cancelled" you didn't initiate.** A Super Admin cancelled it; the notification typically includes who and why.

## When to call vs. follow up via Notifications

A notification is information, not necessarily action. Most notifications are informational. A handful prompt action:

| Notification | Action |
|---|---|
| New load arrived | Add to your queue, assign when ready |
| Driver declined | Reassign |
| Status auto-advanced but seems wrong | Investigate, correct |
| POD uploaded | None usually — load is moving toward closure |
| Driver location lost | Check whether they're online, message |
| Expense submitted | Review when you have time |

## End-of-day scan

A useful habit: at end of day (or end of shift), scan back through the day's notifications. Look for:

- **Any "declined" with no follow-up.** Loose ends.
- **Any "status updated" by anyone other than the driver or auto.** Manual updates from dispatchers or admins — was the reason clear?
- **Anything else that surprises you.** A pattern you hadn't noticed.

A 5-minute scan catches things that slipped during the busy parts of the day.

## When the feed is overwhelming

On busy days, the feed can scroll fast. Notifications you really need to act on get drowned by routine ones.

Three coping strategies:

1. **Focus on the dashboard, not the feed.** The Active Loads tab shows you what's actively in motion. The feed is the historical view; the dashboard is operational view.
2. **Use search.** Type a driver name or Load ID to filter the feed.
3. **Skip routine notifications.** "Status auto-advanced" for a load that's going smoothly doesn't need your attention. Glance and move on.

## Notifications and the audit trail

Notifications are user-facing summaries. The full audit trail (Super Admin only) has more detail — what changed exactly, who initiated, what the previous value was.

If you need to research something deeper than the Notification text shows, ask Super Admin to pull the audit trail entry.

## A few things Notifications won't tell you

- **Slack/email messages about the system.** Outside the app.
- **System errors or downtime.** You'd find out from leadership, not the feed.
- **Customer-side activity on the public tracker.** You don't see who looked at a load's tracking page.
- **Background jobs.** The Routemate sync, geocode cache refresh, etc. — invisible to the dispatcher.

For all of those, ask Super Admin or technical support.

## Pro tips

- **Glance every 15-30 minutes during active hours.** Faster than that is overkill; slower lets things accumulate.
- **Use the feed as a "what just happened" log when something looks weird.** A driver's status is wrong? Scroll the feed for the recent status changes.
- **Don't rely on the feed for active management.** The Active Loads tab is your real-time view; Notifications is the log.
- **Acknowledge dramatic events.** If a notification surfaces a real problem, send a message to confirm action — driver acceptance, broker update, etc.
