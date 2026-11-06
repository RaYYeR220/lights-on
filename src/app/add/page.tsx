import type { Metadata } from "next";
import { StubPage } from "@/components/chassis/StubPage";

export const metadata: Metadata = { title: "Add a project · Lights On" };

export default function AddPage() {
  return (
    <StubPage
      title="Add a project to the watch"
      lede="Give a live URL, and optionally a repo or a contract. It gets the next open window in the building and its first shift right away."
    />
  );
}
