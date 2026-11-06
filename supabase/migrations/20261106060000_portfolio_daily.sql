-- One recorded row per day of what the app showed: the start of a real value history.
-- It records app estimates as estimates; "verified" only when every account was API-synced that day.
create table public.portfolio_daily (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  as_of date not null,
  investable numeric not null,
  invested numeric not null,
  cash numeric not null,
  net_worth_tracked numeric,
  spy_close numeric,
  quality text not null check (quality in ('verified','estimated')),
  holdings_as_of date,
  positions jsonb not null default '[]'::jsonb,
  recorded_at timestamptz not null default now(),
  unique (owner_id, as_of)
);

alter table public.portfolio_daily enable row level security;
create policy portfolio_daily_owner_mfa on public.portfolio_daily for all to authenticated
  using (owner_id = (select auth.uid()) and public.is_mfa_session())
  with check (owner_id = (select auth.uid()) and public.is_mfa_session());
revoke all on public.portfolio_daily from anon;
