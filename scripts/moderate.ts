import { loadEnv } from './_backfill';

loadEnv();

/** Usage: tsx scripts/moderate.ts hide <slug> [reason] | unhide <slug> */
async function main() {
  const [action, slug, ...reason] = process.argv.slice(2);
  if ((action !== 'hide' && action !== 'unhide') || !slug) {
    console.error('usage: moderate.ts hide <slug> [reason] | unhide <slug>');
    process.exit(2);
  }
  const [{ getDb }, { moderateProject }] = await Promise.all([import('@/lib/db'), import('@/lib/db/queries')]);
  const row = await moderateProject(await getDb(), slug, action);
  if (!row) { console.error(`no such project: ${slug}`); process.exit(1); }
  console.log(`${action} ${row.slug}: hidden=${row.hidden} added_by=${row.addedBy ?? '-'}${reason.length ? ` (reason: ${reason.join(' ')})` : ''}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
