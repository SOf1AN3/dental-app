# PLAN.md — Refonte visuelle moderne de DentalCare

> **Statut** : EN ATTENTE DE VALIDATION — aucun code applicatif modifié.
> **Date de rédaction** : 2026-10-12
> **Périmètre** : design system, layout, composants UI, refonte visuelle.
> **Note** : le plan précédent (stabilisation des 108 bugs) a été écrasé à la demande
> du client. Il reste intégralement récupérable dans l'historique Git de `PLAN.md`.

---

## Contexte & besoin métier

**DentalCare** est une plateforme multi-cliniques de gestion de cabinet dentaire
(57 routes App Router, 3 espaces : landing, clinic, owner). L'application a été
livrée fonctionnellement mais **sans design system appliqué** : deux systèmes
coexistent, le plus rigoureux (shadcn/ui) étant installé mais quasi jamais utilisé.

Un audit complet a été mené le 2026-10-12 sur la base de :
- 15 captures d'écran (light / dark / mobile / landing / auth / clinic / owner)
- la lecture de `globals.css`, des 3 layouts, des composants `ui/` et `clinic/`
- l'inspection du runtime (styles calculés, règles CSS, console navigateur)
- un snapshot d'accessibilité et une recherche d'imports croisée

**Décisions client (2026-10-12)** :
| Question | Réponse |
|---|---|
| Ampleur | **Refonte visuelle moderne** (consolidation + nouvelle direction visuelle) |
| Cibles d'affichage | **Desktop + tablette** en priorité ; mobile ne doit plus être cassé |
| Plan | **Écraser `PLAN.md`** |

### Résultat de l'audit — 4 bloquants, 7 incohérences structurelles, 10 défauts visuels

**BLOQUANTS**
- **B1** — Aucune responsive : sidebar fixe `w-64` + `ml-64` sans aucun breakpoint,
  pas de menu burger. En 390px la sidebar mange 250px. (`(clinic)/layout.tsx:92,129`)
- **B2** — Erreurs d'hydration React sur chaque page : `ThemeToggle` rend `Sun`
  côté client / `Moon` côté serveur. (`theme-toggle.tsx:15`)
- **B3** — Aucun état actif dans la sidebar : pas de `usePathname`, pas d'`aria-current`.
- **B4** — Boutons icône sans nom accessible (ThemeToggle, NotificationBell, UserMenu).

**STRUCTURELS**
- **I1** — shadcn/ui installé mais ignoré : `ui/button`, `ui/card`, `ui/input`,
  `ui/badge`, `ui/table`, `ui/dialog` ne sont importés que par d'autres fichiers `ui/`.
  Seuls `dropdown-menu` et `combobox` sont réellement utilisés.
- **I2** — `font-heading` est une classe morte : référencée dans `card/dialog/sheet`
  mais `--font-heading` n'est définie nulle part (vérifié runtime : règle inexistante).
- **I3** — Deux palettes concurrentes : tokens shadcn oklch (`--primary`) + couleurs
  hex custom (`--color-primary`). `--primary` est du code mort.
- **I4** — Rayons excessifs et mixtes : `--radius-xl: 1.5rem` → cards à 24px,
  boutons 16px, badges `rounded-4xl` (mesuré en runtime).
- **I5** — 8 composants de badge de statut ; `shared/status-badge.tsx` affiche le
  raw enum anglais (`in_progress`, `no_show`) non traduit.
- **I6** — `<table className="w-full text-sm">` copié ~24 fois ; `shared/data-table.tsx`
  n'est importé nulle part. Idem `ui/input` vs `<input>` brut.
- **I7** — Sidebar owner dupliquée avec divergences arbitraires (`w-56` vs `w-64`,
  absence de header et de footer utilisateur).

