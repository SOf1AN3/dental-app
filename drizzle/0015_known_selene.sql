CREATE TABLE "drug_catalog" (
	"id" text PRIMARY KEY NOT NULL,
	"clinic_id" text NOT NULL,
	"name" text NOT NULL,
	"dosage" text,
	"form" text,
	"category" text,
	"frequency" text,
	"instructions" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "drug_catalog" ADD CONSTRAINT "drug_catalog_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_drug_catalog_clinic_id" ON "drug_catalog" USING btree ("clinic_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_drug_catalog_clinic_id_name" ON "drug_catalog" USING btree ("clinic_id","name");