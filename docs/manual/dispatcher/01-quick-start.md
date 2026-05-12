# Quick Start

What you'll see when you sign in, what each part is for, and how a typical day flows.

## Signing in

Go to `app.logisx.com`. Sign in with your dispatcher credentials. You land on the **Operations Dashboard** at `/dashboard`.

## The dashboard at a glance

The dashboard has a header strip of KPI cards across the top showing current totals (active loads, pending loads, trucks on the road, revenue this period), then a tabbed area below with four tabs.

![Operations Dashboard](screenshots/dispatcher-dashboard.png)

| Tab | Contents |
|---|---|
| **Job Board** | Unassigned loads waiting for a driver. New arrivals from broker emails land here. |
| **Active Loads** | Loads currently in progress (dispatched, in transit, at receiver, etc.). |
| **Completed Loads** | Delivered loads, most recent first. |
| **Fleet** | Drivers and trucks — who's available, who's busy. |

Click any tab to switch. Each tab shows a count badge so you can see at a glance how many loads are in each state.

## The sidebar

On the left (desktop) or behind a hamburger menu (mobile/tablet), the sidebar gives you access to:

- **Dashboard** — back to the main operations view.
- **Tracking** — the live map showing every active truck.
- **Expenses** — driver expense submissions.
- **Messages** — chat threads with each driver.
- **Notifications** — system-generated alert feed.
- **Trucks** — fleet inventory (view-only mostly; some edits if your role allows).
- **Trailers** — same for trailers.

## A typical day

Roughly what your day looks like:

**Morning (7-10 AM):**
- New loads arrive overnight from broker emails. Open Job Board.
- Match each load to an available driver. Click load → pick driver → Assign.
- Drivers respond accept/decline. You see the responses in real time.
- Address any declines — pick a different driver, or message dispatch lead.

**Mid-day (10 AM-2 PM):**
- Watch tracking map. Address anything unusual (stuck driver, wrong route, status not advancing).
- Respond to driver messages as they come in.
- Approve or follow up on expense submissions.

**Afternoon (2-5 PM):**
- Drivers start delivering. Watch for POD uploads.
- Status updates roll through. Spot-check anything that looks off.
- New loads continue to arrive throughout — handle in real time.

**End of day:**
- Quick check: every active load has a current status, every recent load has a POD.
- Any pending issues (delayed deliveries, missing PODs) get flagged for follow-up.
- Hand off to after-hours dispatch (if applicable).

Most of this is reactive — you respond to what the app surfaces. The app does most of the work; you handle the exceptions.

## Real-time updates

The dashboard updates automatically when:

- A new load arrives (Job Board count goes up).
- A driver accepts or declines (you see immediately).
- A driver reports a new GPS position (tracking map moves).
- A driver updates status (Active Loads tab refreshes).
- A POD is uploaded (Active Loads tab updates).
- A driver sends a message (Messages tab badge increments).

You don't need to refresh. If you don't see something you expect, refresh manually — but in 99% of cases the screen is already current.

## Click anywhere to drill in

Almost everything on the dashboard is clickable. The general rule:

- **Click a card** in a list → open the detail view for that item.
- **Click a name** in any table → open that person's profile or thread.
- **Click a number** in a KPI card → filter the relevant view by that metric.

If you're not sure what something does, click it. The app is forgiving — almost every action has an undo or is reversible.

## Search

There's a search bar in the dashboard's job board and active loads area. Type a Load ID, broker name, city, or driver name. Results filter in real time.

For larger or older loads, the **Archive** is the place to look (Super Admin only, but you can ask).

## What you can do, what you can't

You **can**:
- Assign and reassign loads.
- Update load status.
- Send and receive messages with drivers.
- Add expenses on behalf of drivers (e.g., when a driver pays for something by phone).
- View the tracking map.
- Read the public customer tracker for any load.
- View trucks and trailers (mostly read-only).

You **cannot**:
- Cancel a load (Super Admin only).
- Approve or reject expense submissions (Super Admin).
- Approve invoices (Super Admin).
- Access the financials dashboard (Super Admin).
- Add or edit user accounts (Super Admin).
- Edit truck records beyond basic viewing.

Things on the "can't" list aren't roadblocks — they're decisions that need to flow through Super Admin. Escalate when needed.

## What goes wrong on day one

A few common day-one frustrations:

- **"I can't see the full job board."** — Refresh. If the loads aren't there, n8n may not have ingested them yet, or they may already be assigned.
- **"The driver isn't responding."** — Check their GPS on tracking. They may be off duty. Try a phone call.
- **"I see a load that says 'cancelled' but I didn't cancel it."** — A Super Admin did. Check the Notifications tab for the audit entry.
- **"I'm getting too many notifications."** — Right now there's no filter. You learn which ones to glance at and which to act on. Most are informational.

The rest of this guide covers each of these in detail.
