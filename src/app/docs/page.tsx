import type { Metadata } from "next";
import Link from "next/link";
import s from "@/components/docs/docs.module.css";

export const metadata: Metadata = {
  title: "Docs · Lights On",
  description: "The REST API, the MCP server for agents, and how to verify any night yourself.",
};

const TOC = [
  ["api", "REST API"],
  ["mcp", "MCP for agents"],
  ["verify", "Verify a night"],
] as const;

interface Endpoint {
  path: string;
  live: boolean;
  text: string;
  shape?: string;
}

const ENDPOINTS: Endpoint[] = [
  {
    path: "GET /api/v1/evidence/{hash}",
    live: true,
    text: "The evidence bundle of one night, as canonical JSON: keccak256 of the response body equals the hash. Cached forever (content-addressed); 404 when unknown.",
  },
  {
    path: "GET /api/v1/briefing/{address}",
    live: true,
    text: "The projects a wallet backed on Vibestarter or holds as a watched token, and its morning briefing. Accepts a 0x address or an ENS name.",
    shape: `{ address, projects: [{ slug, name, via, amountWei?, balance?, symbol? }],
  briefing: { text, aiOk }, degraded }`,
  },
  {
    path: "GET /api/v1/projects?with=lastNight",
    live: false,
    text: "Every watched project with its latest status and record.",
    shape: `{ projects: [{ slug, name, tagline, source, status, confirmedAt,
  summary, record: { streak, lit30, lastShip } }] }`,
  },
  {
    path: "GET /api/v1/projects/{slug}",
    live: false,
    text: "One project: sources, status, record and latest attestation.",
  },
  {
    path: "GET /api/v1/projects/{slug}/nights",
    live: false,
    text: "A project's nights, observed and reconstructed, each with its evidence hash and attestation.",
  },
  {
    path: "GET /api/openapi.json · /llms.txt",
    live: false,
    text: "The machine-readable description of all of the above.",
  },
];

const TOOLS = [
  ["list_projects", "every watched project with its latest status"],
  ["get_project", "one project by slug"],
  ["get_night", "one project's night: status, reasons, evidence hash, attestation"],
  ["is_still_shipping", "{ slug, status, streak, lit30, lastShip, lastNight, attestationUid }"],
  ["get_briefing", "the briefing for a wallet address"],
  ["watch_project", "ask the agent to watch a project (rate limited)"],
] as const;

export default function DocsPage() {
  const site = (process.env.NEXT_PUBLIC_SITE_URL ?? "https://<site>").replace(/\/$/, "");
  return (
    <main id="main" className="wrap page-top">
      <p className="eyebrow rv">Docs</p>
      <h1 className="h-page rv d1">Read it from your own code</h1>
      <p className="lede rv d1">
        Everything on this site comes from a public API: no keys, no accounts. Agents get the same data over MCP, and every
        night can be verified against Base without trusting us.
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
          <section id="api" className={s.sec} aria-labelledby="api-h">
            <h2 id="api-h" className="h-sec">
              REST API
            </h2>
            <p>
              Base URL <code>{site}</code>. JSON over HTTPS, read only. Endpoints marked <em>planned</em> are part of this
              build and land before launch; their shapes are fixed.
            </p>
            <div style={{ marginTop: 16 }}>
              {ENDPOINTS.map((e) => (
                <div key={e.path} className={s.ep}>
                  <div className={s.epHead}>
                    <span>{e.path}</span>
                    <span className={`tag ${e.live ? s.live : ""}`}>{e.live ? "live" : "planned"}</span>
                  </div>
                  <p>{e.text}</p>
                  {e.shape ? <pre className={s.pre}>{e.shape}</pre> : null}
                </div>
              ))}
            </div>
          </section>

          <section id="mcp" className={s.sec} aria-labelledby="mcp-h">
            <h2 id="mcp-h" className="h-sec">
              MCP for agents
            </h2>
            <p>
              A Streamable HTTP MCP server at <code>{site}/api/mcp</code> (planned, part of this build) exposes the same reads
              as tools:
            </p>
            <ul>
              {TOOLS.map(([name, text]) => (
                <li key={name}>
                  <code>{name}</code>: {text}
                </li>
              ))}
            </ul>
            <p>Claude Code:</p>
            <pre className={s.pre}>{`claude mcp add --transport http lights-on ${site}/api/mcp`}</pre>
            <p>
              Cursor, in <code>.cursor/mcp.json</code>:
            </p>
            <pre className={s.pre}>{`{
  "mcpServers": {
    "lights-on": { "url": "${site}/api/mcp" }
  }
}`}</pre>
          </section>

          <section id="verify" className={s.sec} aria-labelledby="ver-h">
            <h2 id="ver-h" className="h-sec">
              Verify a night
            </h2>
            <p>Three checks, none of which trust this site:</p>
            <ul>
              <li>
                <strong>The bundle is what was hashed.</strong> keccak256 of the response body equals the hash in the URL:
              </li>
            </ul>
            <pre className={s.pre}>{`curl -s ${site}/api/v1/evidence/<hash> -o evidence.json
cast keccak "$(cat evidence.json)"   # prints <hash>`}</pre>
            <ul>
              <li>
                <strong>The hash is what was attested.</strong> Read the attestation from EAS on Base (
                <code>0x4200…0021</code>) and decode its data: the <code>evidenceHash</code> field must equal the hash, the
                attester must be the watcher, and it must not be revoked.
              </li>
              <li>
                <strong>All of it at once</strong> with the repo&apos;s script, or in the browser from any night on a project
                page:
              </li>
            </ul>
            <pre className={s.pre}>{`pnpm tsx scripts/verify-night.ts --network base \\
  --uid <attestation uid> --bundle evidence.json --attester <watcher address>`}</pre>
            <p>
              The rules that turn evidence into a status are on the <Link className="ul" href="/methodology">methodology</Link>{" "}
              page.
            </p>
          </section>
        </div>
      </div>
    </main>
  );
}
