#!/usr/bin/env node
// Voice notes in Messages, the client (plan 2026-10-22, PR 2; flag
// MESSAGE_VOICE_NOTES_ENABLED). Anyone in a conversation records a voice note;
// the others play it, from the dashboard, the driver app and the investor portal.
//
//   §1 the words: client/src/lib/voiceNoteText.js says exactly what the server's
//      lib/voice-note-text.js says ("Voice note (0:42)", m:ss rounded down), for
//      every length, the title and the two fixed texts. The client cannot load
//      the server's copy: this is the one parity check between the two
//   §2 which rows play (Revision 2, M3): isServerVoiceNote() is true only for a
//      row the server measured (voice_duration_ms > 0) with a real id, and the
//      player's source is /api/messages/<id>/voice, never attachment_url
//   §3 the recorder's format: AAC in MP4 or nothing (no WebM, no guess)
//   §4 driver safety: the client's record gate decides exactly as the server's
//      lib/voice-note-gate.js for every case (moving, stopped under 2 minutes,
//      parked, stale, unknown, a clock running ahead), the note under the
//      composer for each state, and how a fix from GET /api/driver/position or
//      the live feed becomes the gate's input
//   §5 the conversation list's last-message line per kind
//   §6 the upload: one request, a raw audio/mp4 body, the recipient and load in
//      percent-encoded headers (never the URL), one Idempotency-Key reused by
//      every retry, a 90 s timeout per try, retried only when it may not have
//      arrived, and an error the composer can show while it keeps the clip
//   §7 the recorder composable (a fake browser): records AAC/MP4 only, stops the
//      microphone on stop and discard, keeps the clip when the tab hides or the
//      3:00 cap is reached, and refuses a browser without AAC
//   §8 the components, MOUNTED in memory: the player (named, seekable, one
//      source, loaded on play), the recorder (a natively disabled mic while the
//      truck moves, Send waits, a failed send keeps the clip), the dashboard
//      bubble, the driver thread and the investor thread
//   §9 the live copies: stores/messages.js and stores/driver.js keep the
//      server's voice_duration_ms on a message that arrives live, and the driver
//      app's bell says "New voice note from ..."
//
// No DOM, no server, no network. Vue comes from client/node_modules; the
// sources from LOGISX_ROOT (default: this checkout).
//   node scripts/test-voice-note-text.mjs
//   LOGISX_ROOT=/path/to/base node scripts/test-voice-note-text.mjs   # a base checkout: fails
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { fileURLToPath, pathToFileURL } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const HERE = path.join(__dirname, '..')
const ROOT = process.env.LOGISX_ROOT || HERE
const CLIENT_DIR = path.join(HERE, 'client')
const exists = (...p) => fs.existsSync(path.join(ROOT, ...p))
const read = (...p) => (exists(...p) ? fs.readFileSync(path.join(ROOT, ...p), 'utf8') : '')
const requireRoot = createRequire(path.join(ROOT, 'package.json'))

