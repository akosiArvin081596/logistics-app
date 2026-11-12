<template>
  <!-- "What's new" after a release, and a first-time driver's tour offer. DriverView decides when
       (noteMoment()); this only shows the words and says which answer was tapped. Nothing but
       "I acknowledge" closes the note: no close mark, and a tap outside it does nothing. -->
  <van-popup
    :show="!!view"
    round
    teleport="body"
    :close-on-click-overlay="false"
    :close-on-popstate="false"
    :style="{ width: 'min(92%, 380px)' }"
  >
    <div v-if="view" class="drn" role="dialog" aria-modal="true" aria-labelledby="drn-title" data-testid="release-dialog">
      <template v-if="view.mode === 'notes'">
        <h2 id="drn-title" class="drn-title" data-testid="release-heading">{{ WORDS.notesHeading }}</h2>
        <section v-for="entry in view.entries" :key="entry.id" class="drn-entry" data-testid="release-entry">
          <h3 class="drn-entry-title" data-testid="release-entry-title">{{ entry.title }}</h3>
          <ul class="drn-lines">
            <li v-for="line in entry.lines" :key="line" data-testid="release-line">{{ line }}</li>
          </ul>
        </section>
        <p v-if="view.canShowMe" class="drn-text">{{ WORDS.notesEncourage }}</p>
        <p class="drn-text drn-ack-line" data-testid="release-acknowledge-line">{{ WORDS.acknowledgeLine }}</p>
        <van-button
          round block type="primary" native-type="button" class="drn-primary" data-testid="release-acknowledge"
          :loading-text="WORDS.acknowledge" :loading="view.saving" :disabled="view.saving" @click="emit('acknowledge')"
        >{{ WORDS.acknowledge }}</van-button>
        <button
          v-if="view.canShowMe" type="button" class="drn-second" data-testid="release-show-me"
          :disabled="view.saving" @click="emit('show-me')"
        >{{ WORDS.showMeFirst }}</button>
        <p v-if="view.whenParked" class="drn-text drn-when-parked" role="status" data-testid="release-when-parked">{{ WORDS.whenParked }}</p>
      </template>
      <template v-else>
        <h2 id="drn-title" class="drn-title" data-testid="release-heading">{{ WORDS.offerHeading }}</h2>
        <p class="drn-text">{{ WORDS.offerText }}</p>
        <van-button round block type="primary" native-type="button" class="drn-primary" data-testid="release-take-tour" @click="emit('take-tour')">{{ WORDS.takeTour }}</van-button>
        <button type="button" class="drn-second" data-testid="release-skip-offer" @click="emit('skip-offer')">{{ WORDS.skipOffer }}</button>
      </template>
    </div>
  </van-popup>
</template>

<script setup>
import { Popup as VanPopup, Button as VanButton } from 'vant'
import { WORDS } from '../../lib/driverReleaseNotices'

defineProps({
  view: { type: Object, default: null },
})
const emit = defineEmits(['acknowledge', 'show-me', 'take-tour', 'skip-offer'])
</script>

<style scoped>
.drn { padding: 1.3rem 1.25rem 1rem; background: #fff; max-height: 80vh; overflow-y: auto; }
.drn-title { margin: 0 0 0.6rem; font-size: 1.1rem; font-weight: 800; color: #0f172a; text-align: center; }
.drn-entry { margin-bottom: 0.75rem; }
.drn-entry-title { margin: 0 0 0.35rem; font-size: 0.92rem; font-weight: 700; color: #0f172a; }
.drn-lines { margin: 0; padding-left: 1.1rem; font-size: 0.88rem; line-height: 1.5; color: #334155; }
.drn-lines li { margin-bottom: 0.35rem; }
.drn-text { margin: 0 0 0.9rem; font-size: 0.88rem; line-height: 1.5; color: #475569; text-align: center; }
.drn-primary { min-height: 44px; }
.drn-second {
  display: block; width: 100%; min-height: 44px; margin-top: 0.4rem;
  border: none; background: none; color: #475569; font-family: inherit;
  font-size: 0.88rem; font-weight: 600; cursor: pointer;
}
.drn-second:focus-visible { outline: 2px solid #1d4ed8; outline-offset: 2px; border-radius: 8px; }
.drn-second:disabled { opacity: 0.5; cursor: default; }
.drn-ack-line { color: #0f172a; font-weight: 600; }
.drn-when-parked { margin: 0.6rem 0 0; color: #92400e; font-weight: 600; }
</style>
