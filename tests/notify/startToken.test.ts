import { describe, it, expect } from 'vitest';
import { decodeStartToken, encodeStartToken, parseCommand } from '@/lib/notify/telegram';

const ADDR = '0xAbCdEf0123456789abcdef0123456789ABCDEF01';

describe('telegram /start payload', () => {
  it('short forms fit Telegram (<=64, [A-Za-z0-9_-])', () => {
    const a = encodeStartToken({ a: ADDR });
    expect(a).toBe(`a_${ADDR.slice(2).toLowerCase()}`);
    expect(a.length).toBeLessThanOrEqual(64);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    const p = encodeStartToken({ p: 'corvo-edge' });
    expect(p).toBe('p_corvo-edge');
    expect(decodeStartToken(a)).toEqual({ address: ADDR.toLowerCase() });
    expect(decodeStartToken(p)).toEqual({ slug: 'corvo-edge' });
    expect(parseCommand(`/start ${a}`)).toEqual({ cmd: 'start', address: ADDR.toLowerCase() });
    expect(parseCommand('/start p_alpha')).toEqual({ cmd: 'start', slug: 'alpha' });
  });
  it('rejects malformed short tokens; old base64url JSON still works', () => {
    expect(decodeStartToken('a_123')).toBeNull();
    expect(decodeStartToken('a_' + 'g'.repeat(40))).toBeNull();
    expect(decodeStartToken('p_Bad_Slug')).toBeNull();
    expect(decodeStartToken('p_' + 'a'.repeat(61))).toBeNull();
    const old = Buffer.from(JSON.stringify({ a: ADDR, p: 'x1' })).toString('base64url');
    expect(decodeStartToken(old)).toEqual({ address: ADDR.toLowerCase(), slug: 'x1' });
  });
});
