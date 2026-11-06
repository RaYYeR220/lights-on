import type { Metadata } from "next";
import Link from "next/link";
import { RULES_TEXT } from "@/lib/shift/rules";
import { RULES_VERSION } from "@/lib/shift/evidence";
import { SCHEMA } from "@/lib/attest/eas";
import s from "@/components/docs/docs.module.css";

export const metadata: Metadata = {
  title: "Methodology · Lights On",
  description: "The published rules behind every night's status, the evidence tiers, reconstructed history, attestation on Base, and the limits.",
};

const TOC = [
  ["rules", "The rules"],
  ["tiers", "Evidence tiers"],
  ["reconstructed", "Reconstructed history"],
  ["attestation", "Attestation on Base"],
  ["verify", "Verify a night"],
  ["limits", "Honest limits"],
] as const;

export default function MethodologyPage() {
  return (
    <main id="main" className="wrap page-top">
      <p className="eyebrow rv">Methodology · rules {RULES_VERSION}</p>
      <h1 className="h-page rv d1">How a night is decided</h1>
      <p className="lede rv d1">
        Every status on this site comes from fixed rules applied to evidence we observed ourselves. The same rules run every
        night, the evidence is published, and each verdict is attested on Base so anyone can check it.
      </p>

      <div className={s.layout}>
        <nav className={s.toc} aria-label="On this page">
          {TOC.map(([id, label]) => (
            <a key={id} href={`#${id}`}>
              {label}
            </a>
          ))}
        </nav>
        <div className={s.body}>
          <section id="rules" className={s.sec} aria-labelledby="rules-h">
            <h2 id="rules-h" className="h-sec">
              The rules
            </h2>
            <p>Quoted verbatim from the code that decides (rules version {RULES_VERSION}):</p>
            <ul className={s.rules} data-testid="rules">
              {RULES_TEXT.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </section>

          <section id="tiers" className={s.sec} aria-labelledby="tiers-h">
            <h2 id="tiers-h" className="h-sec">
              Evidence tiers
            </h2>
            <div className={s.tiers}>
              <div className={`panel ${s.tier}`}>
                <h3>VERIFIED</h3>
                <p>
                  What we observed ourselves: the public repo (commits, releases, tags), the live app (answers, deploy
                  fingerprint from hashed asset paths), and the chain (contract creations by listed deployers). Only this
                  tier decides a status.
                </p>
              </div>
              <div className={`panel ${s.tier}`}>
                <h3>REPORTED</h3>
                <p>
                  What others tell us: Vibestarter raise and tranche data, founder updates, activity feeds, founder notes.
                  Shown with every night, never counted toward a status.
                </p>
              </div>
            </div>
          </section>

          <section id="reconstructed" className={s.sec} aria-labelledby="rec-h">
            <h2 id="rec-h" className="h-sec">
              Reconstructed history
            </h2>
            <p>
              The watch started with 90 nights of history rebuilt after the fact, so a window is not empty on day one. Those
              nights are labelled <strong>reconstructed</strong>, hatched wherever they appear, and never attested.
            </p>
            <ul>
              <li>
                <strong>Git:</strong> each public repo is cloned and its commits are bucketed into nights by author date, with
                the same code-versus-cosmetic path rules as the live shift. No rows exist before a repo&apos;s first commit.
              </li>
              <li>
                <strong>Wayback:</strong> archived captures of the live app give a deploy fingerprint per capture. A changed
                fingerprint between two captures counts as a deploy on the later night. For a project without a repo, quiet
                nights are filled in only between two captures with the same fingerprint; anywhere else the night stays
                unknown.
              </li>
              <li>
                <strong>Live nights win:</strong> once the nightly shift has observed a night, its reading replaces the
                reconstructed one everywhere on the site; the reconstructed row is kept and shown in the night drawer.
              </li>
            </ul>
          </section>

          <section id="attestation" className={s.sec} aria-labelledby="att-h">
            <h2 id="att-h" className="h-sec">
              Attestation on Base
            </h2>
            <p>
              Each observed night is attested with EAS on Base mainnet: one <code>multiAttest</code> transaction per nightly
              shift, one <code>attest</code> per live run. The evidence hash is keccak256 of the bundle&apos;s canonical JSON
              (sorted keys, no whitespace), and the bundle is served byte for byte at{" "}
              <code>/api/v1/evidence/&lt;hash&gt;</code>. The schema (non-revocable, no resolver):
            </p>
            <pre className={s.pre}>{SCHEMA.split(",").join(",\n")}</pre>
            <p>
              Gas is capped per day. Over the cap a run still finishes and says <code>attestation: skipped</code>; it never
              shows an attestation that does not exist.
            </p>
          </section>

          <section id="verify" className={s.sec} aria-labelledby="ver-h">
            <h2 id="ver-h" className="h-sec">
              Verify a night
            </h2>
            <p>
              <strong>In the browser:</strong> open any project, click a night, then <em>Verify in this browser</em>. It
              re-hashes the published bundle, reads the attestation from Base, and checks the schema, the attester, that it is
              not revoked or expired, and that its project, night and evidence hash match.
            </p>
            <p>
              <strong>From a terminal</strong>, with the repo checked out:
            </p>
            <pre className={s.pre}>{`curl -s <site>/api/v1/evidence/<hash> > evidence.json
pnpm tsx scripts/verify-night.ts --network base \\
  --uid <attestation uid> --bundle evidence.json --attester <watcher address>`}</pre>
            <p>
              It prints PASS or FAIL per check and exits 0 only on a full match. More in the <Link className="ul" href="/docs#verify">docs</Link>.
            </p>
          </section>

          <section id="limits" className={s.sec} aria-labelledby="lim-h">
            <h2 id="lim-h" className="h-sec">
              Honest limits
            </h2>
            <ul data-testid="limits">
              <li>
                <strong>Private repos</strong> are invisible to us. A team that ships from a private repo shows only its
                deploys and contracts, so it can read quiet while it is busy.
              </li>
              <li>
                <strong>Projects without a repo</strong> have only the live app and the chain, and their reconstructed history
                is sparse: Wayback archived some of them once or never, so most of their history is unknown, not quiet.
              </li>
              <li>
                <strong>Contract creations</strong> by a deployer come from Blockscout; when Blockscout does not answer, new
                deployments can be missed for that night and the chain source is marked as failed.
              </li>
              <li>
                <strong>The AI explains, it never decides.</strong> A model writes the one-line summary after the rules have
                decided; if it fails or runs out of budget the night says &quot;explanation unavailable&quot; and the status
                is unchanged.
              </li>
              <li>
                <strong>Social signals are not read.</strong> Posts on X, Discord or Farcaster, and announcements anywhere,
                never count: only work that reached users does.
              </li>
              <li>
                <strong>A deploy is not a feature.</strong> A new deploy fingerprint means new code reached users, not that it
                was big; the evidence shows what changed so you can judge.
              </li>
            </ul>
          </section>
        </div>
      </div>
    </main>
  );
}
