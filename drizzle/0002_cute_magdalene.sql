CREATE TABLE "document_sequence" (
	"id" text PRIMARY KEY NOT NULL,
	"clinic_id" text NOT NULL,
	"type" text NOT NULL,
	"last_number" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "document_sequence" ADD CONSTRAINT "document_sequence_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_doc_seq_clinic_type" ON "document_sequence" USING btree ("clinic_id","type");