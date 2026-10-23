"use strict";
// What a voice note is called wherever it shows as text: the notification, the
// live message's text, the conversation list and a note nobody can play any
// more. Pure. The length is always the one the server measured
// (lib/voice-note-mp4.js), shown m:ss and rounded down. Never a file name, a URL
// or an id.
//
// The client keeps its own copy (client/src/lib/voiceNoteText.js, with the
// recorder); a runner pins the two equal when that copy lands.

function voiceNoteClock(ms) {
	const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
	const minutes = Math.floor(total / 60);
	const seconds = total % 60;
	return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

const voiceNoteLabel = (ms) => `Voice note (${voiceNoteClock(ms)})`;
const voiceNoteExpiredLabel = (ms) => `Voice note (${voiceNoteClock(ms)}), no longer available`;
const voiceNoteTitle = (from) => `New voice note from ${from}`;
// A note in a thread its reader may not play (lib/voice-notes.js).
const VOICE_NOTE_UNAVAILABLE = "Voice note (unavailable)";
// A note a Super Admin removed (DELETE /api/messages/:id/voice).
const VOICE_NOTE_REMOVED = "Voice note removed by an administrator";

module.exports = { voiceNoteClock, voiceNoteLabel, voiceNoteExpiredLabel, voiceNoteTitle, VOICE_NOTE_UNAVAILABLE, VOICE_NOTE_REMOVED };
