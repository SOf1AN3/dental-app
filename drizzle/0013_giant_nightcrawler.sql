CREATE TYPE "public"."notification_category" AS ENUM('broadcast', 'maintenance', 'subscription_reminder', 'system');--> statement-breakpoint
CREATE TABLE "notification" (
	"id" text PRIMARY KEY NOT NULL,
	"clinic_id" text NOT NULL,
	"category" "notification_category" DEFAULT 'broadcast' NOT NULL,
	"title" text NOT NULL,
	"message" text NOT NULL,
	"link" text,
	"ref_key" text,
	"read_at" timestamp,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_created_by_platform_owner_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."platform_owner"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_notifications_clinic_read" ON "notification" USING btree ("clinic_id","read_at");