<template>
  <div style="padding:1.25rem;">
    <div v-if="fleet.length > 0" class="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-4">
      <Card v-for="f in fleet" :key="f.Driver" class="fleet-card" @click="openDetail(f)">
        <CardContent style="padding:1.25rem 1.375rem;">
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
        </CardContent>
      </Card>
    </div>
    <EmptyState v-else>No carriers found.</EmptyState>

    <Dialog :open="!!selected" @update:open="v => { if (!v) selected = null }">
      <DialogContent class="max-w-[500px]" style="padding:0;">
        <DialogHeader class="border-b border-gray-100 bg-muted/50" style="padding:1.25rem 1.5rem;">
          <DialogTitle>{{ selected?.Driver || 'Driver' }}</DialogTitle>
          <DialogDescription class="sr-only">Details for driver {{ selected?.Driver }}</DialogDescription>
        </DialogHeader>
        <div style="padding:1.25rem;overflow-y:auto;">
          <div style="margin-bottom:1rem;">
            <div class="dash-section-title">Status</div>
            <div class="dash-detail-grid">
              <div style="display:flex;flex-direction:column;gap:4px;padding:0.75rem;border-bottom:1px solid #f3f4f6;">
                <span style="font-size:0.68rem;font-weight:600;text-transform:uppercase;color:#9ca3af;">Availability</span>
                <span :class="['fleet-status', selected?.Status === 'On Load' ? 'fleet-status-active' : 'fleet-status-available']" style="width:fit-content;">{{ selected?.Status }}</span>
              </div>
              <div style="display:flex;flex-direction:column;gap:4px;padding:0.75rem;border-bottom:1px solid #f3f4f6;">
                <span style="font-size:0.68rem;font-weight:600;text-transform:uppercase;color:#9ca3af;">Current Load</span>
                <span style="font-size:0.875rem;">{{ selected?.CurrentLoad || '\u2014' }}</span>
              </div>
            </div>
          </div>
          <div style="margin-bottom:1rem;">
            <div class="dash-section-title">Performance</div>
            <div class="dash-detail-grid" style="display:block;padding:0.75rem;">
              <span style="font-size:0.68rem;font-weight:600;text-transform:uppercase;color:#9ca3af;">Completed Loads</span>
              <div style="font-size:2rem;font-weight:800;font-family:'JetBrains Mono',monospace;color:#111827;margin-top:4px;">{{ selected?.CompletedLoads }}</div>
            </div>
          </div>
          <div v-if="selected?.Phone">
            <div class="dash-section-title">Contact</div>
            <div class="dash-detail-grid" style="display:block;padding:0.75rem;">
              <span style="font-size:0.68rem;font-weight:600;text-transform:uppercase;color:#9ca3af;">Phone</span>
              <div style="font-size:0.875rem;margin-top:4px;">{{ selected?.Phone }}</div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { Card, CardContent } from '@/components/ui/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import EmptyState from '../shared/EmptyState.vue'

defineProps({ fleet: { type: Array, required: true }, activeJobs: { type: Array, default: () => [] }, headers: { type: Array, default: () => [] } })
const selected = ref(null)
function openDetail(f) { selected.value = f }
</script>
