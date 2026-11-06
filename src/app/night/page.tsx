import type { Metadata } from "next";
import { getDb } from "@/lib/db";
import { getNightView } from "@/lib/views/night";
import { NightShift } from "@/components/night/NightShift";

export const metadata: Metadata = { title: "Last night · Lights On" };
export const revalidate = 300;

export default async function NightPage() {
  const view = await getNightView(await getDb());
  return <NightShift view={view} asked={null} now={view.generatedAt} />;
}
