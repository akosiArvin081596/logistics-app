<template>
  <Transition name="banner-slide">
    <div v-if="notification" class="load-assigned-banner">
      <div class="banner-body">
        <div class="banner-icon">&#128666;</div>
        <div class="banner-text">
          <div class="banner-title">New Load Assigned</div>
          <div class="banner-load-id">{{ notification.loadId }}</div>
          <div v-if="route" class="banner-route">{{ route }}</div>
        </div>
        <button class="banner-close" @click="$emit('dismiss')">&times;</button>
      </div>
      <div class="banner-actions">
        <button class="banner-btn view" @click="$emit('view-load')">View Load</button>
        <button class="banner-btn dismiss" @click="$emit('dismiss')">Dismiss</button>
      </div>
      <div class="banner-timer">
        <div class="banner-timer-bar" :key="timerKey"></div>
      </div>
    </div>
  </Transition>
</template>

<script setup>
import { computed, watch, ref, onUnmounted } from 'vue'

const props = defineProps({
  notification: { type: Object, default: null }
})

const emit = defineEmits(['dismiss', 'view-load'])

const timerKey = ref(0)
let dismissTimer = null

const route = computed(() => {
  if (!props.notification) return ''
  const { origin, destination } = props.notification
  if (origin || destination) return `${origin || '\u2014'} \u2192 ${destination || '\u2014'}`
  return ''
})

// Web Audio notification sound
let audioCtx = null

function playSound() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)()
    audioCtx.resume().then(() => {
      const now = audioCtx.currentTime
      // First tone
      const osc1 = audioCtx.createOscillator()
      const gain1 = audioCtx.createGain()
      osc1.frequency.value = 523
      osc1.type = 'sine'
      gain1.gain.setValueAtTime(0.3, now)
      gain1.gain.exponentialRampToValueAtTime(0.01, now + 0.15)
      osc1.connect(gain1).connect(audioCtx.destination)
      osc1.start(now)
      osc1.stop(now + 0.15)

      // Second tone (higher)
      const osc2 = audioCtx.createOscillator()
      const gain2 = audioCtx.createGain()
      osc2.frequency.value = 659
      osc2.type = 'sine'
      gain2.gain.setValueAtTime(0.3, now + 0.18)
      gain2.gain.exponentialRampToValueAtTime(0.01, now + 0.35)
      osc2.connect(gain2).connect(audioCtx.destination)
      osc2.start(now + 0.18)
      osc2.stop(now + 0.35)
    })
  } catch {
    // Audio blocked — visual banner still works
  }
}

watch(() => props.notification, (val) => {
  if (val) {
    playSound()
    timerKey.value++
    clearTimeout(dismissTimer)
    dismissTimer = setTimeout(() => emit('dismiss'), 15000)
  }
}, { immediate: true })

onUnmounted(() => clearTimeout(dismissTimer))
</script>

<style scoped>
.load-assigned-banner {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 200;
  background: var(--blue, #3b82f6);
  color: #fff;
  padding: calc(env(safe-area-inset-top, 0px) + 1rem) 1rem 0;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.25);
}

.banner-body {
  display: flex;
  align-items: flex-start;
  gap: 0.75rem;
}

.banner-icon {
  font-size: 1.8rem;
  line-height: 1;
  flex-shrink: 0;
}

.banner-text {
  flex: 1;
  min-width: 0;
}

.banner-title {
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  opacity: 0.85;
  margin-bottom: 0.15rem;
}

.banner-load-id {
  font-size: 1.1rem;
  font-weight: 700;
}

.banner-route {
  font-size: 0.85rem;
  opacity: 0.9;
  margin-top: 0.2rem;
}

.banner-close {
  background: none;
  border: none;
  color: #fff;
  font-size: 1.5rem;
  line-height: 1;
  padding: 0 0.25rem;
  cursor: pointer;
  opacity: 0.7;
  flex-shrink: 0;
}
.banner-close:hover { opacity: 1; }

.banner-actions {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.85rem;
  padding-bottom: 0.85rem;
}

.banner-btn {
  flex: 1;
  padding: 0.55rem;
  border-radius: 8px;
  font-size: 0.82rem;
  font-weight: 600;
  cursor: pointer;
  border: none;
  transition: opacity 0.2s;
}
.banner-btn:active { opacity: 0.8; }

.banner-btn.view {
  background: #fff;
  color: var(--blue, #3b82f6);
}

.banner-btn.dismiss {
  background: rgba(255, 255, 255, 0.15);
  color: #fff;
  border: 1px solid rgba(255, 255, 255, 0.3);
}

.banner-timer {
  height: 3px;
  background: rgba(255, 255, 255, 0.2);
}

.banner-timer-bar {
  height: 100%;
  background: #fff;
  width: 100%;
  animation: timer-shrink 15s linear forwards;
}

@keyframes timer-shrink {
  from { width: 100%; }
  to { width: 0%; }
}

/* Slide transition */
.banner-slide-enter-active {
  transition: transform 0.3s ease-out;
}
.banner-slide-leave-active {
  transition: transform 0.25s ease-in;
}
.banner-slide-enter-from,
.banner-slide-leave-to {
  transform: translateY(-100%);
}
</style>
