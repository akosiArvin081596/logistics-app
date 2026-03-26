<template>
  <nav class="bottom-nav">
    <button
      v-for="tab in tabs"
      :key="tab.key"
      :class="['nav-tab', { active: currentTab === tab.key }]"
      @click="$emit('switch', tab.key)"
    >
      <span class="nav-tab-icon" v-html="tab.icon"></span>
      <span
        v-if="tab.key === 'messages' && unreadCount > 0"
        class="badge"
      >{{ unreadCount > 9 ? '9+' : unreadCount }}</span>
      <span
        v-if="tab.key === 'notifications' && unreadNotifCount > 0"
        class="badge"
      >{{ unreadNotifCount > 9 ? '9+' : unreadNotifCount }}</span>
      {{ tab.label }}
    </button>
  </nav>
</template>

<script setup>
defineProps({
  currentTab: { type: String, default: 'loads' },
  unreadCount: { type: Number, default: 0 },
  unreadNotifCount: { type: Number, default: 0 },
})

defineEmits(['switch'])

const tabs = [
  { key: 'loads', label: 'Loads', icon: '&#128230;' },
  { key: 'status', label: 'Status', icon: '&#128666;' },
  { key: 'notifications', label: 'Alerts', icon: '&#128276;' },
  { key: 'kit', label: 'Kit', icon: '&#128196;' },
  { key: 'messages', label: 'Messages', icon: '&#128172;' },
  { key: 'expenses', label: 'Expenses', icon: '&#128176;' },
]
</script>

<style scoped>
.bottom-nav {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  height: calc(60px + env(safe-area-inset-bottom, 0px));
  padding-bottom: env(safe-area-inset-bottom, 0px);
  background: var(--surface);
  border-top: 1px solid var(--border);
  display: flex;
  align-items: stretch;
  z-index: 40;
}

.nav-tab {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.15rem;
  background: none;
  border: none;
  font-family: inherit;
  font-size: 0.65rem;
  font-weight: 500;
  color: var(--text-dim);
  cursor: pointer;
  transition: color 0.15s;
  position: relative;
  padding: 0.4rem 0;
}

.nav-tab-icon {
  font-size: 1.2rem;
  line-height: 1;
}

.nav-tab.active {
  color: var(--accent);
}

.badge {
  position: absolute;
  top: 4px;
  right: 50%;
  transform: translateX(14px);
  min-width: 16px;
  height: 16px;
  background: var(--danger);
  color: #fff;
  font-size: 0.6rem;
  font-weight: 700;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 4px;
}
</style>
