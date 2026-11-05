import { describe, it, expect } from 'vitest';
import { parseEnv, hasFeature } from '@/lib/env';

const minimal = {
  DATABASE_URL: 'pglite://memory',
  NEXT_PUBLIC_SITE_URL: 'http://localhost:3000',
};

describe('env', () => {
  it('parses minimal env (DATABASE_URL + NEXT_PUBLIC_SITE_URL)', () => {
    const e = parseEnv(minimal);
    expect(e.DATABASE_URL).toBe('pglite://memory');
    expect(e.NEXT_PUBLIC_SITE_URL).toBe('http://localhost:3000');
    expect(e.NEXT_PUBLIC_CHAIN_ID).toBe(8453);
    expect(e.WATCHER_PRIVATE_KEY).toBeUndefined();
  });

  it("hasFeature('telegram') is false without TELEGRAM_BOT_TOKEN", () => {
    expect(hasFeature('telegram', minimal)).toBe(false);
    expect(hasFeature('telegram', { ...minimal, TELEGRAM_BOT_TOKEN: 'abc' })).toBe(true);
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
