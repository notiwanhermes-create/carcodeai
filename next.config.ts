import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,
  async redirects() {
    return [
      { source: "/codes", destination: "/", permanent: true },
      { source: "/codes/:path*", destination: "/", permanent: true },
    ];
  },
};

export default nextConfig;
