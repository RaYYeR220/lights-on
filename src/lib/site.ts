/** Public site origin (no trailing slash). */
export function siteUrl(): string {
  return (process.env.NEXT_PUBLIC_SITE_URL || 'https://lights-on.vercel.app').replace(/\/+$/, '');
}
