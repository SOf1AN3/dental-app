# DESKTOP-ELECTRON.md — Bascule vers une application desktop

> **Statut** : DOCUMENT DE RÉFÉRENCE — **aucun développement desktop engagé**.
> **Objet** : conservation de l'analyse technique réalisée le 2026-10-10, en vue d'une
> bascule future vers une application desktop. Ce fichier est le point de départ du jour où
> la décision sera prise.
> **Décision actuelle du client** : *« Pour l'instant on ne va pas travailler sur le desktop,
> on va continuer uniquement avec la version web. »*

---

## 1. Résumé exécutif

L'application **DentalCare** (Next.js 16 App Router + Drizzle/PostgreSQL) est actuellement
entièrement *server-rendered*. Le besoin métier est un fonctionnement **hors-ligne total** sur
**plusieurs postes fixes par clinique**, avec **synchronisation automatique** vers une base
centrale, et un **dossier radiographique volumineux** (estimation **> 20 Go** par clinique).

**Conclusion de l'analyse** : pour ce cahier des charges précis, une **application desktop**
(Electron ou Tauri) est **techniquement supérieure** à une PWA, essentiellement parce qu'elle
**élimine la refonte la plus risquée du projet**.

---

## 2. L'argument décisif

La question n'est pas *« PWA vs desktop »*. Elle est : **qui lit les données locales, et comment ?**

| | PWA | Desktop |
|---|---|---|
| Où vivent les données locales | Dans le **navigateur** (PGlite WASM) | Dans un **processus Node local** (fichier réel) |
| Qui les lit | L'**UI**, réécrite en client-side | Les **Server Actions**, **inchangées** |

C'est là que tout se joue. Les données sont aujourd'hui lues via des Server Actions qui
interrogent PostgreSQL. En PWA, il faut **réécrire toute la couche d'accès aux données** pour
que l'UI lise PGlite côté client. En desktop, **on lance un serveur Next.js local, on pointe
`DATABASE_URL` vers une base locale, et la totalité des 42 tables, des requêtes Drizzle, de
l'authentification et du multi-tenant fonctionne sans modification.**

> C'est le point le plus important de ce document : **le desktop ne supprime pas du travail,
> il en supprime la partie la plus dangereuse.**

---

## 3. Comparaison détaillée

