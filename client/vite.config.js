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
            // stays lazy — it just gives the ~2.4MB pdf.js split a clear name
            // instead of the confusing "index" Rollup derives from its entry file.
            'vendor-pdf': ['vue-pdf-embed', 'pdfjs-dist'],
          },
        },
      },
    },
  }
})
