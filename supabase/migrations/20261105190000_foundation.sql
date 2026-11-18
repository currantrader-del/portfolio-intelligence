-- Stage 1 foundation schema for Portfolio Intelligence.
-- Four labeled data layers: market data, research conclusions, model outputs, AI judgments.
-- Single owner per row; every table has RLS. Private tables also require a two-factor session (aal2).

create extension if not exists pgcrypto;

-- Helper: true when the caller is signed in with two-factor.
create or replace function public.is_mfa_session() returns boolean
language sql stable security invoker set search_path = '' as $$
  select coalesce((auth.jwt() ->> 'aal') = 'aal2', false)
$$;

-- ---------- Provenance ----------
create table public.source_documents (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  file_name text not null,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  byte_size bigint not null,
  storage_path text,
  origin text not null check (origin in ('chatgpt_export','chatgpt_paste','broker_export','broker_statement','sec_filing','web','manual')),
  description text,
  received_at timestamptz not null default now(),
  unique (owner_id, sha256)
);

-- ---------- Policy ----------
create table public.policies (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  version text not null,
  effective_from date not null,
  is_current boolean not null default false,
  rules jsonb not null,               -- limits, floors, hurdle, freshness windows
  source_document_id uuid references public.source_documents(id),
  created_at timestamptz not null default now()
);
create unique index policies_one_current on public.policies(owner_id) where is_current;

-- ---------- Accounts and holdings ----------
create table public.accounts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  institution text not null,
  account_role text not null check (account_role in ('taxable_brokerage','retirement','cash','protected_savings')),
  external_ref_hint text,             -- last 4 digits at most; never a full account number
  created_at timestamptz not null default now()
);

create table public.holding_snapshots (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  account_id uuid not null references public.accounts(id) on delete cascade,
  as_of timestamptz not null,
  source_kind text not null check (source_kind in ('schwab_api','csv_import','statement','manual')),
  source_document_id uuid references public.source_documents(id),
  total_value numeric(14,2),
  cash_value numeric(14,2),
  imported_at timestamptz not null default now()
);
create index on public.holding_snapshots(account_id, as_of desc);

create table public.positions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  snapshot_id uuid not null references public.holding_snapshots(id) on delete cascade,
  symbol text not null,
  quantity numeric(20,6),
  price numeric(14,4),
  market_value numeric(14,2),
  cost_basis numeric(14,2)            -- null when unknown; tax impact then shows "unknown"
);
create index on public.positions(snapshot_id);

-- ---------- Layer 1: market data (shared, read by any signed-in user, written by server jobs) ----------
create table public.quotes (
  symbol text not null,
  as_of timestamptz not null,
  price numeric(14,4) not null,
  prev_close numeric(14,4),
  provider text not null,
  delay_class text not null check (delay_class in ('realtime','delayed','eod')),
  primary key (symbol, as_of)
);

create table public.daily_prices (
  symbol text not null,
  trade_date date not null,
  open numeric(14,4), high numeric(14,4), low numeric(14,4),
  close numeric(14,4) not null,
  volume bigint,
  provider text not null,
  primary key (symbol, trade_date)
);

create table public.filings (
  accession text primary key,
  symbol text not null,
  cik text not null,
  form text not null,
  filed_at timestamptz not null,
  url text not null,
  fetched_at timestamptz not null default now()
);
create index on public.filings(symbol, filed_at desc);

create table public.news_items (
  id uuid primary key default gen_random_uuid(),
  symbol text,
  published_at timestamptz not null,
  headline text not null,
  url text not null,
  provider text not null,
  unique (provider, url)
);
create index on public.news_items(symbol, published_at desc);

-- ---------- Layer 2: research conclusions (versioned, never overwritten) ----------
create table public.companies (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  symbol text not null,
  name text,
  cik text,
  watchlist_status text not null default 'watch' check (watchlist_status in ('held','watch','queued','excluded')),
  unique (owner_id, symbol)
);

