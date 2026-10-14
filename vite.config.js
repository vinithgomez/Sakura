import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset URLs: the same build works at a domain root (Vercel,
  // Netlify) and under a sub-path such as https://<user>.github.io/<repo>/
  // (GitHub Pages). It's a single page with no client-side routes, so
  // nothing needs an absolute base.
  base: './',
  server: {
    port: 5190,
    open: false,
  },
  build: {
    target: 'es2022', // top-level await in app.js (every WebGL 2 browser supports it)
    chunkSizeWarningLimit: 900,
  },
});
