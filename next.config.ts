import type { NextConfig } from "next";

const config: NextConfig = {
  serverExternalPackages: ["pdfjs-dist"],
  agentRules: false,
};
export default config;
