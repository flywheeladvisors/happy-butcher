# The Happy Butcher

A chat app that watches your stores' weekly ads for sales on the fresh meats you actually buy, and emails a sale-only rundown every Wednesday morning.

## The crew (multi-agent)

Four agents, each with its own instructions, tools, and loop (`src/lib/agents/`). They hand work to each other, and every step is recorded: shown in the chat's agent-activity panel and saved to `agent_runs`.

| Agent | Role | Tools |
|---|---|---|
| **Happy Butcher** (`butcher.ts`) | Orchestrator. Talks to the customer, delegates, writes answers and the Wednesday rundown. | `update_store_list`, `manage_watch_list`, `get_item_prices`; Wednesdays: `dispatch_deal_hunters` |
| **Store Scout** (`storeScout.ts`) | Resolves a new store to an exact location (address, ZIP, store number) and a reachable weekly ad. | ZIP lookup, weekly-ad coverage by ZIP, Tavily search, Firecrawl page read |
| **Deal Hunter** (`dealHunter.ts`) | For one cut, searches weekly ads by ZIP (Flipp), the store's own ad page (Publix via Firecrawl), and in chat the store's website (Tavily `site:` + Firecrawl). Submits one candidate per store as evidence ids. | `search_weekly_ads`, `browse_store_ad`, `search_store_site`, `read_product_page` |
| **Cut Inspector** (`cutInspector.ts`) | The skeptic. Checks each candidate is the exact cut (marinated ≠ plain, loin ≠ tenderloin, lean ratios), that the price was read right and applies to our store, and whether it's really a sale. Approves, marks unverified, or rejects and sends the Hunter back with a hint. | `get_evidence`, `parse_ad_price`, `price_history` |

**Price check flow** (`prices.ts`): Butcher → Deal Hunter → Cut Inspector → (rejects with hints) → Deal Hunter → Cut Inspector. Prices are then parsed deterministically from the approved raw evidence (`priceParse.ts`), so no model re-types a number. Product-page prices are always `unverified`, since most chains pick the store by cookie.

**Wednesday** (`weeklyCheck.ts`): the Butcher dispatches Deal Hunters for every watched cut (code backstops any he skips), reads the verified deals, and writes the intro and sign-off. The deals table in the email is rendered from the results.

Models (via OpenRouter): Butcher `OPENROUTER_MODEL` (Claude Sonnet 5), Deal Hunter Claude Haiku 4.5 (many fast tool calls), Cut Inspector and Store Scout Claude Sonnet 5. Override with `HUNTER_MODEL`, `INSPECTOR_MODEL`, `SCOUT_MODEL`.

## Local dev

```
cp .env.example .env.local   # fill in values
npm install
npm run dev                  # http://localhost:3000
npm run check-price -- "pork tenderloin" weekly   # Hunter + Inspector without the chat, prints the trace
npm test
```

Database: `db/schema.sql` then `db/seed.sql` (Neon project `happy-butcher`).

## Wednesday check

`.github/workflows/weekly-check.yml` POSTs to `/api/weekly-check` at 12:00 UTC Wednesdays (8am EDT; change to `0 13 * * 3` when EST starts in November). Repo secrets: `WEEKLY_CHECK_URL`, `CRON_SECRET`. `?dry=1` checks prices without emailing. `/api/env-check` (same secret) reports which environment variables the deployment has.
