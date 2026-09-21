import "server-only";
import type { AdListing } from "../priceParse";

// Everything the Deal Hunter looks at is registered here with an id (E1, E2, ...). Findings and
// verdicts refer to evidence by id, and final prices are parsed from the raw evidence, so a model
// never gets to re-type a number into the result.

export type Evidence =
  | {
      id: string;
      store_id: number;
      source: "weekly_ad" | "store_ad_page" | "store_catalog";
      product_name: string;
      listing: AdListing;
      url: string;
      valid: string | null;
    }
  | {
      id: string;
      store_id: number;
      source: "product_page";
      url: string;
      snippet: string;
    };

type NewEvidence = Evidence extends infer E ? (E extends unknown ? Omit<E, "id"> : never) : never;

export class EvidenceLocker {
  private items = new Map<string, Evidence>();
  private next = 1;

  add<E extends NewEvidence>(e: E): E & { id: string } {
    const withId = { ...e, id: `E${this.next++}` } as E & Evidence;
    this.items.set(withId.id, withId);
    return withId;
  }

  get(id: string | null | undefined): Evidence | undefined {
    return id ? this.items.get(id) : undefined;
  }
}

export const listingText = (l: AdListing) =>
  [[l.pre_price_text, l.current_price !== null ? `$${l.current_price}` : null, l.post_price_text].filter(Boolean).join(" "), l.sale_story]
    .filter(Boolean)
    .join(" | ");
