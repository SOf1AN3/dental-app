# PLAN-ELECTRON.md — Bascule vers une application de bureau (Electron, local-first, sync bidirectionnelle)

> **Statut** : EN ATTENTE DE VALIDATION — aucun code applicatif modifié.
> **Date de rédaction** : 2026-10-13
> **Périmètre** : architecture Electron, stockage local (embedded-postgres), moteur de synchronisation, packaging Windows.
> **Note** : le `PLAN.md` existant (refonte visuelle) reste **intact et indépendant** ; il est toujours en attente de validation de son côté. Ce document le complète sans le remplacer.
> **Documents de référence réutilisés** : `DESKTOP-ELECTRON.md` (analyse Electron/Tauri du 2026-10-10) et `OFFLINE-PLAN.md` (archivé, décision D2 re-arbitrée ici — voir §2.1).

---

## Contexte & besoin métier

**DentalCare** (Next.js 16 App Router + Drizzle + PostgreSQL, 57 routes, 43 tables) est actuellement
100 % *server-rendered* : chaque lecture/écriture passe par des **Server Actions / Server Components**
qui interrogent PostgreSQL en direct. Aucune couche client, aucun cache, aucun Service Worker.

**Le besoin** : livrer une **application de bureau Windows** installée sur **2 à 5 postes fixes par
clinique**, qui :

1. **Fonctionne sans connexion** (local-first) — dossier médical complet, agenda, facturation,
   stock, prothèses, ordonnances.
2. **Se synchronise bidirectionnellement** avec la base PostgreSQL centrale (Vercel) dès qu'une
   connexion est disponible, sans intervention de l'utilisateur.
3. **Conserve le code serveur existant** : les ~22 fichiers de Server Actions, le multi-tenant,
   la matrice de permissions et l'authentification doivent être réutilisés à l'identique.

**Le constat structurant** (thèse de `DESKTOP-ELECTRON.md` §2) : en lançant un **serveur Next.js
local** dans Electron et en pointant `DATABASE_URL` vers une base **PostgreSQL locale**, le data
layer n'a **quasi rien à réécrire** — c'est exactement l'inverse d'une PWA ou d'un export statique.

**Décisions validées par le client (2026-10-13)** :

| # | Sujet | Décision |
|---|---|---|
| **D-1** | Architecture applicative | **Serveur Next.js embarqué** (build `standalone`) + base locale |
| **D-2** | Stockage local | **`embedded-postgres`** (vrais binaires PostgreSQL 18 embarqués) — *remplace D2 « PGlite » de l'OFFLINE-PLAN* |
| **D-3** | Portée de l'app bureau | **Espace `(clinic)` uniquement** + auth ; landing et espace `owner` restent web |
| **D-4** | Conflits | **Last Write Wins + protections ciblées** (montants verrouillés, suppressions jamais gagnantes, conflits journalisés) |
| **D-5** | Doublons patients | **Fusion automatique par identifiant natif** |
| **D-6** | Médias (radios) | **Disque local + sync en tâche de fond** (SHA-256, dédup, push S3) |
| **D-7** | Distribution | **Installer NSIS + auto-update + code signing** (`electron-builder` + `electron-updater`) |
| **D-8** | Auth hors-ligne | **Appareil de confiance + expiration** (login vérifié localement, confiance accordée en ligne) |
| **D-9** | Plan | **Fichier dédié `PLAN-ELECTRON.md`** (celui-ci) |

**Décisions antérieures réaffirmées** (OFFLINE-PLAN) : sync **automatique et continue** (D6),
**allouation de blocs** pour les numéros de documents (D4), **UTC en base**, **pas de P2P** — toute
convergence passe par le serveur central.

---

## Questions / décisions en attente

À trancher avant ou avant la fin de la Phase « Packaging » (elles ne bloquent pas les Phases 1-7) :

| # | Question | Impact | Proposition par défaut |
|---|---|---|---|
| **Q-1** | **Hébergement des releases** pour l'auto-update (GitHub Releases ? S3 ? Vercel Blob ?) | Phase 8 | GitHub Releases du repo existant |
| **Q-2** | **Certificat de code signing** : qui l'achète, quel type (OV vs EV), qui gère le pipeline de signature ? | Phase 8 | Sans certificat, SmartScreen s'affiche (coût humain accepté si postes gérés par la DSI) |
| **Q-3** | **Chiffrement du disque** (BitLocker/VeraCrypt) : les binaires PostgreSQL stockent les données médicales **en clair** dans `userData/pgdata` | Sécurité | À **signifier par écrit au client** ; prérequis non technique |
| **Q-4** | **Version Windows cible** (10 / 11 ?) et architecture (x64 uniquement ?) | Phase 8 | Windows 10/11 x64 |
| **Q-5** | **Port PostgreSQL local** : fixe (5433) ou détecté dynamiquement à chaque démarrage ? | Phase 2 | Dynamique avec persistance dans `userData/config.json` (évite les conflits si PG système installé) |
| **Q-6** | **Bootstrap initial** : premier lancement d'un poste vierge = pull complet depuis le serveur central (pagination, volume à estimer) | Phase 5 | Pull paginé par `clinic_id` |
| **Q-7** | **La base centrale reste-t-elle la source de vérité unique ?** (supposée oui : le serveur Vercel continue de tourner pour le web) | Phase 4 | Oui — validé implicitement par D-1/D-3 |

---

## 1. Structure du projet & séparation des processus

### 1.1 Principe d'architecture

