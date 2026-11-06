import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb } from '../helpers/db';
import type { Db } from '@/lib/db';
import { createNightlyShift, insertNight, saveEvidence, upsertProject } from '@/lib/db/queries';
import { getProjectView } from '@/lib/views/project';
import { getNightView } from '@/lib/views/night';
import { openWindowOf, parseCampaigns } from '@/lib/views/vibestarterLive';
import { founderNotes } from '@/lib/db/schema';
import { nightLabel, parseNightParam, reasonLines, reasonText } from '@/lib/views/reasons';
import { telegramLink, telegramProjectToken, telegramStartToken, shortAddress } from '@/lib/views/backer';
import { NOTE_REASONS, REASONS } from '@/lib/shift/rules';
import type { EvidenceBundle } from '@/lib/types';

let db: Db;
beforeEach(async () => { db = await makeTestDb(); });
const NOW = new Date('2026-11-06T12:00:00Z');

describe('reasons', () => {
  it('every reason code the rules emit has plain words', () => {
    for (const code of [...REASONS, ...NOTE_REASONS]) expect(reasonText(code)).not.toBe(code);
    expect(reasonText('something.new')).toBe('something.new');
  });
  it('keeps order, drops duplicates and non-strings', () => {
    expect(reasonLines(['repo.release', 7, 'repo.release', 'liveapp.blocked']).map((r) => r.code)).toEqual(['repo.release', 'liveapp.blocked']);
    expect(reasonLines(null)).toEqual([]);
  });
  it('parses only real calendar dates', () => {
    expect(parseNightParam('2026-11-06')).toBe(20261106);
    expect(parseNightParam('2026-02-30')).toBeNull();
    expect(parseNightParam('20261106')).toBeNull();
    expect(nightLabel(20261106, true)).toBe('6 Nov 2026');
  });
});

describe('telegram deep link', () => {
  it('uses a_<40 hex> / p_<slug> payloads that fit in 64 characters', () => {
    const a = '0x60BC5323c0e0e9144af0b35ce8de119fc743e345';
    expect(telegramStartToken(a)).toBe('a_60bc5323c0e0e9144af0b35ce8de119fc743e345');
    expect(telegramProjectToken('corvo-edge')).toBe('p_corvo-edge');
    expect(telegramLink('a_60bc', 'LightsOnBot')).toBe('https://t.me/LightsOnBot?start=a_60bc');
    expect(telegramLink('a_60bc', '@LightsOnBot')).toBe('https://t.me/LightsOnBot?start=a_60bc');
    expect(telegramLink('a_60bc', undefined)).toBeNull();
    expect(telegramLink(`p_${'x'.repeat(70)}`, 'LightsOnBot')).toBeNull();
    expect(shortAddress(a)).toBe('0x60BC…e345');
  });
});

