CREATE TABLE "clinic_schedule" (
	"id" text PRIMARY KEY NOT NULL,
	"clinic_id" text NOT NULL,
	"day_of_week" integer NOT NULL,
	"open_time" time,
	"close_time" time,
	"is_closed" boolean DEFAULT false NOT NULL,
	"is_weekend" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clinic_schedule" ADD CONSTRAINT "clinic_schedule_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_clinic_schedule_clinic_id" ON "clinic_schedule" USING btree ("clinic_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_clinic_schedule_clinic_day" ON "clinic_schedule" USING btree ("clinic_id","day_of_week");