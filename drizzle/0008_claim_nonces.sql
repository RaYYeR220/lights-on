CREATE TABLE "claim_nonces" (
	"nonce_hash" text PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"purpose" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "claim_nonces" ADD CONSTRAINT "claim_nonces_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "claim_nonces_expires_idx" ON "claim_nonces" USING btree ("expires_at");