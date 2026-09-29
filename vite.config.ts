import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";
import { localFiles } from "./server/local-files.ts";

export default defineConfig({
  plugins: [svelte(), localFiles()],
  build: { target: "es2022" },
  optimizeDeps: { exclude: ["@duckdb/duckdb-wasm"] },
});
