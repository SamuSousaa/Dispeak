import tailwindcss from '@tailwindcss/vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

// The browser only ever talks to its own origin: `/api` and `/media` are proxied to the
// services in dev, exactly like Caddy does in production.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiTarget = env.DEV_API_TARGET ?? 'http://localhost:4000';
  const mediaTarget = env.DEV_MEDIA_TARGET ?? 'http://localhost:4100';

  // getUserMedia needs a secure context: DEV_HTTPS=1 serves a self-signed certificate so other
  // LAN devices can join (localhost is already considered secure).
  const https = env.DEV_HTTPS === '1';

  return {
    plugins: [react(), tailwindcss(), ...(https ? [basicSsl()] : [])],
    server: {
      host: true,
      port: 5173,
      strictPort: true,
      proxy: {
        '/api': { target: apiTarget, ws: true, changeOrigin: true },
        '/media': { target: mediaTarget, ws: true, changeOrigin: true },
      },
    },
    preview: {
      port: 5173,
      strictPort: true,
      proxy: {
        '/api': { target: apiTarget, ws: true, changeOrigin: true },
        '/media': { target: mediaTarget, ws: true, changeOrigin: true },
      },
    },
    test: {
      include: ['src/**/*.test.{ts,tsx}'],
    },
  };
});
