# Bulk insert

A CREATE TABLE AS with 250,000 rows. Inserts that large skip the WAL: DuckDB writes the row groups straight into the database file and logs only pointers to them (a ROW_GROUP_DATA entry). The new blocks sit after the last block the header counts, so the layout shows them as "past the last block": only the WAL points to them until the next checkpoint.

Files: `store.duckdb`, `store.duckdb.wal`. Open `examples/10_db_and_wal_bulk_insert/store.duckdb`.
