import Link from "next/link";
import type { StudyView } from "@/lib/views/study";
import s from "./study.module.css";

/** The landing's one-line pointer to /study, below the building. */
export function StudyStrip({ view }: { view: StudyView }) {
  return (
    <section className={s.strip} aria-label="From the study">
      <div className={`panel ${s.stripIn}`}>
        <div>
          <span className={`k ${s.stripK}`}>
            <i className="sw sw-hatch" aria-hidden="true" />
            From the study · {view.basis}
          </span>
          <p className={s.stripText}>{view.headline}</p>
        </div>
        <Link className="btn btn-ghost btn-sm" href="/study">
          Read the study <span aria-hidden="true">→</span>
        </Link>
      </div>
    </section>
  );
}
