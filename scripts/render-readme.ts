/**
 * Fills <!-- num:key -->…<!-- /num --> spans in markdown files from results/*.json (keys: field.*, vibeathon01.*, commitVsShip.*, headline.*).
 * Errors on unknown keys. NOTE: field.<cohort>.medianDaysSinceActivityAmongActive is survivor-biased (only projects that
 * were active at all) and is refused as a standalone key; quote noActivityInHistory next to it in prose instead.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './_backfill';
import { renderNumbers } from '@/lib/study';

/** Merge results JSON under stable namespaces: field.*, vibeathon01.*, commitVsShip.*, headline.* */
const FILES: Record<string, string> = {
  field: 'study-field.json', vibeathon01: 'study-vibeathon01.json', commitVsShip: 'commit-vs-ship.json', headline: 'headline.json',
};

function main() {
  const targets = process.argv.slice(2);
  if (!targets.length) throw new Error('usage: tsx scripts/render-readme.ts <file.md> [...]');
  const data = Object.fromEntries(Object.entries(FILES).map(([k, f]) => [k, JSON.parse(fs.readFileSync(path.join(ROOT, 'results', f), 'utf8'))]));
  for (const t of targets) {
    const file = path.resolve(t);
    const before = fs.readFileSync(file, 'utf8');
    const after = renderNumbers(before, data);
    if (after !== before) fs.writeFileSync(file, after);
    console.log(`${t}: ${after === before ? 'unchanged' : 'updated'}`);
  }
}

main();
