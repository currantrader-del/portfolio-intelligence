-- Two-factor becomes optional (owner's choice, 2026-11-05).
-- A password session is enough until the owner enrolls an authenticator;
-- once a verified factor exists, every session must be aal2 again.

-- Reading auth.mfa_factors needs elevated rights, so that one check lives in a
-- private schema the REST API does not expose. It only looks at the caller's own factors.
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

create or replace function private.has_verified_factor() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from auth.mfa_factors f
    where f.user_id = (select auth.uid()) and f.status = 'verified'
  )
$$;
revoke all on function private.has_verified_factor() from public, anon;
grant execute on function private.has_verified_factor() to authenticated;

create or replace function public.is_mfa_session() returns boolean
language sql stable security invoker set search_path = '' as $$
  select coalesce((auth.jwt() ->> 'aal') = 'aal2', false) or not private.has_verified_factor()
$$;
comment on function public.is_mfa_session() is 'True for aal2 sessions, or any signed-in session when the user has no verified MFA factor.';