```
┌──────────────────────────── POSTE DU CABINET (Windows) ────────────────────────────┐
│                                                                                    │
│  ┌─ PROCESSUS MAIN (Electron) ──────────────────────────────────────────────────┐  │
│  │  electron/main.ts        : lifecycle, single-instance-lock, tray, menu        │  │
│  │  electron/db/embedded-pg.ts : initdb/start/stop du cluster PG local           │  │
│  │  electron/server/next.ts  : spawn du serveur Next standalone (127.0.0.1:PORT)  │  │
│  │  electron/env.ts          : génère DATABASE_URL + AUTH_SECRET locaux          │  │
│  │  electron/sync/runner.ts  : ORCHESTRATEUR DE SYNC (pull/push, hors fenêtre)   │  │
│  │  electron/updater.ts      : electron-updater                                  │  │
│  │  electron/ipc.ts + preload.ts : pont contrôlé vers le renderer                │  │
│  └──────────────┬────────────────────────────────────────────────────────────────┘  │
│                 │ démarre & supervise                                                │
│                 ▼                                                                     │
│  ┌─ SERVEUR NEXT LOCAL (processus enfant) ──────────────────────────────────────┐   │
│  │  .next/standalone/server.js  →  http://127.0.0.1:<port>                      │   │
│  │    ├── Server Actions ……………… INCHANGÉES (drizzle-orm/postgres-js)            │   │
│  │    ├── NextAuth v5 …………………… sessions locales, cookies non-secure             │   │
│  │    └── Drizzle ──────────────► PostgreSQL embarqué (userData/pgdata)          │   │
│  └──────────────┬────────────────────────────────────────────────────────────────┘   │
│                 │ loadURL('http://127.0.0.1:<port>')                                 │
│                 ▼                                                                     │
│  ┌─ PROCESSUS RENDERER (sandboxed) ─────────────────────────────────────────────┐   │
│  │  Next.js App Router, UI (clinic), Client Components, Sonner, Zustand          │   │
│  │  lit l'état sync via contextBridge (window.desktop) — PAS de Node, PAS d'fs   │   │
│  └────────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                    │
│  Données : userData/pgdata (PG) · userData/uploads (radios, dédup SHA-256)         │
└────────────────────────────────────────────────────────────────────────────────────┘
                 │ HTTPS (uniquement en ligne)
                 ▼
        SERVEUR CENTRAL (Vercel) — source de vérité
        /api/sync/push · /api/sync/pull · /api/sync/blocks · /api/health
```

**Réponse à la question 1 du cahier des charges** : la séparation est physique (processus OS distincts)
et le Renderer **n'a jamais accès aux données directement** — il appelle des Server Actions, qui
tournent dans le serveur Next local. Le Main Process ne touche qu'à l'**infrastructure** (PG, spawn,
réseau, updates) et à la **sync**, jamais au rendu.

### 1.2 Arborescence cible (fichiers exacts)

```
electron/
  main.ts                 # CRÉER — entrypoint, app lifecycle, single-instance-lock
  window.ts               # CRÉER — BrowserWindow (contextIsolation, sandbox, CSP)
  preload.ts              # CRÉER — contextBridge → window.desktop (API minimale)
  ipc.ts                  # CRÉER — handlers : sync:status, sync:trigger, net:state, paths
  env.ts                  # CRÉER — DATABASE_URL/AUTH_SECRET/PORT locaux (safeStorage)
  db/embedded-pg.ts       # CRÉER — cycle de vie embedded-postgres
  server/next.ts          # CRÉER — spawn/kill du build standalone + health-check
  sync/runner.ts          # CRÉER — orchestrateur (boucle push/pull, backoff)
  updater.ts              # CRÉER — electron-updater (autoInstallOnAppQuit)
  dev.ts                  # CRÉER — point d'entrée dev (next dev + electron)
electron.vite.config.ts   # CRÉER — bundler main+preload (renderer = Next, non géré)
electron-builder.yml      # CRÉER — config NSIS, asarUnpack des binaires PG
scripts/build-desktop.ts  # CRÉER — next build (standalone) + copie static/public
src/lib/db/desktop-db.ts  # CRÉER — client Drizzle lazy, URL injectée par l'env
src/lib/sync/*            # CRÉER — moteur partagé (voir §4)
src/app/api/sync/*        # CRÉER — routes CENTRALES (déployées sur Vercel)
src/components/offline/*  # CRÉER — UI sync (voir §5)
next.config.ts            # MODIFIER — output conditionnel 'standalone'
package.json              # MODIFIER — deps electron + scripts
```

> ⚠️ **`electron/` est un nouveau dossier TypeScript** : il doit être compilé par `electron-vite`
> (Rollup), pas par `tsc` seul — sinon les imports transverses (`src/lib/sync`, `src/lib/db`)
> ne sont pas bundlés.

### 1.3 Sécurité de la coque (non négociable)

| Règle | Valeur |
|---|---|
| `contextIsolation` | `true` |
| `nodeIntegration` | `false` |
| `sandbox` | `true` (BrowserWindow) |
| `webSecurity` | `true` |
| CSP | stricte, servie par `headers()` dans `next.config.ts` (voir §6.4) |
| `shell.openExternal` | uniquement sur URL **allow-listée** |
| Écoute réseau | **`127.0.0.1` uniquement**, jamais `0.0.0.0` |
| Instance unique | `app.requestSingleInstanceLock()` |
| Modules `remote` | interdits |

### 1.4 Next.js : serveur embarqué vs export statique — **décision D-1**

**Choix retenu : serveur embarqué (`output: 'standalone'`).** Justification :

- L'**export statique** (`output: 'export'`) supprime les Server Actions, les Route Handlers et
  le SSR → **réécriture intégrale du data layer** (≈ 22 fichiers de actions, 43 tables, multi-tenant).
  C'est le scénario que `DESKTOP-ELECTRON.md` qualifie de « refonte la plus risquée ».
- Le mode `standalone` produit `.next/standalone/` = serveur + dépendances minimales, empaquetable.

**Implémentation** :
- `next.config.ts` : `output: process.env.NEXT_OUTPUT === "standalone" ? "standalone" : undefined`
  → le build **web Vercel reste strictement identique**, seul le build desktop passe par l'env.

