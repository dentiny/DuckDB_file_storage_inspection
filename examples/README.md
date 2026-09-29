# Example databases

Healthy and damaged DuckDB databases and write-ahead logs to try the inspector on. Each folder's README says what's in
it and what the inspector shows. The damaged ones were made from healthy files the way a crash or a bad copy leaves
them: cut short, or with a byte flipped.

| Folder                                                   | Case                         | Files                               |
| -------------------------------------------------------- | ---------------------------- | ----------------------------------- |
| [`01_db_only`](01_db_only)                               | Database only                | `store.duckdb`                      |
| [`02_db_and_wal`](02_db_and_wal)                         | Database and WAL             | `store.duckdb` + `store.duckdb.wal` |
| [`03_wal_only`](03_wal_only)                             | WAL only                     | `store.duckdb.wal`                  |
| [`04_wal_torn_last_commit`](04_wal_torn_last_commit)     | WAL torn in its last commit  | `store.duckdb` + `store.duckdb.wal` |
| [`05_wal_torn_frame_header`](05_wal_torn_frame_header)   | WAL torn in an entry header  | `store.duckdb` + `store.duckdb.wal` |
| [`06_wal_checksum_mismatch`](06_wal_checksum_mismatch)   | WAL with a corrupted byte    | `store.duckdb` + `store.duckdb.wal` |
| [`07_wal_only_torn`](07_wal_only_torn)                   | Torn WAL only                | `store.duckdb.wal`                  |
| [`08_db_truncated`](08_db_truncated)                     | Truncated database           | `store.duckdb`                      |
| [`09_db_torn_header`](09_db_torn_header)                 | Database torn in its headers | `store.duckdb`                      |
| [`10_db_and_wal_bulk_insert`](10_db_and_wal_bulk_insert) | Bulk insert                  | `store.duckdb` + `store.duckdb.wal` |

Open one by typing its path in the inspector, e.g. `examples/02_db_and_wal/store.duckdb`, or start it with
`npm start -- examples/02_db_and_wal/store.duckdb`. For the WAL-only folders, open `store.duckdb.wal` itself.

Regenerate them with `npm run examples` (needs the DuckDB CLI).
