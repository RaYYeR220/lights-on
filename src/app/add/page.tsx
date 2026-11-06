import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Add a project · Lights On" };

export default function AddPage() {
  return (
    <main id="main" className="wrap page-top">
      <p className="eyebrow rv">
        <span className="tag">
          <i className="sw sw-none" aria-hidden="true" />
          opens after launch
        </span>
      </p>
      <h1 className="h-page rv d1">Add a project to the watch</h1>
      <p className="lede rv d1">
        Community watch requests open after launch. You will give a live URL, and optionally a repo or a contract; the project
        gets the next open window in the building and its first shift right away.
      </p>
      <p className="lede rv d2" style={{ fontSize: 15 }}>
        Until then, every project already on the watch is on the <Link className="ul" href="/">building</Link>, and its nights
        are on <Link className="ul" href="/night">last night&apos;s shift</Link>.
      </p>
    </main>
  );
}