let pass = 0
const failures = []
function ok(name, cond) {
  if (cond) { pass++; return }
  failures.push(name)
  console.log(`  FAIL  ${name}`)
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

async function importClient(...rel) {
  if (!exists('client', 'src', ...rel)) { ok(`client/src/${rel.join('/')} exists`, false); return null }
  try { return await import(pathToFileURL(path.join(ROOT, 'client', 'src', ...rel)).href) } catch (err) {
    ok(`client/src/${rel.join('/')} loads (${err.message})`, false)
    return null
  }
}

const serverText = requireRoot('./lib/voice-note-text.js')
const serverGate = requireRoot('./lib/voice-note-gate.js')
const text = await importClient('lib', 'voiceNoteText.js')
const gate = await importClient('lib', 'voiceNoteGate.js')
const vn = await importClient('lib', 'voiceNotes.js')
const upload = await importClient('lib', 'voiceNoteUpload.js')

// ══ §1 the words ══════════════════════════════════════════════════════════════
if (text) {
  const lengths = [0, -5, NaN, Infinity, -Infinity, null, undefined, '42000', 1, 499, 500, 999, 1000, 3160, 9999, 42000, 42999,
    59999, 60000, 61000, 119999, 179999, 180000, 180499, 180500, 600000, 3599999, 3600000]
  const diff = []
  for (const ms of lengths) {
    for (const fn of ['voiceNoteClock', 'voiceNoteLabel', 'voiceNoteExpiredLabel']) {
      const a = typeof text[fn] === 'function' ? text[fn](ms) : undefined
      const b = serverText[fn](ms)
      if (a !== b) diff.push(`${fn}(${String(ms)}) client ${JSON.stringify(a)} server ${JSON.stringify(b)}`)
    }
  }
  if (diff.length) console.log(`        ${diff.slice(0, 6).join('\n        ')}`)
  ok('§1 every length reads the same on both sides (clock, label, expired label)', diff.length === 0)
  ok('§1 the label is m:ss, rounded down', typeof text.voiceNoteLabel === 'function' && text.voiceNoteLabel(42999) === 'Voice note (0:42)' && text.voiceNoteLabel(180000) === 'Voice note (3:00)' && text.voiceNoteLabel(3160) === 'Voice note (0:03)')
  ok('§1 the notification title is the server\'s', typeof text.voiceNoteTitle === 'function' && ['Dispatch', 'Pat Example', 'admin', ''].every((f) => text.voiceNoteTitle(f) === serverText.voiceNoteTitle(f)))
  ok('§1 "unavailable" and "removed" are the server\'s, word for word', text.VOICE_NOTE_UNAVAILABLE === serverText.VOICE_NOTE_UNAVAILABLE && text.VOICE_NOTE_REMOVED === serverText.VOICE_NOTE_REMOVED)
}

// ══ §2 which rows play (M3) ═══════════════════════════════════════════════════
if (vn) {
  const { isServerVoiceNote, voiceNoteSrc } = vn
  const server = { id: 41, from: 'Dispatch', to: 'Pat Example', message: 'Voice note (0:42)', attachment_url: '', attachment_type: 'voice', voice_duration_ms: 42000 }
  ok('§2 a server-shaped voice row plays', isServerVoiceNote(server) === true)
  ok('§2 ...from /api/messages/<id>/voice', voiceNoteSrc(server) === '/api/messages/41/voice')
  ok('§2 a row typed voice with no voice_duration_ms does not', isServerVoiceNote({ ...server, voice_duration_ms: undefined }) === false)
  ok('§2 voice_duration_ms 0 (a reader who may not play it, or a removed file) does not', isServerVoiceNote({ ...server, voice_duration_ms: 0 }) === false)
  ok('§2 an attachment_url with id 0 (an unsaved row) does not', isServerVoiceNote({ ...server, id: 0, attachment_url: '/api/messages/41/voice' }) === false)
  ok('§2 a negative, missing or non-number id does not', [-1, undefined, null, 'x', 1.5].every((id) => isServerVoiceNote({ ...server, id }) === false))
  ok('§2 a negative or non-number duration does not', [-1, 'abc', NaN, null].every((d) => isServerVoiceNote({ ...server, voice_duration_ms: d }) === false))
  ok('§2 nothing, or a text row, does not', isServerVoiceNote(null) === false && isServerVoiceNote({ id: 3, message: 'hi', attachment_type: '', voice_duration_ms: 0 }) === false)
  ok('§2 the source never comes from attachment_url', voiceNoteSrc({ ...server, attachment_url: 'https://elsewhere.example/a.m4a' }) === '/api/messages/41/voice'
    && voiceNoteSrc({ ...server, voice_duration_ms: 0, attachment_url: '/uploads/chat/a.m4a' }) === '')
}

// ══ §3 the recorder's format ══════════════════════════════════════════════════
if (vn) {
  const { pickRecorderMime, voiceRecordingSupport } = vn
  ok('§3 AAC in MP4 first', pickRecorderMime((t) => t === 'audio/mp4;codecs=mp4a.40.2' || t === 'audio/mp4' || t === 'audio/webm') === 'audio/mp4;codecs=mp4a.40.2')
  ok('§3 plain audio/mp4 when the codec string is not listed', pickRecorderMime((t) => t === 'audio/mp4') === 'audio/mp4')
  ok('§3 a WebM-only browser (Firefox) gets none', pickRecorderMime((t) => t.startsWith('audio/webm') || t.startsWith('audio/ogg')) === null)
  ok('§3 no isTypeSupported, or one that throws: none', pickRecorderMime(undefined) === null && pickRecorderMime(() => { throw new Error('x') }) === null)
  const env = (over = {}) => ({
    isSecureContext: true,
    MediaRecorder: Object.assign(function MediaRecorder() {}, { isTypeSupported: (t) => t === 'audio/mp4;codecs=mp4a.40.2' }),
    navigator: { mediaDevices: { getUserMedia: async () => ({}) } },
    ...over,
  })
  ok('§3 a browser that records AAC/MP4 is supported', same(voiceRecordingSupport(env()), { supported: true, mimeType: 'audio/mp4;codecs=mp4a.40.2' }))
  ok('§3 no MediaRecorder, no microphone API, or not a secure page: not supported',
    !voiceRecordingSupport(env({ MediaRecorder: undefined })).supported
    && !voiceRecordingSupport(env({ navigator: {} })).supported
    && !voiceRecordingSupport(env({ isSecureContext: false })).supported
    && !voiceRecordingSupport(null).supported)
  ok('§3 a WebM-only recorder: not supported', !voiceRecordingSupport(env({ MediaRecorder: Object.assign(function M() {}, { isTypeSupported: (t) => t.startsWith('audio/webm') }) })).supported)
  ok('§3 the unsupported note names the browsers that record', vn.VOICE_NOTE_UNSUPPORTED === 'Voice notes record in Chrome, Edge or Safari.')
  ok('§3 the limits: 3:00 cap, 4 MB', vn.VOICE_NOTE_MAX_MS === 180000 && vn.VOICE_NOTE_MAX_BYTES === 4 * 1024 * 1024)
}

// ══ §4 driver safety ══════════════════════════════════════════════════════════
if (gate) {
  const NOW = Date.parse('2026-10-22T15:00:00Z')
  const MIN = 60 * 1000
  const fix = (speed, ageMs) => ({ speed, location_date_ms: NOW - ageMs })
  // [case, input, expected { allowed, state }]
  const table = [
    ['no fix (no truck, no ELD, never a fix)', { fix: null, stoppedSince: null }, { allowed: true, state: 'unknown' }],
    ['a fix older than 3 minutes (engine off, dead zone)', { fix: fix(25, 3 * MIN + 1), stoppedSince: null }, { allowed: true, state: 'unknown' }],
    ['a fix stamped 5 minutes ahead (a skewed clock)', { fix: fix(25, -5 * MIN), stoppedSince: null }, { allowed: true, state: 'unknown' }],
    ['a fresh fix with no speed', { fix: fix(NaN, 10000), stoppedSince: null }, { allowed: true, state: 'unknown' }],
    ['a fresh fix at 25 m/s (moving)', { fix: fix(25, 10000), stoppedSince: null }, { allowed: false, state: 'moving' }],
    ['a fresh fix just above 5 mph', { fix: fix(2.236, 10000), stoppedSince: null }, { allowed: false, state: 'moving' }],
    ['a fresh fix at exactly 5 mph (not moving)', { fix: fix(2.235, 10000), stoppedSince: NOW - 10 * MIN }, { allowed: true, state: 'parked' }],
    ['stopped 30 s (a light, traffic)', { fix: fix(0, 5000), stoppedSince: NOW - 30000 }, { allowed: false, state: 'stopping' }],
    ['stopped 1:59', { fix: fix(0, 5000), stoppedSince: NOW - 119999 }, { allowed: false, state: 'stopping' }],
    ['stopped with no known start', { fix: fix(0, 5000), stoppedSince: null }, { allowed: false, state: 'stopping' }],
    ['stopped exactly 2 minutes', { fix: fix(0, 5000), stoppedSince: NOW - 2 * MIN }, { allowed: true, state: 'parked' }],
    ['stopped 20 minutes (parked)', { fix: fix(0, 5000), stoppedSince: NOW - 20 * MIN }, { allowed: true, state: 'parked' }],
  ]
  for (const [name, input, expected] of table) {
    const client = typeof gate.recordGate === 'function' ? gate.recordGate({ ...input, nowMs: NOW }) : null
    const srv = serverGate.recordGate({ ...input, nowMs: NOW })
    ok(`§4 ${name}: ${JSON.stringify(expected)}`, same(client, expected) && same(srv, expected))
  }
  // The same decision for a sweep of speeds, ages and stops.
  let mismatches = 0
  for (const speed of [NaN, 0, 1, 2.235, 2.236, 30]) {
    for (const age of [-3 * MIN, -MIN, 0, MIN, 3 * MIN, 3 * MIN + 1, 10 * MIN]) {
      for (const stopped of [null, NOW, NOW - MIN, NOW - 2 * MIN, NOW - 30 * MIN, NaN]) {
        const input = { fix: fix(speed, age), stoppedSince: stopped, nowMs: NOW }
        if (!same(gate.recordGate?.(input), serverGate.recordGate(input))) mismatches++
      }
    }
  }
  ok('§4 252 combinations of speed, fix age and stop: the client decides as the server', mismatches === 0)
  ok('§4 the thresholds are the server\'s', gate.MOVING_MPS === serverGate.MOVING_MPS && gate.FRESH_MS === serverGate.FRESH_MS && gate.STOPPED_MIN_MS === serverGate.STOPPED_MIN_MS && gate.FUTURE_SKEW_MS === serverGate.FUTURE_SKEW_MS)
  const note = gate.voiceGateNote
  ok('§4 the note while moving or just stopped', typeof note === 'function' && note({ allowed: false, state: 'moving' }) === 'Voice notes are off while the truck is moving. Park first, then record.' && note({ allowed: false, state: 'stopping' }) === note({ allowed: false, state: 'moving' }))
  ok('§4 the note when parked or unknown (always shown)', typeof note === 'function' && note({ allowed: true, state: 'parked' }) === 'Record only when parked.' && note({ allowed: true, state: 'unknown' }) === 'Record only when parked.' && note(null) === 'Record only when parked.')

  // A fix as the driver app holds it -> the gate's input, in this phone's clock.
  const { eldMotion } = gate
  if (typeof eldMotion === 'function') {
    // GET /api/driver/position: the server's clock is 7 minutes behind the phone's.
    const skew = 7 * MIN
    const serverFixMs = NOW - skew - 20000
    const polled = eldMotion({ speed: 0, timestamp: new Date(serverFixMs).toISOString(), lastPingAge: 20000, stoppedSinceMs: serverFixMs - 5 * MIN }, null, NOW)
    ok('§4 a polled fix is dated by its age (the phone\'s clock never compared with the server\'s)', !!polled && polled.fix.location_date_ms === NOW - 20000)
    ok('§4 ...and its stoppedSinceMs is moved by the same skew', !!polled && polled.stoppedSince === NOW - 20000 - 5 * MIN)
    ok('§4 ...so a truck parked 5 minutes is parked', !!polled && same(gate.recordGate({ ...polled, nowMs: NOW }), { allowed: true, state: 'parked' }))
    const moving = eldMotion({ speed: 20, timestamp: new Date(NOW - 4000).toISOString(), source: 'routemate' }, polled, NOW)
    ok('§4 a live fix (no stoppedSinceMs) above 5 mph: moving', !!moving && moving.stoppedSince === null && gate.recordGate({ ...moving, nowMs: NOW }).state === 'moving')
    const firstStop = eldMotion({ speed: 0, timestamp: new Date(NOW - 1000).toISOString() }, moving, NOW)
    ok('§4 the first stopped live fix after moving: stopped since that fix (waits 2 minutes)', !!firstStop && firstStop.stoppedSince === NOW - 1000 && gate.recordGate({ ...firstStop, nowMs: NOW }).state === 'stopping')
    const stillStopped = eldMotion({ speed: 0, timestamp: new Date(NOW + 2 * MIN).toISOString() }, firstStop, NOW + 2 * MIN)
    ok('§4 a later stopped live fix keeps the earlier stop', !!stillStopped && stillStopped.stoppedSince === NOW - 1000 && gate.recordGate({ ...stillStopped, nowMs: NOW + 2 * MIN }).state === 'parked')
    ok('§4 no fix: no motion (unknown, allowed)', eldMotion(null, polled, NOW) === null && same(gate.recordGate({ fix: null, stoppedSince: null, nowMs: NOW }), { allowed: true, state: 'unknown' }))
    ok('§4 a phone GPS fix is never the basis', eldMotion({ speed: 30, timestamp: new Date(NOW).toISOString(), source: 'phone' }, polled, NOW) === polled)
  } else ok('§4 voiceNoteGate.js exports eldMotion()', false)
}

// ══ §5 the conversation list's last-message line ══════════════════════════════
if (vn) {
  const p = vn.conversationPreview
  const c = (o) => ({ driver: 'Pat Example', loadId: '', lastTimestamp: '2026-10-22T15:00:00Z', unread: 0, ...o })
  ok('§5 a text message: its text', typeof p === 'function' && p(c({ lastKind: 'text', lastText: 'At the gate now' })) === 'At the gate now')
  ok('§5 a photo: "Photo"', typeof p === 'function' && p(c({ lastKind: 'photo', lastText: 'see this' })) === 'Photo')
  ok('§5 a file: "File"', typeof p === 'function' && p(c({ lastKind: 'file', lastText: '' })) === 'File')
  ok('§5 a voice note: "Voice note (0:42)" from the server\'s length', typeof p === 'function' && p(c({ lastKind: 'voice', lastText: 'Voice note (0:42)', lastVoiceMs: 42500 })) === 'Voice note (0:42)')
  ok('§5 a voice note whose audio is gone: the stored text', typeof p === 'function' && p(c({ lastKind: 'voice', lastText: 'Voice note removed by an administrator', lastVoiceMs: 0 })) === 'Voice note removed by an administrator')
  ok('§5 a server without the preview (no lastKind): no line', typeof p === 'function' && p(c({})) === '' && p(null) === '')
  // The server cuts lastText at 60 characters; the client shows it as sent, so
  // a trailing emoji is never split in two.
  ok('§5 the text is shown as the server sent it (a trailing emoji whole)', typeof p === 'function' && p(c({ lastKind: 'text', lastText: `${'x'.repeat(59)}👍` })) === `${'x'.repeat(59)}👍`)
}

// ══ §6 the upload ═════════════════════════════════════════════════════════════
if (upload && vn) {
  const { uploadVoiceNote } = upload
  const blob = { size: 9600, type: 'audio/mp4', fake: 'the recording' }
  const err = (status, code, message = 'refused') => Object.assign(new Error(message), { status, code })
  const run = async (answers, over = {}) => {
    const calls = []
    const request = async (url, opts) => {
      calls.push({ url, opts })
      const a = answers[Math.min(calls.length - 1, answers.length - 1)]
      if (a instanceof Error) throw a
      return a
    }
    let result = null
    let thrown = null
    try {
      result = await uploadVoiceNote(request, { blob, to: 'Pat Example', loadId: 'QA-VOICE-1', key: 'vn-0123456789abcdef', durationMs: 4200, sleep: async () => {}, ...over })
    } catch (e) { thrown = e }
    return { calls, result, thrown }
  }
  const one = await run([{ success: true, id: 77, durationMs: 4160 }])
  const o = one.calls[0]?.opts || {}
  ok('§6 one POST to /api/messages/voice, nothing in the URL', one.calls.length === 1 && one.calls[0].url === '/api/messages/voice' && o.method === 'POST')
  ok('§6 the body is the recording itself, typed audio/mp4', o.body === blob && o.headers?.['Content-Type'] === 'audio/mp4')
  ok('§6 the recipient and load ride in percent-encoded headers', o.headers?.['X-Message-To'] === 'Pat%20Example' && o.headers?.['X-Message-Load-Id'] === 'QA-VOICE-1')
  ok('§6 the Idempotency-Key is the clip\'s', o.headers?.['Idempotency-Key'] === 'vn-0123456789abcdef')
  ok('§6 a 90 s timeout', o.timeout === 90000)
  ok('§6 the answer: the id and the server\'s length', same(one.result, { id: 77, durationMs: 4160, duplicate: false }))
  const dup = await run([{ success: true, id: 77, duplicate: true }])
  ok('§6 a retry the server already had: its id, the recorder\'s length until the next read', same(dup.result, { id: 77, durationMs: 4200, duplicate: true }))
  const staff = await run([{ success: true, id: 78, durationMs: 1000 }], { from: 'Dispatch', loadId: '' })
  ok('§6 staff send as Dispatch; no load: no load header', staff.calls[0]?.opts?.headers?.['X-Message-From'] === 'Dispatch' && !('X-Message-Load-Id' in (staff.calls[0]?.opts?.headers || {})))
  const utf = await run([{ success: true, id: 79, durationMs: 1000 }], { to: 'José Ñandú' })
  ok('§6 a name with accents is UTF-8 percent-encoded', utf.calls[0]?.opts?.headers?.['X-Message-To'] === encodeURIComponent('José Ñandú'))
  const flaky = await run([err(0, 'TIMEOUT', 'timed out'), err(503, ''), { success: true, id: 80, durationMs: 2000 }])
  ok('§6 a timeout, then a 503, then sent: three tries, one key', flaky.calls.length === 3 && flaky.result?.id === 80 && new Set(flaky.calls.map((c) => c.opts.headers['Idempotency-Key'])).size === 1)
  const net = await run([new TypeError('Failed to fetch')])
  ok('§6 no network at all: three tries, then the error (the clip is the caller\'s to keep)', net.calls.length === 3 && !!net.thrown)
  for (const [status, code] of [[409, 'VOICE_NOTE_WHILE_MOVING'], [413, 'VOICE_NOTE_TOO_LARGE'], [415, 'UNSUPPORTED_AUDIO_TYPE'], [422, 'VOICE_NOTE_TOO_SHORT'], [429, 'VOICE_NOTE_DAILY_LIMIT'], [404, 'FEATURE_OFF'], [507, 'STORAGE_LOW'], [403, 'VOICE_NOTE_RECIPIENT']]) {
    const r = await run([err(status, code)])
    ok(`§6 ${status} ${code}: one try, no retry`, r.calls.length === 1 && r.thrown?.code === code)
  }
  const cancelled = await run([err(0, 'ABORT', 'Request cancelled.')])
  ok('§6 a cancel is never retried', cancelled.calls.length === 1)
  const msg = vn.voiceSendFailure
  ok('§6 moving: the server\'s words, and the clip is kept', typeof msg === 'function' && msg(err(409, 'VOICE_NOTE_WHILE_MOVING', "Voice notes can't be sent while the truck is moving. Park first; your recording is kept.")) === "Voice notes can't be sent while the truck is moving. Park first; your recording is kept.")
  ok('§6 no connection: say so, and how to retry', typeof msg === 'function' && msg(err(0, 'TIMEOUT', 'The request timed out.')) === 'Not sent. Check your connection, then tap Send to try again.' && msg(new TypeError('Failed to fetch')) === 'Not sent. Check your connection, then tap Send to try again.')
  ok('§6 switched off: plain words', typeof msg === 'function' && msg(err(404, 'FEATURE_OFF', 'Voice notes are not switched on.')) === 'Voice notes are switched off. Send a text message instead.')
  ok('§6 a server error without words: a generic line', typeof msg === 'function' && msg(err(500, '', 'Request failed (500)')) === 'Not sent. Tap Send to try again.')
  ok('§6 a key is made per clip: 8-64 of [A-Za-z0-9_-], never twice', typeof vn.newVoiceNoteKey === 'function' && /^[A-Za-z0-9_-]{8,64}$/.test(vn.newVoiceNoteKey()) && vn.newVoiceNoteKey() !== vn.newVoiceNoteKey())
}

// ══ §7 the recorder composable ════════════════════════════════════════════════
const clientRequire = createRequire(path.join(CLIENT_DIR, 'package.json'))
const Vue = clientRequire('vue')
const { parse, compileScript } = clientRequire('vue/compiler-sfc')
const drain = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)) }

