// What a voice note is called wherever it shows as text: the bell, the toast,
// the conversation list and a note nobody can play any more. The client's copy
// of the server's lib/voice-note-text.js, which it cannot load;
// scripts/test-voice-note-text.mjs pins the two equal, word for word. Change
// both or neither.
//
// The length is always the one the server measured (voice_duration_ms), shown
// m:ss and rounded down. Never a file name, a URL or an id.

export function voiceNoteClock(ms) {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

export const voiceNoteLabel = (ms) => `Voice note (${voiceNoteClock(ms)})`
export const voiceNoteExpiredLabel = (ms) => `Voice note (${voiceNoteClock(ms)}), no longer available`
export const voiceNoteTitle = (from) => `New voice note from ${from}`
// A note in a thread its reader may not play.
export const VOICE_NOTE_UNAVAILABLE = 'Voice note (unavailable)'
// A note a Super Admin removed.
export const VOICE_NOTE_REMOVED = 'Voice note removed by an administrator'
