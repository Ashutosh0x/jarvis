import { defineConfig } from 'vite'

export default defineConfig({
    /* GeoJSON is fetched at run time by URL, not imported, so it must be
       copied verbatim rather than transformed into a module. */
    assetsInclude: ['**/*.geojson'],
  root: 'src',
  publicDir: '../static',
  base: './',              // REQUIRED for Electron
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    assetsDir: 'assets',   // IMPORTANT for proper shader/audio paths
  }
})
