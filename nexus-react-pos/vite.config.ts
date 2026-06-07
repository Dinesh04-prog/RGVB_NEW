import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    hmr: true,
  },
  build: {
    // Increase the chunk warning limit to avoid CI/build failures on large bundles.
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('xlsx')) return 'vendor_xlsx';
            if (id.includes('html2canvas')) return 'vendor_html2canvas';
            return 'vendor';
          }
        }
      }
    }
  },
})
