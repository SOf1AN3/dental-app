import { builtinModules } from 'node:module'
import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'

const nodeBuiltins: string[] = builtinModules.filter((name) => !name.startsWith('_'))

/**
 * `electron` + modules natifs Node.js (avec et sans préfixe `node:`), plus les
 * paquets laissés en `require()` résolu au runtime.
 *
 * Depuis electron-vite v5, `externalizeDeps` vaut `true` par défaut : **toutes**
 * les `dependencies` sont donc externalisées (jamais bundlées) —
 * `dist-electron/main/main.js` contient ainsi des `require("electron-log")`,
 * `require("zod")`, `require("drizzle-orm/postgres-js")`, … résolus au runtime.
 * Seuls les paquets listés **explicitement** ci-dessous le sont parce qu'ils
 * exigent un traitement particulier :
 *
 * - **`embedded-postgres`** est **ESM** et effectue des `import('…')` littéraux
 *   vers ses `optionalDependencies` par plateforme (`@embedded-postgres/darwin-*`,
 *   `linux-*`, …) qui **ne sont pas installées** ici → Rollup échouerait dès que
 *   `electron/db/embedded-pg.ts` entre dans le graphe d'imports (étape 2.2).
 *   Il résout en plus ses binaires via `import.meta.url`, faux une fois converti
 *   en CJS par le format `main` ;
 * - **`@embedded-postgres/windows-x64`** : binaires natifs, jamais bundlés ;
 * - **`postgres`** : driver consommé par `embedded-pg.ts`, laissé externe pour
 *   le même cycle de résolution au runtime.
 */
const externals: string[] = [
  'electron',
  ...nodeBuiltins,
  ...nodeBuiltins.map((name) => `node:${name}`),
  'embedded-postgres',
  'postgres',
  '@embedded-postgres/windows-x64',
]

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
    // Vite/Rollup ignore les `paths` de `electron/tsconfig.json` : sans cet
    // alias, le build échouerait sur `@/lib/sync/protocol.ts` (et `@/lib/db/schema`)
    // importés par le runner de synchronisation (étape 5.5).
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src'),
      },
    },
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
