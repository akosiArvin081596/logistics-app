<template>
  <div v-if="visible" class="pagination">
    <div class="pagination-info">{{ start }}–{{ end }} of {{ total }}</div>
    <div class="pagination-controls">
      <template v-if="totalPages > 1">
        <Button variant="outline" size="icon-xs" aria-label="First page" :disabled="page === 1" @click="$emit('go', 1)">&laquo;</Button>
        <Button variant="outline" size="icon-xs" aria-label="Previous page" :disabled="page === 1" @click="$emit('go', page - 1)">&lsaquo;</Button>
        <template v-for="i in pageNumbers" :key="i">
          <span v-if="i === '...'" style="padding:0 0.25rem;color:#d1d5db;font-size:0.85rem;user-select:none;">&#183;&#183;&#183;</span>
          <Button v-else :variant="i === page ? 'default' : 'outline'" size="icon-xs" :aria-current="i === page ? 'page' : undefined" @click="$emit('go', i)">{{ i }}</Button>
        </template>
        <Button variant="outline" size="icon-xs" aria-label="Next page" :disabled="page === totalPages" @click="$emit('go', page + 1)">&rsaquo;</Button>
        <Button variant="outline" size="icon-xs" aria-label="Last page" :disabled="page === totalPages" @click="$emit('go', totalPages)">&raquo;</Button>
      </template>
      <select v-if="sizes.length" class="page-size-select" aria-label="Rows per page" :value="pageSize" @change="$emit('size', +($event.target).value)">
        <option v-for="s in sizes" :key="s" :value="s">{{ s }}/page</option>
      </select>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { Button } from '@/components/ui/button'

const props = defineProps({
  page: { type: Number, required: true },
  pageSize: { type: Number, required: true },
  total: { type: Number, required: true },
  totalPages: { type: Number, required: true },
  // The page sizes offered; none hides the select.
  sizes: { type: Array, default: () => [5, 10, 25, 50] },
  // Keep the size select when every row fits one page, as long as a smaller
  // size would page: otherwise a large choice hides the bar and can't be undone.
  keepSizeChoice: { type: Boolean, default: false },
})

defineEmits(['go', 'size'])

const visible = computed(() => props.totalPages > 1 || (props.keepSizeChoice && props.sizes.length > 0 && props.total > Math.min(...props.sizes)))
const start = computed(() => (props.page - 1) * props.pageSize + 1)
const end = computed(() => Math.min(props.page * props.pageSize, props.total))

const pageNumbers = computed(() => {
  const pages = []
  for (let i = 1; i <= props.totalPages; i++) {
    if (i === 1 || i === props.totalPages || (i >= props.page - 1 && i <= props.page + 1)) {
      pages.push(i)
    } else if (i === props.page - 2 || i === props.page + 2) {
      pages.push('...')
    }
  }
  return pages
})
</script>

<style scoped>
/* At phone width the buttons and the size select wrap instead of running off screen. */
.pagination-controls { flex-wrap: wrap; row-gap: 0.4rem; }
</style>
