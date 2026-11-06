import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import { getProjectView } from "@/lib/views/project";
import { siteUrl } from "@/lib/site";
import { ClaimFlow } from "@/components/claim/ClaimFlow";

export const dynamic = "force-dynamic";

const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/;

export async function generateMetadata({ params }: PageProps<"/claim/[slug]">): Promise<Metadata> {
  return { title: `Claim ${(await params).slug} · Lights On`, robots: { index: false } };
}

export default async function ClaimPage({ params }: PageProps<"/claim/[slug]">) {
  const { slug } = await params;
  if (!SLUG.test(slug)) notFound();
  const v = await getProjectView(await getDb(), slug);
  if (!v) notFound();
  return (
    <main id="main" className="wrap page-top">
      <p className="eyebrow rv">
        <span>Founders</span>
        <Link className="ul" href={`/p/${v.slug}`}>
          Back to {v.name}
        </Link>
      </p>
      <h1 className="h-page rv d1">Claim {v.name}</h1>
      <p className="lede rv d1">
        Prove the project is yours and you get its badge, a backer-update draft built from the evidence, and notes on any
        night. A claim never changes a status: notes are shown as reported, next to what the agent verified.
      </p>
      <div className="rv d2">
        <ClaimFlow
          slug={v.slug}
          name={v.name}
          liveUrl={v.liveUrl}
          founderWallet={v.vibestarter?.founderWallet ?? null}
          claimedBy={v.claimedBy}
          nights={v.strip.slice(-30).map((n) => ({ night: n.night, status: n.status, observed: n.observed }))}
          site={siteUrl()}
        />
      </div>
    </main>
  );
}
