import type { Metadata } from "next";
import { StubPage } from "@/components/chassis/StubPage";

export const metadata: Metadata = { title: "Docs · Lights On" };

export default function DocsPage() {
  return (
    <StubPage
      title="Docs"
      lede="The REST API, the MCP server for agents, and how to verify any night's evidence against its attestation yourself."
    />
  );
}