function fakeBrowser({ mime = 'audio/mp4', supports = (t) => t.startsWith('audio/mp4'), denyMic = false } = {}) {
  const state = { tracksStopped: 0, recorders: [], listeners: {}, timers: new Map(), nextTimer: 1, now: 1_000_000, hidden: false, closedContexts: 0 }
  class FakeRecorder {
    constructor(stream, opts) { this.stream = stream; this.opts = opts; this.state = 'inactive'; this.mimeType = mime; state.recorders.push(this) }
    start(slice) { this.state = 'recording'; this.slice = slice }
    stop() {
      if (this.state === 'inactive') return
      this.state = 'inactive'
      this.ondataavailable?.({ data: { size: 9600, type: this.mimeType, part: 'the bytes' } })
      this.onstop?.()
    }
    static isTypeSupported(t) { return supports(t) }
  }
  const env = {
    isSecureContext: true,
    MediaRecorder: FakeRecorder,
    navigator: { mediaDevices: { getUserMedia: async (c) => { state.constraints = c; if (denyMic) throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }); return { getTracks: () => [{ stop: () => { state.tracksStopped++ } }] } } } },
    Blob: class { constructor(parts, opts) { this.parts = parts; this.type = opts?.type || ''; this.size = parts.reduce((n, p) => n + (p.size || 0), 0) } },
    URL: { createObjectURL: () => 'blob:fake/1', revokeObjectURL: (u) => { state.revoked = u } },
    AudioContext: class { constructor() { this.state = 'running' } createMediaStreamSource() { return { connect() {} } } createAnalyser() { return { fftSize: 0, getByteTimeDomainData(a) { a.fill(128) } } } close() { state.closedContexts++; return Promise.resolve() } },
    document: {
      get visibilityState() { return state.hidden ? 'hidden' : 'visible' },
      addEventListener: (t, fn) => { (state.listeners[t] = state.listeners[t] || []).push(fn) },
      removeEventListener: (t, fn) => { state.listeners[t] = (state.listeners[t] || []).filter((f) => f !== fn) },
    },
    setInterval: (fn, ms) => { const id = state.nextTimer++; state.timers.set(id, { fn, ms }); return id },
    clearInterval: (id) => { state.timers.delete(id) },
    now: () => state.now,
  }
  const tick = (ms) => { state.now += ms; for (const t of [...state.timers.values()]) t.fn() }
  return { env, state, tick }
}

