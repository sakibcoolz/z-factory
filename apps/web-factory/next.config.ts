import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

// This app sits inside the Z-Factory repository with its own lockfile: it is its own root.
const root = dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  reactStrictMode: true,
  outputFileTracingRoot: root,
  turbopack: { root },
  poweredByHeader: false,
  // Hosts other than localhost that may load dev resources such as hot reload, e.g. the
  // machine's tailnet name (TASK-004). `make start` sets it; production ignores it.
  allowedDevOrigins: process.env.DEV_ALLOWED_ORIGINS?.split(",").filter(Boolean),
  // Web Factory is internet-facing: no framing, no sniffing, no referrer leaks.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
