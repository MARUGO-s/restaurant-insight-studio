-- Dedicated storage for Restaurant Insight Studio. No existing app tables are changed.
create table public.restaurant_insight_reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  store_name text not null check (char_length(store_name) between 1 and 120),
  store_url text not null check (char_length(store_url) between 8 and 600),
  group_name text check (group_name is null or char_length(group_name) <= 120),
  selected_sites jsonb not null check (jsonb_typeof(selected_sites) = 'array' and jsonb_array_length(selected_sites) between 1 and 12),
  agents jsonb not null check (jsonb_typeof(agents) = 'array'),
  critique text not null,
  critique_sources jsonb not null default '[]'::jsonb check (jsonb_typeof(critique_sources) = 'array'),
  report text not null,
  report_sources jsonb not null default '[]'::jsonb check (jsonb_typeof(report_sources) = 'array'),
  created_at timestamptz not null default now(),
  unique (id, user_id)
);

create index restaurant_insight_reports_user_created
  on public.restaurant_insight_reports (user_id, created_at desc);

create table public.restaurant_insight_followups (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  question text not null check (char_length(question) between 1 and 2000),
  answer text not null,
  sources jsonb not null default '[]'::jsonb check (jsonb_typeof(sources) = 'array'),
  created_at timestamptz not null default now(),
  foreign key (report_id, user_id)
    references public.restaurant_insight_reports(id, user_id) on delete cascade
);

create index restaurant_insight_followups_report_created
  on public.restaurant_insight_followups (report_id, created_at);

create table public.restaurant_insight_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'running' check (status in ('running', 'done', 'failed')),
  error_code text check (error_code is null or char_length(error_code) <= 80),
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create index restaurant_insight_runs_user_started
  on public.restaurant_insight_runs (user_id, started_at desc);

alter table public.restaurant_insight_reports enable row level security;
alter table public.restaurant_insight_followups enable row level security;
alter table public.restaurant_insight_runs enable row level security;

revoke all on public.restaurant_insight_reports,
  public.restaurant_insight_followups,
  public.restaurant_insight_runs from anon, authenticated;

grant select, insert on public.restaurant_insight_reports to authenticated;
grant select, insert on public.restaurant_insight_followups to authenticated;
grant select, insert, update on public.restaurant_insight_runs to authenticated;

create policy restaurant_insight_reports_select_own
  on public.restaurant_insight_reports for select to authenticated
  using ((select auth.uid()) = user_id);
create policy restaurant_insight_reports_insert_own
  on public.restaurant_insight_reports for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy restaurant_insight_followups_select_own
  on public.restaurant_insight_followups for select to authenticated
  using ((select auth.uid()) = user_id);
create policy restaurant_insight_followups_insert_own
  on public.restaurant_insight_followups for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.restaurant_insight_reports r
      where r.id = report_id and r.user_id = (select auth.uid())
    )
  );

create policy restaurant_insight_runs_select_own
  on public.restaurant_insight_runs for select to authenticated
  using ((select auth.uid()) = user_id);
create policy restaurant_insight_runs_insert_own
  on public.restaurant_insight_runs for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy restaurant_insight_runs_update_own
  on public.restaurant_insight_runs for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
