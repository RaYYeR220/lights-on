import type { Metadata } from "next";
import { StubPage } from "@/components/chassis/StubPage";

export const metadata: Metadata = { title: "Your bags · Lights On" };

export default async function BackerPage({ params }: PageProps<"/b/[address]">) {
  const { address } = await params;
  const who = decodeURIComponent(address);
  const short = /^0x[0-9a-fA-F]{40}$/.test(who) ? `${who.slice(0, 6)}…${who.slice(-4)}` : who;
  return (
    <StubPage
      title={`Bags of ${short}`}
      lede="The projects this wallet backed or holds, with last night's reading for each and a morning briefing you can follow."
    />
  );
}
