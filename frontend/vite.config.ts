import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

// Standalone Circuit Lab. `npm run dev` serves the UI on :5174 and forwards /api to the
// Flask service (python circuit_simulator/backend/server.py, :5050).
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  server: {
    port: 5174,
    // presets.json lives one level up (shared with the Python service)
    fs: { allow: [path.resolve(import.meta.dirname, '..')] },
    proxy: { '/api': { target: 'http://localhost:5050', changeOrigin: true } },
  },
});