const recMod = await importClient('composables', 'useVoiceRecorder.js')
if (recMod) {
  const { useVoiceRecorder } = recMod
  {
    const { env, state, tick } = fakeBrowser()
    const rec = useVoiceRecorder({ env })
    ok('§7 a browser with AAC/MP4 is supported; idle', rec.supported === true && rec.phase.value === 'idle')
    await rec.start()
    ok('§7 start: asks for the microphone (mono, echo cancellation, noise suppression)', state.constraints?.audio?.channelCount === 1 && state.constraints.audio.echoCancellation === true && state.constraints.audio.noiseSuppression === true)
    ok('§7 ...records AAC/MP4 at 48 kbps in 1 s slices', rec.phase.value === 'recording' && state.recorders[0]?.opts?.mimeType === 'audio/mp4;codecs=mp4a.40.2' && state.recorders[0].opts.audioBitsPerSecond === 48000 && state.recorders[0].slice === 1000)
    ok('§7 ...and says so', rec.announcement.value === 'Recording started')
    tick(4200)
    ok('§7 the clock runs', rec.elapsedMs.value === 4200)
    rec.stop()
    await drain()
    ok('§7 stop: a clip for review, typed audio/mp4, with its length and a send key', rec.phase.value === 'review' && rec.clip.value?.blob?.type === 'audio/mp4' && rec.clip.value.durationMs === 4200 && /^[A-Za-z0-9_-]{8,64}$/.test(rec.clip.value.key || ''))
    ok('§7 ...the microphone is released', state.tracksStopped === 1 && state.closedContexts === 1)
    rec.discard()
    ok('§7 discard: back to idle, the preview URL released', rec.phase.value === 'idle' && rec.clip.value === null && state.revoked === 'blob:fake/1')
  }
  {
    const { env, state, tick } = fakeBrowser()
    const rec = useVoiceRecorder({ env })
    await rec.start()
    tick(170000)
    ok('§7 ten seconds before the cap: "10 seconds left"', rec.announcement.value === '10 seconds left')
    tick(10000)
    await drain()
    ok('§7 at 3:00 it stops by itself and keeps the clip', rec.phase.value === 'review' && rec.clip.value?.durationMs === 180000 && state.tracksStopped === 1)
    ok('§7 ...and says so', rec.announcement.value === 'Recording stopped at 3 minutes')
  }
  {
    const { env, state } = fakeBrowser()
    const rec = useVoiceRecorder({ env })
    await rec.start()
    state.now += 3000
    state.hidden = true
    for (const fn of state.listeners.visibilitychange || []) fn()
    await drain()
    ok('§7 the tab hides: the recording stops and the clip is kept', rec.phase.value === 'review' && !!rec.clip.value && state.tracksStopped === 1)
    rec.discard()
  }
  {
    const { env, state } = fakeBrowser()
    const rec = useVoiceRecorder({ env })
    await rec.start()
    state.now += 400
    rec.stop()
    await drain()
    ok('§7 under a second: no clip, and a reason', rec.phase.value === 'idle' && rec.clip.value === null && rec.error.value === 'Too short to send. Hold on a little longer.')
  }
  {
    const { env, state } = fakeBrowser({ mime: 'audio/webm;codecs=opus', supports: () => true })
    const rec = useVoiceRecorder({ env })
    await rec.start()
    state.now += 3000
    rec.stop()
    await drain()
    ok('§7 a recorder that hands back WebM anyway: no clip, and a reason', rec.phase.value === 'idle' && rec.clip.value === null && /can't be sent/.test(rec.error.value))
  }
  {
    const { env } = fakeBrowser({ denyMic: true })
    const rec = useVoiceRecorder({ env })
    await rec.start()
    ok('§7 a blocked microphone: idle, and how to allow it', rec.phase.value === 'idle' && rec.error.value === 'Microphone access is blocked. Allow it for this site in the browser settings, then try again.')
  }
  {
    const { env } = fakeBrowser({ supports: (t) => t.startsWith('audio/webm') })
    const rec = useVoiceRecorder({ env })
    await rec.start()
    ok('§7 a WebM-only browser: not supported, and start does nothing', rec.supported === false && rec.phase.value === 'idle')
  }
}

// ══ §8 the components, mounted ════════════════════════════════════════════════
globalThis.window = { innerWidth: 390, innerHeight: 844, addEventListener() {}, removeEventListener() {} }
globalThis.document = { activeElement: null, addEventListener() {}, removeEventListener() {} }
globalThis.Document = globalThis.Document || class Document {}
globalThis.ShadowRoot = globalThis.ShadowRoot || class ShadowRoot {}

async function compileComponent(rel, { overrides = {}, real = [] } = {}) {
  const file = path.join(ROOT, rel)
  if (!fs.existsSync(file)) throw new Error(`${rel} does not exist`)
  const dir = path.dirname(file)
  const { descriptor } = parse(fs.readFileSync(file, 'utf8'), { filename: path.basename(file) })
  let body = compileScript(descriptor, { id: path.basename(file), inlineTemplate: true, templateOptions: { compilerOptions: { hoistStatic: false } } }).content
  const specs = []
  body = body.replace(/^import\s*\{([^}]*)\}\s*from\s*(['"])([^'"]+)\2;?[ \t]*$/gm, (_, names, q, spec) => {
    specs.push(spec)
    const binds = names.split(',').map((n) => n.trim()).filter(Boolean).map((n) => n.replace(/\s+as\s+/, ': '))
    return `const { ${binds.join(', ')} } = __deps[${JSON.stringify(spec)}];`
  })
  body = body.replace(/^import\s+([A-Za-z_$][\w$]*)\s+from\s*(['"])([^'"]+)\2;?[ \t]*$/gm, (_, name, q, spec) => {
    specs.push(spec)
    return `const ${name} = __deps[${JSON.stringify(spec)}].default;`
  })
  body = body.replace(/^export default\s*/m, 'return ')
  if (/^\s*(import|export)\s/m.test(body)) throw new Error(`${rel}: an import/export this harness cannot map`)
  const deps = { vue: Vue }
  for (const spec of specs) {
    if (spec === 'vue') continue
    if (spec in overrides) deps[spec] = overrides[spec]
    else if (spec.endsWith('.vue')) {
      const childRel = path.relative(ROOT, path.join(dir, spec))
      deps[spec] = real.includes(path.basename(spec))
        ? { default: await compileComponent(childRel, { overrides, real }) }
        : { default: Vue.defineComponent({ name: path.basename(spec, '.vue'), render: () => null }) }
    } else deps[spec] = await import(pathToFileURL(path.join(dir, spec.endsWith('.js') ? spec : `${spec}.js`)).href)
  }
  return new Function('__deps', body)(deps)
}

function mountInMemory(Comp, props) {
  const node = (type, tag) => Vue.markRaw({
    type, tag, children: [], parent: null, props: {}, text: '', value: '', listeners: {},
    addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn) },
    removeEventListener(ev, fn) { this.listeners[ev] = (this.listeners[ev] || []).filter((f) => f !== fn) },
    getRootNode() { return {} },
    focus() { globalThis.document.activeElement = this },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 390, height: 844, right: 390, bottom: 844 }),
    // An <audio> element: records what the player asks of it.
    play() { this.played = (this.played || 0) + 1; return Promise.resolve() },
    pause() { this.paused = (this.paused || 0) + 1 },
    currentTime: 0, playbackRate: 1, scrollTop: 0, scrollHeight: 0,
  })
  const ops = {
    insert(child, parent, anchor) {
      if (child.parent) ops.remove(child)
      const i = anchor ? parent.children.indexOf(anchor) : -1
      if (i >= 0) parent.children.splice(i, 0, child); else parent.children.push(child)
      child.parent = parent
    },
    remove(child) { const p = child.parent; if (!p) return; const i = p.children.indexOf(child); if (i >= 0) p.children.splice(i, 1); child.parent = null },
    createElement: (tag) => node('el', tag),
    createText: (t) => Object.assign(node('text'), { text: t }),
    createComment: (t) => Object.assign(node('comment'), { text: t }),
    setText(n, t) { n.text = t },
    setElementText(el, t) { el.children = []; if (t) ops.insert(Object.assign(node('text'), { text: t }), el) },
    parentNode: (n) => n.parent,
    nextSibling(n) { const p = n.parent; if (!p) return null; return p.children[p.children.indexOf(n) + 1] || null },
    querySelector: () => null,
    setScopeId() {},
    patchProp(el, key, prev, next) { el.props[key] = next },
  }
  const { createApp } = Vue.createRenderer(ops)
  const root = node('el', 'root')
  // Root props are copied once; a wrapper that renders the component from a
  // reactive object lets a test change them (the gate, the flag).
  const state = Vue.isReactive(props) ? props : Vue.reactive({ ...(props || {}) })
  const app = createApp(Vue.defineComponent({ render: () => Vue.h(Comp, { ...state }) }))
  app.mount(root)
  const textOf = (n) => (n.type === 'text' ? n.text : n.type === 'el' ? n.children.map(textOf).join(' ') : '')
  const all = (n, pred, out = []) => { if (n.type === 'el' && pred(n)) out.push(n); for (const c of n.children || []) all(c, pred, out); return out }
  return {
    root,
    findAll: (pred) => all(root, pred),
    find: (pred) => all(root, pred)[0] || null,
    textOf: (n) => (n ? textOf(n).replace(/\s+/g, ' ').trim() : ''),
    unmount: () => app.unmount(),
  }
}
const hasClass = (n, c) => {
  const v = n && n.props && n.props.class
  if (!v) return false
  if (typeof v === 'string') return v.split(/\s+/).includes(c)
  if (Array.isArray(v)) return v.some((x) => (typeof x === 'string' ? x.split(/\s+/).includes(c) : !!(x && x[c])))
  return !!v[c]
}
async function click(el) {
  if (!el) return
  const h = el.props.onClick
  const e = { preventDefault() {}, stopPropagation() {}, target: el, currentTarget: el }
  if (typeof h === 'function') await h(e)
  else if (Array.isArray(h)) for (const f of h) await f(e)
  await drain()
}
const named = (m, re) => m.find((n) => n.tag === 'button' && re.test(String(n.props['aria-label'] || '')))
const isDisabled = (n) => !!n && (n.props.disabled === true || n.props.disabled === '')

