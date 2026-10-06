import type { NextConfig } from "next";
import path from "path";

// Pin the workspace root to this folder so Next.js never infers a parent
// directory (e.g. when another lockfile exists higher up the tree).
const projectRoot = path.resolve(__dirname);

const nextConfig: NextConfig = {
  reactCompiler: true,
  turbopack: { root: projectRoot },
  outputFileTracingRoot: projectRoot,
  async redirects() {
    return [
      { source: "/codes", destination: "/", permanent: true },
      { source: "/codes/:path*", destination: "/", permanent: true },
    ];
  },
};

export default nextConfig;
