/**
 * Fills <!-- num:key -->…<!-- /num --> spans in markdown files from results/*.json (keys: field.*, vibeathon01.*, commitVsShip.*, headline.*).
 * Errors on unknown keys. NOTE: field.<cohort>.medianDaysSinceActivityAmongActive is survivor-biased (only projects that
 * were active at all) and is refused as a standalone key; quote noActivityInHistory next to it in prose instead.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './_backfill';
import { renderNumbers } from '@/lib/study';
import { STUDY_FILES, parseStudyResults, type StudyNamespace } from '@/lib/studyResults';

function main() {
  const targets = process.argv.slice(2);
  if (!targets.length) throw new Error('usage: tsx scripts/render-readme.ts <file.md> [...]');
  // results JSON under stable namespaces (field.*, vibeathon01.*, commitVsShip.*, headline.*), validated as /study validates it
  const raw = Object.fromEntries(Object.entries(STUDY_FILES).map(([k, f]) => [k, JSON.parse(fs.readFileSync(path.join(ROOT, 'results', f), 'utf8'))]));
  const data = parseStudyResults(raw as Record<StudyNamespace, unknown>);
  for (const t of targets) {
    const file = path.resolve(t);
    const before = fs.readFileSync(file, 'utf8');
    const after = renderNumbers(before, data);
    if (after !== before) fs.writeFileSync(file, after);
    console.log(`${t}: ${after === before ? 'unchanged' : 'updated'}`);
  }
}

main();
