// Voice notes in Messages (MESSAGE_VOICE_NOTES_ENABLED; plan 2026-10-22,
// Revision 2): the rules every surface shares. Pure; scripts/test-voice-note-text.mjs.
//
// WHICH ROWS PLAY (M3). The voice type belongs to the server: only a row it
// measured plays, and the audio always comes from GET /api/messages/<id>/voice,
// which checks who is asking. A row's attachment_url is never a voice source,
// and a row with no server length (voice_duration_ms 0 or missing: a reader who
// may not play it, a removed file, an unsaved row) shows its text instead.
//
// THE FORMAT. AAC in MP4, recorded only where the browser records it natively
// (iPhone Safari, Chrome and Edge 126+, desktop Safari). Firefox plays notes but
// does not record them.
import { voiceNoteLabel } from './voiceNoteText.js'

export const VOICE_NOTE_MAX_MS = 3 * 60 * 1000
// The server refuses under 0.5 s; a clip under a second is refused here first.
export const VOICE_NOTE_MIN_MS = 1000
export const VOICE_NOTE_MAX_BYTES = 4 * 1024 * 1024
export const VOICE_NOTE_MIME_CHOICES = Object.freeze(['audio/mp4;codecs=mp4a.40.2', 'audio/mp4'])
export const VOICE_NOTE_UNSUPPORTED = 'Voice notes record in Chrome, Edge or Safari.'

export function isServerVoiceNote(msg) {
  if (!msg) return false
  const id = Number(msg.id)
  const ms = Number(msg.voice_duration_ms)
  return Number.isInteger(id) && id > 0 && ms > 0
}

export const voiceNoteSrc = (msg) => (isServerVoiceNote(msg) ? `/api/messages/${Number(msg.id)}/voice` : '')

// The first AAC/MP4 type this browser's MediaRecorder records, or null.
export function pickRecorderMime(isTypeSupported) {
  if (typeof isTypeSupported !== 'function') return null
  for (const type of VOICE_NOTE_MIME_CHOICES) {
    try {
      if (isTypeSupported(type)) return type
    } catch {
      return null
    }
  }
  return null
}

// { supported, mimeType } for a window-like object: a secure page, the
// microphone API and a MediaRecorder that records AAC/MP4.
export function voiceRecordingSupport(env) {
  const no = { supported: false, mimeType: null }
  if (!env || env.isSecureContext === false) return no
  const Recorder = env.MediaRecorder
  const media = env.navigator && env.navigator.mediaDevices
  if (typeof Recorder !== 'function' || !media || typeof media.getUserMedia !== 'function') return no
  const mimeType = pickRecorderMime(typeof Recorder.isTypeSupported === 'function' ? (t) => Recorder.isTypeSupported(t) : undefined)
  return mimeType ? { supported: true, mimeType } : no
}

// "42 seconds", "1 minute 5 seconds": a length as a screen reader says it.
export function spokenDuration(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0))
  const m = Math.floor(s / 60)
  const r = s % 60
  const secs = `${r} second${r === 1 ? '' : 's'}`
  return m ? `${m} minute${m === 1 ? '' : 's'}${r ? ` ${secs}` : ''}` : secs
}

// The conversation list's last-message line, from the GET /api/messages
// preview fields (lastKind "text" | "photo" | "file" | "voice", lastText, the
// first 60 characters, and lastVoiceMs). '' when the server sends none.
export function conversationPreview(c) {
  if (!c || !c.lastKind) return ''
  const textPart = String(c.lastText || '').slice(0, 60)
  switch (c.lastKind) {
    case 'voice': return Number(c.lastVoiceMs) > 0 ? voiceNoteLabel(Number(c.lastVoiceMs)) : (textPart || 'Voice note')
    case 'photo': return 'Photo'
    case 'file': return 'File'
    case 'text': return textPart
    default: return ''
  }
}

// One voice note plays at a time across the page: a player that starts claims
// playback, which pauses the one playing before it.
let playingAudio = null
export function claimPlayback(audio) {
  if (playingAudio && playingAudio !== audio && typeof playingAudio.pause === 'function') playingAudio.pause()
  playingAudio = audio
}
export function releasePlayback(audio) {
  if (playingAudio === audio) playingAudio = null
}

// One send key per recorded clip; every retry of that clip reuses it, so a
// reply lost on a weak signal never makes a second note.
export function newVoiceNoteKey(cryptoObj = globalThis.crypto) {
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') return `vn-${cryptoObj.randomUUID()}`
  const bytes = new Uint8Array(16)
  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') cryptoObj.getRandomValues(bytes)
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  return `vn-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`
}

const NO_CONNECTION = 'Not sent. Check your connection, then tap Send to try again.'
// What the composer says when a send failed. The clip stays either way.
export function voiceSendFailure(err) {
  if (!err) return 'Not sent. Tap Send to try again.'
  if (err.code === 'FEATURE_OFF') return 'Voice notes are switched off. Send a text message instead.'
  if (err.code === 'TIMEOUT' || err.name === 'TypeError' || (err.status === 0 && err.code !== 'ABORT')) return NO_CONNECTION
  if (err.code && err.message) return err.message
  if (Number(err.status) >= 400 && Number(err.status) < 500 && err.message && !/^Request failed/.test(err.message)) return err.message
  return 'Not sent. Tap Send to try again.'
}
