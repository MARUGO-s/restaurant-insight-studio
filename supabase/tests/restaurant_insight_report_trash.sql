-- Transaction-local fixtures only. Never dispatches a job or contacts a provider.
begin;
do $$
declare
  v_owner uuid := gen_random_uuid();
  v_other uuid := gen_random_uuid();
  v_run uuid := gen_random_uuid();
  v_report uuid := gen_random_uuid();
  v_legacy uuid := gen_random_uuid();
  v_job uuid := gen_random_uuid();
  v_cost uuid := gen_random_uuid();
  v_legacy_cost uuid := gen_random_uuid();
  v_reply uuid;
  v_result jsonb;
  v_before timestamptz;
  v_denied boolean;
begin
  if has_function_privilege('authenticated', 'public.restaurant_insight_manage_report(uuid,uuid,text,boolean)', 'EXECUTE')
    or has_function_privilege('anon', 'public.restaurant_insight_save_followup(uuid,uuid,text,text,jsonb)', 'EXECUTE')
    or has_table_privilege('authenticated', 'public.restaurant_insight_report_deletions', 'SELECT')
    or has_table_privilege('authenticated', 'public.restaurant_insight_followups', 'INSERT')
  then raise exception 'Private report mutation permissions are not restricted'; end if;
  insert into auth.users(id) values(v_owner),(v_other);
  insert into public.restaurant_insight_runs(id,user_id,status,progress_stage,input) values(v_run,v_owner,'done','done','{"storeName":"fixture","researchFocus":"private focus"}');
  insert into public.restaurant_insight_jobs(id,run_id,job_key,status,output) values(v_job,v_run,'synthesis','done','{"report_row":{"report":"private research copy"}}');
  insert into public.restaurant_insight_reports(id,user_id,run_id,store_name,store_url,selected_sites,agents,critique,report)
    values(v_report,v_owner,v_run,'Trash fixture','https://example.test','[{"id":"tabelog"}]','[]','critique','private report'),
      (v_legacy,v_owner,null,'Legacy fixture','https://example.test','[{"id":"tabelog"}]','[]','critique','legacy report');
  insert into public.restaurant_insight_cost_events(id,user_id,run_id,report_id,job_id,operation,provider,model,request_status,measurement_status,list_price_usd,pricing_as_of)
    values(v_cost,v_owner,v_run,v_report,v_job,'synthesis','OpenAI','fixture','succeeded','complete',1.234,current_date),
      (v_legacy_cost,v_owner,null,v_legacy,null,'followup_question','OpenAI','fixture','unknown','unknown',null,current_date);
  v_result := public.restaurant_insight_save_followup(v_owner,v_report,'question','answer','[]');
  v_reply := (v_result->>'id')::uuid;

  foreach v_result in array array[jsonb_build_object('action','trash'),jsonb_build_object('action','restore'),jsonb_build_object('action','delete')] loop
    v_denied := false;
    begin perform public.restaurant_insight_manage_report(v_other,v_report,v_result->>'action',true);
    exception when others then v_denied := true; end;
    if not v_denied then raise exception 'Another owner mutated report'; end if;
  end loop;
  v_denied := false;
  begin perform public.restaurant_insight_manage_report(v_owner,v_report,'delete',true);
  exception when others then v_denied := true; end;
  if not v_denied then raise exception 'Direct permanent deletion bypassed trash'; end if;

  v_result := public.restaurant_insight_manage_report(v_owner,v_report,'trash',false);
  v_before := (v_result#>>'{report_row,deleted_at}')::timestamptz;
  if v_before is null then raise exception 'Trash did not persist'; end if;
  perform public.restaurant_insight_manage_report(v_owner,v_report,'trash',false);
  if (select deleted_at from public.restaurant_insight_reports where id=v_report) is distinct from v_before then raise exception 'Repeated trash changed receipt'; end if;
  v_denied := false;
  begin perform public.restaurant_insight_save_followup(v_owner,v_report,'late question','late answer','[]');
  exception when others then v_denied := true; end;
  if not v_denied then raise exception 'Trashed report accepted a late answer'; end if;
  perform public.restaurant_insight_manage_report(v_owner,v_report,'restore',false);
  perform public.restaurant_insight_manage_report(v_owner,v_report,'restore',false);
  if (select deleted_at from public.restaurant_insight_reports where id=v_report) is not null
    or not exists(select 1 from public.restaurant_insight_followups where id=v_reply)
  then raise exception 'Restore did not retain report and conversation'; end if;
  perform public.restaurant_insight_manage_report(v_owner,v_report,'trash',false);
  v_denied := false;
  begin perform public.restaurant_insight_manage_report(v_owner,v_report,'delete',false);
  exception when others then v_denied := true; end;
  if not v_denied then raise exception 'Delete lacked explicit confirmation'; end if;
  v_result := public.restaurant_insight_manage_report(v_owner,v_report,'delete',true);
  if v_result->>'deleted' <> 'true' then raise exception 'Delete not confirmed'; end if;
  perform public.restaurant_insight_manage_report(v_owner,v_report,'delete',true);
  if exists(select 1 from public.restaurant_insight_reports where id=v_report)
    or exists(select 1 from public.restaurant_insight_followups where report_id=v_report)
    or exists(select 1 from public.restaurant_insight_jobs where run_id=v_run)
    or (select input from public.restaurant_insight_runs where id=v_run) <> '{}'::jsonb
    or (select report_deleted_at from public.restaurant_insight_runs where id=v_run) is null
  then raise exception 'Permanent cleanup left report content'; end if;
  if not exists(select 1 from public.restaurant_insight_cost_events where id=v_cost and report_id is null and job_id is null and run_id=v_run and list_price_usd=1.234 and report_name='Trash fixture' and report_deleted_at is not null) then
    raise exception 'Fee history lost or changed';
  end if;
  if public.restaurant_insight_finish_job(v_job,gen_random_uuid(),'{}',null,true)->>'accepted' <> 'false' then raise exception 'Late worker recreated deleted report'; end if;
  if public.restaurant_insight_retry_run(v_run,v_owner)->>'status' <> 'done' then raise exception 'Deleted run restarted'; end if;
  v_denied := false;
  begin perform public.restaurant_insight_manage_report(v_other,v_report,'delete',true);
  exception when others then v_denied := true; end;
  if not v_denied then raise exception 'Other owner read deletion receipt'; end if;

  perform public.restaurant_insight_manage_report(v_owner,v_legacy,'trash',false);
  perform public.restaurant_insight_manage_report(v_owner,v_legacy,'delete',true);
  perform public.restaurant_insight_manage_report(v_owner,v_legacy,'delete',true);
  if not exists(select 1 from public.restaurant_insight_cost_events where id=v_legacy_cost and run_id is null and report_id is null and report_name='Legacy fixture') then raise exception 'Run-less question cost lost'; end if;
  -- A late cost response updates measurements without resurrecting report/job foreign keys.
  update public.restaurant_insight_cost_events set request_status='succeeded',measurement_status='complete',list_price_usd=0.25 where id=v_legacy_cost;
  if (select list_price_usd from public.restaurant_insight_cost_events where id=v_legacy_cost) <> 0.25 then raise exception 'Late fee update failed'; end if;
end;
$$;
rollback;