> ⚠️ **À vérifier impérativement au démarrage (Étape 1)** : la doc Next.js 16 embarquée dans
> `node_modules/next/dist/docs/` ne contient que `index.md` (69 lignes, aucun contenu sur
> `output`). **Aller sur la doc en ligne Next 16** (`nextjs.org/docs/app/api-reference/config/next-config-js/output`)
> et vérifier : (a) que `standalone` existe toujours, (b) la procédure de copie de
> `.next/static` + `public/` dans `standalone/`, (c) les éventuelles ruptures de convention
> (cf. `AGENTS.md` : « This version has breaking changes »). **C'est le point de risque n°1
> de l'Étape 1.**

### 1.5 Chaîne de build

| Outil | Rôle |
|---|---|
| **`electron-vite`** | bundle `electron/main.ts` + `preload.ts` (TS → CJS/ESM, watch en dev). Le renderer n'est **pas** géré (c'est Next). |
| **`next build`** + `NEXT_OUTPUT=standalone` | produit `.next/standalone/` |
| **`scripts/build-desktop.ts`** | copie `.next/static` → `standalone/.next/static`, `public/` → `standalone/public`, copie les binaires PG |
| **`electron-builder`** | NSIS, `asarUnpack` pour `standalone/` et les binaires PG, `extraResources` |
| **`electron-updater`** | mises à jour différées (Q-1) |
| **`electron-log`** | logs main + sync (indispensable pour diagnostiquer un poste distant) |

**Packages à installer** :

```
# dependencies (l'app embarque ces binaires !)
embedded-postgres          ← DÉJÀ en devDependencies → à PROMOUVOIR en dependencies
                            (+ optionalDependencies @embedded-postgres/windows-x64 déjà gérées)
electron-updater
electron-log

# devDependencies
electron                   (^33+ — à confirmer la dernière LTS stable au moment du build)
electron-builder           (^25+)
electron-vite              (^4+)
concurrently
wait-on
cross-env
```

**Scripts `package.json`** :
```jsonc
"dev:desktop": "electron-vite dev",            // next dev lancé par electron/server en dev
"build:desktop": "NEXT_OUTPUT=standalone next build && tsx scripts/build-desktop.ts",
"dist:win": "electron-vite build && npm run build:desktop && electron-builder --win nsis",
"typecheck:desktop": "tsc --noEmit -p electron/tsconfig.json"
```

---

## 2. Base de données locale

### 2.1 Choix : `embedded-postgres` (D-2)

| Solution | Verdict |
|---|---|
| **`embedded-postgres`** ✅ | **Vrais binaires PostgreSQL 18** (déjà en devDependencies). Même dialecte → **43 tables, 17 migrations `drizzle/*.sql` et le driver `drizzle-orm/postgres-js` sont réutilisés à l'identique**. Performances natives. Radios : fichier disque réel, pas de quota. |
| `PGlite` (ex-D2) | Rejeté par D-2 : WASM, plus lent, et impose des contraintes COOP/COEP côté navigateur. L'avantage « même dialecte » est obtenu aussi par embedded-postgres, en mieux. |
| `better-sqlite3` | Dialecte différent → **réécriture des 17 migrations et des requêtes sur 43 tables**. Réjecté. |
| `PouchDB` / `WatermelonDB` | Conçus pour la replication auto, mais **incompatibles avec Drizzle/Server Actions** → réécriture complète. Rejeté. |

**Avantage décisif** : comme `embedded-postgres` ouvre un vrai socket TCP PostgreSQL,
`src/lib/db/db.ts` **ne change presque pas** — seule l'URL change
(`postgres://user:pass@127.0.0.1:<port>/dentalcare`).

### 2.2 Cycle de vie du cluster (main process)

Fichier : **`electron/db/embedded-pg.ts`** (CRÉER)

| Étape | Détail |
|---|---|
| **Répertoire** | dev : `./pgdata` (existe déjà à la racine) · prod : `app.getPath('userData')/pgdata` |
| **Initialisation** | 1er lancement uniquement : `initialise()` du package (initdb + user/password) |
| **Port** | Q-5 : persistance dans `userData/config.json`, sinon première valeur libre ≥ 5433 |
| **Démarrage** | `start()` **avant** le spawn du serveur Next — avec timeout + relance |
| **Password** | généré aléatoirement au init, stocké via **`safeStorage`** (Credential Manager Windows) |
| **Arrêt** | `stop()` sur `before-quit`, avec timeout de secours (le package embarque `async-exit-hook`) |
| **Santé** | health-check `SELECT 1` avant de lancer Next ; **2 échecs → écran d'erreur + retry** |
| **Corruption** | si le cluster ne démarre pas → proposer **réinitialisation locale** (les données sont sur le serveur central, aucun risque de perte totale) |

### 2.3 Connexion Drizzle & séparation web/desktop

| Fichier | Rôle |
|---|---|
| `src/lib/db/db.ts` (EXISTANT) | **inchangé pour le web** ; `validateEnv()` reste en top-level |
| `src/lib/db/desktop-db.ts` (CRÉER) | client Drizzle **lazy** pour le processus main (sync runner) : reçoit l'URL via paramètre, zéro lecture `process.env` au import |
| `electron/env.ts` (CRÉER) | construit l'env du serveur enfant : `DATABASE_URL`, `AUTH_SECRET` (≥ 32 chars, `safeStorage`), `AUTH_URL=http://localhost:<port>` (**cohérent avec `START_URL` et la whitelist `window.ts`** : un `127.0.0.1` divergerait et casserait les redirections NextAuth), `PORT`, `HOSTNAME=127.0.0.1`, `UPLOAD_DIR=userData/uploads` |

