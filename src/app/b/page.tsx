import type { Metadata } from "next";
import { StubPage } from "@/components/chassis/StubPage";
import { BagsForm } from "@/components/bags/BagsForm";

export const metadata: Metadata = { title: "Check your bags · Lights On" };

export default function BagsPage() {
  return (
    <StubPage
      title="Check your bags"
      lede="Paste the wallet you backed with. We find the projects it backed or holds and show how each one did last night."
    >
      <BagsForm size="page" />
    </StubPage>
  );
}
