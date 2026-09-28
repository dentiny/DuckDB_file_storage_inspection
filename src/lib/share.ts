export interface Selection {
  /** The URL or local path as typed. */
  db: string;
  /** `schema.name` of the open table. */
  table: string | null;
  rg: number | null;
  col: string | null;
}

export function toQuery({ db, table, rg, col }: Selection): string {
  const params = new URLSearchParams({ db });
  if (table !== null) params.set("table", table);
  if (rg !== null) params.set("rg", String(rg));
  if (col !== null) params.set("col", col);
  return params.toString();
}

export function fromQuery(search: string): Selection | null {
  const params = new URLSearchParams(search);
  const db = params.get("db");
  if (!db) return null;
  const rg = params.get("rg");
  return {
    db,
    table: params.get("table"),
    rg: rg !== null && /^\d+$/.test(rg) ? Number(rg) : null,
    col: params.get("col"),
  };
}

export function shareUrl(query: string, location: Location): string {
  return `${location.origin}${location.pathname}?${query}`;
}

export function publishQuery(query: string): void {
  history.replaceState(null, "", `?${query}`);
}
