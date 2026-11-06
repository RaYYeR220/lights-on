import { computeGeometry, RAIL_H_DESKTOP, RAIL_H_MOBILE } from "./geometry";

/**
 * Inline script that sizes the building before first paint (where the fold falls, the canvas height, the rail
 * width), so the hero does not jump when the client renderer takes over. Same function, same numbers.
 */
export function towerPrePaintScript(nwin: number): string {
  return `(function(){try{var d=document.documentElement,w=window,vw=w.innerWidth;var g=(${computeGeometry.toString()})({cssW:d.clientWidth,vw:vw,vh:w.innerHeight,dpr:w.devicePixelRatio||1,nwin:${Number(nwin) | 0},railH:vw<=640?${RAIL_H_MOBILE}:${RAIL_H_DESKTOP}});var s=d.style;s.setProperty('--tower-peek',g.peek+'px');s.setProperty('--tower-h',(g.ch/g.dpr)+'px');s.setProperty('--tower-bw',(g.bw/g.dpr)+'px');}catch(e){}})();`;
}

export function TowerPrePaint({ nwin }: { nwin: number }) {
  return <script dangerouslySetInnerHTML={{ __html: towerPrePaintScript(nwin) }} />;
}
