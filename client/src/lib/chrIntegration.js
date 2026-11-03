// The words and small rules for the C.H. Robinson page and the load-detail badge.
// Plain module: no imports, no network, no Vue. The server sends codes; this
// turns them into sentences. Times are formatted by the caller's formatter.
// scripts/test-chr-integration-client.mjs pins every code the server can send.

export const CHR_PAGE_PATH = '/admin/integrations/chr'
export const CHR_API = '/api/integrations/chr'

export const CHR_EVENT_WORDS = Object.freeze({
  arrived_pickup: 'Arrived at pickup',
  departed_pickup: 'Departed pickup',
  arrived_delivery: 'Arrived at delivery',
  departed_delivery: 'Departed a delivery stop',
  delivered: 'Delivered',
  location: 'Location',
})

export const CHR_STATUS_WORDS = Object.freeze({
  pending: 'Waiting',
  sending: 'Sending',
  sent: 'Sent',
  failed: 'Failed',
  gave_up: 'Given up',
  outcome_unknown: 'Outcome unknown',
  dry_run: 'Dry run',
  held: 'Held',
  superseded: 'Superseded',
  skipped_off: 'Skipped',
  skipped_not_chr: 'Skipped: not a CHR load now',
  skipped_backwards: 'Skipped: status went back',
  skipped_refresh: 'Skipped: refreshed copy',
})

// Why an update is held, and what a person does about it.
export const CHR_HOLD_WORDS = Object.freeze({
  tap_away_from_stop: 'The truck was away from the stop at the tap. Check it, then post it in Navisphere if it is right.',
  tap_unverified: 'No clean truck position could confirm the tap. Check it, then post it in Navisphere if it is right.',
  stop_not_mapped: 'This stop has no mapped point. Post it in Navisphere if it is right.',
  multi_stop: 'A multi-stop load: LogisX sends only single-stop loads for now. Post it in Navisphere.',
  load_hold: 'The load is on hold here. Release it to send its updates through the checks again.',
  person: 'This update needs a person. Post it in Navisphere if it is right.',
  stop_skipped: 'A stop was skipped in the statuses. Check it, then post it in Navisphere if it is right.',
})

export const CHR_SKIP_WORDS = Object.freeze({
  load_missing: 'The load is not in Job Tracking.',
  email_blank: 'The load\'s Email cell is blank.',
  load_id_not_9_digits: 'The Load ID is not 9 digits.',
  other_broker: 'The load belongs to another broker now.',
  withheld: 'The Load ID holds a protected number.',
  reverted: 'The status went back after it.',
  baseline: 'It came before recording started.',
  mode_off: 'Recording was turned off.',
  live_dropped: 'Live was switched off before it was sent.',
  arrival_off: '"Arrived at pickup" updates are off.',
  refresh: 'This is a refreshed copy of the data.',
})

export const CHR_VERIFY_WORDS = Object.freeze({
  waiting: 'Checking the truck\'s position',
  confirmed: 'Confirmed by the truck\'s position',
  away: 'Truck away from the stop',
  unverified: 'No clean truck position',
  not_mapped: 'Stop not mapped',
  'n/a': '',
})

// Fixed LogisX sentences for each result code; CHR's own text is never shown.
export const CHR_RESULT_SENTENCES = Object.freeze({
  SENT: 'C.H. Robinson took the update.',
  DUPLICATE: 'C.H. Robinson already had this update.',
  AUTH_FAILED: 'C.H. Robinson refused LogisX\'s credentials. Sending is paused.',
  RATE_LIMITED: 'C.H. Robinson asked LogisX to slow down. It will try again.',
  CHR_UNAVAILABLE: 'C.H. Robinson was unavailable. It will try again.',
  TIMEOUT: 'C.H. Robinson did not answer in time. It will try again.',
  NETWORK: 'The connection to C.H. Robinson failed. It will try again.',
  REDIRECT_REFUSED: 'C.H. Robinson\'s address answered with a redirect, which LogisX never follows.',
  TOO_LARGE: 'C.H. Robinson\'s answer was too large to read.',
  REJECTED: 'C.H. Robinson refused this update. Post it in Navisphere.',
  BAD_RESPONSE: 'C.H. Robinson\'s answer could not be read.',
})

// Why Live can't be chosen (the server's reason codes).
export const CHR_LIVE_REASONS = Object.freeze({
  not_listed: 'Only an account on the listed-accounts setting may choose Live.',
  send_off: 'Sending to C.H. Robinson is switched off on the server.',
  not_connected: 'LogisX has no C.H. Robinson connection yet.',
})

