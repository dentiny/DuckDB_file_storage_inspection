# Database and WAL

A database plus a WAL of committed changes that were never checkpointed: CREATE SCHEMA/TABLE/VIEW/SEQUENCE, inserts, an update, a delete and an ALTER TABLE. The block layout shows the database before these changes; the WAL panel lists them. Every entry is complete.

Files: `store.duckdb`, `store.duckdb.wal`. Open `examples/02_db_and_wal/store.duckdb`.
