ALTER TABLE "nights" ADD COLUMN "attest_tx" text;--> statement-breakpoint
ALTER TABLE "shifts" ADD COLUMN "llm_tokens" numeric DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "shifts" ADD COLUMN "github_calls" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "shifts" ADD COLUMN "notes" text;