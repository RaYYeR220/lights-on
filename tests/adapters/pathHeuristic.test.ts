import { describe, it, expect } from 'vitest';
import { classifyPaths, classifyMessage, isBot } from '@/lib/adapters/pathHeuristic';

describe('classifyPaths', () => {
  it.each([
    [['README.md'], 'cosmetic'],
    [['docs/a/b.png', 'docs/x.mdx'], 'cosmetic'],
    [['LICENSE', 'LICENSE-MIT'], 'cosmetic'],
    [['notes.txt'], 'cosmetic'],
    [['pnpm-lock.yaml'], 'cosmetic'],
    [['apps/web/package-lock.json', 'go.sum', 'Cargo.lock', 'bun.lockb', 'yarn.lock'], 'cosmetic'],
    [['.github/workflows/ci.yml', '.vscode/settings.json'], 'cosmetic'],
    [['public/logo.svg', 'a.png', 'b.jpg', 'favicon.ico'], 'cosmetic'],
    [['src/x.ts', 'README.md'], 'code'],
    [['src/x.ts'], 'code'],
    [['package.json'], 'code'],
    [['contracts/Vault.sol', 'pnpm-lock.yaml'], 'code'],
    [[], 'code'],
  ] as const)('%j -> %s', (files, want) => {
    expect(classifyPaths([...files])).toBe(want);
  });
});

describe('classifyMessage', () => {
  it.each([
    ['docs: update readme', 'cosmetic'],
    ['docs(api): clarify', 'cosmetic'],
    ['chore(deps): bump viem', 'cosmetic'],
    ['chore(deps-dev): bump vitest', 'cosmetic'],
    ['ci: pin node', 'cosmetic'],
    ['style: fmt', 'cosmetic'],
    ['Fix typo in header', 'cosmetic'],
    ['Bump version', 'cosmetic'],
    ['Update README', 'cosmetic'],
    ['feat: add vault', 'code'],
    ['fix: indexing', 'code'],
    ['chore: refactor core', 'code'],
  ])('%s -> %s', (m, want) => {
    expect(classifyMessage(m)).toBe(want);
  });
});

describe('isBot', () => {
  it.each(['dependabot[bot]', 'renovate[bot]', 'github-actions[bot]', 'vercel[bot]', 'Renovate Bot', 'dependabot', 'vercel'])('bot %s', (a) =>
    expect(isBot(a)).toBe(true),
  );
  it.each(['rkalis', 'Dana', 'Botond'])('human %s', (a) => expect(isBot(a)).toBe(false));
});
