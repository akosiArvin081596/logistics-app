<template>
  <div :class="['vn-player', { 'is-sent': sent }]" role="group" :aria-label="`Voice note, ${spokenDuration(durationSec)}`">
    <button
      type="button"
      class="vn-play"
      :aria-label="`Play voice note, ${spokenDuration(durationSec)}`"
      :aria-pressed="playing ? 'true' : 'false'"
      @click="toggle"
    >
      <Loader2 v-if="loading" class="vn-icon vn-spin" aria-hidden="true" />
      <Pause v-else-if="playing" class="vn-icon" aria-hidden="true" />
      <Play v-else class="vn-icon vn-icon-play" aria-hidden="true" />
    </button>
    <div class="vn-body">
      <input
        class="vn-seek"
        type="range"
        min="0"
        :max="durationSec"
        step="0.1"
        :value="position"
        :style="{ '--vn-pct': pct + '%' }"
        aria-label="Seek"
        :aria-valuetext="`${spokenDuration(position)} of ${spokenDuration(durationSec)}`"
        @input="seek($event.target.value)"
      />
      <div class="vn-meta">
        <span class="vn-time">{{ playing || position > 0 ? `${voiceNoteClock(position * 1000)} / ` : '' }}{{ voiceNoteClock(durationMs) }}</span>
        <button type="button" class="vn-rate" :aria-label="`Playback speed ${rate} times`" @click="cycleRate">{{ rate }}&times;</button>
      </div>
      <p v-if="error" class="vn-error" role="alert">{{ error }}</p>
    </div>
    <audio
      ref="audioEl"
      preload="none"
      @timeupdate="onTime"
      @ended="onEnded"
      @pause="playing = false"
      @play="playing = true"
      @waiting="loading = true"
      @playing="loading = false"
      @error="onError"
    />
  </div>
</template>

<script setup>
// One voice note's player (plan 2026-10-22, sections 2 and 9). The length shown
// is the one the server measured (`durationMs`, voice_duration_ms), never the
// <audio> element's own: a recorded MP4 can report Infinity until it has been
// read to the end. Nothing is fetched until Play: the source is set in the tap
// itself (iOS plays only from a user gesture), from `src`, which the caller
// builds with voiceNoteSrc() for a sent note (GET /api/messages/<id>/voice,
// checked per reader) or a blob: URL for a clip being reviewed.
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import { Play, Pause, Loader2 } from 'lucide-vue-next'
import { voiceNoteClock } from '../../lib/voiceNoteText'
import { claimPlayback, releasePlayback, spokenDuration } from '../../lib/voiceNotes'

const props = defineProps({
  src: { type: String, required: true },
  durationMs: { type: Number, required: true },
  // Inside the sender's own (accent-coloured) bubble.
  sent: { type: Boolean, default: false },
})

const audioEl = ref(null)
const playing = ref(false)
const loading = ref(false)
const position = ref(0)
const error = ref('')
const rate = ref(1)
let loaded = false

const durationSec = computed(() => Math.max(0, (Number(props.durationMs) || 0) / 1000))
const pct = computed(() => (durationSec.value > 0 ? Math.min(100, (position.value / durationSec.value) * 100) : 0))

const PLAY_ERROR = "Can't play this voice note. Tap play to try again."

async function toggle() {
  const a = audioEl.value
  if (!a) return
  error.value = ''
  if (playing.value) { a.pause(); return }
  if (!loaded) {
    a.src = props.src
    loaded = true
  }
  if (position.value >= durationSec.value) position.value = 0
  try {
    a.currentTime = position.value
    a.playbackRate = rate.value
    claimPlayback(a)
    loading.value = true
    await a.play()
  } catch {
    error.value = PLAY_ERROR
    loaded = false
  } finally {
    loading.value = false
  }
}

