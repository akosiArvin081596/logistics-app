<template>
  <!-- An invoice's Personal lines (R3 v1), each with its receipt: the server's
       label and amount, and a link to the receipt (lib/personalReceipt.js). Used
       by the admin Invoices detail and the driver's invoice sheet. -->
  <ul v-if="items.length" class="personal-lines">
    <li v-for="item in items" :key="item.key" class="pl-row">
      <span class="pl-label">{{ item.label }}</span>
      <span class="pl-amount">{{ item.amount }}</span>
      <span class="pl-receipt">
        <RouterLink v-if="item.receipt.href && item.receipt.internal" :to="item.receipt.href">{{ item.receipt.text }}</RouterLink>
        <a v-else-if="item.receipt.href" :href="item.receipt.href" target="_blank" rel="noopener">{{ item.receipt.text }}</a>
        <span v-else class="pl-receipt-text">{{ item.receipt.text }}</span>
      </span>
    </li>
  </ul>
</template>

<script setup>
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import { personalLineReceipt } from '../../lib/personalReceipt'

const props = defineProps({
  // The invoice's personal_lines, as the server sent them.
  lines: { type: Array, default: () => [] },
  isSuperAdmin: { type: Boolean, default: false },
})

const items = computed(() => (Array.isArray(props.lines) ? props.lines : []).map((l, i) => ({
  key: `${l && l.line_id}-${l && l.kind}-${i}`,
  label: String((l && l.label) || ''),
  amount: String((l && l.amount) || ''),
  // A share line carries no receipt of its own; its Personal line beside it does.
  receipt: l && l.receipt ? personalLineReceipt(l, { isSuperAdmin: props.isSuperAdmin }) : { text: '', href: '', internal: false },
})))
</script>

<style scoped>
.personal-lines { list-style: none; margin: 0.35rem 0 0; padding: 0; display: flex; flex-direction: column; gap: 0.3rem; }
.pl-row { display: grid; grid-template-columns: 1fr auto; column-gap: 0.75rem; font-size: 0.8rem; }
.pl-label { color: #374151; }
.pl-amount { font-weight: 600; text-align: right; white-space: nowrap; }
.pl-receipt { grid-column: 1 / -1; font-size: 0.72rem; color: #6b7280; }
.pl-receipt a { color: #1d4ed8; text-decoration: underline; }
</style>
