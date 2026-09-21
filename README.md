# The Happy Butcher

A chat app that watches your stores' weekly ads for sales on the fresh meats you actually buy, and emails a sale-only rundown every Wednesday morning.

## How prices are found (`get_item_prices`)

1. **Flipp weekly-ad search** by each store's ZIP: location-correct circular listings for all six chains.
2. **Store's own weekly-ad page via Firecrawl** where the store can be pinned by URL (Publix `?setstorenumber=`).
3. **Matcher** (Claude via OpenRouter) picks the listing that really is the requested cut: marinated ≠ plain, pork loin ≠ pork tenderloin, boneless required when asked.
4. **Regular vs sale** split deterministically from the ad text (`src/lib/priceParse.ts`): crossed-out price, "Save $X", "save up to $X" (approximate), BOGO, "HOT SALE".
5. **Chat only:** stores with no ad match get a Tavily (`site:`) + Firecrawl product-page lookup, returned as `unverified` since most chains set the store by cookie.

Every result is written to `price_checks` (price history).

## Local dev

```
cp .env.example .env.local   # fill in values
npm install
npm run dev                  # http://localhost:3000
npm run check-price -- "pork tenderloin" weekly   # price lookup without the chat
npm test
```

Database: `db/schema.sql` then `db/seed.sql` (Neon project `happy-butcher`).

## Wednesday check

`.github/workflows/weekly-check.yml` POSTs to `/api/weekly-check` at 12:00 UTC Wednesdays (8am EDT; change to `0 13 * * 3` when EST starts in November). Repo secrets: `WEEKLY_CHECK_URL`, `CRON_SECRET`. `?dry=1` checks prices without emailing.
