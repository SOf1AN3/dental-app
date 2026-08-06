ALTER TABLE "treatment_catalog" ALTER COLUMN "price" SET DATA TYPE numeric(12, 2) USING "price" / 100.0;--> statement-breakpoint
ALTER TABLE "treatment_plan_item" ALTER COLUMN "fee" SET DATA TYPE numeric(12, 2) USING "fee" / 100.0;--> statement-breakpoint
ALTER TABLE "treatment_plan_item" ALTER COLUMN "discount" SET DATA TYPE numeric(12, 2) USING "discount" / 100.0;--> statement-breakpoint
ALTER TABLE "treatment_plan" ALTER COLUMN "total_amount" SET DATA TYPE numeric(12, 2) USING "total_amount" / 100.0;--> statement-breakpoint
ALTER TABLE "treatment_plan" ALTER COLUMN "discount" SET DATA TYPE numeric(12, 2) USING "discount" / 100.0;--> statement-breakpoint
ALTER TABLE "clinical_session_item" ALTER COLUMN "fee" SET DATA TYPE numeric(12, 2) USING "fee" / 100.0;--> statement-breakpoint
ALTER TABLE "clinical_session_item" ALTER COLUMN "discount" SET DATA TYPE numeric(12, 2) USING "discount" / 100.0;--> statement-breakpoint
ALTER TABLE "clinical_session" ALTER COLUMN "total_amount" SET DATA TYPE numeric(12, 2) USING "total_amount" / 100.0;--> statement-breakpoint
ALTER TABLE "invoice_item" ALTER COLUMN "unit_price" SET DATA TYPE numeric(12, 2) USING "unit_price" / 100.0;--> statement-breakpoint
ALTER TABLE "invoice_item" ALTER COLUMN "discount" SET DATA TYPE numeric(12, 2) USING "discount" / 100.0;--> statement-breakpoint
ALTER TABLE "invoice_item" ALTER COLUMN "total" SET DATA TYPE numeric(12, 2) USING "total" / 100.0;--> statement-breakpoint
ALTER TABLE "invoice" ALTER COLUMN "subtotal" SET DATA TYPE numeric(12, 2) USING "subtotal" / 100.0;--> statement-breakpoint
ALTER TABLE "invoice" ALTER COLUMN "tax_total" SET DATA TYPE numeric(12, 2) USING "tax_total" / 100.0;--> statement-breakpoint
ALTER TABLE "invoice" ALTER COLUMN "discount_total" SET DATA TYPE numeric(12, 2) USING "discount_total" / 100.0;--> statement-breakpoint
ALTER TABLE "invoice" ALTER COLUMN "total" SET DATA TYPE numeric(12, 2) USING "total" / 100.0;--> statement-breakpoint
ALTER TABLE "payment" ALTER COLUMN "amount" SET DATA TYPE numeric(12, 2) USING "amount" / 100.0;--> statement-breakpoint
ALTER TABLE "quote_item" ALTER COLUMN "unit_price" SET DATA TYPE numeric(12, 2) USING "unit_price" / 100.0;--> statement-breakpoint
ALTER TABLE "quote_item" ALTER COLUMN "discount" SET DATA TYPE numeric(12, 2) USING "discount" / 100.0;--> statement-breakpoint
ALTER TABLE "quote_item" ALTER COLUMN "total" SET DATA TYPE numeric(12, 2) USING "total" / 100.0;--> statement-breakpoint
ALTER TABLE "quote" ALTER COLUMN "subtotal" SET DATA TYPE numeric(12, 2) USING "subtotal" / 100.0;--> statement-breakpoint
ALTER TABLE "quote" ALTER COLUMN "tax_total" SET DATA TYPE numeric(12, 2) USING "tax_total" / 100.0;--> statement-breakpoint
ALTER TABLE "quote" ALTER COLUMN "discount_total" SET DATA TYPE numeric(12, 2) USING "discount_total" / 100.0;--> statement-breakpoint
ALTER TABLE "quote" ALTER COLUMN "total" SET DATA TYPE numeric(12, 2) USING "total" / 100.0;--> statement-breakpoint
ALTER TABLE "stock_item" ALTER COLUMN "purchase_price" SET DATA TYPE numeric(12, 2) USING "purchase_price" / 100.0;--> statement-breakpoint
ALTER TABLE "stock_item" ALTER COLUMN "selling_price" SET DATA TYPE numeric(12, 2) USING "selling_price" / 100.0;--> statement-breakpoint
ALTER TABLE "stock_transaction" ALTER COLUMN "unit_price" SET DATA TYPE numeric(12, 2) USING "unit_price" / 100.0;--> statement-breakpoint
ALTER TABLE "prosthesis_order" ALTER COLUMN "cost" SET DATA TYPE numeric(12, 2) USING "cost" / 100.0;--> statement-breakpoint
ALTER TABLE "subscription_plan" ALTER COLUMN "price_monthly" SET DATA TYPE numeric(12, 2) USING "price_monthly" / 100.0;--> statement-breakpoint
ALTER TABLE "subscription_plan" ALTER COLUMN "price_yearly" SET DATA TYPE numeric(12, 2) USING "price_yearly" / 100.0;--> statement-breakpoint
ALTER TABLE "clinic_membership" ADD COLUMN "min_gap_minutes" integer DEFAULT 15 NOT NULL;--> statement-breakpoint
ALTER TABLE "clinic" ADD COLUMN "opening_time" time DEFAULT '08:00' NOT NULL;--> statement-breakpoint
ALTER TABLE "clinic" ADD COLUMN "closing_time" time DEFAULT '19:00' NOT NULL;
