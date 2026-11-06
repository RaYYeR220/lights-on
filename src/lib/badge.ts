import type { Record30, Status } from '@/lib/types';

const INK = '#14181c';
const PAPER = '#f2efe6';
const FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function svg(text: string, lit: boolean): string {
  const w = Math.ceil(text.length * 6.6) + 38;
  const dot = lit
    ? `<circle cx="14" cy="12" r="4.5" fill="${PAPER}"/>`
    : `<circle cx="14" cy="12" r="3.5" fill="none" stroke="${PAPER}" stroke-width="1.5"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="24" viewBox="0 0 ${w} 24" role="img" aria-label="${esc(text)}">`
    + `<title>${esc(text)}</title>`
    + `<rect width="${w}" height="24" rx="12" fill="${INK}"/>`
    + dot
    + `<text x="26" y="16" fill="${PAPER}" font-family='${FONT}' font-size="11" font-weight="600">${esc(text)}</text>`
    + `</svg>`;
}

/** Two-colour status badge: dot filled when the latest night was lit (shipped/building), ring otherwise. */
export function renderBadge(record: Record30, status: Status): string {
  return svg(`lights on · lit ${record.lit30}/30`, status === 'shipped' || status === 'building');
}

export function renderNotWatched(): string {
  return svg('lights on · not watched', false);
}
