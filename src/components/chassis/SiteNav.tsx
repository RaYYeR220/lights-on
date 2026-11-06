import Link from "next/link";
import { Glyph } from "./Glyph";
import { NavLinks } from "./NavLinks";

export function SiteNav() {
  return (
    <header className="nav fd">
      <Link className="brand" href="/" aria-label="Lights On, home">
        <Glyph />
        Lights On
      </Link>
      <NavLinks />
      <Link className="btn btn-ghost btn-sm" href="/b">
        Check your bags
      </Link>
    </header>
  );
}
