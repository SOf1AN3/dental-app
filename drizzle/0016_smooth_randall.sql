ALTER TABLE "user" ADD COLUMN "token_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "prescription_item" ADD COLUMN "order_index" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_stock_alerts_item_id_active" ON "stock_alert" USING btree ("item_id") WHERE status = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_prosthesis_orders_clinic_order_number" ON "prosthesis_order" USING btree ("clinic_id","order_number");--> statement-breakpoint
ALTER TABLE "stock_item" ADD CONSTRAINT "ck_stock_items_current_qty_non_negative" CHECK ("stock_item"."current_qty" >= 0);--> statement-breakpoint
ALTER TABLE "clinic" ADD COLUMN "default_tax_rate" integer DEFAULT 19 NOT NULL;--> statement-breakpoint
ALTER TABLE "clinic" ADD COLUMN "document_branding" jsonb;