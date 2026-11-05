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
| 1 | Foundation: schema, two-factor login, research import with provenance | this branch |
| 2 | Real data: Schwab sync, Acorns statements, quotes, freshness | next |
| 3 | Portfolio engine: returns, attribution, look-through, limits | |
| 4 | Decision engine: the "$1,250" workflow end to end, assistant with tools | |
| 5 | Monitoring and alerts | |
| 6 | Today brief | |
| 7 | Research profiles and decision outcomes | |

## Local setup

```bash
npm install
cp .env.example .env.local   # fill in the Supabase URL and publishable key
npm run dev
```

Checks: `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`.

## Database

Migrations live in `supabase/migrations`. Row-level security is on for every table.

- Private tables require the row's owner **and** a two-factor session (`aal2`).
- Market-data tables are read-only for signed-in users and are written only by server jobs.

## Importing preserved research

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
