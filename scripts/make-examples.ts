/**
 * Writes examples/: healthy and damaged DuckDB databases and write-ahead logs, each in its own folder with a
 * README, plus public/orders.duckdb(.wal), the torn-commit example the app offers under "Try".
 * Run with `npm run examples` (needs the DuckDB CLI). Damage is made the way a crash or a bad copy leaves it:
 * by cutting healthy files short or flipping a byte.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(repo, "examples");
const DB = "store.duckdb";
const WAL = `${DB}.wal`;

const duckdb = (file: string, sql: string) =>
  execFileSync("duckdb", [file], { input: sql, stdio: ["pipe", "ignore", "inherit"] });

/** Keeps changes in the WAL: no checkpoint on exit, and a threshold the examples never reach. */
const KEEP_IN_WAL = "PRAGMA disable_checkpoint_on_shutdown;\nSET checkpoint_threshold = '10GB';\n";

/** Two tables; `events` spans two row groups and several blocks. */
const BASE = `
CREATE TABLE customers AS SELECT i AS id, 'customer ' || i AS name, ['Oslo', 'Lima', 'Pune'][1 + i % 3] AS city
FROM range(1, 1001) t(i);
CREATE TABLE events AS
SELECT i AS id, TIMESTAMP '2024-01-01' + to_seconds(i) AS at, 1 + (hash(i) % 1000)::INT AS customer_id,
  ['view', 'cart', 'buy'][1 + (hash(i * 7) % 3)::INT] AS kind, round((hash(i * 13) % 10000) / 100.0, 2) AS amount
FROM range(150000) t(i);
CHECKPOINT;
`;

/** Committed changes that stay in the WAL: catalog changes, inserts, an update, a delete, an ALTER. */
const CHANGES = `
CREATE SCHEMA shop;
CREATE TABLE shop.orders (
  id INTEGER PRIMARY KEY,
  customer_id BIGINT NOT NULL,
  amount DECIMAL(10, 2),
  placed TIMESTAMP,
  status ENUM('new', 'paid', 'shipped') DEFAULT 'new',
  tags VARCHAR[],
  shipping STRUCT(city VARCHAR, express BOOLEAN)
);
INSERT INTO shop.orders VALUES
  (1, 7, 12.50, '2024-05-01 10:00', 'paid', ['gift'], {'city': 'Oslo', 'express': true}),
  (2, 9, NULL, NULL, DEFAULT, NULL, NULL);
INSERT INTO shop.orders
SELECT i, 1 + i % 1000, round(i * 1.37, 2), TIMESTAMP '2024-06-01' + to_minutes(i), 'new', [], {'city': 'Lima', 'express': false}
FROM range(3, 3000) t(i);
UPDATE shop.orders SET status = 'shipped' WHERE id <= 5;
DELETE FROM shop.orders WHERE id BETWEEN 100 AND 120;
INSERT INTO customers VALUES (1001, 'customer 1001', 'Oslo');
ALTER TABLE customers RENAME COLUMN name TO full_name;
CREATE VIEW shop.big_orders AS SELECT * FROM shop.orders WHERE amount > 1000;
CREATE SEQUENCE shop.order_ids START 3000;
SELECT nextval('shop.order_ids');
`;

/** A last transaction, to cut in half. */
const LAST_TRANSACTION = `INSERT INTO shop.orders SELECT i, 1, 1.00, NULL, 'new', NULL, NULL FROM range(5000, 5600) t(i);`;

/** Inserts of a full row group or more skip the WAL: DuckDB writes the row groups and logs pointers to them. */
const BULK = `CREATE TABLE archive AS SELECT range AS id, range % 97 AS bucket FROM range(250000);`;

/** Entry frames after the version header: `size u64, checksum u64, payload`, the payload opening with its type. */
function frames(wal: Buffer): { start: number; type: number }[] {
  let pos = wal.indexOf(Buffer.from([0xff, 0xff])) + 2;
  const found: { start: number; type: number }[] = [];
  while (pos + 16 <= wal.length) {
    found.push({ start: pos, type: wal[pos + 18] ?? -1 });
    pos += 16 + Number(wal.readBigUInt64LE(pos));
  }
  return found;
}

