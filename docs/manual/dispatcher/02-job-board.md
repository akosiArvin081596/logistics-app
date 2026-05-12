# The Job Board

The **Job Board** is where every load you need to assign lives. New ones arrive here from broker emails; you move them out of here by assigning a driver.

## Where loads come from

Most loads arrive **automatically**. When a broker emails a rate confirmation to `info@logisx.com`, an automated workflow on the backend:

1. Reads the email.
2. Parses the attached PDF rate confirmation.
3. Extracts the load details (pickup, delivery, rate, broker reference, etc.).
4. Posts the extracted data to the LogisX server.
5. A new row appears on the Job Board within seconds.

You'll know a new load arrived because:

- The Job Board count in the header goes up.
- A brief notification highlights the new load on the dashboard.
- The **Notifications** tab shows the arrival.

Some loads arrive **manually** — entered by you or another dispatcher via the **New Job** button. Use manual entry for:

- Loads phoned in by a broker without an email.
- Re-entry of a load that got mis-parsed by automation.
- Internal moves not tied to a broker.

Manual entry opens a form. Fill in the broker, pickup, dropoff, rate, dates, and any notes; save; the load appears on the Job Board.

## Reading a load card

Each load on the Job Board is a card. The key fields:

- **Load ID** — the unique identifier (e.g., `LD-3492`). This is what brokers, drivers, and customers reference.
- **Broker** — who emailed the load.
- **Pickup** — city, state, ZIP, plus the pickup appointment time.
- **Drop-off** — same for delivery.
- **Rate** — the payment the broker has agreed to.
- **Equipment** — type required (dry van, reefer, flatbed, etc.).
- **Notes** — anything special the broker flagged.

Click the card to open the full detail view. Everything you need to make an assignment decision is visible.

## Assigning a load

To assign:

1. **Open the load.** Click its card on the Job Board.
2. **Pick a driver from the Driver dropdown.** Only available drivers (those not currently on an active load) appear. If a driver you want isn't listed, they're already on something — check Active Loads to confirm.
3. **Click Assign.**

What happens next:

- The load disappears from the Job Board.
- It appears in Active Loads with status **Dispatched**.
- The driver gets a real-time notification on their phone.
- The driver sees the load on their Loads tab with Accept/Decline buttons.

You don't have to wait for the driver to accept before moving on to the next assignment. They have to take some action (accept or decline), but until they do, the load is "dispatched" and ready for them.

## Driver responses

After you assign, the driver will:

- **Accept** — most common. Load moves to "Accepted" status and into their active queue.
- **Decline** — happens. The load returns to the Job Board. You'll see a notification with the decline reason (if the driver gave one).

When a driver declines, the load needs reassignment. See the Reassignment chapter.

## Choosing the right driver

Things to consider when picking from the dropdown:

- **Location.** Is the driver close to the pickup? Long deadheads waste time and fuel.
- **Equipment type.** Does their truck match what the load needs?
- **HOS.** Do they have enough hours to make the pickup and delivery on time?
- **Rate.** Does the driver-specific rate (daily or percentage) work for this load?
- **History.** Has the driver run for this broker before? Some brokers prefer specific drivers.
- **Personal preferences.** Drivers tell you the kinds of loads they want. Honor it when you can.

There's no scoring algorithm — these are judgment calls. The app surfaces the available drivers; you choose.

## Bulk operations

If multiple new loads land at once (common in the morning), assign them one at a time. There's currently no bulk-assign feature. The clicks add up, but each takes 10-20 seconds — five loads is two minutes total.

## Loads that linger on the Job Board

Some loads will sit on the Job Board for a while. Reasons:

- **No available driver in the area.** You may need to wait for a delivery to complete, or message a driver about a slightly off-route load.
- **Bad pickup window.** A load that picks up 600 miles away in 4 hours can't be run. Either decline to the broker or reschedule.
- **Equipment mismatch.** No flatbeds available for a flatbed load. Tell the broker.

If a load is stale (more than 24 hours on the board), check whether it's still viable. The broker may have given it to a different carrier already.

## When to decline a load to the broker

Sometimes you'll get a load that just doesn't make sense:

- Pickup is across the country and you have no driver heading that way.
- The rate is too low for the miles.
- The equipment isn't right.
- The pickup or delivery window is unworkable.

Don't sit on it. Call or email the broker, decline cleanly, and move on. The broker would rather know now than discover at the pickup that no one is coming.

Declining to a broker is handled outside the LogisX app — by phone or email — not via the dashboard. Once you've declined, you can manually delete the load from the system (ask Super Admin) or just leave it for the day to roll off.

## Search and filter

The Job Board has a search bar. Common uses:

- **Search by Load ID** — find a specific load.
- **Search by broker** — see all loads from one broker.
- **Search by city** — find loads near a particular area.

There's no advanced filter UI; the search is plain-text on multiple fields. Most dispatchers don't need filters — the Job Board rarely has more than a handful of loads at once.

## Pro tips

- **Glance at the Job Board first thing in the morning.** Anything that arrived overnight is your first work of the day.
- **Don't accept loads on the broker's side then never assign them.** A load sitting on the Job Board for days makes the broker think you don't have capacity.
- **Watch for duplicates.** Occasionally a broker re-sends a rate confirmation and you get two of the same load. The Admin Tools have a "Scan Duplicates" feature — ask Super Admin to run it monthly.
- **Note the broker.** Different brokers have different quirks. Some are easy; some require constant updates. Build a mental map.
