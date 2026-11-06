export interface GeometryInput {
  /** Facade width in CSS px (the page width without the scrollbar). */
  cssW: number;
  /** window.innerWidth: picks the column count. */
  vw: number;
  /** window.innerHeight: how many floors peek above the fold. */
  vh: number;
  dpr: number;
  /** Bays in the building (occupied + vacant). */
  nwin: number;
  /** Height of the rail above the canvas, CSS px. */
  railH: number;
}

export interface WindowRect {
  x: number;
  y: number;
  c: number;
  r: number;
}

export interface Geometry {
  dpr: number;
  cols: number;
  group: number;
  groups: number;
  mobile: boolean;
  /** device px: mullion, frame, meeting rail */
  m: number;
  F: number;
  R: number;
  /** lite width / height */
  L: number;
  Lh: number;
  /** window width / height */
  W: number;
  H: number;
  p: number;
  pg: number;
  pe: number;
  sill: number;
  ox: number;
  spandrel: number;
  pitch: number;
  spTop: number;
  cornice: number;
  rows: number;
  plinth: number;
  bw: number;
  bh: number;
  cw: number;
  ch: number;
  bx: number;
  by: number;
  win: WindowRect[];
  /** CSS px of the building shown above the fold (rail included). */
  peek: number;
}

/**
 * Building layout in integer device pixels, so every lite lands on whole pixels and stays crisp.
 * Self-contained on purpose (no outside references): its source is inlined into the landing's pre-paint script.
 */
export function computeGeometry(input: GeometryInput): Geometry {
  const dpr = Math.min(2, Math.max(1, input.dpr || 1));
  const cssW = input.cssW;
  const vw = input.vw;
  const nwin = input.nwin;
  const cols = vw >= 1000 ? 12 : vw >= 640 ? 8 : 4;
  const group = cols === 4 ? 2 : 4;
  const groups = cols / group;
  const mobile = cols === 4;
  const SCALE = mobile ? 1 : vw >= 1700 ? 0.93 : 0.86;
  const targetCss = mobile ? cssW - 32 : Math.min(1360, cssW * (cols === 12 ? 0.775 : 0.9)) * SCALE;
  const target = targetCss * dpr;
  const m = Math.max(1, Math.round(dpr));
  const F = Math.max(2, Math.round(2 * dpr));
  const R = Math.max(3, Math.round(3 * dpr));
  const kp = mobile ? [0.34, 0.62, 0.3] : [0.44, 0.88, 0.64];
  let L = Math.round(14 * dpr);
  let W = 0;
  let p = 0;
  let pg = 0;
  let pe = 0;
  let bw = 0;
  for (; L >= 2; L--) {
    W = 9 * L + 8 * m + 2 * F;
    p = Math.round(W * kp[0]);
    pg = Math.round(W * kp[1]);
    pe = Math.round(W * kp[2]);
    bw = cols * W + (cols - groups) * p + (groups - 1) * pg + 2 * pe;
    if (bw <= target) break;
  }
  if (L < 2) L = 2;
  const Lh = Math.round(L * 1.2);
  const H = 10 * Lh + 8 * m + R + 2 * F;
  const sill = Math.max(3, Math.round(3 * dpr));
  const ox = Math.max(2, Math.round(W * 0.055));
  const spandrel = Math.round(W * (mobile ? 0.4 : 0.34));
  const pitch = H + sill + spandrel;
  const spTop = Math.round(spandrel * 0.4);
  const cornice = Math.round(W * 0.5);
  const rows = Math.ceil(nwin / cols);
  const plinth = Math.round(W * 1.1);
  const bh = cornice + rows * pitch + plinth;
  const cw = Math.round(cssW * dpr);
  const bx = Math.round((cw - bw) / 2);
  const by = Math.round(14 * dpr);
  const ch = by + bh + Math.round(2 * dpr);
  const win: WindowRect[] = [];
  for (let b = 0; b < nwin; b++) {
    const c = b % cols;
    const r = Math.floor(b / cols);
    const gi = Math.floor(c / group);
    win.push({ x: bx + pe + c * W + (c - gi) * p + gi * pg, y: by + cornice + r * pitch + spTop, c: c, r: r });
  }
  const floors = mobile ? 1.55 : Math.max(1.6, Math.min(2.4, 1.7 + (input.vh - 900) / 300));
  const peek = Math.round(input.railH + (by + cornice + spTop + floors * pitch) / dpr);
  return {
    dpr: dpr, cols: cols, group: group, groups: groups, mobile: mobile, m: m, F: F, R: R, L: L, Lh: Lh, W: W, H: H,
    p: p, pg: pg, pe: pe, sill: sill, ox: ox, spandrel: spandrel, pitch: pitch, spTop: spTop, cornice: cornice,
    rows: rows, plinth: plinth, bw: bw, bh: bh, cw: cw, ch: ch, bx: bx, by: by, win: win, peek: peek,
  };
}

/** Rail height before it is measured: one line on desktop, two stacked lines at <= 640px. */
export const RAIL_H_DESKTOP = 28;
export const RAIL_H_MOBILE = 38;

/** Bays in the building: at least 12 x 8, always some open, a multiple of 24 so 4, 8 and 12 columns fill evenly. */
export function baysFor(projects: number): number {
  return Math.max(96, Math.ceil((projects + 4) / 24) * 24);
}
