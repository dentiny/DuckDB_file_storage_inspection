/** Local paths are served by the dev and preview servers under this prefix (see `server/local-files.ts`). */
export const LOCAL_PREFIX = "/@local";
/** POST here to have the server show the system's open-file dialog and answer `{ path }`, or `{}` when cancelled. */
export const PICK_ROUTE = "/@pick";
/** Header the local file server sets to the size of the database's `.wal`, or 0 when there is none. */
export const WAL_HEADER = "x-duckdb-wal-size";
