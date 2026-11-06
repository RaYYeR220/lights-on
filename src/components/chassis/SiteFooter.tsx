import Link from "next/link";
import { Glyph } from "./Glyph";

export function SiteFooter() {
  return (
    <footer className="site-foot">
      <div className="site-foot-in">
        <Link className="brand" href="/" aria-label="Lights On, home">
          <Glyph />
          Lights On
        </Link>
        <nav aria-label="Footer">
          <Link href="/methodology">Methodology</Link>
          <Link href="/docs">Docs</Link>
          <Link href="/docs#api">API</Link>
          <a href="#repo">GitHub</a>
          <Link className="base" href="/methodology#attestation">
            <i className="sw sw-shipped" aria-hidden="true" />
            Attested on Base
          </Link>
        </nav>
      </div>
    </footer>
  );
}
