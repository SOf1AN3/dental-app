# PLAN.md — Stabilisation : bugs & sécurité

> **Statut** : EN ATTENTE DE VALIDATION — aucun code applicatif modifié.
> **Date de rédaction** : 2026-10-10
> **Périmètre** : correction des 108 bugs identifiés par l'audit (7 bloquants, 38 importants, 63 mineurs).

---

## Contexte & besoin métier

**DentalCare** est une plateforme multi-cliniques de gestion de cabinet dentaire. Elle gère
42 tables PostgreSQL : patients, agenda & salle d'attente, dossier clinique (odontogramme, plans
de traitement, radiographies, historique médical), séances, facturation (factures, devis,
paiements), ordonnances, stock, prothèses, abonnements et audit.

L'application contient des **données de santé**. La gravité maximale est donc de mise sur tout ce
qui touche à l'isolation des cliniques, à l'accès non autorisé et à l'intégrité des montants.

**Quatre audits ont balayé l'intégralité des Server Actions, routes API, schémas et règles
métier. Résultat : 108 bugs confirmés.**

---

## Périmètre retenu

Le client a décidé de **restreindre ce plan à la stabilisation** :

| Dans le périmètre | Hors périmètre (reporté) |
|---|---|
| Correction des 108 bugs | Fonctionnalité hors-ligne / synchronisation |
| Failles de sécurité critiques | PWA, cache local, auth hors-ligne |
| Intégrité en base | Migration de l'UI côté client |
| Propreté du dépôt | Backlog de `new phase.md` (hors les 3 tickets cassés) |
| Tests de non-régression | Refonte architecturale |

> L'analyse complète de l'architecture hors-ligne a été réalisée mais **n'entre plus dans ce
> plan**. Elle est récupérable dans l'historique Git de `PLAN.md`.

---

## Résultats de l'audit

| Module | Bugs | P0 | P1 | P2 |
|---|---|---|---|---|
| Dossier patient / clinique / ordonnances | 30 | 4 | 7 | 19 |
| Agenda / salle d'attente / stock / rapports | 30 | 1 | 10 | 19 |
| Sécurité / multi-tenant / auth / API | 23 | 2 | 8 | 13 |
| Facturation / séances / calculs | 25 | 0 | 13 | 12 |
| **TOTAL** | **108** | **7** | **38** | **63** |

> Le point essentiel n'est pas le nombre mais la **nature** : ces 108 bugs découlent d'environ
> **une dizaine de motifs structurels** répétés dans des fichiers différents. Corriger les
> symptômes un par un laisserait la cause intacte et les bugs réapparaîtraient au prochain
> développement.

---

## Les 7 motifs structurels

### M1 — `patientId` / `clinicId` jamais validé *(le plus grave — 9 actions)*

Le helper `requireActivePatient` **existe et fonctionne**. Il est utilisé dans **un seul fichier**.
Partout ailleurs, une action reçoit un `patientId` du client et lui fait aveuglément confiance.

Le mécanisme subtil : une action peut parfaitement vérifier *« cet utilisateur est membre de sa
clinique »* (`requireClinicAccessOrThrow`) **tout en acceptant n'importe quel `patientId` dans le
corps de la requête**. Le compartiment est contrôlé, le contenu qu'on y range ne l'est pas.

| Module | Actions concernées | Réf. |
|---|---|---|
| patient | `requireActivePatient` elle-même exposée sans auth | PAT-B01 **P0** |
| clinical | `createTreatmentPlan`, `createConsultationNote`, `createRadiograph`, `createMedicalHistoryEntry` | PAT-B05 |
| odontogram | `saveOdontogramState` | PAT-B05 |
| prescription | `createPrescription` + JOIN non filtré | PAT-B03 **P0** |
| prosthesis | `createOrder`, `updateOrder` + JOIN non filtré | PAT-B04 **P0** |
| appointment | `createAppointment` — et le payload d'erreur de conflit **retourne le nom du patient étranger** | APT-B01 **P0** |
| waiting-room | `addToWaitingRoom`, `addWalkInToWaitingRoom` | WR-B01, WR-B06 |
| financial | `createInvoice`, `createQuote`, `recordPayment` + pages détail lisant `patients` sans `clinicId` | FAC-B01 |
| api/drugs | `/api/drugs/search` — sa jumelle `/export` **a** la garde, elle ne l'a pas | SEC-B01 **P0** |

**Conséquence clinique directe (WR-B01)** : on peut lier le rendez-vous du patient A au dossier
d'attente du patient B — le dossier de soin se rattache à **la mauvaise personne**.

### M2 — Une invitation jamais acceptée ouvre tout *(SEC-B02, P0)*

`clinicMemberships.joinedAt` **n'est testé nulle part**. Le simple fait qu'une ligne de membership
*existe* ouvre l'accès complet.

> Scénario : un dentiste invite l'email d'un compte tiers. **Sans même cliquer sur le lien**, ce
> compte lit patients, odontogrammes, radios et ordonnances. Une personne qui *décline* conserve
> son accès.

### M3 — Fuseau horaire : les utilitaires existent et sont oubliés

`getClinicDateString` et `offsetMinutesForTz` existent, sont corrects et DST-aware. Ils sont
utilisés dans la génération des créneaux, puis **oubliés** dans `getAppointmentsForDate`
(`setHours` sur le fuseau serveur), dans tous les rapports, dans les dates par défaut des
formulaires (`toISOString()` → **date de la veille** après minuit local) et dans le stockage des
dates de rendez-vous (`new Date(string)` sans format imposé).