// Lucide icons: empty components.
const icons = new Proxy({}, { get: (_, k) => (k === '__esModule' ? false : Vue.defineComponent({ name: String(k), render: () => null })) })

// A recorder the components can drive: its phase and clip are set by the test.
function fakeRecorder() {
  const r = {
    supported: true,
    phase: Vue.ref('idle'),
    elapsedMs: Vue.ref(0),
    levels: Vue.ref([0, 0, 0]),
    clip: Vue.shallowRef(null),
    error: Vue.ref(''),
    announcement: Vue.ref(''),
    calls: [],
    async start() { r.calls.push('start'); r.phase.value = 'recording' },
    stop() { r.calls.push('stop'); r.phase.value = 'review'; r.clip.value = { blob: { size: 9600, type: 'audio/mp4' }, url: 'blob:fake/2', durationMs: 7000, mimeType: 'audio/mp4', key: 'vn-key-0000000001' } },
    discard() { r.calls.push('discard'); r.phase.value = 'idle'; r.clip.value = null },
  }
  return r
}
let currentRecorder = fakeRecorder()
const recorderOverrides = {
  'lucide-vue-next': icons,
  '../../composables/useVoiceRecorder': { useVoiceRecorder: () => currentRecorder },
}

// The player.
const PLAYER_REL = 'client/src/components/shared/VoiceNotePlayer.vue'
{
  let Player = null
  try { Player = await compileComponent(PLAYER_REL, { overrides: { 'lucide-vue-next': icons } }) } catch (err) { ok(`§8 VoiceNotePlayer.vue compiles (${err.message})`, false) }
  if (Player) {
    const m = mountInMemory(Player, { src: '/api/messages/41/voice', durationMs: 42000 })
    await drain()
    const play = named(m, /^Play voice note/)
    ok('§8 player: a real button named with the length ("Play voice note, 42 seconds"), aria-pressed false', !!play && play.props['aria-label'] === 'Play voice note, 42 seconds' && String(play.props['aria-pressed']) === 'false')
    const audio = m.find((n) => n.tag === 'audio')
    // The source is set on the element in the tap itself (iOS plays only from a
    // user gesture), not bound in the template.
    const srcOf = (a) => (a ? a.src || a.props.src || '' : '')
    ok('§8 ...nothing is fetched before Play (no src, preload none)', !!audio && !srcOf(audio) && audio.props.preload === 'none')
    const seek = m.find((n) => n.tag === 'input' && n.props.type === 'range')
    ok('§8 ...a native range to seek, with "0 seconds of 42 seconds"', !!seek && seek.props['aria-valuetext'] === '0 seconds of 42 seconds' && Number(seek.props.max) === 42)
    ok('§8 ...the length shown is the server\'s (0:42)', /0:42/.test(m.textOf(m.root)))
    await click(play)
    ok('§8 Play: the source is the one given, and it plays', srcOf(audio) === '/api/messages/41/voice' && audio.played === 1)
    // The element reports that it plays: the button keeps its name, and
    // aria-pressed carries the state.
    const onPlay = audio.props.onPlay
    if (typeof onPlay === 'function') onPlay({})
    await drain()
    const playing = m.find((n) => n.tag === 'button' && hasClass(n, 'vn-play'))
    ok('§8 while playing: the same name ("Play voice note, 42 seconds"), aria-pressed true', !!playing && playing.props['aria-label'] === 'Play voice note, 42 seconds' && String(playing.props['aria-pressed']) === 'true')
    const speed = named(m, /^Playback speed/)
    const rates = []
    for (let i = 0; i < 3; i++) { await click(speed); rates.push(named(m, /^Playback speed/)?.props?.['aria-label']) }
    ok('§8 a speed button cycles 1x, 1.5x, 2x', same(rates, ['Playback speed 1.5 times', 'Playback speed 2 times', 'Playback speed 1 times']))
    m.unmount()
  }
}

