-- Disposable PostgreSQL only. No dispatcher or real provider is invoked.
begin;
create function pg_temp.check_true(ok boolean, message text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception '%', message; end if; end $$;
create function pg_temp.reject(sql text) returns void language plpgsql as $$
begin
  begin execute sql; exception when raise_exception or insufficient_privilege or unique_violation then return; end;
  raise exception 'Unexpectedly accepted: %', sql;
end $$;
do $$
declare
  u uuid := gen_random_uuid(); other_u uuid := gen_random_uuid(); r uuid; j uuid; req uuid := gen_random_uuid();
  receipt jsonb; replay jsonb; peers jsonb; costs jsonb; original jsonb; g uuid;
begin
  insert into auth.users(id) values(u),(other_u);
  r := public.restaurant_insight_queue_run(u,'{"storeName":"fixture","storeUrl":"https://example.test","selectedSites":[{"id":"tabelog"}]}');
  select id into j from public.restaurant_insight_jobs where run_id=r and job_key='synthesis';
  update public.restaurant_insight_jobs set status='done',attempts=1,output=jsonb_build_object('text',job_key || ' immutable research'),finished_at=now() where run_id=r and job_key<>'synthesis';
  original := '{"synthesisDraft":{"version":1,"responseStatus":"completed","responseId":"resp-old","text":"original RAW output","toolSources":[]},"sourceRecovery":{"status":"needs_review","validationMessage":"claimReviews[2].evidenceQuote: exact quotation mismatch","unmatchedSources":["https://unknown.test"]}}';
  update public.restaurant_insight_jobs set status='failed',attempts=2,output=original,error_message='previous diagnostic',finished_at=now() where id=j;
  update public.restaurant_insight_runs set status='failed',progress_stage='failed',deadline_at=now()-interval '1 hour',finished_at=now() where id=r;
  insert into public.restaurant_insight_cost_events(user_id,run_id,job_id,operation,provider,model,request_status,measurement_status,pricing_as_of,request_metadata)
    values(u,r,j,'fact_check_synthesis','OpenAI','fixture','succeeded','complete',current_date,'{"response_status":"completed","provider_response_id":"resp-old"}');
  select jsonb_agg(to_jsonb(t) order by id) into peers from public.restaurant_insight_jobs t where run_id=r and job_key<>'synthesis';
  select jsonb_agg(to_jsonb(t) order by id) into costs from public.restaurant_insight_cost_events t where run_id=r;
  -- Undefined function is deliberately NOT swallowed: expected pre-migration RED.
  perform pg_temp.reject(format('select public.restaurant_insight_regenerate_synthesis(%L,%L,%L,%L)',other_u,r,req,'resp-old'));
  perform pg_temp.reject(format('select public.restaurant_insight_regenerate_synthesis(%L,%L,%L,%L)',u,r,req,'stale'));
  update public.restaurant_insight_jobs set status='failed' where run_id=r and job_key='market';
  perform pg_temp.reject(format('select public.restaurant_insight_regenerate_synthesis(%L,%L,%L,%L)',u,r,req,'resp-old'));
  update public.restaurant_insight_jobs set status='done' where run_id=r and job_key='market';
  -- Malformed/partial outputs cannot turn a status marker into paid consent.
  for receipt in select value from jsonb_array_elements(jsonb_build_array(
    original #- '{synthesisDraft}',
    jsonb_set(original,'{synthesisDraft,responseStatus}','"in_progress"'),
    jsonb_set(original,'{synthesisDraft,text}','""'),
    jsonb_set(original,'{synthesisDraft,toolSources}','[42]'),
    jsonb_set(original,'{sourceRecovery,status}','"unchanged"')
  )) loop
    update public.restaurant_insight_jobs set output=receipt where id=j;
    perform pg_temp.reject(format('select public.restaurant_insight_regenerate_synthesis(%L,%L,%L,%L)',u,r,req,'resp-old'));
  end loop;
  update public.restaurant_insight_jobs set output=original where id=j;
  execute 'set local role service_role';
  receipt := public.restaurant_insight_regenerate_synthesis(u,r,req,'resp-old');
  execute 'reset role';
  g := (receipt->>'regenerationId')::uuid;
  perform pg_temp.check_true(receipt->>'status'='running' and receipt->>'replayed'='false','approval did not start');
  perform pg_temp.check_true((select jsonb_agg(to_jsonb(t) order by id) from public.restaurant_insight_jobs t where run_id=r and job_key<>'synthesis')=peers,'research changed');
  perform pg_temp.check_true((select jsonb_agg(to_jsonb(t) order by id) from public.restaurant_insight_cost_events t where run_id=r)=costs,'cost history changed');
  perform pg_temp.check_true((select previous_output from public.restaurant_insight_synthesis_regenerations where id=g)=original,'archive changed original');
  perform pg_temp.check_true((select status='pending' and max_attempts=attempts+1 and attempts=2 and lease_token is null and lease_until is null and dispatch_token_hash is null and dispatched_at is null and finished_at is null and output=jsonb_build_object('regenerationId',g,'requiredReportVersion',3,'regenerationFeedback','claimReviews[2].evidenceQuote: exact quotation mismatch') from public.restaurant_insight_jobs where id=j),'job reset/feedback/budget incorrect');
  perform pg_temp.check_true((select status='running' and deadline_at>now() and finished_at is null from public.restaurant_insight_runs where id=r),'deadline not renewed');
  replay := public.restaurant_insight_regenerate_synthesis(u,r,req,'resp-old');
  perform pg_temp.check_true(replay->>'regenerationId'=g::text and replay->>'replayed'='true','replay not idempotent');
  perform pg_temp.reject(format('select public.restaurant_insight_regenerate_synthesis(%L,%L,%L,%L)',u,r,gen_random_uuid(),'resp-old'));
  -- A single claimed execution exhausts the bounded lease budget even if a
  -- legacy worker mistakenly marks its failure retryable.
  update public.restaurant_insight_jobs set dispatch_token_hash=encode(extensions.digest(repeat('a',64),'sha256'),'hex'),dispatched_at=now() where id=j;
  receipt := public.restaurant_insight_claim_job(j,repeat('a',64));
  perform pg_temp.check_true(receipt#>>'{job,output,regenerationId}'=g::text,'claim lost server authorization');
  replay := public.restaurant_insight_finish_job(j,(receipt#>>'{job,lease_token}')::uuid,null,'unknown provider outcome',true);
  perform pg_temp.check_true(replay->>'status'='failed','one-shot failure automatically retried');
  perform pg_temp.check_true((select output->>'regenerationId'=g::text from public.restaurant_insight_jobs where id=j),'failed finish lost generation ID');
  execute 'set local role service_role';
  insert into public.restaurant_insight_cost_events(user_id,run_id,job_id,operation,provider,model,request_status,measurement_status,pricing_as_of,request_metadata)
    values(u,r,j,'fact_check_synthesis','OpenAI','fixture','unknown','unknown',current_date,jsonb_build_object('regeneration_id',g));
  perform pg_temp.reject(format('insert into public.restaurant_insight_cost_events(user_id,run_id,job_id,operation,provider,model,request_status,measurement_status,pricing_as_of,request_metadata) values(%L,%L,%L,''fact_check_synthesis'',''OpenAI'',''fixture'',''unknown'',''unknown'',current_date,%L)',u,r,j,jsonb_build_object('regeneration_id',g)));
  perform pg_temp.reject(format('update public.restaurant_insight_synthesis_regenerations set previous_output=''{}'' where id=%L',g));
  perform pg_temp.reject(format('delete from public.restaurant_insight_synthesis_regenerations where id=%L',g));
  execute 'reset role';
  perform set_config('request.jwt.claim.sub',u::text,true);
  execute 'set local role authenticated';
  perform pg_temp.check_true((select count(*)=1 from public.restaurant_insight_synthesis_regenerations),'owner archive unreadable');
  perform pg_temp.reject(format('select public.restaurant_insight_regenerate_synthesis(%L,%L,%L,%L)',u,r,req,'resp-old'));
  execute 'reset role';
  perform set_config('request.jwt.claim.sub',other_u::text,true);
  execute 'set local role authenticated';
  perform pg_temp.check_true((select count(*)=0 from public.restaurant_insight_synthesis_regenerations),'cross-owner archive exposed');
  execute 'reset role';
  execute 'set local role anon';
  perform pg_temp.reject(format('select public.restaurant_insight_regenerate_synthesis(%L,%L,%L,%L)',u,r,req,'resp-old'));
  execute 'reset role';
  update public.restaurant_insight_jobs set status='failed',output=jsonb_set(original,'{synthesisDraft,responseId}','"resp-new"') where id=j;
  update public.restaurant_insight_runs set status='failed' where id=r;
  replay := public.restaurant_insight_regenerate_synthesis(u,r,req,'resp-old');
  perform pg_temp.check_true(replay->>'regenerationId'=g::text,'replay charged later draft');
  perform pg_temp.reject(format('select public.restaurant_insight_regenerate_synthesis(%L,%L,%L,%L)',u,r,gen_random_uuid(),'resp-old'));
  update public.restaurant_insight_runs set report_deleted_at=now() where id=r;
  perform pg_temp.reject(format('select public.restaurant_insight_regenerate_synthesis(%L,%L,%L,%L)',u,r,gen_random_uuid(),'resp-new'));
  update public.restaurant_insight_runs set report_deleted_at=null where id=r;
  insert into public.restaurant_insight_reports(user_id,run_id,store_name,store_url,selected_sites,agents,critique,report)
    values(u,r,'fixture','https://example.test','[{}]','[]','fixture','fixture');
  perform pg_temp.reject(format('select public.restaurant_insight_regenerate_synthesis(%L,%L,%L,%L)',u,r,gen_random_uuid(),'resp-new'));
end $$;
rollback;
