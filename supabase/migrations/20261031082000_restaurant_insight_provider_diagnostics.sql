-- Connection diagnostics are metered before any analysis run/report exists.
-- Preserve all previous contexts, including receipts for permanently deleted reports.
-- No existing data, ownership policy or write privilege is changed.
alter table public.restaurant_insight_cost_events
  drop constraint restaurant_insight_cost_events_context_check,
  add constraint restaurant_insight_cost_events_context_check check (
    run_id is not null
    or report_id is not null
    or (report_deleted_at is not null and report_name is not null)
    or operation = 'provider_diagnostic'
  );
