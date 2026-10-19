// Which leg a load's route map asks for (B11, the user's decision 2026-10-16).
//
// A truck pin whose fix is more than 2 hours old (lib/fixAge.js
// fixHidesFigures()) shows where the truck WAS. The map then draws the planned
// pickup -> drop-off route, never a route from that pin: a line from an old
// position reads as the truck's live trajectory, and routing it is a paid
// Google Routes call for figures the map already hides. The pin itself stays,
// with its "Last seen" age.
//
//   pin        { lat, lng } or null: the truck's position on the map
//   pinTooOld  true when that position's fix is over 2 hours old
//   origin     { lat, lng } or null: the load's pickup
//   dest       { lat, lng } or null: the load's drop-off
//   pickedUp   true once the freight is aboard
//
// A live pin: from the pin to the pickup before the freight is collected (to
// the drop-off when the load has no pickup coordinate), else to the drop-off.
// No pin, or a pin too old: the planned pickup -> drop-off route.
// Returns { from, to, fromPin }; `from` or `to` is null when the load lacks
// that coordinate.

// May the map route from this pin and anchor its line to it?
export function pinIsLive(pin, pinTooOld) {
  return !!pin && !pinTooOld
}

export function routeLegFor({ pin = null, pinTooOld = false, origin = null, dest = null, pickedUp = false } = {}) {
  if (pinIsLive(pin, pinTooOld)) {
    return { from: pin, to: pickedUp ? dest : (origin || dest), fromPin: true }
  }
  return { from: origin, to: dest, fromPin: false }
}
