# DuckDB File Storage Inspection

See how a DuckDB database file is laid out on disk: headers, metadata, row groups, column segments, overflow, free and index blocks. It's modeled on [Parquet X-ray](https://github.com/cfahlgren1/parquet-xray), adapted to DuckDB's storage format.

![A DuckDB file with a row group open and a segment's details in a popover](docs/overview.png)

Type a path on this machine (`~/data/app.duckdb`), open or drop a file, or paste a URL that allows range requests. The file is attached read-only in [DuckDB-Wasm](https://github.com/duckdb/duckdb-wasm) and read block by block, so large databases don't have to be downloaded whole.

## Usage

```sh
npm start                                   # http://localhost:5173, installs dependencies on first run
npm start -- --port 8080                    # another port; PORT=8080 npm start works too
npm start -- ~/data/app.duckdb              # opens that database right away
npm start -- ~/data/app.duckdb --no-open    # prints the link instead of opening a browser
```

`node scripts/start.ts` does the same without npm.

Paths are served by a small route in the dev and preview servers (`server/local-files.ts`) that only serves files starting with DuckDB's magic bytes. Files picked with **Open file** never leave the browser.

## What it reads

- **Headers**, parsed directly: the main header (magic, storage version, the DuckDB version that wrote the file) and both database headers (checkpoint iteration, block count and size, metadata and free-list pointers).
- **Free list**, parsed by following the active header's pointer into metadata: free blocks and blocks shared by several segments.
- **Catalog and segments**, from DuckDB: `duckdb_tables()`, `duckdb_columns()`, `pragma_storage_info()` for where every segment starts and how it is compressed, and `pragma_metadata_info()` for metadata sub-blocks.
- **Segment ends**: `pragma_storage_info` only gives start offsets. A segment ends where the next one in its block starts. The last segment in a block ends at the block's last non-zero byte, since DuckDB zero-fills the rest.

Changes still in a `.wal` next to the file aren't shown; the **Checkpointed** badge says when there are some.

## Development

```sh
npm run verify     # lint, type-check, unit tests, build
npm run test:e2e   # browser tests (first run: npx playwright install chromium)
npm run sample     # rebuild public/sensors.duckdb with the DuckDB CLI
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for how the code is organized.

## License

[MIT](LICENSE)
