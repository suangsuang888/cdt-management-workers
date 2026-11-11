import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    // Workers 版：产物进 web/dist，供 wrangler [assets] directory = "./web/dist" 使用。
    // 原项目指向 ../app/static（Python 后端的静态目录），Workers 下不存在。
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
    cssCodeSplit: true,
  },
  server: {
    port: 5273,
    proxy: {
      '/api': 'http://127.0.0.1:8080',
    },
  },
})
