CREATE TABLE "budget" (
	"day" date PRIMARY KEY NOT NULL,
	"llm_tokens" numeric DEFAULT '0' NOT NULL,
	"gas_wei" numeric DEFAULT '0' NOT NULL,
	"live_runs" numeric DEFAULT '0' NOT NULL,
	"github_calls" numeric DEFAULT '0' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evidence" (
	"hash" text PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"night" date NOT NULL,
	"bundle" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "founder_notes" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"night" date NOT NULL,
	"note" text NOT NULL,
	"author" text NOT NULL,
	"signature" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "live_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"evidence_hash" text,
	"attestation_uid" text,
	"tx" text,
	"requester_ip_hash" text
);
--> statement-breakpoint
CREATE TABLE "nights" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"night" date NOT NULL,
	"shift_id" integer,
	"status" text NOT NULL,
	"observed" boolean DEFAULT true NOT NULL,
	"signals" jsonb,
	"summary" text,
	"notable" jsonb,
	"evidence_hash" text,
	"attestation_uid" text,
	"attest_claimed_at" timestamp with time zone,
	"ai_model" text,
	"ai_ok" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "nights_status_chk" CHECK (status in ('shipped', 'building', 'quiet', 'down', 'unavailable'))
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"tagline" text,
	"category" text,
	"source" text NOT NULL,
	"live_url" text,
	"repo_host" text,
	"repo" text,
	"default_branch" text,
	"contracts" jsonb,
	"token" jsonb,
	"vibestarter" jsonb,
	"claimed_by" text,
	"claim_verified_at" timestamp with time zone,
	"added_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	CONSTRAINT "projects_slug_unique" UNIQUE("slug"),
	CONSTRAINT "projects_source_chk" CHECK (source in ('vibestarter', 'vibeathon01', 'base', 'community'))
);
--> statement-breakpoint
CREATE TABLE "shifts" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"night" date NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"planned" integer DEFAULT 0 NOT NULL,
	"done" integer DEFAULT 0 NOT NULL,
	"attest_tx" text,
	"gas_used" numeric,
	"status" text DEFAULT 'running' NOT NULL,
	CONSTRAINT "shifts_kind_chk" CHECK (kind in ('nightly', 'live', 'backfill'))
);
--> statement-breakpoint
CREATE TABLE "snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"adapter" text NOT NULL,
	"taken_at" timestamp with time zone DEFAULT now() NOT NULL,
	"fingerprint" text,
	"data" jsonb
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" serial PRIMARY KEY NOT NULL,
	"channel" text NOT NULL,
	"target" text NOT NULL,
	"addresses" text[] DEFAULT '{}'::text[] NOT NULL,
	"project_ids" integer[] DEFAULT '{}'::integer[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_sent_at" timestamp with time zone,
	CONSTRAINT "subscriptions_channel_chk" CHECK (channel in ('telegram', 'webpush'))
);
--> statement-breakpoint
CREATE TABLE "tranche_events" (
	"project_id" integer NOT NULL,
	"tranche_index" integer NOT NULL,
	"requested_at" timestamp with time zone,
	"window_ends_at" timestamp with time zone,
	"amount_wei" numeric,
	"tx" text,
	"alerted" boolean DEFAULT false NOT NULL,
	CONSTRAINT "tranche_events_project_id_tranche_index_pk" PRIMARY KEY("project_id","tranche_index")
);
--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "founder_notes" ADD CONSTRAINT "founder_notes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_runs" ADD CONSTRAINT "live_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nights" ADD CONSTRAINT "nights_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nights" ADD CONSTRAINT "nights_shift_id_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."shifts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshots" ADD CONSTRAINT "snapshots_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tranche_events" ADD CONSTRAINT "tranche_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "live_runs_project_idx" ON "live_runs" USING btree ("project_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "nights_project_night_observed_uq" ON "nights" USING btree ("project_id","night","observed");--> statement-breakpoint
CREATE INDEX "nights_night_idx" ON "nights" USING btree ("night");--> statement-breakpoint
CREATE UNIQUE INDEX "shifts_nightly_night_uq" ON "shifts" USING btree ("kind","night") WHERE "shifts"."kind" = 'nightly';--> statement-breakpoint
CREATE INDEX "snapshots_project_adapter_idx" ON "snapshots" USING btree ("project_id","adapter","taken_at");