| Critère | PWA + PGlite (navigateur) | Desktop + PGlite (Node) |
|---|---|---|
| Réécriture du data layer | 🔴 **Énorme** (~11 sous-phases) | 🟢 **Quasi nulle** |
| Hors-ligne réel | 🟡 Partiel (quota, WASM) | 🟢 **Total** |
| Radiographies > 20 Go | 🔴 **Impossible** | 🟢 **Possible** |
| Performance base locale | 🟡 WASM, ~×2-5 plus lent | 🟢 Natif |
| Authentification hors-ligne | 🔴 Complexe (vérificateur dérivé, confiance d'appareil) | 🟢 **Résolue naturellement** |
| Contraintes navigateur | 🔴 COOP/COEP, OPFS, quota | 🟢 Aucune |
| Installation | 🟢 Juste une URL | 🔴 Sur chaque PC |
| Distribution | 🟢 Gratuite | 🔴 Code signing + auto-update |
| Mises à jour | 🟢 Immédiates | 🔴 Infrastructure à monter |
| Tablette / mobile | 🟢 Possible | 🔴 Desktop uniquement |
| Poids du client | 🟢 0 Mo | 🔴 ~150 Mo (Electron) / ~15 Mo (Tauri) |

### Adéquation au cahier des charges du client

Les décisions déjà prises pour le projet convergent **toutes** vers le desktop :

| Décision client | Implication |
|---|---|
| Plusieurs PC **fixes** par clinique | L'installation n'est pas un frein |
| Chrome / Edge **uniquement** | Le desktop est déjà la cible |
| Dossier radiographique **complet** offline | **Impossible** en PWA (quota navigateur), naturel en desktop |
| « **Tout** garder en permanence » | Idem |

---

## 4. Coûts et risques — sans maquiller

### 4.1 Code signing Windows *(le coût principal)*

Sans certificat, **Microsoft SmartScreen** affiche *« Windows a protégé votre ordinateur »* et
l'utilisateur doit cliquer *« Plus d'informations → Exécuter quand même »*.

| Type | Coût indicatif | Remarque |
|---|---|---|
| OV (Organization Validation) | ~100–200 $/an | Reputation longue à construire |
| EV (Extended Validation) | ~300–500 $/an | Reputation quasi immédiate |
| Aucun | 0 $ | Cliquer *Exécuter quand même* — viable sur des postes verrouillés et gérés |

> **Point de décision futur** : si les PC du cabinet sont gérés par une équipe ou une DSI,
> l'absence de certificat est un coût humain acceptable.

### 4.2 Mises à jour automatiques

`electron-updater` + hébergement des releases (GitHub Releases, S3, ou Vercel Blob).
Estimation : **2 à 3 jours** de mise en place, plus la chaîne de build CI.

### 4.3 Sécurité de la coque

Règles **non négociables** :
- `contextIsolation: true`
- `nodeIntegration: false`
- Aucun module `remote`
- `sandbox: true` sur les `BrowserWindow`
- CSP stricte
- Aucun `shell.openExternal` sur une URL non validée

### 4.4 Contraintes Next.js

- Passage en **`output: 'standalone'`** dans `next.config.ts` pour embarquer le serveur.
- ⚠️ **À re-vérifier impérativement dans `node_modules/next/dist/docs/`** : Next.js 16
  comporte des ruptures de compatibilité (voir `AGENTS.md`). Les conventions de build ont pu
  changer depuis la rédaction de ce document.

### 4.5 Ce qui n'est PAS éliminé

- Le **serveur central** reste la source de vérité et l'endpoint de synchronisation.
- La **Phase de synchronisation** (outbox, push, pull, conflits, blocs de numérotation) est
  **identique** dans les deux architectures. C'est le vrai cœur du projet, aucun choix ne
  l'économise.
- Les **108 bugs** identifiés par l'audit existent dans les deux cas.

---

## 5. Alternative : Tauri

Si le poids du client est un critère :

| | Electron | Tauri |
|---|---|---|
| Taille installée | ~150 Mo | **~15 Mo** |
| Moteur | Chromium embarqué | **WebView2 du système** (Edge Chromium) |
| Surface d'attaque | Plus grande | Plus faible |
| Performance | Très bonne | Très bonne |
| Langage de la coque | JavaScript/TypeScript | **Rust** |

**Argument favorable à Tauri dans ce projet précis** : la décision *« Chrome / Edge uniquement »*
garantit la présence de **WebView2** sur Windows 10/11 — donc pas de risque de WebView hétérogène.

**Contrepartie** : la coque nécessite **~200 lignes de Rust** (démarrage du serveur Node,
ouverture de la fenêtre, gestion de l'auto-update). Faisable, mais à prendre en compte si
personne dans l'équipe ne connaît Rust.

---

## 6. Architecture cible proposée

```
┌──────────────────────── POSTE DU CABINET ────────────────────────┐
│                                                                  │
│  Coque (Electron main / Tauri)                                   │
│      │ démarre                                                    │
│      ▼                                                            │
│  Serveur Next.js LOCAL (build standalone)                         │
│      │                                                            │
│      ├── Drizzle ──► PGlite en Node (persistance sur disque)     │
│      │                fichier réel, pas de quota, pas de WASM     │
│      │                                                            │
│      ├── Server Actions ──► INCHANGÉES                            │
│      │                                                            │
│      └── /api/sync/* ──► HTTPS ──► SERVEUR CENTRAL               │
│                                                                  │
│  Fichiers radiographiques ──► disque local (quota illimité)      │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Points techniques à valider au démarrage

1. **PGlite en mode Node** : `@electric-sql/pglite` supporte la persistance fichier via
   `new PGlite('chemin/vers/dossier')`. **Même dialecte Postgres, même schéma Drizzle, mêmes
   migrations** qu'en serveur. Aucune réécriture de schéma.
   → *Alternative* : `embedded-postgres` (vrais binaires PostgreSQL) si les performances ou les
   fonctionnalités PGlite s'avèrent insuffisantes.
2. **Build `next standalone`** : le dossier `standalone/` contient serveur + dépendances
   minimales, empaquetable dans l'application.
3. **Variables d'environnement locales** : `DATABASE_URL` pointant vers PGlite, `AUTH_SECRET`
   généré et stocké localement (Keychain / Credential Manager de Windows).
4. **Uploads** : les radiographies sont écrites sur disque local, puis poussées vers S3 au sync.
   **Jamais** d'URL publique permanente (cf. faille SEC-B05 de l'audit).
5. **Authentification** : la table `users` est locale, bcrypt tourne nativement (pas de WASM
   dégradé). Le problème du **déverrouillage hors-ligne** disparaît.

---

## 7. Ce qui est RÉUTILISABLE du plan web

La bascule n'est pas un redémarrage à zéro. Est **réutilisable à l'identique** :

| Élément | Réutilisable | Commentaire |
|---|---|---|
| **Phase de stabilisation** (29 tâches, 108 bugs) | ✅ **Intégralement** | Les bugs existent dans les deux cas |
| **Moteur de synchronisation** (outbox, push, pull, LWW, blocs) | ✅ **Intégralement** | C'est le vrai cœur, indépendant de l'hébergement |
| **Schéma Drizzle + migrations SQL** | ✅ **Intégralement** | PGlite partage le dialecte Postgres |
| **Règles métier** (`billing-math`, `appointment-rules`, `session-rules`) | ✅ **Intégralement** | Pur TypeScript, aucun lien au runtime |
| **Matrice de permissions** | ✅ **Intégralement** | — |
| Couche PWA (manifest, Service Worker) | ❌ | Remplacée par le packaging desktop |
| Cache binaire à quota navigateur | ❌ | Remplacé par le disque local |
| Auth hors-ligne dérivée / confiance d'appareil | ❌ | Résolue par la base locale |
| Réécriture UI client-side | ❌ | **Supprimée** — c'est le gain principal |

---

## 8. Prérequis avant d'engager la bascule

- [ ] Confirmation que les PC du cabinet sont **fixes et en nombre connu**
- [ ] Décision sur le **code signing** (certificat vs formation au clic SmartScreen)
- [ ] Décision **Electron vs Tauri** (peser le Rust dans l'équipe)
- [ ] **Chaîne de distribution** : préinstallation, clonage, ou installation autonome
- [ ] **Auto-update** : hébergement des releases et canal de publication
- [ ] Hébergement des **artefacts de build** signés
- [ ] Relecture de la doc **Next.js 16** (`node_modules/next/dist/docs/`) sur
      `output: 'standalone'`
- [ ] Validation du **verrouillage du disque** (BitLocker/VeraCrypt) — PGlite stocke les
      données médicales **en clair** sur le disque

---

## 9. Ordre de travail suggéré le jour J

1. **Socle** : coque minimale + PGlite Node + build `next standalone` qui s'ouvre
2. **Reconnaissance** : l'application existante tourne **telle quelle** en local
3. **Synchro** : reprendre le moteur de synchronisation prévu pour la PWA
4. **Médias** : pipeline de synchronisation des radiographies (upload résumable, dédup SHA-256)
5. **Packaging** : build CI, signing, auto-update
6. **Durcissement** : vérification des règles de sécurité de la coque (§4.3)

> **Principe** : chaque étape livre une application **fonctionnelle**. La synchro (étape 3) est
> la seule dépendance bloquante réelle ; les étapes 1 et 2 sont de la reconnaissance.
