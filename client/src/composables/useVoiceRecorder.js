import { ref, shallowRef, getCurrentInstance, onBeforeUnmount } from 'vue'
import { VOICE_NOTE_MAX_BYTES, VOICE_NOTE_MAX_MS, VOICE_NOTE_MIN_MS, newVoiceNoteKey, voiceRecordingSupport } from '../lib/voiceNotes.js'

// One voice note being recorded (plan 2026-10-22, section 2). The phases:
//   idle -> starting (asking for the microphone) -> recording -> review -> idle
// `review` holds the clip ({ blob, url, durationMs, mimeType, key }) until it is
// sent or discarded; a failed send leaves it there for another try.
//
// - AAC in MP4 only (`audio/mp4;codecs=mp4a.40.2`, else `audio/mp4`), and the
//   recorder's own mimeType is checked afterwards: a browser that hands back
//   WebM anyway gets an error, never an upload the server would refuse.
// - getUserMedia is the first await of start(), so it runs inside the tap
//   (iOS asks only from a user gesture). Mono, echo cancellation, noise
//   suppression; 48 kbps requested (iOS may ignore it; the cap is 4 MB).
// - Stops by itself at 3:00 ("10 seconds left" first) and when the tab hides
//   (iOS stops capture anyway); both keep the clip. The microphone and the
//   level meter's AudioContext are released on stop, discard and unmount.
// - The level meter is an AnalyserNode read on a timer: no AudioWorklet.
//
// `env` is the browser (window); the runner passes a fake one.
const LEVEL_BARS = 14
const TICK_MS = 120
const WARN_BEFORE_MS = 10000

export const MIC_BLOCKED = 'Microphone access is blocked. Allow it for this site in the browser settings, then try again.'
const NO_MIC = 'No microphone was found.'
const MIC_FAILED = 'The microphone could not be started. Try again.'
const WRONG_FORMAT = "This browser recorded a format that can't be sent. Record in Chrome, Edge or Safari."
const TOO_SHORT = 'Too short to send. Hold on a little longer.'
const TOO_LARGE = 'That recording is too large to send. Record a shorter note.'

function browserEnv() {
  if (typeof window === 'undefined') return null
  return {
    isSecureContext: window.isSecureContext,
    MediaRecorder: window.MediaRecorder,
    navigator: window.navigator,
    Blob: window.Blob,
    URL: window.URL,
    AudioContext: window.AudioContext || window.webkitAudioContext,
    document: window.document,
    setInterval: window.setInterval.bind(window),
    clearInterval: window.clearInterval.bind(window),
    now: () => Date.now(),
  }
}

function stopTracks(stream) {
  if (!stream || typeof stream.getTracks !== 'function') return
  for (const track of stream.getTracks()) {
    try { track.stop() } catch { /* already stopped */ }
  }
}

