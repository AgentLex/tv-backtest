// next.config.ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  eslint: {
    ignoreDuringBuilds: true, // ✅ 构建时忽略 ESLint 报错
  },
};

export default nextConfig;