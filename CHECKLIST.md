# RESTE À FAIRE

> **État au 2026-10-11** — document de suivi après la passe complète de stabilisation.
> ✅ = fait et committé · ⬜ = restant · 🔴 = bloquant avant déploiement

---

## 1. Où on en est

**108 bugs** identifiés par 4 audits, corrigés en **9 lots**. **56 commits**.

| | |
|---|---|
| Lots 1 → 9 | ✅ terminés |
| Tests | ✅ **221 / 221** (128 au départ) |
| Typecheck | ✅ propre (5 erreurs préexistantes, hors périmètre : SVG de l'odontogramme) |
| Base de dev | ✅ PostgreSQL 18.4 embarqué, 43 tables, UTF8 |

**7 failles P0 fermées**, dont 3 qui étaient exploitables aujourd'hui :

- un tiers non connecté pouvait lire le **dossier patient complet**
- une **invitation jamais acceptée** ouvrait l'accès aux dossiers médicaux (6 endroits, dont le middleware)
- `/api/drugs/search` laissait consulter le catalogue d'un **autre cabinet**

---

## 2. ⬜ Reste à faire — 3 tâches délibérément laissées ouvertes

| # | Tâche | Décision | Raison |
|---|---|---|---|
| **Z-63** | Contrainte d'exclusion sur les plages de rendez-vous (double réservation) | **Reportée** | Exige `btree_gist` — désormais **disponible nativement** dans PostgreSQL 18.4. Voir §5. |
| **Z-68** | `userId` sur les notifications lues (le badge est global à la clinique) | **Reportée** | Une tentative avait ajouté la colonne au schéma **sans migration** → module **inexécutable** sur la base courante. À refaire **avec** migration. |
| **Z-80** | `emailVerified` exigé dans `requireAuth` | **Refusée** | Verrouillerait `resendVerificationEmail` (qui repose sur `requireAuth`) → **verrouillage définitif** des comptes non vérifiés. Analyse documentée dans `src/lib/auth-utils.ts`. |

> Aucun autre item du plan initial n'est resté ouvert.

---

## 3. 🔴 Questions métier — 6 en attente, 2 bloquantes

Elles n'ont pas bloqué la correction des bugs, mais certaines touchent à la **conformité fiscale** et à la **sécurité clinique**. Une réponse peut nécessiter des retouches ciblées.

| # | Question | Bloquant ? |
|---|---|---|
| **Q2** | **Assiette de TVA** — la remise est-elle déductible de l'assiette (TVA sur `base − remise`) ou déduite **après** la TVA (comportement actuel) ? Une remise de 200 sur 1000 à 19 % facture **190** de TVA au lieu de **152**. | 🔴 **Oui** — à trancher avec le comptable |
| **Q5** | **Contrôle d'allergie** — la détection est textuelle et imparfaite. Voulu, ou refuser catégoriquement certaines molécules ? | 🔴 **Oui** — risque clinique |
| **Q1** | Corriger les 63 bugs **P2** restants, ou se limiter aux P0/P1 ? | non |
| **Q3** | Le statut `overdue` n'est **jamais produit** : l'onglet « Impayée » est structurellement vide. L'implémenter ? | non |
| **Q4** | « Marquer payée » : créer une **écriture de paiement traçable**, ou conserver le simple changement de statut ? | non |
| **Q6** | `deleteSession` supprime toutes les entrées de file du patient. Lier à la séance concernée ? | non |

---

## 4. 🔴 Opérations avant déploiement en production

Le **code** est corrigé ; les **données** et le **schéma** de production ne le sont pas encore.

- [ ] **Backfill `joined_at`** — sans ça, des membres actifs **perdent l'accès** :
  ```
  npx tsx scripts/backfill-membership-joined-at.ts          # diagnostic, lecture seule
  npx tsx scripts/backfill-membership-joined-at.ts --apply  # écriture
  ```
- [x] ~~Migration `token_version`~~ — **générée et appliquée** en dev (`drizzle/0016_smooth_randall.sql`)
- [ ] **Contrôles de données avant `db:migrate`** en production — la migration 0016 contient des contraintes qui **échoueraient** si des données les violent :
  ```sql
  SELECT clinic_id, order_number, COUNT(*) FROM prosthesis_order
    GROUP BY 1, 2 HAVING COUNT(*) > 1;              -- index unique Z-49
  SELECT id, current_qty FROM stock_item WHERE current_qty < 0;   -- CHECK Z-60
  SELECT item_id, COUNT(*) FROM stock_alert WHERE status='active'
    GROUP BY 1 HAVING COUNT(*) > 1;                 -- index unique Z-62
  ```
  → si des lignes sont retournées, **nettoyer d'abord**.
- [ ] **Fumée-test** : créer une commande prothèse → vérifier `PRO-2026-0000n` (Z-49)

---

## 5. ⬜ Reprendre en priorité

1. **Z-63 — double réservation de rendez-vous.** Le check est un *check-then-insert* en JS, sans contrainte en base : deux créations simultanées passent toutes les deux. `btree_gist` est désormais disponible dans PostgreSQL 18.4. Alternative plus simple : index unique partiel `(clinic_id, dentist_id, start_time)` — efficace pour le double-book du même créneau, sans couvrir les chevauchements de durées différentes.

2. **Z-68 — notifications personnelles.** Aujourd'hui `markNotificationsRead` marque **toutes** les notifications de la clinique : le premier membre à ouvrir la cloche efface le badge de tous ses collègues. Refaire **avec** migration.

3. **Backlog P2 (63 bugs).** Classés dans le plan initial, non traités par décision.

---

## 6. ⬜ Dette signalée par les revues

Points notés en cours de route, jamais corrigés :

- **`requireClinicAccessOrThrow`** ne vérifie pas `clinics.deletedAt` (contrairement à `requireClinicAccess`) — incohérence entre deux points d'accès
- **`inviteMember`** : TOCTOU `count(maxStaff)` → `insert`, même famille que le quota patients déjà corrigé
- **`toggleClinicStatus`** renvoie `success: true` sur une clinique inexistante (0 ligne)
- **`updateStockItem`** : `minQty` remis à 0 si omis, et sans `.min(0)` — même bug que `currentQty`, corrigé
- **`getAppointmentsForDate`** n'a aucun appelant (export mort ?)
- **`payment-launcher.tsx`** : `catch { setInvoices([]) }` réinstalle silencieusement l'ambiguïté « panne = liste vide » dans le module encaissement
- **`payments/new/page.tsx`** : affiche « Patient introuvable » sur une panne DB (message faux)
- **`owner-dashboard.tsx`** : « Revenu global du jour » = `invoices.total` **tous statuts** — une **troisième** famille, ni production ni encaissé
- **`btree_gist`** : disponible dans PostgreSQL, mais jamais activé — utile pour Z-63
- **`getAuditLogHealth()`** : exposé mais **aucun consommateur** — à câbler sur `/owner/health`

---

## 7. ⬜ Améliorations fonctionnelles (non bugs)

- **`drug_catalog`** n'est **jamais consulté** : la prescription est du texte libre, sans posologie normalisée ni interaction
- **Alertes d'allergie** : table fermée de 3 aliases (`penicilline`, `amoxicilline`, `augmentin`). Toute extension est une décision clinique — le test d'audit force à la justifier
- **Impression** : pas de facture électronique conforme
- **Tests d'intégration** : la concurrence et les verrous ne sont couverts que par des tests de **source** (structurels), pas par exécution contre une vraie base

---

## 8. Environnement de développement

```
npm run db:dev        # base locale (terminal dédié, laisse-le ouvert)
npm run db:migrate    # applique les migrations
npm run dev           # l'application
npm test              # 221 tests
```

⚠️ **Ferme toujours `db:dev` avec Ctrl+C.** Un arrêt brutal laisse un verrou `postmaster.pid` — le script le détecte et le nettoie au démarrage suivant, mais l'arrêt propre évite le problème.

⚠️ Le `.env` est **gitignoré** et contient une clé de dev **sans valeur en production**. Ne jamais le copier ailleurs.
