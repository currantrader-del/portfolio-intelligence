import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The PDF renderer for "Share full research" runs on the server with its own font and layout files.
  serverExternalPackages: ["@react-pdf/renderer"],
};

export default nextConfig;