### M4 — `logAction` dans le `try` → « Échec » affiché alors que l'écriture a réussi

```js
try {
  await db.insert(patient).values(...)   // ✅ écrit
  await logAction(...)                    // ❌ échoue
} catch { return "Erreur" }               // → l'utilisateur relance → DOUBLON
```
Aucune contrainte d'unicité n'existe pour rattraper le doublon (PAT-B08, PAT-B30).

### M5 — La seule garde est en JavaScript, jamais en base

| Contrainte absente | Conséquence observée |
|---|---|
| `CHECK (current_qty >= 0)` | stock négatif par concurrence (INV-B01) |
| Contrainte d'exclusion sur les plages de RDV | **double réservation** par race (APT-B03) |
| `UNIQUE` sur les numéros de commande prothèse | `PRO-YYYY-00001` dupliqué (PAT-B22) |
| Index unique partiel sur alertes actives | alertes en doublon **puis définitivement muettes** (INV-B04) |
| `UNIQUE (invoice.session_id)` | deux factures pour une même séance (FAC-B03) |

### M6 — `.catch("")` et `catch {}` qui avalent les erreurs

- **PAT-B06** — JSON `items` malformé → `[]` → **tous les médicaments de l'ordonnance supprimés**
- **PAT-B16** — email invalide **silencieusement effacé**, message « Email invalide » = code mort
- **FAC-B17** — `taxRate.catch(0)` → **TVA annulée sans avertissement** (perte sèche + risque fiscal)
- **FAC-B22** — erreur DB → `null` → **404 sur une facture existante**
- **TRA-B01** — erreur DB → `[]` → *« 0 patient aujourd'hui »* affiché lors d'une simple panne

### M7 — Atomicité absente sur les écritures critiques

Facture + lignes + audit sans transaction (FAC-B02), check-in salle d'attente sans transaction
(WR-B02), `convertQuoteToInvoice` en check-then-act (FAC-B04), recalcul de statut de paiement en
3 statements séparés (FAC-B05), `document_sequence` incrémenté **avant** la validation →
**numéros brûlés** (FAC-B14, PAT-B22).

---

## Bugs d'argent avérés (vérifiés en exécutant le code)

| ID | Constat |
|---|---|
| **FAC-B06** | `round2` est **faux sur les demi-centimes** : `lineTax(1, 42.5, 19)` renvoie **8,07 au lieu de 8,08**. Sous-perception systématique de TVA. Le test existant passe **par chance** (`10.005` tombe juste), donnant une fausse sécurité. |
| **FAC-B15** | Total document ≠ somme des lignes : **199,99 affiché vs 200,00 stocké**. Visible sur le document imprimé. |
| **FAC-B11** | `recalculateSessionTotal` **ignore `taxRate`** alors que `closeSession` l'applique → acte à 1000 DZD à 19 % : la séance affiche **1000**, la facture affiche **1190**. |
| **FAC-B07** | « En attente de paiement » additionne le montant **intégral** des factures partiellement payées — 10 000 réglés à 9 999 comptent 10 000. |
| **RAP-B01** | `getMonthlyTrends` fait les mêmes agrégations que `getRevenueData` **sans la permission `revenue:view_global`** → tout membre en rôle `viewer` lit 6 mois de revenus. |
| **PAT-B27** | `sessionItemTotal` ne plafonne pas à 0 → remise supérieure au montant = sous-total **négatif** propagé. |

### Impact sur le backlog existant (`new phase.md`)

| Ticket | Statut réel constaté |
|---|---|
| **FACT-5** (calcul TVA) | **Confirmé et quadruplé** : FAC-B06 (`round2` faux), FAC-B15 (totals ≠ lignes), FAC-B11 (`taxRate` ignoré côté séance), FAC-B17 (`catch(0)` annule la TVA). |
| **FACT-6** (paiement depuis la facture) | **Confirmé** comme lien mort, aggravé par FAC-B12 (« Marquer payée » sans écriture de paiement) et FAC-B08 (paiement accepté sur facture `paid`). |
| **RAP-1** (rapports admin only) | **Cassé aujourd'hui** via `getMonthlyTrends` — pas seulement non implémenté. La promesse « un dentiste ne voit jamais les revenus des confrères » repose sur une garde qui ne protège rien. |

---

## Zones saines — vérifiées explicitement

- **Injection SQL : aucune.** Tout est paramétré Drizzle ; `escapeLike` échappe `%` et `_` côté
  recherche patients. Le seul `sql``` n'interpole qu'une colonne de schéma.
- **Numérotation des factures** : `UPDATE … last_number + 1 … RETURNING` est **atomique**, et les
  contraintes `uq_doc_seq_clinic_type` + `uq_invoices_clinic_number` **empêchent tout doublon**.
- **Détection de conflit de RDV** : intervalles **semi-ouverts** `[début, fin)` — corrects et
  **couverts par des tests**.
- **Unicité salle d'attente** : garantie **en base** par index partiel unique + gestion du 23505.
  *Seul endroit du code où une règle métier est réellement protégée en base.*
- **Crons Vercel** : protégés par `CRON_SECRET` et **fail-closed** (503 si absent).
- **Mots de passe** : bcrypt cost 12, aucun hash journalisé ; tokens de reset en 32 octets
  CSPRNG, expiration 1 h, usage unique, anciens tokens invalidés.
