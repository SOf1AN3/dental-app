# CHECKLIST — Reste à faire

> Suivi d'exécution. Mis à jour au fil des commits.
> ✅ = fait et committé · ⬜ = à faire · N/A = hors périmètre actuel

## Lot 1 — Correctifs structurels
- [x] Z-1 `requireCurrentClinic()`
- [x] Z-2 `requireOwnedPatient` / `requirePatientOwnership`
- [x] Z-3 `joinedAt` exigé (invitation non acceptée)
- [x] Z-4 test anti-réintroduction
- [x] Z-5 jointures `financial.ts`
- [ ] **Z-5B** appliquer `requireCurrentClinic()` aux pages `(clinic)` *(~24 fichiers, centralisable dans le layout)*

## Lot 2 — Sécurité de profondeur
- [x] Z-6 export owner (tokens de reset + `passwordHash`)
- [x] Z-7 `passwordHash` retiré du profil
- [x] Z-8 abilities (abonnement + catalogue)
- [x] Z-9 uploads sortis de `public/` + route authentifiée
- [x] Z-10 `tokenVersion` — révocation des sessions JWT
- [x] Z-11 brute-force (backoff + plafond IP)
- [x] Z-12 wildcards `ILIKE` échappées
- [x] Z-13 cookie `secure`
- [x] Z-14 `timingSafeEqual` sur `CRON_SECRET`
- [x] Z-15 throttle reset/inscription + mot de passe 12 car.
- [x] Z-16 clinique archivée inaccessible
- [x] FAC-B01 gardes de patient à l'écriture facturation

## Lot 3 — Facturation & séances
- [x] Z-17 `round2` (demi-centimes)
- [x] Z-18 `taxRate` côté séance
- [x] Z-19 transaction `createInvoice`
- [x] Z-20 transaction `createQuote`
- [x] Z-21 verrou `closeSession`
- [x] Z-22 verrou `convertQuoteToInvoice`
- [x] Z-23 verrou `recordPayment`
- [x] Z-24 bornes de saisie
- [x] Z-25 encours « en attente »
- [x] Z-26 paiement sur facture `paid` + `patientId`
- [x] Z-27 `updateSessionStatus` sans `hasAbility`
- [x] Z-28 lignes de séance modifiables après facturation
- [x] Z-29 machine à états des séances
- [x] Z-30 numéros brûlés par la séquence
- [x] Z-31 transitions facture/devis non validées
- [x] Z-32 erreurs avalées → 404 / liste vide
- [x] Z-33 « Marquer payée » sans traçabilité
- [x] Z-34 `sessionItemTotal` négatif

## Lot 4 — Patients & dossier clinique
- [x] Z-35 JSON `items` → suppression silencieuse des médicaments
- [x] Z-36 validation `dateOfBirth`
- [x] Z-37 email silencieusement effacé
- [x] Z-38 audit dans le `try` + unicité patients
- [x] Z-39 `try/catch` sur les écritures sans garde
- [x] Z-40 validation du fichier de radiographie
- [x] Z-41 payload odontogramme
- [x] Z-42 numéros de dent (plage FDI)
- [x] Z-43 colonnes d'auteur renseignées
- [x] Z-44 statut d'ordonnance validé
- [x] Z-45 ordre de saisie des items d'ordonnance
- [x] Z-46 quota patient à la restauration
- [x] Z-47 patients archivés filtrés (ordonnances/prothèses)
- [x] Z-48 existence testée (`updateLab`/`deleteLab`/`updateOrder`)
- [x] Z-49 numéro de commande prothèse
- [x] Z-50 suppression de labo lié à des commandes
- [x] Z-51 alerte d'allergie à la prescription ⚠️ *(visible sur les 3 écrans)*
- [x] Z-52 `revalidatePath` sur routes imbriquées

## Lot 5 — Agenda, salle d'attente, stock
- [ ] Z-53 dates de RDV normalisées côté serveur
- [ ] Z-54 changement de patient dans `updateAppointment`
- [ ] Z-55 transaction sur le check-in
- [ ] Z-56 incohérence visible/actif de la file
- [ ] Z-57 `updateWaitingStatus` sans contrôle d'accès
- [ ] Z-58 garde d'état sur le RDV au check-in
- [ ] Z-59 `deleteSession` liée à son entrée de file
- [ ] Z-60 `CHECK (current_qty >= 0)` + ajustement
- [ ] Z-61 stock remis à 0 si champ omis
- [ ] Z-62 alertes de stock jamais résolues
- [ ] Z-63 contrainte d'exclusion sur les plages de RDV

