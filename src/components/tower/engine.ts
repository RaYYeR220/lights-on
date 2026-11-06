import { computeGeometry, RAIL_H_DESKTOP, RAIL_H_MOBILE, type Geometry, type WindowRect } from "./geometry";
import type { TowerModel, TowerWindow } from "./model";

/**
 * The building renderer: a 2D canvas, one window per project, 9 x 10 lites per window = its last 90 nights
 * (oldest top left, the latest night bottom right) and a side lite for tonight, still to come.
 * Every lit lite is a real row; positions are stable; vacant bays are empty frames.
 */

const NIGHTS = 90;
const LAST = 89;
type RGB = readonly [number, number, number];
type Tier = 1 | 3 | 7;
const SHIP: Record<Tier, RGB> = { 1: [159, 182, 217], 3: [198, 214, 240], 7: [236, 243, 255] };
const WARM: RGB = [139, 115, 80];
const rgb = (a: RGB, al: number) => `rgba(${a[0]},${a[1]},${a[2]},${al})`;
const ease = (t: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);

function hash(n: number): number {
  let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

export const tierOf = (streak: number): Tier => (streak >= 7 ? 7 : streak >= 3 ? 3 : 1);

interface Win extends TowerWindow {
  bay: number;
  tier: Tier;
  /** Replay index among the windows that have a reading for the latest night; -1 = none. */
  oi: number;
}

export interface EngineElements {
  facade: HTMLElement;
  canvas: HTMLCanvasElement;
  bays: HTMLElement;
  rail: HTMLElement;
  railL: HTMLElement;
  railR: HTMLElement;
  tn: HTMLElement;
  prog: HTMLElement;
  chip: HTMLElement;
  chipT: HTMLElement;
  card: HTMLElement;
}

export interface EngineOptions {
  reduce: boolean;
  /** Window to show a card for (-1 = none). */
  onActive: (bay: number) => void;
  onLapse: (on: boolean) => void;
}

type Ctx = CanvasRenderingContext2D;

export class TowerEngine {
  private ctx: Ctx;
  private P: Win[];
  private byBay: (Win | null)[];
  private replayN: number;
  private G!: Geometry;
  private baseBake!: HTMLCanvasElement;
  private histBake!: HTMLCanvasElement;
  private dimAll!: HTMLCanvasElement;
  private lapseLites!: HTMLCanvasElement;
  private lapseDim!: HTMLCanvasElement;
  private lapseDrawn = -1;
  private hatch: CanvasPattern | null = null;
  private railH = RAIL_H_DESKTOP;
  private T0: number;
  private STEP: number;
  private hover = -1;
  private focusB = -1;
  private touchB = -1;
  private activeB = -1;
  private lapse: { t: number; k: number } | null = null;
  private snap: { c: HTMLCanvasElement; t: number } | null = null;
  private lastBlink = -2;
  private dirty = true;
  private raf = 0;
  private visible = true;
  private press: { x: number; y: number; type: string; timer: number } | null = null;
  private suppressClick = false;
  private labels = new Map<HTMLElement, string>();
  private feat: Win | null;
  private chipOn = false;
  private cleanups: (() => void)[] = [];
  private rz = 0;
  private destroyed = false;

  constructor(
    private els: EngineElements,
    private model: TowerModel,
    private opts: EngineOptions,
  ) {
    const ctx = els.canvas.getContext("2d");
    if (!ctx) throw new Error("2d canvas unavailable");
    this.ctx = ctx;
    this.P = model.wins.map((w, bay) => ({ ...w, bay, tier: tierOf(w.streak), oi: -1 }));
    this.byBay = Array.from({ length: model.nwin }, (_, b) => this.P[b] ?? null);
    const replay = this.P.filter((p) => p.h[LAST] !== "-").sort((a, b) => a.co - b.co);
    replay.forEach((p, i) => {
      p.oi = i;
    });
    this.replayN = replay.length;
    this.STEP = Math.min(46, 5200 / Math.max(1, this.replayN));
    this.T0 = opts.reduce ? -1e9 : performance.now() + 450;
    this.feat =
      this.P.filter((p) => p.h[LAST] === "s").sort((a, b) => b.tier - a.tier || a.bay - b.bay)[0] ?? null;
  }

  start() {
    this.layout();
    this.bind();
    if (document.fonts?.ready) document.fonts.ready.then(() => !this.destroyed && this.placeChip());
    this.raf = requestAnimationFrame(this.frame);
  }

  destroy() {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    clearTimeout(this.rz);
    if (this.press) clearTimeout(this.press.timer);
    for (const c of this.cleanups) c();
    this.cleanups = [];
  }

  // ---------- timing ----------
  private shiftEnd() {
    return this.T0 + this.replayN * this.STEP + 380;
  }
  private resolveAt(p: Win) {
    return this.T0 + p.oi * this.STEP;
  }

  // ---------- layout ----------
  private layout() {
    const { facade, canvas, rail, bays } = this.els;
    const vw = window.innerWidth;
    this.railH = rail.offsetHeight || (vw <= 640 ? RAIL_H_MOBILE : RAIL_H_DESKTOP);
    const G = computeGeometry({
      cssW: facade.clientWidth,
      vw,
      vh: window.innerHeight,
      dpr: window.devicePixelRatio || 1,
      nwin: this.model.nwin,
      railH: this.railH,
    });
    this.G = G;
    canvas.width = G.cw;
    canvas.height = G.ch;
    canvas.style.height = `${G.ch / G.dpr}px`;
    const bwCss = `${G.bw / G.dpr}px`;
    const root = document.documentElement.style;
    root.setProperty("--tower-bw", bwCss);
    root.setProperty("--tower-h", `${G.ch / G.dpr}px`);
    this.railH = rail.offsetHeight || this.railH;
    bays.style.top = `${this.railH}px`;
    root.setProperty("--tower-peek", `${G.peek}px`);
    this.hatch = this.makeHatch(G.dpr);
    this.baseBake = this.bake(false);
    this.histBake = this.bake(true);
    this.dimAll = this.bakeDim();
    this.lapseLites = this.blank();
    this.lapseDim = this.blank();
    this.placeBays();
    this.placeChip();
    this.dirty = true;
  }

  private blank() {
    const c = document.createElement("canvas");
    c.width = this.G.cw;
    c.height = this.G.ch;
    return c;
  }

  private liteX(w: WindowRect, n: number) {
    return w.x + this.G.F + (n % 9) * (this.G.L + this.G.m);
  }
  private liteY(w: WindowRect, n: number) {
    const j = Math.floor(n / 9);
    return w.y + this.G.F + j * (this.G.Lh + this.G.m) + (j >= 5 ? this.G.R - this.G.m : 0);
  }
  private tonightX(w: WindowRect) {
    return w.x + this.G.W + this.G.m;
  }

  private makeHatch(dpr: number) {
    const s = Math.max(4, Math.round(4 * dpr));
    const c = document.createElement("canvas");
    c.width = c.height = s;
    const g = c.getContext("2d")!;
    g.fillStyle = "rgba(16,23,35,.30)";
    for (let i = 0; i < s; i++) g.fillRect(i, s - 1 - i, Math.max(1, Math.round(dpr * 0.8)), 1);
    return this.ctx.createPattern(c, "repeat");
  }

  // ---------- lites ----------
  private glass(g: Ctx, w: WindowRect, n: number, b: number) {
    const { bx, by, bw, bh, L, Lh } = this.G;
    const x = this.liteX(w, n);
    const y = this.liteY(w, n);
    const xd = (x - bx) / bw;
    const yd = (y - by) / bh;
    const upper = n < 45;
    let f = 1.07 - 0.16 * yd;
    f += Math.exp(-Math.pow((xd * 0.85 + yd * 0.55 - 0.58) / 0.16, 2)) * 0.085;
    f += (upper ? 0.04 : 0) + (hash(b * 131 + (upper ? 1 : 0)) - 0.5) * 0.05;
    g.fillStyle = `rgb(${Math.round(24 * f)},${Math.round(33 * f)},${Math.round(49 * f)})`;
    g.fillRect(x, y, L, Lh);
  }
  private hatchOver(g: Ctx, x: number, y: number) {
    if (!this.hatch) return;
    g.fillStyle = this.hatch;
    g.fillRect(x, y, this.G.L, this.G.Lh);
  }
  private warmLite(g: Ctx, x: number, y: number, hatched: boolean, a = 1) {
    const { L, Lh } = this.G;
    g.fillStyle = rgb(WARM, 0.85 * a);
    g.fillRect(x, y, L, Lh);
    if (hatched) this.hatchOver(g, x, y);
    // light comes from inside the pane: a soft core, so it reads as lamp-lit glass, not a painted tile
    const cx = x + L / 2;
    const cy = y + Lh / 2;
    const r = L * 0.95;
    const op = g.globalCompositeOperation;
    g.globalCompositeOperation = "lighter";
    const rg = g.createRadialGradient(cx, cy, 0, cx, cy, r);
    rg.addColorStop(0, rgb(WARM, (hatched ? 0.26 : 0.36) * a));
    rg.addColorStop(1, rgb(WARM, 0));
    g.fillStyle = rg;
    g.fillRect(x, y, L, Lh);
    g.globalCompositeOperation = op;
  }
  private downLite(g: Ctx, x: number, y: number) {
    const { L, Lh, dpr } = this.G;
    const t = Math.max(1, Math.round(dpr * 1.5));
    g.fillStyle = "#1b1b25";
    g.fillRect(x, y, L, Lh);
    g.fillStyle = "rgba(255,106,106,.6)";
    g.fillRect(x, y + Lh - t, L, t);
  }
  private shipLite(g: Ctx, x: number, y: number, tier: Tier, hatched: boolean, a = 1) {
    g.fillStyle = rgb(SHIP[tier], a);
    g.fillRect(x, y, this.G.L, this.G.Lh);
    if (hatched) this.hatchOver(g, x, y);
  }
  /** No reading: no row for that night (or no source answered). The glass stays dark, unlit and unreflective. */
  private noneLite(g: Ctx, x: number, y: number, a = 1) {
    g.fillStyle = `rgba(6,9,14,${0.5 * a})`;
    g.fillRect(x, y, this.G.L, this.G.Lh);
  }
  private nightLite(g: Ctx, w: WindowRect, n: number, ch: string, hatched: boolean) {
    const x = this.liteX(w, n);
    const y = this.liteY(w, n);
    if (ch === "b") this.warmLite(g, x, y, hatched);
    else if (ch === "s") this.shipLite(g, x, y, 1, hatched);
    else if (ch === "d") this.downLite(g, x, y);
    else if (ch === "-" || ch === "u") this.noneLite(g, x, y);
  }

  // ---------- bakes ----------
  private bake(withHist: boolean) {
    const c = this.blank();
    const g = c.getContext("2d")!;
    const G = this.G;
    const { bx, by, bw, bh, m, F, R, W, H, L, Lh, sill, ox, cornice, plinth, dpr } = G;
    // mass
    const gr = g.createLinearGradient(0, by, 0, by + bh);
    gr.addColorStop(0, "#0f1520");
    gr.addColorStop(1, "#0a0e16");
    g.fillStyle = gr;
    g.fillRect(bx, by, bw, bh);
    g.fillStyle = "rgba(130,155,195,.10)";
    g.fillRect(bx, by, m, bh);
    g.fillStyle = "rgba(0,0,0,.25)";
    g.fillRect(bx + bw - m, by, m, bh);
    // cornice: projecting cap + frieze
    const cp = Math.round(W * 0.07);
    const capH = Math.max(3 * m, Math.round(cornice * 0.3));
    g.fillStyle = "#131a27";
    g.fillRect(bx - cp, by, bw + 2 * cp, capH);
    g.fillStyle = "rgba(175,198,235,.24)";
    g.fillRect(bx - cp, by, bw + 2 * cp, m);
    g.fillStyle = "rgba(0,0,0,.45)";
    g.fillRect(bx, by + capH, bw, m * 2);
    g.fillStyle = "rgba(140,165,205,.07)";
    g.fillRect(bx, by + cornice - 2 * m, bw, m);
    // pilasters at the structural bay breaks
    const top = by + cornice;
    const bot = by + bh - plinth;
    for (let k = 1; k < G.groups; k++) {
      const a = G.win[k * G.group - 1].x + W;
      const b2 = G.win[k * G.group].x;
      const ins = Math.round((b2 - a) * 0.2);
      g.fillStyle = "#10161f";
      g.fillRect(a + ins, top, b2 - a - 2 * ins, bot - top);
      g.fillStyle = "rgba(140,165,205,.07)";
      g.fillRect(a + ins, top, m, bot - top);
      g.fillStyle = "rgba(0,0,0,.28)";
      g.fillRect(b2 - ins - m, top, m, bot - top);
    }
    // plinth
    const pp = Math.round(W * 0.05);
    g.fillStyle = "#0b1018";
    g.fillRect(bx - pp, bot, bw + 2 * pp, plinth);
    g.fillStyle = "rgba(160,185,225,.14)";
    g.fillRect(bx - pp, bot, bw + 2 * pp, m);
    g.fillStyle = "rgba(140,165,205,.06)";
    g.fillRect(bx - pp, bot + Math.round(plinth * 0.62), bw + 2 * pp, m);
    // ground line, full width
    g.fillStyle = "rgba(238,242,248,.10)";
    g.fillRect(0, by + bh, G.cw, m);

    const lt = Math.max(2, Math.round(2 * dpr));
    for (let b = 0; b < this.model.nwin; b++) {
      const w = G.win[b];
      const p = this.byBay[b];
      // lintel
      g.fillStyle = "#121925";
      g.fillRect(w.x - ox, w.y - lt - 2 * m, W + 2 * ox, lt);
      // reveal (recess shadow)
      g.fillStyle = "#05080d";
      g.fillRect(w.x - 2 * m, w.y - 2 * m, W + 4 * m, H + 2 * m);
      // sill
      g.fillStyle = "#141c2a";
      g.fillRect(w.x - ox, w.y + H, W + 2 * ox, sill);
      g.fillStyle = "rgba(175,198,235,.22)";
      g.fillRect(w.x - ox, w.y + H, W + 2 * ox, m);
      g.fillStyle = "rgba(0,0,0,.40)";
      g.fillRect(w.x - ox, w.y + H + sill, W + 2 * ox, 2 * m);
      if (!p) {
        // vacant bay: an empty frame, no glazing
        g.fillStyle = "#0c121c";
        g.fillRect(w.x, w.y, W, H);
        g.fillStyle = "#070a10";
        g.fillRect(w.x + F, w.y + F, W - 2 * F, H - 2 * F);
        const ry = w.y + F + 5 * Lh + 4 * m;
        g.fillStyle = "#0c121c";
        g.fillRect(w.x + F, ry, W - 2 * F, R);
        g.fillStyle = "rgba(140,165,205,.06)";
        g.fillRect(w.x, w.y, W, m);
        continue;
      }
      // side lite for tonight, framed into the window and sharing its sill
      const ty = this.liteY(w, LAST);
      const tx = this.tonightX(w);
      g.fillStyle = "#05080d";
      g.fillRect(w.x + W, ty - F - 2 * m, L + F + m + 2 * m, Lh + 2 * F + 2 * m + (w.y + H - (ty + Lh + F)));
      g.fillStyle = "#0b111b";
      g.fillRect(w.x + W - F, ty - F, L + 2 * F + m, w.y + H - (ty - F));
      g.fillStyle = "#0d1420";
      g.fillRect(tx, ty, L, Lh);
      g.fillStyle = "rgba(140,165,205,.10)";
      g.fillRect(w.x + W, ty - F, L + F + m, m);
      g.fillStyle = "#141c2a";
      g.fillRect(w.x + W, w.y + H, L + F + m + ox, sill);
      g.fillStyle = "rgba(175,198,235,.22)";
      g.fillRect(w.x + W, w.y + H, L + F + m + ox, m);
      g.fillStyle = "rgba(0,0,0,.40)";
      g.fillRect(w.x + W, w.y + H + sill, L + F + m + ox, 2 * m);
      // frame
      g.fillStyle = "#0b111b";
      g.fillRect(w.x, w.y, W, H);
      g.fillStyle = "rgba(140,165,205,.10)";
      g.fillRect(w.x, w.y, W, m);
      for (let n = 0; n < NIGHTS; n++) this.glass(g, w, n, b);
      // meeting rail highlight (the lower sash sits in front)
      const ry = w.y + F + 5 * Lh + 4 * m;
      g.fillStyle = "rgba(160,185,225,.16)";
      g.fillRect(w.x + F, ry, W - 2 * F, m);
      // a sky reflection crossing the glass, offset between the two sashes (they sit in different planes)
      g.save();
      g.globalCompositeOperation = "lighter";
      const sashes: [number, number, number][] = [
        [w.y + F, ry, 0],
        [ry + R, w.y + H - F, Math.round(W * 0.1)],
      ];
      for (const [y0, y1, off] of sashes) {
        const o = (hash(b * 7 + 3) - 0.5) * W * 0.5 + off;
        const lg = g.createLinearGradient(w.x + o, y0, w.x + o + W * 0.9, y0 + H * 0.9);
        lg.addColorStop(0, "rgba(120,145,190,0)");
        lg.addColorStop(0.42, "rgba(120,145,190,0)");
        lg.addColorStop(0.5, "rgba(120,145,190,.07)");
        lg.addColorStop(0.58, "rgba(120,145,190,0)");
        lg.addColorStop(1, "rgba(120,145,190,0)");
        g.fillStyle = lg;
        g.fillRect(w.x + F, y0, W - 2 * F, y1 - y0);
      }
      g.restore();
      if (withHist) {
        for (let n = 0; n < LAST; n++) {
          const ch = p.h[n];
          if (ch !== "q") this.nightLite(g, w, n, ch, p.o[n] !== "1");
        }
        g.save();
        g.globalCompositeOperation = "lighter";
        for (let n = 0; n < LAST; n++)
          if (p.h[n] === "b") {
            const cx = this.liteX(w, n) + L / 2;
            const cy = this.liteY(w, n) + Lh / 2;
            const r = L * 2.8;
            const rg = g.createRadialGradient(cx, cy, 0, cx, cy, r);
            rg.addColorStop(0, rgb(WARM, 0.17));
            rg.addColorStop(0.45, rgb(WARM, 0.06));
            rg.addColorStop(1, rgb(WARM, 0));
            g.fillStyle = rg;
            g.fillRect(cx - r, cy - r, 2 * r, 2 * r);
          }
        g.restore();
      }
    }
    return c;
  }

  /** The time-lapse veil: every lite of every occupied window dimmed until its night plays. */
  private bakeDim() {
    const c = this.blank();
    const g = c.getContext("2d")!;
    g.fillStyle = "rgba(8,12,19,.58)";
    for (const p of this.P) {
      const w = this.G.win[p.bay];
      for (let n = 0; n < NIGHTS; n++) g.fillRect(this.liteX(w, n), this.liteY(w, n), this.G.L, this.G.Lh);
    }
    return c;
  }

  // ---------- overlay controls ----------
  private bayEls(): HTMLElement[] {
    return Array.from(this.els.bays.querySelectorAll<HTMLElement>("[data-b]"));
  }
  private placeBays() {
    const d = this.G.dpr;
    for (const el of this.bayEls()) {
      const w = this.G.win[Number(el.dataset.b)];
      if (!w) continue;
      el.style.left = `${w.x / d}px`;
      el.style.top = `${w.y / d}px`;
      el.style.width = `${this.G.W / d}px`;
      el.style.height = `${(this.G.H + this.G.sill) / d}px`;
    }
  }

  private placeChip() {
    const { chip, chipT, facade } = this.els;
    const feat = this.feat;
    if (!feat || !this.G) {
      chip.style.display = "none";
      return;
    }
    const G = this.G;
    const w = G.win[feat.bay];
    const d = G.dpr;
    const lx = (this.liteX(w, LAST) + G.L / 2) / d;
    const ly = (w.y + G.H + G.sill) / d;
    if (!chipT.dataset.slug || chipT.dataset.slug !== feat.slug) {
      const b = document.createElement("b");
      b.textContent = feat.name;
      chipT.replaceChildren(b, document.createTextNode(" · shipped last night"));
      chipT.dataset.slug = feat.slug;
    }
    const cwid = chip.offsetWidth || 230;
    const fw = facade.clientWidth;
    let left = lx - 14;
    if (left + cwid > fw - 12) left = fw - 12 - cwid;
    const leadH = Math.round((G.spandrel * 0.42) / d + 6);
    chip.style.left = `${left}px`;
    chip.style.top = `${this.railH + ly + leadH}px`;
    chip.style.setProperty("--lx", `${lx - left}px`);
    chip.style.setProperty("--lh", `${leadH}px`);
    chip.style.display = fw < 340 ? "none" : "";
  }

  private setChip(on: boolean) {
    if (this.chipOn === on) return;
    this.chipOn = on;
    if (on) this.els.chip.dataset.on = "";
    else delete this.els.chip.dataset.on;
  }

  /** Puts the card next to its window, inside the facade and the viewport. Called after React renders the card. */
  placeCard(card: HTMLElement, b: number) {
    const G = this.G;
    const w = G?.win[b];
    if (!w) return;
    const d = G.dpr;
    const fw = this.els.facade.clientWidth;
    const top0 = this.railH;
    const wx = w.x / d;
    const wy = top0 + w.y / d;
    const ww = G.W / d;
    const wh = G.H / d;
    card.style.left = "0px";
    card.style.top = "0px";
    const cwid = card.offsetWidth;
    const chh = card.offsetHeight;
    let left: number;
    let top: number;
    if (G.mobile) {
      top = wy - chh - 12;
      if (top < top0) top = wy + wh + 14;
      left = 16;
    } else {
      left = wx + ww + 22;
      if (left + cwid > fw - 16) left = wx - 22 - cwid;
      top = wy + wh / 2 - chh / 2;
      const fr = this.els.facade.getBoundingClientRect();
      const maxTop = window.innerHeight - fr.top - chh - 14;
      top = Math.max(84 - fr.top, Math.min(top, maxTop));
    }
    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
  }

  // ---------- rendering ----------
  private bloom(cx: number, cy: number, r: number, col: RGB, a: number) {
    if (a <= 0.002) return;
    const g = this.ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, rgb(col, a));
    g.addColorStop(0.28, rgb(col, a * 0.42));
    g.addColorStop(0.6, rgb(col, a * 0.12));
    g.addColorStop(1, rgb(col, 0));
    this.ctx.fillStyle = g;
    this.ctx.fillRect(cx - r, cy - r, 2 * r, 2 * r);
  }
  private sillSpill(w: WindowRect, cx: number, col: RGB, a: number) {
    const G = this.G;
    const g = this.ctx.createLinearGradient(cx - G.W * 0.7, 0, cx + G.W * 0.5, 0);
    g.addColorStop(0, rgb(col, 0));
    g.addColorStop(0.6, rgb(col, a));
    g.addColorStop(1, rgb(col, 0));
    this.ctx.fillStyle = g;
    this.ctx.fillRect(w.x - G.ox, w.y + G.H, G.W + 2 * G.ox, G.m);
  }
  private strokeIn(x: number, y: number, w: number, h: number, col: string, lw: number) {
    const c = this.ctx;
    c.fillStyle = col;
    c.fillRect(x, y, w, lw);
    c.fillRect(x, y + h - lw, w, lw);
    c.fillRect(x, y, lw, h);
    c.fillRect(x + w - lw, y, lw, h);
  }
  private tonight(w: WindowRect, a: number) {
    this.strokeIn(this.tonightX(w), this.liteY(w, LAST), this.G.L, this.G.Lh, `rgba(182,192,207,${a})`, this.G.m);
  }

  private drawFinal(now: number) {
    const { ctx, G } = this;
    const reduce = this.opts.reduce;
    ctx.clearRect(0, 0, G.cw, G.ch);
    ctx.drawImage(this.histBake, 0, 0);
    const end = this.shiftEnd();
    const blinkOn = reduce ? true : now < end ? false : Math.floor((now - end) / 550) % 2 === 0;
    const glow: [Win, WindowRect, number, number, number][] = [];
    for (const p of this.P) {
      const w = G.win[p.bay];
      const x = this.liteX(w, LAST);
      const y = this.liteY(w, LAST);
      const ch = p.h[LAST];
      const hatched = p.o[LAST] !== "1";
      const t = p.oi < 0 ? -1 : now - this.resolveAt(p);
      if (ch === "-") {
        // never checked for the latest night: the lite stays dark with a pending outline
        this.noneLite(ctx, x, y);
        this.strokeIn(x, y, G.L, G.Lh, "rgba(124,136,154,.4)", G.m);
      } else if (t < 0) {
        this.strokeIn(x, y, G.L, G.Lh, "rgba(124,136,154,.55)", G.m);
      } else {
        const a = ease(t / 320);
        if (ch === "s") this.shipLite(ctx, x, y, p.tier, hatched, a);
        else if (ch === "b") this.warmLite(ctx, x, y, hatched, a);
        else if (ch === "d") {
          ctx.globalAlpha = a;
          this.downLite(ctx, x, y);
          ctx.globalAlpha = 1;
        } else if (ch === "u") this.noneLite(ctx, x, y, a);
        if (a < 1) this.strokeIn(x, y, G.L, G.Lh, `rgba(124,136,154,${0.55 * (1 - a)})`, G.m);
        if (ch === "s" || ch === "b") glow.push([p, w, x, y, ease(t / 900)]);
        // the agent's visit: the frame catches a cool edge, then lets go
        if (t < 760 && !reduce) this.strokeIn(w.x, w.y, G.W, G.H, `rgba(198,214,240,${0.5 * (1 - t / 760)})`, G.m);
      }
      this.tonight(w, blinkOn ? 0.44 : 0.09);
    }
    ctx.globalCompositeOperation = "lighter";
    for (const [p, w, x, y, a] of glow) {
      const cx = x + G.L / 2;
      const cy = y + G.Lh / 2;
      if (p.h[LAST] === "s") {
        const s = { 1: 0.78, 3: 1, 7: 1.2 }[p.tier] * a;
        const col = SHIP[p.tier];
        this.bloom(cx, cy, G.W * 2.3, col, 0.12 * s);
        this.bloom(cx, cy, G.W * 0.78, col, 0.26 * s);
        this.bloom(cx, cy, G.L * 2.3, col, 0.62 * s);
        this.sillSpill(w, cx, col, 0.7 * s);
      } else {
        this.bloom(cx, cy, G.W * 0.9, WARM, 0.1 * a);
        this.bloom(cx, cy, G.L * 2.4, WARM, 0.22 * a);
      }
    }
    ctx.globalCompositeOperation = "source-over";
    this.drawHover();
    if (this.snap) {
      const k = (now - this.snap.t) / 280;
      if (k >= 1) this.snap = null;
      else {
        ctx.globalAlpha = 1 - ease(k);
        ctx.drawImage(this.snap.c, 0, 0);
        ctx.globalAlpha = 1;
      }
    }
  }

  private drawLapse(k: number) {
    const { ctx, G } = this;
    const kn = Math.floor(k);
    // paint each night once as it is reached: lites go on the lites layer, the veil lifts off that lite
    if (this.lapseDrawn < kn) {
      const lg = this.lapseLites.getContext("2d")!;
      const dg = this.lapseDim.getContext("2d")!;
      for (let n = this.lapseDrawn + 1; n <= kn; n++) {
        for (const p of this.P) {
          const w = G.win[p.bay];
          const ch = p.h[n];
          if (ch !== "q") this.nightLite(lg, w, n, ch, p.o[n] !== "1");
          dg.clearRect(this.liteX(w, n), this.liteY(w, n), G.L, G.Lh);
        }
      }
      this.lapseDrawn = kn;
    }
    ctx.clearRect(0, 0, G.cw, G.ch);
    ctx.drawImage(this.baseBake, 0, 0);
    ctx.drawImage(this.lapseLites, 0, 0);
    ctx.drawImage(this.lapseDim, 0, 0);
    const glow: [number, number, number, RGB][] = [];
    for (const p of this.P) {
      const w = G.win[p.bay];
      let I = 0;
      let col: RGB = WARM;
      for (let n = Math.max(0, kn - 14); n <= kn; n++) {
        const ch = p.h[n];
        if (ch === "b" || ch === "s") {
          const e = Math.exp(-(k - n) / 2.4);
          I += e * (ch === "s" ? 1.7 : 1);
          if (ch === "s" && e > 0.3) col = SHIP[1];
        }
      }
      if (I > 0.02) {
        // light sits on the lite being written: the current night
        const n = Math.min(kn, LAST);
        glow.push([this.liteX(w, n) + G.L / 2, this.liteY(w, n) + G.Lh / 2, Math.min(1, I), col]);
      }
      this.tonight(w, 0.16);
    }
    ctx.globalCompositeOperation = "lighter";
    for (const [cx, cy, a, col] of glow) {
      this.bloom(cx, cy, G.W * 1.35, col, 0.17 * a);
      this.bloom(cx, cy, G.W * 0.45, col, 0.22 * a);
      this.bloom(cx, cy, G.L * 2.4, col, 0.4 * a);
    }
    ctx.globalCompositeOperation = "source-over";
  }

  private drawHover() {
    const b = this.hover >= 0 ? this.hover : this.focusB;
    if (b < 0 || this.lapse) return;
    const G = this.G;
    const w = G.win[b];
    if (!w) return;
    const o = 3 * G.m;
    this.strokeIn(w.x - o, w.y - o, G.W + 2 * o, G.H + 2 * o, "rgba(238,242,248,.5)", G.m);
  }

  // ---------- loop ----------
  private setLabel(el: HTMLElement, text: string, bold?: string, tail = "") {
    const key = `${text}\u0000${bold ?? ""}\u0000${tail}`;
    if (this.labels.get(el) === key) return;
    this.labels.set(el, key);
    if (bold === undefined) {
      el.textContent = text;
      return;
    }
    const b = document.createElement("b");
    b.textContent = bold;
    el.replaceChildren(document.createTextNode(text), b, document.createTextNode(tail));
  }

  private frame = (now: number) => {
    if (this.destroyed) return;
    if (!this.visible) {
      this.raf = 0;
      return;
    }
    const { railL, railR, tn, prog } = this.els;
    const end = this.shiftEnd();
    if (this.lapse) {
      const k = Math.min(LAST, (now - this.lapse.t) / 50);
      this.lapse.k = k;
      this.drawLapse(k);
      prog.style.transform = `scaleX(${(k / LAST).toFixed(4)})`;
      this.setLabel(railR, "Night ", String(Math.floor(k) + 1), ` of 90${k >= LAST ? " · last night" : ""}`);
      this.setLabel(railL, "Season time-lapse");
      tn.dataset.off = "";
    } else {
      const animating = now < end + 1000 || this.snap !== null;
      const phase = this.opts.reduce ? 0 : now < end ? -1 : Math.floor((now - end) / 550) % 2;
      if (animating || this.dirty || phase !== this.lastBlink) {
        this.drawFinal(now);
        this.dirty = false;
        this.lastBlink = phase;
      }
      if (phase === 1 || phase === -1) tn.dataset.off = "";
      else delete tn.dataset.off;
      if (now < end - 380 && this.replayN > 0) {
        const done = Math.max(0, Math.min(this.replayN, Math.floor((now - this.T0) / this.STEP) + 1));
        const lead = this.model.live ? "Last night's shift · " : "Last night, reconstructed · ";
        this.setLabel(railL, lead, String(done), ` of ${this.replayN} checked`);
      } else this.setLabel(railL, "Tonight's shift in ", countdown());
      this.setLabel(railR, "Press and hold to play 90 nights");
      const feat = this.feat;
      if (feat && !this.chipOn && now >= this.resolveAt(feat) + 250 && this.hover < 0 && this.focusB < 0) this.setChip(true);
    }
    this.raf = requestAnimationFrame(this.frame);
  };

  private wake() {
    if (!this.raf && this.visible && !this.destroyed) this.raf = requestAnimationFrame(this.frame);
  }

  // ---------- input ----------
  private canvasPoint(ev: { clientX: number; clientY: number }) {
    const r = this.els.canvas.getBoundingClientRect();
    return { x: (ev.clientX - r.left) * this.G.dpr, y: (ev.clientY - r.top) * this.G.dpr };
  }
  private bayAt(ev: { clientX: number; clientY: number }) {
    const G = this.G;
    const { x, y } = this.canvasPoint(ev);
    for (let b = 0; b < this.model.nwin; b++) {
      const w = G.win[b];
      if (x >= w.x - G.p / 2 && x <= w.x + G.W + G.p / 2 && y >= w.y - G.spTop && y <= w.y + G.H + G.sill + G.spandrel - G.spTop)
        return b;
    }
    return -1;
  }
  private onBuilding(ev: { clientX: number; clientY: number }) {
    const G = this.G;
    const { x, y } = this.canvasPoint(ev);
    return x >= G.bx && x <= G.bx + G.bw && y >= G.by && y <= G.by + G.bh;
  }

  private show(b: number) {
    if (this.lapse) b = -1;
    if (b >= 0) this.setChip(false);
    this.activeB = b;
    this.opts.onActive(b);
  }

  private startLapse() {
    if (this.lapse) return;
    this.lapse = { t: performance.now(), k: 0 };
    this.lapseDrawn = -1;
    this.lapseLites.getContext("2d")!.clearRect(0, 0, this.G.cw, this.G.ch);
    const dg = this.lapseDim.getContext("2d")!;
    dg.clearRect(0, 0, this.G.cw, this.G.ch);
    dg.drawImage(this.dimAll, 0, 0);
    this.els.facade.dataset.lapsing = "";
    this.setChip(false);
    this.activeB = -1;
    this.opts.onActive(-1);
    this.opts.onLapse(true);
    this.wake();
  }
  private endLapse() {
    if (!this.lapse) return;
    const c = this.blank();
    c.getContext("2d")!.drawImage(this.els.canvas, 0, 0);
    this.snap = { c, t: performance.now() };
    this.lapse = null;
    delete this.els.facade.dataset.lapsing;
    this.dirty = true;
    this.els.prog.style.transform = "scaleX(0)";
    this.opts.onLapse(false);
  }

  private bind() {
    const { facade, bays } = this.els;
    const on = <K extends keyof HTMLElementEventMap>(
      el: HTMLElement | Document | Window,
      type: K,
      fn: (e: HTMLElementEventMap[K]) => void,
      o?: AddEventListenerOptions,
    ) => {
      el.addEventListener(type, fn as EventListener, o);
      this.cleanups.push(() => el.removeEventListener(type, fn as EventListener, o));
    };

    on(facade, "pointerdown", (e) => {
      this.suppressClick = false;
      if (e.button !== 0 || !this.G || !this.onBuilding(e)) return;
      const timer = window.setTimeout(() => {
        this.startLapse();
        this.suppressClick = true;
      }, 170);
      this.press = { x: e.clientX, y: e.clientY, type: e.pointerType, timer };
    });
    on(facade, "pointermove", (e) => {
      if (this.press && Math.hypot(e.clientX - this.press.x, e.clientY - this.press.y) > 8 && !this.lapse) {
        clearTimeout(this.press.timer);
        this.press = null;
      }
      if (e.pointerType === "mouse" && !this.lapse) {
        const b = this.bayAt(e);
        if (b !== this.hover) {
          this.hover = b;
          this.dirty = true;
          this.show(b >= 0 ? b : this.focusB);
        }
      }
    });
    const release = (e: PointerEvent) => {
      if (!this.press) return;
      clearTimeout(this.press.timer);
      const wasLapse = !!this.lapse;
      if (wasLapse) this.endLapse();
      else if (this.press.type !== "mouse" && e.type === "pointerup") {
        // touch: the first tap on a window shows its card, a second tap on the same window opens it
        const b = this.bayAt(e);
        if (b !== this.touchB) {
          this.suppressClick = b >= 0;
          this.touchB = b;
          this.hover = b;
          this.dirty = true;
          this.show(b);
        }
      }
      this.press = null;
    };
    on(facade, "pointerup", release);
    on(facade, "pointercancel", release);
    on(facade, "pointerleave", (e) => {
      if (e.pointerType !== "mouse") return;
      if (this.press) release(e);
      this.hover = -1;
      this.dirty = true;
      this.show(this.focusB);
    });
    on(facade, "contextmenu", (e) => {
      if (this.onBuilding(e)) e.preventDefault();
    });
    on(
      facade,
      "click",
      (e) => {
        if (this.suppressClick) {
          e.preventDefault();
          e.stopPropagation();
          this.suppressClick = false;
        }
      },
      { capture: true },
    );
    // a tap anywhere else puts the card away
    on(document, "pointerdown", (e) => {
      if (e.pointerType === "mouse" || facade.contains(e.target as Node)) return;
      if (this.touchB >= 0) {
        this.touchB = -1;
        this.hover = -1;
        this.dirty = true;
        this.show(this.focusB);
      }
    });

    on(bays, "focusin", (e) => {
      const b = Number((e.target as HTMLElement).dataset.b);
      if (Number.isNaN(b)) return;
      this.focusB = b;
      this.dirty = true;
      this.show(b);
    });
    on(bays, "focusout", () => {
      this.focusB = -1;
      this.dirty = true;
      this.show(this.hover);
    });
    on(bays, "keydown", (e) => {
      const b = Number((e.target as HTMLElement).dataset.b);
      if (Number.isNaN(b)) return;
      const c = this.G.cols;
      const mv = ({ ArrowRight: 1, ArrowLeft: -1, ArrowDown: c, ArrowUp: -c } as Record<string, number>)[e.key];
      if (mv) {
        e.preventDefault();
        const nb = Math.max(0, Math.min(this.model.nwin - 1, b + mv));
        const all = this.bayEls();
        const cur = all.find((el) => Number(el.dataset.b) === b);
        const next = all.find((el) => Number(el.dataset.b) === nb);
        if (cur && next) {
          cur.tabIndex = -1;
          next.tabIndex = 0;
          next.focus();
        }
      } else if (e.key === "Home" || e.key === "End") {
        e.preventDefault();
        const all = this.bayEls();
        const next = e.key === "Home" ? all[0] : all[Math.max(0, this.P.length - 1)];
        for (const el of all) el.tabIndex = -1;
        if (next) {
          next.tabIndex = 0;
          next.focus();
        }
      } else if (e.key === " " || e.key === "Spacebar") {
        e.preventDefault();
        if (!e.repeat) this.startLapse();
      } else if (e.key === "Escape") {
        this.show(-1);
      }
    });
    on(bays, "keyup", (e) => {
      if (e.key === " " || e.key === "Spacebar") {
        e.preventDefault();
        this.endLapse();
        this.show(this.focusB);
      }
    });

    on(window, "resize", () => {
      clearTimeout(this.rz);
      this.rz = window.setTimeout(() => {
        this.layout();
        if (this.activeB >= 0) this.placeCard(this.els.card, this.activeB);
        this.wake();
      }, 80);
    });

    if (typeof IntersectionObserver !== "undefined") {
      const io = new IntersectionObserver((entries) => {
        this.visible = entries.some((x) => x.isIntersecting);
        if (this.visible) {
          this.dirty = true;
          this.wake();
        }
      });
      io.observe(facade);
      this.cleanups.push(() => io.disconnect());
    }
  }
}