> ** piège identifié ** : `db.ts` exécute `validateEnv()` au **top-level**. Un import de `db.ts`
> depuis le main process avant génération de l'env provoquerait un crash. D'où `desktop-db.ts`
> dédié (lazy) — **ne jamais importer `db.ts` depuis `electron/`**.

### 2.4 Migrations locales

- **Réutiliser les 17 fichiers `drizzle/*.sql` déjà versionnés**, via le mécanisme existant
  (`src/lib/db/migrate.ts` + table des migrations Drizzle).
- **`electron/server/next.ts` déclenche les migrations** au démarrage *après* santé PG et
  *avant* le premier `loadURL` (migration idempotente = pas de casse).
- Nouvelles migrations générées par `drizzle-kit generate` : **committées, appliquées aux deux
  bases** (web et desktop) — c'est l'avantage du dialecte unique.
- ⚠️ **A-4 de l'OFFLINE-PLAN** : nettoyer les artefacts `.js` commités dans `drizzle/` avant
  d'ajouter de nouvelles migrations.

### 2.5 Colonnes de synchronisation à ajouter

**Constat relevé** : 43 tables `pgTable(` mais seulement **12 occurrences de `updated_at`** dans
`src/lib/db/schema/*` → **la très grande majorité des tables n'a aucune colonne exploitable pour
un curseur de pull.**

Migration unique à générer (**`src/lib/db/schema/sync.ts` + migration SQL**) :

```sql
-- sur CHAQUE table sync-able (identique partout) :
ALTER TABLE <t> ADD COLUMN updated_at  timestamptz NOT NULL DEFAULT now();  -- + $onUpdate Drizzle
ALTER TABLE <t> ADD COLUMN device_id   text;              -- dernier auteur (TEXT, comme device.id — aucun type uuid dans ce projet)
ALTER TABLE <t> ADD COLUMN rev         bigint NOT NULL DEFAULT 0;          -- version monotone
ALTER TABLE <t> ADD COLUMN deleted_at  timestamptz;                         -- TOMBSTONE
CREATE INDEX <t>_sync_cursor ON <t> (clinic_id, updated_at, id);            -- curseur de pull
```

> 🔑 **`rev` est attribué côté SERVEUR** (incrément monotone) — **jamais l'horloge client** :
> une horloge fausse sur un poste ne doit jamais écraser une donnée récente (cf. edge cases §7).

**Tables sync-ables (à confirmer par inventaire en Phase 2)** :
`patient`, `appointment`, `clinical_session`, `treatment_plan` (+ `_item`), `invoice` (+ `_item`),
`quote` (+ `_item`), `prescription` (+ `_item`), `payment`, `stock_item`, `prosthesis_*`,
`waiting_room`, `audit`… **et impérativement les tables enfants** (`invoice_item`, `quote_item`,
`sessions`…) : sinon une facture se réplique **sans ses lignes**.

**Tables NON sync-ables** : `users`/`sessions` (auth, gérée par le bootstrap), `subscription`
(paiements, web seulement), tables `owner`.

