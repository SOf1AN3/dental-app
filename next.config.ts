import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `NEXT_OUTPUT=standalone` est réservé au build desktop (Étape 9, scripts/build-desktop.ts),
  // qui a besoin du serveur autonome empaquetable dans `.next/standalone/`.
  // Sans cette variable (build web / Vercel), `output` vaut `undefined` : Next.js ignore la clé
  // comme si elle était absente (les valeurs `undefined` sont filtrées lors du merge du config),
  // donc le build web reste strictement inchangé.
  output: process.env.NEXT_OUTPUT === "standalone" ? "standalone" : undefined,
  reactStrictMode: true,
  poweredByHeader: false,
  images: {
    remotePatterns: [],
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-XSS-Protection", value: "1; mode=block" },
        ],
      },
    ];
  },
};

export default nextConfig;
