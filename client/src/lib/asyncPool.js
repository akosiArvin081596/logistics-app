// Concurrency-limited runner: at most `size` workers in flight over `items`.
// Was inline in BulkReceiptScan.vue; extracted when the driver document scanner
// needed the same thing, so the receipt grid and the POD scanner run their
// batches through one implementation rather than two.
//
// ⚠️ `worker` MUST NOT THROW. There is deliberately no try/catch inside the
// loop, and adding one here would change BulkReceiptScan's behaviour, so the
// contract lives on the caller instead. A throw kills that runner's `while`, so
// every item it had not reached yet is SILENTLY never processed, and the
// returned promise rejects — which in both callers runs their
// `finally { busy = false }` over unfinished work, leaving a surface that looks
// done and isn't. In DocumentUpload it is worse than cosmetic: `scanning` is a
// computed over per-entry status, so an item stranded mid-flight disables the
// Upload button for good. Every worker records its own outcome on the item and
// returns normally; that is the contract, not a style preference.
//
// Items are STARTED in array order and finish in whatever order they resolve.
// A caller that needs positional meaning must carry it on the item.
export async function runPool(items, worker, size) {
  let i = 0
  const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++
      await worker(items[idx])
    }
  })
  await Promise.all(runners)
}