// The recorder.
const RECORDER_REL = 'client/src/components/shared/VoiceNoteRecorder.vue'
{
  let Recorder = null
  try { Recorder = await compileComponent(RECORDER_REL, { overrides: recorderOverrides, real: ['VoiceNotePlayer.vue'] }) } catch (err) { ok(`§8 VoiceNoteRecorder.vue compiles (${err.message})`, false) }
  if (Recorder) {
    currentRecorder = fakeRecorder()
    const sent = []
    let failNext = null
    const props = Vue.reactive({
      blocked: false,
      describedBy: 'vn-note',
      send: async (clip) => { sent.push(clip); if (failNext) { const e = failNext; failNext = null; throw e } },
    })
    const m = mountInMemory(Recorder, props)
    await drain()
    let mic = named(m, /^Record a voice note/)
    ok('§8 recorder: an enabled mic button when not blocked', !!mic && !isDisabled(mic))
    props.blocked = true
    await drain()
    mic = named(m, /^Record a voice note/)
    ok('§8 while the truck moves the mic is natively disabled, and described by the note', !!mic && isDisabled(mic) && mic.props['aria-describedby'] === 'vn-note')
    await click(mic)
    ok('§8 ...a tap on it records nothing', !currentRecorder.calls.includes('start'))
    props.blocked = false
    await drain()
    await click(named(m, /^Record a voice note/))
    ok('§8 mic: recording, with the word "Recording" and a Stop button', currentRecorder.phase.value === 'recording' && /Recording/.test(m.textOf(m.root)) && !!named(m, /^Stop recording/))
    props.blocked = true
    await drain()
    ok('§8 the truck starts moving mid-recording: it stops and the clip is kept for review', currentRecorder.calls.includes('stop') && currentRecorder.phase.value === 'review' && !!currentRecorder.clip.value)
    let send = named(m, /^Send voice note/)
    ok('§8 ...and Send waits (natively disabled) until the truck is parked again', !!send && isDisabled(send))
    await click(send)
    ok('§8 ...a tap on it sends nothing', sent.length === 0)
    props.blocked = false
    await drain()
    send = named(m, /^Send voice note/)
    ok('§8 parked: Send is named with the length ("Send voice note, 0:07")', !!send && !isDisabled(send) && send.props['aria-label'] === 'Send voice note, 0:07')
    failNext = Object.assign(new Error("Voice notes can't be sent while the truck is moving. Park first; your recording is kept."), { status: 409, code: 'VOICE_NOTE_WHILE_MOVING' })
    await click(send)
    ok('§8 a refused send keeps the clip and says why', sent.length === 1 && currentRecorder.phase.value === 'review' && !!currentRecorder.clip.value
      && m.textOf(m.find((n) => n.props.role === 'alert')).startsWith("Voice notes can't be sent while the truck is moving. Park first; your recording is kept."))
    await click(named(m, /^Send voice note/))
    ok('§8 the second try sends the same clip (same key), then back to the mic', sent.length === 2 && sent[1].key === sent[0].key && currentRecorder.phase.value === 'idle' && !!named(m, /^Record a voice note/))
    m.unmount()

    // The truck starts moving while the browser still asks for the microphone:
    // the recording that then starts is stopped at once, and kept for review.
    const held = fakeRecorder()
    let release = null
    held.start = async () => {
      held.calls.push('start')
      held.phase.value = 'starting'
      await new Promise((r) => { release = r })
      held.phase.value = 'recording'
    }
    currentRecorder = held
    const heldProps = Vue.reactive({ blocked: false, describedBy: 'vn-note', send: async () => {} })
    const hm = mountInMemory(Recorder, heldProps)
    await drain()
    await click(named(hm, /^Record a voice note/))
    ok('§8 (the mic waits at "starting" for the microphone prompt)', held.phase.value === 'starting')
    heldProps.blocked = true
    await drain()
    if (release) release()
    await drain()
    ok('§8 the truck starts moving during the microphone prompt: the recording stops as soon as it starts, the clip kept', held.calls.includes('stop') && held.phase.value === 'review')
    hm.unmount()

    currentRecorder = Object.assign(fakeRecorder(), { supported: false })
    const u = mountInMemory(Recorder, { send: async () => {} })
    await drain()
    ok('§8 a browser that cannot record AAC: no mic, the note instead', !named(u, /^Record a voice note/) && /Voice notes record in Chrome, Edge or Safari\./.test(u.textOf(u.root)))
    u.unmount()
  }
}

