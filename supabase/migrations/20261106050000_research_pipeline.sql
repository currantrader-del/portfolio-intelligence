-- Research pipeline: every company has a stage, a dated screen result and a stage history.
-- Additive only: no existing column or row is removed.
alter table public.companies
  add column if not exists pipeline_stage text not null default 'idea'
    check (pipeline_stage in ('idea','screening','researching','ready','owned','passed')),
  add column if not exists pipeline_note text,
  add column if not exists stage_updated_at timestamptz,
  add column if not exists stage_history jsonb not null default '[]'::jsonb,
  add column if not exists screen jsonb,
  add column if not exists screened_at timestamptz;

-- Starting stages from what is already known.
update public.companies c set pipeline_stage = case
    when c.watchlist_status = 'held' then 'owned'
    when c.watchlist_status = 'excluded' then 'passed'
    when exists (select 1 from public.research_versions v where v.company_id = c.id) then 'researching'
    when c.watchlist_status = 'queued' then 'screening'
    else 'idea' end,
  stage_updated_at = now()
where c.stage_updated_at is null;

update public.companies set stage_history = jsonb_build_array(jsonb_build_object('stage', pipeline_stage, 'at', now(), 'note', 'Set from watchlist status and research on file'))
where stage_history = '[]'::jsonb;