**Tables à créer** (reprises de l'OFFLINE-PLAN §5, adaptées) :

```
sync_outbox   : id · table_name · row_id · op(insert|update|delete) · payload(jsonb)
                · device_id · seq · created_at · status(pending|sent|failed) · attempts · last_error
                → index (status, seq)
sync_state    : key(PK) · value(jsonb) · updated_at          ← last_pull_cursor, last_push_at
sync_conflict : id · table_name · row_id · device_id · winning_payload · losing_payload
                · decided_at · reason · resolved_by           ← visibilité humaine (D-4)
sync_merge    : id · table · canonical_id · duplicate_id · reason(native_id|phone|uuid) · merged_at
                ← D-5 fusion automatique par identifiant natif
--- côte SERVEUR CENTRAL uniquement ---
sync_applied  : op_id(PK) · device_id · applied_at           ← idempotence du push
device        : id(PK) · clinic_id · user_id · name · os · first_seen_at · last_seen_at
                · last_sync_at · trust_expires_at            ← D-8 appareil de confiance
document_sequence : [EXISTANT] + block_start · block_end · block_device_id · block_status
```

---

## 3. API Routes / Server Actions

### 3.1 Routes CENTRALES (sur le projet web Vercel existant — à créer)

| Route | Fichier exact | Rôle |
|---|---|---|
| `POST /api/sync/push` | `src/app/api/sync/push/route.ts` | Applique l'outbox d'un device. **Idempotent** via `op_id` (`sync_applied`). Transaction par `(clinic_id, device_id)`. **Re-valide chaque `clinicId` côté serveur** (un client compromis ne doit pas injecter de lignes étrangères). |
| `GET /api/sync/pull` | `src/app/api/sync/pull/route.ts` | Changements depuis un curseur `(clinic_id, updated_at, id)`, **paginé** (timeout Vercel si un poste est offline des semaines). Retourne aussi les **tombstones**. |
| `POST /api/sync/blocks` | `src/app/api/sync/blocks/route.ts` | Réservation de blocs de numérotation (D4) — **réutilise la décision OFFLINE-PLAN D4**. |
| `GET /api/health` | `src/app/api/health/route.ts` | Sonde de connectivité fine (distinguer « pas d'internet » / « serveur en panne »). |
| `POST /api/sync/trust` | `src/app/api/sync/trust/route.ts` | Accorde/révole la confiance d'un device (D-8), avec `trust_expires_at`. |

**Idempotence / ordre / tombstones** (règles reprises telles quelles de l'OFFLINE-PLAN §6) :
- chaque opération porte un `op_id` UUID client → appliquée **une seule fois** ;
- respect de `seq` par device, et **ordre parent→enfant** (`patient` avant `invoice`) ;
- suppressions poussées en `op=delete` avec `deleted_at` (**jamais de hard delete poussé**) ;
- push traité **en transaction** ; push interrompu → reprise sans doublon.

### 3.2 Routes LOCALES (serveur Next embarqué)

Le serveur local tourne **le même code** que le web. Adaptations à vérifier en Étape 2 :

| Route | Comportement local |
|---|---|
| `/api/auth/[...nextauth]` | NextAuth v5 avec `AUTH_URL=http://localhost:<port>` → **cookies `useSecureCookies: false`** (sinon aucun cookie n'est écrit en HTTP local). Fichier : `src/lib/auth.ts` (à localiser et adapter par env `AUTH_INSECURE_COOKIES=1`). |
| `/api/files/[...key]` | sert `UPLOAD_DIR` local au lieu de S3 (**obligatoire** : corrige aussi la faille SEC-B05 — aucune URL publique permanente). |
| `/api/cron/*` | **désactivés en local** (pas de cron) → remplacés par des tâches planifiées du main process (expiration devis, rappels abonnement) — **hors périmètre D-3**, simple no-op local. |
| `/api/drugs/search` | inchangé (base locale) ou fallback réseau si catalogue distant. |
| Server Actions (22 fichiers) | **INCHANGÉES** — c'est le gain central de D-1. |

### 3.3 Écran de démarrage (bootstrap)

- **Premier lancement** : PG vide → Next sert l'écran login → **pull complet paginé** (Q-6) →
  l'app devient utilisable hors-ligne.
- **Si offline au 1er lancement** : message explicite « Connexion requise pour la première
  synchronisation » (aucune donnée inventée).

---

## 4. Moteur de synchronisation

### 4.1 Détection de la connexion (réponse à la question 3-a)

**Deux niveaux, cumulatifs** :

1. **Capteur système** — `electron/net` (module `net.isOnline()` + événements `online`/`offline`)
   dans le main process → transmis au renderer via IPC (`net:state`).
2. **Sonde applicative** — `GET /api/health` (timeout 5 s) : distingue *pas d'internet* du
   *serveur central inaccessible*. Tant que `health` échoue → **état « en attente »** (pas
   d'erreur à l'utilisateur), avec backoff **exponentiel + jitter** (1 s → 5 s → 30 s → 5 min, plafond).

Fichier : **`src/lib/sync/net.ts`** (CRÉER) + **`electron/sync/runner.ts`**.

> **L'orchestrateur vit dans le main process** (pas dans le renderer) : il doit continuer à
> synchroniser quand la fenêtre est minimisée, et survivre à un rechargement de page.

### 4.2 File d'attente hors-ligne (réponse à la question 3-c)

```
Écriture UI (Server Action)
   │  1. transaction locale : UPDATE/INSERT réel  +  INSERT dans sync_outbox (même tx)
   ▼
sync_outbox (status=pending, seq croissant)
   │  2. runner détecte en ligne → push par lots (100 ops/req), ordre respecté
   ▼
POST /api/sync/push  →  200 : status=sent   |  4xx : status=failed (retry limité)  |  5xx : retry backoff
```

- **Atomicité garantie** : outbox et mutation sont écrites **dans la même transaction locale** —
  aucune mutation ne peut exister sans être journalisée (et inversement).
- **Retry** : `attempts` + `last_error` ; après 10 échecs → `failed` visible dans l'UI
  (l'utilisateur doit pouvoir voir et rejouer manuellement).
- **Pull** : boucle séparée, applique les changements distants **en ignorant** les lignes
  modifiées localement en attente (le conflit est résolu au push, cf. §4.4).

Fichiers : **`src/lib/sync/outbox.ts`**, **`electron/sync/runner.ts`** (CRÉER).

### 4.3 Résolution des conflits (réponse à la question 3-b) — D-4

**LWW par défaut, arbitré par le serveur central** :

| Règle | Implémentation |
|---|---|
| **Gagnant = le serveur** | Le serveur calcule `max(rev)` : la mutation cliente n'écrit que si `payload.rev > row.rev` ; sinon elle est **rejetée mais journalisée**. Pas d'horloge client. |
| **Montants verrouillés** | Une `invoice`/`quote` dont le statut dépasse `draft` : les champs `total_*`, `tax_*`, `lines` sont **ignorés en cas de conflit** (verrouillage applicatif `src/lib/sync/locks.ts`). |
| **Suppressions jamais gagnantes** | Si A supprime et B modifie → **la modification l'emporte**, la suppression est annulée et journalisée. |
| **Traçabilité** | Tout conflit écrit `sync_conflict` (payload gagnant/périmant, device, motif). |
| **Revue humaine** | Un écran (§5.2) liste les conflits ; l'humain tranche *a posteriori*. **La sync n'est jamais bloquée** (D-6 : continue). |

Fichiers : **`src/lib/sync/conflict.ts`**, **`src/lib/sync/locks.ts`** (CRÉER).

### 4.4 Fusion des doublons patients — D-5

- Deux postes créent hors-ligne le **même patient** → les deux lignes arrivent au serveur.
- **Fusion automatique** déclenchée par **identifiant natif** (UUID partagé, n° patient, ou
  téléphone normalisé) : une ligne devient **canonique**, l'autre est redirigée dans `sync_merge`
  et remplacée par un **tombstone + redirection** (`duplicate_id → canonical_id`).
- **Règle de prudence à définir dans le code** : fusion **uniquement** si `nom+prénom` ou
  `dateNaissance` correspondent aussi — sinon **journaliser en conflit pour revue humaine**
  (éviter de fusionner deux personnes distinctes partageant un numéro de téléphone).
- Les références enfant (`appointment.patient_id`…) sont **réorientées en transaction**.

Fichier : **`src/lib/sync/merge.ts`** (CRÉER).

### 4.5 Numérotation des documents (D-4 OFFLINE-PLAN réaffirmé)

- Réutilisation intégrale du mécanisme **d'allocation par bloc réservé** (`/api/sync/blocks`).
- **Bloc épuisé hors-ligne → refus explicite** de créer une facture (jamais de numéro inventé).
- Interdiction de renuméroter après impression.

Fichiers : **`src/lib/sync/numbering.ts`** (CRÉER), **`src/lib/db/schema/financial.ts`** (MODIFIER).

### 4.6 Médias / radiographies — D-6

| Tâche | Fichier |
|---|---|
| Stockage disque + dédup **SHA-256** | **CRÉER** `src/lib/offline/blob-store.ts` → `userData/uploads/` |
| Écriture locale immédiate, **push S3 en tâche de fond** | **CRÉER** `src/lib/sync/media-sync.ts` (jamais pendant une écriture clinique) |
| Téléchargement différé des radios distantes (favoris + N derniers jours) | idem |
| Indicateur « nécessite connexion » sur les vignettes radios | **MODIFIER** le composant d'affichage des médias |
| Panel « espace disque utilisé » | **CRÉER** `src/components/settings/storage-panel.tsx` |

> 🔒 **Conditionné par SEC-B05** : tout accès aux fichiers passe par `/api/files/[...key]`
> **authentifiée** — jamais par une URL publique permanente.

---

## 5. UI Components

### 5.1 Indicateur d'état de sync — **OBLIGATOIRE EN PREMIER**

> Sans indicateur, l'utilisateur **ne sait jamais** si sa donnée est locale ou serveur → cause
> n°1 d'abandon d'une migration local-first.

| Fichier | Rôle |
|---|---|
| **CRÉER** `src/components/offline/sync-status.tsx` | Badge global : `Synchronisé · En attente (n) · Hors-ligne · Conflit (n)` — polling de l'état via IPC (`sync:status`) |
| **CRÉER** `src/components/offline/sync-queue-sheet.ts` | Détail de la file : opérations en attente, dernières erreurs, bouton « Synchroniser maintenant » |
| **MODIFIER** `src/app/(clinic)/layout.tsx` | Intégration du badge (header) |
| **CRÉER** `src/hooks/use-desktop.ts` | Accès typé à `window.desktop` + fallback web (undefined = version web) |

### 5.2 Écrans de conflit & doublons

| Fichier | Rôle |
|---|---|
| **CRÉER** `src/components/offline/conflict-list.tsx` | Liste des `sync_conflict` (payload gagnant/périmant, motif) |
| **CRÉER** `src/components/offline/merge-review.tsx` | Doublons patients proposés à fusion/réparation (D-5) |
| **CRÉER** `src/app/(clinic)/settings/sync/page.tsx` | Page paramètres « Synchronisation » : état, file, conflits, appareils, espace disque |

### 5.3 Comportement hors-ligne

- **Formulaire en cours + perte de réseau** : ne **jamais** vider ni bloquer — l'écriture est
  locale et réussit (toast « Enregistré localement — synchronisation en attente »).
- **Pas de rechargement de page forcé** pendant une saisie (règle reprise de l'OFFLINE-PLAN P-6).
- **Sonner** les événements de sync via `sonner` (déjà installé).

---

## 6. Packaging, distribution & mises à jour (D-7)

### 6.1 `electron-builder.yml` (CRÉER)

```yaml
appId: com.dentalcare.desktop
productName: DentalCare
win:
  target: [{ target: nsis, arch: [x64] }]
  icon: build/icon.ico          # CRÉER — aucun icône dans public/ (constat OFFLINE-PLAN P-2)
nsis:
  oneClick: false
  allowToChangeInstallationDirectory: true
  deleteAppDataOnUninstall: false     # ⚠️ pgdata + radios doivent SURVIVRE à la désinstallation
asar: true
asarUnpack:
  - "**/node_modules/embedded-postgres/**"   # binaires PG hors asar
  - "**/.next/standalone/**"                 # serveur Next spawnable
files:
  - "dist-electron/**"
  - ".next/standalone/**"
  - "package.json"
extraResources:
  - { from: ".next/static", to: "app/.next/static" }
  - { from: "public",       to: "app/public" }
```

> ⚠️ **Piège NSIS** : par défaut la désinstallation efface `userData`. Les données médicales
> locales doivent être **sauvegardées/manquantes explicitement** — à trancher (Q-3).

### 6.2 Auto-update

- `electron-updater`, canal `latest`, téléchargement en arrière-plan,
  `autoInstallOnAppQuit: true` (**jamais** d'installation pendant une saisie clinique).
- Hébergement : **Q-1** (défaut proposé : GitHub Releases).
- Version minimale requise imposée côté serveur (`min_version` renvoyé par `/api/health`).

### 6.3 Code signing

- `win.certificateFile` / `certificateSubjectName` via variable d'env CI (jamais commitée).
- Sans certificat → SmartScreen « Windows a protégé votre ordinateur » (analysé dans
  `DESKTOP-ELECTRON.md` §4.1 : OV ~100-200 $/an, EV ~300-500 $/an, aucun = clic manuel).

### 6.4 Durcissement (checklist de fin de phase)

- [ ] CSP stricte servie par `next.config.ts` (actuellement **absente** → à ajouter)
- [ ] `contextIsolation` / `sandbox` / `nodeIntegration:false` vérifiés au runtime
- [ ] `shell.openExternal` filtré (allow-list `https://` + domaines connus)
- [ ] serveur local en `127.0.0.1` + password PG fort + port non standard
- [ ] `AUTH_SECRET` via `safeStorage` (jamais en clair dans un `.env` packagé)
- [ ] aucune donnée médicale dans les logs (`electron-log`)
- [ ] `pgdata` exclu des rapports de crash
- [ ] cookies NextAuth locaux en `httpOnly` + `sameSite=lax`
- [ ] le push central re-valide **chaque** `clinicId` (pas de confiance au payload)

---

## 7. Tests

| # | Test | Fichier exact | Phase |
|---|---|---|---|
| **T-1** | Idempotence du push (`op_id` rejoué = 1 seule écriture) | `src/app/api/sync/push.test.ts` | 5 |
| **T-2** | Curseur de pull sans perte (2 lignes, même milliseconde) | `src/app/api/sync/pull.test.ts` | 5 |
| **T-3** | LWW + protections (montant verrouillé, suppression perdante) | `src/lib/sync/conflict.test.ts` | 6 |
| **T-4** | Verrouillage facturation | `src/lib/sync/locks.test.ts` | 6 |
| **T-5** | Allocation de blocs — **aucun doublon possible**, bloc épuisé = refus | `src/lib/sync/numbering.test.ts` | 6 |
| **T-6** | Fusion doublons patients (fusionne si homonyme+naissance, sinon conflit) | `src/lib/sync/merge.test.ts` | 6 |
| **T-7** | Outbox : mutation locale toujours journalisée même si offline | `src/lib/sync/outbox.test.ts` | 5 |
| **T-8** | Migrations locales sur base vierge (17 fichiers + migration sync) | `src/lib/db/migrate.test.ts` | 2 |
| **T-9** | Recette manuelle 2 postes (voir ci-dessous) | manuel | 7 |

**Recette manuelle obligatoire (2 postes réels, coupure réseau PHYSIQUE)** :
1. Patient créé offline sur A → visible sur B après sync.
2. Deux factures créées offline sur A et B → **numéros distincts, zéro doublon**.
3. Même patient modifié sur A et B → **LWW respecté + conflit journalisé**.
4. Redémarrage offline → données toujours là (`pgdata` persistant).
5. Bloc épuisé offline → **refus explicite**.
6. Fusion automatique de deux patients identiques créés offline sur A et B.

---

## Sécurité & edge cases à couvrir

**Multi-tenant (risque n°1)**
- Toute lecture par ID vérifie l'appartenance à la `clinicId` courante.
- Le **push central re-valide chaque `clinicId`** — un client compromis ne doit pas injecter de
  lignes étrangères. `device_id` lié à `user_id`+`clinic_id` **côté serveur**.

**Conflits & données**
- Suppression locale vs modification distante → la **modification gagne** (jamais l'inverse).
- Patient créé en double sur 2 postes → fusion automatique par identifiant natif **avec garde-fou**
  (nom/naissance) sinon revue humaine (D-5).
- Bloc de numéros épuisé hors-ligne → **refus** (aucun numéro inventé).
- **Toujours UTC en base**, conversion locale à l'affichage.
- Horloge du poste fausse → **`rev` serveur**, jamais l'horloge client.

**Réseau**
- Push interrompu → reprise sans doublon (`op_id`).
- Poste offline des **semaines** → pull **paginé** (timeout Vercel).
- Deux syncs simultanés → **verrou de runner** (instance unique + mutex interne).

**Processus / lifecycle**
- PG ne démarre pas → écran dédié + retry + réinitialisation possible.
- Clic sur fermer → **arrêt propre de PG** (sinon `pgdata` corrompu au prochain lancement).
- Mise à jour auto pendant une saisie → différée (`autoInstallOnAppQuit`).
- **Piège `db.ts` top-level** : ne jamais l'importer depuis `electron/` (§2.3).
- **Piège cookies NextAuth en HTTP** : `useSecureCookies:false` obligatoire sinon login impossible (§3.2).
- **Piège `next.config.ts`** : `output` conditionnel par env pour ne pas casser le deploy Vercel (§1.4).

**Sécurité disque**
- `pgdata` stocke les données médicales **en clair** → **BitLocker/VeraCrypt obligatoire** (Q-3),
  à **signifier par écrit au client**. Aucune mesure applicative ne change ce fait.

---

## Ordre d'exécution (séquentiel — chaque étape livre une app fonctionnelle)

```
ÉTAPE 1 — SOCLE (reconnaissance)
  1.1 Vérifier doc Next 16 : output 'standalone' + procédure copie static/public   [BLOQUANT]
  1.2 Installer deps (electron, electron-vite, electron-builder, electron-updater, electron-log)
  1.3 electron/main.ts + window.ts + preload.ts + ipc.ts  (coque sécurisée §1.3)
  1.4 electron/server/next.ts : next dev en dev / standalone en prod
  1.5 next.config.ts : output conditionnel par NEXT_OUTPUT
  1.6 Épingler la version npm (`packageManager` dans package.json) — le bloc
      `allowScripts` n'est honoré que par npm ≥ 11.6 (revue 1.2, point mineur)
      ✅ FAIT SI : l'app Electron ouvre l'app Next existante en dev, sans régression web.

  [1.1 à 1.6 FAITES — builds vérifiés : web 79 routes OK, standalone OK,
   tsc 0 erreur. Le lancement spawn→prêt→loadURL reste à valider en conditions
   réelles dès que le `next dev` en cours sur le port 3000 sera arrêté.]

ÉTAPE 2 — BASE LOCALE
  2.1 Promouvoir embedded-postgres en dependencies + vérifier binaires windows-x64
  2.2 electron/db/embedded-pg.ts (init, port Q-5, start/stop, safeStorage)
  2.3 electron/env.ts (DATABASE_URL, AUTH_SECRET, UPLOAD_DIR)
  2.5 Appliquer les 17 migrations drizzle/*.sql sur le cluster vierge + T-8
  [2.4 src/lib/db/desktop-db.ts REPORTÉ EN ÉTAPE 4 : ce client Drizzle lazy n'a
   de consommateur qu'avec le moteur de sync — le livrer ici produirait du
   code mort (règle de revue).]
      ✅ FAIT SI : l'app tourne entièrement offline avec données persistées après reboot.

ÉTAPE 3 — AUTH LOCALE (D-8)
  3.1 Cookies NextAuth en HTTP local (useSecureCookies false via env)
  3.2 Appareil de confiance : table device, trust_expires_at, route /api/sync/trust
  3.3 Écran login offline + expiration + révocation serveur
      ✅ FAIT SI : login offline fonctionne ; un device révoqué est refusé après sync.

ÉTAPE 4 — COLONNES DE SYNC
  4.1 Inventaire des tables sync-ables (+ tables enfants)
  4.2 schema/sync.ts : updated_at, device_id, rev, deleted_at, index curseur
  4.3 Tables sync_outbox, sync_state, sync_conflict, sync_merge (locale)
  4.4 Tables sync_applied, device (serveur central)
      ✅ FAIT SI : migrations appliquées sur les DEUX bases, zéro régression existante.

ÉTAPE 5 — ROUTES CENTRALES + OUTBOX
  5.1 /api/sync/push (idempotent, transactionnel, re-validation clinicId)
  5.2 /api/sync/pull (curseur composite, paginé, tombstones)
  5.3 /api/sync/blocks  +  5.4 /api/health
  5.5 src/lib/sync/outbox.ts (écriture atomique mutation+journal)
  5.6 Tests T-1, T-2, T-7
      ✅ FAIT SI : push/pull passent les tests ; aucune donnée perdue en coupure.

ÉTAPE 6 — ORCHESTRATEUR + CONFLITS
  6.1 src/lib/sync/net.ts (double détection + backoff)
  6.2 electron/sync/runner.ts (boucle push/pull, mutex, retry, logs)
  6.3 conflict.ts + locks.ts (LWW + protections D-4)     → T-3, T-4
  6.4 numbering.ts (blocs)                                → T-5
  6.5 merge.ts (doublons natifs D-5)                      → T-6
      ✅ FAIT SI : coupure/rétablissement physique → convergence sans intervention.

ÉTAPE 7 — UI SYNC (D-3 : espace clinic)
  7.1 sync-status.tsx + use-desktop.ts + sync-queue-sheet  [AVANT TOUT LE RESTE]
  7.2 Intégration dans (clinic)/layout.tsx
  7.3 settings/sync/page.tsx (file, conflits, appareils, disque)
  7.4 conflict-list.tsx + merge-review.tsx
  7.5 Ajustement des Server Actions concernées pour journaliser l'outbox
      ✅ FAIT SI : l'utilisateur voit toujours l'état exact de sa donnée.

ÉTAPE 8 — MÉDIAS (D-6)
  8.1 blob-store.ts (SHA-256, userData/uploads)
  8.2 media-sync.ts (push S3 tâche de fond, pull différé)
  8.3 storage-panel.tsx + indicateur « nécessite connexion »   [conditionné par SEC-B05]

ÉTAPE 9 — PACKAGING (D-7)
  9.0 BLOCAGE IDENTIFIÉ EN REVUE 1.5 : le build standalone embarque `.env`
      (secrets), `pgdata/` (PHI + postmaster.pid), `uploads/` (PHI), `src/`,
      `audit/` — tracé NFT élargi par src/app/api/files/[...key]/route.ts.
      → EXCLURE impérativement `.env*`, `pgdata/`, `uploads/`, `src/`, `audit/`,
        `*.md` via les patterns `files`/`extraResources` d'electron-builder,
      → PURGER le dossier standalone avant packaging,
      → copier le datadir PG UNIQUEMENT après arrêt complet du cluster,
      → jamais de secrets dans l'artefact livré au client.
  9.1 scripts/build-desktop.ts + electron-builder.yml (NSIS, asarUnpack)
  9.2 Icônes (build/icon.ico — aucune n'existe)
  9.3 electron-updater + hébergement releases (Q-1) + certificat (Q-2)
  9.4 Bascule `embedded-postgres` vers une version STABLE si disponible
      (actuellement 18.4.0-beta.17 en data-path critique — point relevé en revue 1.2)
  9.5 Recette manuelle 2 postes (§7)

ÉTAPE 10 — DURCISSEMENT & VALIDATION
  10.1 Checklist §6.4 → Reviewer
  10.2 Tester (E2E complet : offline → sync → conflit → update)
  10.3 Durcissements issus des revues (relevés, non bloquants) :
      - embedded-pg.ts : garde `isPostgresImage` sur le repli taskkill (pid recyclé)
      - embedded-pg.ts : confirmer l'arrêt avant de désarmer le filet `forceStopLocalDb`
      - embedded-pg.ts : vérifier le detach du champ `process` + documenter le risque de version (package en beta)
      - embedded-pg.ts : logger en `warn` si l'instance `async-exit-hook` diffère (layout non hoisté)
      - embedded-pg.ts : ne cacher que les succès de résolution de `pg_ctl`
      - electron.vite.config.ts : `asarUnpack` des binaires PG + exclusion `.env*`/`pgdata`/`uploads`/`src` (voir 9.0)
```

> **Principe** : chaque étape se termine par une application **fonctionnelle**. Les Étapes 1-3
> sont de la reconnaissance (aucun risque sur le code existant) ; l'**Étape 5 est la seule vraie
> dépendance critique**. Une interruption en fin d'étape laisse un système cohérent.

---

## Validation finale (Reviewer → Tester)

1. **Reviewer** intervient **après chaque tâche** (sécurité de la coque, typage, multi-tenant,
   conformité aux décisions D-1…D-9) → feu vert obligatoire avant la tâche suivante, puis
   micro-commit Conventional Commits.
2. **Tester** intervient en fin d'**Étape 5** (moteur de sync), fin d'**Étape 7** (UI) et fin
   d'**Étape 9** (packaging), via la recette manuelle 2 postes + les tests T-1 à T-8.
3. **Feu vert client** requis avant toute écriture de code (ce document est en attente de validation).