- **Console owner** : `requirePlatformOwner()` vérifié dans le layout **et** chaque page **et**
  chaque action — jamais délégué au masquage de menu.
- **Confiance du client sur les totaux** : soumis puis **ignorés**, `docTotals()` recalculé
  côté serveur à chaque création.
- **Tests de la matrice de rôles** : `permissions.test.ts` vérifie *concrètement* que `viewer` est
  en lecture seule. La politique est **testée**, pas seulement documentée.
- **Pas de N+1** dans les rapports : agrégats SQL + `Promise.all`.
- **Cascade de suppression** : aucun paiement orphelin créé par une suppression.
- **CSRF sur l'API d'auth** : l'origine est validée.
- **Pas d'élévation de privilège** : `inviteMember` et `updateMemberRole` excluent le rôle `owner`.

---

## Questions / décisions en attente

1. **Périmètre P2** — Corriger les **63 bugs P2** ou se limiter aux **45 P0/P1** ?
   *Je recommande : P0 + P1 d'abord, P2 en second lot après validation.* 🟦
2. **FAC-B24 — assiette de TVA** — La remise est-elle **déductible de l'assiette** (TVA calculée
   sur `base − remise`) ou **déduite après** la TVA (comportement actuel) ? Le code présente la
   seconde comme voulue, mais une remise de 200 sur une ligne à 1000 à 19 % facture **190** de
   TVA au lieu de **152**. → **À trancher avec ton comptable.** 🟥 Bloque Z-12.
3. **FAC-B25 — statut « Impayée »** — Le calcul `overdue` n'est **jamais produit** : l'onglet
   « Impayée » serait structurellement vide. Le faut-il implémenter, et à partir de quel délai
   après échéance ? 🟧
4. **FAC-B12 — « Marquer payée »** — Doit-il créer une **écriture de paiement** (traçable, avec
   méthode et auteur) ou rester un simple changement de statut ? Aujourd'hui la facture sort de
   l'encours **sans qu'aucune recette n'existe**. 🟧
5. **PAT-B11 — contrôle d'allergie** *(SUSPECT)* — Aucune vérification d'allergie à la
   prescription : une allergie à la pénicilline enregistrée dans l'historique médical **n'alerte
   ni ne bloque** rien, et le `drug_catalog` n'est jamais consulté. S'agit-il d'une **fonctionnalité
   manquante** à ajouter, ou d'un contrôle assumé côté UI ? 🟥 Risque clinique.
6. **FAC-B20 — file d'attente** — `deleteSession` supprime **toutes** les entrées actives du
   patient, pas celle liée à la séance. Corriger par un lien explicite ? 🟧

---

## 1. Correctifs structurels *(à faire en premier)*

> **Principe** : les tâches de ce lot ne corrigent pas des symptômes — elles **rendent la
> réintroduction impossible**. Elles précèdent obligatoirement tous les autres lots, car
> corriger les failles de 2 et 3 sans ce socle reviendrait à repartir du même point au
> prochain développement.

| Tâche | Fichiers exacts | Dépend de | Fait quand |
|---|---|---|---|
| **Z-1** Helper `requireCurrentClinic()` non contournable — lit **et** valide le cookie en une opération | **modifier** `src/lib/multi-tenant.ts` ; **remplacer** les appels dans `src/app/api/drugs/search/route.ts`, `src/app/api/drugs/export/route.ts` | — | `getCurrentClinicId()` seule ne suffit plus à ouvrir un accès |
| **Z-2** Helper `requireOwnedPatient(clinicId, patientId)` + application **systématique** | **créer** `src/lib/actions/guards.ts` ; **modifier** `src/lib/actions/patient.ts`, `clinical.ts`, `odontogram.ts`, `prescription.ts`, `prosthesis.ts`, `appointment.ts`, `waiting-room.ts`, `financial.ts` | — | **aucune** action ne reçoit plus un `patientId` non vérifié |
| **Z-3** Exiger `joinedAt IS NOT NULL` | **modifier** `src/lib/multi-tenant.ts` (`requireClinicAccess`), `src/lib/auth-utils.ts` (`requireClinicAccessOrThrow`, `getUserMemberships`), `src/lib/actions/clinic.ts` (`switchClinic`) | — | invitation non acceptée = aucun accès ; déclin = accès révoqué |
| **Z-4** Test de non-régression anti-réintroduction | **créer** `src/lib/multi-tenant.guard.test.ts` | Z-1, Z-2, Z-3 | le test **échoue** si une surface oublie la validation |
| **Z-5** Filtrer les JOIN `patients` par `clinicId` | **modifier** `src/lib/actions/prescription.ts` (L32, L60), `prosthesis.ts` (L257, L281), `financial.ts` (L147-152), `src/app/(clinic)/billing/invoices/[id]/page.tsx` (L48-50), `src/app/(clinic)/billing/quotes/[id]/page.tsx` (L186-190) | — | aucun JOIN ne retourne plus un patient d'un autre tenant |
| **Z-5B** Appliquer `requireCurrentClinic()` aux **pages** du groupe `(clinic)` | **modifier** `src/app/(clinic)/**` (~47 pages) ; idéalement **centraliser dans** `src/app/(clinic)/layout.tsx` | Z-1 | aucune page ne se fie plus seule au cookie forgeable |

