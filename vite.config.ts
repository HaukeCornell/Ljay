import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/lrclib": {
        target: "https://lrclib.net",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/lrclib/, ""),
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq) => {
            proxyReq.setHeader(
              "User-Agent",
              "Ljay/0.0.1 (https://github.com/haukesandhaus/Ljay)",
            );
          });
        },
      },
    },
  },
  build: {
    target: "esnext",
    sourcemap: true,
  },
});
