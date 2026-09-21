import "server-only";
import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { requireEnv } from "./env";
import { ident, join, render, sql, type Sql } from "./sqlBuilder";

export { ident, join, sql, type Sql };

// Neon Postgres over HTTP (the `neon()` driver): one fetch per query, no connections to manage.
//
// Row shapes: the HTTP driver can't take custom type parsers, and Postgres's default parsing turns
// numeric into strings and date/timestamp into JS Dates. Every query here therefore returns rows as
// `to_jsonb(t) as row` (or `returning to_jsonb(t) as row`) and unwraps `.row`. Postgres's JSON
// serialization gives numbers for numeric and ISO strings for dates/timestamps, which is what the app
// relied on from Supabase/PostgREST.
//
// Queries are built with the `sql` tag from sqlBuilder.ts.

let client: NeonQueryFunction<false, false> | undefined;
const neonClient = () => (client ??= neon(requireEnv("DATABASE_URL")));

async function execute(fragment: Sql): Promise<Record<string, unknown>[]> {
  const { text, params } = render(fragment);
  return (await neonClient().query(text, params)) as Record<string, unknown>[];
}

/** Rows from a query that selects or returns `... as row`. */
export async function all<T>(query: Sql): Promise<T[]> {
  const result = await execute(query);
  return result.map((r) => {
    if (!("row" in r)) throw new Error("Query must select `to_jsonb(...) as row`");
    return r.row as T;
  });
}

/** The first row of an `... as row` query, or null. */
export async function first<T>(query: Sql): Promise<T | null> {
  return (await all<T>(query))[0] ?? null;
}

/** A single value from a query that selects `... as value` (cast counts to ::int). */
export async function value<T>(query: Sql): Promise<T> {
  const [r] = await execute(query);
  return r?.value as T;
}

/** Run a statement for its side effects. */
export async function run(query: Sql): Promise<void> {
  await execute(query);
}

/** Run several statements atomically in one request. */
export async function transaction(queries: Sql[]): Promise<void> {
  const db = neonClient();
  await db.transaction(queries.map((q) => {
    const { text, params } = render(q);
    return db.query(text, params);
  }));
}

type Row = Record<string, unknown>;

function columnsOf(rows: Row[]): string[] {
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  if (columns.length === 0) throw new Error("Nothing to write");
  return columns;
}

const columnList = (columns: string[]) => join(columns.map((c) => sql`${ident(c)}`), sql`, `);

/**
 * Insert rows, letting Postgres convert each JSON value to its column type. Columns not given use
 * their defaults. With `onConflict`, duplicates are skipped ("nothing") or overwritten ("update").
 * Returns the written rows (skipped duplicates are not returned).
 */
export async function insert<T>(
  table: string,
  input: Row | Row[],
  options: { onConflict?: { target: string; action: "nothing" | "update" } } = {},
): Promise<T[]> {
  const rows = Array.isArray(input) ? input : [input];
  if (rows.length === 0) return [];
  const columns = columnsOf(rows);
  const t = ident(table);
  const cols = columnList(columns);

  let conflict = sql``;
  if (options.onConflict) {
    const target = ident(options.onConflict.target);
    conflict =
      options.onConflict.action === "nothing"
        ? sql` on conflict (${target}) do nothing`
        : sql` on conflict (${target}) do update set ${join(
            columns.filter((c) => c !== options.onConflict!.target).map((c) => sql`${ident(c)} = excluded.${ident(c)}`),
            sql`, `,
          )}`;
  }

  return all<T>(sql`
    insert into public.${t} as t (${cols})
    select ${cols} from jsonb_populate_recordset(null::public.${t}, ${JSON.stringify(rows)}::jsonb)
    ${conflict}
    returning to_jsonb(t) as row`);
}

/** Update the columns in `patch` on rows matching `where` (which may refer to the table as `t`). Returns updated rows. */
export async function update<T>(table: string, patch: Row, where: Sql): Promise<T[]> {
  const columns = columnsOf([patch]);
  const t = ident(table);
  const cols = columnList(columns);
  return all<T>(sql`
    update public.${t} as t
    set (${cols}) = (select ${cols} from jsonb_populate_record(null::public.${t}, ${JSON.stringify(patch)}::jsonb))
    where ${where}
    returning to_jsonb(t) as row`);
}

