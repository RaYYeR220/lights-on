import Link from "next/link";
import type { TowerData } from "@/lib/views/tower";
import s from "./landing.module.css";

/**
 * The landing below the building: how a night works, who it is for, why now. Every sentence describes something that
 * works today and links to the surface that shows it; nothing here is a count (counts come from data, above the fold).
 */

interface Go {
  href: string;
  label: string;
}

export interface Raise {
  slug: string;
  name: string;
}

/** The Vibestarter raise to show: the first one on the building (tower order), or null when the data has none. */
export function raiseOf(data: Pick<TowerData, "projects"> | null): Raise | null {
  const p = data?.projects.find((x) => x.source === "vibestarter");
  return p ? { slug: p.slug, name: p.name } : null;
}

const STEPS: { name: string; text: string; links: Go[] }[] = [
  {
    name: "Read",
    text: "The public repo, the live app's deploy fingerprint, the chain and, for a raise, its Vibestarter campaign.",
    links: [{ href: "/methodology#tiers", label: "Evidence tiers" }],
  },
  {
    name: "Decide",
    text: "Published, deterministic rules: shipped beats building, building beats down and down beats quiet.",
    links: [{ href: "/methodology#rules", label: "The rules" }],
  },
  {
    name: "Explain",
    text: "AI explains the night after the rules have decided. It never decides.",
    links: [{ href: "/methodology#limits", label: "What AI does" }],
  },
  {
    name: "Attest",
    text: "One Merkle root per night on Base, from an ERC-8004 watcher. Anyone can verify a night against it in the browser.",
    links: [
      { href: "/methodology#attestation", label: "Attestation" },
      { href: "/night", label: "Last night's shift" },
    ],
  },
];

function cards(raise: Raise | null): { who: string; text: string; links: Go[] }[] {
  return [
    {
      who: "Backers",
      text: "Paste the wallet you backed with and see how each project did last night, then get the morning briefing on Telegram or by web push.",
      links: [{ href: "/b", label: "Open the backer view" }],
    },
    {
      who: "Vibestarter raises",
      text: "The tranche schedule and any open challenge window, next to the evidence for every night.",
      // a raise from the building's own data; with none loaded, the night's list of projects
      links: [raise ? { href: `/p/${raise.slug}`, label: `See ${raise.name}` } : { href: "/night", label: "Last night's shift" }],
    },
    {
      who: "Founders",
      text: "Claim your project with a wallet signature, answer a quiet night with a note (shown as reported, never counted) and embed a live badge.",
      links: [
        { href: "/add", label: "Add your project" },
        { href: "/methodology#tiers", label: "Reported vs verified" },
      ],
    },
    {
      who: "Agents",
      text: "MCP tools like is_still_shipping and get_night, a REST API with OpenAPI, and llms.txt. No keys, no accounts.",
      links: [
        { href: "/docs#mcp", label: "MCP" },
        { href: "/docs#api", label: "REST API" },
        { href: "/llms.txt", label: "llms.txt" },
      ],
    },
  ];
}

function why(raise: Raise | null): { k: string; text: string; links: Go[] }[] {
  return [
    {
      k: "Vibestarter",
      text: "Vibestarter releases a raise in monthly tranches and lets backers challenge a payout. A challenge needs evidence, and Lights On writes it down every night.",
      links: [raise ? { href: `/p/${raise.slug}`, label: "See the tranches" } : { href: "/methodology#tiers", label: "How raise data is shown" }],
    },
    {
      k: "Agents",
      text: "Agents can now read a night of commits, releases and page changes and explain it cheaply, under a hard daily token cap.",
      links: [{ href: "/methodology#limits", label: "What AI does" }],
    },
    {
      k: "Base",
      text: "One attestation on Base covers every project-night, so a public record nobody can edit costs one transaction a night.",
      links: [{ href: "/night", label: "Last night's attestation" }],
    },
  ];
}

/** Route handlers (llms.txt) are plain links; pages go through next/link. */
function GoLink({ href, label }: Go) {
  const body = (
    <>
      {label} <span aria-hidden="true">→</span>
    </>
  );
  return href.startsWith("/llms.txt") ? (
    <a className="ul" href={href}>
      {body}
    </a>
  ) : (
    <Link className="ul" href={href}>
      {body}
    </Link>
  );
}

function Links({ links }: { links: Go[] }) {
  return (
    <p className={s.go}>
      {links.map((l) => (
        <GoLink key={l.href} {...l} />
      ))}
    </p>
  );
}

export function LandingSections({ raise }: { raise: Raise | null }) {
  return (
    <div className={s.sections} data-testid="landing-sections">
      <section id="how" className={s.sec} aria-labelledby="how-h">
        <h2 id="how-h" className="h-sec">
          How a night works
        </h2>
        <p className={s.lead}>Every night at 05:00 UTC, the same steps for every project on the watch.</p>
        <ol className={s.steps}>
          {STEPS.map((st) => (
            <li key={st.name} className={s.step}>
              <i className={s.dot} data-state="ok" aria-hidden="true" />
              <h3 className={s.name}>{st.name}</h3>
              <p className={s.text}>{st.text}</p>
              <Links links={st.links} />
            </li>
          ))}
        </ol>
      </section>

      <section id="who" className={s.sec} aria-labelledby="who-h">
        <h2 id="who-h" className="h-sec">
          Who it&apos;s for
        </h2>
        <ul className={s.cards}>
          {cards(raise).map((c) => (
            <li key={c.who} className={`panel ${s.card}`}>
              <h3 className={s.name}>{c.who}</h3>
              <p className={s.text}>{c.text}</p>
              <Links links={c.links} />
            </li>
          ))}
        </ul>
      </section>

      <section id="why" className={s.sec} aria-labelledby="why-h">
        <h2 id="why-h" className="h-sec">
          Why now
        </h2>
        <ul className={s.why}>
          {why(raise).map((w) => (
            <li key={w.k}>
              <span className={s.whyK}>{w.k}</span>
              <div>
                <p className={s.whyText}>{w.text}</p>
                <Links links={w.links} />
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