describe('getProjectView', () => {
  it('builds the 90-night strip with observed rows first and reconstructed provenance', async () => {
    const p = await upsertProject(db, { slug: 'rc', name: 'RC', source: 'base', repo: 'o/r', repoHost: 'github', liveUrl: 'https://rc.example' });
    await insertNight(db, { projectId: p.id, night: '2026-11-06', status: 'building', observed: false, signals: { source: 'git', reasons: ['repo.code_commits'] } });
    await insertNight(db, { projectId: p.id, night: '2026-11-06', status: 'shipped', observed: true, summary: 'Shipped a new <b>swap</b> page.', aiModel: 'm', signals: { reasons: ['liveapp.new_deploy'] }, attestationUid: '0xuid', attestTx: '0xtx' });
    await insertNight(db, { projectId: p.id, night: '2026-11-05', status: 'shipped', observed: false, signals: { source: 'git+wayback', note: 'deploy between a and b', reasons: ['liveapp.new_deploy'] } });
    const v = (await getProjectView(db, 'rc', { now: NOW }))!;
    expect(v.strip).toHaveLength(90);
    const last = v.strip[89];
    expect(last).toMatchObject({ night: 20261106, status: 'shipped', observed: true, alsoReconstructed: true, attestationUid: '0xuid', attestTx: '0xtx', reasons: ['liveapp.new_deploy'] });
    expect(last.summary).toBe('Shipped a new swap page.');
    const prev = v.strip[88];
    expect(prev).toMatchObject({ status: 'shipped', observed: false, reconstructedFrom: 'git+wayback', note: 'deploy between a and b', attestationUid: null });
    expect(v.strip[0].status).toBeNull();
    expect(v).toMatchObject({ status: 'shipped', statusObserved: true, statusNight: 20261106, streak: 2, lit30: 2, reconstructedNights: 1, repoUrl: 'https://github.com/o/r' });
    expect(v.vibestarterFacts).toBeNull();
  });

  it('a template summary is labelled apart from an AI one; unknown and hidden slugs are null', async () => {
    const p = await upsertProject(db, { slug: 'q', name: 'Q', source: 'base' });
    await insertNight(db, { projectId: p.id, night: '2026-11-06', status: 'quiet', observed: true, summary: 'No new code or deploy reached users in this window.', aiOk: true });
    const v = (await getProjectView(db, 'q', { now: NOW }))!;
    expect(v.strip[89].summary).toBeNull();
    expect(v.strip[89].templateSummary).toMatch(/No new code/);
    await upsertProject(db, { slug: 'h', name: 'H', source: 'base', hidden: true });
    expect(await getProjectView(db, 'h', { now: NOW })).toBeNull();
    expect(await getProjectView(db, 'nope', { now: NOW })).toBeNull();
  });

  it('reads the latest recorded Vibestarter facts for a campaign', async () => {
    const p = await upsertProject(db, { slug: 'v', name: 'V', source: 'vibestarter', vibestarter: { campaignId: 'c', escrow: '0xe', founderWallet: '0xf' } });
    const facts = { campaignId: 'c', raiseStatus: 'FUNDED', tranches: [{ index: 0, status: 'RELEASED', requestedAt: null, windowEndsAt: null, amountPaidWei: '1' }], openWindow: null, founderUpdates: [], reportedActivity: [] };
    const bundle = { v: 1, project: 'v', night: 20261104, sources: { repo: null, liveapp: null, chain: null, vibestarter: { source: 'vibestarter', tier: 'reported', ok: true, facts } } } as unknown as EvidenceBundle;
    await saveEvidence(db, '0xv', p.id, '2026-11-04', bundle);
    await insertNight(db, { projectId: p.id, night: '2026-11-04', status: 'quiet', observed: false, evidenceHash: '0xv' });
    const v = (await getProjectView(db, 'v', { now: NOW }))!;
    expect(v.vibestarterFacts?.night).toBe(20261104);
    expect(v.vibestarterFacts?.facts.raiseStatus).toBe('FUNDED');
  });
});

describe('project page extras', () => {
  it('founder notes land on their night; community and claim flags are exposed', async () => {
    const p = await upsertProject(db, { slug: 'cm', name: 'CM', source: 'community', claimedBy: '0xabc', claimVerifiedAt: new Date('2026-11-01T00:00:00Z') });
    await insertNight(db, { projectId: p.id, night: '2026-11-05', status: 'building', observed: true });
    await db.insert(founderNotes).values({ projectId: p.id, night: '2026-11-05', note: 'Shipped the fix behind a flag.', author: '0xabc', signature: '0x00' });
    const v = (await getProjectView(db, 'cm', { now: NOW }))!;
    expect(v.communityAdded).toBe(true);
    expect(v.claimedBy).toBe('0xabc');
    expect(v.strip[88].founderNotes).toEqual([expect.objectContaining({ note: 'Shipped the fix behind a flag.', author: '0xabc' })]);
    expect(v.strip[89].founderNotes).toEqual([]);
    // the note never changes the night's status
    expect(v.strip[88].status).toBe('building');
  });

  it('parses the live Vibestarter tranche schedule and finds an open challenge window', () => {
    const raw = { campaigns: [{ id: 'c1', status: 'FUNDED', contributorCount: 3, tranches: [
      { orderIndex: 1, status: 'REQUESTED', releasePercent: 15, requestedAt: '2026-11-13T12:00:00Z', challengeWindowEndsAt: '2026-11-16T12:00:00Z', amountPaid: null, _count: { challenges: 0 } },
      { orderIndex: 0, status: 'PAID', releasePercent: 10, isKickstart: true, requestedAt: null, challengeWindowEndsAt: null, amountPaid: '116964250000000000' },
      { status: 'LOCKED' },
    ] }, { nope: true }] };
    const m = parseCampaigns(raw, '2026-11-14T00:00:00.000Z');
    expect(Object.keys(m)).toEqual(['c1']);
    expect(m.c1.tranches.map((t) => [t.index, t.status])).toEqual([[0, 'PAID'], [1, 'REQUESTED']]);
    expect(m.c1.tranches[0].amountPaidWei).toBe('116964250000000000');
    expect(openWindowOf(m.c1.tranches, Date.parse('2026-11-14T00:00:00Z'))?.index).toBe(1);
    expect(openWindowOf(m.c1.tranches, Date.parse('2026-11-17T00:00:00Z'))).toBeNull();
    expect(parseCampaigns(null, 'x')).toEqual({});
  });
});

