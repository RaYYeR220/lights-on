import { towerPrePaintScript } from "./prePaintScript";

/** Renders the pre-paint sizing script (our own code and an integer, nothing user-supplied). */
export function TowerPrePaint({ nwin }: { nwin: number }) {
  return <script dangerouslySetInnerHTML={{ __html: towerPrePaintScript(nwin) }} />;
}
