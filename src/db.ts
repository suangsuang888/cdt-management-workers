// D1 storage layer — port of app/db.py's query helpers.
// Python used a per-thread sqlite3 connection with WAL; in Workers every
// query goes through the bound D1Database with `?` placeholders and bind().
// All timestamps are Unix seconds (number), matching the Python code.
// The schema itself lives in migrations/0001_schema.sql (consolidated from
// db.py SCHEMA plus its _migrate() ALTER additions).

export type SqlParam = string | number | null | ArrayBuffer | Uint8Array;

export interface ExecuteResult {
  changes: number;
  lastInsertRowId: number;
}

function toPlainObject<T>(row: unknown): T {
  // D1 returns plain objects already; this normalises null rows and keeps
  // the conversion explicit at the single place rows leave D1.
  if (row === null || typeof row !== "object") return row as T;
  return { ...(row as Record<string, unknown>) } as T;
}

/** Run a SELECT and return all rows as plain objects. */
export async function query<T>(
  db: D1Database,
  sql: string,
  params: SqlParam[] = [],
): Promise<T[]> {
  const result = await db
    .prepare(sql)
    .bind(...params)
    .all();
  return (result.results ?? []).map((row) => toPlainObject<T>(row));
}

/** Run a SELECT and return the first row, or null. */
export async function queryOne<T>(
  db: D1Database,
  sql: string,
  params: SqlParam[] = [],
): Promise<T | null> {
  const result = await db
    .prepare(sql)
    .bind(...params)
    .first();
  if (result === null || result === undefined) return null;
  return toPlainObject<T>(result);
}

/** Run an INSERT/UPDATE/DELETE and report affected rows + last row id. */
export async function execute(
  db: D1Database,
  sql: string,
  params: SqlParam[] = [],
): Promise<ExecuteResult> {
  const result = await db
    .prepare(sql)
    .bind(...params)
    .run();
  const meta = result.meta as unknown as {
    changes?: number;
    last_row_id?: number | string;
  };
  return {
    changes: meta.changes ?? 0,
    lastInsertRowId:
      typeof meta.last_row_id === "number"
        ? meta.last_row_id
        : Number(meta.last_row_id ?? 0),
  };
}

export interface BatchStatement {
  sql: string;
  params?: SqlParam[];
}

/**
 * Run several statements atomically (D1 batch). Used by repo functions that
 * the Python code wrapped in BEGIN/COMMIT (setSettings, reorderServers,
 * reorderDnsRecords, upsertGroup, deleteGroup) so a failure mid-sequence
 * cannot leave a half-written group or settings update behind.
 * Returns one ExecuteResult per statement, in order.
 */
export async function batch(
  db: D1Database,
  statements: BatchStatement[],
): Promise<ExecuteResult[]> {
  const prepared = statements.map((s) =>
    db.prepare(s.sql).bind(...(s.params ?? [])),
  );
  const results = await db.batch(prepared);
  return results.map((result) => {
    const meta = result.meta as unknown as {
      changes?: number;
      last_row_id?: number | string;
    };
    return {
      changes: meta.changes ?? 0,
      lastInsertRowId:
        typeof meta.last_row_id === "number"
          ? meta.last_row_id
          : Number(meta.last_row_id ?? 0),
    };
  });
}