// Build the healthy files once, in a scratch folder.
const work = mkdtempSync(path.join(tmpdir(), "duckdb-examples-"));
const at = (name: string) => {
  mkdirSync(path.join(work, name), { recursive: true });
  return path.join(work, name, DB);
};
const clean = at("clean");
duckdb(clean, BASE);
const withWal = at("wal");
copyFileSync(clean, withWal);
duckdb(withWal, KEEP_IN_WAL + CHANGES);
const crashed = at("crashed");
copyFileSync(withWal, crashed);
copyFileSync(`${withWal}.wal`, `${crashed}.wal`);
const committed = statSync(`${crashed}.wal`).size;
duckdb(crashed, KEEP_IN_WAL + LAST_TRANSACTION);
const tornAt = committed + Math.floor((statSync(`${crashed}.wal`).size - committed) / 2);
const bulk = at("bulk");
copyFileSync(clean, bulk);
duckdb(bulk, KEEP_IN_WAL + BULK);

const wal = readFileSync(`${withWal}.wal`);
const walFrames = frames(wal);
const lastFrame = walFrames.at(-1);
const update = walFrames.find((f) => f.type === 28);
if (!lastFrame || !update) throw new Error("the WAL is missing the entries the examples cut into");

/** Writes `bytes` to a case folder, cut to `length` when given. */
const put = (dir: string, name: string, from: string | Buffer, length?: number) => {
  const bytes = typeof from === "string" ? readFileSync(from) : from;
  writeFileSync(path.join(dir, name), length === undefined ? bytes : bytes.subarray(0, length));
};

interface Case {
  name: string;
  title: string;
  /** What's in the folder and what the inspector shows for it. */
  about: string;
  write: (dir: string) => void;
}

const cases: Case[] = [
  {
    name: "01_db_only",
    title: "Database only",
    about: `A healthy database, fully checkpointed, with no WAL next to it. Everything is in its blocks: two tables,
one of them spread over two row groups.`,
    write: (dir) => put(dir, DB, clean),
  },
  {
    name: "02_db_and_wal",
    title: "Database and WAL",
    about: `A database plus a WAL of committed changes that were never checkpointed: CREATE SCHEMA/TABLE/VIEW/SEQUENCE,
inserts, an update, a delete and an ALTER TABLE. The block layout shows the database before these changes; the WAL
panel lists them. Every entry is complete.`,
    write: (dir) => {
      put(dir, DB, withWal);
      put(dir, WAL, wal);
    },
  },
  {
    name: "03_wal_only",
    title: "WAL only",
    about: `Only the WAL from 02, without its database, e.g. copied off a server on its own. Open \`${WAL}\` directly.
Column names come from the CREATE TABLE entries in the log; rows inserted into tables created before it (customers)
show "column 1, column 2", since their definitions are in the missing database.`,
    write: (dir) => put(dir, WAL, wal),
  },
  {
    name: "04_wal_torn_last_commit",
    title: "WAL torn in its last commit",
    about: `The process died while writing its last commit: the WAL ends halfway through an INSERT entry. That entry is
incomplete (truncated), and so is the USE_TABLE before it, since no COMMIT follows either. DuckDB replays everything
before them and drops the half-written transaction.`,
    write: (dir) => {
      put(dir, DB, crashed);
      put(dir, WAL, `${crashed}.wal`, tornAt);
    },
  },
  {
    name: "05_wal_torn_frame_header",
    title: "WAL torn in an entry header",
    about: `The process died 7 bytes into writing an entry's 16-byte size and checksum. That fragment shows as a torn entry
header, and the transaction it would have committed has no COMMIT, so its entries are incomplete too.`,
    write: (dir) => {
      put(dir, DB, withWal);
      put(dir, WAL, wal, lastFrame.start + 7);
    },
  },
  {
    name: "06_wal_checksum_mismatch",
    title: "WAL with a corrupted byte",
    about: `One byte in the middle of the WAL is flipped, as a bad disk or a botched copy would leave it: the UPDATE entry
fails its checksum. DuckDB stops replaying there, so that entry and every byte after it are incomplete, even though the
later entries were written in full.`,
    write: (dir) => {
      const damaged = Buffer.from(wal);
      const byte = update.start + 16 + 20;
      damaged[byte] = (damaged[byte] ?? 0) ^ 0xff;
      put(dir, DB, withWal);
      put(dir, WAL, damaged);
    },
  },
  {
    name: "07_wal_only_torn",
    title: "Torn WAL only",
    about: `The torn WAL from 04, on its own without its database.`,
    write: (dir) => put(dir, WAL, `${crashed}.wal`, tornAt),
  },
  {
    name: "08_db_truncated",
    title: "Truncated database",
    about: `The database file is cut off at 55% of its size, like an interrupted copy or a full disk. Its headers are
intact, so the block layout is shown with the missing blocks marked, but DuckDB can't open it: its metadata was in the
missing part. The summary says so.`,
    write: (dir) => put(dir, DB, clean, Math.floor(statSync(clean).size * 0.55)),
  },
  {
    name: "09_db_torn_header",
    title: "Database torn in its headers",
    about: `A database file only 6,000 bytes long: the process died before even its 12 KB of headers were written. It has
the DUCK magic bytes but nothing else to show, so the inspector says it's cut off.`,
    write: (dir) => put(dir, DB, clean, 6000),
  },
  {
    name: "10_db_and_wal_bulk_insert",
    title: "Bulk insert",
    about: `A CREATE TABLE AS with 250,000 rows. Inserts that large skip the WAL: DuckDB writes the row groups straight into
the database file and logs only pointers to them (a ROW_GROUP_DATA entry). The new blocks sit after the last block the
header counts, so the layout shows them as "past the last block": only the WAL points to them until the next
checkpoint.`,
    write: (dir) => {
      put(dir, DB, bulk);
      put(dir, WAL, `${bulk}.wal`);
    },
  },
];

