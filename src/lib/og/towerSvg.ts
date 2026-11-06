import type { Status } from '@/lib/types';

const FILL: Record<Status, string> = {
  shipped: '#9fb6d9',
  building: 'rgba(139,115,80,0.88)',
  quiet: '#1a2436',
  down: '#1b1b25',
  unavailable: '#0e141e',
};

/**
 * A static render of the building (same grammar as the canvas: 9 x 10 lites per window, oldest top left, the latest
 * night bottom right, vacant bays as empty frames) for share images. Every lit lite is a real row.
 */
export function towerSvg(
  projects: { history: (Status | null)[] }[],
  opts: { width: number; height: number; cols?: number; rows?: number } = { width: 1080, height: 300 },
): string {
  const cols = opts.cols ?? 12;
  const rows = opts.rows ?? 3;
  const L = 4;
  const Lh = 5;
  const m = 1;
  const F = 2;
  const R = 3;
  const W = 9 * L + 8 * m + 2 * F;
  const H = 10 * Lh + 8 * m + R + 2 * F;
  const p = 20;
  const pg = 40;
  const pe = 30;
  const groups = cols / 4;
  const bw = cols * W + (cols - groups) * p + (groups - 1) * pg + 2 * pe;
  const bx = Math.round((opts.width - bw) / 2);
  const cornice = 24;
  const pitch = H + 3 + 16;
  const parts: string[] = [];
  parts.push(
    `<defs><linearGradient id="mass" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0f1520"/><stop offset="1" stop-color="#0a0e16"/></linearGradient>` +
      `<radialGradient id="ship"><stop offset="0" stop-color="#c6d6f0" stop-opacity=".55"/><stop offset="1" stop-color="#c6d6f0" stop-opacity="0"/></radialGradient>` +
      `<radialGradient id="warm"><stop offset="0" stop-color="#8b7350" stop-opacity=".45"/><stop offset="1" stop-color="#8b7350" stop-opacity="0"/></radialGradient></defs>`,
  );
  parts.push(`<rect x="${bx}" y="0" width="${bw}" height="${opts.height}" fill="url(#mass)"/>`);
  parts.push(`<rect x="${bx - 8}" y="0" width="${bw + 16}" height="8" fill="#131a27"/><rect x="${bx - 8}" y="0" width="${bw + 16}" height="1" fill="#afc6eb" fill-opacity=".24"/>`);
  const glows: string[] = [];
  for (let b = 0; b < cols * rows; b++) {
    const c = b % cols;
    const r = Math.floor(b / cols);
    const gi = Math.floor(c / 4);
    const x = bx + pe + c * W + (c - gi) * p + gi * pg;
    const y = cornice + r * pitch;
    const proj = projects[b];
    parts.push(`<rect x="${x - 2}" y="${y - 2}" width="${W + 4}" height="${H + 2}" fill="#05080d"/>`);
    parts.push(`<rect x="${x - 3}" y="${y + H}" width="${W + 6}" height="3" fill="#141c2a"/>`);
    if (!proj) {
      parts.push(`<rect x="${x}" y="${y}" width="${W}" height="${H}" fill="#0c121c"/><rect x="${x + F}" y="${y + F}" width="${W - 2 * F}" height="${H - 2 * F}" fill="#070a10"/>`);
      continue;
    }
    parts.push(`<rect x="${x}" y="${y}" width="${W}" height="${H}" fill="#0b111b"/>`);
    for (let n = 0; n < 90; n++) {
      const j = Math.floor(n / 9);
      const lx = x + F + (n % 9) * (L + m);
      const ly = y + F + j * (Lh + m) + (j >= 5 ? R - m : 0);
      const st = proj.history[n] ?? null;
      parts.push(`<rect x="${lx}" y="${ly}" width="${L}" height="${Lh}" fill="${st ? FILL[st] : '#0e141e'}"/>`);
      if (n === 89 && (st === 'shipped' || st === 'building')) {
        glows.push(`<circle cx="${lx + L / 2}" cy="${ly + Lh / 2}" r="${st === 'shipped' ? 34 : 18}" fill="url(#${st === 'shipped' ? 'ship' : 'warm'})"/>`);
        if (st === 'shipped') parts.push(`<rect x="${lx}" y="${ly}" width="${L}" height="${Lh}" fill="#ecf3ff"/>`);
      }
    }
    parts.push(`<rect x="${x + F}" y="${y + F + 5 * Lh + 4 * m}" width="${W - 2 * F}" height="1" fill="#a0b9e1" fill-opacity=".16"/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${opts.width}" height="${opts.height}" viewBox="0 0 ${opts.width} ${opts.height}">${parts.join('')}${glows.join('')}</svg>`;
}
