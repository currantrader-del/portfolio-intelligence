import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The PDF renderer for "Share full research" runs on the server with its own font and layout files.
  serverExternalPackages: ["@react-pdf/renderer"],
  // Its fonts are read from disk at run time, so they must ship with the share route.
  outputFileTracingIncludes: { "/api/research/[symbol]/share": ["./src/lib/research/share/fonts/**"] },
};

export default nextConfig;
