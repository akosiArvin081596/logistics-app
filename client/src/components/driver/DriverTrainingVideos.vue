<template>
  <!-- The training videos (DRIVER_TRAINING_VIDEOS_ENABLED). DriverView renders this
       only where the payload's `trainingVideos` says: "onboarding" on the lock
       screen, "kit" on the Kit tab. Nothing reaches YouTube until the driver taps
       the player, and the YouTube link always shows, since a refused frame can't be
       detected. -->
  <section :class="['card', 'tv-card', `tv-card-${variant}`]" :aria-labelledby="headingId" data-testid="training-videos" :data-variant="variant">
    <h2 :id="headingId" class="tv-heading">{{ TRAINING_VIDEOS_HEADING }}</h2>
    <p class="tv-intro">{{ intro }}</p>

    <figure class="tv-item" data-testid="tv-eld">
      <figcaption class="tv-caption">
        <span class="tv-title">{{ numbered ? '1. ' : '' }}{{ ELD_VIDEO_TITLE }}</span>
        <span class="tv-sub">{{ ELD_VIDEO_SUB }}</span>
      </figcaption>
      <div class="tv-frame">
        <iframe
          v-if="playing"
          ref="frameEl"
          class="tv-iframe"
          :title="ROUTEMATE_FRAME_TITLE"
          :sandbox="ROUTEMATE_FRAME_SANDBOX"
          :referrerpolicy="ROUTEMATE_FRAME_REFERRER_POLICY"
          :allow="ROUTEMATE_FRAME_ALLOW"
          allowfullscreen
          :src="embedUrl"
        ></iframe>
        <button v-else type="button" class="tv-facade" :aria-label="ELD_PLAY_NAME" data-testid="tv-eld-play" @click="play">
          <svg class="tv-play-icon" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
            <circle cx="32" cy="32" r="29" />
            <path d="M26 20 L46 32 L26 44 Z" />
          </svg>
          <span class="tv-facade-text">{{ ELD_PLAY_LABEL }}</span>
        </button>
      </div>
      <p class="tv-note">{{ ELD_DATA_NOTE }}</p>
      <a class="tv-link" :href="ROUTEMATE_WATCH_URL" target="_blank" rel="noopener noreferrer" data-testid="tv-eld-link">{{ ELD_LINK_TEXT }}</a>
    </figure>

    <figure v-if="walkthrough" class="tv-item" data-testid="tv-walkthrough">
      <figcaption class="tv-caption">
        <span class="tv-title">2. {{ WALKTHROUGH_TITLE }}</span>
        <span class="tv-sub">{{ WALKTHROUGH_SUB }}</span>
      </figcaption>
      <!-- No playsinline: an iPhone plays it full screen, where the portrait
           recording is legible. No bytes load until play (preload none). -->
      <div class="tv-portrait">
        <video class="tv-video" controls preload="none" :poster="walkthrough.poster" :aria-describedby="noteId">
          <source :src="walkthrough.mp4" type="video/mp4">
          <track kind="captions" srclang="en" label="English" :src="walkthrough.vtt" default>
          <a :href="walkthrough.mp4">Open the video file</a>
        </video>
      </div>
      <p :id="noteId" class="tv-note">{{ walkthroughNote }}</p>
      <details class="tv-steps" @toggle="onStepsToggle">
        <summary class="tv-steps-summary">Read the steps</summary>
        <p v-if="steps.state === 'loading'" class="tv-note">Loading the steps…</p>
        <p v-else-if="steps.state === 'failed'" class="tv-note">The steps couldn't be loaded. The video's captions say the same.</p>
        <ol v-else-if="steps.state === 'ready'" class="tv-steps-list">
          <li v-for="(cue, i) in steps.cues" :key="i">{{ cue.text }}</li>
        </ol>
      </details>
      <a class="tv-link" :href="walkthrough.mp4" data-testid="tv-walkthrough-link">{{ WALKTHROUGH_LINK_TEXT }}</a>
    </figure>
  </section>
</template>

<script setup>
import { computed, nextTick, reactive, ref, useId } from 'vue'
import {
  ROUTEMATE_FRAME_ALLOW, ROUTEMATE_FRAME_REFERRER_POLICY, ROUTEMATE_FRAME_SANDBOX, ROUTEMATE_FRAME_TITLE, ROUTEMATE_WATCH_URL,
  TRAINING_VIDEOS_HEADING, ELD_VIDEO_TITLE, ELD_VIDEO_SUB, ELD_PLAY_LABEL, ELD_PLAY_NAME, ELD_DATA_NOTE, ELD_LINK_TEXT,
  WALKTHROUGH_TITLE, WALKTHROUGH_SUB, WALKTHROUGH_LINK_TEXT, WALKTHROUGH_APPROX_MB,
  routemateEmbedUrl, trainingVideosIntro, walkthroughDataNote, parseVttCues,
} from '../../lib/driverVideos'
import { walkthrough } from '../../lib/driverVideoAssets'

