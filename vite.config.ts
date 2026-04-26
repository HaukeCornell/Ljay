import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "preact",
  },
  server: {
    port: 5173,
    strictPort: true,
    // host:true defers to CLI: `npm run dev -- --host` exposes on LAN for iPad.
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
      // Music-video acquisition + serving lives on the sidecar.
      "/mv":      { target: "http://127.0.0.1:7777", changeOrigin: false },
      "/mv-file": { target: "http://127.0.0.1:7777", changeOrigin: false },
      // Sidecar WebSocket — must be proxied so the iPad-side panel can use the
      // same origin for both static assets and the realtime channel.
      "/ws":      { target: "ws://127.0.0.1:7777", ws: true, changeOrigin: false },
    },
  },
  build: {
    target: "esnext",
    sourcemap: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        control: resolve(__dirname, "control.html"),
      },
    },
  },
});
