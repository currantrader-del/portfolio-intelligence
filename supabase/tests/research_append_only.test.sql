-- Staging test for 20261106140000_research_append_only.sql.
-- Run on a scratch database that has every earlier migration applied (see supabase/tests/run-staging.sh).
-- Each check raises an exception on failure, so the script stops at the first broken expectation.
\set ON_ERROR_STOP 1
\echo '--- seed: one owner, one company, a historical version with a phase and a source'
insert into auth.users(id) values ('00000000-0000-0000-0000-000000000001');
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001';
set request.jwt.claims = '{"aal":"aal1"}';
insert into public.companies(id, owner_id, symbol, name) values ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'TEST', 'Test Co');
insert into public.research_versions(id, owner_id, company_id, research_as_of, completeness, origin, is_current, conclusion)
  values ('20000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '2026-09-10', 'complete', 'chatgpt_original', true, '{"action":"HOLD / NO ADD","reference_price":"$44.30"}');
insert into public.research_phases(owner_id, version_id, phase_number, title, body_markdown, extraction)
  values ('00000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 1, 'Phase 1', 'original text', 'verbatim');
insert into public.research_sources(owner_id, version_id, title, url) values ('00000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', '10-K', 'https://www.sec.gov/');
create temp table before_md5 as select md5(v::text) h from public.research_versions v;

\echo '--- apply the migration'
\i supabase/migrations/20261106140000_research_append_only.sql

create function pg_temp.expect_error(sql text, label text) returns void language plpgsql as $$
begin
  begin execute sql; exception when others then raise notice 'PASS (blocked): % -> %', label, sqlerrm; return; end;
  raise exception 'FAIL: % was allowed', label;
end $$;

\echo '--- 1. historical content cannot be edited or deleted'
select pg_temp.expect_error($$update public.research_versions set conclusion = '{"action":"BUY"}' where id = '20000000-0000-0000-0000-000000000001'$$, 'edit conclusion');
select pg_temp.expect_error($$update public.research_versions set research_as_of = '2026-11-06' where id = '20000000-0000-0000-0000-000000000001'$$, 'edit research date');
select pg_temp.expect_error($$delete from public.research_versions where id = '20000000-0000-0000-0000-000000000001'$$, 'delete version');
select pg_temp.expect_error($$update public.research_phases set body_markdown = 'rewritten'$$, 'edit phase text');
select pg_temp.expect_error($$delete from public.research_phases$$, 'delete phase');
select pg_temp.expect_error($$update public.research_sources set url = 'https://example.com'$$, 'edit source');
select pg_temp.expect_error($$delete from public.research_sources$$, 'delete source');
select pg_temp.expect_error($$delete from public.companies where symbol = 'TEST'$$, 'cascade delete through company');

\echo '--- 2. a correction is a new version; the current flag can move'
do $$ begin
  update public.research_versions set is_current = false where id = '20000000-0000-0000-0000-000000000001';
  insert into public.research_versions(id, owner_id, company_id, research_as_of, completeness, origin, is_current, supersedes_id, conclusion, change_summary)
    values ('20000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '2026-11-06', 'in_progress', 'claude_targeted_update', true, '20000000-0000-0000-0000-000000000001', '{"status":"WAIT / REVIEW"}', 'Q1 FY27 results');
  insert into public.research_sources(owner_id, version_id, title, url) values ('00000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000002', '10-Q', 'https://www.sec.gov/');
  raise notice 'PASS: new version, new source and current-flag move allowed';
end $$;
do $$ begin
  if (select count(*) from public.research_versions) <> 2 then raise exception 'FAIL: expected 2 versions'; end if;
  if (select md5(v::text) from public.research_versions v where id = '20000000-0000-0000-0000-000000000001')
     = (select h from before_md5) then raise exception 'FAIL: expected only is_current to differ'; end if;
  if exists (select 1 from public.research_versions v where id = '20000000-0000-0000-0000-000000000001' and (conclusion->>'action' <> 'HOLD / NO ADD' or research_as_of <> '2026-09-10')) then raise exception 'FAIL: historical content changed'; end if;
  raise notice 'PASS: historical version content unchanged (only is_current moved)';
end $$;

\echo '--- 3. the app role (authenticated, row-level security) is held to the same rules'
grant usage on schema private to authenticated;
set role authenticated;
select pg_temp.expect_error($$update public.research_versions set conclusion = '{}' where id = '20000000-0000-0000-0000-000000000001'$$, 'app role edits conclusion');
do $$ begin
  if (select count(*) from public.research_versions) <> 2 then raise exception 'FAIL: app role cannot read versions'; end if;
  insert into public.research_phases(owner_id, version_id, phase_number, title, body_markdown, extraction)
    values ('00000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000002', 1, 'Refresh', 'new text', 'verbatim');
  raise notice 'PASS: app role reads versions and adds a phase to the new version';
end $$;
reset role;

\echo '--- 4. deliberate cleanup still possible with the explicit switch'
begin;
set local app.allow_research_delete = 'on';
delete from public.research_sources where version_id = '20000000-0000-0000-0000-000000000002';
rollback;
do $$ begin
  if (select count(*) from public.research_sources) <> 2 then raise exception 'FAIL: rollback did not restore'; end if;
  raise notice 'PASS: explicit delete switch works inside a transaction, and rollback restores';
end $$;

\echo '--- 5. rollback procedure removes the guard completely'
\i supabase/migrations/rollback/20261106140000_research_append_only.down.sql
do $$ begin
  update public.research_phases set title = 'editable again' where version_id = '20000000-0000-0000-0000-000000000002';
  if exists (select 1 from pg_trigger where tgname like 'research_%append_only') then raise exception 'FAIL: triggers remain'; end if;
  raise notice 'PASS: rollback removes triggers and functions; edits work again';
end $$;
\echo '--- 6. re-applying after rollback is idempotent'
\i supabase/migrations/20261106140000_research_append_only.sql
\i supabase/migrations/20261106140000_research_append_only.sql
select pg_temp.expect_error($$update public.research_phases set title = 'x'$$, 'edit after re-apply');
\echo 'ALL STAGING CHECKS PASSED'
