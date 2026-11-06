import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import { getNightView } from "@/lib/views/night";
import { nightLabel, parseNightParam } from "@/lib/views/reasons";
import { NightShift } from "@/components/night/NightShift";

export const revalidate = 300;

export async function generateMetadata({ params }: PageProps<"/night/[date]">): Promise<Metadata> {
  const n = parseNightParam((await params).date);
  return { title: n ? `Night of ${nightLabel(n, true)} · Lights On` : "Not found · Lights On" };
}

export default async function NightDatePage({ params }: PageProps<"/night/[date]">) {
  const night = parseNightParam((await params).date);
  if (!night) notFound();
  const view = await getNightView(await getDb(), night);
  return <NightShift view={view} asked={night} now={view.generatedAt} />;
}
