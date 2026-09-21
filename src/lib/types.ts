export interface Store {
  id: number;
  name: string;
  city: string;
  state: string;
  zip: string | null;
  store_number: string | null;
  base_url: string;
  weekly_ad_url: string | null;
  created_at: string;
}

export interface WatchItem {
  id: number;
  name: string;
  created_at: string;
}

export type PriceStatus = "found" | "not_found" | "unverified";

/** One store's answer for one item. Regular and sale prices are separate on purpose. */
export interface PriceResult {
  store_id: number;
  store: string;
  status: PriceStatus;
  product_name: string | null;
  regular_price: number | null;
  sale_price: number | null;
  unit_price: string | null;
  on_sale: boolean;
  promo_text: string | null;
  product_url: string | null;
  note: string | null;
}
