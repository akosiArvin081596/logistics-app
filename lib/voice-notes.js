"use strict";
// Voice notes in Messages: where the audio lives, who may play it, how a thread
// shows it, and the daily retention sweep. The bytes check is
// lib/voice-note-mp4.js; the wording lib/voice-note-text.js; the routes are in
// server.js (POST /api/messages/voice, GET and DELETE /api/messages/:id/voice).
//
// STORAGE. DATA_DIR/storage/voice-notes/vn_<messageId>_<16 hex>.m4a, outside
// uploads/: no static mount reaches it, so the GET route is the only way in.
// The name is chosen by the server and checked against VOICE_FILE_RE before it
// is ever joined to a path. Written with "wx" (never over an existing file),
// mode 0640.
//
// WHO PLAYS A NOTE: BY USER ID, NOT BY NAME. Each voice row stores
// party_user_id, the Driver or Investor account in the conversation, resolved
// when it was sent. Super Admin and Dispatcher play every note (they read every
// thread); a Driver or an Investor only a note whose party_user_id is his own
// account id. A rename keeps his notes; a new account given an old name gets
// none of them. Everyone else, and a note that does not exist, is answered 404.
//
// THREADS. A voice row reaches a thread with attachment_type "voice", no
// attachment_url (the player builds /api/messages/<id>/voice from the id) and
// voice_duration_ms > 0 only when the reader may play it AND the file is still
// stored. A reader who may not play it sees "Voice note (unavailable)". A note
// the sweep or a Super Admin removed keeps its row; its text says so.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const text = require("./voice-note-text");

const VOICE_FILE_RE = /^vn_\d{1,16}_[0-9a-f]{16}\.m4a$/;
const STAFF_ROLES = Object.freeze(["Super Admin", "Dispatcher"]);
const PARTY_ROLES = Object.freeze(["Driver", "Investor"]);
const HEADER_MAX_CHARS = 200;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{8,64}$/;
const ORPHAN_MIN_AGE_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const voiceNoteDir = (dataDir) => path.join(dataDir, "storage", "voice-notes");
const newVoiceFileName = (messageId) => `vn_${messageId}_${crypto.randomBytes(8).toString("hex")}.m4a`;
const voiceFilePath = (dir, name) => (typeof name === "string" && VOICE_FILE_RE.test(name) ? path.join(dir, name) : null);

function canPlayVoiceNote(user, row) {
	if (!user || !row) return false;
	if (STAFF_ROLES.includes(user.role)) return true;
	if (!PARTY_ROLES.includes(user.role)) return false;
	const party = Number(row.party_user_id);
	return Number.isInteger(party) && party > 0 && party === Number(user.id);
}

// One thread row as `user` may see it. Strips voice_file and party_user_id,
// which never leave the server.
function voiceThreadRow(user, row) {
	const { voice_file: file, party_user_id: _party, voice_duration_ms: ms, ...rest } = row;
	if (rest.attachment_type !== "voice") return { ...rest, voice_duration_ms: 0 };
	const out = { ...rest, attachment_url: "", voice_duration_ms: 0 };
	if (!canPlayVoiceNote(user, row)) return { ...out, message: text.VOICE_NOTE_UNAVAILABLE };
	if (!VOICE_FILE_RE.test(file || "")) return out;
	return { ...out, voice_duration_ms: Number(ms) > 0 ? Number(ms) : 0 };
}
const voiceThreadRows = (user, rows) => rows.map((r) => voiceThreadRow(user, r));

// X-Message-To / X-Message-Load-Id: percent-encoded UTF-8, at most 200
// characters once decoded, no control characters. { value } or { error }.
function messageHeader(raw, { required = false } = {}) {
	if (raw === undefined || raw === "") return required ? { error: "missing" } : { value: "" };
	if (typeof raw !== "string" || raw.length > HEADER_MAX_CHARS * 12) return { error: "too long" };
	let value;
	try { value = decodeURIComponent(raw); } catch { return { error: "not percent-encoded UTF-8" }; }
	value = value.trim();
	if (value.length > HEADER_MAX_CHARS) return { error: "too long" };
	if (/[\u0000-\u001f\u007f]/.test(value)) return { error: "control characters" };
	if (required && !value) return { error: "missing" };
	return { value };
}
const idempotencyKey = (raw) => (typeof raw === "string" && IDEMPOTENCY_KEY_RE.test(raw) ? raw : "");

