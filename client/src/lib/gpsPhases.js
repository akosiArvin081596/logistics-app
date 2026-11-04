// The driver stepper's GPS phases (DRIVER_STEPPER_GPS_PHASES_ENABLED on the server).
// The server decides, per load, whether the geofence can mark a stop's phases right
// now (`_gpsPhases` { pickup, drop }, lib/gps-phases.js); this file only words it.
// The geofence writes three steps: arriving at the shipper and leaving it (the
// pickup point), and arriving at the receiver (the drop-off point). Heading to
// Shipper, Loading and Delivered keep their buttons.

// No prototype, so a status name can only ever find one of these three.
export const GPS_STEPS = Object.freeze(Object.assign(Object.create(null), {
  'At Shipper': Object.freeze({ stop: 'pickup', line: 'GPS marks this when you get there.' }),
  'In Transit': Object.freeze({ stop: 'pickup', line: 'GPS marks this when you leave the shipper.' }),
  'At Receiver': Object.freeze({ stop: 'drop', line: 'GPS marks this when you get there.' }),
}))

export const MARK_IT_MYSELF = 'Mark it myself'

// The line to show instead of the next step's button, or null for today's button.
// Only an answer of exactly true from the server for that step's stop counts: no
// key (the flag off), false, or any other value keeps the button.
export function gpsStepLine(nextStatus, gpsPhases) {
  const step = GPS_STEPS[nextStatus]
  if (!step || !gpsPhases || typeof gpsPhases !== 'object') return null
  return gpsPhases[step.stop] === true ? step.line : null
}
