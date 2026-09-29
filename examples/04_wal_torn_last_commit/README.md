# WAL torn in its last commit

The process died while writing its last commit: the WAL ends halfway through an INSERT entry. That entry is incomplete (truncated), and so is the USE_TABLE before it, since no COMMIT follows either. DuckDB replays everything before them and drops the half-written transaction.

Files: `store.duckdb`, `store.duckdb.wal`. Open `examples/04_wal_torn_last_commit/store.duckdb`.
