// Is this page sending something? useApi counts every write here, so a sign-out the app starts by
// itself can wait for a status tap, a POD upload or an expense still on the wire, whichever screen
// the driver has moved to since. The quiet time covers useUpload's pauses between tries, when
// nothing is on the wire but the upload isn't over.

export const WRITE_QUIET_MS = 5000

let onTheWire = 0
let lastEndedAt = -Infinity

// Call when a write starts; call what it returns once, when the write ends.
export function writeStarted() {
  onTheWire += 1
  let ended = false
  return () => {
    if (ended) return
    ended = true
    onTheWire -= 1
    lastEndedAt = Date.now()
  }
}

export function writesBusy(nowMs = Date.now()) {
  return onTheWire > 0 || nowMs - lastEndedAt < WRITE_QUIET_MS
}
