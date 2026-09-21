# The Happy Butcher

A chat app that watches your stores' weekly ads for sales on the fresh meats you actually buy, and emails a sale-only rundown every Wednesday morning.

## The crew (multi-agent)

Four agents, each with its own instructions, tools, and loop (). They hand work to each other and every step is recorded (shown in the chat's agent-activity panel; saved to ).

| Agent | Role | Tools |
|---|---|---|
| **Happy Butcher** () | Orchestrator. Talks to the customer, delegates, writes answers and the Wednesday rundown. | , , ; Wednesdays:  |
| **Store Scout** () | Resolves a new store to an exact location (address, ZIP, store number) and a reachable weekly ad. | ZIP lookup, weekly-ad coverage by ZIP, Tavily, Firecrawl |
| **Deal Hunter** () | For one cut, searches weekly ads by ZIP (Flipp), the store's own ad page (Publix via Firecrawl), and in chat the store's website (Tavily  + Firecrawl). Submits one candidate per store as evidence ids. | , , ,  |
| **Cut Inspector** () | Skeptic. Checks each candidate is the exact cut (marinated ≠ plain, loin ≠ tenderloin, lean ratios), that the price was read right and applies to our store, and whether it's really a sale. Approves, marks unverified, or rejects and sends the Hunter back with a hint. | , ,  |

**Price check flow** (): Butcher → Deal Hunter → Cut Inspector → (rejects with hints) → Deal Hunter → Cut Inspector → prices parsed deterministically from the approved raw evidence (), so no model re-types a number. Product-page prices are always  (most chains pick the store by cookie).

**Wednesday** (): the Butcher dispatches Deal Hunters for every watched cut (code backstops any he skips), reads the verified deals, and writes the intro/sign-off; the deals table in the email is rendered from the results.

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
