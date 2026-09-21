-- Happy Butcher schema (Neon Postgres). Idempotent: safe to re-run.

-- Stores price and run circulars by location, so every store row carries one.
create table if not exists public.stores (
  id            bigint generated always as identity primary key,
  name          text not null,
  city          text not null,
  state         text not null,
  zip           text,
  store_number  text,                 -- chain's own id for the location, when its ad lookup needs one
  base_url      text not null,
  weekly_ad_url text,                 -- null when the chain has no browsable circular
  created_at    timestamptz not null default now()
);
-- Adding a store that's already saved is a no-op, not a duplicate.
create unique index if not exists stores_name_location_key
  on public.stores (lower(name), lower(city), lower(state));

create table if not exists public.watch_items (
  id         bigint generated always as identity primary key,
  name       text not null,
  created_at timestamptz not null default now()
);
create unique index if not exists watch_items_name_key on public.watch_items (lower(name));

-- One row per item x store per check: doubles as price history.
create table if not exists public.price_checks (
  id            bigint generated always as identity primary key,
  watch_item_id bigint references public.watch_items (id) on delete set null,
  item_query    text not null,        -- what was searched (watch item name or ad hoc query)
  store_id      bigint not null references public.stores (id) on delete cascade,
  status        text not null check (status in ('found', 'not_found', 'unverified')),
  product_name  text,                 -- the store's own product title that was matched
  regular_price numeric(10, 2),
  sale_price    numeric(10, 2),
  unit_price    text,                 -- as printed, e.g. "$9.99/lb"
  on_sale       boolean not null default false,
  promo_text    text,                 -- e.g. "BOGO", "Save $3/lb", "Valid 9/23-9/29"
  product_url   text,
  note          text,                 -- why a result is unverified/not found
  source        text not null default 'chat' check (source in ('chat', 'weekly')),
  checked_at    timestamptz not null default now()
);
create index if not exists price_checks_item_store_idx on public.price_checks (watch_item_id, store_id, checked_at desc);

create table if not exists public.notifications (
  id           bigint generated always as identity primary key,
  sent_at      timestamptz not null default now(),
  summary_text text not null,
  delivered    boolean not null default false,
  error        text
);

-- Scraped pages reused within a day (e.g. a store's whole weekly ad), to save Firecrawl credits.
create table if not exists public.page_cache (
  url        text primary key,
  markdown   text not null,
  fetched_at timestamptz not null default now()
);

-- Added with the multi-agent build: what the Store Scout learned about each location.
alter table public.stores add column if not exists address text;
alter table public.stores add column if not exists ad_source text check (ad_source in ('flipp', 'store_page', 'none'));
alter table public.stores add column if not exists scout_notes text;

-- Who did what: the agent trace for each chat reply, Store Scout run, and Wednesday check.
create table if not exists public.agent_runs (
  id         bigint generated always as identity primary key,
  kind       text not null check (kind in ('chat', 'weekly', 'store')),
  summary    text not null,
  events     jsonb not null,
  created_at timestamptz not null default now()
);
