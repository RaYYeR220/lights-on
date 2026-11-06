import type { TowerData } from "@/lib/views/tower";
import type { Status } from "@/lib/types";
import { baysFor } from "./geometry";

/** One lite per night: shipped, building, quiet, down, unavailable, or "-" for no row. */
export type LiteCode = "s" | "b" | "q" | "d" | "u" | "-";

export interface TowerWindow {
  slug: string;
  name: string;
  /** Where the project comes from, in words. */
  src: string;
  st: Status | null;
  /** The status comes from an observed (live) night. */
  stObs: boolean;
  /** The status night is the newest night of the window. */
  stLast: boolean;
  /** "3 Nov" for the status night. */
  stDay: string | null;
  w: string[];
  /** 90 lite codes, oldest first. */
  h: string;
  /** 90 flags, "1" where the night was observed live, "0" where it is reconstructed or missing. */
  o: string;
  l30: number;
  streak: number;
  /** Nights in the window that only exist as reconstructed history. */
  rn: number;
  /** Replay position: confirmation order of the latest shift, then the stable order. */
  co: number;
}

export interface TowerModel {
  lastNight: number;
  /** At least one observed (live) night exists. */
  live: boolean;
  nwin: number;
  wins: TowerWindow[];
}

const CODE: Record<Status, LiteCode> = { shipped: "s", building: "b", quiet: "q", down: "d", unavailable: "u" };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const SOURCE_LABEL: Record<string, string> = {
  base: "Base app",
  vibeathon01: "Vibeathon 01 finalist",
  vibestarter: "Vibestarter campaign",
  community: "Added by the community",
};

/** yyyymmdd -> "3 Nov" */
export function dayLabel(n: number): string {
  return `${n % 100} ${MONTHS[Math.floor(n / 100) % 100 - 1] ?? ""}`.trim();
}

/** Server side: the compact shape the client tower renders (history as strings, labels resolved). */
export function toTowerModel(d: TowerData): TowerModel {
  const wins: TowerWindow[] = d.projects.map((p) => ({
    slug: p.slug,
    name: p.name,
    src: SOURCE_LABEL[p.source] ?? p.source,
    st: p.status,
    stObs: p.statusObserved,
    stLast: p.statusNight === d.lastNight,
    stDay: p.statusNight ? dayLabel(p.statusNight) : null,
    w: p.whatShipped,
    h: p.history.map((s) => (s ? CODE[s] : "-")).join(""),
    o: p.observed.map((o) => (o ? "1" : "0")).join(""),
    l30: p.lit30,
    streak: p.streak,
    rn: p.reconstructedNights,
    co: 0,
  }));
  const order = wins
    .map((w, i) => ({ i, t: d.projects[i].confirmedAt ? Date.parse(d.projects[i].confirmedAt!) : Infinity }))
    .sort((a, b) => a.t - b.t || a.i - b.i);
  order.forEach((x, k) => {
    wins[x.i].co = k;
  });
  return { lastNight: d.lastNight, live: d.night !== null, nwin: baysFor(wins.length), wins };
}

const LABEL: Record<Status, string> = {
  shipped: "Shipped",
  building: "Building",
  quiet: "Quiet",
  down: "Down",
  unavailable: "Unavailable",
};
const MEANING: Record<Status, string> = {
  shipped: "new work reached users",
  building: "code landed, not live yet",
  quiet: "no verified change seen",
  down: "the live app is not answering",
  unavailable: "no source answered, so no claim either way",
};

/** "Shipped last night: new work reached users" / "Building on 3 Nov: code landed, not live yet". */
export function statusLine(w: Pick<TowerWindow, "st" | "stLast" | "stDay">): string {
  if (!w.st) return "Not checked yet: its first live night is at 05:00 UTC";
  const when = w.stLast ? " last night" : w.stDay ? ` on ${w.stDay}` : "";
  return `${LABEL[w.st]}${when}: ${MEANING[w.st]}`;
}

/** Swatch class for a status (globals.css). */
export function swatchFor(st: Status | null): string {
  return st === "shipped" || st === "building" || st === "quiet" || st === "down" ? `sw-${st}` : "sw-none";
}

export const isLit = (st: Status | null) => st === "shipped" || st === "building";
/** Quiet, down and building nights say nothing new reached users; unchecked and unavailable ones make no claim. */
export const claimsNothingNew = (st: Status | null) => st === "quiet" || st === "down" || st === "building";

export function whatLabel(w: Pick<TowerWindow, "st">): string {
  return w.st === "shipped" ? "What reached users" : "Work that landed";
}

/** The one-line text a screen reader hears for a window, and the sr-only list item. */
export function describeWindow(w: TowerWindow): string {
  const what = isLit(w.st)
    ? w.w.length
      ? ` ${whatLabel(w)}: ${w.w.join("; ")}.`
      : ""
    : claimsNothingNew(w.st)
      ? " Nothing new reached users."
      : "";
  const hist = w.rn > 0 ? " Includes reconstructed history." : "";
  return `${w.name}, ${w.src}. ${statusLine(w)}.${what} Lit ${w.l30} of the last 30 nights.${hist}`;
}
