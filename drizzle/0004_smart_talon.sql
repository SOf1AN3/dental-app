CREATE TABLE "treatment_catalog" (
	"id" text PRIMARY KEY NOT NULL,
	"clinic_id" text NOT NULL,
	"name" text NOT NULL,
	"code" text,
	"category" text,
	"price" integer DEFAULT 0 NOT NULL,
	"description" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clinic" ADD COLUMN "logo_url" text;--> statement-breakpoint
ALTER TABLE "clinic" ADD COLUMN "header_url" text;--> statement-breakpoint
ALTER TABLE "clinic" ADD COLUMN "legal_info" text;--> statement-breakpoint
ALTER TABLE "treatment_catalog" ADD CONSTRAINT "treatment_catalog_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_treatment_catalog_clinic_id" ON "treatment_catalog" USING btree ("clinic_id");