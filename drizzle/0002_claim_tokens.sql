ALTER TABLE "nights" ADD COLUMN "attest_nonce" integer;--> statement-breakpoint
ALTER TABLE "nights" ADD COLUMN "attest_claim_id" text;--> statement-breakpoint
ALTER TABLE "shifts" ADD COLUMN "lease_until" timestamp with time zone;