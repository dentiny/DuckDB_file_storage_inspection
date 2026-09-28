import { quoteIdent, quoteLiteral, type Engine, type Row } from "./engine";

export interface ColumnDef {
  name: string;
  type: string;
  nullable: boolean;
}

export interface TableDef {
  schema: string;
  name: string;
  /** Committed rows, net of deletes. */
  rows: number;
  columns: ColumnDef[];
}

/** One row of `pragma_storage_info`: a column segment of one row group. */
export interface StorageRow {
  rowGroup: number;
  column: string;
  columnId: number;
  /** Position in the column tree, e.g. `[2]` for the values and `[2, 0]` for their validity mask. */
  path: number[];
  segmentType: string;
  /** First row within the row group. */
  start: number;
  count: number;
  compression: string;
  stats: string;
  hasUpdates: boolean;
  persistent: boolean;
  /** -1 when the segment has no bytes of its own, e.g. constant compression. */
  blockId: number;
  /** Offset inside the block's payload, after its checksum. */
  blockOffset: number;
  segmentInfo: string;
  /** Further blocks the segment owns outright, e.g. string overflow. */
  additionalBlocks: number[];
}

export interface MetadataBlockInfo {
  block: number;
  /** Sub-blocks of this metadata block that hold nothing. */
  freeSubBlocks: number[];
}

export interface CatalogEntry {
  schema: string;
  name: string;
  sql: string;
  /** For indexes, the table they index. */
  table?: string;
}

export interface Catalog {
  tables: TableDef[];
  /** Segments per table, in the same order as `tables`. */
  storage: StorageRow[][];
  views: CatalogEntry[];
  indexes: CatalogEntry[];
  sequences: CatalogEntry[];
  metadata: MetadataBlockInfo[];
}

const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));
const num = (v: unknown) => Number(v ?? 0);
const nums = (v: unknown) => (Array.isArray(v) ? v.map(Number) : []);

function parsePath(s: string): number[] {
  return s
    .replace(/[[\]\s]/g, "")
    .split(",")
    .filter(Boolean)
    .map(Number);
}

function storageRow(r: Row): StorageRow {
  return {
    rowGroup: num(r.row_group_id),
    column: str(r.column_name),
    columnId: num(r.column_id),
    path: parsePath(str(r.column_path)),
    segmentType: str(r.segment_type),
    start: num(r.start),
    count: num(r.count),
    compression: str(r.compression),
    stats: str(r.stats),
    hasUpdates: r.has_updates === true,
    persistent: r.persistent !== false,
    blockId: num(r.block_id),
    blockOffset: num(r.block_offset),
    segmentInfo: str(r.segment_info),
    additionalBlocks: nums(r.additional_block_ids),
  };
}

/** Reads the catalog and the storage layout of every table from an attached database. */
export async function readCatalog(engine: Engine, alias: string): Promise<Catalog> {
  const db = quoteLiteral(alias);
  const tableRows = await engine.query(
    `SELECT schema_name, table_name, estimated_size::DOUBLE AS rows
     FROM duckdb_tables() WHERE database_name = ${db} ORDER BY schema_name, table_name`,
  );
  const columnRows = await engine.query(
    `SELECT schema_name, table_name, column_name, data_type, is_nullable
     FROM duckdb_columns() WHERE database_name = ${db} ORDER BY schema_name, table_name, column_index`,
  );
  const tables: TableDef[] = tableRows.map((r) => ({
    schema: str(r.schema_name),
    name: str(r.table_name),
    rows: num(r.rows),
    columns: [],
  }));
  const byName = new Map(tables.map((t) => [`${t.schema}\0${t.name}`, t]));
  for (const r of columnRows) {
    byName.get(`${str(r.schema_name)}\0${str(r.table_name)}`)?.columns.push({
      name: str(r.column_name),
      type: str(r.data_type),
      nullable: r.is_nullable !== false,
    });
  }

  const storage: StorageRow[][] = [];
  for (const t of tables) {
    const qualified = [alias, t.schema, t.name].map(quoteIdent).join(".");
    const rows = await engine.query(
      `SELECT row_group_id::DOUBLE AS row_group_id, column_name, column_id::DOUBLE AS column_id, column_path,
         segment_type, start::DOUBLE AS start, count::DOUBLE AS count, compression, stats, has_updates, persistent,
         block_id::DOUBLE AS block_id, block_offset::DOUBLE AS block_offset, segment_info,
         list_transform(additional_block_ids, x -> x::DOUBLE) AS additional_block_ids
       FROM pragma_storage_info(${quoteLiteral(qualified)})`,
    );
    storage.push(rows.map(storageRow));
  }

  const entries = async (sql: string) =>
    (await engine.query(sql)).map((r): CatalogEntry => ({
      schema: str(r.schema_name),
      name: str(r.name),
      sql: str(r.sql),
      table: r.table_name === undefined ? undefined : str(r.table_name),
    }));
  const views = await entries(
    `SELECT schema_name, view_name AS name, sql FROM duckdb_views()
     WHERE database_name = ${db} AND NOT internal ORDER BY schema_name, view_name`,
  );
  // Key constraints keep an ART index too, but only CREATE INDEX shows up in duckdb_indexes().
  const indexes = await entries(
    `SELECT schema_name, index_name AS name, table_name, sql FROM duckdb_indexes() WHERE database_name = ${db}
     UNION ALL
     SELECT schema_name, constraint_text AS name, table_name, constraint_text AS sql FROM duckdb_constraints()
     WHERE database_name = ${db} AND constraint_type IN ('PRIMARY KEY', 'UNIQUE')
     ORDER BY schema_name, table_name, name`,
  );
  const sequences = await entries(
    `SELECT schema_name, sequence_name AS name, sql FROM duckdb_sequences()
     WHERE database_name = ${db} ORDER BY schema_name, sequence_name`,
  );
  const metadata = (
    await engine.query(
      `SELECT block_id::DOUBLE AS block_id, list_transform(free_list, x -> x::DOUBLE) AS free_list
       FROM pragma_metadata_info(${db}) ORDER BY block_id`,
    )
  ).map((r) => ({ block: num(r.block_id), freeSubBlocks: nums(r.free_list) }));

  return { tables, storage, views, indexes, sequences, metadata };
}