function seek(v) {
  position.value = Math.min(durationSec.value, Math.max(0, Number(v) || 0))
  const a = audioEl.value
  if (a && loaded) a.currentTime = position.value
}

function cycleRate() {
  rate.value = rate.value === 1 ? 1.5 : rate.value === 1.5 ? 2 : 1
  if (audioEl.value) audioEl.value.playbackRate = rate.value
}

function onTime() {
  const t = audioEl.value ? Number(audioEl.value.currentTime) : 0
  position.value = Number.isFinite(t) ? Math.min(t, durationSec.value) : 0
}
function onEnded() {
  playing.value = false
  position.value = durationSec.value
}
function onError() {
  if (!loaded) return
  error.value = PLAY_ERROR
  loaded = false
  playing.value = false
  loading.value = false
}

// Another clip (a re-recorded review): start over.
watch(() => props.src, () => {
  const a = audioEl.value
  if (a && playing.value) a.pause()
  loaded = false
  position.value = 0
  error.value = ''
})

onBeforeUnmount(() => {
  const a = audioEl.value
  if (a) {
    if (playing.value) a.pause()
    releasePlayback(a)
  }
})
</script>

<style scoped>
.vn-player {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  min-width: 200px;
  max-width: 280px;
  --vn-track: var(--border, #d4d4d8);
  --vn-fill: var(--accent, #6366f1);
  --vn-btn-bg: var(--accent, #6366f1);
  --vn-btn-fg: #fff;
  --vn-dim: var(--text-dim, #71717a);
}
.vn-player.is-sent {
  --vn-track: rgba(255, 255, 255, 0.35);
  --vn-fill: #fff;
  --vn-btn-bg: #fff;
  --vn-btn-fg: var(--accent, #6366f1);
  --vn-dim: rgba(255, 255, 255, 0.85);
}
.vn-play {
  flex-shrink: 0;
  width: var(--vn-play-size, 40px);
  height: var(--vn-play-size, 40px);
  border-radius: 50%;
  border: none;
  background: var(--vn-btn-bg);
  color: var(--vn-btn-fg);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.vn-play:focus-visible, .vn-rate:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
.vn-icon { width: 18px; height: 18px; }
.vn-icon-play { margin-left: 2px; }
.vn-spin { animation: vn-spin 0.9s linear infinite; }
@keyframes vn-spin { to { transform: rotate(360deg); } }
.vn-body { flex: 1; min-width: 0; }
.vn-seek {
  -webkit-appearance: none;
  appearance: none;
  width: 100%;
  height: 4px;
  border-radius: 2px;
  background: linear-gradient(to right, var(--vn-fill) var(--vn-pct, 0%), var(--vn-track) var(--vn-pct, 0%));
  outline: none;
  margin: 0.45rem 0 0.3rem;
  cursor: pointer;
}
.vn-seek::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--vn-fill);
  border: none;
}
.vn-seek::-moz-range-thumb { width: 14px; height: 14px; border-radius: 50%; background: var(--vn-fill); border: none; }
.vn-seek:focus-visible { box-shadow: 0 0 0 2px var(--vn-fill); }
.vn-meta { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
.vn-time {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.68rem;
  color: var(--vn-dim);
  font-variant-numeric: tabular-nums;
}
.vn-rate {
  border: 1px solid var(--vn-track);
  background: transparent;
  color: var(--vn-dim);
  border-radius: 10px;
  font-size: 0.62rem;
  font-weight: 700;
  padding: 0.05rem 0.45rem;
  cursor: pointer;
  /* The driver app sets 44 px (touch targets there). */
  min-height: var(--vn-rate-size, 24px);
  min-width: var(--vn-rate-size, 36px);
}
.vn-error { margin: 0.25rem 0 0; font-size: 0.7rem; color: var(--danger, #b91c1c); }
.is-sent .vn-error { color: #fff; }
@media (prefers-reduced-motion: reduce) {
  .vn-spin { animation: none; }
}
</style>
