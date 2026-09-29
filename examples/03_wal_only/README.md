# WAL only

Only the WAL from 02, without its database, e.g. copied off a server on its own. Open `store.duckdb.wal` directly. Column names come from the CREATE TABLE entries in the log; rows inserted into tables created before it (customers) show "column 1, column 2", since their definitions are in the missing database.

Files: `store.duckdb.wal`. Open `examples/03_wal_only/store.duckdb.wal`.
