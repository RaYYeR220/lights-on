import type { AdapterResult, ChainFacts, EvidenceBundle, LiveAppFacts, RepoFacts, VibestarterFacts } from "@/lib/types";
import s from "./project.module.css";

const MAX_COMMITS = 8;

function Head({ name, r }: { name: string; r: AdapterResult<unknown> }) {
  return (
    <div className={s.srcHead}>
      <span>{name}</span>
      <span className="tag">
        {r.ok ? (r.degraded ? "read, degraded" : "read") : `failed${r.error ? ` (${r.error})` : ""}`}
      </span>
    </div>
  );
}

function Repo({ r }: { r: AdapterResult<RepoFacts> }) {
  const f = r.facts;
  return (
    <div className={s.src}>
      <Head name="Repo" r={r} />
      {f ? (
        <>
          <p className={s.small} style={{ margin: "6px 0 0" }}>
            {f.repo} · {f.branch} · {f.commits.length} commit{f.commits.length === 1 ? "" : "s"} · {f.releases.length} release
            {f.releases.length === 1 ? "" : "s"} · read via {f.mode}
          </p>
          {f.releases.length ? (
            <ul className={s.commits}>
              {f.releases.map((x) => (
                <li key={x.tag}>
                  <span className={s.sha}>release</span> {x.name || x.tag}
                </li>
              ))}
            </ul>
          ) : null}
          {f.commits.length ? (
            <ul className={s.commits}>
              {f.commits.slice(0, MAX_COMMITS).map((c) => (
                <li key={c.sha}>
                  <span className={s.sha}>{c.sha.slice(0, 7)}</span> {c.message.split("\n")[0]}
                  {c.authorIsBot ? <span className={s.sha}> · bot</span> : null}
                  {c.kind === "cosmetic" ? <span className={s.sha}> · docs/config only</span> : null}
                </li>
              ))}
              {f.commits.length > MAX_COMMITS ? <li className={s.sha}>+{f.commits.length - MAX_COMMITS} more in the bundle</li> : null}
            </ul>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function Live({ r }: { r: AdapterResult<LiveAppFacts> }) {
  const f = r.facts;
  return (
    <div className={s.src}>
      <Head name="Live app" r={r} />
      {f ? (
        <dl className={s.kv}>
          <dt>URL</dt>
          <dd>{f.finalUrl ?? f.url}</dd>
          <dt>Answer</dt>
          <dd>
            {f.up ? "up" : "not answering"}
            {f.httpStatus !== null ? ` · HTTP ${f.httpStatus}` : ""}
            {f.latencyMs !== null ? ` · ${f.latencyMs} ms` : ""}
          </dd>
          <dt>New deploy</dt>
          <dd>{f.newDeploy ? "yes" : "no"}</dd>
          {f.deployFingerprint ? (
            <>
              <dt>Fingerprint</dt>
              <dd>{f.deployFingerprint.slice(0, 18)}…</dd>
            </>
          ) : null}
          {f.textDelta && f.textDelta.changedChars > 0 ? (
            <>
              <dt>Text change</dt>
              <dd>{f.textDelta.changedChars} characters</dd>
            </>
          ) : null}
        </dl>
      ) : null}
    </div>
  );
}

function Chain({ r }: { r: AdapterResult<ChainFacts> }) {
  const f = r.facts;
  return (
    <div className={s.src}>
      <Head name="Chain" r={r} />
      {f ? (
        <dl className={s.kv}>
          <dt>Contracts</dt>
          <dd>
            {f.contracts.length} watched · {f.contracts.reduce((n, c) => n + c.txCount, 0)} tx in the window
          </dd>
          <dt>New deploys</dt>
          <dd>
            {f.newDeployments.length
              ? f.newDeployments.map((d) => (
                  <a key={d.txHash} className="ul" href={`https://basescan.org/tx/${d.txHash}`} target="_blank" rel="noreferrer" style={{ marginRight: 8 }}>
                    {d.address.slice(0, 10)}…
                  </a>
                ))
              : "none"}
          </dd>
        </dl>
      ) : null}
    </div>
  );
}

function Vibestarter({ r }: { r: AdapterResult<VibestarterFacts> }) {
  const f = r.facts;
  return (
    <div className={s.src}>
      <Head name="Vibestarter" r={r} />
      {f ? (
        <>
          <dl className={s.kv}>
            <dt>Raise</dt>
            <dd>{f.raiseStatus.toLowerCase()}</dd>
            <dt>Tranches</dt>
            <dd>{f.tranches.length ? f.tranches.map((t) => `${t.index === 0 ? "K" : `T${t.index}`} ${t.status.toLowerCase()}`).join(" · ") : "none listed"}</dd>
            <dt>Updates</dt>
            <dd>{f.founderUpdates.length} founder update{f.founderUpdates.length === 1 ? "" : "s"} in the window</dd>
          </dl>
          {f.reportedActivity.length ? (
            <ul className={s.commits}>
              {f.reportedActivity.slice(0, 6).map((a) => (
                <li key={`${a.at}-${a.summary}`}>
                  <span className={s.sha}>{a.type}</span> {a.summary}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/** One night's evidence, grouped by tier: what we observed ourselves decides; what is reported never does. */
export function EvidenceView({ bundle }: { bundle: EvidenceBundle }) {
  const { repo, liveapp, chain, vibestarter } = bundle.sources ?? {};
  const verified = [repo, liveapp, chain].some(Boolean);
  return (
    <div>
      <p className={s.small} style={{ margin: 0 }}>
        VERIFIED: observed by us. Only this tier decides the status.
      </p>
      {verified ? null : <p className={s.note}>No verified source was recorded for this night.</p>}
      {repo ? <Repo r={repo} /> : null}
      {liveapp ? <Live r={liveapp} /> : null}
      {chain ? <Chain r={chain} /> : null}
      <p className={s.small} style={{ margin: "16px 0 0" }}>
        REPORTED: from Vibestarter and founders. Shown, never counted.
      </p>
      {vibestarter ? <Vibestarter r={vibestarter} /> : <p className={s.note}>Nothing reported for this night.</p>}
    </div>
  );
}
