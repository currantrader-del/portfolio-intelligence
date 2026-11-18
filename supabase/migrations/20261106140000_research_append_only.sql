-- Research Master Records are append-only.
-- A new finding becomes a new research_versions row (supersedes_id -> the previous one).
-- The only change allowed on an existing version is moving the "current" flag.
-- Phases and sources can be added but never edited or removed.
-- A deliberate cleanup can still run with: set local app.allow_research_delete = 'on';

create or replace function public.research_version_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if coalesce(current_setting('app.allow_research_delete', true), '') = 'on' then return old; end if;
    raise exception 'Research versions are append-only: % cannot be deleted', old.id;
  end if;
  if (new.id, new.owner_id, new.company_id, new.research_as_of, new.completeness, new.origin, new.supersedes_id,
      new.conclusion, new.change_summary, new.source_document_id, new.created_at)
     is distinct from
     (old.id, old.owner_id, old.company_id, old.research_as_of, old.completeness, old.origin, old.supersedes_id,
      old.conclusion, old.change_summary, old.source_document_id, old.created_at) then
    raise exception 'Research versions are append-only: only is_current may change on %; write a new version instead', old.id;
  end if;
  return new;
end $$;

create or replace function public.research_child_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and coalesce(current_setting('app.allow_research_delete', true), '') = 'on' then return old; end if;
  raise exception '% rows are append-only: add a new version instead of changing %', tg_table_name, old.id;
end $$;

drop trigger if exists research_versions_append_only on public.research_versions;
create trigger research_versions_append_only before update or delete on public.research_versions
  for each row execute function public.research_version_guard();

drop trigger if exists research_phases_append_only on public.research_phases;
create trigger research_phases_append_only before update or delete on public.research_phases
  for each row execute function public.research_child_guard();

drop trigger if exists research_sources_append_only on public.research_sources;
create trigger research_sources_append_only before update or delete on public.research_sources
  for each row execute function public.research_child_guard();

revoke execute on function public.research_version_guard() from public, anon;
revoke execute on function public.research_child_guard() from public, anon;
