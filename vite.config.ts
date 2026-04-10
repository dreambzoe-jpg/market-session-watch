import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  return {
    plugins: [react(), tailwindcss()],
    define: {
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    build: {
      // Capacitor reads from the 'dist' folder by default (set in capacitor.config.ts)
      outDir: 'dist',
    },
    server: {
      port: 3000,
      hmr: false,
      proxy: {
        '/api': 'http://localhost:3001',
        '/auth': 'http://localhost:3001',
      },
    },
  };
});
