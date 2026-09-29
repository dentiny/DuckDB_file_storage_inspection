# Database torn in its headers

A database file only 6,000 bytes long: the process died before even its 12 KB of headers were written. It has the DUCK magic bytes but nothing else to show, so the inspector says it's cut off.

Files: `store.duckdb`. Open `examples/09_db_torn_header/store.duckdb`.