export function useVoiceRecorder({ maxMs = VOICE_NOTE_MAX_MS, env = browserEnv() } = {}) {
  const support = voiceRecordingSupport(env)
  const phase = ref('idle')
  const elapsedMs = ref(0)
  const levels = ref(Array(LEVEL_BARS).fill(0))
  const clip = shallowRef(null)
  const error = ref('')
  const announcement = ref('')

  let stream = null
  let recorder = null
  let chunks = []
  let startedAt = 0
  let durationAtStop = 0
  let timer = null
  let audioCtx = null
  let analyser = null
  let sample = null
  let warned = false
  let stopping = false
  let stopReason = ''
  // Bumped by every start and discard: a late getUserMedia answer or recorder
  // event from an earlier recording changes nothing.
  let session = 0

  function onVisibility() {
    if (env.document && env.document.visibilityState === 'hidden' && phase.value === 'recording') stop('hidden')
  }

  function release() {
    if (timer != null) { env.clearInterval(timer); timer = null }
    stopTracks(stream)
    stream = null
    if (audioCtx) {
      try {
        const closing = audioCtx.close()
        if (closing && typeof closing.catch === 'function') closing.catch(() => {})
      } catch { /* already closed */ }
    }
    audioCtx = null
    analyser = null
    if (env.document && typeof env.document.removeEventListener === 'function') env.document.removeEventListener('visibilitychange', onVisibility)
  }

  function dropClip() {
    if (!clip.value) return
    try { env.URL.revokeObjectURL(clip.value.url) } catch { /* nothing to release */ }
    clip.value = null
  }

  function startMeter(s) {
    const Ctx = env.AudioContext
    if (typeof Ctx !== 'function') return
    try {
      audioCtx = new Ctx()
      analyser = audioCtx.createAnalyser()
      analyser.fftSize = 256
      audioCtx.createMediaStreamSource(s).connect(analyser)
      sample = new Uint8Array(analyser.fftSize || 256)
    } catch {
      audioCtx = null
      analyser = null
    }
  }

  function readLevel() {
    if (!analyser || !sample) return 0
    analyser.getByteTimeDomainData(sample)
    let sum = 0
    for (let i = 0; i < sample.length; i++) {
      const v = (sample[i] - 128) / 128
      sum += v * v
    }
    return Math.min(100, Math.round(Math.sqrt(sum / sample.length) * 300))
  }

  function tick() {
    if (phase.value !== 'recording') return
    const elapsed = env.now() - startedAt
    elapsedMs.value = elapsed
    levels.value = [...levels.value.slice(1), readLevel()]
    if (!warned && elapsed >= maxMs - WARN_BEFORE_MS) {
      warned = true
      announcement.value = '10 seconds left'
    }
    if (elapsed >= maxMs) stop('limit')
  }

  function finishRecording(mine) {
    if (mine !== session) return
    const durationMs = durationAtStop
    const type = String((recorder && recorder.mimeType) || support.mimeType || '')
    const parts = chunks
    chunks = []
    recorder = null
    stopping = false
    release()
    elapsedMs.value = durationMs
    if (!/^audio\/mp4/i.test(type)) { phase.value = 'idle'; error.value = WRONG_FORMAT; return }
    if (!(durationMs >= VOICE_NOTE_MIN_MS) || !parts.length) { phase.value = 'idle'; error.value = TOO_SHORT; return }
    const blob = new env.Blob(parts, { type: 'audio/mp4' })
    if (blob.size > VOICE_NOTE_MAX_BYTES) { phase.value = 'idle'; error.value = TOO_LARGE; return }
    clip.value = { blob, url: env.URL.createObjectURL(blob), durationMs, mimeType: 'audio/mp4', key: newVoiceNoteKey() }
    phase.value = 'review'
    announcement.value = stopReason === 'limit'
      ? 'Recording stopped at 3 minutes'
      : stopReason === 'blocked'
        ? 'Recording stopped: the truck is moving. Your recording is kept.'
        : 'Recording stopped'
  }

  async function start() {
    if (!support.supported || phase.value !== 'idle') return
    error.value = ''
    announcement.value = ''
    dropClip()
    phase.value = 'starting'
    const mine = ++session
    let s
    try {
      s = await env.navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } })
    } catch (err) {
      if (mine !== session) return
      phase.value = 'idle'
      const name = err && err.name
      error.value = name === 'NotAllowedError' || name === 'SecurityError' ? MIC_BLOCKED : name === 'NotFoundError' ? NO_MIC : MIC_FAILED
      return
    }
    if (mine !== session) { stopTracks(s); return }
    stream = s
    try {
      recorder = new env.MediaRecorder(s, { mimeType: support.mimeType, audioBitsPerSecond: 48000 })
    } catch {
      release()
      recorder = null
      phase.value = 'idle'
      error.value = MIC_FAILED
      return
    }
    chunks = []
    stopping = false
    stopReason = ''
    recorder.ondataavailable = (e) => { if (e && e.data && e.data.size > 0) chunks.push(e.data) }
    recorder.onstop = () => finishRecording(mine)
    startMeter(s)
    startedAt = env.now()
    elapsedMs.value = 0
    warned = false
    recorder.start(1000)
    phase.value = 'recording'
    announcement.value = 'Recording started'
    timer = env.setInterval(tick, TICK_MS)
    if (env.document && typeof env.document.addEventListener === 'function') env.document.addEventListener('visibilitychange', onVisibility)
  }

  // reason: 'user' | 'limit' | 'hidden' | 'blocked'. The clip is kept.
  function stop(reason = 'user') {
    if (phase.value !== 'recording' || !recorder || stopping) return
    stopping = true
    stopReason = reason
    durationAtStop = env.now() - startedAt
    if (timer != null) { env.clearInterval(timer); timer = null }
    try {
      recorder.stop()
    } catch {
      finishRecording(session)
    }
  }

  function discard() {
    session++
    if (recorder) {
      recorder.ondataavailable = null
      recorder.onstop = null
      try { if (recorder.state !== 'inactive') recorder.stop() } catch { /* already stopped */ }
    }
    recorder = null
    chunks = []
    stopping = false
    release()
    dropClip()
    phase.value = 'idle'
    elapsedMs.value = 0
    levels.value = Array(LEVEL_BARS).fill(0)
  }

  if (getCurrentInstance()) onBeforeUnmount(discard)

  return { supported: support.supported, phase, elapsedMs, levels, clip, error, announcement, start, stop, discard }
}