const voiceRow = { id: 41, timestamp: '2026-10-22T13:00:00.000Z', from: 'Pat Example', to: 'Dispatch', message: 'Voice note (0:42)', loadId: 'QA-VOICE-1', read: 1, attachment_url: '', attachment_type: 'voice', voice_duration_ms: 42000 }
const typedOnly = { ...voiceRow, id: 42, voice_duration_ms: undefined, message: 'Voice note (unavailable)' }
const unsaved = { ...voiceRow, id: 0, attachment_url: '/api/messages/41/voice' }

// The dashboard bubble.
{
  let Bubble = null
  try { Bubble = await compileComponent('client/src/components/dashboard/ChatBubble.vue', { overrides: recorderOverrides, real: ['VoiceNotePlayer.vue'] }) } catch (err) { ok(`§8 ChatBubble.vue compiles (${err.message})`, false) }
  if (Bubble) {
    const a = mountInMemory(Bubble, { msg: voiceRow })
    await drain()
    const audio = a.find((n) => n.tag === 'audio')
    ok('§8 dashboard: a server voice note is a player', !!named(a, /^Play voice note, 42 seconds/) && !!audio)
    await click(named(a, /^Play voice note/))
    ok('§8 ...playing /api/messages/41/voice', (audio?.src || audio?.props?.src) === '/api/messages/41/voice')
    ok('§8 ...without repeating "Voice note (0:42)" as text', !/Voice note \(0:42\)/.test(a.textOf(a.root)))
    a.unmount()
    const b = mountInMemory(Bubble, { msg: typedOnly })
    await drain()
    ok('§8 dashboard: a row typed voice with no voice_duration_ms has no player, and shows its text', !named(b, /^Play voice note/) && /Voice note \(unavailable\)/.test(b.textOf(b.root)))
    b.unmount()
    const c = mountInMemory(Bubble, { msg: unsaved })
    await drain()
    ok('§8 dashboard: an attachment_url with id 0 has no player and no link', !named(c, /^Play voice note/) && !c.find((n) => n.tag === 'a'))
    c.unmount()
  }
}

// The dashboard Messages page.
{
  const sentTo = []
  const store = Vue.reactive({
    conversations: [
      { driver: 'Pat Example', loadId: 'QA-VOICE-1', lastTimestamp: '2026-10-22T13:00:00.000Z', unread: 0, lastKind: 'voice', lastText: 'Voice note (0:42)', lastVoiceMs: 42000 },
      { driver: 'Sam Example', loadId: '', lastTimestamp: '2026-10-22T12:00:00.000Z', unread: 1, lastKind: 'photo', lastText: '' },
      { driver: 'Lee Example', loadId: '', lastTimestamp: '2026-10-22T11:00:00.000Z', unread: 0 },
    ],
    selectedDriver: 'Pat Example',
    selectedLoadId: 'QA-VOICE-1',
    currentMessages: [voiceRow],
    selectConversation() {},
    async sendVoiceNote(driver, loadId, clip) { sentTo.push({ driver, loadId, key: clip.key }) },
  })
  const flag = Vue.ref(true)
  const overrides = {
    ...recorderOverrides,
    '../../stores/messages': { useMessagesStore: () => store },
    '../../composables/useApi': { useApi: () => ({ get: async () => ({}), post: async () => ({}), put: async () => ({}) }) },
    '../../stores/dashboard': { useDashboardStore: () => ({ activeJobs: [] }) },
    '../../composables/useToast': { useToast: () => ({ show() {} }) },
    '../../composables/useFileDrop': { useFileDrop: () => ({ dropzoneProps: {}, inputProps: {}, setInputEl() {}, dragActive: Vue.ref(false), error: Vue.ref(''), notice: Vue.ref(''), clearMessages() {} }) },
    '../../composables/useVoiceNotesFeature': { useVoiceNotesFeature: () => flag },
  }
  currentRecorder = fakeRecorder()
  let Panel = null
  try { Panel = await compileComponent('client/src/components/dashboard/MessagingPanel.vue', { overrides, real: ['ChatBubble.vue', 'VoiceNotePlayer.vue', 'VoiceNoteRecorder.vue'] }) } catch (err) { ok(`§8 MessagingPanel.vue compiles (${err.message})`, false) }
  if (Panel) {
    const m = mountInMemory(Panel, { driverNames: ['Pat Example'] })
    await drain()
    const previews = m.findAll((n) => hasClass(n, 'msg-preview')).map((n) => m.textOf(n))
    ok('§8 dashboard list: "Voice note (0:42)", "Photo", and no line for a conversation the server sent no preview for', same(previews, ['Voice note (0:42)', 'Photo']))
    ok('§8 dashboard thread: the voice note plays', !!named(m, /^Play voice note, 42 seconds/))
    const mic = named(m, /^Record a voice note/)
    ok('§8 dashboard composer: a mic (flag on), enabled (no truck gate here)', !!mic && !isDisabled(mic))
    await click(mic)
    currentRecorder.stop()
    await drain()
    const row = m.find((n) => hasClass(n, 'msg-chat-input'))
    ok('§8 recording or reviewing takes the row (the text field and send are hidden)', hasClass(row, 'is-recording'))
    await click(named(m, /^Send voice note/))
    ok('§8 Send goes as Dispatch to the open conversation and its load', same(sentTo, [{ driver: 'Pat Example', loadId: 'QA-VOICE-1', key: 'vn-key-0000000001' }]))
    flag.value = false
    await drain()
    ok('§8 dashboard, flag off: no mic; the note still plays', !named(m, /^Record a voice note/) && !!named(m, /^Play voice note/))
    m.unmount()
  }
}