/** Time to the next 05:00 UTC shift, hh:mm:ss. */
export function countdown(now = new Date()): string {
  const t = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 5, 0, 0));
  if (t <= now) t.setUTCDate(t.getUTCDate() + 1);
  const s = Math.floor((t.getTime() - now.getTime()) / 1000);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor(s / 60) % 60;
  const ss = s % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

/** The hover card's close-up of one window, drawn at 2x. */
export function drawZoom(c: HTMLCanvasElement, p: TowerWindow) {
  const d = 2;
  const L = 7;
  const Lh = 8;
  const m = 1;
  const F = 3;
  const R = 3;
  const W = 9 * L + 8 * m + 2 * F;
  const H = 10 * Lh + 8 * m + R + 2 * F;
  const pad = 10;
  const side = 4 + L;
  const tier = tierOf(p.streak);
  c.width = (W + side + 2 * pad) * d;
  c.height = (H + 5 + 2 * pad) * d;
  c.style.width = `${W + side + 2 * pad}px`;
  c.style.height = `${H + 5 + 2 * pad}px`;
  const g = c.getContext("2d");
  if (!g) return;
  g.setTransform(d, 0, 0, d, 0, 0);
  const x0 = pad;
  const y0 = pad;
  g.fillStyle = "#05080d";
  g.fillRect(x0 - 2, y0 - 2, W + 4, H + 2);
  g.fillStyle = "#0b111b";
  g.fillRect(x0, y0, W, H);
  const lx = (n: number) => x0 + F + (n % 9) * (L + m);
  const ly = (n: number) => {
    const j = Math.floor(n / 9);
    return y0 + F + j * (Lh + m) + (j >= 5 ? R - m : 0);
  };
  const s = 3 * d;
  const cc = document.createElement("canvas");
  cc.width = cc.height = s;
  const h = cc.getContext("2d")!;
  h.fillStyle = "rgba(16,23,35,.6)";
  for (let i = 0; i < s; i++) h.fillRect(i, s - 1 - i, 2, 1);
  const hp = g.createPattern(cc, "repeat");
  const hatchAt = (x: number, y: number) => {
    if (!hp) return;
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = hp;
    g.fillRect(x * d, y * d, L * d, Lh * d);
    g.restore();
  };
  for (let n = 0; n < NIGHTS; n++) {
    const ch = p.h[n];
    const x = lx(n);
    const y = ly(n);
    const hatched = p.o[n] !== "1";
    g.fillStyle = n < 45 ? "#1a2335" : "#182131";
    g.fillRect(x, y, L, Lh);
    if (ch === "b") {
      g.fillStyle = rgb(WARM, 0.85);
      g.fillRect(x, y, L, Lh);
      if (hatched) hatchAt(x, y);
    } else if (ch === "s") {
      g.fillStyle = rgb(SHIP[n === LAST ? tier : 1], 1);
      g.fillRect(x, y, L, Lh);
      if (hatched) hatchAt(x, y);
    } else if (ch === "d") {
      g.fillStyle = "#1b1b25";
      g.fillRect(x, y, L, Lh);
      g.fillStyle = "rgba(255,106,106,.7)";
      g.fillRect(x, y + Lh - 1.5, L, 1.5);
    } else if (ch === "-" || ch === "u") {
      g.fillStyle = "#0e141e";
      g.fillRect(x, y, L, Lh);
    }
  }
  g.fillStyle = "rgba(160,185,225,.18)";
  g.fillRect(x0 + F, y0 + F + 5 * Lh + 4 * m, W - 2 * F, 1);
  // sill
  g.fillStyle = "#141c2a";
  g.fillRect(x0 - 3, y0 + H, W + 6, 3);
  g.fillStyle = "rgba(175,198,235,.25)";
  g.fillRect(x0 - 3, y0 + H, W + 6, 1);
  // tonight, still to come
  const tx = x0 + W + 4;
  const ty = ly(LAST);
  g.strokeStyle = "rgba(182,192,207,.6)";
  g.lineWidth = 1;
  g.strokeRect(tx + 0.5, ty + 0.5, L - 1, Lh - 1);
  const last = p.h[LAST];
  if (last === "s" || last === "b") {
    const col = last === "s" ? SHIP[tier] : WARM;
    const cx = lx(LAST) + L / 2;
    const cy = ly(LAST) + Lh / 2;
    g.globalCompositeOperation = "lighter";
    const gr = g.createRadialGradient(cx, cy, 0, cx, cy, last === "s" ? 30 : 18);
    gr.addColorStop(0, rgb(col, last === "s" ? 0.45 : 0.2));
    gr.addColorStop(1, rgb(col, 0));
    g.fillStyle = gr;
    g.fillRect(cx - 30, cy - 30, 60, 60);
    g.globalCompositeOperation = "source-over";
  }
}
