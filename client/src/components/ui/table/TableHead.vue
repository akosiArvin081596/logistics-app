<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "@/lib/utils"

const props = defineProps<{
  class?: HTMLAttributes["class"]
}>()
</script>

<template>
  <th :class="cn('h-12 px-5 text-left align-middle text-[0.625rem] font-bold uppercase tracking-[0.08em] text-muted-foreground bg-muted/40 [&:has([role=checkbox])]:pr-0', props.class)">
    <slot />
  </th>
</template>
