<template>
  <van-tabbar :model-value="currentTab" @update:model-value="$emit('switch', $event)" :safe-area-inset-bottom="true" :border="true" active-color="var(--accent)" inactive-color="var(--text-dim)">
    <van-tabbar-item v-for="tab in tabs" :key="tab.key" :name="tab.key">
      <template #icon>
        <van-badge v-if="tab.key === 'messages' && unreadCount > 0" :content="unreadCount > 9 ? '9+' : unreadCount">
          <span class="tab-icon" v-html="tab.icon"></span>
        </van-badge>
        <van-badge v-else-if="tab.key === 'notifications' && unreadNotifCount > 0" :content="unreadNotifCount > 9 ? '9+' : unreadNotifCount">
          <span class="tab-icon" v-html="tab.icon"></span>
        </van-badge>
        <span v-else class="tab-icon" v-html="tab.icon"></span>
      </template>
      {{ tab.label }}
    </van-tabbar-item>
  </van-tabbar>
</template>

<script setup>
import { Tabbar as VanTabbar, TabbarItem as VanTabbarItem, Badge as VanBadge } from 'vant'

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
]
</script>

<style scoped>
.tab-icon {
  font-size: 1.2rem;
  line-height: 1;
}
</style>
