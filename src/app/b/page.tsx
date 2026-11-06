import type { Metadata } from "next";
import Link from "next/link";
import { BagsForm } from "@/components/bags/BagsForm";
import { REAL_BACKER } from "@/components/bags/realBacker";
import { shortAddress } from "@/lib/views/backer";
import s from "@/components/bags/backer.module.css";

export const metadata: Metadata = { title: "Check your bags · Lights On" };

export default function BagsPage() {
  return (
    <main id="main" className="wrap page-top">
      <p className="eyebrow rv">Backers</p>
      <h1 className="h-page rv d1">Check your bags</h1>
      <p className="lede rv d1">
        Paste the wallet you backed with. We find the Vibestarter campaigns it backed and the watched tokens it holds, then
        show how each project did last night.
      </p>
      <div className="rv d2" style={{ marginTop: 32 }}>
        <BagsForm size="page" />
      </div>
      <p className={`${s.try} rv d3`}>
        <Link className="btn btn-ghost btn-sm" href={`/b/${REAL_BACKER}`}>
          Try a real backer
        </Link>
        <span>a real Corvo Edge backer · {shortAddress(REAL_BACKER)}</span>
      </p>
    </main>
  );
}
