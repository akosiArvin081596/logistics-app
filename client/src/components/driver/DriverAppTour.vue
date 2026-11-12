<template>
  <!-- A card over the real screens. The clear layer behind it keeps a tap from reaching what's
       underneath, so the tour can't change a status or send anything: only Next and Skip work. -->
  <div class="tour-shield" data-testid="tour-shield"></div>
  <div class="tour-card" role="dialog" aria-labelledby="tour-title" data-testid="tour-card" @keydown.esc="emit('skip')">
    <div class="tour-label" data-testid="tour-label">{{ view.label }}</div>
    <h3 id="tour-title" class="tour-title" data-testid="tour-title">{{ view.title }}</h3>
    <p class="tour-text" data-testid="tour-text">{{ view.text }}</p>
    <div class="tour-actions">
      <button type="button" class="tour-skip" data-testid="tour-skip" @click="emit('skip')">{{ WORDS.tourSkip }}</button>
      <button ref="nextBtn" type="button" class="tour-next" data-testid="tour-next" @click="emit('next')">{{ view.last ? WORDS.tourDone : WORDS.tourNext }}</button>
    </div>
    <button v-if="view.last && videos" type="button" class="tour-videos" data-testid="tour-videos" @click="emit('videos')">{{ WORDS.tourVideos }}</button>
  </div>
</template>

<script setup>
import { onMounted, ref, watch } from 'vue'
import { WORDS } from '../../lib/driverReleaseNotices'

const props = defineProps({
  view: { type: Object, required: true },
  videos: { type: Boolean, default: false },
})
const emit = defineEmits(['next', 'skip', 'videos'])

// The keyboard follows the card, so Enter walks the tour and Escape leaves it.
const nextBtn = ref(null)
onMounted(() => nextBtn.value?.focus())
watch(() => props.view.label, () => nextBtn.value?.focus())
</script>

<style scoped>
/* Below LoadAssignedBanner (200), so a new load's banner can still be read and tapped. */
.tour-shield { position: fixed; inset: 0; z-index: 150; background: transparent; }
.tour-card {
  position: fixed; z-index: 160;
  left: 50%; transform: translateX(-50%);
  bottom: calc(60px + env(safe-area-inset-bottom, 0px));
  width: min(92%, 420px); max-height: 60vh; overflow-y: auto;
  padding: 0.9rem 1rem 0.8rem; border-radius: 14px; background: #fff;
  box-shadow: 0 10px 34px rgba(15, 23, 42, 0.32), 0 0 0 1px rgba(15, 23, 42, 0.08);
}
.tour-label { font-size: 0.72rem; font-weight: 700; color: #475569; letter-spacing: 0.02em; }
.tour-title { margin: 0.15rem 0 0.3rem; font-size: 1rem; font-weight: 800; color: #0f172a; }
.tour-text { margin: 0 0 0.7rem; font-size: 0.88rem; line-height: 1.5; color: #334155; }
.tour-actions { display: flex; gap: 0.5rem; }
.tour-skip, .tour-next, .tour-videos { min-height: 44px; border-radius: 10px; font-family: inherit; font-size: 0.88rem; font-weight: 700; cursor: pointer; }
.tour-skip { flex: 0 0 34%; border: 1px solid #cbd5e1; background: #fff; color: #475569; }
.tour-next { flex: 1; border: none; background: #0369a1; color: #fff; }
.tour-videos { display: block; width: 100%; margin-top: 0.45rem; border: none; background: none; color: #0369a1; }
.tour-skip:focus-visible, .tour-next:focus-visible, .tour-videos:focus-visible { outline: 2px solid #1d4ed8; outline-offset: 2px; }
</style>
