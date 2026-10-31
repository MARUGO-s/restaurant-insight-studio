-- Request-level metering for the independent Restaurant Insight Studio app.
-- Costs are calculated from provider-reported usage and a timestamped public
-- standard-rate snapshot; provider credits/free tiers are not knowable here.
alter table public.restaurant_insight_reports
  add column run_id uuid unique references public.restaurant_insight_runs(id) on delete set null;

create table public.restaurant_insight_cost_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  run_id uuid references public.restaurant_insight_runs(id) on delete set null,
  report_id uuid references public.restaurant_insight_reports(id) on delete set null,
  operation text not null check (char_length(operation) between 1 and 40),
  provider text not null check (provider in ('OpenAI', 'Google Gemini', 'xAI')),
  model text not null check (char_length(model) between 1 and 100),
  request_status text not null check (request_status in ('succeeded', 'failed', 'unknown')),
  measurement_status text not null check (measurement_status in ('complete', 'partial', 'unknown')),
  usage jsonb not null default '{}'::jsonb check (jsonb_typeof(usage) = 'object'),
  rates jsonb not null default '{}'::jsonb check (jsonb_typeof(rates) = 'object'),
  list_price_usd numeric(16, 10) check (list_price_usd is null or list_price_usd >= 0),
  pricing_as_of date not null,
  created_at timestamptz not null default now(),
  check (run_id is not null or report_id is not null)
);

create index restaurant_insight_cost_events_user_created
  on public.restaurant_insight_cost_events (user_id, created_at desc);
create index restaurant_insight_cost_events_run
  on public.restaurant_insight_cost_events (run_id, created_at)
  where run_id is not null;
create index restaurant_insight_cost_events_report
  on public.restaurant_insight_cost_events (report_id, created_at)
  where report_id is not null;

alter table public.restaurant_insight_cost_events enable row level security;
revoke all on public.restaurant_insight_cost_events from anon, authenticated;
grant select on public.restaurant_insight_cost_events to authenticated;
grant insert on public.restaurant_insight_cost_events to service_role;

create policy restaurant_insight_cost_events_select_own
  on public.restaurant_insight_cost_events for select to authenticated
  using ((select auth.uid()) = user_id);
