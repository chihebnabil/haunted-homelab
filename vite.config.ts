import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Backend address for the dev proxy. Matches the server defaults (HAUNTED_HOST, HAUNTED_PORT).
const backendHost = process.env.HAUNTED_HOST ?? "127.0.0.1";
const backendPort = process.env.HAUNTED_PORT ?? "3000";
const backendHttp = `http://${backendHost}:${backendPort}`;
const backendWs = `ws://${backendHost}:${backendPort}`;

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist/web",
    emptyOutDir: true,
  },
  server: {
    // The backend origin guard allows http://localhost:5173 as the dev origin.
    host: "localhost",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target: backendHttp },
      "/ws": { target: backendWs, ws: true },
    },
  },
});
