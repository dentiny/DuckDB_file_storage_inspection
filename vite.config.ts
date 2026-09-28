import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vitest/config";
import { localFiles } from "./server/local-files";

export default defineConfig({
  plugins: [svelte(), localFiles()],
  build: { target: "es2022" },
  optimizeDeps: { exclude: ["@duckdb/duckdb-wasm"] },
  test: { include: ["tests/**/*.test.ts"], testTimeout: 30_000 },
});
