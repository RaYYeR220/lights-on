import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProjectEyebrow } from '@/components/project/ProjectEyebrow';
import { validateWatch } from '@/components/add/WatchForm';
import { CLAIM_ERRORS } from '@/components/claim/messages';
import { trancheKind } from '@/components/project/Tranches';
import { verifyCommand } from '@/components/project/NightDrawer';

describe('ProjectEyebrow', () => {
  it('labels a community-added project as unverified instead of its source', () => {
    const html = renderToStaticMarkup(createElement(ProjectEyebrow, { source: 'community', communityAdded: true, claimedBy: null }));
    expect(html).toContain('Community-added · unverified');
    expect(html).toContain('data-testid="community-label"');
    expect(html).not.toContain('Added by the community');
  });
  it('shows the source and the claim for listed projects', () => {
    const html = renderToStaticMarkup(createElement(ProjectEyebrow, { source: 'base', communityAdded: false, claimedBy: '0x60bc5323c0e0e9144af0b35ce8de119fc743e345' }));
    expect(html).toContain('Base app');
    expect(html).toContain('Claimed by its founder 0x60bc…e345');
    expect(html).not.toContain('unverified');
  });
});

describe('NightDrawer offline check', () => {
  const uid = `0x${'a'.repeat(64)}`;
  const hash = `0x${'b'.repeat(64)}`;
  const watcher = '0x60bc5323c0e0e9144af0b35ce8de119fc743e345';
  it('is a complete, copy-pasteable command with the real uid, bundle, network and attester', () => {
    const cmd = verifyCommand({ site: 'https://lights-on-watch.vercel.app/', slug: 'corvo-edge', night: 20261106, uid, evidenceHash: hash, watcher })!;
    const [fetchLine, verifyLine] = cmd.split(String.fromCharCode(10));
    expect(fetchLine).toBe(`curl -s https://lights-on-watch.vercel.app/api/v1/evidence/${hash} -o evidence-corvo-edge-20261106.json`);
    expect(verifyLine).toBe(`pnpm tsx scripts/verify-night.ts --network base --uid ${uid} --bundle evidence-corvo-edge-20261106.json --attester ${watcher}`);
    // every flag verify-night.ts requires is present with a value
    const argv = verifyLine.split(' ');
    const val = (f: string) => argv[argv.indexOf(`--${f}`) + 1];
    expect([val('network'), val('uid'), val('bundle'), val('attester')]).toEqual(['base', uid, 'evidence-corvo-edge-20261106.json', watcher]);
    expect(cmd).not.toMatch(/[<>]/);
  });
  it('falls back to the env default without a known watcher, and needs an attestation', () => {
    const cmd = verifyCommand({ site: 'https://x.example', slug: 's', night: 20261106, uid, evidenceHash: hash, watcher: null })!;
    expect(cmd).not.toContain('--attester');
    expect(cmd).toContain('--network base');
    expect(verifyCommand({ site: 'https://x.example', slug: 's', night: 20261106, uid: null, evidenceHash: hash, watcher })).toBeNull();
    expect(verifyCommand({ site: 'https://x.example', slug: 's', night: 20261106, uid, evidenceHash: null, watcher })).toBeNull();
  });
});

describe('watch form validation', () => {
  it('needs a public http(s) live URL; repo and contract are optional but checked', () => {
    expect(validateWatch({ liveUrl: '', repo: '', contract: '' }).liveUrl).toMatch(/required/);
    expect(validateWatch({ liveUrl: 'ftp://x.y', repo: '', contract: '' }).liveUrl).toBeDefined();
    expect(validateWatch({ liveUrl: 'https://user:pw@x.y', repo: '', contract: '' }).liveUrl).toBeDefined();
    expect(validateWatch({ liveUrl: 'https://app.example.xyz', repo: '', contract: '' })).toEqual({});
    expect(validateWatch({ liveUrl: 'https://a.xyz', repo: 'https://github.com/o/r', contract: '0x' + 'a'.repeat(40) })).toEqual({});
    expect(validateWatch({ liveUrl: 'https://a.xyz', repo: 'just-a-name', contract: '0x12' })).toMatchObject({ repo: expect.any(String), contract: expect.any(String) });
  });
});

describe('claim copy', () => {
  it('explains the codes the coordinator asked for', () => {
    for (const k of ['bad_nonce', 'proof_missing', 'claimed_by_other', 'wrong_chain', 'not_claimer', 'rate_limited']) expect(CLAIM_ERRORS[k]).toBeTruthy();
  });
  it('maps live tranche statuses', () => {
    expect(trancheKind('PAID')).toBe('paid');
    expect(trancheKind('LOCKED')).toBe('none');
    expect(trancheKind('REQUESTED')).toBe('open');
    expect(trancheKind('REFUNDED')).toBe('fail');
  });
});
