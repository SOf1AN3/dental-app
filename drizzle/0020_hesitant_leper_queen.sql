CREATE TABLE "sync_applied" (
	"op_id" text PRIMARY KEY NOT NULL,
	"device_id" text,
	"applied_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_conflict" (
	"id" text PRIMARY KEY NOT NULL,
	"table_name" text NOT NULL,
	"row_id" text NOT NULL,
	"device_id" text,
	"winning_payload" jsonb,
	"losing_payload" jsonb,
	"reason" text,
	"decided_at" timestamp DEFAULT now() NOT NULL,
	"resolved_by" text,
	"resolved_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "sync_merge" (
	"id" text PRIMARY KEY NOT NULL,
	"table_name" text NOT NULL,
	"canonical_id" text NOT NULL,
	"duplicate_id" text NOT NULL,
	"reason" text,
	"merged_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"table_name" text NOT NULL,
	"row_id" text NOT NULL,
	"op" text NOT NULL,
	"payload" jsonb NOT NULL,
	"device_id" text,
	"seq" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"clinic_id" text
);
--> statement-breakpoint
CREATE TABLE "sync_state" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "support_ticket" ADD COLUMN "updated_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "support_ticket" ADD COLUMN "device_id" text;--> statement-breakpoint
ALTER TABLE "support_ticket" ADD COLUMN "rev" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "support_ticket" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
CREATE INDEX "idx_sync_applied_device_applied_at" ON "sync_applied" USING btree ("device_id","applied_at");--> statement-breakpoint
CREATE INDEX "idx_sync_conflict_table_row" ON "sync_conflict" USING btree ("table_name","row_id");--> statement-breakpoint
CREATE INDEX "idx_sync_conflict_decided_at" ON "sync_conflict" USING btree ("decided_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_sync_merge_duplicate_id" ON "sync_merge" USING btree ("duplicate_id");--> statement-breakpoint
CREATE INDEX "idx_sync_outbox_status_seq" ON "sync_outbox" USING btree ("status","seq");--> statement-breakpoint
CREATE INDEX "idx_sync_outbox_clinic_status" ON "sync_outbox" USING btree ("clinic_id","status");--> statement-breakpoint
CREATE INDEX "idx_support_tickets_clinic_updated_id" ON "support_ticket" USING btree ("clinic_id","updated_at","id");