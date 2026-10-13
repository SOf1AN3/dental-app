import { builtinModules } from 'node:module'
import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'

const nodeBuiltins: string[] = builtinModules.filter((name) => !name.startsWith('_'))

/** `electron` + modules natifs Node.js (avec et sans préfixe `node:`). */
const externals: string[] = ['electron', ...nodeBuiltins, ...nodeBuiltins.map((name) => `node:${name}`)]

/**
 * Configuration electron-vite.
 *
 * Il n'y a **aucune section renderer** ici : le renderer est l'application Next.js
 * existante (App Router), servie par `next dev` / `next start` et chargée par URL
 * (cf. `ELECTRON_START_URL` dans `electron/main.ts`).
 *
 * En mode dev (`electron-vite dev`), electron-vite reconstruit `main` et `preload`
 * en watch (redémarrage automatique d'Electron) ; le serveur Next.js est lancé
 * séparément (`npm run dev`).
 */
export default defineConfig({
  main: {
    build: {
      lib: {
        entry: resolve(__dirname, 'electron/main.ts'),
        formats: ['cjs'],
      },
      outDir: 'dist-electron/main',
      rollupOptions: {
        external: externals,
        output: {
          format: 'cjs',
          entryFileNames: '[name].js',
        },
      },
    },
  },
  preload: {
    build: {
      lib: {
        entry: resolve(__dirname, 'electron/preload.ts'),
        // `sandbox: true` impose du CommonJS : Electron ne sait pas charger un preload ESM sandboxé.
        formats: ['cjs'],
      },
      outDir: 'dist-electron/preload',
      rollupOptions: {
        external: externals,
        output: {
          format: 'cjs',
          entryFileNames: '[name].js',
          exports: 'auto',
        },
      },
    },
  },
})