## Lot 6 — Rapports & notifications
- [ ] Z-64 `getMonthlyTrends` sans permission
- [ ] Z-65 définitions de « revenu » incohérentes
- [ ] Z-66 fuseau horaire des rapports
- [ ] Z-67 taux d'occupation
- [ ] Z-68 `userId` sur les notifications lues
- [ ] Z-69 cible de `createNotification` validée
- [ ] Z-70 `requireAuth` sur les notifications

## Lot 7 — Fiabilité transverse
- [ ] Z-71 erreurs DB avalées (`[]` / `null` / succès)
- [ ] Z-72 résultats des `UPDATE` testés
- [ ] Z-73 quota patients (TOCTOU)
- [ ] Z-74 IP `x-forwarded-for` journalisée comme vérité
- [ ] Z-75 échecs d'audit avalés
- [ ] Z-76 consommation de token atomique
- [ ] Z-77 rétrogradation du dernier owner
- [ ] Z-78 ré-vérification de l'email
- [ ] Z-79 sanitisation des clés de stockage
- [ ] Z-80 `emailVerified` exigé dans `requireAuth`

## Lot 8 — Propreté & reconnaissance
- [x] Z-81 artefacts `.js` compilés supprimés
- [x] Z-82 `proxy.ts` inspecté (lu et modifié en A-5)
- [ ] Z-83 `src/app/billing/**` hors groupe `(clinic)`

## Lot 9 — Tests
- [x] T-1 garde multi-tenant
- [x] T-2 arrondis financiers *(couvert par Z-17)*
- [ ] T-3 transitions de statut
- [ ] T-4 verrous de concurrence
- [ ] T-5 règles de séance
- [ ] T-6 alerte d'allergie
- [ ] T-7 *(N/A — migration locale hors-ligne abandonnée)*
- [ ] T-8 contrôle d'accès financier

---

## ⬜ En cours
**Lot 5** — Z-53 à Z-63 (agenda, salle d'attente, stock).

## ⚠️ À trancher par le client (bloquent certains lots)
- **Q1** — corriger les 63 P2 ou seulement P0/P1 ?
- **Q2** 🟥 — assiette de TVA : remise déductible de l'assiette, ou déduite **après** TVA (actuel) ? → **bloque Z-17 et la conformité fiscale**
- **Q3** — implémenter le statut `overdue` (onglet « Impayée » vide)
- **Q4** — « Marquer payée » : écriture de paiement traçable, ou statut nu ? → **Z-33**
- **Q5** 🟥 — contrôle d'allergie à l'ordonnance → **Z-51**
- **Q6** — `deleteSession` liée à son entrée de file → **Z-59**

## 🔴 Avant tout déploiement
- [ ] **Backfill `joined_at`** : `npx tsx scripts/backfill-membership-joined-at.ts` (diagnostic) puis `--apply`
- [ ] **Migration `token_version`** : `npm run db:generate` puis `npm run db:migrate` **avant** le déploiement du code Z-10
- [ ] **Migrations `order_index` (Z-45) + index unique commandes prothèse (Z-49)** :
  1. contrôle des doublons **avant** migration :
     `SELECT clinic_id, order_number, COUNT(*) FROM prosthesis_order GROUP BY 1, 2 HAVING COUNT(*) > 1;`
     → si lignes retournées, renuméroter d'abord (sinon la migration **échoue**)
  2. `npm run db:generate` → commit des fichiers `drizzle/*.sql` + `meta/`
  3. `npm run db:migrate`
  4. **Redéploiement obligatoire** — la sonde de Z-45 est mémoïsée par process
- [ ] **Nettoyage lié aux numéros de dent** : `UPDATE treatment_plan_item SET tooth_number = NULL WHERE tooth_number = 0;`
- [ ] **Fumée-test** après déploiement : créer une commande prothèse → vérifier `PRO-2026-0000n` (SQL Z-49 jamais exécuté en conditions réelles)
