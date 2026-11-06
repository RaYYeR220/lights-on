import Link from "next/link";
import type { ReactNode } from "react";

/** A plain, on-brand placeholder page: one heading, one line, a way back. Replaced as each page is built. */
export function StubPage({ title, lede, children }: { title: string; lede: string; children?: ReactNode }) {
  return (
    <main id="main" className="mx-auto flex w-full max-w-[1120px] flex-col px-4 pb-24 pt-[150px] sm:pt-[180px]">
      <h1 className="rv m-0 max-w-[14em] font-display text-[clamp(40px,5.2vw,72px)] font-medium leading-[0.98] tracking-[-0.04em] text-ink [text-wrap:balance]">
        {title}
      </h1>
      <p className="rv d1 mt-6 max-w-[34em] text-[17px] leading-[1.55] text-ink-2 [text-wrap:pretty]">{lede}</p>
      {children ? <div className="rv d2 mt-9">{children}</div> : null}
      <p className="rv d3 mt-10 flex flex-wrap items-center gap-x-4 gap-y-2 font-mono text-[12px] text-ink-3">
        <span className="inline-flex items-center gap-2">
          <i className="sw sw-none" aria-hidden="true" />
          Coming in this build.
        </span>
        <Link href="/" className="text-ink-2 shadow-[0_1px_0_var(--hair-2)] transition-colors hover:text-ink">
          Back to the building
        </Link>
      </p>
    </main>
  );
}
