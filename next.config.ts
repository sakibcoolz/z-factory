import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Native/optional dependencies of the Docker client must not be bundled.
  serverExternalPackages: ["dockerode"],
  // Hosts other than localhost that may load dev resources such as hot reload, e.g. the
  // machine's tailnet name (TASK-004). `make start` sets it; production ignores it.
  allowedDevOrigins: process.env.DEV_ALLOWED_ORIGINS?.split(",").filter(Boolean),
};

export default nextConfig;
