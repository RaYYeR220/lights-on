ALTER TABLE "projects" ADD COLUMN "bay" integer;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_bay_unique" UNIQUE("bay");--> statement-breakpoint
UPDATE "projects" p SET "bay" = r.rn FROM (
	SELECT "id", row_number() OVER (
		ORDER BY CASE "source" WHEN 'vibestarter' THEN 1 WHEN 'vibeathon01' THEN 2 WHEN 'base' THEN 3 ELSE 4 END,
			lower("name"), "id"
	) AS rn FROM "projects"
) r WHERE p."id" = r."id" AND p."bay" IS NULL;
