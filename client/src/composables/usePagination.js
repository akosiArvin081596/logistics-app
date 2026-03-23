import { ref, computed } from 'vue'

export function usePagination(items, defaultSize = 5) {
  const page = ref(1)
  const pageSize = ref(defaultSize)

  const totalPages = computed(() =>
    Math.max(1, Math.ceil(items.value.length / pageSize.value))
  )

  const paginatedItems = computed(() => {
    const start = (page.value - 1) * pageSize.value
    return items.value.slice(start, start + pageSize.value)
  })

  function goTo(p) {
    page.value = Math.max(1, Math.min(p, totalPages.value))
  }

  function setSize(s) {
    pageSize.value = s
    page.value = 1
  }

  return { page, pageSize, totalPages, paginatedItems, goTo, setSize }
}
