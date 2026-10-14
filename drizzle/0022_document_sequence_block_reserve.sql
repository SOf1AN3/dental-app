ALTER TABLE "document_sequence" ADD COLUMN "block_start" integer;--> statement-breakpoint
ALTER TABLE "document_sequence" ADD COLUMN "block_end" integer;--> statement-breakpoint
ALTER TABLE "document_sequence" ADD COLUMN "block_device_id" text;--> statement-breakpoint
ALTER TABLE "document_sequence" ADD COLUMN "block_status" text;--> statement-breakpoint
ALTER TABLE "document_sequence" ADD COLUMN "block_reserved_at" timestamp;