describe('getNightView', () => {
  it('before the first live shift: the newest reconstructed night, as a preview', async () => {
    const a = await upsertProject(db, { slug: 'a', name: 'A', source: 'base' });
    const b = await upsertProject(db, { slug: 'b', name: 'B', source: 'base' });
    await insertNight(db, { projectId: a.id, night: '2026-11-05', status: 'shipped', observed: false });
    await insertNight(db, { projectId: a.id, night: '2026-11-06', status: 'building', observed: false });
    await insertNight(db, { projectId: b.id, night: '2026-11-06', status: 'quiet', observed: false });
    const v = await getNightView(db);
    expect(v.mode).toBe('preview');
    expect(v.night).toBe(20261106);
    expect(v.latestObserved).toBeNull();
    expect(v.counts).toMatchObject({ building: 1, quiet: 1, shipped: 0 });
    expect(v.txs).toEqual([]);
    expect(v.rows.every((r) => !r.observed)).toBe(true);
  });

  it('a live night: observed rows only, the shift and its attestation txs, in confirmation order', async () => {
    const a = await upsertProject(db, { slug: 'a', name: 'A', source: 'base' });
    const b = await upsertProject(db, { slug: 'b', name: 'B', source: 'base' });
    const { shift } = await createNightlyShift(db, { night: '2026-11-06', startedAt: new Date('2026-11-06T05:00:00Z'), planned: 2 });
    await insertNight(db, { projectId: b.id, night: '2026-11-06', status: 'shipped', observed: true, shiftId: shift.id, attestTx: '0xaa', attestationUid: '0x1', notable: ['New pools page'] });
    await insertNight(db, { projectId: a.id, night: '2026-11-06', status: 'quiet', observed: true, shiftId: shift.id, attestTx: '0xaa', attestationUid: '0x2' });
    await insertNight(db, { projectId: a.id, night: '2026-11-06', status: 'building', observed: false });
    const v = await getNightView(db);
    expect(v.mode).toBe('observed');
    expect(v.rows.map((r) => r.slug)).toEqual(['b', 'a']);
    expect(v.rows.every((r) => r.observed)).toBe(true);
    expect(v.counts).toMatchObject({ shipped: 1, quiet: 1, building: 0 });
    expect(v.txs).toEqual(['0xaa']);
    expect(v.rows[0].whatShipped).toEqual(['New pools page']);
    expect(v.shift?.planned).toBe(2);
    // community-added projects are unlisted: never on the shift page
    const c = await upsertProject(db, { slug: 'c', name: 'C', source: 'community' });
    await insertNight(db, { projectId: c.id, night: '2026-11-06', status: 'shipped', observed: true, shiftId: shift.id });
    expect((await getNightView(db)).rows.map((r) => r.slug)).toEqual(['b', 'a']);
    // a date without a live shift is never shown as one
    const old = await getNightView(db, 20261101);
    expect(old.mode).toBe('empty');
    expect(old.prev).toBeNull();
    expect(old.next).toBe(20261106);
  });
});
