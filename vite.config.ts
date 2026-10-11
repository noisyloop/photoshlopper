import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // onnxruntime-web locates its WASM glue at runtime; pre-bundling breaks that
  optimizeDeps: { exclude: ['onnxruntime-web'] },
  build: { target: 'es2021', chunkSizeWarningLimit: 1200 },
});
