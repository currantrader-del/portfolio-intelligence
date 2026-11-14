# Portfolio Intelligence

A decision desk for investment research and portfolio management. Next.js on Netlify, Supabase, and Claude as the explanation layer.

Design: Concept B, "Decision Desk". It opens on a short brief and a ranked queue of decisions. Each decision opens a workspace with evidence, calculations, alternatives and a recommendation.

## Principles

- **Four labeled data layers:** market data, research conclusions, model outputs and AI judgments. Each has its own tables, and every number carries a source and a timestamp.
- **Code does the financial math.** Claude explains and recommends, citing tool outputs. It never supplies prices, holdings or calculations itself.
- **Research is versioned and never overwritten.** New evidence creates a targeted update, not a silent edit.
- **No trading.** The app has no way to place orders.
- **No private data in this repository:** no brokerage exports, statements, research archives or keys.

## Stages

| Stage | Scope | Status |
|---|---|---|
| 1 | Foundation: schema, login (optional two-factor), research import with provenance | done |
| 2 | Real data: statements loaded, delayed quotes (Yahoo, Stooq fallback), freshness labels | done; Schwab API sync later |
| 3 | Portfolio engine: weights, day attribution, policy buckets, ETF look-through, limits | done |
| 4 | Decision engine: new-cash workflow, position review, assistant with tools | done |
| 5 | Monitoring: alert rules evaluated on every load (price bands, big moves, limits, stale research) | done; scheduled push alerts later |
| 6 | Today brief: written by code from computed numbers | done |
| 7 | Decision log with outcomes since each decision | done; stored 30/90/365-day scores later |

## How the pieces fit

- `src/lib/market`: quotes and market hours (Layer 1).
- `src/lib/research`: reads stored conclusions and re-prices them at today's price (Layer 2 to 3).
- `src/lib/portfolio`, `src/lib/policy`: deterministic portfolio math and policy limits (Layer 3).
- `src/lib/decision`: the new-cash and position-review engines. Every recorded decision saves a `model_runs` row with its inputs hash.
- `src/lib/alerts`, `src/lib/brief.ts`: monitoring rules and the Today brief.
- `src/app/api/ask`: the assistant. It can only cite numbers returned by its tools, and every answer is logged in `ai_judgments` with tokens and cost (Layer 4).

Environment: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, and `ANTHROPIC_API_KEY` (server only) for the assistant.

## Local setup

```bash
npm install
cp .env.example .env.local   # fill in the Supabase URL and publishable key
npm run dev
```

Checks: `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`.

## Database

Migrations live in `supabase/migrations`. Row-level security is on for every table.

- Private tables require the row's owner. Two-factor is optional: once an authenticator is enrolled, every session must verify it (`aal2`).
- Market-data tables are read-only for signed-in users and are written only by server jobs.

## Importing preserved research

The easiest way: sign in and open **/import**, choose the files (JSON, Markdown and the two zips), check the audit, then press Import. It runs under your own login, so no server keys are needed. Re-running it is safe.

From the command line:

```bash
# Dry run: prints the audit and writes the plan outside the repo
npm run import:originals -- /path/to/originals --out /tmp/import-plan.json

# Apply (needs the server-side key; safe to re-run)
NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SECRET_KEY=... npm run import:originals -- /path/to/originals --apply --owner you@example.com
```

Import rules:

- Every row keeps its source file and SHA-256.
- Reconstructed phases are labeled as reconstructed.
- Partial archives are never marked complete.
- Conflicting records (GOOGL) are kept as dated history, with none marked current.
- Historical balances are never treated as current holdings.
