import type { Metadata } from "next";
import { StubPage } from "@/components/chassis/StubPage";

export const metadata: Metadata = { title: "Methodology · Lights On" };

export default function MethodologyPage() {
  return (
    <StubPage
      title="How a night is decided"
      lede="The published rules that turn deploys, releases, contract deployments and commits into shipped, building, quiet, down or unavailable, and how each night is attested on Base."
    />
  );
}
