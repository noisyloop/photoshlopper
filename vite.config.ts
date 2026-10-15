import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// Everything is client-side and self-hosted, so the production page is locked
// to its own origin: an opened file can't make the browser fetch elsewhere.
// 'wasm-unsafe-eval' is for onnxruntime-web (Remove Background). Build-only:
// the dev server injects an inline React Refresh preamble this would block.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' data: blob:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const csp = (): Plugin => ({
  name: 'photoshlopper-csp',
  apply: 'build',
  transformIndexHtml: () => [
    { tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP }, injectTo: 'head-prepend' },
  ],
});

export default defineConfig({
  plugins: [react(), csp()],
  // onnxruntime-web locates its WASM glue at runtime; pre-bundling breaks that
  optimizeDeps: { exclude: ['onnxruntime-web'] },
  build: { target: 'es2021', chunkSizeWarningLimit: 1200 },
});
