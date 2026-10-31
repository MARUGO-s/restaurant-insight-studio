-- Long web searches can exceed the HTTP request idle timeout. Persist job progress and errors for polling.
alter table public.restaurant_insight_runs
  add column progress_stage text not null default 'queued'
    check (progress_stage in ('queued', 'researching', 'checking', 'done', 'failed')),
  add column error_message text
    check (error_message is null or char_length(error_message) <= 2000);

update public.restaurant_insight_runs
set progress_stage = case status when 'done' then 'done' when 'failed' then 'failed' else 'queued' end;
