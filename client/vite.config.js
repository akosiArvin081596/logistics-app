import { defineConfig, loadEnv } from 'vite'
import path from 'path'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, path.resolve(__dirname, '..'), '')
  const apiTarget = env.VITE_API_TARGET || 'http://localhost:3000'

  return {
    plugins: [vue(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'src'),
      },
    },
    server: {
      port: Number(env.VITE_DEV_PORT) || 5173,
      proxy: {
        '/api': {
          target: apiTarget,
          changeOrigin: true,
        },
        '/socket.io': {
          target: apiTarget,
          ws: true,
        },
        // Uploaded files (receipts, PODs, legal docs, signed onboarding PDFs) are
        // stored as '/uploads/...' paths and served by Express behind requireAuth.
        // Without this, dev requests for them hit Vite instead, fall through to the
        // SPA catch-all, and come back as index.html with content-type text/html —
        // so every <img> pointing at a receipt renders as a broken image locally
        // while working perfectly in production, where Express serves both.
        '/uploads': {
          target: apiTarget,
          changeOrigin: true,
        },
      },
    },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      rollupOptions: {
        output: {
          // Vendor chunking — keep heavy libs in stable hashes so app updates
          // don't bust the vendor cache. Eliminates orphan DialogTitle.vue chunk.
          manualChunks: {
            'vendor-vue': ['vue', 'vue-router', 'pinia'],
            'vendor-ui': ['reka-ui', 'radix-vue', 'lucide-vue-next', '@vueuse/core', 'class-variance-authority', 'clsx', 'tailwind-merge'],
            'vendor-maps': ['@googlemaps/js-api-loader'],
            'vendor-socket': ['socket.io-client'],
            'vendor-vant': ['vant'],
            // pdf.js + its Vue wrapper (the invoice PDF zoom viewer). Only
            // reached via a dynamic import() in PdfZoomViewer, so this chunk
            // stays lazy — it just gives the pdf.js split a clear name
            // instead of the confusing "index" Rollup derives from its entry file.
            //
            // These are the EXACT specifiers in the module graph, not the bare
            // package names. PdfZoomViewer imports vue-pdf-embed's essential
            // entry (see the comment there — the default entry inlines pdf.js
            // and makes the pdfjs-dist pin unenforceable), and that entry pulls
            // the `legacy/` pdf.js build. Bare 'vue-pdf-embed'/'pdfjs-dist'
            // resolve to the default and modern builds respectively — neither is
            // in the graph, so they silently produced a 1-byte empty vendor-pdf
            // while the real 772 kB landed in an "index.essential" chunk. Worse,
            // naming the modern build here would drag a SECOND copy of pdf.js
            // into the bundle. Keep these in step with PdfZoomViewer's imports.
            'vendor-pdf': [
              'vue-pdf-embed/dist/index.essential.mjs',
              'pdfjs-dist/legacy/build/pdf.mjs',
              'pdfjs-dist/legacy/web/pdf_viewer.mjs',
            ],
          },
        },
      },
    },
  }
})
