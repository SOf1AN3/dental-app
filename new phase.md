

## PHASE 0 — Bugs bloquants

### FACT-5 — Corriger le calcul de taxe 🐞 P0
**Objectif :** la TVA s'applique correctement sur les lignes de facture et de devis.
**Où regarder :** `invoice-form` + `invoice-line-items`, `quote-form` +
`quote-line-items`, actions de facturation dans `src/lib/actions/`, colonnes `tax_rate`
(entier, %) et totaux (`subtotal`, `tax_total`, `discount_total`, `total`).
**À faire :**
- Reproduire le bug : créer une facture avec une ligne à TVA 19 % et vérifier les totaux.
- Corriger le calcul : `total_ligne = qty × prix_unitaire × (1 + tax_rate/100) − remise`
  (ou la formule métier choisie — la documenter), et faire remonter `tax_total` au document.
- Vérifier la cohérence avec les lignes de séance (`clinical_session_item.tax_rate`).
**Critères d'acceptation :**
- Sous-total, TVA, remise et total exacts sur facture ET devis, affichage DZD correct.
- Tests Vitest ajoutés/mis à jour pour le calcul.

### FACT-6 — Corriger « Nouveau paiement » depuis la facture 🐞 P0
**Objectif :** enregistrer un paiement depuis la page détail d'une facture sans erreur.
**Où regarder :** page détail facture `/billing/invoices/[id]` (le bouton pointe vers
`/billing/payments/new`, lien mort), formulaire existant `payment-form` (utilisé dans
`session-invoice.tsx`), règle de recalcul de statut (§10.2 de specs.md).
**À faire :**
- Réutiliser le `PaymentForm` existant : soit créer la page `/billing/payments/new`
  (avec `?invoiceId=` pré-rempli), soit ouvrir le formulaire en inline/dialog sur la
  facture. Choisir l'option la plus cohérente avec le code actuel.
- Après enregistrement : recalculer le statut (`paid` si Σ paiements ≥ total,
  `partially_paid` si > 0), `revalidatePath`, audit.
**Critères d'acceptation :**
- Aucun lien mort ; paiement enregistré depuis la facture ; statut mis à jour.
- Test unitaire sur la règle de recalcul de statut.

---

## PHASE 1 — Socle permissions (rôles)

### PAR-1 — Appliquer la matrice des rôles 🔐 P1
**Objectif :** une source unique de vérité pour « qui voit / peut faire quoi ».
**Où regarder :** `requireClinicAccess` (retourne `{ user, membership }`), la navigation
(sidebar), les actions sensibles.
**À faire :**
- Créer un module de permissions (ex. `src/lib/permissions.ts`) : matrice rôle → capacités
  (voir rapports, voir revenus globaux, gérer membres, etc.).
- L'appliquer côté serveur (actions + pages) ET côté navigation (masquer les entrées
  interdites). Jamais de masquage uniquement côté client.
**Critères d'acceptation :**
- Matrice documentée dans le code ; tests Vitest sur la matrice.
- Aucune action/page protégée accessible à un rôle non autorisé.

### DB-1 — Widget agenda multi-dentistes ✨ P1
**Objectif :** le widget principal du dashboard est l'agenda du jour de **tous les
dentistes** (une colonne ou couleur par dentiste).
**Où regarder :** dashboard `/` (`src/app/(clinic)/page.tsx`), agenda hebdo
`/appointments/agenda` + `agenda-nav`, actions `getAppointmentStats`.
**Dépend de :** PAR-1.

### DB-2 / DB-3 / DB-4 — Dashboards par rôle ✨ P1
**Objectif :** contenu du tableau de bord adapté au rôle connecté.
- **Réceptionniste (DB-2) :** agenda tous dentistes, bouton « Nouveau patient », factures
  impayées, dernières ordonnances, nb de RDV du jour, nb en salle d'attente.
- **Dentiste (DB-3) :** agenda de **ses** RDV uniquement, nb de ses RDV, **son** chiffre
  d'affaires, récapitulatif de son activité des semaines/mois précédents en bas de page.
- **Admin/owner (DB-4) :** agenda tous dentistes en principal, nb patients, nb RDV, nb en
  salle d'attente, revenu global journalier + historique.
**Où regarder :** actions `reports` existantes (`getPatientStats`, `getRevenueData`…) à
étendre avec un filtre `dentistId` ; `clinic_membership.role` pour l'aiguillage.
**Critères d'acceptation :**
- Un dentiste ne voit **jamais** les revenus globaux ni ceux d'un confrère.
- Chargement rapide : requêtes agrégées, pas de N+1.

