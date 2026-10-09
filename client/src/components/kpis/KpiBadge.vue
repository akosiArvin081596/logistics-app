<template>
  <Badge variant="outline" :class="cn('normal-case tracking-normal font-semibold', TONE_CLASSES[tone] || TONE_CLASSES.muted)">
    <slot>{{ label }}</slot>
  </Badge>
</template>

<script setup>
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

// One look per tone from lib/kpiView.js. Text colours are the -700/-800 shades so
// every label keeps AA contrast on its tinted background.
const TONE_CLASSES = {
  real: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  estimate: 'border-amber-200 bg-amber-50 text-amber-800',
  proxy: 'border-violet-200 bg-violet-50 text-violet-700',
  missing: 'border-red-200 bg-red-50 text-red-700',
  partial: 'border-sky-200 bg-sky-50 text-sky-700',
  high: 'border-emerald-200 bg-white text-emerald-700',
  medium: 'border-sky-200 bg-white text-sky-700',
  low: 'border-amber-200 bg-white text-amber-800',
  muted: 'border-slate-200 bg-slate-50 text-slate-600',
}

defineProps({
  label: { type: String, default: '' },
  tone: { type: String, default: 'muted' },
})
</script>
