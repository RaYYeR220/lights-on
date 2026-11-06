import { getDb } from "@/lib/db";
import { getTowerData, type TowerData } from "@/lib/views/tower";
import { cached } from "@/lib/apiCache";
import { HeroCtas } from "@/components/bags/HeroCtas";
import { Tower } from "@/components/tower/Tower";
import { TowerPrePaint } from "@/components/tower/PrePaint";
import { dayLabel, toTowerModel } from "@/components/tower/model";
import { StudyStrip } from "@/components/study/StudyStrip";
import { getStudyView } from "@/lib/views/study";
import s from "./home.module.css";

/** ISR: the building is rebuilt from the DB at most every 5 minutes. */
export const revalidate = 300;

async function loadTower(): Promise<TowerData | null> {
  try {
    // shared with the share image; at most one tower read per instance per 2 min
    return await cached("tower", async () => getTowerData(await getDb()));
  } catch (e) {
    console.error("landing: tower data unavailable:", e instanceof Error ? e.message : e);
    return null;
  }
}

function Legend({ withNone }: { withNone: boolean }) {
  return (
    <span className={s.legend} aria-label="Legend">
      <span>
        <i className="sw sw-shipped" aria-hidden="true" />
        shipped
      </span>
      <span>
        <i className="sw sw-building" aria-hidden="true" />
        building
      </span>
      <span>
        <i className="sw sw-quiet" aria-hidden="true" />
        quiet
      </span>
      <span>
        <i className="sw sw-down" aria-hidden="true" />
        down
      </span>
      {withNone ? (
        <span>
          <i className="sw sw-none" aria-hidden="true" />
          no reading
        </span>
      ) : null}
    </span>
  );
}

function Proof({ data }: { data: TowerData }) {
  const n = data.projects.length;
  if (data.night !== null) {
    return (
      <>
        <span>
          <span className={s.nw}>
            Night of {dayLabel(data.night)} {data.attested ? "attested on Base" : "checked"} ·
          </span>{" "}
          <span className={s.nw}>
            <b>{n}</b> watched · <b>{data.shippedOnNight ?? 0}</b> shipped
          </span>
        </span>
      </>
    );
  }
  return (
    <span>
      <span className={s.nw}>
        <b>{n}</b> watched ·
      </span>{" "}
      <span className={`${s.nw} ${s.inline}`}>
        <i className="sw sw-hatch" aria-hidden="true" />
        history reconstructed ·
      </span>{" "}
      <span className={s.nw}>first live night at 05:00 UTC</span>
    </span>
  );
}

export default async function Home() {
  const data = await loadTower();
  const model = data ? toTowerModel(data) : null;
  const withNone = model ? model.wins.some((w) => w.h.includes("-") || w.h.includes("u")) : false;
  return (
    <main id="main">
      {model ? <TowerPrePaint nwin={model.nwin} /> : null}
      <section className={s.hero} aria-labelledby="hero-title">
        <div className={s.copy}>
          <h1 id="hero-title" className={`${s.h1} rv`}>
            Know by morning if <br />
            they&apos;re still shipping.
          </h1>
          <p className={`${s.sub} rv d1`}>
            Every night an agent checks the projects you backed for work that actually reached users, attests the
            verdict on Base, and tells you by breakfast.
          </p>
          <HeroCtas className={`${s.ctas} rv d2`} />
          <p className={`${s.proof} rv d3`}>
            {data ? <Proof data={data} /> : <span>Last night&apos;s readings are not available right now.</span>}
            <Legend withNone={withNone} />
          </p>
        </div>
        {model ? <Tower model={model} /> : <p className={s.down}>The building could not be loaded. It is rebuilt every 5 minutes, so try again shortly.</p>}
      </section>
      <StudyStrip view={getStudyView()} />
    </main>
  );
}
