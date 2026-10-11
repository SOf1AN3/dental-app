--
-- Migration 0016 — changements de schéma en attente + normalisation des données
--
-- ⚠️ Cette migration est AUTO-RÉPARATRICE.
--
-- Elle pose des contraintes (index uniques, CHECK) qui ÉCHOUEAIENT si des
-- données préexistantes les violent. Or deux des bugs corrigés ont produit
-- exactement de telles données en production :
--   - Z-49 : le `catch {}` muet de la séquence réémisait PRO-YYYY-00001 dès
--     que la ligne de séquence était absente → commandes en double
--   - Z-61 : `currentQty` acceptait une valeur négative saisie par le client
--   - Z-62 : les alertes de stock n'étaient JAMAIS résolues → doublons actifs
--
-- Chaque bloc de normalisation précède donc la contrainte qu'il rend
-- applicable. Idempotent : rejouer la migration ne fait rien de plus.
--
-- En cas de doute, exécuter d'abord `npm run db:preflight` (lecture seule).
--

--> statement-breakpoint
-- 1. Révocation des sessions JWT (Z-10) — aucun impact sur les données.
ALTER TABLE "user" ADD COLUMN "token_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
--> statement-breakpoint
-- 2. Ordre de saisie des items d'ordonnance (Z-45) — colonne nullable.
ALTER TABLE "prescription_item" ADD COLUMN "order_index" integer;--> statement-breakpoint
--> statement-breakpoint
-- 3. Marquage des memberships directs comme acceptés (Z-3 / SEC-B02).
--
-- Un membership créé sans passer par `acceptInvitation()` n'a jamais de
-- `joined_at`, alors que tout contrôle d'accès l'exige désormais. On ne
-- touche PAS aux invitations réellement en attente (`invited_at` non nul) :
-- elles doivent rester refusées, c'est le correctif de sécurité.
UPDATE "clinic_membership"
SET "joined_at" = COALESCE("created_at", now())
WHERE "invited_at" IS NULL AND "joined_at" IS NULL;--> statement-breakpoint
--> statement-breakpoint
-- 4. Résolution des alertes de stock en doublon (Z-62) — AVANT l'index unique.
--
-- Le contrôle SELECT-then-INSERT n'était pas atomique : un même article peut
-- avoir plusieurs alertes actives. On garde la plus récente, les autres
-- passent en résolues — elles ne doivent pas être perdues, mais bloquer
-- l'index.
UPDATE "stock_alert" sa
SET "status" = 'resolved', "resolved_at" = now()
FROM (
  SELECT "id", ROW_NUMBER() OVER (
    PARTITION BY "item_id"
    ORDER BY "created_at" DESC, "id" DESC
  ) AS "rn"
  FROM "stock_alert"
  WHERE "status" = 'active'
) "ranked"
WHERE sa."id" = ranked."id" AND ranked."rn" > 1;--> statement-breakpoint
--> statement-breakpoint
-- 5. Dédoublonnage des numéros de commande prothèse (Z-49) — AVANT l'index unique.
--
-- Le bug de séquence produisait deux commandes portant le même numéro. On
-- conserve le numéro à la commande la plus récente, et on suffixe les
-- antérieures : AUCUNE ligne n'est supprimée, l'historique est préservé.
UPDATE "prosthesis_order" po
SET "order_number" = po."order_number" || '-' || "ranked"."rn"::text
FROM (
  SELECT "id", ROW_NUMBER() OVER (
    PARTITION BY "clinic_id", "order_number"
    ORDER BY "created_at" DESC, "id" DESC
  ) AS "rn"
  FROM "prosthesis_order"
) "ranked"
WHERE po."id" = ranked."id" AND ranked."rn" > 1;--> statement-breakpoint
--> statement-breakpoint
-- 6. Remise à zéro des stocks négatifs (Z-60) — AVANT le CHECK.
--
-- Une quantité négative est impossible métier : elle signifie que le registre
-- des mouvements et le stock courant divergent. On renvoie à zéro plutôt que
-- de supprimer l'article. Vérifier ensuite la cohérence avec `stock_transaction`.
UPDATE "stock_item"
SET "current_qty" = 0
WHERE "current_qty" < 0;--> statement-breakpoint
--> statement-breakpoint
-- 7. Contraintes.
CREATE UNIQUE INDEX "uq_stock_alerts_item_id_active" ON "stock_alert" USING btree ("item_id") WHERE status = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_prosthesis_orders_clinic_order_number" ON "prosthesis_order" USING btree ("clinic_id","order_number");--> statement-breakpoint
ALTER TABLE "stock_item" ADD CONSTRAINT "ck_stock_items_current_qty_non_negative" CHECK ("stock_item"."current_qty" >= 0);--> statement-breakpoint
--> statement-breakpoint
-- 8. Colonnes de la clinique — orphelines du journal (voir commit a5038d6).
--
-- Ces deux migrations manuelles existaient dans drizzle/ mais n'étaient pas
-- dans meta/_journal.json : le runner s'en basant sur le journal, elles
-- n'avaient JAMAIS été appliquées, alors que le snapshot Drizzle les
-- jugeait migrées et que le code les référence à 35 endroits.
ALTER TABLE "clinic" ADD COLUMN "default_tax_rate" integer DEFAULT 19 NOT NULL;--> statement-breakpoint
ALTER TABLE "clinic" ADD COLUMN "document_branding" jsonb;
