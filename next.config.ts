import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Native/optional dependencies of the Docker client must not be bundled.
  serverExternalPackages: ["dockerode"],
};

export default nextConfig;