const props = defineProps({
  // "onboarding" (the lock screen) or "kit" (the Kit tab): only the intro differs.
  variant: { type: String, default: 'kit' },
})

const headingId = useId()
const noteId = useId()
const numbered = !!walkthrough
const intro = computed(() => trainingVideosIntro(props.variant, walkthrough ? 2 : 1))
const embedUrl = routemateEmbedUrl()
const walkthroughNote = [walkthroughDataNote(WALKTHROUGH_APPROX_MB), 'Tap ⛶ for full screen.'].filter(Boolean).join(' ')

// The player frame exists only after the tap; focus then moves into it.
const playing = ref(false)
const frameEl = ref(null)
async function play() {
  playing.value = true
  await nextTick()
  frameEl.value?.focus()
}

// The transcript: the captions file (same origin, small) is read the first time
// "Read the steps" opens, never before.
const steps = reactive({ state: 'idle', cues: [] })
async function onStepsToggle(event) {
  if (!event.target.open || steps.state !== 'idle' || !walkthrough) return
  steps.state = 'loading'
  try {
    const res = await fetch(walkthrough.vtt, { credentials: 'same-origin' })
    if (!res.ok) throw new Error(`captions answered ${res.status}`)
    const cues = parseVttCues(await res.text())
    steps.cues = cues
    steps.state = cues.length ? 'ready' : 'failed'
  } catch {
    steps.state = 'failed'
  }
}
</script>

<style scoped>
.tv-card-kit {
  margin-top: 1rem;
}
.tv-heading {
  font-size: 0.95rem;
  font-weight: 800;
  margin: 0 0 0.25rem;
}
.tv-intro {
  font-size: 0.82rem;
  color: var(--text-dim);
  line-height: 1.5;
  margin: 0 0 0.75rem;
}
.tv-item {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  min-width: 0;
  margin: 0;
}
.tv-item + .tv-item {
  margin-top: 1rem;
  padding-top: 1rem;
  border-top: 1px solid var(--border);
}
.tv-caption {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
}
.tv-title {
  font-size: 0.88rem;
  font-weight: 700;
  color: var(--text);
  overflow-wrap: anywhere;
}
.tv-sub {
  font-size: 0.75rem;
  color: var(--text-dim);
}
.tv-frame {
  position: relative;
  width: 100%;
  aspect-ratio: 16 / 9;
  border-radius: 12px;
  overflow: hidden;
  background: #0f172a;
}
.tv-iframe,
.tv-facade {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  border: 0;
}
.tv-facade {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  padding: 0.75rem;
  background: #0f172a;
  color: #fff;
  font-family: inherit;
  font-size: 0.9rem;
  font-weight: 700;
  text-align: center;
  cursor: pointer;
}
/* Drawn inside the frame: its rounded clip would cut an outside ring. */
.tv-facade:focus-visible {
  outline: 3px solid #fff;
  outline-offset: -7px;
}
.tv-play-icon {
  width: 56px;
  height: 56px;
  flex-shrink: 0;
}
.tv-play-icon circle {
  fill: rgba(255, 255, 255, 0.14);
  stroke: #fff;
  stroke-width: 3;
}
.tv-play-icon path {
  fill: #fff;
}
.tv-note {
  font-size: 0.75rem;
  color: var(--text-dim);
  line-height: 1.45;
  margin: 0;
}
.tv-link {
  display: inline-flex;
  align-items: center;
  align-self: flex-start;
  min-height: 44px;
  max-width: 100%;
  font-size: 0.82rem;
  font-weight: 600;
  color: #0369a1;
  text-decoration: underline;
  overflow-wrap: anywhere;
}
.tv-link:focus-visible {
  outline: 2px solid #0369a1;
  outline-offset: 2px;
  border-radius: 4px;
}
.tv-portrait {
  width: min(100%, calc(60vh * 390 / 844));
  width: min(100%, calc(60dvh * 390 / 844));
  aspect-ratio: 390 / 844;
  margin: 0 auto;
  border-radius: 12px;
  overflow: hidden;
  background: #0f172a;
}
.tv-video {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: #0f172a;
}
.tv-steps-summary {
  padding: 0.8rem 0;
  font-size: 0.82rem;
  font-weight: 600;
  line-height: 1.5;
  color: #0369a1;
  cursor: pointer;
}
.tv-steps-summary:focus-visible {
  outline: 2px solid #0369a1;
  outline-offset: 2px;
  border-radius: 4px;
}
.tv-steps-list {
  margin: 0 0 0.25rem;
  padding-left: 1.2rem;
  font-size: 0.82rem;
  line-height: 1.5;
}
</style>
