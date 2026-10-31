-- Transaction-local fixtures only. No provider request or job dispatch occurs.
begin;
do $$
declare
  v_owner uuid := gen_random_uuid();
  v_run uuid := gen_random_uuid();
  v_diagnostic uuid := gen_random_uuid();
  v_constraint text;
  v_denied boolean := false;
begin
  if has_table_privilege('authenticated', 'public.restaurant_insight_cost_events', 'INSERT')
    or has_table_privilege('authenticated', 'public.restaurant_insight_cost_events', 'UPDATE')
    or has_table_privilege('anon', 'public.restaurant_insight_cost_events', 'SELECT')
    or not (select relrowsecurity from pg_class where oid='public.restaurant_insight_cost_events'::regclass)
  then raise exception 'Cost security permissions changed'; end if;

  insert into auth.users(id) values(v_owner);
  insert into public.restaurant_insight_runs(id,user_id,status,progress_stage,input)
    values(v_run,v_owner,'done','done','{"storeName":"diagnostics fixture"}');

  insert into public.restaurant_insight_cost_events(id,user_id,operation,provider,model,request_status,measurement_status,pricing_as_of)
    values(v_diagnostic,v_owner,'provider_diagnostic','Google Gemini','diagnostic-fixture','unknown','unknown',current_date);
  update public.restaurant_insight_cost_events
    set request_status='failed',list_price_usd=0,request_metadata='{"provider_error":{"http_status":429,"violations":[{"quotaValue":0}]}}'
    where id=v_diagnostic;
  if not exists(select 1 from public.restaurant_insight_cost_events where id=v_diagnostic and run_id is null and report_id is null
    and request_status='failed' and request_metadata#>>'{provider_error,violations,0,quotaValue}'='0')
  then raise exception 'Standalone diagnostic was not retained'; end if;

  -- Ordinary analysis costs still require their run/report context.
  begin
    insert into public.restaurant_insight_cost_events(user_id,operation,provider,model,request_status,measurement_status,pricing_as_of)
      values(v_owner,'gourmet_research','Google Gemini','diagnostic-fixture','unknown','unknown',current_date);
  exception when check_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint <> 'restaurant_insight_cost_events_context_check' then raise; end if;
    v_denied := true;
  end;
  if not v_denied then raise exception 'Orphan research cost unexpectedly permitted'; end if;

  insert into public.restaurant_insight_cost_events(user_id,run_id,operation,provider,model,request_status,measurement_status,pricing_as_of)
    values(v_owner,v_run,'gourmet_research','Google Gemini','diagnostic-fixture','succeeded','complete',current_date);
  -- A deleted legacy report may have neither a run nor a report FK.
  insert into public.restaurant_insight_cost_events(user_id,operation,provider,model,request_status,measurement_status,pricing_as_of,report_name,report_deleted_at)
    values(v_owner,'followup_question','OpenAI','diagnostic-fixture','succeeded','complete',current_date,'Deleted fixture',now());
  if (select count(*) from public.restaurant_insight_cost_events where user_id=v_owner) <> 3
    then raise exception 'Legacy cost contexts were not preserved'; end if;
end;
$$;
rollback;
