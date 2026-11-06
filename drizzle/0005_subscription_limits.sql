ALTER TABLE "subscriptions" ADD COLUMN "endpoint_hash" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "ip_hash" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "ai_brief_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_channel_target_uq" ON "subscriptions" USING btree ("channel","target");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_endpoint_hash_uq" ON "subscriptions" USING btree ("endpoint_hash");--> statement-breakpoint
CREATE INDEX "subscriptions_pending_idx" ON "subscriptions" USING btree ("last_sent_at","id");