export const CHR_MODE_LABELS = Object.freeze({ off: 'Off', dry_run: 'Dry run', live: 'Live' })

// The badge and the page are Super Admin only; the server is the real gate.
export function showChrBadge(role) {
  return role === 'Super Admin'
}

// A load's summary is asked for only while the feature is on, so opening a
// load costs no request while it is off.
export function shouldAskLoadSummary(status) {
  return Boolean(status) && status.enabled === true
}

// The chip for one kind ('milestones' or 'location'): { label, tone }.
export function kindChip(status, kind) {
  if (!status || status.enabled !== true) return { label: 'Off: server setting', tone: 'muted' }
  if (kind === 'location' && status.locationEnabled !== true) return { label: 'Off: server setting', tone: 'muted' }
  const mode = kind === 'location' ? status.location : status.milestones
  if (mode === 'live') return { label: 'Live', tone: 'live' }
  if (mode === 'dry_run') return { label: 'Dry run', tone: 'dry' }
  return { label: 'Off', tone: 'muted' }
}

// The load-detail badge from a load's counts by status (and its hold), or null
// for no badge. Trouble first, then what was sent, then the dry run.
export function badgeFor(summary) {
  if (!summary || !summary.counts) return null
  const c = summary.counts
  const n = (k) => (Number.isInteger(c[k]) ? c[k] : 0)
  const failed = n('failed') + n('gave_up') + n('outcome_unknown')
  if (failed) return { text: `CHR: ${failed} failed`, tone: 'bad' }
  if ((summary.load && summary.load.hold) || n('held')) return { text: 'CHR: held', tone: 'warn' }
  if (n('sent')) return { text: `CHR: ${n('sent')} sent`, tone: 'live' }
  if (n('dry_run')) return { text: `CHR: dry run (${n('dry_run')})`, tone: 'dry' }
  if (n('pending') || n('sending')) return { text: 'CHR: waiting', tone: 'muted' }
  return null
}

// One send-log row's status line. `fmt` formats an ISO instant.
export function rowStatusText(row, fmt = (v) => v) {
  if (!row) return ''
  const status = row.status
  if (status === 'dry_run') return `Dry run: would have been sent at ${fmt(row.sentAt)}`
  if (status === 'sent') return `Sent at ${fmt(row.sentAt)}${row.reverted ? '. Sent, then the status went back: check it in Navisphere.' : ''}`
  if (status === 'held') return `Held: ${CHR_HOLD_WORDS[row.holdReason] || 'needs a person.'}`
  if (status && status.startsWith('skipped_')) return `${CHR_STATUS_WORDS[status] || 'Skipped'}. ${CHR_SKIP_WORDS[row.skipReason] || ''}`.trim()
  if (row.resultCode && CHR_RESULT_SENTENCES[row.resultCode]) return `${CHR_STATUS_WORDS[status] || status}: ${CHR_RESULT_SENTENCES[row.resultCode]}`
  return CHR_STATUS_WORDS[status] || String(status || '')
}

export function stopText(row) {
  if (!row || !row.stop) return ''
  if (row.stop.kind === 'pickup') return `Pickup ${row.stop.index}`
  if (row.event === 'delivered') return 'Final delivery'
  return row.stop.kind === 'delivery' ? `Delivery ${row.stop.index}` : ''
}

// Each milestone once, in trip order, with its newest row's status; a row
// voided by a status that went back is left out.
const LADDER = ['arrived_pickup', 'departed_pickup', 'arrived_delivery', 'delivered']
export function ladderOf(events) {
  const latest = new Map()
  for (const e of Array.isArray(events) ? events : []) {
    if (!e || e.status === 'skipped_backwards' || !LADDER.includes(e.event)) continue
    const prev = latest.get(e.event)
    if (!prev || e.id > prev.id) latest.set(e.event, e)
  }
  return LADDER.map((event) => ({ event, label: CHR_EVENT_WORDS[event], row: latest.get(event) || null }))
}

export function pageLinkForLoad(loadId) {
  return `${CHR_PAGE_PATH}?load=${encodeURIComponent(String(loadId || ''))}`
}

export function loadSummaryUrl(loadId) {
  return `${CHR_API}/loads/${encodeURIComponent(String(loadId || ''))}`
}

// The send log's query string from the page's filters.
export function eventsQuery({ status = '', loadId = '', before = null } = {}) {
  const q = new URLSearchParams()
  if (status) q.set('status', status)
  if (loadId) q.set('loadId', String(loadId).trim())
  if (before) q.set('before', String(before))
  const s = q.toString()
  return `${CHR_API}/events${s ? `?${s}` : ''}`
}
