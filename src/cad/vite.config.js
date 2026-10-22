import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: { target: 'es2022', cssTarget: 'safari15' },
  worker: { format: 'es' },
  // `npm run dev` in this folder talks to a CAD Home server running on port 8080.
  // ws: true keeps live co-editing working while developing.
  server: { proxy: { '/api': { target: 'http://localhost:8080', ws: true } } },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
  },
});