> 🔴 **Z-5B ajouté après découverte en revue (2026-10-10)** — **constat non couvert par l'audit
> initial** : **47 pages** du groupe `(clinic)` appellent `getCurrentClinicId()` **sans aucune
> vérification d'appartenance** ; seules **2** appellent `requireClinicAccess`
> (`settings/schedule`, `patients/[id]/session/[sessionId]`). Le cookie `active_clinic_id` se
> forge côté client → un utilisateur authentifié peut lire le nom/prénom d'un patient d'une autre
> clinique via `?patientId=`.
>
> C'est le **motif M1 appliqué aux pages**, non détecté par l'audit qui s'était concentré sur les
> Server Actions. **Note rassurante** : les *actions* (`financial.ts`) appellent bien
> `requireClinicAccessOrThrow`, donc les données écrites sont protégées — la fuite est **de
> lecture** via les Server Components, et la protection est **incohérente** entre pages et actions.
>
> **Recommandation** : plutôt que de corriger 47 pages une par une, **centraliser dans le layout**
> du groupe `(clinic)`, qui est déjà exécuté avant chaque page — une seule vérification protège
> l'intégralité du groupe. À valider avec le client (risque : un layout qui redirige peut casser
> les pages d'erreur ou les flux d'authentification).

---

## 2. Failles de sécurité critiques

| Tâche | Fichiers exacts | Dépend de | Fait quand |
|---|---|---|---|
| **Z-6** Exclure `accountTokens`, `loginAttempts` et `users.passwordHash` de l'export owner | **modifier** `src/app/api/owner/export/route.ts` (L12-20, L187-196, L209-215) | — | l'export « clinique » ne contient plus de tokens de reset **en clair** |
| **Z-7** Retirer `passwordHash` du profil | **modifier** `src/lib/actions/settings.ts` (L35-37, ajouter `columns:`) | — | aucun hash n'atteint le client |
| **Z-8** Restreindre abonnement + catalogue au rôle | **modifier** `src/lib/actions/subscription.ts` (L76-84, L146-150), `src/lib/actions/drug-catalog.ts` (L71-319) — ajouter `hasAbility` | — | un `viewer` ne peut plus résilier l'abonnement ni supprimer le catalogue |
| **Z-9** Servir les uploads via route authentifiée | **modifier** `src/lib/storage.ts` (L38-85, L227-230) ; **créer** `src/app/api/files/[...key]/route.ts` | — | plus d'URL publique permanente pour les radiographies |
| **Z-10** `tokenVersion` révoquant les sessions | **modifier** `src/lib/db/schema/auth.ts`, `src/lib/actions/auth.ts` (L126-131, L207-210), `src/lib/auth.ts` (L71-86) ; migration `drizzle/` | — | changer de mot de passe invalide les JWT existants |
| **Z-11** Limiter le brute-force par IP **et** par compte | **modifier** `src/lib/auth.ts` (L35-60) | — | DoS de compte impossible, stuffing plafonné, purge > 24 h |
| **Z-12** Échapper les wildcards `ILIKE` | **modifier** `src/app/api/drugs/search/route.ts` (L35), `src/lib/actions/drug-catalog.ts` (L36) | — | `q=%` ne balaie plus tout le catalogue |
| **Z-13** Durcir le cookie de clinique | **modifier** `src/lib/actions/clinic.ts` (L67-72, L116-121) — ajouter `secure: true` | — | cookie sécurisé en tout déploiement |
| **Z-14** `timingSafeEqual` sur `CRON_SECRET` | **modifier** `src/app/api/cron/expire-quotes/route.ts` (L10), `src/app/api/cron/subscription-reminders/route.ts` (L10) | — | comparaison constante en temps |
| **Z-15** Limiter la réinitialisation de mot de passe + politique ≥ 12 caractères | **modifier** `src/lib/actions/auth.ts` (L25-29, L79-103) | — | flood d'emails impossible, énumération d'emails supprimée à l'inscription |
| **Z-16** Valider `clinics.deletedAt` dans `requireClinicAccess` | **modifier** `src/lib/multi-tenant.ts` (L21-26) | Z-1 | clinique archivée inaccessible à ses membres |

> ⚠️ **Z-9 est prioritaire** pour toute fonctionnalité future touchant aux radiographies : sans
> elle, un fichier médical reste accessible par simple URL, sans session ni journalisation.

---

## 3. Bugs métier — facturation & séances

