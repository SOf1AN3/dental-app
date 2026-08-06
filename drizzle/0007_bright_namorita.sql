CREATE TYPE "public"."audit_action" AS ENUM('create', 'update', 'delete', 'status_change');--> statement-breakpoint
CREATE TYPE "public"."verification_token_purpose" AS ENUM('password_reset', 'email_verification');--> statement-breakpoint
CREATE TABLE "account_token" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token" text NOT NULL,
	"purpose" "verification_token_purpose" NOT NULL,
	"expires_at" timestamp NOT NULL,
	"used_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "account_token_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"clinic_id" text,
	"actor_user_id" text NOT NULL,
	"action" "audit_action" NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"before_state" jsonb,
	"after_state" jsonb,
	"ip_address" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "login_attempt" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"ip_address" text,
	"successful" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "consultation_note" DROP CONSTRAINT "consultation_note_dentist_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "stock_transaction" DROP CONSTRAINT "stock_transaction_item_id_stock_item_id_fk";
--> statement-breakpoint
ALTER TABLE "clinic" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "patient" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "odontogram_state" ADD COLUMN "version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "radiograph" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "account_token" ADD CONSTRAINT "account_token_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_account_tokens_user_id" ON "account_token" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_audit_logs_clinic_id" ON "audit_log" USING btree ("clinic_id");--> statement-breakpoint
CREATE INDEX "idx_audit_logs_actor_user_id" ON "audit_log" USING btree ("actor_user_id");--> statement-breakpoint
CREATE INDEX "idx_audit_logs_entity" ON "audit_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "idx_login_attempts_email_ip_time" ON "login_attempt" USING btree ("email","ip_address","created_at");--> statement-breakpoint
ALTER TABLE "consultation_note" ADD CONSTRAINT "consultation_note_dentist_id_user_id_fk" FOREIGN KEY ("dentist_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transaction" ADD CONSTRAINT "stock_transaction_item_id_stock_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."stock_item"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_invoices_clinic_number" ON "invoice" USING btree ("clinic_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_quotes_clinic_number" ON "quote" USING btree ("clinic_id","number");--> statement-breakpoint
ALTER TABLE "clinic_membership" DROP COLUMN "permissions";