// Writes the checked bytes under a new name. Never over an existing file; a
// partial file this call created is removed before the error is rethrown.
function storeVoiceFile(dir, name, bytes) {
	const target = voiceFilePath(dir, name);
	if (!target) throw new Error("bad voice note file name");
	fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
	try {
		fs.writeFileSync(target, bytes, { flag: "wx", mode: 0o640 });
	} catch (err) {
		if (err && err.code !== "EEXIST") {
			try { fs.unlinkSync(target); } catch { /* never written */ }
		}
		throw err;
	}
	return target;
}

function removeVoiceFile(dir, name) {
	const target = voiceFilePath(dir, name);
	if (!target) return false;
	try { fs.unlinkSync(target); return true; } catch (err) { return !!err && err.code === "ENOENT"; }
}

// The daily retention sweep: notes older than `retentionDays`, and vn_ files
// no row names (older than an hour: a send in progress writes its file before
// its row commits). REPORT ONLY until `applyFrom` (YYYY-MM-DD, set by Arvin
// before the flag goes on) is today or earlier in `todayKey`; with no date it
// never deletes. The reference set is read first and fails closed: if it cannot
// be read, nothing is removed.
function sweepVoiceNotes({ db, dir, nowMs = Date.now(), retentionDays = 180, applyFrom = "", todayKey = "", log = console }) {
	const out = { expired: 0, expiredBytes: 0, orphans: 0, orphanBytes: 0, removed: 0, applied: false };
	const apply = /^\d{4}-\d{2}-\d{2}$/.test(applyFrom) && /^\d{4}-\d{2}-\d{2}$/.test(todayKey) && todayKey >= applyFrom;
	out.applied = apply;
	let referenced;
	let expired;
	try {
		referenced = new Set(db.prepare("SELECT voice_file FROM messages WHERE COALESCE(voice_file, '') <> ''").all().map((r) => r.voice_file));
		const days = Number.isFinite(retentionDays) && retentionDays > 0 ? retentionDays : 180;
		const cutoff = new Date(nowMs - days * DAY_MS).toISOString();
		expired = db.prepare(
			`SELECT id, voice_file, voice_duration_ms, voice_bytes FROM messages
			 WHERE attachment_type = 'voice' AND COALESCE(voice_file, '') <> '' AND timestamp < ?`,
		).all(cutoff);
	} catch (err) {
		log.warn(`[voice-notes] messages unreadable (${err.message}): removing nothing this run.`);
		return { ...out, referenceUnreadable: true };
	}
	const clear = db.prepare("UPDATE messages SET voice_file = '', voice_bytes = 0, message = ? WHERE id = ? AND voice_file = ?");
	for (const row of expired) {
		out.expired++;
		out.expiredBytes += Number(row.voice_bytes) || 0;
		if (apply && removeVoiceFile(dir, row.voice_file)) {
			clear.run(text.voiceNoteExpiredLabel(row.voice_duration_ms), row.id, row.voice_file);
			out.removed++;
		}
	}
	let names = [];
	try { names = fs.readdirSync(dir); } catch { names = []; }
	for (const name of names) {
		if (!name.startsWith("vn_") || referenced.has(name)) continue;
		const p = path.join(dir, name);
		try {
			const st = fs.lstatSync(p);
			if (!st.isFile() || nowMs - st.mtimeMs < ORPHAN_MIN_AGE_MS) continue;
			out.orphans++;
			out.orphanBytes += st.size;
			if (apply) { fs.unlinkSync(p); out.removed++; }
		} catch { /* vanished, or not ours to touch */ }
	}
	if (out.expired || out.orphans) {
		const mb = ((out.expiredBytes + out.orphanBytes) / (1024 * 1024)).toFixed(1);
		log.log(apply
			? `[voice-notes] removed ${out.removed} file(s): ${out.expired} past ${retentionDays} days, ${out.orphans} named by no message (${mb} MB)`
			: `[voice-notes] REPORT ONLY: ${out.expired} voice note(s) past ${retentionDays} days and ${out.orphans} file(s) named by no message, ${mb} MB. `
				+ "Nothing is deleted until VOICE_NOTE_SWEEP_APPLY_FROM is set.");
	}
	return out;
}

module.exports = {
	VOICE_FILE_RE,
	HEADER_MAX_CHARS,
	voiceNoteDir,
	newVoiceFileName,
	voiceFilePath,
	canPlayVoiceNote,
	voiceThreadRow,
	voiceThreadRows,
	messageHeader,
	idempotencyKey,
	storeVoiceFile,
	removeVoiceFile,
	sweepVoiceNotes,
};
