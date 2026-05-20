<template>
  <div class="route-alts">
    <div class="alts-scroll">
      <button
        v-for="(alt, i) in alternatives"
        :key="i"
        :class="['alt-card', { active: i === selectedIdx, recommended: i === recommendedIdx }]"
        @click="$emit('select', i)"
      >
        <div v-if="i === recommendedIdx" class="alt-badge">Recommended</div>
        <div class="alt-eta">{{ formatEta(alt.etaMinutes) }}</div>
        <div class="alt-dist">{{ alt.distanceMiles }} mi</div>
        <div class="alt-meta">
          <span v-if="alt.fuelLiters != null" class="alt-meta-item">
            <span class="alt-meta-icon">⛽</span>{{ formatGallons(alt.fuelLiters) }} gal
          </span>
          <span v-else class="alt-meta-item alt-meta-dim">⛽ —</span>
          <span v-if="alt.tollPriceUsd != null && alt.tollPriceUsd > 0" class="alt-meta-item alt-toll">
            <span class="alt-meta-icon">💰</span>${{ alt.tollPriceUsd.toFixed(2) }}
          </span>
          <span v-else-if="alt.tollPriceUsd != null" class="alt-meta-item alt-tollfree">Toll-free</span>
        </div>
        <div v-if="i === selectedIdx" class="alt-check">✓</div>
      </button>
    </div>
  </div>
</template>

<script setup>
defineProps({
  alternatives: { type: Array, required: true },
  recommendedIdx: { type: Number, default: 0 },
  selectedIdx: { type: Number, default: 0 },
})
defineEmits(['select'])

function formatEta(minutes) {
  if (minutes == null) return '—'
  const m = Math.round(minutes)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

function formatGallons(liters) {
  if (liters == null) return '—'
  return (liters * 0.264172).toFixed(1)
}
</script>

<style scoped>
.route-alts { width: 100%; }
.alts-scroll {
  display: flex;
  gap: 0.6rem;
  overflow-x: auto;
  padding: 0.25rem 0.1rem 0.5rem;
  scroll-snap-type: x mandatory;
  -webkit-overflow-scrolling: touch;
}
.alts-scroll::-webkit-scrollbar { height: 4px; }
.alts-scroll::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.15); border-radius: 2px; }

.alt-card {
  position: relative;
  flex: 0 0 auto;
  min-width: 140px;
  background: var(--bg, #f5f6fa);
  border: 2px solid transparent;
  border-radius: 10px;
  padding: 0.75rem 0.9rem 0.7rem;
  text-align: left;
  cursor: pointer;
  scroll-snap-align: start;
  transition: border-color 0.15s, background 0.15s, transform 0.05s;
  color: var(--text, #1f2937);
}
.alt-card:hover { background: #eef0f5; }
.alt-card:active { transform: scale(0.98); }
.alt-card.active {
  border-color: #2563eb;
  background: #eff6ff;
}
.alt-card.recommended { box-shadow: 0 0 0 1px #16a34a inset; }
.alt-card.recommended.active { box-shadow: none; }

.alt-badge {
  position: absolute;
  top: -7px;
  left: 8px;
  background: #16a34a;
  color: #fff;
  font-size: 0.62rem;
  font-weight: 700;
  padding: 0.15rem 0.4rem;
  border-radius: 4px;
  letter-spacing: 0.02em;
  text-transform: uppercase;
}
.alt-eta {
  font-size: 1.1rem;
  font-weight: 700;
  color: #111;
  line-height: 1.1;
}
.alt-dist {
  font-size: 0.78rem;
  color: #6b7280;
  margin-top: 0.1rem;
}
.alt-meta {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.4rem;
  flex-wrap: wrap;
}
.alt-meta-item {
  font-size: 0.72rem;
  color: #4b5563;
  font-weight: 500;
  white-space: nowrap;
}
.alt-meta-icon { margin-right: 0.15rem; }
.alt-meta-dim { color: #9ca3af; }
.alt-toll { color: #b45309; }
.alt-tollfree { color: #16a34a; font-size: 0.68rem; }
.alt-check {
  position: absolute;
  top: 0.4rem;
  right: 0.5rem;
  color: #2563eb;
  font-weight: 700;
  font-size: 0.9rem;
}
</style>
