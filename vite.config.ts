import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  optimizeDeps: { exclude: ['occt-wasm'] },
  build: { target: 'es2023' },
  worker: { format: 'es' },
});
