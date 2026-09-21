// SQL fragment builder for the Neon driver. Interpolated values always become bind parameters;
// nested `sql` fragments are spliced in; `ident()` inserts a validated identifier. Nothing else is
// ever concatenated into SQL text. No I/O here, so it is unit-tested directly.

const FRAGMENT = Symbol("sql-fragment");
const IDENT = Symbol("sql-identifier");

export interface Sql {
  [FRAGMENT]: true;
  strings: readonly string[];
  values: readonly unknown[];
}

interface Identifier {
  [IDENT]: string;
}

const IDENTIFIER_RE = /^[a-z_][a-z0-9_]*$/;

/** A table or column name, validated so it can't carry SQL. */
export function ident(name: string): Identifier {
  if (!IDENTIFIER_RE.test(name)) throw new Error(`Invalid SQL identifier: ${name}`);
  return { [IDENT]: name };
}

export function sql(strings: TemplateStringsArray | readonly string[], ...values: unknown[]): Sql {
  return { [FRAGMENT]: true, strings, values };
}

const isFragment = (v: unknown): v is Sql => typeof v === "object" && v !== null && FRAGMENT in v;
const isIdent = (v: unknown): v is Identifier => typeof v === "object" && v !== null && IDENT in v;

/** Join fragments with a separator, e.g. join(conditions, sql` and `). */
export function join(parts: Sql[], separator: Sql): Sql {
  if (parts.length === 0) return sql``;
  const strings: string[] = [""];
  const values: unknown[] = [];
  parts.forEach((part, i) => {
    if (i > 0) {
      values.push(separator);
      strings.push("");
    }
    values.push(part);
    strings.push("");
  });
  return { [FRAGMENT]: true, strings, values };
}

/** Render a fragment tree to `$n` placeholder text plus its parameter list. */
export function render(fragment: Sql, params: unknown[] = []): { text: string; params: unknown[] } {
  let text = fragment.strings[0];
  fragment.values.forEach((value, i) => {
    if (isFragment(value)) text += render(value, params).text;
    else if (isIdent(value)) text += `"${value[IDENT]}"`;
    else {
      params.push(value);
      text += `$${params.length}`;
    }
    text += fragment.strings[i + 1];
  });
  return { text, params };
}
