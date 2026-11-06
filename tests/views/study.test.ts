import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import field from '../../results/study-field.json';
import v01 from '../../results/study-vibeathon01.json';
import cvs from '../../results/commit-vs-ship.json';
import headline from '../../results/headline.json';
import { HEADLINE_TEMPLATES, fillTemplate } from '@/lib/study';
import { parseStudyResults } from '@/lib/studyResults';
import { getStudyView, studyView } from '@/lib/views/study';
import { StudyBody } from '@/components/study/StudyBody';
import { StudyStrip } from '@/components/study/StudyStrip';

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const text = (id: string) => headline.candidates.find((c) => c.id === id)!.text;
const BANNED = /\b(abandoned|dead|scam|inactive|rug|fraud)\b/i;

/** A consistent results set with other numbers: the headline candidates are refilled from it the way scripts/study.ts does. */
function fixture() {
  const f = clone(field);
  f.hackathon = { ...f.hackathon, n: 40, withHistory: 40, active30: 7, shipped30: 2, quiet30: 33, noActivityInHistory: 20 };
  f.reference = { ...f.reference, active30: 5, shipped30: 4, quiet30: 3 };
  const v = clone(v01);
  v.resultsDate = '2026-08-09';
  v.daysSinceResults = 89;
  v.perProject[0].liveUp = false; // Onetoken
  v.perProject[2].liveUp = false; // Corvo Edge
  v.perProject[9].name = 'Nonesuch'; // not a watched project: rendered without a link
  v.summary = { ...v.summary, liveUp: 6 };
  const c = clone(cvs);
  c.withHistory = 50;
  c.commitsNoVerifiedShip = ['Coal', 'BasedBills'];
  c.shipNightsWithoutCodeCommits = [{ name: 'Revoke.cash', nights: 1 }];
  const data = { field: f, vibeathon01: v, commitVsShip: c };
  const h = { ...clone(headline), candidates: HEADLINE_TEMPLATES.map((t) => fillTemplate(t.id, t.template, data)) };
  return { f, v, c, h };
}