| Tâche | Fichiers exacts | Dépend de | Fait quand |
|---|---|---|---|
| **Z-17** Corriger `round2` (demi-centimes) | **modifier** `src/lib/billing-math.ts` (L26-28, L45-52) ; **corriger** `src/lib/billing-math.test.ts` (L14 — le test actuel passe par chance) | **Q2** | `lineTax(1, 42.5, 19) === 8.08` — test de non-régression ajouté |
| **Z-18** Réconcilier `taxRate` entre séance et facture | **modifier** `src/lib/actions/session.ts` (L249 `recalculateSessionTotal`) | Z-17 | séance et facture affichent le même montant |
| **Z-19** Transaction sur création facture | **modifier** `src/lib/actions/financial.ts` (L551-595) — sortir `logAction` du `try` ou la lier à la transaction | — | plus de facture orpheline sans lignes ; plus de doublon après relance |
| **Z-20** Transaction sur création devis | **modifier** `src/lib/actions/financial.ts` (L261-305) | — | idem |
| **Z-21** Verrou de fermeture de séance | **modifier** `src/lib/actions/session.ts` (L560-564 — ajouter `AND status = 'in_progress'`) ; migration `drizzle/` (`UNIQUE (invoice.session_id)`) | — | deux clôtures simultanées = **une seule** facture |
| **Z-22** Verrou de conversion devis → facture | **modifier** `src/lib/actions/financial.ts` (L454-457 — ajouter `AND converted_invoice_id IS NULL`) | — | une seule facture par conversion |
| **Z-23** Verrou de recalcul de statut de paiement | **modifier** `src/lib/actions/financial.ts` (L752-802 — `SELECT … FOR UPDATE`) | — | encaissements simultanés : la facture soldée passe bien `paid` |
| **Z-24** Plafonner les saisies financières | **modifier** `src/lib/actions/financial.ts` — remise bornée (L44), montant de paiement borné (L726-730), décimales limitées (L42-43), `taxRate` **sans** `.catch(0)` | — | plus de total négatif, plus de TVA annulée, plus de surpaiement |
| **Z-25** Corriger l'encours « en attente de paiement » | **modifier** `src/lib/actions/financial.ts` (L116-118 — exclure `cancelled`, déduire les paiements) | — | l'encours reflète le solde réel |
| **Z-26** Refuser le paiement sur facture `paid` + vérifier `patientId` de la facture | **modifier** `src/lib/actions/financial.ts` (L747-749, L793-797) | — | une facture soldée ne régresse plus en `partially_paid` |
| **Z-27** Restreindre `updateSessionStatus` | **modifier** `src/lib/actions/session.ts` (L695-782 — ajouter `hasAbility`) | — | plus de facture `paid` sans encaissement |
| **Z-28** Verrouiller les lignes de séance après facturation | **modifier** `src/lib/actions/session.ts` (L275-501 — tester `session.status`) | — | le total de séance ne diverge plus de la facture |
| **Z-29** Corriger la machine à états des séances | **modifier** `src/lib/session-rules.ts` (L42-45), `src/lib/actions/session.ts` (L563), `src/lib/actions/financial.ts` (L804-808) | **Q4** | statuts cohérents, transitions respectées |
| **Z-30** Incrémenter la séquence **après** validation | **modifier** `src/lib/actions/financial.ts` (L528-545, L238-255) | — | plus de numéro brûlé par un formulaire invalide |
| **Z-31** Valider les transitions de statut facture/devis | **modifier** `src/lib/actions/financial.ts` (L636-645, L674-677, L312-349) | **Q4** | `cancelled → paid` et `paid → draft` refusés |
| **Z-32** Ne pas avaler les erreurs de lecture | **modifier** `src/lib/actions/financial.ts` (L91-104, L75-83, L139-164, L72) | — | plus de **404 sur une facture existante** ; `?status=bogus` rejeté |
| **Z-33** Journaliser « Marquer payée » | **modifier** `src/lib/actions/financial.ts` (L674-677) ; `src/components/clinic/confirm-mark-paid-button.tsx` (L22-24) | **Q4** | message non trompeur, écriture tracée |
| **Z-34** Corriger `sessionItemTotal` (plafond 0) | **modifier** `src/lib/session-rules.ts` (L15-21) | — | plus de sous-total négatif |

---

## 4. Bugs métier — patients, dossier clinique, prescriptions

