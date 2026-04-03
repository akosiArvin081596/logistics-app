<template>
  <div v-if="totalPages > 1" class="pagination">
    <div class="pagination-info">{{ start }}–{{ end }} of {{ total }}</div>
    <div class="pagination-controls">
      <Button variant="outline" size="icon-xs" :disabled="page === 1" @click="$emit('go', 1)">&laquo;</Button>
      <Button variant="outline" size="icon-xs" :disabled="page === 1" @click="$emit('go', page - 1)">&lsaquo;</Button>
      <template v-for="i in pageNumbers" :key="i">
        <span v-if="i === '...'" style="padding:0 0.25rem;color:#d1d5db;font-size:0.85rem;user-select:none;">&#183;&#183;&#183;</span>
        <Button v-else :variant="i === page ? 'default' : 'outline'" size="icon-xs" @click="$emit('go', i)">{{ i }}</Button>
      </template>
      <Button variant="outline" size="icon-xs" :disabled="page === totalPages" @click="$emit('go', page + 1)">&rsaquo;</Button>
      <Button variant="outline" size="icon-xs" :disabled="page === totalPages" @click="$emit('go', totalPages)">&raquo;</Button>
      <select class="page-size-select" :value="pageSize" @change="$emit('size', +($event.target).value)">
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
})

defineEmits(['go', 'size'])

const sizes = [5, 10, 25, 50]
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
