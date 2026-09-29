# Truncated database

The database file is cut off at 55% of its size, like an interrupted copy or a full disk. Its headers are intact, so the block layout is shown with the missing blocks marked, but DuckDB can't open it: its metadata was in the missing part. The summary says so.

Files: `store.duckdb`. Open `examples/08_db_truncated/store.duckdb`.
