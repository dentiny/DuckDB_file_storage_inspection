#!/usr/bin/env bash
# Writes public/sensors.duckdb, the bundled example, with the DuckDB CLI.
# It has sorted and unsorted columns, nested types, long strings, an index, a view, and free blocks from a drop.
set -euo pipefail

out="${1:-public/sensors.duckdb}"
rm -f "$out" "$out.wal"
duckdb "$out" > /dev/null <<'SQL'
CREATE TABLE sensors AS
SELECT
  1000000 + i AS event_id,
  TIMESTAMP '2024-01-01' + to_minutes(i::BIGINT) AS ts,
  'sensor-' || lpad((hash(i) % 200)::VARCHAR, 3, '0') AS sensor_id,
  (['Paris', 'Berlin', 'Tokyo', 'NYC', 'Lagos', 'Lima', 'Oslo', 'Seoul'])[1 + (hash(i * 7) % 8)::INT] AS city,
  round(15 + sin(i / 1440.0) * 8 + (hash(i * 13) % 100) / 100.0, 2)::FLOAT AS temperature,
  CASE WHEN i % 17 = 0 THEN NULL ELSE (hash(i * 3) % 1000)::INT END AS battery
FROM range(400000) t(i);

CREATE SCHEMA logs;
CREATE TABLE logs.events (
  id INTEGER PRIMARY KEY,
  level VARCHAR,
  message VARCHAR,
  tags VARCHAR[],
  origin STRUCT(host VARCHAR, port INTEGER)
);
INSERT INTO logs.events
SELECT
  i,
  (['debug', 'info', 'warn', 'error'])[1 + (i % 4)],
  repeat('payload ' || i::VARCHAR || ' ', CASE WHEN i % 4000 = 0 THEN 600 ELSE 2 + (i % 8) END),
  ['t' || (i % 5)::VARCHAR, 't' || (i % 11)::VARCHAR],
  {'host': 'node-' || (i % 8)::VARCHAR, 'port': 8000 + (i % 4)}
FROM range(20000) t(i);

CREATE TABLE scratch AS SELECT i, md5(i::VARCHAR) AS h FROM range(300000) t(i);
CHECKPOINT;
DROP TABLE scratch;

CREATE VIEW hot_sensors AS SELECT sensor_id, avg(temperature) AS t FROM sensors GROUP BY ALL HAVING t > 20;
CREATE SEQUENCE event_ids START 1;
CHECKPOINT;
SQL
ls -l "$out"
