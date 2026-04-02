<template>
  <div style="padding:1.25rem;">
    <div v-if="fleet.length > 0" class="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-4">
      <div v-for="f in fleet" :key="f.Driver" class="fleet-card" @click="openDetail(f)">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:0.75rem;">
          <div>
            <div style="font-weight:700;font-size:0.9375rem;color:#111827;">{{ f.Driver || 'Unknown' }}</div>
            <div style="font-size:0.6875rem;color:#9ca3af;font-family:'JetBrains Mono',monospace;margin-top:2px;">{{ f.Truck || 'No truck assigned' }}</div>
          </div>
          <span :class="['fleet-status', f.Status === 'On Load' ? 'fleet-status-active' : 'fleet-status-available']">{{ f.Status }}</span>
        </div>
        <div style="display:flex;align-items:center;gap:0.75rem;padding-top:0.75rem;margin-top:0.75rem;border-top:1px solid #f3f4f6;">
          <span style="font-size:0.6875rem;color:#9ca3af;"><span style="font-family:'JetBrains Mono',monospace;font-weight:600;color:#4b5563;">{{ f.CompletedLoads }}</span> completed</span>
          <span v-if="f.CurrentLoad" style="font-size:0.6875rem;font-family:'JetBrains Mono',monospace;color:#0284c7;background:#f0f9ff;padding:2px 8px;border-radius:4px;">{{ f.CurrentLoad }}</span>
        </div>
      </div>
    </div>
    <EmptyState v-else>No carriers found.</EmptyState>

    <Teleport to="body">
      <div v-if="selected" class="fixed inset-0 bg-black/30 backdrop-blur-sm z-[200] flex items-center justify-center" @click.self="selected = null">
        <div class="dash-modal-container dash-modal-sm">
          <div class="dash-modal-header">
            <h3 style="font-size:1.1rem;font-weight:700;">{{ selected.Driver || 'Driver' }}</h3>
            <button class="dash-modal-close" @click="selected = null">&times;</button>
          </div>
          <div style="padding:1.25rem;overflow-y:auto;">
            <div style="margin-bottom:1rem;">
              <div class="dash-section-title">Status</div>
              <div class="dash-detail-grid">
                <div style="display:flex;flex-direction:column;gap:4px;padding:0.75rem;border-bottom:1px solid #f3f4f6;">
                  <span style="font-size:0.68rem;font-weight:600;text-transform:uppercase;color:#9ca3af;">Availability</span>
                  <span :class="['fleet-status', selected.Status === 'On Load' ? 'fleet-status-active' : 'fleet-status-available']" style="width:fit-content;">{{ selected.Status }}</span>
                </div>
                <div style="display:flex;flex-direction:column;gap:4px;padding:0.75rem;border-bottom:1px solid #f3f4f6;">
                  <span style="font-size:0.68rem;font-weight:600;text-transform:uppercase;color:#9ca3af;">Current Load</span>
                  <span style="font-size:0.875rem;">{{ selected.CurrentLoad || '\u2014' }}</span>
                </div>
              </div>
            </div>
            <div style="margin-bottom:1rem;">
              <div class="dash-section-title">Performance</div>
              <div class="dash-detail-grid" style="display:block;padding:0.75rem;">
                <span style="font-size:0.68rem;font-weight:600;text-transform:uppercase;color:#9ca3af;">Completed Loads</span>
                <div style="font-size:2rem;font-weight:800;font-family:'JetBrains Mono',monospace;color:#111827;margin-top:4px;">{{ selected.CompletedLoads }}</div>
              </div>
            </div>
            <div v-if="selected.Phone">
              <div class="dash-section-title">Contact</div>
              <div class="dash-detail-grid" style="display:block;padding:0.75rem;">
                <span style="font-size:0.68rem;font-weight:600;text-transform:uppercase;color:#9ca3af;">Phone</span>
                <div style="font-size:0.875rem;margin-top:4px;">{{ selected.Phone }}</div>
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