| Tâche | Fichiers exacts | Dépend de | Fait quand |
|---|---|---|---|
| **Z-35** Ne plus convertir un JSON malformé en `[]` | **modifier** `src/lib/actions/prescription.ts` (L103-113, L259-270) | — | plus de suppression silencieuse des médicaments |
| **Z-36** Valider la date de naissance | **modifier** `src/lib/actions/patient.ts` (L23, L74, L227) | — | date future refusée, format vérifié, erreur explicite |
| **Z-37** Ne plus effacer silencieusement un email invalide | **modifier** `src/lib/actions/patient.ts` (L26 — retirer `.catch("")`) | — | « Email invalide » affiché réellement |
| **Z-38** Tenter l'audit **après** l'insertion validée ; ajouter les contraintes d'unicité | **modifier** `src/lib/actions/patient.ts` (L51-96) ; migration `drizzle/` | — | plus de « faux échec » → plus de doublon |
| **Z-39** Ajouter `try/catch` aux écritures sans garde | **modifier** `src/lib/actions/clinical.ts` (L521-543, L737-760) | — | message contrôlé au lieu d'une 500 |
| **Z-40** Valider le fichier de radiographie (type + taille) | **modifier** `src/lib/actions/clinical.ts` (L590-614) ; **nettoyer** l'upload orphelin en cas d'échec d'insert | — | `.exe` et `.svg` refusés, taille bornée |
| **Z-41** Valider le payload de l'odontogramme | **modifier** `src/lib/actions/odontogram.ts` (L44-60) | — | schéma imposé, plages FDI vérifiées, taille bornée |
| **Z-42** Restreindre les numéros de dent à la plage FDI | **modifier** `src/lib/actions/clinical.ts` (L153, L569), `src/lib/actions/prosthesis.ts` (L27-30) | — | dents `-1`, `0`, `999` refusées |
| **Z-43** Renseigner les colonnes d'auteur | **modifier** `src/lib/actions/clinical.ts` (L121-128, L521-527, L605-614), `src/lib/actions/prosthesis.ts` (L367-379) | — | `createdBy`, `dentistId`, `uploadedBy` renseignés |
| **Z-44** Valider le statut d'ordonnance | **modifier** `src/lib/actions/prescription.ts` (L295-335) | — | valeur invalide rejetée avec message |
| **Z-45** Conserver l'ordre de saisie des items d'ordonnance | **modifier** `src/lib/db/schema/prescriptions.ts`, `src/lib/actions/prescription.ts` (L71, L259-270) ; migration `drizzle/` | — | l'ordre de saisie est préservé à l'affichage et à l'impression |
| **Z-46** Vérifier le quota patient lors d'une restauration | **modifier** `src/lib/actions/patient.ts` (L175-197) | — | la limite du plan ne se contourne plus par restauration |
| **Z-47** Filtrer les patients archivés dans ordonnances et prothèses | **modifier** `src/lib/actions/prescription.ts` (L32), `src/lib/actions/prosthesis.ts` (L257, L281) | Z-5 | patient archivé invisible partout |
| **Z-48** Tester l'existence avant `delete`/`update` de labo | **modifier** `src/lib/actions/prosthesis.ts` (L144-167, L208-228, L465-494) | — | plus de succès mensonger |
| **Z-49** Sécuriser la génération du numéro de commande prothèse | **modifier** `src/lib/actions/prosthesis.ts` (L341-364) ; migration `drizzle/` (`UNIQUE (order_number)`) | — | numéros dupliqués impossibles |
| **Z-50** Alerte si suppression de labo liée à des commandes | **modifier** `src/lib/actions/prosthesis.ts` (L214-216) | — | confirmation exigée |
| **Z-51** Alerte d'allergie à la prescription | **modifier** `src/lib/actions/prescription.ts` ; `src/lib/actions/clinical.ts` (lecture `medicalHistoryEntries`) | **Q5** | l'allergie est **signalée** avant enregistrement |
| **Z-52** Filtrer `revalidatePath` sur les routes imbriquées | **modifier** `src/lib/actions/clinical.ts` (L542, L759, et `createRadiograph`) | — | les radios créées apparaissent sans rechargement |

---

## 5. Bugs métier — agenda, salle d'attente, stock

| Tâche | Fichiers exacts | Dépend de | Fait quand |
|---|---|---|---|
| **Z-53** Normaliser les dates de RDV côté serveur | **modifier** `src/lib/actions/appointment.ts` (L25-33, L104, L508-511) — imposer `getClinicDateString`/`offsetMinutesForTz`, bannir `setHours` et `new Date(string)` | — | plus de décalage d'1 h, plus de 500 sur date invalide |
| **Z-54** Appliquer le changement de patient dans `updateAppointment` | **modifier** `src/lib/actions/appointment.ts` (L404-414, L429-430) | — | l'audit dit vrai, les conflits sont vérifiés sur le bon patient |
| **Z-55** Transaction sur le check-in en salle d'attente | **modifier** `src/lib/actions/waiting-room.ts` (L48-77) | — | plus d'état partiel masqué par le `catch` |
| **Z-56** Corriger l'incohérence visible/actif de la file | **modifier** `src/lib/actions/waiting-room.ts` (L185-190) | — | les patients `called`/`in_treatment` réapparaissent à l'écran |
| **Z-57** Ajouter `requireClinicAccessOrThrow` à `updateWaitingStatus` + machine à états | **modifier** `src/lib/actions/waiting-room.ts` (L135-170) | — | transitions validées, plus de 500 |
| **Z-58** Ajouter une garde d'état sur le RDV au check-in | **modifier** `src/lib/actions/waiting-room.ts` (L75-77) | — | un RDV terminé ne repasse plus `confirmed` |
| **Z-59** Lier la suppression de séance à son entrée de file | **modifier** `src/lib/actions/session.ts` (L837-849) | **Q6** | les autres entrées du patient sont préservées |
| **Z-60** `CHECK (current_qty >= 0)` + mouvement d'ajustement | migration `drizzle/` ; **modifier** `src/lib/actions/inventory.ts` (L18-19, L169, L290, L292-311) | — | stock négatif impossible **en base**, ajustement à la baisse possible |
| **Z-61** Ne plus remettre le stock à 0 si le champ est omis | **modifier** `src/lib/actions/inventory.ts` (L169) | — | omission ≠ remise à zéro |
| **Z-62** Résoudre les alertes de stock + index unique partiel | migration `drizzle/` ; **modifier** `src/lib/actions/inventory.ts` (L328-347) | — | les alertes reprennent après un réapprovisionnement |
| **Z-63** Contrainte d'exclusion sur les plages de RDV | migration `drizzle/` (`EXCLUDE USING gist`) | — | **double réservation impossible en base** |

---

## 6. Rapports & notifications