// The driver thread.
{
  let Chat = null
  currentRecorder = fakeRecorder()
  try { Chat = await compileComponent('client/src/components/driver/ChatView.vue', { overrides: recorderOverrides, real: ['VoiceNotePlayer.vue', 'VoiceNoteRecorder.vue'] }) } catch (err) { ok(`§8 ChatView.vue compiles (${err.message})`, false) }
  if (Chat) {
    const messages = Vue.reactive([
      { ...voiceRow, id: 41, from: 'Dispatch', to: 'Pat Example' },
      { ...typedOnly, from: 'Dispatch', to: 'Pat Example' },
    ])
    const props = Vue.reactive({ messages, loads: [], driverName: 'Pat Example', loadId: 'QA-VOICE-1', voiceNotes: true, voiceGate: { allowed: false, state: 'moving' }, voiceSendHandler: async () => {} })
    const m = mountInMemory(Chat, props)
    await drain()
    ok('§8 driver: the server voice note plays, the typed-only row does not', m.findAll((n) => n.tag === 'button' && /^Play voice note/.test(String(n.props['aria-label'] || ''))).length === 1)
    const mic = named(m, /^Record a voice note/)
    const note = m.find((n) => hasClass(n, 'vn-drive-note'))
    ok('§8 driver, truck moving: the mic is shown, natively disabled', !!mic && isDisabled(mic))
    ok('§8 ...described by the note, which says why', !!note && mic?.props?.['aria-describedby'] === note.props.id && m.textOf(note) === 'Voice notes are off while the truck is moving. Park first, then record.')
    props.voiceGate = { allowed: false, state: 'stopping' }
    await drain()
    ok('§8 driver, stopped under 2 minutes: still disabled', isDisabled(named(m, /^Record a voice note/)))
    props.voiceGate = { allowed: true, state: 'parked' }
    await drain()
    ok('§8 driver, parked: the mic works, the note says "Record only when parked."', !isDisabled(named(m, /^Record a voice note/)) && m.textOf(m.find((n) => hasClass(n, 'vn-drive-note'))) === 'Record only when parked.')
    props.voiceGate = { allowed: true, state: 'unknown' }
    await drain()
    ok('§8 driver, ELD unknown: allowed, with the note', !isDisabled(named(m, /^Record a voice note/)) && m.textOf(m.find((n) => hasClass(n, 'vn-drive-note'))) === 'Record only when parked.')
    props.voiceNotes = false
    await drain()
    ok('§8 driver, flag off: no mic and no note; notes already sent still play', !named(m, /^Record a voice note/) && !m.find((n) => hasClass(n, 'vn-drive-note')) && !!named(m, /^Play voice note/))
    m.unmount()
  }
}

// The investor thread.
{
  const invThread = [
    { id: 51, timestamp: '2026-10-22T13:00:00.000Z', from: 'Dispatch', to: 'inv_t', message: 'Voice note (0:09)', read: 1, attachment_url: '', attachment_type: 'voice', voice_duration_ms: 9000 },
    { id: 52, timestamp: '2026-10-22T13:01:00.000Z', from: 'Dispatch', to: 'inv_t', message: 'Voice note (unavailable)', read: 1, attachment_url: '', attachment_type: 'voice' },
  ]
  const invAuth = { user: { id: 7, username: 'inv_t', role: 'Investor' } }
  const api = { get: async (url) => (url === '/api/auth/session' ? { authenticated: true, features: { voiceNotes: true } } : { messages: invThread.map((r) => ({ ...r })) }), put: async () => ({}), post: async () => ({}), request: async () => ({ success: true, id: 60, durationMs: 7000 }) }
  const overrides = {
    ...recorderOverrides,
    '../../composables/useApi': { useApi: () => api },
    '../../composables/useSocket': { useSocket: () => ({ on() {}, off() {} }) },
    '../../composables/useFileDrop': { useFileDrop: () => ({ dropzoneProps: {}, inputProps: {}, setInputEl() {}, dragActive: Vue.ref(false), error: Vue.ref(''), notice: Vue.ref(''), clearMessages() {} }) },
    '../../stores/auth': { useAuthStore: () => invAuth },
    '../../stores/investor': { useInvestorStore: () => ({ data: null }) },
    '../../composables/useVoiceNotesFeature': { useVoiceNotesFeature: () => Vue.ref(true) },
  }
  currentRecorder = fakeRecorder()
  let Inv = null
  try { Inv = await compileComponent('client/src/components/investor/InvestorChat.vue', { overrides, real: ['VoiceNotePlayer.vue', 'VoiceNoteRecorder.vue'] }) } catch (err) { ok(`§8 InvestorChat.vue compiles (${err.message})`, false) }
  if (Inv) {
    const m = mountInMemory(Inv, { trucks: [] })
    await drain()
    ok('§8 investor: the server voice note plays; the one he may not play shows its text only',
      m.findAll((n) => n.tag === 'button' && /^Play voice note, 9 seconds/.test(String(n.props['aria-label'] || ''))).length === 1 && /Voice note \(unavailable\)/.test(m.textOf(m.root)))
    ok('§8 investor: a mic in the composer (flag on)', !!named(m, /^Record a voice note/))
    m.unmount()
    const pv = mountInMemory(Inv, { trucks: [], isPreview: true, previewUserId: 7 })
    await drain()
    ok('§8 investor preview (a Super Admin looking): no mic', !named(pv, /^Record a voice note/))
    pv.unmount()
    // A Super Admin on /investor outside a preview: his note could only be
    // refused (staff send to a driver or an investor, from the dashboard).
    invAuth.user = { id: 1, username: 'admin_t', role: 'Super Admin' }
    const sa = mountInMemory(Inv, { trucks: [] })
    await drain()
    ok('§8 investor portal opened by a Super Admin (not a preview): no mic; notes still play', !named(sa, /^Record a voice note/) && !!named(sa, /^Play voice note/))
    sa.unmount()
  }
}

// ══ §9 the live copies ════════════════════════════════════════════════════════
for (const [store, label] of [['messages.js', 'dashboard'], ['driver.js', 'driver app']]) {
  const src = read('client', 'src', 'stores', store)
  const live = /addIncomingMessage\s*\(msg\)\s*\{[\s\S]*?\n {4}\},/.exec(src)
  ok(`§9 stores/${store} (${label}): a live message keeps voice_duration_ms`, !!live && /voice_duration_ms:\s*Number\(msg\.voice_duration_ms\)\s*\|\|\s*0/.test(live[0]))
  ok(`§9 stores/${store}: sends a voice note through uploadVoiceNote()`, /sendVoiceNote\s*\(/.test(src) && /uploadVoiceNote\(/.test(src))
}
{
  // Touch targets in the driver app: 44 px play and speed buttons in the thread.
  const chat = read('client', 'src', 'components', 'driver', 'ChatView.vue')
  const list = /\.chat-messages\s*\{[^}]*\}/.exec(chat)
  ok('§9 the driver thread sets 44 px voice-note play and speed buttons', !!list && /--vn-play-size:\s*44px/.test(list[0]) && /--vn-rate-size:\s*44px/.test(list[0]))
  const player = read('client', 'src', 'components', 'shared', 'VoiceNotePlayer.vue')
  ok('§9 the player\'s speed button takes its size from --vn-rate-size', /\.vn-rate\s*\{[^}]*min-height:\s*var\(--vn-rate-size/.test(player))
}
{
  const src = read('client', 'src', 'views', 'DriverView.vue')
  const fn = /function onNewMessage\(msg\)\s*\{[\s\S]*?\n\}/.exec(src)
  ok('§9 the driver app\'s bell and toast say "New voice note from ..." for a voice note', !!fn && /voiceNoteTitle\(msg\.from\)/.test(fn[0]))
}

console.log(`\n${pass} passed, ${failures.length} failed`)
if (failures.length) process.exit(1)