describe('studyView over the committed results', () => {
  const view = getStudyView();

  it('quotes the headline candidates verbatim and the basis, dates and window from the JSON', () => {
    expect(view.headline).toBe(text('hackathon-quiet'));
    expect(view.contrast).toBe(text('reference-vs-hackathon'));
    expect(view.v01.sentence).toBe(text('v01-still-lit'));
    expect(view.cvs.commits.heading).toBe(text('commit-no-ship'));
    expect(view.basis).toBe(headline.basis);
    expect(view.basis).toBe('reconstructed history (git + Wayback), not attested');
    expect(view.asOf).toBe(headline.asOf);
    expect(view.window30From).toBe(headline.window30From);
    expect(view.latestNight).toBe(headline.latestNight);
    expect(view.windowNights).toBe(30);
  });

  it('one window per project with history, lit for each active one; counts equal the JSON', () => {
    expect(view.cohorts.map((c) => c.id)).toEqual(['hackathon', 'reference', 'vibestarter', 'vibeathon01']);
    for (const c of view.cohorts) {
      const j = field[c.id];
      expect(c).toMatchObject({ n: j.n, withHistory: j.withHistory, active30: j.active30, shipped30: j.shipped30 });
      expect(c.windows).toHaveLength(j.withHistory);
      expect(c.windows.filter((w) => w !== 'quiet')).toHaveLength(j.active30);
      expect(c.windows.filter((w) => w === 'shipped')).toHaveLength(j.shipped30);
      expect(c.count).toBe(`${j.active30} of ${j.withHistory} active in the last 30 nights`);
      expect(c.ariaLabel).toContain(c.label);
      expect(c.ariaLabel).toContain(c.count);
    }
    const ref = view.cohorts.find((c) => c.id === 'reference')!;
    const hack = view.cohorts.find((c) => c.id === 'hackathon')!;
    expect(ref.count).toBe('8 of 8 active in the last 30 nights');
    expect(hack.count).toBe('3 of 33 active in the last 30 nights');
    // finalists without usable history are counted apart, never drawn as dark windows
    expect(view.cohorts.find((c) => c.id === 'vibeathon01')!.withoutHistory).toBe(field.vibeathon01.n - field.vibeathon01.withHistory);
  });

  it('maps the 10 finalists: yes / no / unknown, never a guess, and links watched projects', () => {
    expect(view.v01.heading).toBe(`Vibeathon 01, ${v01.daysSinceResults} days later`);
    expect(view.v01.summary).toBe(`${v01.summary.liveUp} of ${v01.summary.finalists} live apps still answer`);
    expect(view.v01.summary).toBe('8 of 10 live apps still answer');
    expect(view.v01.liveUpBasis).toBe(v01.liveUpBasis);
    expect(view.v01.rows).toHaveLength(10);
    const row = (name: string) => view.v01.rows.find((r) => r.name === name)!;
    expect(row('aHand')).toEqual({
      name: 'aHand', href: '/p/ahand', liveUp: 'yes', publicRepo: 'yes', coverage: 'full window', active30: 'no',
      lastActivity: '2026-09-15', lastActivityText: '15 Sep 2026',
    });
    expect(row('Onetoken')).toMatchObject({ href: '/p/onetoken', publicRepo: 'no', coverage: 'no public history', active30: 'unknown', lastActivity: null });
    expect(row('Agent Verse')).toMatchObject({ href: '/p/agent-verse', liveUp: 'no' });
    expect(row('Grayl AI')).toMatchObject({ href: '/p/grayl-ai', active30: 'no', lastActivity: null, lastActivityText: 'none seen' });
    expect(row('Lineage').lastActivityText).toBe('unknown');
    for (const r of view.v01.rows) {
      const j = v01.perProject.find((p) => p.name === r.name)!;
      expect(r.active30).toBe(j.active30 === null ? 'unknown' : j.active30 ? 'yes' : 'no');
    }
  });

  it('names both commit-vs-ship groups, linked when watched, with the definitions as captions', () => {
    expect(view.cvs.commits.items.map((i) => i.name)).toEqual(cvs.commitsNoVerifiedShip);
    expect(view.cvs.commits.items.find((i) => i.name === 'CoW Swap')!.href).toBe('/p/cow-swap');
    expect(view.cvs.commits.caption).toBe(cvs.definition.commitsNoVerifiedShip);
    expect(view.cvs.ships.heading).toBe(`${cvs.shipNightsWithoutCodeCommits.length} projects shipped on nights with no code commits`);
    expect(view.cvs.ships.items.map((i) => [i.name, i.nights])).toEqual(cvs.shipNightsWithoutCodeCommits.map((s) => [s.name, s.nights]));
    expect(view.cvs.ships.items.find((i) => i.name === 'Safe{Wallet}')).toMatchObject({ href: '/p/safe-wallet', nightsText: '2 nights' });
    expect(view.cvs.ships.caption).toBe(cvs.definition.shipNightsWithoutCodeCommits);
    expect(view.cvs.why).toBe('A commit graph would call the first group active and the second idle; Lights On checks what reached users.');
    expect(view.method.windows).toBe(cvs.definition.windows);
    expect(view.method.observed).toBe(`From ${headline.asOf} on, nights are observed and attested on Base; the study is recomputed as observed nights accumulate.`);
    expect(view.method.command).toBe('pnpm tsx scripts/study.ts');
    expect(view.method.sourceUrl).toBe('https://github.com/RaYYeR220/lights-on/blob/main/scripts/study.ts');
  });
});

describe('nothing is typed by hand', () => {
  it('other numbers in the JSON change every sentence that carries one', () => {
    const { f, v, c, h } = fixture();
    const view = studyView(f, v, c, h);
    expect(view.headline).toBe('33 of 40 hackathon builds on Base showed no detected commit or deploy activity in the last 30 nights.');
    expect(view.contrast).toBe('5 of 8 big reference apps showed detected commit or deploy activity in the last 30 nights, against 7 of 40 hackathon builds.');
    expect(view.cohorts.find((x) => x.id === 'hackathon')!.count).toBe('7 of 40 active in the last 30 nights');
    expect(view.cohorts.find((x) => x.id === 'hackathon')!.windows).toHaveLength(40);
    expect(view.v01.heading).toBe('Vibeathon 01, 89 days later');
    expect(view.v01.sentence).toContain('(89 days after the results)');
    expect(view.v01.summary).toBe('6 of 10 live apps still answer');
    expect(view.v01.rows.find((r) => r.name === 'Nonesuch')!.href).toBeNull();
    expect(view.cvs.commits.heading).toBe('2 of 50 projects with a full 30-night window had commits but no detected deploy.');
    expect(view.cvs.commits.items.map((i) => i.href)).toEqual(['/p/coal', '/p/basedbills']);
    expect(view.cvs.ships.heading).toBe('1 project shipped on nights with no code commits');
    expect(view.cvs.ships.items[0]).toMatchObject({ name: 'Revoke.cash', nightsText: '1 night' });
  });

  it('the rendered page follows the fixture and keeps none of the committed numbers', () => {
    const { f, v, c, h } = fixture();
    const html = renderToStaticMarkup(createElement(StudyBody, { view: studyView(f, v, c, h) }));
    expect(html).toContain('33 of 40 hackathon builds on Base');
    expect(html).toContain('6 of 10 live apps still answer');
    expect(html).toContain('Vibeathon 01, 89 days later');
    expect(html).toContain('>Nonesuch<');
    expect(html).not.toContain('href="/p/nonesuch"');
    for (const real of ['30 of 33', '3 of 33', '8 of 10 live apps', '5 of 46', '99 days', '5 projects shipped']) expect(html).not.toContain(real);
  });
});

