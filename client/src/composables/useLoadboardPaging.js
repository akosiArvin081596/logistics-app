import { watch } from 'vue'
import { usePagination } from './usePagination.js'
import {
  LOADBOARD_PAGE_SIZES,
  browserStorage,
  isLoadboardPageSize,
  pageSizeKey,
  readPageSize,
  savePageSize,
} from '../lib/loadboardPaging.js'

// usePagination for the loadboard's tabs (lib/loadboardPaging.js has the rules).
//   items     the rows after search and filters: paging slices them, never the
//             other way round, so a search always covers every row.
//   tab       storage name of a tab with a size choice ('jobBoard', 'completed').
//   userId    the signed-in user's id; the choice is kept per user.
//   fixedSize a fixed page size and no choice (Active Loads).
//   resetOn   refs whose change goes back to page 1 (search, filters).
// `sizes` is what the PaginationBar offers: none for a fixed size.
export function useLoadboardPaging(items, { tab = '', userId = null, fixedSize = 0, resetOn = [] } = {}) {
  const key = fixedSize ? null : pageSizeKey(tab, userId)
  const pager = usePagination(items, fixedSize || readPageSize(browserStorage(), key))

  function setSize(size) {
    if (fixedSize || !isLoadboardPageSize(size)) return
    pager.setSize(size)
    savePageSize(browserStorage(), key, size)
  }

  if (resetOn.length) watch(resetOn, () => pager.goTo(1))
  // A refresh that shortens the list would otherwise leave a blank page.
  watch(pager.totalPages, (n) => { if (pager.page.value > n) pager.goTo(n) })

  return { ...pager, setSize, sizes: fixedSize ? [] : LOADBOARD_PAGE_SIZES }
}
