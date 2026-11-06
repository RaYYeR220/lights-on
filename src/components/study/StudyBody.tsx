import Link from "next/link";
import type { StudyLink, StudyView } from "@/lib/views/study";
import s from "./study.module.css";

function Name({ item }: { item: StudyLink }) {
  return item.href ? (
    <Link className={s.link} href={item.href} prefetch={false}>
      {item.name}
    </Link>
  ) : (
    <span>{item.name}</span>
  );
}

const Day = ({ iso, text }: { iso: string; text: string }) => <time dateTime={iso}>{text}</time>;

function Legend() {
  return (
    <span className={s.legend} aria-label="Legend">
      <span>
        <i className="sw sw-shipped" aria-hidden="true" />
        shipped
      </span>
      <span>
        <i className="sw sw-building" aria-hidden="true" />
        commits only
      </span>
      <span>
        <i className="sw sw-quiet" aria-hidden="true" />
        quiet
      </span>
    </span>
  );
}

const muted = (v: string) => (v === "unknown" || v === "none seen" ? s.muted : undefined);

/** The /study page: the field study behind Lights On, every number from results/*.json via studyView(). */
export function StudyBody({ view }: { view: StudyView }) {
  const { v01, cvs, method } = view;
  return (
    <main id="main" className="wrap page-top">
      <header className={s.hero}>
        <p className="eyebrow rv">Study · why Lights On exists</p>
        <h1 className={`${s.claim} rv d1`} data-testid="study-claim">
          {view.headline}
        </h1>
        <p className={`${s.meta} rv d2`}>
          <span>
            <i className="sw sw-hatch" aria-hidden="true" />
            {view.basis}
          </span>
          <span>
            as of <Day iso={view.asOf} text={view.asOfText} />
          </span>
          <span>
            {view.windowNights}-night window: <Day iso={view.window30From} text={view.window30FromText} /> →{" "}
            <Day iso={view.latestNight} text={view.latestNightText} />
          </span>
        </p>
        <p className="lede rv d2">
          Lights On checks every night whether a project&apos;s work reached users. Before the watch began, each
          project&apos;s recent history was rebuilt from its public repo and from Wayback captures of its live app, to see
          what happens after a hackathon. Quiet means no verified change seen, nothing more.
        </p>
      </header>

      <section id="cohorts" className={s.sec} aria-labelledby="cohorts-h">
        <div className={s.secHead}>
          <h2 id="cohorts-h" className="h-sec">
            Who is still lit
          </h2>
          <Legend />
        </div>
        <div className={`panel ${s.facade}`} data-testid="cohorts">
          {view.cohorts.map((c) => (
            <div key={c.id} className={s.floor}>
              <div>
                <span className={s.floorName}>{c.label}</span>
                {c.hint ? <span className={`k ${s.floorHint}`}>{c.hint}</span> : null}
              </div>
              <div className={s.windows} role="img" aria-label={c.ariaLabel}>
                {c.windows.map((w, i) => (
                  <i key={i} className={`sw sw-${w} ${s.win}`} />
                ))}
              </div>
              <div className={s.count} aria-hidden="true">
                <b>{c.count}</b>
                <span className="k">{c.detail}</span>
              </div>
            </div>
          ))}
        </div>
        <p className={s.caption}>
          Active means a commit, or a detected deploy, release or contract deploy, in the window. Shipped means the
          deploy, release or contract deploy was detected. One window per project with a full window; projects without
          one are not drawn and never counted as quiet.
        </p>
        <p className={s.contrast} data-testid="study-contrast">
          {view.contrast}
        </p>
      </section>

      <section id="vibeathon-01" className={s.sec} aria-labelledby="v01-h">
        <h2 id="v01-h" className="h-sec">
          {v01.heading}
        </h2>
        <p className={s.secLead}>{v01.sentence}</p>
        <p className={s.stat} data-testid="v01-summary">
          {v01.summary}
        </p>
        <div className={s.tableWrap} role="region" aria-labelledby="v01-caption" tabIndex={0}>
          <table className={s.table} data-testid="v01-table">
            <caption id="v01-caption" className="sr-only">
              {v01.heading}: the finalists, their live apps, public repos, history coverage and activity
            </caption>
            <thead>
              <tr>
                <th scope="col">Project</th>
                <th scope="col">
                  Live app answers
                  <a className={s.fn} href="#liveup-basis" aria-label="How the live app check is made">
                    *
                  </a>
                </th>
                <th scope="col">Public repo</th>
                <th scope="col">History coverage</th>
                <th scope="col">Active in last {view.windowNights} nights</th>
                <th scope="col">Last activity</th>
              </tr>
            </thead>
            <tbody>
              {v01.rows.map((r) => (
                <tr key={r.name}>
                  <th scope="row">
                    <Name item={r} />
                  </th>
                  <td className={muted(r.liveUp)}>{r.liveUp}</td>
                  <td>{r.publicRepo}</td>
                  <td className={r.coverage === "no public history" ? s.muted : undefined}>{r.coverage}</td>
                  <td className={muted(r.active30)}>{r.active30}</td>
                  <td className={muted(r.lastActivityText)}>
                    {r.lastActivity ? <Day iso={r.lastActivity} text={r.lastActivityText} /> : r.lastActivityText}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p id="liveup-basis" className={s.caption}>
          * {v01.liveUpBasis}
        </p>
      </section>

      <section id="commits" className={s.sec} aria-labelledby="cvs-h">
        <h2 id="cvs-h" className="h-sec">
          Commit graphs vs shipping
        </h2>
        <div className={s.pair}>
          <div className={`panel ${s.group}`} data-testid="cvs-commits">
            <p className={s.groupHead}>
              <i className="sw sw-building" aria-hidden="true" />
              <span>{cvs.commits.heading}</span>
            </p>
            <ul className={s.names}>
              {cvs.commits.items.map((i) => (
                <li key={i.name}>
                  <Name item={i} />
                </li>
              ))}
            </ul>
            <p className={s.caption}>{cvs.commits.caption}</p>
          </div>
          <div className={`panel ${s.group}`} data-testid="cvs-ships">
            <p className={s.groupHead}>
              <i className="sw sw-shipped" aria-hidden="true" />
              <span>{cvs.ships.heading}</span>
            </p>
            <ul className={s.names}>
              {cvs.ships.items.map((i) => (
                <li key={i.name}>
                  <Name item={i} />
                  <span className="k">{i.nightsText}</span>
                </li>
              ))}
            </ul>
            <p className={s.caption}>{cvs.ships.caption}</p>
          </div>
        </div>
        <p className={s.secLead}>{cvs.why}</p>
      </section>

      <section id="method" className={s.sec} aria-labelledby="method-h">
        <h2 id="method-h" className="h-sec">
          Method and limits
        </h2>
        <dl className={s.method}>
          <dt>Basis</dt>
          <dd>{method.basis}</dd>
          <dt>Windows</dt>
          <dd>{method.windows}</dd>
          <dt>Reproduce</dt>
          <dd>
            <pre className={s.pre}>
              <code>{method.command}</code>
            </pre>
            <p>
              It reads the watch database and rewrites <code>results/*.json</code>; the README and this page are rendered
              from those files. Source:{" "}
              <a className="ul" href={method.sourceUrl} target="_blank" rel="noreferrer">
                scripts/study.ts on GitHub
              </a>
              .
            </p>
          </dd>
          <dt>From now on</dt>
          <dd>{method.observed}</dd>
          <dt>Limits</dt>
          <dd>
            <ul className={s.limits}>
              <li>
                Quiet means no verified change seen in the public repo, the live app or the listed contracts. It does not
                mean a team has stopped.
              </li>
              <li>Private repos are invisible to us, so a team that ships from one can read quiet while it is busy.</li>
              <li>Reconstructed nights are labelled as such and never attested.</li>
            </ul>
          </dd>
        </dl>
        <p className={s.more}>
          <Link className="ul" href="/methodology#reconstructed">
            How reconstructed history is built
          </Link>
          <Link className="ul" href="/night">
            Last night&apos;s shift
          </Link>
        </p>
      </section>
    </main>
  );
}
