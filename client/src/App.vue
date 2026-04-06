<template>
  <AppSidebar v-if="showSidebar" />
  <main :class="['main', { 'no-sidebar': !showSidebar }]">
    <router-view />
  </main>
  <AppToast />
</template>

<script setup>
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { useAuthStore } from './stores/auth'
import AppSidebar from './components/layout/AppSidebar.vue'
import AppToast from './components/layout/AppToast.vue'

const route = useRoute()
const auth = useAuthStore()

const showSidebar = computed(() => {
  if (!auth.isAuthenticated) return false
  if (route.meta.noSidebar) return false
  return true
})
</script>

<style>
.main.no-sidebar {
  margin-left: 0;
  width: 100%;
  padding: 0;
  height: 100vh;
}
</style>
