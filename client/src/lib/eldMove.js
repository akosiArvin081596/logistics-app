// Move device (ELD_MOVE_DEVICE_ENABLED) in the Trucks page's Link dialog: the second group, the devices that sit on
// another truck, and the dialog's words around a move. The server decides whether the dialog offers it (moveDevice on
// GET /api/routemate/vehicles/unlinked?truckId=N) and judges every move; nothing here re-derives a rule.
// scripts/test-trucks-store.mjs §4 runs this file.

// The name a device goes by in the picker: its vehicle number, else its id.
export function deviceLabel(rv) {
  return String(rv?.vehicle_id ?? '').trim() || String(rv?.routemate_vehicle_id ?? '')
}

// The devices on another truck, from GET /api/routemate/vehicles: [{ id, label, unit, truckId }], by truck unit.
export function devicesOnOtherTrucks(vehicles, truckId) {
  const here = Number(truckId)
  return (Array.isArray(vehicles) ? vehicles : [])
    .filter((v) => v && v.routemate_vehicle_id && v.linked_truck_id != null && v.linked_truck_id !== '' && Number(v.linked_truck_id) !== here)
    .map((v) => ({
      id: String(v.routemate_vehicle_id),
      label: deviceLabel(v),
      unit: String(v.linked_truck_unit ?? '').trim() || `truck #${v.linked_truck_id}`,
      truckId: Number(v.linked_truck_id),
    }))
    .sort((a, b) => a.unit.localeCompare(b.unit, 'en', { numeric: true }) || a.label.localeCompare(b.label, 'en', { numeric: true }))
}

// The dialog's choices: the free devices as always (?truckId lets the server suggest one by unit number), and with
// Move device offered, the devices on other trucks too. That second read failing leaves the free ones on screen.
export async function loadLinkChoices(api, truck) {
  const r = await api.get(`/api/routemate/vehicles/unlinked?truckId=${encodeURIComponent(truck.id)}`)
  const out = { vehicles: r.vehicles || [], suggested: r.suggested || null, move: r.moveDevice === true, others: [], othersError: '' }
  if (!out.move) return out
  try {
    const all = await api.get('/api/routemate/vehicles')
    out.others = devicesOnOtherTrucks(all.vehicles, truck.id)
  } catch (err) {
    out.othersError = err?.message || "Couldn't load the devices on other trucks."
  }
  return out
}

// The move's request: the device, and the truck the dialog showed it on, so the server takes it off that truck or
// refuses (it may have moved since the list was loaded).
export function moveRequestBody(pick) {
  return { routemateVehicleId: pick.id, fromTruckId: pick.truckId }
}

// With Move device offered and no free device, the free group says where to look instead.
export const MOVE_FREE_EMPTY = 'No free devices. Pick one under On another truck to move it here.'

// The confirm, in the dialog, before a move is sent.
export function moveConfirmWords({ device, from, to }) {
  return {
    title: `Move ${device} from ${from} to ${to}?`,
    body: `From now on ${device} counts for ${to}. ${from} will have no ELD device until you link one. Earlier days stay as they were.`,
  }
}

// A refused move as the dialog shows it, in the server's words: { lead, first, rest }: the lead in bold, the rest of
// the first paragraph after it, then each further paragraph (the data-fix line).
export function moveRefusalView(err) {
  const d = err?.data || {}
  const paragraphs = Array.isArray(d.paragraphs) && d.paragraphs.length ? d.paragraphs.map(String) : [String(err?.message || 'The move was refused.')]
  const lead = typeof d.lead === 'string' && d.lead && paragraphs[0].startsWith(d.lead) ? d.lead : ''
  return { lead, first: lead ? paragraphs[0].slice(lead.length) : paragraphs[0], rest: paragraphs.slice(1) }
}
