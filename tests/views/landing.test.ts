import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { makeTestDb } from '../helpers/db';
import type { Db } from '@/lib/db';
import { insertNight, upsertProject } from '@/lib/db/queries';
import { resetApiCache } from '@/lib/apiCache';

/** The landing reads the tower through getDb(); each test points it at its own pglite (or at nothing). */
const h = vi.hoisted(() => ({ db: null as Db | null }));
vi.mock('@/lib/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/db')>()),
  getDb: async () => {
    if (!h.db) throw new Error('no database in this test');
    return h.db;
  },
}));

const { default: Home } = await import('@/app/page');

const NOW = new Date('2026-11-06T12:00:00Z');

/** The outer HTML of the first <section> whose opening tag matches `open`, nested sections included. */
function sectionHtml(html: string, open: RegExp): string {
  const m = open.exec(html);
  if (!m) throw new Error(`no section matching ${open}`);
  const tag = /<section\b|<\/section>/g;
  tag.lastIndex = m.index + 1;
  let depth = 1;
  for (let t = tag.exec(html); t; t = tag.exec(html)) {
    depth += t[0] === '</section>' ? -1 : 1;
    if (depth === 0) return html.slice(m.index, t.index + '</section>'.length);
  }
  throw new Error('unclosed section');
}
const HERO = /<section[^>]*aria-labelledby="hero-title"[^>]*>/;
const regionOf = (html: string, heading: string) => {
  const id = new RegExp(`<h2[^>]*id="([^"]+)"[^>]*>${heading}</h2>`).exec(html)?.[1];
  if (!id) throw new Error(`no h2 "${heading}"`);
  return sectionHtml(html, new RegExp(`<section[^>]*aria-labelledby="${id}"[^>]*>`));
};

async function renderHome(): Promise<string> {
  return renderToStaticMarkup(await Home());
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  resetApiCache();
  h.db = null;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function seed(): Promise<void> {
  const db = await makeTestDb();
  const raise = await upsertProject(db, {
    slug: 'some-raise', name: 'Some Raise', source: 'vibestarter',
    vibestarter: { campaignId: 'c1', escrow: '0xe', founderWallet: '0xf' },
  });
  const app = await upsertProject(db, { slug: 'an-app', name: 'An App', source: 'base' });
  await insertNight(db, { projectId: app.id, night: '2026-11-06', status: 'shipped', observed: true, attestationUid: '0x01' });
  await insertNight(db, { projectId: raise.id, night: '2026-11-06', status: 'quiet', observed: true, attestationUid: '0x01' });
  await insertNight(db, { projectId: raise.id, night: '2026-11-05', status: 'building', observed: false });
  h.db = db;
}

describe('the landing', () => {
  it('keeps the approved hero fold byte for byte', async () => {
    await seed();
    const html = await renderHome();
    expect(sectionHtml(html, HERO)).toMatchSnapshot();
  });

  it('keeps the hero fold when the building cannot be loaded', async () => {
    const html = await renderHome();
    expect(sectionHtml(html, HERO)).toMatchSnapshot();
  });

  it('explains itself below the fold: how a night works, who it is for and why now, after the hero, with the study strip kept', async () => {
    await seed();
    const html = await renderHome();
    const heroEnd = html.indexOf(sectionHtml(html, HERO)) + sectionHtml(html, HERO).length;
    const at = (needle: string) => {
      const i = html.indexOf(needle);
      expect(i, needle).toBeGreaterThan(-1);
      return i;
    };
    const how = at('>How a night works</h2>');
    const who = at('>Who it&#x27;s for</h2>');
    const why = at('>Why now</h2>');
    const strip = at('aria-label="From the study"');
    for (const i of [how, who, why, strip]) expect(i).toBeGreaterThan(heroEnd);
    expect(how).toBeLessThan(who);
    expect(who).toBeLessThan(why);
  });

  it('links the Vibestarter raise it reads from the tower data, not a hardcoded one', async () => {
    await seed();
    const who = regionOf(await renderHome(), 'Who it&#x27;s for');
    expect(who).toMatch(/<a[^>]*href="\/p\/some-raise"[^>]*>See Some Raise/);
    expect(who).not.toContain('href="/p/corvo-edge"');
  });

  it('still explains itself when the building cannot be loaded', async () => {
    const html = await renderHome();
    for (const heading of ['How a night works', 'Who it&#x27;s for', 'Why now']) expect(regionOf(html, heading)).toContain('href="/');
    expect(regionOf(html, 'Who it&#x27;s for')).not.toContain('href="/p/');
  });
});
