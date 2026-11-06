import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { keccak256, toBytes } from 'viem';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { getDb } from '@/lib/db';
import { saveEvidence, setProjectHidden, upsertProject } from '@/lib/db/queries';
import { hashEvidence } from '@/lib/shift/evidence';
import { GET } from '@/app/api/v1/evidence/[hash]/route';
import type { EvidenceBundle } from '@/lib/types';

const saved = process.env.DATABASE_URL;
beforeAll(async () => {
  process.env.DATABASE_URL = 'pglite://memory';
  const db = await getDb();
  await migrate(db as never, { migrationsFolder: path.resolve(__dirname, '../../drizzle') });
});
afterAll(() => {
  if (saved === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = saved;
});

const call = (hash: string) => GET(new Request(`http://localhost/api/v1/evidence/${hash}`), { params: Promise.resolve({ hash }) });

describe('GET /api/v1/evidence/[hash]', () => {
  it('serves the canonical bundle, whose keccak256 is the hash', async () => {
    const db = await getDb();
    const p = await upsertProject(db, { slug: 'ev', name: 'Ev', source: 'base' });
    const bundle = {
      v: 1, rulesVersion: 'r1', project: 'ev', night: 20261106, kind: 'nightly',
      window: { start: '2026-11-05T05:00:00.000Z', end: '2026-11-06T05:00:00.000Z' },
      sources: {
        repo: { source: 'repo', tier: 'verified', ok: true, facts: { host: 'github', repo: 'o/r', branch: 'main', headSha: null, mode: 'git', commits: [{ sha: 'a', author: 'Zoë', authorIsBot: false, date: '2026-11-05T10:00:00Z', message: 'feat: ünïcode "quotes" <b>', files: ['x.ts'], additions: 1.5, deletions: 0, kind: 'code' }], releases: [] } },
        liveapp: null, chain: null, vibestarter: null,
      },
    } as unknown as EvidenceBundle;
    const hash = hashEvidence(bundle);
    await saveEvidence(db, hash, p.id, '2026-11-06', bundle);

    const r = await call(hash);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/json');
    expect(r.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    const text = await r.text();
    expect(keccak256(toBytes(text))).toBe(hash);
    // upper-case hex in the URL finds the same row
    expect((await call(hash.toUpperCase().replace('0X', '0x'))).status).toBe(200);
  });

  it("a hidden (moderated) project's bundle is not served; an unlisted community one still is", async () => {
    const db = await getDb();
    const mk = (slug: string) => ({
      v: 1, rulesVersion: 'r1', project: slug, night: 20261106, kind: 'nightly',
      window: { start: '2026-11-05T05:00:00.000Z', end: '2026-11-06T05:00:00.000Z' },
      sources: { repo: null, liveapp: null, chain: null, vibestarter: null },
    } as unknown as EvidenceBundle);
    const hidden = await upsertProject(db, { slug: 'ev-hidden', name: 'H', source: 'base' });
    await setProjectHidden(db, hidden.id, true);
    const community = await upsertProject(db, { slug: 'ev-community', name: 'C', source: 'community' });
    const hb = mk('ev-hidden');
    const cb = mk('ev-community');
    await saveEvidence(db, hashEvidence(hb), hidden.id, '2026-11-06', hb);
    await saveEvidence(db, hashEvidence(cb), community.id, '2026-11-06', cb);

    const h = await call(hashEvidence(hb));
    expect(h.status).toBe(404);
    expect(await h.json()).toEqual({ error: 'not_found' });
    expect(h.headers.get('cache-control')).not.toContain('immutable');
    expect((await call(hashEvidence(cb))).status).toBe(200);
  });

  it('400 on a malformed hash, 404 when missing', async () => {
    expect((await call('0x1234')).status).toBe(400);
    expect((await call('not-a-hash')).status).toBe(400);
    const missing = await call(`0x${'ab'.repeat(32)}`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'not_found' });
  });
});
