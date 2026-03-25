<template>
  <div class="doc-list">
    <div v-if="loading" class="doc-loading">Loading documents...</div>
    <div v-else-if="documents.length === 0" class="doc-empty">No documents uploaded yet</div>
    <div v-else class="doc-items">
      <div v-for="doc in documents" :key="doc.id" class="doc-item">
        <div class="doc-item-left">
          <span :class="['doc-badge', `badge-${doc.type.toLowerCase()}`]">{{ doc.type }}</span>
          <div class="doc-meta">
            <span class="doc-name">{{ doc.file_name }}</span>
            <span class="doc-date">{{ formatDate(doc.uploaded_at) }}</span>
          </div>
        </div>
        <a
          v-if="doc.drive_url"
          :href="doc.drive_url"
          target="_blank"
          rel="noopener"
          class="doc-link"
        >View</a>
      </div>
      <!-- OCR text for receipts -->
      <div
        v-for="doc in receiptsWithOcr"
        :key="'ocr-' + doc.id"
        class="ocr-block"
      >
        <button class="ocr-toggle" @click="toggleOcr(doc.id)">
          OCR Text ({{ doc.type }} #{{ doc.id }})
          <span class="ocr-chevron" :class="{ open: openOcr.has(doc.id) }">&#9662;</span>
        </button>
        <pre v-show="openOcr.has(doc.id)" class="ocr-text">{{ doc.ocr_text }}</pre>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, watch, onMounted } from 'vue'
import { useApi } from '../../composables/useApi'

const props = defineProps({
  loadId: { type: String, required: true },
})

const api = useApi()
const documents = ref([])
const loading = ref(false)
const openOcr = ref(new Set())

const receiptsWithOcr = ref([])

function toggleOcr(id) {
  if (openOcr.value.has(id)) {
    openOcr.value.delete(id)
  } else {
    openOcr.value.add(id)
  }
  openOcr.value = new Set(openOcr.value)
}

async function fetchDocs() {
  if (!props.loadId) return
  loading.value = true
  try {
    const res = await api.get(`/api/documents/${encodeURIComponent(props.loadId)}`)
    documents.value = res.documents || []
    receiptsWithOcr.value = documents.value.filter(d => d.ocr_text && d.ocr_text.trim())
  } catch {
    documents.value = []
  } finally {
    loading.value = false
  }
}

function formatDate(str) {
  if (!str) return ''
  const d = new Date(str)
  if (isNaN(d)) return str
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

// Expose refresh method for parent
defineExpose({ refresh: fetchDocs })

onMounted(fetchDocs)
watch(() => props.loadId, fetchDocs)
</script>

<style scoped>
.doc-list { margin-top: 0.75rem; }

.doc-loading,
.doc-empty {
  text-align: center;
  font-size: 0.8rem;
  color: var(--text-dim);
  padding: 0.5rem 0;
}

.doc-items { display: flex; flex-direction: column; gap: 0.5rem; }

.doc-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.5rem 0.6rem;
  background: var(--bg);
  border-radius: 6px;
  gap: 0.5rem;
}

.doc-item-left {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
  flex: 1;
}

.doc-badge {
  font-size: 0.6rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 0.15rem 0.4rem;
  border-radius: 4px;
  flex-shrink: 0;
}

.badge-pod { background: #dcfce7; color: #166534; }
.badge-receipt { background: #fef9c3; color: #854d0e; }
.badge-bol { background: #dbeafe; color: #1e40af; }
.badge-other { background: var(--bg); color: var(--text-dim); border: 1px solid var(--border); }

.doc-meta {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.doc-name {
  font-size: 0.72rem;
  font-weight: 500;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.doc-date {
  font-size: 0.65rem;
  color: var(--text-dim);
}

.doc-link {
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--accent);
  text-decoration: none;
  flex-shrink: 0;
}

.doc-link:hover { text-decoration: underline; }

/* OCR */
.ocr-block { margin-top: 0.25rem; }

.ocr-toggle {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.4rem 0.6rem;
  background: var(--bg);
  border: none;
  border-radius: 6px;
  font-family: inherit;
  font-size: 0.72rem;
  font-weight: 500;
  color: var(--text-dim);
  cursor: pointer;
}

.ocr-chevron {
  font-size: 0.6rem;
  transition: transform 0.2s;
  display: inline-block;
}

.ocr-chevron.open { transform: rotate(180deg); }

.ocr-text {
  margin: 0.25rem 0 0;
  padding: 0.5rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 0.72rem;
  color: var(--text);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 150px;
  overflow-y: auto;
}
</style>
