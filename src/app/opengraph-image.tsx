import { ImageResponse } from "next/og";
import { getDb } from "@/lib/db";
import { getTowerData } from "@/lib/views/tower";
import { towerSvg } from "@/lib/og/towerSvg";

export const alt = "Lights On: know by morning if they're still shipping.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const revalidate = 3600;

/* Clash Display 500 as TTF, delivered by Fontshare (the share image renders it; the files are never redistributed). */
const CLASH_TTF = "https://cdn.fontshare.com/wf/2GQIT54GKQY3JRFTSHS4ARTRNRQISSAA/3CIP5EBHRRHE5FVQU3VFROPUERNDSTDF/JTSL5QESUXATU47LCPUNHZQBDDIWDOSW.ttf";

async function clash(): Promise<ArrayBuffer | null> {
  try {
    const r = await fetch(CLASH_TTF, { next: { revalidate: 86400 } });
    return r.ok ? await r.arrayBuffer() : null;
  } catch {
    return null;
  }
}

export default async function OpengraphImage() {
  const [data, font] = await Promise.all([getTowerData(await getDb()).catch(() => null), clash()]);
  const projects = data?.projects ?? [];
  const svg = towerSvg(projects, { width: 1200, height: 250, cols: 12, rows: 3 });
  const src = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  const shipped = projects.filter((p) => p.history[89] === "shipped").length;
  const proof = data
    ? data.night !== null
      ? `${projects.length} watched · ${data.shippedOnNight ?? 0} shipped last night · attested on Base`
      : `${projects.length} watched · ${shipped} shipped last night (reconstructed) · first live night at 05:00 UTC`
    : "A nightly check of what reached users, attested on Base";
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          background: "linear-gradient(180deg, #0e141f 0%, #111824 60%)",
          color: "#eef2f8",
          position: "relative",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 44, fontSize: 26, fontFamily: font ? "Clash" : "sans-serif" }}>
          <div style={{ display: "flex", flexWrap: "wrap", width: 22, height: 22, gap: 2, padding: 2, borderRadius: 3, border: "1px solid rgba(238,242,248,.18)" }}>
            <div style={{ width: 7, height: 7, background: "#1f2a3c", borderRadius: 1 }} />
            <div style={{ width: 7, height: 7, background: "#1f2a3c", borderRadius: 1 }} />
            <div style={{ width: 7, height: 7, background: "#1f2a3c", borderRadius: 1 }} />
            <div style={{ width: 7, height: 7, background: "#c6d6f0", borderRadius: 1, boxShadow: "0 0 8px 2px rgba(198,214,240,.6)" }} />
          </div>
          Lights On
        </div>
        <div
          style={{
            display: "flex",
            textAlign: "center",
            marginTop: 34,
            fontSize: 84,
            lineHeight: 0.95,
            letterSpacing: "-0.04em",
            fontFamily: font ? "Clash" : "sans-serif",
            fontWeight: 500,
            maxWidth: 1000,
          }}
        >
          Know by morning if they&apos;re still shipping.
        </div>
        <div style={{ display: "flex", marginTop: 26, fontSize: 21, color: "#7c889a", fontFamily: "monospace" }}>{proof}</div>
        {/* eslint-disable-next-line @next/next/no-img-element -- ImageResponse renders plain img */}
        <img src={src} width={1200} height={250} alt="" style={{ position: "absolute", left: 0, bottom: -60 }} />
      </div>
    ),
    { ...size, fonts: font ? [{ name: "Clash", data: font, weight: 500, style: "normal" }] : undefined },
  );
}