### RAP-1 — Rapports réservés à l'admin 🔐 P1
**Objectif :** `/reports` visible uniquement par `owner`. Réceptionnistes et dentistes :
accès à leur historique uniquement, pas de rapports globaux ni de revenus globaux.
**Où regarder :** page `/reports`, entrée de navigation, matrice PAR-1.
**Critères d'acceptation :** accès direct par URL refusé (redirect + message) pour les
rôles non autorisés ; entrée de menu masquée.

---

## PHASE 2 — Facturation

### FACT-1 — Conversion devis → facture pré-remplie ✨ P1
**Objectif :** un bouton « Convertir en facture » sur un devis accepté génère une facture
pré-remplie (patient, lignes, montants) avec numérotation `FAC-YYYY-#####` atomique.
**Où regarder :** actions quotes/invoices, `document_sequence`, statuts devis
(`accepted`), page détail devis.
**Critères d'acceptation :** la facture créée reprend toutes les lignes du devis ; le
devis garde la trace de la conversion ; opération auditée.

### FACT-2 — Boutons « Nouveau devis » et « Enregistrer un paiement » 🎨 P1
**Objectif :** ces deux actions sont visibles depuis le hub `/billing` et les listes.
**Où regarder :** widget `/billing`, listes invoices/quotes.

### FACT-7 — Impression factures et devis ✨ P1
**Objectif :** bouton « Imprimer » sur facture et devis, avec en-tête clinique (logo,
coordonnées, mentions légales) — même pattern que l'ordonnance A5.
**Où regarder :** `a5-prescription.tsx`, `a5-styles`, `print-toolbar`,
`settings/documents` (logo/en-tête/filigrane).
**Critères d'acceptation :** impression propre au format navigateur, sans sidebar ni
topbar ; totaux identiques à l'écran.

---

## PHASE 3 — Confort / UX

### UX-1 — Bouton « Retour » partout 🎨 P2
Composant retour réutilisable sur tous les écrans de détail/formulaire (patients,
facturation, etc.). Aucun parcours ne doit exiger le bouton du navigateur.

### RDV-1 — Vue agenda par défaut 🎨 P2
`/appointments` ouvre directement la vue agenda (semaine) ; la liste par jour reste
accessible. Mémoriser le dernier choix de vue si simple à faire.

### SA-1 — Admission d'urgence ✨ P2
Bouton « Admission d'urgence » dans `/waiting-room` : proposer « créer un nouveau
patient » ou « choisir un patient existant », puis ajouter directement en salle
d'attente (sans rendez-vous — `appointment_id` nullable existe déjà).
**Attention :** respecter la règle d'unicité (une seule entrée active par patient).

### FACT-3 — Envoi de facture optionnel 🎨 P2
Permettre `brouillon → payée` sans passer par « envoyée » (transition manuelle autorisée,
message clair).

### FACT-4 — Redirection après création de facture 🎨 P2
Après création, rediriger vers la page de la facture (pas la liste) pour enchaîner sur
l'enregistrement d'un paiement.

### ORD-1 — Articles d'ordonnance sur deux lignes 🎨 P2
Dans `prescription-line-items` : chaque article sur deux lignes (lisibilité + saisie) ;
**supprimer le champ type** (`medication`/`care`) de l'UI. Décider côté schéma : garder
la colonne avec valeur par défaut ou la retirer — documenter le choix.

### ORD-2 — Aperçu ordonnance responsive 🎨 P2
Sur écran étroit, l'aperçu A5 passe **sous** le formulaire (layout en colonne) au lieu
d'être à côté.

### TRT-1 — Supprimer l'onglet « Traitements » 🎨 P2
Retirer `/treatments` de la navigation (les plans restent accessibles depuis le dossier
patient). Garder ou supprimer la route : documenter le choix.

### STO-1 — Boutons entrée/sortie par article 🎨 P2
Sur chaque ligne de `/stock` : boutons « Entrée » et « Sortie » ouvrant le formulaire de
mouvement pré-rempli avec l'article. Règles existantes inchangées (quantité jamais
négative, alerte stock bas).

### PAR-2 — Changement de mot de passe ✨ P2
Dans « Votre profil » (`profile-form`) : mot de passe actuel + nouveau + confirmation.
Vérifier l'ancien hash (bcrypt), exiger 6 caractères min, invalider la session si le
pattern NextAuth le permet — sinon documenter.

### PAR-3 — TVA paramétrable (défaut 19 %) ✨ P2
Champ « TVA (%) » dans les paramètres de la clinique, pré-rempli à 19, utilisé comme
valeur par défaut des nouvelles lignes de facture/devis. Cohérent avec le fix FACT-5.

---

## PHASE 4 — 

### PAR-4 — Modèles de factures/devis modifiables ✨ P3
Modèles d'impression pour factures et devis avec design modifiable (logo, en-tête,
couleurs, mentions légales), sur le principe du modèle d'ordonnance A5
(`A5TemplateSettings`). À spécifier plus en détail avant de démarrer.
