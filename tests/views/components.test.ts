import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProjectEyebrow } from '@/components/project/ProjectEyebrow';
import { validateWatch } from '@/components/add/WatchForm';
import { CLAIM_ERRORS } from '@/components/claim/messages';
import { trancheKind } from '@/components/project/Tranches';

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
