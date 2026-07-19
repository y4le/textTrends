import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  // GitHub Pages serves the app from /textTrends/.
  base: '/textTrends/',
  plugins: [react()],
});