describe('the JSON is validated', () => {
  it('accepts the committed files', () => {
    expect(() => parseStudyResults({ field, vibeathon01: v01, commitVsShip: cvs, headline })).not.toThrow();
  });

  it('rejects a malformed file and names it', () => {
    const noCohort = clone(field) as Partial<typeof field>;
    delete noCohort.hackathon;
    expect(() => studyView(noCohort, v01, cvs, headline)).toThrow(/study-field\.json/);
    expect(() => studyView({ ...field, reference: { ...field.reference, active30: '8' } }, v01, cvs, headline)).toThrow(/study-field\.json/);
    const badCoverage = clone(v01);
    (badCoverage.perProject[0] as { coverage: string }).coverage = 'maybe';
    expect(() => studyView(field, badCoverage, cvs, headline)).toThrow(/study-vibeathon01\.json/);
    expect(() => studyView(field, v01, { ...cvs, shipNightsWithoutCodeCommits: [{ name: 'X' }] }, headline)).toThrow(/commit-vs-ship\.json/);
    expect(() => studyView(field, v01, cvs, { ...headline, candidates: headline.candidates.filter((x) => x.id !== 'v01-still-lit') })).toThrow(/headline\.json.*v01-still-lit/);
    expect(() => studyView(field, v01, cvs, { ...headline, basis: undefined })).toThrow(/headline\.json/);
  });

  it('rejects files that contradict themselves or each other', () => {
    // an unknown finalist counted as quiet
    const quietUnknown = clone(v01);
    (quietUnknown.perProject[0] as { active30: boolean | null }).active30 = false;
    expect(() => studyView(field, quietUnknown, cvs, headline)).toThrow(/study-vibeathon01\.json/);
    // a summary that does not add up
    expect(() => studyView(field, { ...v01, summary: { ...v01.summary, liveUp: 9 } }, cvs, headline)).toThrow(/study-vibeathon01\.json/);
    expect(() => studyView({ ...field, hackathon: { ...field.hackathon, quiet30: 29 } }, v01, cvs, headline)).toThrow(/study-field\.json/);
    // a window that is not the 30 nights ending at latestNight
    expect(() => studyView({ ...field, window30From: '2026-10-01' }, v01, cvs, headline)).toThrow(/study-field\.json/);
    // files from different study runs
    expect(() => studyView(field, { ...v01, asOf: '2026-11-07' }, cvs, headline)).toThrow(/asOf/);
    // a headline sentence whose numbers are stale against the files
    const stale = { ...field, hackathon: { ...field.hackathon, active30: 4, quiet30: 29 } };
    expect(() => studyView(stale, v01, cvs, headline)).toThrow(/headline\.json.*hackathon-quiet/);
    // a number edited by hand inside a sentence, values left alone
    const edited = { ...headline, candidates: headline.candidates.map((x) => (x.id === 'hackathon-quiet' ? { ...x, text: x.text.replace('30 of', '31 of') } : x)) };
    expect(() => studyView(field, v01, cvs, edited)).toThrow(/headline\.json.*hackathon-quiet.*template/);
  });
});

describe('copy', () => {
  it('the page and the landing strip use none of the banned words', () => {
    const view = getStudyView();
    const page = renderToStaticMarkup(createElement(StudyBody, { view }));
    const strip = renderToStaticMarkup(createElement(StudyStrip, { view }));
    expect(page).not.toMatch(BANNED);
    expect(strip).not.toMatch(BANNED);
    expect(strip).toContain(text('hackathon-quiet'));
    expect(strip).toContain('href="/study"');
    expect(strip).toContain('Read the study');
  });

  it('the page is accessible: a real table with scoped headers, a labelled row per cohort, the anchor for /study/vibeathon-01', () => {
    const view = getStudyView();
    const html = renderToStaticMarkup(createElement(StudyBody, { view }));
    expect(html).toContain('id="vibeathon-01"');
    expect(html.match(/<th scope="col"/g)).toHaveLength(6);
    expect(html.match(/<th scope="row"/g)).toHaveLength(10);
    for (const c of view.cohorts) expect(html).toContain(`aria-label="${c.ariaLabel}"`);
    expect(html).toContain(view.v01.liveUpBasis);
    expect(html).toContain('href="/methodology#reconstructed"');
    expect(html).toContain('href="/night"');
    expect(html).toContain('href="https://github.com/RaYYeR220/lights-on/blob/main/scripts/study.ts"');
  });
});
