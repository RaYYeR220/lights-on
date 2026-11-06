import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LandingSections, raiseOf, type Raise } from '@/components/landing/LandingSections';
import type { TowerProject } from '@/lib/views/tower';

const APP = path.resolve(__dirname, '../../src/app');
const render = (raise: Raise | null) => renderToStaticMarkup(createElement(LandingSections, { raise }));
const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
/** Visible text: tags dropped, entities decoded. */
const textOf = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

/** The page.tsx or route.ts under src/app that serves `pathname` (a dynamic [segment] matches any value), or null. */
function routeFile(pathname: string): string | null {
  let dir = APP;
  for (const seg of pathname.split('/').filter(Boolean)) {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
    const hit = entries.find((e) => e.name === seg) ?? entries.find((e) => /^\[[^.\]]+\]$/.test(e.name));
    if (!hit) return null;
    dir = path.join(dir, hit.name);
  }
  for (const f of ['page.tsx', 'route.ts']) {
    const file = path.join(dir, f);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

const SECTIONS = [
  ['how-h', 'How a night works'],
  ['who-h', 'Who it&#x27;s for'],
  ['why-h', 'Why now'],
] as const;

describe('the landing sections below the fold', () => {
  const html = render({ slug: 'corvo-edge', name: 'Corvo Edge' });

  it('are three labelled regions, each with a real h2', () => {
    for (const [id, heading] of SECTIONS) {
      expect(html).toContain(`<h2 id="${id}" class=`);
      expect(html).toMatch(new RegExp(`<h2 id="${id}"[^>]*>${heading}</h2>`));
      expect(html).toMatch(new RegExp(`<section[^>]*aria-labelledby="${id}"`));
    }
    expect(html.match(/<section/g)).toHaveLength(3);
  });

  it('a night is read, decide, explain, attest, in that order, as a list of lit steps', () => {
    const how = html.slice(html.indexOf('id="how-h"'), html.indexOf('id="who-h"'));
    const steps = [...how.matchAll(/<h3[^>]*>([^<]+)<\/h3>/g)].map((m) => m[1]);
    expect(steps).toEqual(['Read', 'Decide', 'Explain', 'Attest']);
    expect(how).toMatch(/<ol[^>]*>/);
    expect(how.match(/<li/g)).toHaveLength(4);
    expect(how.match(/data-state="ok"/g)).toHaveLength(4);
  });

  it('says what the brief and CLAIMS.md say, in their order: rules decide, AI only explains, one root per night', () => {
    const t = textOf(html);
    expect(t).toMatch(/shipped beats building, building beats down and down beats quiet/i);
    expect(t).toMatch(/never decides/i);
    expect(t).toMatch(/one Merkle root per night on Base/i);
    expect(t).toMatch(/ERC-8004/);
    expect(t).toMatch(/is_still_shipping/);
    expect(t).toMatch(/get_night/);
    expect(t).toMatch(/llms\.txt/);
    expect(t).toMatch(/reported, never counted/i);
  });

  it('every link points to a route that exists, and every #anchor to an id on that page', () => {
    const links = hrefs(html);
    expect(links.length).toBeGreaterThanOrEqual(8);
    for (const href of links) {
      expect(href, href).toMatch(/^\/[^/]/);
      const [pathname, anchor] = href.split('#');
      const file = routeFile(pathname);
      expect(file, `${href}: no page or route under src/app`).not.toBeNull();
      if (anchor) expect(fs.readFileSync(file!, 'utf8'), `${href}: no id="${anchor}"`).toContain(`id="${anchor}"`);
    }
    for (const want of ['/methodology#tiers', '/methodology#rules', '/methodology#attestation', '/night', '/b', '/p/corvo-edge', '/add', '/docs#mcp', '/docs#api']) {
      expect(links).toContain(want);
    }
  });

  it('names the raise it links to, from the data', () => {
    const who = html.slice(html.indexOf('id="who-h"'), html.indexOf('id="why-h"'));
    expect(who).toMatch(/<a[^>]*href="\/p\/corvo-edge"[^>]*>See Corvo Edge/);
  });

  it('without a raise in the data, the raise card links somewhere real instead of a guessed slug', () => {
    const none = render(null);
    expect(hrefs(none).filter((h) => h.startsWith('/p/'))).toEqual([]);
    for (const href of hrefs(none)) expect(routeFile(href.split('#')[0]), href).not.toBeNull();
  });

  it('copy rules: no banned words, no hype, no hand-typed numbers', () => {
    const t = textOf(html);
    expect(t).not.toMatch(/\b(abandoned|dead|scam|inactive)\b/i);
    expect(t).not.toMatch(/\b(revolutionary|seamless|powerful)\b|AI-powered/i);
    expect(t).not.toMatch(/\$\s?\d|\bcents?\b/i);
    // the only digits are names and the shift's fixed hour, never a count
    expect(t.replace(/ERC-8004|05:00 UTC/g, '')).not.toMatch(/\d/);
  });
});

describe('raiseOf', () => {
  const p = (slug: string, source: TowerProject['source']) => ({ slug, name: slug.toUpperCase(), source }) as TowerProject;
  it('is the first Vibestarter raise in tower order, or null', () => {
    expect(raiseOf({ projects: [p('a', 'base'), p('r1', 'vibestarter'), p('r2', 'vibestarter')] })).toEqual({ slug: 'r1', name: 'R1' });
    expect(raiseOf({ projects: [p('a', 'base'), p('b', 'vibeathon01')] })).toBeNull();
    expect(raiseOf(null)).toBeNull();
  });
});
