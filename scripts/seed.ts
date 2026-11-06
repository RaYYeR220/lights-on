import fs from 'node:fs';
import path from 'node:path';
import { loadEnv, flag, ROOT } from './_backfill';
import { listVibestarterCampaigns } from '@/lib/adapters/vibestarter';
import { buildSeedProjects, mergeDraft, type SeedFile } from '@/lib/backfill/seed';

loadEnv();

async function main() {
  const seed = JSON.parse(fs.readFileSync(path.resolve(ROOT, '../research/seed-projects.json'), 'utf8')) as SeedFile;
  const campaigns = await listVibestarterCampaigns();
  const { drafts, skippedRaises } = buildSeedProjects(seed, campaigns);
  console.log(`vibestarter campaigns: ${campaigns.length} (skipped ${skippedRaises.length}: ${skippedRaises.map((c) => `${c.title}[${c.status}]`).join(', ') || 'none'})`);

  if (flag('dry')) {
    for (const d of drafts) console.log(`${d.slug}\t${d.source}\t${d.repo ?? '-'}\t${d.liveUrl ?? '-'}`);
    return;
  }
  const [{ getDb }, { upsertProject }] = await Promise.all([import('@/lib/db'), import('@/lib/db/queries')]);
  const db = await getDb();
  const counts: Record<string, number> = {};
  for (const d of drafts) {
    const row = await upsertProject(db, mergeDraft(d));
    counts[row.source] = (counts[row.source] ?? 0) + 1;
    console.log(`#${row.id}\t${row.slug}\t${row.source}\t${row.repo ?? '-'}`);
  }
  console.log(`upserted ${drafts.length} projects`, counts);
}

main().catch((e) => { console.error(e); process.exit(1); });
