-- P0 review fixes: a transaction ledger for reconciliation, versioned policy rules with approval status,
-- and richer decision records. Nothing existing is dropped or rewritten.

-- ---------- Transaction ledger ----------
-- Trades and cash flows after a statement. Holdings shown = latest snapshot + ledger rows dated after it.
create table public.transactions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  account_id uuid not null references public.accounts(id) on delete cascade,
  trade_date date not null,
  kind text not null check (kind in ('buy','sell','deposit','withdrawal','dividend','interest','fee','transfer_in','transfer_out')),
  symbol text,
  quantity numeric(20,6),
  price numeric(14,4),
  amount numeric(14,2) not null,       -- cash effect on the account: negative for a buy, positive for a sale or deposit
  source_kind text not null default 'manual' check (source_kind in ('manual','statement','csv_import','schwab_api')),
  source_document_id uuid references public.source_documents(id),
  note text,
  created_at timestamptz not null default now(),
  check ((kind in ('buy','sell') and symbol is not null and quantity > 0 and price >= 0) or kind not in ('buy','sell'))
);
create index on public.transactions(account_id, trade_date);

-- ---------- Versioned policy rules ----------
-- One row per rule per source. Rules are never deleted; approval moves between rows.
create table public.policy_rules (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  scope text not null check (scope in ('bucket','company','generic_company','portfolio','assumption')),
  subject text not null,               -- bucket name, ticker, 'generic', or an assumption key
  normal_low numeric(6,4),
  normal_high numeric(6,4),
  high_conviction_low numeric(6,4),
  high_conviction_high numeric(6,4),
  hard_max numeric(6,4),
  value numeric(14,4),                 -- for assumptions (e.g. an ETF expected return) and portfolio-level numbers
  conditions text,
  source_label text not null,          -- e.g. 'Portfolio Baseline v2 (revised)', 'IREN research 2026-09-10'
  source_date date,                    -- null when the source never stated a date
  source_status text not null,         -- what the source itself said: latest_approved, superseded, company_research, historical_research, user_entry
  source_document_id uuid references public.source_documents(id),
  approval text not null default 'unresolved' check (approval in ('approved','superseded','unresolved','proposed')),
  approved_at timestamptz,
  approval_note text,
  created_at timestamptz not null default now()
);
create index on public.policy_rules(scope, subject);
-- At most one approved rule per subject.
create unique index policy_rules_one_approved on public.policy_rules(owner_id, scope, subject) where approval = 'approved';

-- ---------- Decision records ----------
alter table public.decisions
  add column if not exists status text check (status in ('actionable','wait_review','historical')),
  add column if not exists research_as_of date,
  add column if not exists imported_at timestamptz,
  add column if not exists execution jsonb;   -- what was actually traded, if anything

-- ---------- RLS (same owner rule as every other private table) ----------
do $$
declare t text;
begin
  foreach t in array array['transactions','policy_rules']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for all to authenticated using (owner_id = (select auth.uid()) and public.is_mfa_session()) with check (owner_id = (select auth.uid()) and public.is_mfa_session())', t || '_owner_mfa', t);
  end loop;
end $$;

revoke all on public.transactions, public.policy_rules from anon;
