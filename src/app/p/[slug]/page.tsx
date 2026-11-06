import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import { getProjectView, type ProjectView } from "@/lib/views/project";
import { nightLabel, STATUS_LABEL, STATUS_MEANING } from "@/lib/views/reasons";
import { ProjectEyebrow } from "@/components/project/ProjectEyebrow";
import { NightStrip } from "@/components/project/NightStrip";
import { LiveShift } from "@/components/project/LiveShift";
import { Tranches } from "@/components/project/Tranches";
import { getLiveCampaign } from "@/lib/views/vibestarterLive";
import { telegramLink, telegramProjectToken } from "@/lib/views/backer";
import s from "@/components/project/project.module.css";

/** ISR: a project page is rebuilt from the DB at most every 5 minutes. */
export const revalidate = 300;

/** None at build time: each page is rendered on its first request, then cached and revalidated (ISR). */
export async function generateStaticParams() {
  return [];
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/;

async function load(slug: string): Promise<ProjectView | null> {
  if (!SLUG.test(slug)) return null;
  return getProjectView(await getDb(), slug);
}

export async function generateMetadata({ params }: PageProps<"/p/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  const v = await load(slug).catch(() => null);
  return v ? { title: `${v.name} · Lights On`, description: v.tagline ?? undefined } : { title: "Not found · Lights On" };
}

const swatch = (st: ProjectView["status"]) =>
  st === "shipped" || st === "building" || st === "quiet" || st === "down" ? `sw-${st}` : "sw-none";

export default async function ProjectPage({ params }: PageProps<"/p/[slug]">) {
  const { slug } = await params;
  const v = await load(slug);
  if (!v) notFound();

  const when = v.statusNight === null ? "" : v.statusNight === v.lastNight ? " last night" : ` on ${nightLabel(v.statusNight)}`;
  const base = v.contracts.filter((c) => c.chainId === 8453);
  const live = v.vibestarter ? await getLiveCampaign(v.vibestarter.campaignId) : null;
  const tg = telegramLink(telegramProjectToken(v.slug));
  return (
    <main id="main" className="wrap page-top">
      <ProjectEyebrow source={v.source} communityAdded={v.communityAdded} claimedBy={v.claimedBy} />

      <h1 className="h-page rv d1">{v.name}</h1>
      {v.tagline ? <p className="lede rv d1">{v.tagline}</p> : null}
      <p className={`${s.links} rv d2`}>
        {v.liveUrl ? (
          <a className="ul" href={v.liveUrl} target="_blank" rel="noreferrer">
            Live app
          </a>
        ) : null}
        {v.repoUrl ? (
          <a className="ul" href={v.repoUrl} target="_blank" rel="noreferrer">
            Repo {v.repo}
          </a>
        ) : (
          <span className="k">no public repo</span>
        )}
        {base.slice(0, 3).map((c) => (
          <a key={c.address} className="ul" href={`https://basescan.org/address/${c.address}`} target="_blank" rel="noreferrer">
            {c.role || "contract"} {c.address.slice(0, 6)}…{c.address.slice(-4)}
          </a>
        ))}
        {tg ? (
          <a className="ul" href={tg} target="_blank" rel="noreferrer">
            Follow on Telegram
          </a>
        ) : null}
        <Link className="ul" href={`/claim/${v.slug}`}>
          {v.claimedBy ? "Founder tools" : "Is this your project? Claim it"}
        </Link>
      </p>
      {v.communityAdded ? (
        <p className="k rv d2" style={{ marginTop: 12 }}>
          Added by someone on the watch list form. Its sources are not verified by us and it stays off the building until it is
          reviewed; the readings below follow the same rules as every other project.
        </p>
      ) : null}

      <section className={`panel ${s.status} rv d2`} aria-label="Current status" data-testid="project-status">
        <i className={`${s.big} sw ${swatch(v.status)}`} aria-hidden="true" />
        <div>
          <div className={s.statusText}>
            {v.status ? (
              <>
                {STATUS_LABEL[v.status]}
                {when}: <span className={s.meaning}>{STATUS_MEANING[v.status]}</span>
              </>
            ) : (
              <>
                Not checked yet: <span className={s.meaning}>its first live night is at 05:00 UTC</span>
              </>
            )}
          </div>
          <div className={s.meta}>
            <span>
              Streak <b>{v.streak}</b> night{v.streak === 1 ? "" : "s"}
            </span>
            <span>
              Lit <b>{v.lit30}</b> of the last 30
            </span>
            <span>Last ship {v.lastShip ? <b>{nightLabel(v.lastShip)}</b> : "none in 90 nights"}</span>
            {v.status && !v.statusObserved ? (
              <span className="tag">
                <i className="sw sw-hatch" aria-hidden="true" />
                from reconstructed history
              </span>
            ) : null}
          </div>
        </div>
      </section>

      <section className={s.stripSec} aria-labelledby="strip-title">
        <div className={s.stripHead}>
          <h2 id="strip-title" className="h-sec">
            90 nights
          </h2>
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
            <span>
              <i className="sw sw-none" aria-hidden="true" />
              no reading
            </span>
            <span>
              <i className="sw sw-hatch" aria-hidden="true" />
              reconstructed
            </span>
          </span>
        </div>
        <NightStrip slug={v.slug} strip={v.strip} watcher={process.env.NEXT_PUBLIC_WATCHER_ADDRESS ?? null} />
        {v.reconstructedNights > 0 ? (
          <p className={s.small} style={{ marginTop: 10 }}>
            {v.reconstructedNights} of these nights are reconstructed from git history and Wayback captures: hatched, never
            attested. <Link className="ul" href="/methodology#reconstructed">How reconstruction works</Link>
          </p>
        ) : null}
      </section>

      <div className={s.cols}>
        <LiveShift slug={v.slug} />
        {v.vibestarter ? (
          <Tranches vibestarter={v.vibestarter} live={live} facts={v.vibestarterFacts} now={v.generatedAt} />
        ) : (
          <section className={`panel ${s.card}`} aria-labelledby="watch-title">
            <div className={s.cardHead}>
              <h2 id="watch-title" className={s.cardTitle}>
                What the agent watches
              </h2>
            </div>
            <dl className={s.kv}>
              <dt>Live app</dt>
              <dd>{v.liveUrl ?? "none listed"}</dd>
              <dt>Repo</dt>
              <dd>{v.repo ?? "none listed"}</dd>
              <dt>Contracts</dt>
              <dd>{v.contracts.length ? `${v.contracts.length} listed` : "none listed"}</dd>
              <dt>Token</dt>
              <dd>{v.token?.symbol || (v.token ? "listed" : "none")}</dd>
            </dl>
            <p className={s.small} style={{ marginTop: 12 }}>
              Each night these sources decide the status by the <Link className="ul" href="/methodology">published rules</Link>.
            </p>
          </section>
        )}
      </div>
    </main>
  );
}
