CREATE TABLE "device" (
	"id" text PRIMARY KEY NOT NULL,
	"clinic_id" text,
	"user_id" text,
	"name" text NOT NULL,
	"os" text NOT NULL,
	"first_seen_at" timestamp DEFAULT now() NOT NULL,
	"last_seen_at" timestamp DEFAULT now() NOT NULL,
	"last_sync_at" timestamp,
	"trust_expires_at" timestamp,
	"trust_revoked_at" timestamp,
	"rev" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "device" ADD CONSTRAINT "device_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device" ADD CONSTRAINT "device_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_devices_clinic_updated_id" ON "device" USING btree ("clinic_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "idx_devices_user_id" ON "device" USING btree ("user_id");