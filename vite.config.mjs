import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const wwwDir = path.resolve(__dirname, 'www');

// Automatically discover all HTML entry points in www/ so existing pages are preserved
function getHtmlEntries(dir, baseDir = dir) {
  const entries = {};
  if (!fs.existsSync(dir)) return entries;
  const items = fs.readdirSync(dir, { withFileTypes: true });
  for (const item of items) {
    const fullPath = path.join(dir, item.name);
    if (item.isDirectory()) {
      if (item.name === 'api' || item.name === 'node_modules') continue;
      Object.assign(entries, getHtmlEntries(fullPath, baseDir));
    } else if (item.isFile() && item.name.endsWith('.html')) {
      const relPath = path.relative(baseDir, fullPath).replace(/\\/g, '/');
      const entryKey = relPath.replace(/\.html$/, '');
      entries[entryKey] = fullPath;
    }
  }
  return entries;
}

const htmlEntries = getHtmlEntries(wwwDir);

export default defineConfig({
  root: 'www',
  plugins: [react()],
  resolve: {
    alias: {
      '/src': path.resolve(__dirname, './src'),
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
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
    outDir: '../dist',
    emptyOutDir: true,
    rollupOptions: {
      input: htmlEntries,
    },
  },
});
