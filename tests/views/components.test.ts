import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProjectEyebrow } from '@/components/project/ProjectEyebrow';
import { validateWatch } from '@/components/add/WatchForm';
import { CLAIM_ERRORS } from '@/components/claim/messages';
import { trancheKind } from '@/components/project/Tranches';
import { NightDrawer, verifyCommand } from '@/components/project/NightDrawer';

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
    expect(verifyLine).toBe(`pnpm tsx scripts/verify-night.ts --network base --uid ${uid} --bundle evidence-corvo-edge-20261106.json --site https://lights-on-watch.vercel.app --attester ${watcher}`);
    // every flag verify-night.ts uses is present with a value (--site: where the row's Merkle proof is read)
    const argv = verifyLine.split(' ');
    const val = (f: string) => argv[argv.indexOf(`--${f}`) + 1];
    expect([val('network'), val('uid'), val('bundle'), val('site'), val('attester')]).toEqual(['base', uid, 'evidence-corvo-edge-20261106.json', 'https://lights-on-watch.vercel.app', watcher]);
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

describe('NightDrawer proof section', () => {
  const P = (b: string) => `0x${b.repeat(32)}`;
  const night = {
    night: 20261106, status: 'shipped' as const, observed: true, alsoReconstructed: false, summary: null, templateSummary: null,
    notable: [], reasons: ['liveapp.new_deploy'], evidenceHash: P('0b'), attestationUid: P('0c'), attestTx: P('0d'),
    attestProof: [P('01'), P('02'), P('03')], attestRoot: P('0e'), attestLit30: 4, manifestHash: P('0f'),
    reconstructedFrom: null, note: null, founderNotes: [],
  };
  it('names the root attestation, the proof length and the root, and links the night manifest', () => {
    const html = renderToStaticMarkup(createElement(NightDrawer, { slug: 'rc', night, watcher: null, onClose: () => undefined }));
    expect(html).toContain('Root attestation');
    expect(html).toContain(`3 steps → root <code>${P('0e').slice(0, 10)}…${P('0e').slice(-6)}</code>`);
    expect(html).toContain(`attested in tx <code>${P('0d').slice(0, 10)}…${P('0d').slice(-6)}</code>`);
    expect(html).toContain(`href="/api/v1/manifest/${P('0f')}"`);
    expect(html).toContain('View night manifest');
    expect(html).toContain('Lit30 in the leaf');
    expect(html).toContain('4 of the last 30 nights');
    expect(html).not.toContain('awaiting confirmation');
  });
  it('a tx without a uid yet is sent, awaiting confirmation, never "attested"', () => {
    const pending = { ...night, attestationUid: null };
    const html = renderToStaticMarkup(createElement(NightDrawer, { slug: 'rc', night: pending, watcher: null, onClose: () => undefined }));
    expect(html).toContain(`sent in tx <code>${P('0d').slice(0, 10)}…${P('0d').slice(-6)}</code>, awaiting confirmation`);
    expect(html).not.toContain('attested in tx');
  });
  it('a reconstructed night shows neither', () => {
    const rec = { ...night, observed: false, attestationUid: null, attestTx: null, attestProof: null, attestRoot: null, attestLit30: null, manifestHash: null };
    const html = renderToStaticMarkup(createElement(NightDrawer, { slug: 'rc', night: rec, watcher: null, onClose: () => undefined }));
    expect(html).not.toContain('Merkle proof');
    expect(html).not.toContain('View night manifest');
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

describe('/docs', () => {
  it('lists every built endpoint as live and nothing as planned', async () => {
    const { default: DocsPage } = await import('@/app/docs/page');
    const { GET: openapi } = await import('@/app/api/openapi.json/route');
    const html = renderToStaticMarkup(DocsPage());
    expect(html).not.toMatch(/planned/i);
    const paths = Object.keys(JSON.parse(await openapi().text()).paths as Record<string, unknown>);
    for (const p of paths) expect(html).toContain(p.replace(/\{(\w+)\}/g, '{$1}'));
    for (const t of ['/api/mcp', '/llms.txt', '/api/openapi.json', 'POST /api/v1/watch', 'agent-registration.json']) expect(html).toContain(t);
  });

  it('documents claiming, notes, drafts and the badge for founders', async () => {
    const { default: DocsPage } = await import('@/app/docs/page');
    const { WELL_KNOWN_PATH, NOTE_MAX } = await import('@/lib/claim');
    const html = renderToStaticMarkup(DocsPage());
    expect(html).toContain('id="claim"');
    expect(html).toContain('href="#claim"');
    for (const t of [WELL_KNOWN_PATH, 'lights-on-claim=', '/claim/&lt;slug&gt;', '/badge/&lt;slug&gt;', String(NOTE_MAX)]) expect(html).toContain(t);
    expect(html).toMatch(/never change(s)? the status/i);
  });
});
