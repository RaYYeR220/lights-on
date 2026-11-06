import { loadEnv, flag } from './_backfill';

loadEnv();

/**
 * One-off, before launch: reorder the tower so the top floors (bay 1 = top left, above the fold) hold the most active
 * windows. Order: activity over the last 90 nights (shipped x3 + building), then cohort, then name. Idempotent.
 *
 *   pnpm tsx scripts/reassign-bays.ts           dry run: prints the diff, writes nothing
 *   pnpm tsx scripts/reassign-bays.ts --apply   writes the new bays
 */
async function main() {
  const [{ getDb }, bays] = await Promise.all([import('@/lib/db'), import('@/lib/backfill/bays')]);
  const db = await getDb();
  const rows = await bays.loadBayRows(db);
  const plan = bays.planBays(rows);
  const diff = bays.describeMoves(plan);
  for (const line of diff) console.log(line);
  console.log(`${rows.length} projects, ${diff.length} bays change${flag('apply') ? '' : ' (dry run; pass --apply to write)'}`);
  if (!flag('apply') || diff.length === 0) return;
  const n = await bays.applyBays(db, plan);
  const after = bays.planBays(await bays.loadBayRows(db));
  console.log(`applied ${n}; re-plan now changes ${bays.describeMoves(after).length}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
