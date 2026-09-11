import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    open: false,
    proxy: {
      // 开发期：前端 API 请求代理到本地后端（npm run server）
      '/api': { target: 'http://localhost:8787', changeOrigin: true },
    },
  },
  build: { target: 'es2022' },
});
