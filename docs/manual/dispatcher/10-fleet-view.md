# Fleet View

The Fleet tab on the dashboard and the sidebar items for Trucks and Trailers give you visibility into the equipment. This chapter is how to read those views and what dispatchers typically use them for.

## The Fleet tab on the dashboard

From the operations dashboard, the **Fleet** tab shows trucks and their current state. Each truck card includes:

- **Truck unit number** (e.g., `TRK-101`).
- **Make, model, year.**
- **Status** — Active (assigned to a driver and on a load), Available (idle, no load), Maintenance.
- **Currently-assigned driver** (if any).
- **Last known location** (city, state).

This is your fleet at a glance. At any moment you can see how many trucks are working, how many are idle, and where everyone roughly is.

## The Trucks page

Sidebar → **Trucks**. A more detailed view of every truck in the fleet, sortable and searchable. For each truck:

- The fields above, plus:
- **VIN.**
- **License plate.**
- **Year, make, model.**
- **Owner ID** (which investor owns it, if applicable).
- **Documents** — registration, insurance, inspection (you can view).

Filters let you focus on a subset — active vs. idle, specific make, specific owner.

## The Trailers page

Sidebar → **Trailers**. Same general format but for trailers (van, reefer, flatbed, etc.). Useful when assigning a load that needs specific equipment.

## What dispatchers use Fleet for

A few common patterns:

**"Who's available right now?"**
Open the Fleet tab. Scan for Available status. That's your assignment pool.

**"Is Truck X idle? Should I reassign?"**
A truck idle for days may have a maintenance issue, the driver may be on vacation, or the truck may just not have had a load matching it. Worth checking.

**"What truck is Driver X in?"**
Find the driver on the Fleet tab (they're attached to a truck card if active). Or use the Drivers page (Super Admin) which shows the full driver-to-truck mapping.

**"Where's TRK-101 right now?"**
Open the Fleet tab and find TRK-101. The card shows last known location. For real-time position, switch to the Tracking map.

## What dispatchers don't typically do

Most truck and trailer edits are Super Admin actions:

- **Adding a new truck** to the fleet.
- **Removing a truck** (sold, scrapped).
- **Changing truck ownership** (owner_id).
- **Updating fixed cost fields** (insurance, ELD, IRP, etc.).
- **Uploading new documents** (registration renewal, etc.).
- **Setting the driver-visible flag** on a document.

You can view all of those, but editing is restricted. If you need a change, ask Super Admin.

## Truck-driver assignment

Trucks have a single assigned driver at a time. This is the driver who currently uses that truck day to day. Changes:

- A new hire gets assigned a truck during onboarding.
- A driver leaves the company; their truck is unassigned until reassignment.
- A truck goes into maintenance; the driver may be moved to a backup truck temporarily.

You see the current assignment in Fleet. To change the assignment, ask Super Admin.

## The driver-visible flag

Trucks have documents (registration, insurance card, inspection certificate). Some are flagged "driver-visible" — those appear in the driver's Kit tab on their phone.

Common documents flagged driver-visible:

- Registration.
- Insurance card.
- Annual inspection.
- Cab card / IRP.
- HVUT Schedule 1.

Documents flagged for internal use only (not driver-visible):

- Lease agreements.
- Sale contracts.
- Internal maintenance records.

If a driver tells you "I need to show my registration but it's not on my phone," check Trucks → that truck → Documents. The doc may exist but not be flagged driver-visible. Ask Super Admin to toggle it.

## Searching the Trucks page

The search bar at the top of the Trucks page accepts:

- **Unit number** (TRK-101).
- **VIN** (or partial VIN).
- **License plate.**
- **Driver name** (current assignment).
- **Make** (Freightliner, Kenworth, etc.).

Most of the time you'll search by unit number or driver name.

## Trailers vs. Trucks

The Trailers page is structurally similar. Each trailer card shows:

- Trailer ID.
- Type (van, reefer, flatbed).
- Status.
- Length.
- Owner.

Trailers may or may not be assigned to specific drivers — depends on your company's structure. Some carriers have dedicated trailer pools; others trade trailers between drivers as needed.

## When trucks need maintenance

If a driver reports an issue:

1. **Note the issue** in the truck record (via notes field if available, otherwise log to messages).
2. **If maintenance is scheduled**, change the truck's status to **Maintenance** so it's not assigned new loads. (This is a Super Admin action; you may need to ask.)
3. **Coordinate the repair shop** with the driver.
4. **Move the driver to a backup truck** if available.

LogisX doesn't have a full-fledged maintenance tracking system. Most fleets use a separate tool for that. The LogisX status is just enough to know "this truck shouldn't get a new load right now."

## Fleet health KPIs

The dashboard's KPI cards may show fleet-related metrics:

- **Trucks on the road** — how many are actively running a load.
- **Trucks available** — how many are idle and could take a load.
- **Trucks in maintenance** — how many are unavailable.

These numbers update in real time. A high "available" count midday is a problem — you have capacity sitting idle.

## When the fleet view doesn't match reality

A few things can cause discrepancies:

- **A truck was sold but not removed from the system.** It still shows up on the Fleet tab. Ask Super Admin to remove.
- **A driver was reassigned but the truck's assigned_driver field wasn't updated.** Same fix.
- **A truck is shown as Active but the driver has no current load.** Status updates can get out of sync. Refresh; if it persists, the load may have been cancelled without the truck status being updated. Investigate.

## Pro tips

- **Use Fleet first thing in the morning.** Confirm everyone's where you expect.
- **Check Available trucks before opening Job Board.** If you have no available trucks, the job board work is academic.
- **Verify documents before each load.** If a truck has an expired registration, you've got a problem — and a load you can't run on that truck.
- **Note quirks per truck.** Some trucks have specific equipment quirks (low fifth wheel, weight distribution, etc.) that matter when matching to loads. The system doesn't track that; your memory does.
