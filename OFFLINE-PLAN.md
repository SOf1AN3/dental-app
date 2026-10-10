# OFFLINE-PLAN.md — Architecture local-first, PWA & Synchronisation

> **Statut** : **ARCHIVÉ — NON ENGAGÉ.** Document de référence conservé le 2026-10-10.
> **Contexte** : ce plan avait été rédigé pour répondre aux points 1 à 4 de la demande initiale
> du client (fonctionnement 100 % hors-ligne, stockage local, PWA, synchronisation). Le client a
> ensuite décidé de **restreindre le `PLAN.md` actuel à la stabilisation (bugs + sécurité)** et de
> **reporter toute la partie hors-ligne / desktop**.
> **Réservez ce document pour le jour où le sujet sera repris.** Il est autonome.

---

## 1. Contexte & besoin métier

**DentalCare** gère 42 tables PostgreSQL (patients, agenda, dossier clinique, séances,
facturation, ordonnances, stock, prothèses, abonnements, audit).

**Le constat** : l'application est intégralement *server-rendered*. **Aucun** accès aux données
côté client — tout passe par des Server Actions / Server Components interrogeant PostgreSQL en
direct. **Aucun** Service Worker, **aucun** manifest PWA, **aucune** icône dans `public/`, aucun
cache client, aucune couche de synchronisation.

**Le besoin** : travailler **sans connexion**, sur **plusieurs postes par clinique**, avec
**synchronisation automatique** vers la base centrale, et un **dossier médical complet** accessible
hors-ligne.

> ⚠️ Ce n'est pas « une fonctionnalité à ajouter » mais une **refonte architecturale** : passer
> d'un modèle *server-first* à un modèle *local-first*.

---

## 2. Décisions validées par le client

| # | Sujet | Décision |
|---|---|---|
| D1 | Topologie | **Plusieurs PC par clinique** (2-5), chacun offline-capable |
| D2 | Stockage local | **PGlite** (Postgres en WebAssembly dans le navigateur) |
| D3 | Auth hors-ligne | **Appareil de confiance + expiration**, vérificateur dérivé local |
| D4 | Numérotation des factures | **Allouation par bloc réservé** (ex. 42 → 91) |
| D5 | Résolution des conflits | **Dernière écriture gagne** + traçage audit |
| D6 | Sync | **Automatique et continue**, reprise après échec |
| D7 | Navigateur | **Chrome / Edge uniquement** |
| D8 | Portée | Offline + PWA + sync + bugs bloquants |
| D9 | Radiographies | Voir arbitrage **A-6** |
| D10 | Données locales | Conservation **permanente** |

### Arbitrage A-6 — conflit D9a / D9b / D10

Le client a répondu **« dossier radiographique complet »** ET **« plus de 20 Go »** ET
**« tout garder en permanence »**. Ces trois contraintes sont **incompatibles** : le quota OPFS
accessible à une origine navigateur plafonne à **1-2 Go** (parfois ~40 % du disque selon la
politique du navigateur).

| Type | Volume | Politique |
|---|---|---|
| Données **textuelles** (patients, odontogramme, plans, séances, factures, ordonnances, stock, prothèses) | **1 à 5 Mo** | **Cache PERMANENT** — satisfait D10 et le besoin clinique réel |
| Données **binaires** (radiographies, photos) | **des Go à dizaines de Go** | **Cache incrémental à quota** : téléchargement en tâche de fond des N derniers jours + favoris, purge LRU, quota configurable, indicateur « nécessite connexion » |

> Le dossier médical est donc **intégralement lisible hors-ligne** ; seule la **matière image**
> des cas anciens exige une connexion. Aucune donnée n'est perdue : tout est sur le serveur.

---

## 3. Architecture cible

