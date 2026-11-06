import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // design.md names /study/vibeathon-01; the section lives on /study
  async redirects() {
    return [{ source: "/study/vibeathon-01", destination: "/study#vibeathon-01", permanent: false }];
  },
  turbopack: {
    rules: {
      // Tailwind runs on global stylesheets only; CSS Modules (*.module.css) keep their module semantics.
      "*.css": {
        condition: { not: { path: /\.module\.css$/ } },
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
