import Link from "next/link";

export default function NotFound() {
  return (
    <main id="main" className="mx-auto flex w-full max-w-[1120px] flex-col px-4 pb-24 pt-[150px] sm:pt-[180px]">
      <p className="m-0 inline-flex items-center gap-2 font-mono text-[12px] text-ink-3">
        <i className="sw sw-none" aria-hidden="true" />
        No window at this address
      </p>
      <h1 className="mt-5 max-w-[14em] font-display text-[clamp(40px,5.2vw,72px)] font-medium leading-[0.98] tracking-[-0.04em] text-ink">
        Nothing is lit here.
      </h1>
      <p className="mt-6 max-w-[34em] text-[17px] leading-[1.55] text-ink-2">
        This page does not exist, or it is not built yet. The building has every watched project.
      </p>
      <p className="mt-9">
        <Link href="/" className="btn btn-ghost">
          Back to the building
        </Link>
      </p>
    </main>
  );
}
