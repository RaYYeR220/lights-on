const LOCKFILES = new Set(['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'Cargo.lock', 'go.sum']);

function base(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}

function isCosmeticPath(raw: string): boolean {
  const p = raw.replace(/^\.?\//, '');
  const b = base(p);
  if (/^(docs|\.github|\.vscode)\//.test(p)) return true;
  if (/^LICENSE/i.test(b)) return true;
  if (LOCKFILES.has(b) || /^bun\.lock/.test(b)) return true;
  return /\.(md|mdx|txt|png|jpe?g|svg|ico)$/i.test(b);
}

/** Cosmetic iff every file is docs / lockfile / editor+CI config / static image. An empty list is 'code' (unknown). */
export function classifyPaths(files: string[]): 'code' | 'cosmetic' {
  return files.length > 0 && files.every(isCosmeticPath) ? 'cosmetic' : 'code';
}

/** Message-only guess for Atom mode (no file list). */
export function classifyMessage(msg: string): 'code' | 'cosmetic' {
  const m = msg.trim();
  if (/^(docs|ci|style)(\([^)]*\))?!?(:|\b)/i.test(m)) return 'cosmetic';
  if (/^chore\(deps[^)]*\)/i.test(m)) return 'cosmetic';
  if (/\b(readme|typo|bump)\b/i.test(m)) return 'cosmetic';
  return 'code';
}

export function isBot(author: string): boolean {
  return /(\[bot\]|dependabot|renovate|github-actions|^vercel)/i.test(author);
}
