import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { Geist_Mono, Manrope } from "next/font/google";
import { SiteNav } from "@/components/chassis/SiteNav";
import { SiteFooter } from "@/components/chassis/SiteFooter";
import "./globals.css";

/* Clash Display (Fontshare, ITF Free Font License, self-hosted; see fonts/ClashDisplay-LICENSE-FFL.txt). */
const clash = localFont({
  variable: "--font-clash",
  display: "swap",
  src: [
    { path: "./fonts/ClashDisplay-Regular.woff2", weight: "400", style: "normal" },
    { path: "./fonts/ClashDisplay-Medium.woff2", weight: "500", style: "normal" },
    { path: "./fonts/ClashDisplay-Semibold.woff2", weight: "600", style: "normal" },
  ],
});

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
    <html lang="en" className={`${clash.variable} ${manrope.variable} ${geistMono.variable}`} suppressHydrationWarning>
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
