<template>
  <!-- Asks a driver with fewer than two emergency contacts on file to add them.
       DriverView decides when (contactsPromptDue()); this only shows the question
       and says which answer was tapped. It reads and keeps nothing. -->
  <van-popup
    :show="show"
    round
    teleport="body"
    :close-on-click-overlay="false"
    :style="{ width: 'min(92%, 360px)' }"
  >
    <div class="ecq" role="dialog" aria-modal="true" aria-labelledby="ecq-title" data-testid="ec-prompt">
      <div class="ecq-icon" aria-hidden="true">&#128222;</div>
      <h2 id="ecq-title" class="ecq-title">Add your emergency contacts</h2>
      <p class="ecq-text">LogisX keeps at least two people we can call if something happens to you on the road. It takes about two minutes.</p>
      <van-button round block type="primary" native-type="button" class="ecq-add" data-testid="ec-prompt-add" @click="emit('add')">Add now</van-button>
      <button type="button" class="ecq-later" data-testid="ec-prompt-later" @click="emit('later')">Remind me later</button>
    </div>
  </van-popup>
</template>

<script setup>
import { Popup as VanPopup, Button as VanButton } from 'vant'

defineProps({
  show: { type: Boolean, default: false },
})
const emit = defineEmits(['add', 'later'])
</script>

<style scoped>
.ecq { padding: 1.4rem 1.25rem 1rem; text-align: center; background: #fff; }
.ecq-icon { font-size: 2rem; line-height: 1; }
.ecq-title { margin: 0.6rem 0 0.4rem; font-size: 1.08rem; font-weight: 800; color: #0f172a; }
.ecq-text { margin: 0 0 1.1rem; font-size: 0.88rem; line-height: 1.5; color: #475569; }
.ecq-add { min-height: 44px; }
.ecq-later {
  display: block; width: 100%; min-height: 44px; margin-top: 0.4rem;
  border: none; background: none; color: #475569; font-family: inherit;
  font-size: 0.88rem; font-weight: 600; cursor: pointer;
}
.ecq-later:focus-visible { outline: 2px solid #1d4ed8; outline-offset: 2px; border-radius: 8px; }
</style>