```
┌──────────────────────── POSTE DU CABINET ────────────────────────┐
│  UI (Client Components)                                          │
│      │ lit / écrit                                               │
│      ▼                                                           │
│  PGlite (Postgres WASM, persistance OPFS)  ◄── source locale     │
│      ├──► sync_outbox  (mutations en attente)                    │
│      └──► sync_state   (curseur de pull, derniers push)          │
└──────────────┬───────────────────────────────────────────────────┘
               │ HTTPS (uniquement en ligne)
               ▼
┌──────────────────────── SERVEUR (Vercel) ────────────────────────┐
│  /api/sync/push  ──► applique les mutations (idempotent)         │
│  /api/sync/pull  ──► renvoie les changements depuis un curseur   │
│  /api/sync/blocks──► réserve des blocs de numérotation           │
│  PostgreSQL = SOURCE DE VÉRITÉ CENTRALE                          │
└──────────────────────────────────────────────────────────────────┘
```

**Les postes ne se parlent jamais** (pas de P2P). Toute convergence passe par le serveur central.

### Les trois pièges structurels

1. **Le Service Worker ne résout PAS le problème offline.** En *network-first*, il ne sert que des
   pages **déjà rendues** — mais chaque Server Component exige Postgres. Le vrai correctif est que
   **l'UI devienne client-side et lise PGlite**. Le SW n'est que le complément (assets, shell).
2. **`document_sequence` est un compteur atomique** : *par construction* inallocable hors-ligne.
   D'où la décision **D4** — et l'interdiction formelle de renuméroter après impression.