**VISUELS / UX**
- **V1** — StatCards : les 4 cartes ont la même icône `LayoutDashboard`.
- **V2** — Contrastes sous le seuil AA : `text-cool-500` ≈ 3:1, `cerulean` texte ≈ 3.5:1.
- **V3** — Bordures cards quasi invisibles (`cool-100` #eef0f4 sur #f8f9fb).
- **V4** — Hiérarchie dashboard inversée : « Agenda du jour » (vide) au-dessus des KPI.
- **V5** — Doublon de recherche : champ header + champ page Patients côte à côte.
- **V6** — Empty states hétérogènes, sans composant partagé ni CTA.
- **V7** — Boutons texte `+ Nouveau patient` au lieu d'icônes lucide.
- **V8** — Aucun `loading.tsx` sur les 57 routes.
- **V9** — `next-intl` en dépendance mais jamais importé (dette).
- **V10** — L'espace owner n'a pas la même identité que l'espace clinic.

---

## Direction visuelle retenue

**Principe : « clinical precision ».** Sur des données de santé affichées toute la
journée, la densité et la lisibilité priment sur l'effet. On resserre, on unifie,
on rend la hiérarchie lisible d'un coup d'œil — sans effet de mode jetable.

| Axe | Avant | Après |
|---|---|---|
| Rayons | 24px cards / 16px boutons / `4xl` badges | Échelle unique : 8 / 12 / 16px (`--radius-*`) |
| Bordures | `cool-100` #eef0f4 → **1.14:1**, invisible | `--border` visible (1.66:1 light / 2.55:1 dark) |
| Typo | Inter mono-fonte, `font-heading` mort | Échelle `h1→h4` + `font-heading` réellement définie |
| Couleurs | 2 palettes (oklch + hex), 4 teintes sous AA | 1 palette, **toutes les valeurs ≥ 4.5:1** |
| Sidebar | Fixe, aucun état actif | État actif, groupes, icônes, compact tablette |
| Cards | Même icône partout | Icône + teinte sémantique par métrique |
| Tables | 24 copiers-collés | `DataTable` unique piloté |
| Badges | 8 fichiers, couleur pleine sur fond 10% | 1 `StatusBadge` unifié traduit, **fond pâle + texte foncé** |

### Palette — décisions validées le 2026-10-12

**Direction** : *navy conservé, sémantique corrigée*. L'identité `#1e2a5a` reste
(sidebar, boutons, logo) — son contraste est excellent (13.69:1) et elle est déjà
installée. On ne touche **qu'aux teintes fonctionnelles**, qui échouent aujourd'hui.

**Justification mesurée des remplacements** (ratios WCAG, seuil AA = 4.5:1) :

| Rôle | Actuel | Ratio | Nouveau | Ratio |
|---|---|---|---|---|
| Marque / boutons | `#1e2a5a` | 13.69:1 ✓ | `#1e2a5a` **inchangé** | 13.69:1 |
| Marque (dark) | `#4a5fa8` | 6.01:1 ✓ | `#4a5fa8` **inchangé** | 6.01:1 |
| Lien / focus | `cerulean #0088cc` | 3.89:1 ⚠️ | `#0369a1` (dark `#60a5fa`) | 5.93 / 6.04:1 ✓ |
| Succès / Payé | `mint #10b981` | **2.54:1 ✗** | `#047857` (dark `#34d399`) | 5.48 / 7.98:1 ✓ |
| En cours | `teal #0d9488` | 3.74:1 ⚠️ | `#0f766e` (dark `#5eead4`) | 5.47:1 ✓ |
| En attente | `amber #f59e0b` | **2.15:1 ✗** | `#b45309` (dark `#fbbf24`) | 5.02 / 9.19:1 ✓ |
| Danger | `danger #ef4444` | 3.76:1 ⚠️ | `#dc2626` (dark `#f87171`) | 4.83 / 5.55:1 ✓ |
| Texte secondaire | `cool-500 #858b9e` | 3.22:1 ⚠️ | `#64748b` (dark `#94a3b8`) | 4.76 / 5.99:1 ✓ |
| Placeholder | `cool-400 #a5abbc` | **2.18:1 ✗** | `#6b7280` | ≥ 4.5:1 ✓ |
| Bordure card | `cool-100 #eef0f4` | **1.14:1 ✗** | `#c3c9d6` (dark `#5f636d`) | 1.66 / 2.55:1 ✓ |

**Décisions explicites** :
- **Fusion `mint` → une seule famille « succès »** : deux verts quasi identiques
  (#10b981 / #0d9488) servaient des statuts distincts — source d'erreur silencieuse
  sur un statut de facture.
- **Badges : fond pâle + texte foncé** (validé). Plus de couleur pleine à 10 %.

**Spécification des badges (valeurs retenues, toutes ≥ 4.9:1)** :

| Statut | Fond light | Texte light | Fond dark | Texte dark |
|---|---|---|---|---|
| Succès / Payé | `#ecfdf5` | `#047857` | `#065f46` | `#6ee7b7` |
| En cours | `#f0fdfa` | `#0f766e` | `#115e59` | `#5eead4` |
| En attente | `#fffbeb` | `#b45309` | `#92400e` | `#fcd34d` |
| Danger / Annulé | `#fef2f2` | `#b91c1c` | `#7f1d1d` | `#fca5a5` |
| Info / Planifié | `#eff6ff` | `#1d4ed8` | `#1e3a8a` | `#93c5fd` |
| Neutre / Brouillon | `#f1f5f9` | `#475569` | `#334155` | `#cbd5e1` |

> Les fonds dark sont choisis pour rester **séparés du card** (1.63–2.38:1) tout en
> gardant le texte à ≥ 4.9:1 — un fond dark trop proche du card rendrait le badge
> invisible, c'est le piège classique qu'on évite ici.

### Fond du thème dark — décision du 2026-10-12

**Demande client** : *« plus foncé, mais pas noir »*.

| | Actuel | Retenu | Noir pur |
|---|---|---|---|
| Page | `#1a1b1e` (lum 0.0110) | **`#121419`** (lum 0.0070) | `#000000` (0.0000) |
| Card | `#232529` (lum 0.0184) | **`#1b1d22`** (lum 0.0123) | `#141414` |

→ **36 % de luminance en moins**, sans jamais atteindre le noir. La teinte reste
légèrement bleutée (r>b), ce qui conserve la cohérence avec le navy de marque.

**Validation AA sur les fonds retenus** :
- Textes : `#f1f5f9` 15.39:1 · `#cbd5e1` 11.36:1 · `#94a3b8` (labels) 6.58:1 ✓
- Accents : bleu `#60a5fa` 6.63:1 · vert `#34d399` 8.77:1 · ambre `#fbbf24` 10.10:1 · rouge `#f87171` 6.10:1 ✓
- Bouton : blanc sur `#4a5fa8` → 6.01:1 ✓
- Séparation page/card : 1.09:1 — volontairement subtile ; **la bordure porte la
  démarcation**, pas le contraste de fond.

**Bordures (WCAG 1.4.11 = 3:1 pour les contrôles)** :

| Rôle | Light | Ratio | Dark | Ratio |
|---|---|---|---|---|
| Bordure **input** (contrôle) | `#7f8798` | 3.61:1 ✓ | `#6b6f7a` | 3.43:1 ✓ |
| Bordure **card** (décorative) | `#c3c9d6` | 1.66:1 | `#6b6f7a` | 3.36:1 |
| Focus ring | `#0369a1` | 5.93:1 ✓ | `#60a5fa` | 6.63:1 ✓ |

> **Piège du navy conservé** : `--color-primary` sert à la fois de **fond de bouton**
> (texte blanc par-dessus) et d'**accent texte**. En light `#1e2a5a` fait les deux
> (13.69:1) ; en dark `#4a5fa8` aussi (6.01:1). Aucun ajustement requis — mais tout
> futur changement de teinte de marque doit revérifier les **deux** usages : éclaircir
> pour le texte casse le bouton, et l'inverse.

---

## Questions / décisions en attente

Aucune. Les 6 arbitrages ont été tranchés : ampleur (refonte visuelle), cibles
(desktop + tablette), fichier de plan (`PLAN.md` écrasé), palette (navy conservé,
sémantique corrigée), badges (fond pâle + texte foncé), fond dark (`#121419`,
plus foncé sans être noir).

---

## 1. Base de données (DB)

**Aucune tâche.** La refonte est 100 % présentation : aucun schéma, aucune
migration, aucun Server Action ne change.

---

## 2. Fondations du design system

> Toutes les tâches suivantes en dépendent. À exécuter en premier, strictement séquentiel.

### 2.1 — Refonte des tokens CSS
**Fichier** : `src/app/globals.css`
**Dépendances** : aucune.
**Valeurs exactes** : voir la section *« Palette — décisions validées »* plus haut.
Aucune valeur n'est à deviner : chaque hex est fourni avec son ratio mesuré.

- [ ] Définir l'échelle de rayons unique : `--radius-sm: 6px`, `--radius-md: 10px`,
      `--radius-lg: 14px`, `--radius-xl: 16px` (remplace `1.5rem`).
- [ ] Définir `--font-heading` dans `@theme` (résout **I2**) — réutiliser Inter avec
      un `font-feature-settings` différent, ou ajouter une 2e famille via `next/font`.
- [ ] Supprimer `--primary` oklch mort et faire piloter `--color-primary` par une
      seule source (résout **I3**) ; garder les hex comme valeurs internes.
- [ ] Appliquer la palette : `cerulean → #0369a1`, `mint` fusionné dans la famille
      succès `#047857`, `teal → #0f766e`, `amber → #b45309`, `danger → #dc2626`,
      `cool-500 → #64748b`, `cool-400 → #6b7280`.
- [ ] Bordures distinctes selon le rôle : **input** `#7f8798` (3.61:1, WCAG 1.4.11)
      vs **card** `#c3c9d6` (1.66:1, décoratif). Aujourd'hui les deux sont `cool-100`.
- [ ] **Fond dark** : page `#121419`, card `#1b1d22`, input `#191b20`, bordure `#6b6f7a`.
      (décision client : *plus foncé, mais pas noir* — 36 % de luminance en moins)
- [ ] Reserrer la palette : vérifier que `cool-*`, `cerulean`, `mint`, `teal`,
      `amber`, `danger` sont tous utilisés — sinon supprimer les morts.
- [ ] Ajouter les tokens de contraste : `--color-muted-fg` remonte à ≥ 4.5:1 (résout **V2**).
- [ ] Vérifier chaque token en **dark** (le bloc `.dark` redéfinit `cool-*` en inversant
      l'échelle — s'assurer qu'aucune combinaison ne descend sous 4.5:1) (résout **V3**).

**Critère de fait** : `npm run build` vert ; contrôle runtime `--font-heading` non vide ;
`--primary` plus référencé nulle part ; **vérification des ratios par calcul sur les
valeurs effectivement écrites** (ne pas se fier au tableau, le recalculer).

### 2.2 — Correction du ThemeToggle (hydration)
**Fichier** : `src/components/clinic/theme-toggle.tsx`
**Dépendances** : 2.1.

- [ ] Rendre l'icône déterministe : gate `mounted` (`useState` + `useEffect`) ou
      `suppressHydrationWarning` sur le nœud d'icône. (résout **B2**)
- [ ] Ajouter `aria-label` dynamique « Passer en thème clair/sombre » (résout **B4**).

**Critère de fait** : console navigateur sans erreur d'hydration sur 5 pages.

### 2.3 — Composant `PageHeader` unifié
**Fichier à créer** : `src/components/ui/page-header.tsx`
**Dépendances** : 2.1.

- [ ] Props : `title`, `description?`, `actions?` (slot droite), `breadcrumb?`.
- [ ] Applique l'échelle typo de 2.1 sur le `h1` (remplace les **58 occurrences** de
      `text-2xl font-bold text-cool-900`).
- [ ] Wrap mobile : `flex-col gap-3 sm:flex-row sm:items-center sm:justify-between`.

**Critère de fait** : composant exporté, typé, sans aucune page migrée encore.

### 2.4 — Composant `EmptyState` unifié
**Fichier à créer** : `src/components/ui/empty-state.tsx`
**Dépendances** : 2.1.

- [ ] Props : `icon`, `title`, `description?`, `action?` (CTA).
- [ ] Centralise les 6 formulations hétérogènes (résout **V6**).

**Critère de fait** : composant exporté, typé.

### 2.5 — Moteur de badges unifié
**Fichiers** : `src/components/shared/status-badge.tsx` (+ les 7 fichiers
`clinic/*-status-badge.tsx` à terme)
**Dépendances** : 2.1.

- [ ] Étendre `StatusBadge` : registre `status → { label FR, variant couleur }`.
- [ ] **Traduire** les labels (`in_progress` → « En cours », `no_show` → « Absent »)
      — résout **I5**.
- [ ] Props : `status`, `domain` (pour désambiguïser `paid` facture vs séance).
- [ ] L'ancien composant reste en place tant que la migration (tâche 5.x) n'est pas faite.

**Critère de fait** : le registre couvre tous les enums du schema (`grep` sur
`pgEnum` = couverture 100 %).

### 2.6 — Moteur de tableaux unifié
**Fichier** : `src/components/shared/data-table.tsx`
**Dépendances** : 2.1, 2.4.

- [ ] Colonnes typées, cellule vide → `—`, ligne action, variant `compact` tablette.
- [ ] Wrappe `overflow-x-auto` + `rounded-xl border bg-card` (résout **I6**).
- [ ] État vide par défaut rendu via `EmptyState` (résout **V6**).

**Critère de fait** : composant exporté ; prêt à recevoir les 24 tables.

---

## 3. Layouts & navigation

### 3.1 — Sidebar clinic : état actif, groupes, accessibilité
**Fichier** : `src/app/(clinic)/layout.tsx`
**Dépendances** : 2.1, 2.3.

- [ ] Extraire la sidebar en composant dédié
      `src/components/ui/sidebar.tsx` (réutilisable par l'owner — résout **I7**).
- [ ] État actif via `usePathname` : `aria-current="page"` + visuel distinct
      (fond + bordure gauche). (résout **B3**)
- [ ] Regrouper les 10 liens : *Pilotage* / *Clinique* / *Suivi* / *Réglages*.
- [ ] `label` sur chaque item pour le mode replié.

**Critère de fait** : navigation item visible comme actif sur les 10 routes ;
snapshot a11y contient `aria-current`.

### 3.2 — Barre latérale responsive (desktop + tablette)
**Fichier** : `src/app/(clinic)/layout.tsx` + `src/components/ui/sidebar.tsx`
**Dépendances** : 3.1.

- [ ] `≥1280px` : état déplié `w-64`.
- [ ] `768–1279px` : état **compact icônes seules** `w-16` (cible tablette retenue),
      contentant `ml-16`.
- [ ] `<768px` : drawer déplaçant (overlay + `Sheet`), bouton burger dans le header.
- [ ] Plus aucune valeur `w-64`/`ml-64` non conditionnée. (résout **B1**)

**Critère de fait** : captures à 1440 / 1024 / 768 / 390 px toutes lisibles.

### 3.3 — En-tête (header) unifié
**Fichier** : `src/app/(clinic)/layout.tsx`
**Dépendances** : 3.1, 3.2.

- [ ] Burger (visible `<1280px`), `SearchInput`, `ThemeToggle`, `NotificationBell`,
      `UserMenu`.
- [ ] **Retirer le doublon de recherche** : le champ header devient recherche globale
      avec résultats, et la page Patients garde son propre filtre local — ou inversement.
      Décision : garder le champ header, retirer celui de la page Patients.
      (résout **V5**)
- [ ] `aria-label` sur les 3 boutons icône. (résout **B4**)

**Critère de fait** : snapshot a11y → 0 bouton sans nom.

### 3.4 — Sidebar owner réalignée
**Fichier** : `src/app/owner/layout.tsx`
**Dépendances** : 3.1.

- [ ] Réutilise le composant `sidebar.tsx` de 3.1 (même largeur, même état actif,
      même footer utilisateur, même header). (résout **I7**, **V10**)
- [ ] Ajouter le badge « Admin » en tant que variante du composant, pas en dur.

**Critère de fait** : aucune duplication de markup de sidebar dans le repo.

### 3.5 — Shell `AppShell` responsive
**Fichier** : `src/app/(clinic)/layout.tsx` (+ `owner/layout.tsx`)
**Dépendances** : 3.2, 3.3.

- [ ] `main` : `p-4 sm:p-6 lg:p-8` (au lieu de `p-8` fixe) + `max-w-[1400px]`
      pour éviter les tables étirées sur grand écran.
- [ ] Vérifier `min-h-dvh` plutôt que `min-h-screen`.

**Critère de fait** : pas de contenu débordant à 768px.

---

## 4. Composants d'interface

### 4.1 — Button / Input / Card : passer à shadcn réellement
**Fichiers** : `src/components/ui/button.tsx`, `ui/input.tsx`, `ui/card.tsx`
**Dépendances** : 2.1.

- [ ] `button.tsx` : harmoniser les `size` avec la nouvelle échelle de rayons (résout **I4**).
- [ ] Ajouter variante `icon-button` avec `aria-label` obligatoire au typage.
- [ ] `card.tsx` : bordure sémantique `border` (résout **V3**), padding resserré.
- [ ] `input.tsx` : s'assurer que les styles de focus sont cohérents partout.

**Critère de fait** : le build reste vert, les 3 composants sont utilisés par la suite.

### 4.2 — StatCards : icône + teinte par métrique
**Fichier** : `src/components/clinic/dashboard/stat-cards.tsx`
**Dépendances** : 2.1, 4.1.

- [ ] `StatCardData` gagne `icon: LucideIcon` (résout **V1**).
- [ ] Les 3 dashboards (`owner/dentist/reception-dashboard.tsx`) passent l'icône adéquate.
- [ ] Déplacer le `p.text-2xl` sur une vraie valeur de la typo (2.1).

**Critère de fait** : les 4 cartes sont distinguished sans lire le libellé.

### 4.3 — Réordonner le dashboard
**Fichiers** : `dashboard/owner-dashboard.tsx`, `dentist-dashboard.tsx`,
`reception-dashboard.tsx`
**Dépendances** : 4.2.

- [ ] Ordre : **KPI → Agenda du jour → graphiques → taux d'occupation**.
      (résout **V4**)

**Critère de fait** : les KPI sont le premier bloc après le `PageHeader`.

### 4.4 — Views & toggles
**Fichiers** : `clinic/view-toggle.tsx`, `clinic/search-input.tsx`
**Dépendances** : 2.1, 4.1.

- [ ] `ViewToggle` : piloter par les tokens (plus de `bg-white` / `dark:bg-cool-300` en dur).
- [ ] `SearchInput` : passer à `ui/input`, `aria-label="Rechercher un patient"`.

**Critère de fait** : aucun `bg-white` hors composants shadcn.

### 4.5 — Landing page
**Fichier** : `src/app/page.tsx`
**Dépendances** : 2.1, 2.3, 2.4.

- [ ] Aligner sur les tokens (rayons, bordures, typo) — la structure est bonne.
- [ ] Vérifier le rendu dark (le thème est persisté, la landing doit suivre).
- [ ] Boutons CTA en `Button` plutôt qu'en classes en dur.

**Critère de fait** : captures light + dark cohérentes avec l'app.

### 4.6 — Pages auth
**Fichiers** : `src/app/(auth)/layout.tsx`, `login/page.tsx`, `register/page.tsx`,
`forgot-password/page.tsx`, `reset-password/page.tsx`, `verify-email/page.tsx`
**Dépendances** : 2.1, 4.1.

- [ ] Utiliser `Card` + `Input` + `Button` (le layout a déjà la structure).
- [ ] Uniformiser le traitement du titre de marque.

**Critère de fait** : plus aucune classe `bg-white dark:bg-cool-100` en dur.

---

## 5. Migration des pages (par lot, séquentiel)

> Chaque lot = une tâche = un `git diff` = une revue. Ne jamais migrer deux lots d'un coup.
> **Dépendances communes** : tout le §2 + §3 + §4 livrés.

### 5.1 — Lot *Patients*
`patients/page.tsx`, `patients/new/page.tsx`, `patients/[id]/page.tsx`,
`patients/[id]/edit`, `sessions`, `prescriptions`, `consultation-notes`,
`medical-history`, `radiographs`, `dental-chart`, `treatment-plan/*`, `session/*`
- [ ] `PageHeader` + `DataTable` + `EmptyState` + `StatusBadge` unifié
- [ ] Retirer le champ de recherche doublon (V5)

### 5.2 — Lot *Rendez-vous*
`appointments/page.tsx`, `appointments/agenda/page.tsx`, `appointments/new`,
`appointments/[id]/edit`, `waiting-room/page.tsx`
- [ ] Même traitement ; agenda : vérifier le contraste des créneaux en dark

### 5.3 — Lot *Facturation*
`billing/page.tsx`, `billing/invoices/*`, `billing/quotes/*`, `billing/payments/new`
- [ ] Même traitement ; harmoniser les 3 boutons d'action en `Button` icône (V7)

### 5.4 — Lot *Clinique courante*
`prescriptions/*`, `stock/*`, `prostheses/*`, `treatments/page.tsx`, `reports/page.tsx`
- [ ] Même traitement

### 5.5 — Lot *Paramètres*
`settings/layout.tsx` + les 7 sous-routes
- [ ] Même traitement ; tabs via tokens

### 5.6 — Lot *Owner*
`owner/layout.tsx` + les 8 pages
- [ ] Même traitement, une fois 3.4 livré

**Critère de fait global §5** : `grep` ne retrouve plus ni
`text-2xl font-bold text-cool-900`, ni `<table className="w-full text-sm">`,
ni `<h1 className=` manuel dans `src/app`.

---

## 6. États de chargement

### 6.1 — `loading.tsx` sur les routes principales
**Fichiers** : `src/app/(clinic)/loading.tsx`, `src/app/owner/loading.tsx`,
`src/app/loading.tsx`
**Dépendances** : 4.1.

- [ ] Squelettes cohérents avec `PageHeader` + grille de cards. (résout **V8**)

**Critère de fait** : navigation fluide sans flash vide.

---

## 7. Dette à purger

### 7.1 — Dépendances inutilisées
**Fichier** : `package.json`
**Dépendances** : dernière tâche.

- [ ] `next-intl` jamais importé → retirer (résout **V9**).
- [ ] Vérifier `@tanstack/react-table`, `react-day-picker`, `xlsx`, `recharts`,
      `@base-ui/react`, `zustand` : chacun a au moins un import réel, sinon retirer.

**Critère de fait** : `npm run build` + `npm run typecheck` verts.

---

## Sécurité & edge cases à couvrir

| Domaine | Point de vigilance |
|---|---|
| **Accessibilité** | `aria-label` sur tous les boutons icône ; `aria-current` sur la nav ; contraste ≥ 4.5:1 vérifié **en dark mode aussi** (les tokens `cool-*` sont inversés dans `.dark`) |
| **Hydration** | Aucun rendu dépendant de `localStorage`/`window` sans gate `mounted` — le bug `ThemeToggle` est le symptôme d'un motif à chercher ailleurs (`NotificationBell`, `UserMenu`) |
| **Responsive** | Aucune régression : les captures desktop existantes doivent rester identiques en structure. Test 768px obligatoire sur chaque lot (target tablette) |
| **Données de santé** | La refonte ne touche **aucun** Server Action, **aucun** guard `multi-tenant`, **aucun** formulaire de données cliniques. Si une tâche nécessite de modifier un formulaire, elle est à part et relit le diff en priorité |
| **Impression A5** | `a5-prescription.tsx`, `a5-financial-document.tsx` utilisent leurs propres styles `@media print` — **hors périmètre**, ne pas harmoniser au risque de casser l'impression |
| **i18n** | L'app est en français uniquement. Les labels de badge doivent être en FR. Ne pas introduire de dépendance i18n |
| **Thème** | `enableSystem={false}` + `defaultTheme="light"` : vérifier que la refonte ne casse pas la persistance (`localStorage.theme`) |
| **Edge cases vides** | Chaque `EmptyState` doit être visible sur : 0 patient, 0 RDV, 0 facture, salle d'attente vide, 0 ordonnance — c'est le cas de figure de la base de dev actuelle, idéal pour la recette |

---

## Ordre d'exécution (séquentiel — une tâche = une invocation = une revue)

| # | Tâche | Agent | Revue |
|---|---|---|---|
| 1 | 2.1 Tokens CSS | Frontend | Reviewer |
| 2 | 2.2 ThemeToggle hydration | Frontend | Reviewer |
| 3 | 2.3 `PageHeader` | Frontend | Reviewer |
| 4 | 2.4 `EmptyState` | Frontend | Reviewer |
| 5 | 2.5 `StatusBadge` unifié | Frontend | Reviewer |
| 6 | 2.6 `DataTable` unifié | Frontend | Reviewer |
| 7 | 4.1 Button/Input/Card | Frontend | Reviewer |
| 8 | 3.1 Sidebar état actif | Frontend | Reviewer |
| 9 | 3.2 Sidebar responsive | Frontend | Reviewer |
| 10 | 3.3 Header unifié | Frontend | Reviewer |
| 11 | 3.4 Sidebar owner | Frontend | Reviewer |
| 12 | 3.5 AppShell | Frontend | Reviewer |
| 13 | 4.2 StatCards icônes | Frontend | Reviewer |
| 14 | 4.3 Réordonnancement dashboard | Frontend | Reviewer |
| 15 | 4.4 ViewToggle / SearchInput | Frontend | Reviewer |
| 16 | 4.5 Landing page | Frontend | Reviewer |
| 17 | 4.6 Pages auth | Frontend | Reviewer |
| 18 | 5.1 Lot Patients | Frontend | Reviewer |
| 19 | 5.2 Lot Rendez-vous | Frontend | Reviewer |
| 20 | 5.3 Lot Facturation | Frontend | Reviewer |
| 21 | 5.4 Lot Clinique courante | Frontend | Reviewer |
| 22 | 5.5 Lot Paramètres | Frontend | Reviewer |
| 23 | 5.6 Lot Owner | Frontend | Reviewer |
| 24 | 6.1 `loading.tsx` | Frontend | Reviewer |
| 25 | 7.1 Dette `package.json` | Backend | Reviewer |

**Micro-commit obligatoire** après chaque APPROUVE, format
`feat(ui): <description>` / `refactor(ui): …`, **jamais de push**.

---

## Validation finale (Reviewer → Tester)

1. **Reviewer** — après chaque tâche, sur le `git diff` isolé de cette tâche :
   typage strict, aucune classe hors tokens, aucune règle d'a11y oubliée,
   aucune modification de Server Action ou de garde multi-tenant.
2. **Typecheck & build** — `npm run typecheck` + `npm run build` à la fin de
   chaque lot (§5), pas seulement en fin de plan.
3. **Tester (E2E)** — en fin de plan complet, sur demande du Lead :
   - connexion → dashboard → patients → création patient → RDV → facturation
   - bascule light/dark sans erreur console
   - rendu 1440 / 1024 / 768 / 390 px
   - impression A5 ordonnance + facture (**non régression critique**)
4. **Recette visuelle** — comparer les nouvelles captures aux captures de l'audit
   (`audit/*.png`) pour confirmer que la structure n'a pas régressé.

---
