import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { keccak256, toBytes } from 'viem';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { getDb } from '@/lib/db';
import { saveNightManifest } from '@/lib/db/queries';
import { buildNightManifest } from '@/lib/attest/manifest';
import { GET } from '@/app/api/v1/manifest/[hash]/route';

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

const call = (hash: string) => GET(new Request(`http://localhost/api/v1/manifest/${hash}`), { params: Promise.resolve({ hash }) });

describe('GET /api/v1/manifest/[hash]', () => {
  it('serves the canonical night manifest byte for byte: keccak256(body) is the hash in the URL', async () => {
    const m = buildNightManifest([
      { slug: 'revoke-cash', night: 20261106, status: 'building', lit30: 12, evidenceHash: keccak256(toBytes('a')) },
      { slug: 'corvo-edge', night: 20261106, status: 'quiet', lit30: 0, evidenceHash: keccak256(toBytes('b')) },
    ], 7n);
    await saveNightManifest(await getDb(), m.hash, '2026-11-06', m.root, m.manifest);
    const r = await call(m.hash);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/json');
    expect(r.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(r.headers.get('access-control-allow-origin')).toBe('*');
    const text = await r.text();
    expect(text).toBe(m.body);
    expect(keccak256(toBytes(text))).toBe(m.hash);
    expect((await call(m.hash.toUpperCase().replace('0X', '0x'))).status).toBe(200);
  });

  it('400 on a malformed hash, 404 when missing (not cached for long)', async () => {
    expect((await call('0x1234')).status).toBe(400);
    expect((await call('nope')).status).toBe(400);
    const missing = await call(`0x${'ab'.repeat(32)}`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'not_found' });
    expect(missing.headers.get('cache-control')).toBe('public, max-age=60');
  });
});