| Tâche | Fichiers exacts | Dépend de | Fait quand |
|---|---|---|---|
| **Z-64** Ajouter la permission `revenue:view_global` à `getMonthlyTrends` | **modifier** `src/lib/actions/reports.ts` (L193-245) | — | un `viewer` ne lit plus les revenus |
| **Z-65** Unifier les définitions de « revenu » | **modifier** `src/lib/actions/reports.ts` (L113-183) | — | `totalRevenue = Σ monthlyRevenue`, libellés explicites |
| **Z-66** Passer les bornes de rapports au fuseau clinique | **modifier** `src/lib/actions/reports.ts` (L23-24, L108-111, L147, L171, L219-240, L265-268) | — | plus de paiement compté dans le mauvais mois |
| **Z-67** Corriger le taux d'occupation | **modifier** `src/lib/actions/reports.ts` (L274-292) | — | créneaux calculés depuis `clinic_schedule`, statuts annulés exclus |
| **Z-68** Ajouter un `userId` aux notifications lu/non-lu | migration `drizzle/` ; **modifier** `src/lib/db/schema/tenant.ts` (L77-90), `src/lib/actions/notifications.ts` (L55-68) | — | un membre n'efface plus le badge des autres |
| **Z-69** Valider la cible de `createNotification` | **modifier** `src/lib/actions/notifications.ts` (L93-124) | — | clinique inexistante ou archivée refusée |
| **Z-70** Ajouter `requireAuth` à `getNotifications` et `markNotificationsRead` | **modifier** `src/lib/actions/notifications.ts` (L22-23, L55-56) | — | contrôle explicite, indépendant du cookie |

---

## 7. Fiabilité transverse

| Tâche | Fichiers exacts | Fait quand |
|---|---|---|
| **Z-71** Ne plus masquer les erreurs DB par `[]` ou `null` | `src/lib/actions/inventory.ts` (L46), `waiting-room.ts` (L194), `appointment.ts` (L531), `financial.ts` | une panne DB n'est plus affichée comme « aucune donnée » |
| **Z-72** Tester le résultat des UPDATE | `src/lib/actions/inventory.ts` (L147-176), `prosthesis.ts`, `patient.ts` (L127-161) | plus de succès mensonger sur 0 ligne touchée |
| **Z-73** Transaction sur la limite de patients (TOCTOU) | `src/lib/actions/patient.ts` (L52-85) ; migration `drizzle/` | le quota d'abonnement ne se contourne plus par concurrence |
| **Z-74** Ne pas journaliser l'IP comme source de vérité | `src/lib/auth.ts` (L30-33), `src/lib/audit.ts` (L19-21) | `x-forwarded-for` n'est plus forgeable dans les journaux |
| **Z-75** Remonter les échecs d'audit au lieu de les avaler | `src/lib/audit.ts` (L32-34) | une action sensible n'est plus commise sans trace |
| **Z-76** Rendre la consommation de token atomique | `src/lib/auth-utils.ts` (L126-146) | un lien de reset ne se réutilise plus |
| **Z-77** Empêcher la rétrogradation du dernier owner + valider `newStatus` | `src/lib/actions/membership.ts` (L215-235), `src/lib/actions/owner.ts` (L87-103, L278-283) | ≥ 1 owner garanti, enum validée côté serveur |
| **Z-78** Ré-vérifier l'email après changement | `src/lib/actions/settings.ts` (L392-417) | l'ancienne adresse est notifiée, `emailVerified` réinitialisé |
| **Z-79** Sanitizer les clés de stockage et restreindre les URLs | `src/lib/storage.ts` (L18-36, L54-82) | `..` neutralisé, allowlist de domaines sur `resolveStoredUrl` |
| **Z-80** Tester `emailVerified` dans `requireAuth` | `src/lib/auth-utils.ts` (L17-21) ; **vérifier d'abord** `proxy.ts` | la vérification d'email cesse d'être cosmétique |

---

## 8. Propreté & reconnaissance

| Tâche | Fichiers exacts | Fait quand |
|---|---|---|
| **Z-81** Supprimer les artefacts `.js` compilés du schéma | `src/lib/db/schema/*.js` (14 fichiers : `appointments.js`, `audit.js`, `auth.js`, `clinical.js`, `drug-catalog.js`*, `financial.js`, `index.js`, `inventory.js`, `patients.js`, `prescriptions.js`, `prostheses.js`, `relations.js`, `subscriptions.js`, `support.js`, `tenant.js`) ; `.gitignore` | dossier `schema/` ne contient plus que du `.ts` |
| **Z-82** Inspecter `proxy.ts` et `src/proxy.ts` | `proxy.ts`, `src/proxy.ts` | comportement de routing documenté — **prérequis à Z-80** |
| **Z-83** Vérifier `src/app/billing/**` hors groupe `(clinic)` | `src/app/billing/**` | accès tenant vérifié sur les routes d'impression (signalé hors périmètre de l'audit) |

---

## 9. Tests

| Tâche | Fichiers exacts | Couvre |
|---|---|---|
| **T-1** Garde multi-tenant | **créer** `src/lib/multi-tenant.guard.test.ts` (déjà Z-4) | M1, M2 — échoue si une surface oublie la validation |
| **T-2** Arrondis financiers | **modifier** `src/lib/billing-math.test.ts` | FAC-B06, FAC-B15 — ajouter `lineTax(1, 42.5, 19) === 8.08`, `round2(2.135)`, cohérence `Σ lignes = total` |
| **T-3** Transitions de statut | **créer** `src/lib/actions/status-transitions.test.ts` | FAC-B21, FAC-B13, Z-29, Z-31 |
| **T-4** Verrous de concurrence | **créer** `src/lib/actions/locking.test.ts` | FAC-B03, FAC-B04, FAC-B05, Z-73 |
| **T-5** Règles de séance | **modifier** `src/lib/session-rules.test.ts` | FAC-B11, PAT-B27, Z-34 |
| **T-6** Alerte d'allergie | **créer** `src/lib/actions/prescription-safety.test.ts` | PAT-B11 (si Q5 positif) |
| **T-7** Validation des entrées | **créer** `src/lib/actions/validation.test.ts` | PAT-B09, PAT-B16, PAT-B18, FAC-B16, FAC-B17 |
| **T-8** Contrôle d'accès financier | **modifier** `src/lib/permissions.test.ts` | RAP-B01, SEC-B08, SEC-B09, FAC-B09 |

