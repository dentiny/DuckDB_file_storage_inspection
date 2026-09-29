#!/usr/bin/env bash
# Writes public/orders.duckdb and its write-ahead log public/orders.duckdb.wal with the DuckDB CLI.
# The log holds several committed transactions, then a last one cut in half, as if DuckDB crashed mid-commit.
set -euo pipefail

out="${1:-public/orders.duckdb}"
wal="$out.wal"
rm -f "$out" "$wal"

duckdb "$out" > /dev/null <<'SQL'
CREATE TABLE customers AS SELECT i AS id, 'customer ' || i AS name FROM range(1, 51) t(i);
CHECKPOINT;
SQL

# Without a checkpoint on exit, every change below stays in the WAL.
duckdb "$out" > /dev/null <<'SQL'
PRAGMA disable_checkpoint_on_shutdown;
SET checkpoint_threshold = '10GB';
CREATE SCHEMA shop;
CREATE TABLE shop.orders (
  id INTEGER PRIMARY KEY,
  customer_id BIGINT NOT NULL,
  amount DECIMAL(10, 2),
  placed TIMESTAMP,
  status ENUM('new', 'paid', 'shipped') DEFAULT 'new',
  tags VARCHAR[],
  shipping STRUCT(city VARCHAR, express BOOLEAN)
);
INSERT INTO shop.orders VALUES
  (1, 7, 12.50, '2024-05-01 10:00', 'paid', ['gift'], {'city': 'Oslo', 'express': true}),
  (2, 9, NULL, NULL, DEFAULT, NULL, NULL);
INSERT INTO shop.orders
SELECT i, 1 + i % 50, round(i * 1.37, 2), TIMESTAMP '2024-06-01' + to_minutes(i), 'new', [], {'city': 'Lima', 'express': false}
FROM range(3, 2500) t(i);
UPDATE shop.orders SET status = 'shipped' WHERE id <= 5;
DELETE FROM shop.orders WHERE id BETWEEN 100 AND 120;
INSERT INTO customers VALUES (51, 'customer 51');
ALTER TABLE customers RENAME COLUMN name TO full_name;
CREATE VIEW shop.big_orders AS SELECT * FROM shop.orders WHERE amount > 1000;
CREATE SEQUENCE shop.order_ids START 2500;
SELECT nextval('shop.order_ids');
SQL

committed=$(wc -c < "$wal")
duckdb "$out" > /dev/null <<'SQL'
PRAGMA disable_checkpoint_on_shutdown;
SET checkpoint_threshold = '10GB';
INSERT INTO shop.orders SELECT i, 1, 1.00, NULL, 'new', NULL, NULL FROM range(5000, 5500) t(i);
SQL
total=$(wc -c < "$wal")
# Keep the last transaction's first half: its USE_TABLE entry, and part of its INSERT.
keep=$((committed + (total - committed) / 2))
head -c "$keep" "$wal" > "$wal.tmp" && mv "$wal.tmp" "$wal"
ls -l "$out" "$wal"
