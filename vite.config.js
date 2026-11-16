import { defineConfig } from 'vite';

// Relative base so the build works at any path, e.g. sulavtimsina.com/android-mirror/
export default defineConfig({
  base: './',
  build: { target: 'es2022' },
});
