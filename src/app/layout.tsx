import type { Metadata, Viewport } from "next";
import { Geist_Mono, Manrope } from "next/font/google";
import { SiteNav } from "@/components/chassis/SiteNav";
import { SiteFooter } from "@/components/chassis/SiteFooter";
import "./globals.css";

/*
 * Clash Display comes from Fontshare's CSS API (the ITF Free Font License allows serving it that way, not
 * redistributing the files in a public repo). The fallback stack in globals.css keeps the layout if it fails.
 */
const CLASH_CSS = "https://api.fontshare.com/v2/css?f[]=clash-display@500,600&display=swap";

const manrope = Manrope({
  variable: "--font-manrope",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Lights On",
  description:
    "Every night an agent checks each watched project for work that actually reached users, attests the verdict on Base, and tells backers by morning.",
};

export const viewport: Viewport = {
  themeColor: "#111824",
  colorScheme: "dark",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // suppressHydrationWarning: the landing's pre-paint script sets layout variables on <html> before hydration.
    <html lang="en" className={`${manrope.variable} ${geistMono.variable}`} suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://api.fontshare.com" crossOrigin="" />
        <link rel="preconnect" href="https://cdn.fontshare.com" crossOrigin="" />
        <link rel="stylesheet" href={CLASH_CSS} />
      </head>
      <body>
        <a className="skip" href="#main">
          Skip to content
        </a>
        <div className="grain" aria-hidden="true" />
        <SiteNav />
        {children}
        <SiteFooter />
      </body>
    </html>
  );
}
