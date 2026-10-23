<template>
  <div :class="['vn-recorder', { 'is-open': open }]">
    <!-- A browser that cannot record AAC/MP4 (Firefox, Chrome on Linux): a
         short note instead of the mic. Notes still play there. -->
    <p v-if="!rec.supported" class="vn-unsupported">{{ VOICE_NOTE_UNSUPPORTED }}</p>

    <!-- Idle: the mic. While the truck moves it is natively disabled (no tap
         reaches it) and described by the note under the composer. -->
    <button
      v-else-if="!open"
      type="button"
      :class="['vn-mic', { 'is-blocked': blocked }]"
      :disabled="blocked || phase === 'starting'"
      :aria-label="blocked ? 'Record a voice note (off while the truck is moving)' : 'Record a voice note'"
      :aria-describedby="describedBy || undefined"
      :title="blocked ? 'Voice notes are off while the truck is moving' : 'Record a voice note'"
      @click="onMic"
    >
      <MicOff v-if="blocked" class="vn-ic" aria-hidden="true" />
      <Loader2 v-else-if="phase === 'starting'" class="vn-ic vn-spin" aria-hidden="true" />
      <Mic v-else class="vn-ic" aria-hidden="true" />
    </button>

    <!-- Recording, then review: the panel takes the composer row. -->
    <div v-else class="vn-panel" role="group" aria-label="Voice note">
      <button type="button" class="vn-ghost" aria-label="Discard voice note" :disabled="sending" @click="onDiscard">
        <Trash2 class="vn-ic" aria-hidden="true" />
      </button>

      <div v-if="phase === 'recording'" class="vn-live">
        <span class="vn-dot" aria-hidden="true" />
        <span class="vn-live-label">Recording</span>
        <span class="vn-bars" aria-hidden="true">
          <span v-for="(h, i) in rec.levels.value" :key="i" class="vn-bar" :style="{ height: Math.max(12, h) + '%' }" />
        </span>
        <span class="vn-clock">{{ voiceNoteClock(rec.elapsedMs.value) }} / {{ voiceNoteClock(VOICE_NOTE_MAX_MS) }}</span>
      </div>
      <div v-else-if="clip" class="vn-review">
        <VoiceNotePlayer :src="clip.url" :duration-ms="clip.durationMs" />
      </div>

      <button
        v-if="phase === 'recording'"
        type="button"
        class="vn-stop"
        aria-label="Stop recording"
        @click="rec.stop('user')"
      >
        <Square class="vn-ic vn-ic-sm" aria-hidden="true" />
      </button>
      <button
        v-else-if="clip"
        type="button"
        class="vn-send"
        :disabled="blocked || sending"
        :aria-label="`Send voice note, ${voiceNoteClock(clip.durationMs)}`"
        :aria-describedby="blocked && describedBy ? describedBy : undefined"
        @click="onSend"
      >
        <Loader2 v-if="sending" class="vn-ic vn-spin" aria-hidden="true" />
        <SendHorizontal v-else class="vn-ic" aria-hidden="true" />
      </button>
    </div>

    <!-- Why the last try failed (the clip is kept), or why recording could not
         start. Floats above the composer row. -->
    <p v-if="message" class="vn-error" role="alert">
      <span>{{ message }}</span>
      <button type="button" class="vn-error-x" aria-label="Dismiss" @click="dismiss">&times;</button>
    </p>
    <span class="vn-sr" aria-live="polite">{{ live }}</span>
  </div>
</template>

<script setup>
// The record control of a composer (plan 2026-10-22, sections 2, 6 and 9):
// mic -> recording (red dot, "Recording", level, clock, Stop) -> review (play
// it back, Discard or Send). `send(clip)` is the caller's upload; it throws on
// failure, and the clip stays here with the reason, so Send tries again with
// the same clip and the same key.
//
// `blocked` (the driver app while the truck moves or has just stopped): the mic
// is natively disabled; a recording in progress stops and is kept for review;
// Send stays disabled until the truck is parked again.
import { ref, computed, watch } from 'vue'
import { Mic, MicOff, Square, Trash2, SendHorizontal, Loader2 } from 'lucide-vue-next'
import VoiceNotePlayer from './VoiceNotePlayer.vue'
import { useVoiceRecorder } from '../../composables/useVoiceRecorder'
import { voiceNoteClock } from '../../lib/voiceNoteText'
import { VOICE_NOTE_MAX_MS, VOICE_NOTE_UNSUPPORTED, voiceSendFailure } from '../../lib/voiceNotes'

const props = defineProps({
  send: { type: Function, required: true },
  blocked: { type: Boolean, default: false },
  // The id of the note that explains the blocked state.
  describedBy: { type: String, default: '' },
})
const emit = defineEmits(['active'])

const rec = useVoiceRecorder()
const phase = computed(() => rec.phase.value)
const clip = computed(() => rec.clip.value)
const open = computed(() => phase.value === 'recording' || phase.value === 'review')
const sending = ref(false)
const sendError = ref('')
const sentNotice = ref('')

const message = computed(() => sendError.value || rec.error.value)
const live = computed(() => sentNotice.value || rec.announcement.value)

watch(open, (v) => emit('active', v), { immediate: true })

