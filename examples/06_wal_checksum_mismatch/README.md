# WAL with a corrupted byte

One byte in the middle of the WAL is flipped, as a bad disk or a botched copy would leave it: the UPDATE entry fails its checksum. DuckDB stops replaying there, so that entry and every byte after it are incomplete, even though the later entries were written in full.

Files: `store.duckdb`, `store.duckdb.wal`. Open `examples/06_wal_checksum_mismatch/store.duckdb`.
