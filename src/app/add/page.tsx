import type { Metadata } from "next";
import Link from "next/link";
import { WatchForm } from "@/components/add/WatchForm";
import s from "@/components/add/add.module.css";

export const metadata: Metadata = { title: "Add a project · Lights On" };

export default function AddPage() {
  return (
    <main id="main" className="wrap page-top">
      <p className="eyebrow rv">Community watch</p>
      <h1 className="h-page rv d1">Add a project to the watch</h1>
      <p className="lede rv d1">
        Give a live URL, and a repo or a contract if you know them. The agent checks the project right away and every night
        after that, by the same <Link className="ul" href="/methodology">rules</Link> as everything else.
      </p>
      <div className={`${s.layout} rv d2`}>
        <WatchForm />
        <aside className={`panel ${s.aside}`} aria-labelledby="unlisted-title">
          <h2 id="unlisted-title">Community-added projects are unlisted</h2>
          <ul>
            <li>
              Each gets its own page at <code>/p/&lt;slug&gt;</code>, labelled <em>Community-added · unverified</em>.
            </li>
            <li>It joins the building, last night&apos;s shift and the counts only after review.</li>
            <li>The page appears once its first check gets an answer from the site; a site that never answers is not added.</li>
            <li>Its founder can claim it later from the project page and attach notes to nights.</li>
          </ul>
        </aside>
      </div>
    </main>
  );
}