watch(() => props.blocked, (b) => {
  if (b && phase.value === 'recording') rec.stop('blocked')
})

function dismiss() {
  sendError.value = ''
  rec.error.value = ''
}

function onMic() {
  if (props.blocked || !rec.supported) return
  dismiss()
  sentNotice.value = ''
  rec.start()
}

function onDiscard() {
  if (sending.value) return
  dismiss()
  rec.discard()
}

async function onSend() {
  const c = clip.value
  if (!c || props.blocked || sending.value) return
  sending.value = true
  sendError.value = ''
  try {
    await props.send(c)
    rec.discard()
    sentNotice.value = 'Voice note sent'
  } catch (err) {
    sendError.value = voiceSendFailure(err)
  } finally {
    sending.value = false
  }
}
</script>

<style scoped>
.vn-recorder { position: relative; display: flex; align-items: center; flex-shrink: 0; }
.vn-recorder.is-open { flex: 1; min-width: 0; }
.vn-mic {
  width: var(--vn-size, 40px);
  height: var(--vn-size, 40px);
  flex-shrink: 0;
  border-radius: 50%;
  border: 1px solid var(--border, #d4d4d8);
  background: var(--surface, #fff);
  color: var(--text, #18181b);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.vn-mic:hover:not(:disabled) { border-color: var(--accent, #6366f1); color: var(--accent, #6366f1); }
.vn-mic:disabled { opacity: 0.45; cursor: not-allowed; }
.vn-ic { width: 18px; height: 18px; }
.vn-ic-sm { width: 14px; height: 14px; fill: currentColor; }
.vn-mic:focus-visible, .vn-ghost:focus-visible, .vn-stop:focus-visible, .vn-send:focus-visible, .vn-error-x:focus-visible {
  outline: 2px solid var(--accent, #6366f1);
  outline-offset: 2px;
}
.vn-unsupported {
  margin: 0;
  max-width: 9.5rem;
  font-size: 0.68rem;
  line-height: 1.25;
  color: var(--text-dim, #71717a);
}
.vn-panel { flex: 1; min-width: 0; display: flex; align-items: center; gap: 0.5rem; }
.vn-ghost {
  width: var(--vn-size, 40px);
  height: var(--vn-size, 40px);
  flex-shrink: 0;
  border-radius: 50%;
  border: none;
  background: transparent;
  color: var(--text-dim, #71717a);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.vn-ghost:hover:not(:disabled) { color: var(--danger, #b91c1c); background: var(--danger-dim, #fef2f2); }
.vn-live {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0 0.75rem;
  height: var(--vn-size, 40px);
  border-radius: 20px;
  background: var(--danger-dim, #fef2f2);
  color: var(--danger, #b91c1c);
  overflow: hidden;
}
.vn-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: currentColor;
  flex-shrink: 0;
  animation: vn-pulse 1.2s ease-in-out infinite;
}
@keyframes vn-pulse { 50% { opacity: 0.25; } }
.vn-live-label { font-size: 0.78rem; font-weight: 700; white-space: nowrap; flex-shrink: 1; min-width: 0; overflow: hidden; }
.vn-bars { flex: 1; min-width: 0; height: 22px; display: flex; align-items: center; gap: 2px; overflow: hidden; }
.vn-bar { width: 3px; min-height: 3px; border-radius: 2px; background: currentColor; opacity: 0.55; transition: height 0.12s ease-out; }
.vn-clock { font-family: 'JetBrains Mono', monospace; font-size: 0.72rem; font-variant-numeric: tabular-nums; flex-shrink: 0; }
.vn-review {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  padding: 0.15rem 0.75rem;
  border-radius: 20px;
  background: var(--bg, #f4f4f5);
}
.vn-review :deep(.vn-player) { max-width: none; min-width: 0; width: 100%; --vn-play-size: 32px; }
.vn-stop, .vn-send {
  width: var(--vn-size, 40px);
  height: var(--vn-size, 40px);
  flex-shrink: 0;
  border-radius: 50%;
  border: none;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  color: #fff;
}
.vn-stop { background: var(--danger, #b91c1c); }
.vn-send { background: var(--accent, #6366f1); }
.vn-send:disabled { opacity: 0.45; cursor: not-allowed; }
.vn-spin { animation: vn-spin 0.9s linear infinite; }
@keyframes vn-spin { to { transform: rotate(360deg); } }
.vn-error {
  position: absolute;
  right: 0;
  bottom: calc(100% + 6px);
  z-index: 5;
  width: max-content;
  max-width: min(320px, 80vw);
  margin: 0;
  display: flex;
  align-items: flex-start;
  gap: 0.4rem;
  padding: 0.45rem 0.6rem;
  border-radius: 8px;
  background: #fef2f2;
  border: 1px solid #fecaca;
  color: #b91c1c;
  font-size: 0.75rem;
  line-height: 1.3;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
}
.vn-error-x { border: none; background: none; color: inherit; font-size: 1rem; line-height: 1; cursor: pointer; padding: 0 0.15rem; min-width: 24px; min-height: 24px; }
.vn-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
@media (prefers-reduced-motion: reduce) {
  .vn-dot, .vn-spin { animation: none; }
  .vn-bar { transition: none; }
}
</style>
