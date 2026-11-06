import type { Metadata } from "next";
import { StubPage } from "@/components/chassis/StubPage";

export const metadata: Metadata = { title: "Last night · Lights On" };

export default function NightPage() {
  return (
    <StubPage
      title="Last night's shift"
      lede="Every watched project, in the order the agent checked it, with what reached users and the attestation for each verdict on Base."
    />
  );
}
