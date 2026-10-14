import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Convention: params/vars prefixed with "_" are intentionally unused.
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Artefacts de build du desktop Electron (gitignorés et régénérés à chaque
    // build) : jamais du code source, et leur contenu dépend des `externals`
    // d'electron-vite — les lintier ferait varier le résultat selon l'ordre
    // `lint` / `build`.
    "dist-electron/**",
  ]),
]);

export default eslintConfig;
