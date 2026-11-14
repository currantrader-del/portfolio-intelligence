-- Rollback for 20261106140000_research_append_only.sql. Removes the guard only; no data is touched.
drop trigger if exists research_versions_append_only on public.research_versions;
drop trigger if exists research_phases_append_only on public.research_phases;
drop trigger if exists research_sources_append_only on public.research_sources;
drop function if exists public.research_version_guard();
drop function if exists public.research_child_guard();
