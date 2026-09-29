# WAL torn in an entry header

The process died 7 bytes into writing an entry's 16-byte size and checksum. That fragment shows as a torn entry header, and the transaction it would have committed has no COMMIT, so its entries are incomplete too.

Files: `store.duckdb`, `store.duckdb.wal`. Open `examples/05_wal_torn_frame_header/store.duckdb`.