const unwrap = (s: string) => s.replace(/\n(?!\n)/g, " ");
const files = (dir: string) =>
  [DB, WAL].filter((f) => {
    try {
      return statSync(path.join(dir, f)).isFile();
    } catch {
      return false;
    }
  });

mkdirSync(out, { recursive: true });
const rows: string[] = [];
for (const c of cases) {
  const dir = path.join(out, c.name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir);
  c.write(dir);
  const present = files(dir);
  const open = present.includes(DB) ? DB : WAL;
  writeFileSync(
    path.join(dir, "README.md"),
    `# ${c.title}\n\n${unwrap(c.about)}\n\nFiles: ${present.map((f) => `\`${f}\``).join(", ")}. Open \`examples/${c.name}/${open}\`.\n`,
  );
  rows.push(`| [\`${c.name}\`](${c.name}) | ${c.title} | ${present.map((f) => `\`${f}\``).join(" + ")} |`);
}

writeFileSync(
  path.join(out, "README.md"),
  `# Example databases

Healthy and damaged DuckDB databases and write-ahead logs to try the inspector on. Each folder's README says what's in
it and what the inspector shows. The damaged ones were made from healthy files the way a crash or a bad copy leaves
them: cut short, or with a byte flipped.

| Folder | Case | Files |
| --- | --- | --- |
${rows.join("\n")}

Open one by typing its path in the inspector, e.g. \`examples/02_db_and_wal/${DB}\`, or start it with
\`npm start -- examples/02_db_and_wal/${DB}\`. For the WAL-only folders, open \`${WAL}\` itself.

Regenerate them with \`npm run examples\` (needs the DuckDB CLI).
`,
);

// The app's "Try" button for a WAL is the torn-commit case, served from public/.
put(path.join(repo, "public"), "orders.duckdb", crashed);
put(path.join(repo, "public"), "orders.duckdb.wal", `${crashed}.wal`, tornAt);

rmSync(work, { recursive: true, force: true });
console.log(`Wrote ${cases.length} examples to ${path.relative(repo, out)}/ and public/orders.duckdb(.wal)`);
