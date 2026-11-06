-- One attestation per night: nightly rows carry the ROOT attestation's uid plus their own Merkle leaf, proof, root,
-- the lit30 the leaf commits to and the night manifest's hash; manifests are stored content-addressed.
CREATE TABLE "night_manifests" (
	"hash" text PRIMARY KEY NOT NULL,
	"night" date NOT NULL,
	"root" text NOT NULL,
	"body" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "nights" ADD COLUMN "attest_leaf" text;--> statement-breakpoint
ALTER TABLE "nights" ADD COLUMN "attest_proof" text[];--> statement-breakpoint
ALTER TABLE "nights" ADD COLUMN "attest_root" text;--> statement-breakpoint
ALTER TABLE "nights" ADD COLUMN "attest_lit30" integer;--> statement-breakpoint
ALTER TABLE "nights" ADD COLUMN "attest_manifest" text;--> statement-breakpoint
CREATE INDEX "night_manifests_night_idx" ON "night_manifests" USING btree ("night");