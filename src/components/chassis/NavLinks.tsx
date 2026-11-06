"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/night", label: "Last night" },
  { href: "/study", label: "Study" },
  { href: "/methodology", label: "Methodology" },
  { href: "/docs", label: "Docs" },
] as const;

export function NavLinks() {
  const path = usePathname();
  return (
    <nav className="nav-links" aria-label="Primary">
      {LINKS.map((l) => (
        <Link key={l.href} href={l.href} aria-current={path === l.href || path.startsWith(`${l.href}/`) ? "page" : undefined}>
          {l.label}
        </Link>
      ))}
    </nav>
  );
}
