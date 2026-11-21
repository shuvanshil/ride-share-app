import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '/src': path.resolve(__dirname, './src'),
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    root: 'www',
    fs: {
      allow: ['..'],
    },
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    // Pre-compiled bundles are committed to git so Vercel serves them statically.
    // Run `npm run build` locally before committing whenever a React page changes.
    outDir: 'www/js/react',
    emptyOutDir: false,
    rollupOptions: {
      input: {
        about:   'src/pages/About/main.jsx',
        contact: 'src/pages/Contact/main.jsx',
        terms:   'src/pages/Terms/main.jsx',
        help:    'src/pages/Help/main.jsx',
        safety:  'src/pages/Safety/main.jsx',
        privacy: 'src/pages/Privacy/main.jsx',
        profile: 'src/pages/Profile/main.jsx',
      },
      output: {
        entryFileNames: '[name].js',              // → www/js/react/about.js, contact.js
        chunkFileNames: 'chunks/[name]-[hash].js',
        format: 'es',
      },
    },
  },
});
