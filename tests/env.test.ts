import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { parseEnv, hasFeature, checkEnv, assertEnv, strictEnv } from '@/lib/env';
import { internalBaseUrl } from '@/lib/shift/dispatch';
import { register } from '@/instrumentation';

const minimal = {
  DATABASE_URL: 'pglite://memory',
  NEXT_PUBLIC_SITE_URL: 'http://localhost:3000',
};
const KEY = `0x${'1'.repeat(64)}` as const;
const KEY_ADDR = privateKeyToAccount(KEY).address;
const prod = {
  DATABASE_URL: 'postgres://u:p@h/db', NEXT_PUBLIC_SITE_URL: 'https://lights-on-watch.vercel.app',
  INTERNAL_RUN_TOKEN: 't', CRON_SECRET: 'c', WATCHER_PRIVATE_KEY: KEY, WATCHER_AGENT_ID: '17', NEXT_PUBLIC_WATCHER_ADDRESS: KEY_ADDR,
  VENICE_API_KEY: 'v', GITHUB_READ_TOKEN: 'g', VERCEL_ENV: 'production',
};
const quiet = { warn: vi.fn(), error: vi.fn() };

describe('env', () => {
  it('parses minimal env (DATABASE_URL + NEXT_PUBLIC_SITE_URL)', () => {
    const e = parseEnv(minimal);
    expect(e.DATABASE_URL).toBe('pglite://memory');
    expect(e.NEXT_PUBLIC_SITE_URL).toBe('http://localhost:3000');
    expect(e.WATCHER_PRIVATE_KEY).toBeUndefined();
  });

  it("hasFeature('telegram') is false without TELEGRAM_BOT_TOKEN; attest needs the key and the agent id", () => {
    expect(hasFeature('telegram', minimal)).toBe(false);
    expect(hasFeature('telegram', { ...minimal, TELEGRAM_BOT_TOKEN: 'abc' })).toBe(true);
    expect(hasFeature('attest', { ...minimal, WATCHER_PRIVATE_KEY: KEY })).toBe(false);
    expect(hasFeature('attest', { ...minimal, WATCHER_PRIVATE_KEY: KEY, WATCHER_AGENT_ID: '17' })).toBe(true);
  });

  it('rejects malformed WATCHER_PRIVATE_KEY (not 0x + 64 hex)', () => {
    expect(() => parseEnv({ ...minimal, WATCHER_PRIVATE_KEY: '0x1234' })).toThrow();
    expect(() => parseEnv({ ...minimal, WATCHER_PRIVATE_KEY: 'a'.repeat(64) })).toThrow();
    expect(() => parseEnv({ ...minimal, WATCHER_PRIVATE_KEY: '0x' + 'a'.repeat(64) })).not.toThrow();
  });

  it('treats empty strings as unset and gates multi-var features', () => {
    const e = { ...minimal, TELEGRAM_BOT_TOKEN: '', VAPID_PRIVATE_KEY: 'k' };
    expect(hasFeature('telegram', e)).toBe(false);
    expect(hasFeature('webpush', e)).toBe(false);
    expect(hasFeature('webpush', { ...e, NEXT_PUBLIC_VAPID_PUBLIC_KEY: 'p' })).toBe(true);
  });
});

