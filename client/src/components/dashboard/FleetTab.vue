<template>
  <div class="p-4">
    <div v-if="fleet.length > 0" class="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
      <div v-for="f in fleet" :key="f.Driver"
        class="bg-white border border-gray-200 rounded-xl p-4 cursor-pointer hover:border-sky-400/40 transition"
        @click="openDetail(f)">
        <div class="flex justify-between items-start mb-3">
          <div>
            <div class="font-bold">{{ f.Driver || 'Unknown' }}</div>
            <div class="text-xs text-gray-500 font-mono">{{ f.Truck || 'No truck assigned' }}</div>
          </div>
          <span :class="['text-xs font-semibold px-2 py-0.5 rounded-full', f.Status === 'On Load' ? 'bg-sky-50 text-sky-600' : 'bg-emerald-500/10 text-emerald-400']">{{ f.Status }}</span>
        </div>
        <div class="flex items-center gap-2">
          <span class="text-xs text-gray-500">{{ f.CompletedLoads }} completed</span>
          <span v-if="f.CurrentLoad" class="text-xs font-mono text-sky-400">{{ f.CurrentLoad }}</span>
        </div>
      </div>
    </div>
    <EmptyState v-else>No carriers found.</EmptyState>

    <Teleport to="body">
      <div v-if="selected" class="fixed inset-0 bg-black/30 backdrop-blur-sm z-[200] flex items-center justify-center" @click.self="selected = null">
        <div class="bg-white rounded-2xl w-[92%] max-w-[480px] max-h-[85vh] flex flex-col shadow-2xl">
          <div class="flex items-center justify-between px-5 py-4 border-b border-gray-200">
            <h3 class="text-lg font-bold">{{ selected.Driver || 'Driver' }}</h3>
            <button class="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-800 text-xl" @click="selected = null">&times;</button>
          </div>
          <div class="p-5 overflow-y-auto">
            <div class="mb-4">
              <div class="text-[0.68rem] font-bold uppercase tracking-wider text-gray-400 mb-2">Status</div>
              <div class="bg-white border border-gray-200 rounded-lg grid grid-cols-2 overflow-hidden">
                <div class="flex flex-col gap-0.5 p-3 border-b border-gray-100">
                  <span class="text-[0.68rem] font-semibold uppercase text-gray-400">Availability</span>
                  <span :class="['text-xs font-semibold px-2 py-0.5 rounded-full w-fit', selected.Status === 'On Load' ? 'bg-sky-50 text-sky-600' : 'bg-emerald-500/10 text-emerald-400']">{{ selected.Status }}</span>
                </div>
                <div class="flex flex-col gap-0.5 p-3 border-b border-gray-100">
                  <span class="text-[0.68rem] font-semibold uppercase text-gray-400">Current Load</span>
                  <span class="text-sm">{{ selected.CurrentLoad || '\u2014' }}</span>
                </div>
              </div>
            </div>
            <div class="mb-4">
              <div class="text-[0.68rem] font-bold uppercase tracking-wider text-gray-400 mb-2">Performance</div>
              <div class="bg-white border border-gray-200 rounded-lg p-3">
                <span class="text-[0.68rem] font-semibold uppercase text-gray-400">Completed Loads</span>
                <div class="text-2xl font-bold font-mono mt-1">{{ selected.CompletedLoads }}</div>
              </div>
            </div>
            <div v-if="selected.Phone">
              <div class="text-[0.68rem] font-bold uppercase tracking-wider text-gray-400 mb-2">Contact</div>
              <div class="bg-white border border-gray-200 rounded-lg p-3">
                <span class="text-[0.68rem] font-semibold uppercase text-gray-400">Phone</span>
                <div class="text-sm mt-1">{{ selected.Phone }}</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import EmptyState from '../shared/EmptyState.vue'

defineProps({ fleet: { type: Array, required: true }, activeJobs: { type: Array, default: () => [] }, headers: { type: Array, default: () => [] } })
const selected = ref(null)
function openDetail(f) { selected.value = f }
</script>
