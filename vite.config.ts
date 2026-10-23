import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// `npm run dev:web` proxies the API and the media to `npm run dev:server`. changeOrigin must be off, and `'/api': 'http://...'` would turn it on: Vite
// reads the string form as { target, changeOrigin: true }, which rewrites the Host to localhost:8080. The server would then see an Origin (localhost:5173)
// that is not its own and refuse every POST as cross-site.
const toServer = () => ({ target: 'http://localhost:8080', changeOrigin: false });

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: { proxy: { '/api': toServer(), '/media': toServer(), '/healthz': toServer() } },
});
