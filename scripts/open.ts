/**
 * Starts the dev server and opens a database in the browser: `npm run open -- ~/data/app.duckdb`.
 * Without a path it opens the empty page.
 */
import { spawn } from "node:child_process";
import path from "node:path";

const [input] = process.argv.slice(2);
const db = input ? path.resolve(input.replace(/^~(?=\/|$)/, process.env.HOME ?? "~")) : null;
const page = db ? `/?db=${encodeURIComponent(db)}` : "/";
spawn("npx", ["vite", "--open", page], { stdio: "inherit" }).on("exit", (code) => process.exit(code ?? 0));