describe('checkEnv / assertEnv (server start)', () => {
  it('a complete production env has no errors', () => {
    expect(checkEnv(prod, { production: true }).errors).toEqual([]);
    expect(strictEnv(prod)).toBe(true);
    expect(strictEnv({ VERCEL_ENV: 'preview' })).toBe(false);
  });

  it('production: names every missing required or malformed variable, never a value', () => {
    const { errors } = checkEnv({
      ...prod, DATABASE_URL: '', INTERNAL_RUN_TOKEN: '', CRON_SECRET: undefined, NEXT_PUBLIC_SITE_URL: 'http://x.example',
      WATCHER_AGENT_ID: 'abc', BASE_RPC_URL: 'not a url', NEXT_PUBLIC_WATCHER_ADDRESS: '0x12', WATCHER_PRIVATE_KEY: '0xdeadbeef',
    }, { production: true });
    const text = errors.join('\n');
    for (const name of ['DATABASE_URL', 'INTERNAL_RUN_TOKEN', 'CRON_SECRET', 'NEXT_PUBLIC_SITE_URL', 'WATCHER_AGENT_ID', 'BASE_RPC_URL', 'NEXT_PUBLIC_WATCHER_ADDRESS', 'WATCHER_PRIVATE_KEY']) {
      expect(text).toContain(name);
    }
    expect(text).not.toContain('0xdeadbeef');
    expect(text).not.toContain('not a url');
  });

  it('warns about switched-off features: no agent id, a watcher missing from the Verify allowlist', () => {
    const other = `0x${'2'.repeat(40)}`;
    const { warnings, errors } = checkEnv({ ...prod, WATCHER_AGENT_ID: '', NEXT_PUBLIC_WATCHER_ADDRESS: other }, { production: true });
    expect(errors).toEqual([]);
    expect(warnings.join('\n')).toMatch(/WATCHER_AGENT_ID is not set/);
    expect(warnings.join('\n')).toMatch(/NEXT_PUBLIC_WATCHER_ADDRESS does not include the watcher wallet/);
    expect(checkEnv(prod, { production: true }).warnings).toEqual([]);
  });

  it('assertEnv throws on the production deployment, only logs elsewhere; register() runs it on the node runtime', async () => {
    const broken = { ...prod, CRON_SECRET: '' };
    expect(() => assertEnv(broken, quiet)).toThrow(/CRON_SECRET is not set/);
    // elsewhere the production-only requirements do not apply, and malformed values are logged, not thrown
    expect(assertEnv({ ...broken, VERCEL_ENV: 'preview' }, quiet).errors).toEqual([]);
    expect(() => assertEnv({ ...broken, VERCEL_ENV: 'preview', BASE_RPC_URL: 'nope' }, quiet)).not.toThrow();
    expect(quiet.error).toHaveBeenCalledWith(expect.stringContaining('BASE_RPC_URL'));
    const saved = { ...process.env };
    try {
      Object.assign(process.env, broken, { NEXT_RUNTIME: 'nodejs' });
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      await expect(register()).rejects.toThrow(/CRON_SECRET/);
      process.env.NEXT_RUNTIME = 'edge';
      await expect(register()).resolves.toBeUndefined();
    } finally {
      process.env = saved;
    }
  });

  it('internal shift runs go to INTERNAL_BASE_URL, else the public site, never first to a per-deployment origin', () => {
    const req = 'https://lights-on-abc123-team.vercel.app/api/shift/dispatch';
    expect(internalBaseUrl({ INTERNAL_BASE_URL: 'https://a.example' }, req)).toBe('https://a.example');
    expect(internalBaseUrl({ NEXT_PUBLIC_SITE_URL: 'https://lights-on-watch.vercel.app' }, req)).toBe('https://lights-on-watch.vercel.app');
    expect(internalBaseUrl({}, req)).toBe('https://lights-on-abc123-team.vercel.app');
  });
});

describe('.env.example', () => {
  it('lists every process.env variable the app, scripts, configs and tests read', () => {
    const root = path.resolve(__dirname, '..');
    const example = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
    const listed = new Set([...example.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]));
    const platform = new Set(['NODE_ENV', 'NEXT_RUNTIME', 'NEXT_PHASE', 'VERCEL_ENV', 'CI', 'LIGHTS_ON_STRICT_ENV']);
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, f.name);
        if (f.isDirectory()) walk(p);
        else if (/\.(ts|tsx|mjs)$/.test(f.name)) files.push(p);
      }
    };
    for (const d of ['src', 'scripts', 'tests']) walk(path.join(root, d));
    for (const f of ['next.config.ts', 'drizzle.config.ts', 'playwright.config.ts', 'vitest.config.ts']) files.push(path.join(root, f));
    const read = new Set<string>();
    for (const f of files) for (const m of fs.readFileSync(f, 'utf8').matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) read.add(m[1]);
    const missing = [...read].filter((v) => !platform.has(v) && !listed.has(v)).sort();
    expect(missing).toEqual([]);
    for (const v of ['WATCHER_AGENT_ID', 'INTERNAL_BASE_URL', 'BASE_RPC_URL', 'ETH_RPC_URL', 'NEXT_PUBLIC_BASE_RPC_URL', 'NEXT_PUBLIC_TELEGRAM_BOT', 'NEXT_PUBLIC_WATCHER_ADDRESS']) {
      expect(listed.has(v)).toBe(true);
    }
  });
});
