import type { Status } from '@/lib/types';

/**
 * Plain words for the machine reason codes in nights.signals.reasons (REASONS and NOTE_REASONS in
 * @/lib/shift/rules). Unknown codes are shown as they are rather than guessed at.
 */
const TEXT: Record<string, string> = {
  'liveapp.new_deploy': 'The live app has a new deployment.',
  'repo.release': 'The repo published a release or tag in the window.',
  'chain.new_deployment': 'A listed deployer created a contract.',
  'repo.code_commits': 'A non-bot author committed code (not only docs, styling or config).',
  'liveapp.down': 'The live app failed twice in a row and nothing else shipped.',
  'all.unavailable': 'None of the repo, live app or chain answered, so no claim is made.',
  none: 'No verified change was seen.',
  'liveapp.blocked': 'The site blocked our check (401, 403 or 429). That never counts as down.',
  'source.repo.failed': 'The repo could not be read this night; the status comes from the other sources.',
  'source.liveapp.failed': 'The live app could not be read this night; the status comes from the other sources.',
  'source.chain.failed': 'The chain could not be read this night; the status comes from the other sources.',
  'source.vibestarter.failed': 'Vibestarter could not be read this night (it never counts toward a status anyway).',
};

export function reasonText(code: string): string {
  return TEXT[code] ?? code;
}

/** Verdict reasons first, notes after, duplicates dropped. */
export function reasonLines(reasons: unknown): { code: string; text: string }[] {
  if (!Array.isArray(reasons)) return [];
  const seen = new Set<string>();
  return reasons
    .filter((r): r is string => typeof r === 'string' && !seen.has(r) && (seen.add(r), true))
    .map((code) => ({ code, text: reasonText(code) }));
}

export const STATUS_LABEL: Record<Status, string> = {
  shipped: 'Shipped',
  building: 'Building',
  quiet: 'Quiet',
  down: 'Down',
  unavailable: 'Unavailable',
};

export const STATUS_MEANING: Record<Status, string> = {
  shipped: 'a new deploy, release or contract reached users',
  building: 'code landed, nothing verified live yet',
  quiet: 'no verified change seen',
  down: 'the live app is not answering',
  unavailable: 'no source answered, so no claim either way',
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** yyyymmdd -> "6 Nov" (or "6 Nov 2026" with the year). */
export function nightLabel(n: number, withYear = false): string {
  const d = n % 100;
  const m = MONTHS[(Math.floor(n / 100) % 100) - 1] ?? '';
  return withYear ? `${d} ${m} ${Math.floor(n / 10000)}` : `${d} ${m}`;
}

/** 'yyyy-mm-dd' for a valid calendar date, else null. */
export function parseNightParam(s: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return y * 10000 + m * 100 + d;
}
