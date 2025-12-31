import { defineConfig } from 'vite'

export default defineConfig({
  root: 'src',
  publicDir: '../static',
  base: './',              // REQUIRED for Electron
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    assetsDir: 'assets',   // IMPORTANT for proper shader/audio paths
  }
})