3. **PGlite multithread impose COOP/COEP**, qui cassent le chargement des images S3 *cross-origin*
   (faute d'un `Cross-Origin-Resource-Policy`).

---

## 4. Risques & arbitrages

| ID | Risque | Arbitrage |
|---|---|---|
| **A-1** | COOP/COEP casse les images S3 | **Mono-thread + OPFS**, sans COOP/COEP |
| **A-2** | PGlite en OPFS est **non chiffré** : poste volé = dossier médical lisible | Chiffrement du disque (**BitLocker/VeraCrypt obligatoire**) + verrouillage d'app. **Aucune** promesse que le navigateur ne peut tenir. |
| **A-3** | Un montant de facture écrasé silencieusement par LWW | **Exception D5** : montants verrouillés dès qu'un document dépasse `draft` |
| **A-4** | 14 artefacts `.js` compilés commités dans `schema/` | Nettoyage + `.gitignore` |
| **A-5** | `proxy.ts` / `src/proxy.ts` non inspectés (Next 16 : `middleware` renommé ?) | À lire avant toute modif de routing |
| **A-6** | 20 Go de radios + cache permanent | Voir arbitrage ci-dessus |
| **A-7** | Drizzle 0.45.2 : support du driver `pglite` **à vérifier** | **Bloquant** avant Phase 1 |

---

## 5. Phase 1 — Socle local (DB)

| Tâche | Fichiers exacts | Dépend de |
|---|---|---|
| **L-1** Dépendances & config build | `package.json`, `next.config.ts` | A-7 |
| **L-2** Schéma Drizzle partagé client/serveur | `src/lib/db/schema/index.ts` + 12 modules | — |
| **L-3** Séparer connexion serveur / locale | **créer** `src/lib/db/local/local-db.ts` ; **modifier** `src/lib/db/db.ts` | L-2 |
| **L-4** Migrateur côté client | **créer** `src/lib/db/local/migrate-local.ts` ; réutiliser `drizzle/*.sql` | L-3 |
| **L-5** Tables de synchronisation | **créer** `src/lib/db/schema/sync.ts`, `device.ts` ; migration | L-2 |
| **L-6** Identification du poste | idem | L-5 |

### Tables à créer

```
sync_outbox   : id · table_name · row_id · op · payload(jsonb) · device_id
                · seq · created_at · status(pending|sent|failed) · attempts · last_error
                → index (status, seq)
sync_state    : key(PK) · value(jsonb) · updated_at
                → last_pull_cursor, last_push_at, last_conflict_at
sync_applied  : op_id(PK) · device_id · applied_at        ← SERVEUR (idempotence)
sync_conflict : id · table_name · row_id · device_id
                · winning_payload · losing_payload · decided_at · reason   ← SERVEUR
device        : id(PK) · clinic_id · user_id · name · os
                · first_seen_at · last_seen_at · last_sync_at · block_reserved
document_sequence : [EXISTANT] + block_start · block_end · block_device_id
                    · block_status(reserved|consumed)
```

### Ancrage des tables métier

Chaque table sync-able doit porter `updated_at` + `updated_by` + `device_id` + `rev`, avec un
index composite `(clinic_id, updated_at, id)` pour le curseur de pull.

> ⚠️ Vérifier les tables **enfants** (`invoice_item`, `quote_item`, `prescription_item`,
> `clinical_session_item`, `treatment_plan_item`) : sinon une facture se réplique sans ses lignes.

---

## 6. Phase 2 — Moteur de synchronisation

| Tâche | Fichiers exacts | Dépend de |
|---|---|---|
| **S-1** File d'attente locale | **créer** `src/lib/sync/outbox.ts` | L-5 |
| **S-2** Route push | **créer** `src/app/api/sync/push/route.ts` | L-5, L-6 |
| **S-3** Route pull | **créer** `src/app/api/sync/pull/route.ts` | D-3 |
| **S-4** Réservation de blocs | **créer** `src/app/api/sync/blocks/route.ts` | D-4 |
| **S-5** Orchestrateur client | **créer** `src/lib/sync/client.ts` | S-1 |
| **S-6** Détection réseau | **créer** `src/lib/offline/net.ts` | — |
| **S-7** Résolution LWW | **créer** `src/lib/sync/conflict.ts` | S-2 |
| **S-8** Verrouillage facturation (A-3) | **créer** `src/lib/sync/locks.ts` | S-7 |
| **S-9** Allocation par bloc (D4) | **créer** `src/lib/sync/numbering.ts` ; **modifier** `src/lib/db/schema/financial.ts` | S-4 |
| **S-10** Ordre de dépendance des tables | **créer** `src/lib/sync/order.ts` | S-2 |

### Règles de synchronisation

- **Idempotence** : chaque op porte un `op_id` UUID client ; le serveur l'applique **une seule fois**.
- **Atomicité** : un push est traité **par clinique et par device**, en transaction.
- **Ordre** : respect de `seq` par device ; un `patient` est poussé **avant** ses enfants.
- **Tombstones** : les suppressions sont poussées en `op=delete`. **Jamais de hard delete poussé
  depuis un client.**
- **Curseur de pull** : `(clinic_id, updated_at, id)` — **jamais** `updated_at` seul (deux lignes
  mises à jour dans la même milliseconde seraient perdues).

---

## 7. Phase 3 — Migration de l'UI *(la plus lourde)*

Chaque domaine passe de *Server Component lisant Postgres* à *Client Component lisant PGlite*.

| Tâche | Fichiers exacts | Priorité |
|---|---|---|
| **U-1** Indicateur d'état sync global | **créer** `src/components/offline/sync-status.tsx`, `online-badge.tsx` ; **modifier** `src/app/(clinic)/layout.tsx` | **Haute — OBLIGATOIRE EN PREMIER** |
| **U-2** Répertoire patients | **créer** `src/lib/db/local/repositories/patients.ts` ; **modifier** `src/lib/actions/patient.ts`, `src/app/(clinic)/patients/*` | Haute |
| **U-3** Agenda & salle d'attente | `repositories/appointments.ts` ; `actions/appointment.ts`, `waiting-room.ts` | Haute |
| **U-4** Dossier clinique & odontogramme | `repositories/clinical.ts` ; `actions/clinical.ts`, `odontogram.ts` | Haute |
| **U-5** Séances | `repositories/sessions.ts` ; `actions/session.ts` | Haute |
| **U-6** Ordonnances | `repositories/prescriptions.ts` ; `actions/prescription.ts` | Moyenne |
| **U-7** Facturation offline | `repositories/billing.ts` ; `actions/financial.ts` | Moyenne |
| **U-8** Stock | `repositories/inventory.ts` ; `actions/inventory.ts` | Basse |
| **U-9** Prothèses | `repositories/prostheses.ts` ; `actions/prosthesis.ts` | Basse |
| **U-10** Rapports | `repositories/reports.ts` ; `actions/reports.ts` | Basse |
| **U-11** Recherche & notifications | `search-input.tsx`, `notification-bell.tsx` | Basse |

> **U-1 avant toute migration.** Sans indicateur d'état sync, un utilisateur ne sait **jamais** si
> sa donnée est locale ou serveur — cause n°1 d'abandon d'une migration local-first.

---

## 8. Phase 4 — PWA (desktop)

| Tâche | Fichiers exacts |
|---|---|
| **P-1** Manifest | **créer** `public/manifest.webmanifest` ; **modifier** `src/app/layout.tsx` |
| **P-2** Icônes (**aucune n'existe** dans `public/`) | **créer** `public/icons/icon-192.png`, `icon-512.png`, `icon-maskable-512.png` |
| **P-3** Service Worker | **créer** `src/lib/pwa/service-worker.ts`, `src/app/sw.ts` ; **modifier** `next.config.ts` |
| **P-4** Stratégie de cache | assets + chunks ; **jamais** de mise en cache des réponses API contenant des données médicales |
| **P-5** Prompt d'installation | **créer** `src/components/offline/install-prompt.tsx` |
| **P-6** Mise à jour sans interruption | **créer** `src/components/offline/sw-update-toast.tsx` via `sonner`, **sans** rechargement forcé en plein formulaire |

> ⚠️ **Lire impérativement `node_modules/next/dist/docs/`** (voir `AGENTS.md`) avant P-3 :
> Next.js 16 comporte des ruptures de compatibilité.

---

## 9. Phase 5 — Auth hors-ligne (D3)

| Tâche | Fichiers exacts |
|---|---|
| **AU-1** Dérivation du vérificateur | **créer** `src/lib/offline/auth-offline.ts` — **PBKDF2 (WebCrypto, ≥ 310 000 itérations)** ou **Argon2id-WASM** ; **jamais bcrypt** (trop lent hors-WASM, sa lenteur y est inutile) |
| **AU-2** Chiffrement du vérificateur | clé **non extractible** via `SubtleCrypto` + `deviceId` → empêche le brute-force hors-ligne |
| **AU-3** Cycle de vie de confiance | **créer** `src/lib/offline/device-trust.ts` — expiration (30 j par défaut), révocation serveur |
| **AU-4** Session offline | **créer** `src/lib/offline/session.ts` — JWT **signé localement**, TTL 12 h, borne absolue = expiration de confiance |
| **AU-5** Verrouillage auto | **créer** `src/components/offline/auto-lock.tsx` |

> 🔒 **Ce que le navigateur NE PEUT PAS garantir** : PGlite en OPFS est stockée **en clair**.
> Sur un poste dont l'OS est déverrouillé, un attaquant avec accès physique lit le dossier
> médical complet. **Aucune mesure applicative ne change ce fait.**
> → **Recommandation non négociable** : **chiffrement de tournage (BitLocker/VeraCrypt) obligatoire**
> sur chaque poste. À **signifier au client par écrit**.

---

## 10. Phase 5 — Cache des radiographies (A-6)

| Tâche | Fichiers exacts |
|---|---|
| **R-1** Stockage binaire dédié (OPFS) | **créer** `src/lib/offline/blob-store.ts` — écriture/lecture par **SHA-256** (dédup) |
| **R-2** Téléchargement différé | **créer** `src/lib/offline/media-sync.ts` — fond, **uniquement en ligne**, jamais pendant une écriture clinique |
| **R-3** Rétention & purge LRU | **créer** `src/lib/offline/quota.ts` — quota défaut **1 Go** |
| **R-4** Espace utilisé | **créer** `src/components/settings/storage-panel.tsx` |
| **R-5** Indicateur « nécessite connexion » | **modifier** les vignettes radios |

> ⚠️ **Conditionné par SEC-B05** (faille de l'audit) : le pipeline de téléchargement doit passer
> par une **route authentifiée**, jamais par les URL publiques actuelles — sinon le cache local
> hérite de la faille **et la rend plus durable**.

---

## 11. Tests

| Tâche | Fichiers |
|---|---|
| **T-1** Conflits LWW | **créer** `src/lib/sync/conflict.test.ts` |
| **T-2** Idempotence du push | **créer** `src/app/api/sync/push.test.ts` |
| **T-3** Allocation par bloc | **créer** `src/lib/sync/numbering.test.ts` — **aucun doublon possible** |
| **T-4** Verrou facturation | **créer** `src/lib/sync/locks.test.ts` |
| **T-5** Auth offline | **créer** `src/lib/offline/auth-offline.test.ts` |
| **T-6** Quota media | **créer** `src/lib/offline/quota.test.ts` |
| **T-7** Migration locale | **créer** `src/lib/db/local/migrate-local.test.ts` |
| **T-8** Bugs P0 corrigés | fichiers `*.test.ts` existants |

---

## 12. Sécurité & edge cases

**Multi-tenant (risque n°1)**
- Toute lecture par ID vérifie l'appartenance à la `clinicId` courante.
- **Le push serveur re-valide chaque `clinicId` du payload** : un client compromis peut injecter
  une ligne étrangère. **Ne jamais faire confiance au payload.**
- `device_id` lié à `user_id` + `clinic_id` **côté serveur**.

**Conflits & données**
- Suppression locale vs modification distante : la suppression **ne doit jamais** l'emporter.
- Patient créé **en double** hors-ligne sur 2 postes → fusion nécessaire au sync. **À spécifier.**
- Bloc de numéros épuisé hors-ligne → le poste doit **refuser** de créer une facture plutôt que
  d'inventer un numéro.
- **Toujours UTC en base**, conversion locale à l'affichage.

**Réseau**
- Push interrompu → reprise sans doublon.
- Poste offline **des semaines** → pull **paginé** (timeout Vercel sinon).
- Horloge du poste fausse → **`rev` incrémental côté serveur**, pas l'horloge client.

**PWA**
- Aucune donnée médicale dans le cache HTTP du SW.
- Cache PGlite **réinitialisable** sans perte serveur.

---

## 13. Ordre d'exécution

```
PHASE 1 — Socle local
  L-1 dépendances → L-2 schéma → L-3 localDb → L-4 migrateur → L-5 sync → L-6 device
     ↳ A-7 (Drizzle/PGlite) échoue : STOP, arbitrage à rediscuter

PHASE 2 — Synchronisation
  S-1 outbox → S-2 push → S-3 pull → S-4 blocks → S-5 orchestrateur
  → S-6 réseau → S-7 conflits → S-8 verrou → S-9 numérotation → S-10 ordre

PHASE 3 — Migration des données (U-2 → U-10)   [U-1 OBLIGATOIRE EN PREMIER]

PHASE 4 — PWA
  P-1 manifest → P-2 icônes → P-3 SW → P-4 stratégie → P-5 install → P-6 update

PHASE 5 — Auth offline & cache médias
  AU-1 → AU-2 → AU-3 → AU-4 → AU-5
  R-1 → R-2 → R-3 → R-4 → R-5   (R-1 dépend de Z-9 du PLAN.md)

PHASE 6 — Tests & validation
  T-1 … T-8 → Reviewer à chaque tâche → Tester en fin de module
```

> **Principe** : chaque phase se termine par une application **pleinement fonctionnelle en ligne**,
> le hors-ligne en supplément. Une interruption en fin de phase laisse un système cohérent.

---

## 14. Recette manuelle obligatoire (fin de Phase 5)

Sur **deux postes réels de la clinique**, avec coupure réseau **physique** (débrancher la prise,
pas le Wi-Fi) :

1. Création d'un patient offline sur A → visible sur B après sync
2. Deux factures créées offline sur A et B → **numéros distincts, aucun doublon**
3. Même patient modifié sur A et B → **LWW respecté + conflit journalisé**
4. Redémarrage du poste offline → PGlite persiste en OPFS, données toujours là
5. Bloc de numéros épuisé offline → **refus explicite**, pas de numéro inventé

---

## 15. Prérequis avant d'engager

- [ ] Réponses aux **questions du client** (voir `PLAN.md` archived, sections A-3 et A-6)
- [ ] **A-7** : `drizzle-orm/pglite` résolu et importable
- [ ] **A-5** : `proxy.ts` / `src/proxy.ts` inspectés
- [ ] **Z-9** (du `PLAN.md`) : uploads servis par route authentifiée
- [ ] **Z-1 à Z-5** (du `PLAN.md`) : multi-tenant sécurisé — **sinon la Phase 2 amplifierait
      les failles existantes en faille de masse**
- [ ] **Validation client** du plan complet avant toute écriture de code
