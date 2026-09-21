import "server-only";
import { all, insert, sql } from "./db";
import type { PriceResult, Store, WatchItem } from "./types";

export const listStores = () => all<Store>(sql`select to_jsonb(s) as row from public.stores s order by s.name`);

export const listWatchItems = () =>
  all<WatchItem>(sql`select to_jsonb(w) as row from public.watch_items w order by w.id`);

/** Adds stores that aren't saved yet (same name + city + state counts as saved). Returns only the new rows. */
export async function addStores(rows: Omit<Store, "id" | "created_at">[]): Promise<Store[]> {
  const added: Store[] = [];
  for (const row of rows) {
    const [created] = await all<Store>(sql`
      insert into public.stores as s (name, city, state, zip, store_number, base_url, weekly_ad_url)
      values (${row.name}, ${row.city}, ${row.state}, ${row.zip}, ${row.store_number}, ${row.base_url}, ${row.weekly_ad_url})
      on conflict (lower(name), lower(city), lower(state)) do nothing
      returning to_jsonb(s) as row`);
    if (created) added.push(created);
  }
  return added;
}

/** Adds watch items not already on the list (case-insensitive). Returns only the new rows. */
export async function addWatchItems(names: string[]): Promise<WatchItem[]> {
  const added: WatchItem[] = [];
  for (const name of names) {
    const [created] = await all<WatchItem>(sql`
      insert into public.watch_items as w (name) values (${name})
      on conflict (lower(name)) do nothing
      returning to_jsonb(w) as row`);
    if (created) added.push(created);
  }
  return added;
}

export async function removeWatchItems(names: string[]): Promise<string[]> {
  if (names.length === 0) return [];
  const lowered = names.map((n) => n.toLowerCase());
  const removed = await all<WatchItem>(sql`
    delete from public.watch_items w where lower(w.name) = any(${lowered}::text[])
    returning to_jsonb(w) as row`);
  return removed.map((r) => r.name);
}

export async function removeStores(ids: number[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const removed = await all<Store>(sql`
    delete from public.stores s where s.id = any(${ids}::bigint[]) returning to_jsonb(s) as row`);
  return removed.map((r) => `${r.name} (${r.city}, ${r.state})`);
}

export async function savePriceChecks(
  results: PriceResult[],
  meta: { itemQuery: string; watchItemId: number | null; source: "chat" | "weekly" },
): Promise<void> {
  if (results.length === 0) return;
  await insert(
    "price_checks",
    results.map((r) => ({
      watch_item_id: meta.watchItemId,
      item_query: meta.itemQuery,
      store_id: r.store_id,
      status: r.status,
      product_name: r.product_name,
      regular_price: r.regular_price,
      sale_price: r.sale_price,
      unit_price: r.unit_price,
      on_sale: r.on_sale,
      promo_text: r.promo_text,
      product_url: r.product_url,
      note: r.note,
      source: meta.source,
    })),
  );
}

export interface DashboardStats {
  stores: number;
  watchItems: number;
  dealsThisWeek: number;
  lastWeeklyCheck: string | null;
}

export async function dashboardStats(): Promise<DashboardStats> {
  const [row] = await all<DashboardStats>(sql`
    select jsonb_build_object(
      'stores', (select count(*) from public.stores),
      'watchItems', (select count(*) from public.watch_items),
      -- Distinct item x store pairs whose latest check this week was on sale (repeat checks don't inflate it).
      'dealsThisWeek', (select count(*) from (
        select distinct on (lower(item_query), store_id) on_sale from public.price_checks
        where checked_at > now() - interval '7 days' and status = 'found'
        order by lower(item_query), store_id, checked_at desc) latest where on_sale),
      'lastWeeklyCheck', (select max(checked_at) from public.price_checks where source = 'weekly')
    ) as row`);
  return row;
}