---

## Sécurité & edge cases à couvrir

**Multi-tenant**
- Tout accès par ID doit vérifier l'appartenance à la `clinicId` courante — **côté ressource, pas
  seulement côté session**.
- Le cookie `active_clinic_id` n'est **jamais** la preuve de l'accès : il doit être revalidé
  contre `clinic_membership` **à chaque utilisation**.
- `requireClinicAccess` doit tester `joinedAt` **et** `clinics.deletedAt`.

**Facturation**
- Aucune écriture de montant sans transaction.
- Les transitions de statut sont **explicites et testées** — jamais une valeur brute du client.
- Un `catch` ne doit **jamais** convertir une erreur en « succès », en `[]` ou en `null`.

**Concurrence**
- Toute règle métier critique est **doublement protégée** : application **et** base. Le cas de
  référence déjà correct dans le code : l'index partiel unique de la salle d'attente.
- `logAction` ne doit **jamais** se trouver dans un `try` dont le `catch` signale un échec
  utilisateur.

**Fuseau horaire**
- **Toujours UTC en base**, conversion locale à l'affichage.
- Interdire `setHours`, `toISOString().split("T")[0]` et `new Date(string)` non validé :
  imposer `getClinicDateString` / `offsetMinutesForTz`.

---

## Ordre d'exécution (séquentiel)

```
LOT 1 — Correctifs structurels     [BLOQUANT pour tout le reste]
  Z-1 requireCurrentClinic → Z-2 requireOwnedPatient → Z-3 joinedAt
  → Z-4 test anti-réintroduction → Z-5 JOIN clinicId

LOT 2 — Sécurité critique
  Z-6 export → Z-7 passwordHash → Z-8 abilities → Z-9 uploads
  → Z-10 tokenVersion → Z-11 brute-force → Z-12 ILIKE → Z-13 cookie
  → Z-14 cron → Z-15 reset → Z-16 deletedAt

LOT 3 — Facturation & séances
  Z-17 round2 ⟵ Q2 → Z-18 taxRate → Z-19/20 transactions → Z-21/22/23 verrous
  → Z-24 bornes → Z-25 encours → Z-26 paiement → Z-27/28 séance
  → Z-29/31 transitions ⟵ Q4 → Z-30 séquence → Z-32 erreurs → Z-33 traçabilité → Z-34

LOT 4 — Patients & dossier clinique
  Z-35 items → Z-36/37 validation → Z-38 unicité → Z-39/40 garde-fous
  → Z-41/42 odontogramme & dents → Z-43 auteurs → Z-44/45 ordonnances
  → Z-46/47 quota & archivage → Z-48/49/50 prothèses → Z-51 allergie ⟵ Q5 → Z-52

LOT 5 — Agenda, salle d'attente, stock
  Z-53 fuseau → Z-54 patient RDV → Z-55/56/57/58 file → Z-59 ⟵ Q6
  → Z-60/61/62 stock → Z-63 contrainte de plage

LOT 6 — Rapports & notifications
  Z-64 permission → Z-65 revenus → Z-66 fuseau → Z-67 occupation
  → Z-68/69/70 notifications

LOT 7 — Fiabilité transverse
  Z-71 → Z-72 → Z-73 → Z-74 → Z-75 → Z-76 → Z-77 → Z-78 → Z-79
  → Z-82 proxy → Z-80 emailVerified (après Z-82)

LOT 8 — Propreté & reconnaissance
  Z-81 artefacts .js → Z-82 proxy (déplacé ici si besoin) → Z-83 billing/

LOT 9 — Tests
  T-1 … T-8

LOT 10 (optionnel) — P2
  Les 63 bugs P2 restants, après validation du client sur Q1
```

> **Principe de livraison** : chaque lot se termine par une application **pleinement
> fonctionnelle**. Aucune dépendance ne pointe vers l'arrière : le Lot 1 crée des helpers que
> les lots suivants **utilisent**, jamais l'inverse.

---

## Validation finale

1. Revue **Reviewer** après **chaque** tâche — sans exception, y compris les migrations SQL.
2. Tests **Vitest** (`npm test`) à chaque lot ; `npm run typecheck` et `npm run lint` obligatoires
   avant tout commit de fin de lot.
3. Recette **Tester** en fin de **Lot 1** (multi-tenant), **Lot 3** (facturation) et
   **Lot 5** (agenda/stock).
4. Recette manuelle sur **2 cliniques de test distinctes** :
   - un `patientId` d'une clinique B injecté depuis la clinique A → **refusé partout**
   - une invitation non acceptée → **aucun accès**
   - `getMonthlyTrends` en rôle `viewer` → **zéros**
   - création de facture avec coupure réseau entre l'insert facture et l'insert lignes →
     **aucune facture orpheline**
   - `lineTax(1, 42.5, 19)` → **8.08**
   - deux créations de RDV simultanées sur le même créneau → **une seule acceptée en base**
5. **Sign-off client** sur Q1 à Q6 avant d'engager les lots concernés (Q2 bloque le Lot 3).
