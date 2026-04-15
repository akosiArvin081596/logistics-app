<template>
  <transition name="drawer">
    <div v-if="open" class="faq-drawer" role="dialog" aria-labelledby="faq-drawer-title">
      <header class="drawer-header">
        <h3 id="faq-drawer-title">Frequently asked</h3>
        <button class="icon-btn" type="button" aria-label="Close FAQ" @click="$emit('close')">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </header>
      <div v-if="activeFaq" class="drawer-body single">
        <button class="back-link" type="button" @click="$emit('clear')">
          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
            <line x1="19" y1="12" x2="5" y2="12" />
            <polyline points="12 19 5 12 12 5" />
          </svg>
          Back to all
        </button>
        <h4 class="single-q">{{ activeFaq.q }}</h4>
        <p class="single-a">{{ activeFaq.a }}</p>
      </div>
      <div v-else class="drawer-body">
        <input
          v-model="searchLocal"
          class="faq-search"
          type="text"
          placeholder="Search questions..."
          aria-label="Search FAQ"
        />
        <div v-if="!filtered.length" class="faq-empty">
          No matches. Try a different question.
        </div>
        <ul v-else class="faq-list">
          <li v-for="item in filtered" :key="item.id">
            <button type="button" class="faq-row" @click="$emit('select', item.id)">
              <span class="faq-q">{{ item.q }}</span>
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </button>
          </li>
        </ul>
      </div>
    </div>
  </transition>
</template>

<script setup>
import { ref, computed, watch } from 'vue';

const props = defineProps({
  open: { type: Boolean, default: false },
  items: { type: Array, default: () => [] },
  activeFaq: { type: Object, default: null },
});

defineEmits(['close', 'select', 'clear']);

const searchLocal = ref('');

const filtered = computed(() => {
  const q = searchLocal.value.trim().toLowerCase();
  if (!q) return props.items;
  return props.items.filter(i =>
    i.q.toLowerCase().includes(q) || i.a.toLowerCase().includes(q)
  );
});

watch(() => props.open, (next) => {
  if (!next) searchLocal.value = '';
});
</script>

<style scoped>
.faq-drawer {
  position: fixed;
  top: 24px;
  right: 420px;
  bottom: 24px;
  width: 340px;
  background: #fff;
  border: 1px solid #e2e8f0;
  border-radius: 18px;
  box-shadow: 0 24px 48px -16px rgba(15, 23, 42, 0.28), 0 8px 20px -8px rgba(15, 23, 42, 0.15);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  z-index: 9998;
  font-family: 'DM Sans', system-ui, sans-serif;
}
.drawer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  border-bottom: 1px solid #f1f5f9;
}
.drawer-header h3 {
  margin: 0;
  font-size: 0.95rem;
  color: #0f172a;
  font-weight: 600;
}
.icon-btn {
  background: transparent;
  border: none;
  color: #64748b;
  width: 28px;
  height: 28px;
  border-radius: 7px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.icon-btn:hover { background: #f1f5f9; color: #0f172a; }
.drawer-body {
  padding: 14px 18px;
  overflow-y: auto;
  flex: 1;
}
.faq-search {
  width: 100%;
  padding: 9px 12px;
  border: 1px solid #e2e8f0;
  border-radius: 9px;
  font-size: 0.85rem;
  font-family: inherit;
  color: #0f172a;
  background: #fafbfd;
  margin-bottom: 10px;
}
.faq-search:focus {
  outline: none;
  border-color: #3b82f6;
  background: #fff;
}
.faq-empty {
  padding: 20px 8px;
  text-align: center;
  color: #94a3b8;
  font-size: 0.82rem;
}
.faq-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.faq-row {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 9px;
  padding: 10px 12px;
  font-size: 0.85rem;
  color: #334155;
  cursor: pointer;
  text-align: left;
  font-family: inherit;
}
.faq-row:hover {
  background: #f8fafc;
  border-color: #e2e8f0;
  color: #0f172a;
}
.faq-q { flex: 1; }
.drawer-body.single {
  padding: 18px 20px;
}
.back-link {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  background: transparent;
  border: none;
  color: #3b82f6;
  font-size: 0.78rem;
  cursor: pointer;
  padding: 0 0 10px;
  font-family: inherit;
}
.single-q {
  margin: 0 0 10px;
  color: #0f172a;
  font-size: 1rem;
  font-weight: 600;
  line-height: 1.35;
}
.single-a {
  margin: 0;
  color: #475569;
  font-size: 0.88rem;
  line-height: 1.6;
}

.drawer-enter-active, .drawer-leave-active {
  transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.25s ease;
}
.drawer-enter-from, .drawer-leave-to {
  transform: translateX(10px);
  opacity: 0;
}

@media (max-width: 1024px) {
  .faq-drawer {
    right: 24px;
    top: 96px;
    bottom: auto;
    width: calc(100vw - 48px);
    max-width: 380px;
    height: 420px;
  }
}
@media (max-width: 768px) {
  .faq-drawer {
    top: auto;
    right: 0;
    left: 0;
    bottom: 0;
    width: 100%;
    max-width: none;
    height: 70vh;
    border-radius: 18px 18px 0 0;
  }
}
@media (prefers-reduced-motion: reduce) {
  .drawer-enter-active, .drawer-leave-active { transition: opacity 0.2s ease; }
  .drawer-enter-from, .drawer-leave-to { transform: none; }
}
</style>
