/**
 * Starts the inspector locally and opens it in the browser.
 *
 *   npm start                                   # http://localhost:5173
 *   npm start -- --port 8080                    # or PORT=8080 npm start
 *   npm start -- ~/data/app.duckdb --port 8080  # opens that database right away
 *   npm start -- --no-open                      # don't open a browser
 *
 * It runs the dev server, which also serves databases by their path on this machine.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_PORT = 5173;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function usage(message: string): never {
  console.error(`${message}\nUsage: npm start -- [path/to/file.duckdb] [--port <number>] [--no-open]`);
  process.exit(1);
}

function parsePort(raw: string | undefined): number {
  const port = Number(raw);
  if (!raw || !Number.isInteger(port) || port < 1 || port > 65535) usage(`Invalid port: ${raw ?? "(missing)"}`);
  return port;
}

let port = process.env.PORT ? parsePort(process.env.PORT) : DEFAULT_PORT;
let open = true;
let input: string | null = null;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i] as string;
  if (arg === "--port" || arg === "-p") port = parsePort(args[++i]);
  else if (arg.startsWith("--port=")) port = parsePort(arg.slice("--port=".length));
  else if (arg === "--no-open") open = false;
  else if (arg === "--help" || arg === "-h") usage("Starts DuckDB File Storage Inspection locally.");
  else if (arg.startsWith("-")) usage(`Unknown option: ${arg}`);
  else if (input === null) input = arg;
  else usage(`Only one database path can be given, got ${input} and ${arg}`);
}

if (!existsSync(path.join(root, "node_modules", ".bin", "vite"))) {
  console.log("Installing dependencies…");
  const install = spawnSync("npm", ["install"], { cwd: root, stdio: "inherit" });
  if (install.status !== 0) process.exit(install.status ?? 1);
}

const db = input ? path.resolve(input.replace(/^~(?=\/|$)/, process.env.HOME ?? "~")) : null;
if (db && !existsSync(db)) usage(`No file at ${db}`);
const page = db ? `/?db=${encodeURIComponent(db)}` : "/";

const vite = path.join(root, "node_modules", ".bin", "vite");
const viteArgs = ["--port", String(port), "--strictPort", ...(open ? ["--open", page] : [])];
if (!open) console.log(`Open http://localhost:${port}${page}`);
spawn(vite, viteArgs, { cwd: root, stdio: "inherit" }).on("exit", (code) => process.exit(code ?? 0));
