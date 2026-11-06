UPDATE "subscriptions"
SET "endpoint_hash" = encode(sha256(convert_to("target"::jsonb->>'endpoint', 'UTF8')), 'hex')
WHERE "channel" = 'webpush' AND "endpoint_hash" IS NULL AND "target"::jsonb->>'endpoint' IS NOT NULL;