create table public.research_versions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  research_as_of date not null,
  completeness text not null check (completeness in ('complete','partial','in_progress')),
  origin text not null check (origin in ('chatgpt_original','chatgpt_reconstructed','claude_targeted_update','claude_full','manual')),
  is_current boolean not null default false,  -- only one may be current; a conflict leaves none current
  supersedes_id uuid references public.research_versions(id),
  conclusion jsonb not null default '{}'::jsonb, -- classification, action, confidence, reference price/date, thesis pillars, scenarios, bands, allocation
  change_summary text,
  source_document_id uuid references public.source_documents(id),
  created_at timestamptz not null default now()
);
create unique index research_one_current on public.research_versions(company_id) where is_current;

create table public.research_phases (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  version_id uuid not null references public.research_versions(id) on delete cascade,
  phase_number int not null check (phase_number between 1 and 6),
  title text,
  body_markdown text,
  extraction text not null check (extraction in ('verbatim','reconstructed','summary_only','truncated','missing')),
  details jsonb not null default '{}'::jsonb,
  source_document_id uuid references public.source_documents(id),
  unique (version_id, phase_number)
);

create table public.research_sources (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  version_id uuid not null references public.research_versions(id) on delete cascade,
  title text not null,
  url text,
  document_date date,
  details jsonb not null default '{}'::jsonb
);

-- ---------- Layer 3: model outputs (deterministic, reproducible) ----------
create table public.model_runs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  kind text not null,                 -- e.g. attribution, expected_return, purchase_simulation, ranking
  code_version text not null,
  inputs jsonb not null,
  inputs_sha256 text not null,
  outputs jsonb not null,
  computed_at timestamptz not null default now()
);
create index on public.model_runs(kind, computed_at desc);

-- ---------- Layer 4: AI judgments (always cite what they used) ----------
create table public.ai_judgments (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  kind text not null,                 -- brief, materiality, recommendation, answer, targeted_update
  model text not null,
  tool_calls jsonb not null default '[]'::jsonb,
  cited_model_run_ids uuid[] not null default '{}',
  cited_research_version_ids uuid[] not null default '{}',
  output_markdown text not null,
  confidence text,
  input_tokens int, output_tokens int, cost_usd numeric(10,5),
  created_at timestamptz not null default now()
);

-- ---------- Decisions ----------
create table public.decisions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  kind text not null check (kind in ('new_capital','alert_review','rebalance','research_review','historical')),
  symbol text,
  decided_at timestamptz not null default now(),
  recommendation jsonb not null,      -- action, amounts, confidence, what-would-change-it
  alternatives jsonb not null default '[]'::jsonb,
  model_run_id uuid references public.model_runs(id),
  ai_judgment_id uuid references public.ai_judgments(id),
  research_version_id uuid references public.research_versions(id),
  user_action text check (user_action in ('followed','partially_followed','declined','deferred','dismissed')),
  user_action_at timestamptz,
  user_note text,
  source_document_id uuid references public.source_documents(id)
);
create index on public.decisions(decided_at desc);

create table public.decision_outcomes (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  decision_id uuid not null references public.decisions(id) on delete cascade,
  horizon_days int not null check (horizon_days in (30,90,365)),
  measured_at timestamptz not null default now(),
  result jsonb not null,
  unique (decision_id, horizon_days)
);

-- ---------- Row-level security ----------
do $$
declare t text;
begin
  foreach t in array array['source_documents','policies','accounts','holding_snapshots','positions','companies',
    'research_versions','research_phases','research_sources','model_runs','ai_judgments','decisions','decision_outcomes']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for all to authenticated using (owner_id = (select auth.uid()) and public.is_mfa_session()) with check (owner_id = (select auth.uid()) and public.is_mfa_session())', t || '_owner_mfa', t);
  end loop;
  foreach t in array array['quotes','daily_prices','filings','news_items']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.is_mfa_session())', t || '_read_mfa', t);
  end loop;
end $$;

-- No anonymous access to anything.
revoke all on all tables in schema public from anon;
revoke execute on function public.is_mfa_session() from anon, public;
grant execute on function public.is_mfa_session() to authenticated;

-- Private bucket for preserved originals (exports, archives, statements). Never public.
insert into storage.buckets (id, name, public) values ('originals', 'originals', false)
on conflict (id) do nothing;
create policy originals_owner_mfa on storage.objects for all to authenticated
  using (bucket_id = 'originals' and owner = (select auth.uid()) and public.is_mfa_session())
  with check (bucket_id = 'originals' and owner = (select auth.uid()) and public.is_mfa_session());
