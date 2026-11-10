import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      {
        extends: true,
        test: {
          name: "server",
          environment: "node",
          include: ["test/**/*.test.ts"],
          exclude: ["test/web/**", "**/node_modules/**"],
        },
      },
      {
        extends: true,
        plugins: [react()],
        test: {
          name: "web",
          environment: "jsdom",
          include: ["test/web/**/*.test.{ts,tsx}"],
        },
      },
    ],
  },
});
