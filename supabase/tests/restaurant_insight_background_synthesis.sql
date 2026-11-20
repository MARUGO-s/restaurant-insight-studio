-- Run against isolated test PostgreSQL after the synthesis-continuations migration.
-- The dispatcher queues requests in pg_net, which only sends after commit. This test rolls back.
begin;
do $$
declare
  v_user uuid := gen_random_uuid();
  v_run uuid;
  v_job public.restaurant_insight_jobs%rowtype;
  v_synthesis uuid;
  v_cost uuid := gen_random_uuid();
  v_token text := encode(extensions.gen_random_bytes(32), 'hex');
  v_token_hash text := encode(extensions.digest(v_token, 'sha256'), 'hex');
  v_result jsonb;
  v_lease uuid;
  v_started timestamptz;
  v_max_attempts integer;
  v_output jsonb := '{"text":"preserved synthetic evidence","backgroundSynthesisPending":true,"backgroundSynthesis":{"responseId":"resp_fixture"}}';
  v_cost_before jsonb;
  v_deadline timestamptz;
  v_constraint text;
  v_dispatched integer;
begin
  if has_function_privilege('anon', 'public.restaurant_insight_defer_synthesis(uuid,uuid)', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.restaurant_insight_defer_synthesis(uuid,uuid)', 'EXECUTE')
    or not has_function_privilege('service_role', 'public.restaurant_insight_defer_synthesis(uuid,uuid)', 'EXECUTE')
    or has_function_privilege('anon', 'public.restaurant_insight_claim_job(uuid,text)', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.restaurant_insight_dispatch_jobs()', 'EXECUTE')
    or not has_function_privilege('service_role', 'public.restaurant_insight_claim_job(uuid,text)', 'EXECUTE')
    or not has_function_privilege('service_role', 'public.restaurant_insight_dispatch_jobs()', 'EXECUTE')
  then raise exception 'Worker RPC grants changed or are too broad'; end if;

  insert into auth.users(id) values(v_user);
  v_run := public.restaurant_insight_queue_run(v_user,
    '{"storeName":"Background SQL verification","storeUrl":"https://example.com","selectedSites":[{"id":"tabelog"}]}'::jsonb);
  select id, max_attempts into strict v_synthesis, v_max_attempts
    from public.restaurant_insight_jobs where run_id = v_run and job_key = 'synthesis';
  if v_max_attempts <> 4 then raise exception 'Astra continuation budget was not set'; end if;
  update public.restaurant_insight_jobs set status = 'done', attempts = 1
    where run_id = v_run and job_key <> 'synthesis';

  -- Research may use most of its window before the first claim of ordinary synthesis.
  update public.restaurant_insight_runs set deadline_at = now() + interval '2 minutes' where id = v_run;
  update public.restaurant_insight_jobs set dispatched_at = now(), dispatch_token_hash = v_token_hash where id = v_synthesis;
  v_result := public.restaurant_insight_claim_job(v_synthesis, v_token);
  v_lease := (v_result#>>'{job,lease_token}')::uuid;
  if v_lease is null or (v_result#>>'{job,attempts}')::integer is distinct from 1
    or (v_result#>>'{run,deadline_at}')::timestamptz is distinct from now() + interval '60 minutes'
  then raise exception 'First synthesis claim did not get its own 60-minute window'; end if;
  perform public.restaurant_insight_finish_job(v_synthesis, v_lease, null, 'simulated output limit', true);

  -- Claim the last permitted generation. Its subsequent polls must keep this attempt number.
  update public.restaurant_insight_runs set deadline_at = now() + interval '35 minutes'
    where id = v_run returning deadline_at into v_deadline;
  update public.restaurant_insight_jobs set attempts = max_attempts - 1,
    next_attempt_at = now(), dispatched_at = now(), dispatch_token_hash = v_token_hash
    where id = v_synthesis;
  v_result := public.restaurant_insight_claim_job(v_synthesis, v_token);
  v_lease := (v_result#>>'{job,lease_token}')::uuid;
  if v_lease is null or (v_result#>>'{job,attempts}')::integer is distinct from v_max_attempts
    or (v_result#>>'{run,deadline_at}')::timestamptz is distinct from v_deadline then
    raise exception 'Last generation changed its attempt or deadline';
  end if;
  update public.restaurant_insight_jobs set started_at = now() - interval '1 minute'
    where id = v_synthesis returning started_at into v_started;

  if public.restaurant_insight_defer_synthesis(v_synthesis, v_lease) then
    raise exception 'Uncheckpointed work was deferred';
  end if;
  perform public.restaurant_insight_checkpoint_job(v_synthesis, v_lease, '{"backgroundSynthesisPending":"true"}');
  if public.restaurant_insight_defer_synthesis(v_synthesis, v_lease) then
    raise exception 'A string was accepted as a polling marker';
  end if;
  if not public.restaurant_insight_checkpoint_job(v_synthesis, v_lease, v_output)
    or public.restaurant_insight_defer_synthesis(v_synthesis, gen_random_uuid())
  then raise exception 'Checkpoint or lease fencing failed'; end if;

  insert into public.restaurant_insight_cost_events(id,user_id,run_id,job_id,attempt_number,
    operation,provider,model,request_status,measurement_status,pricing_as_of,request_metadata)
  values(v_cost,v_user,v_run,v_synthesis,v_max_attempts,'fact_check_synthesis','OpenAI','fixture','unknown','unknown',current_date,
    '{"synthesis_background":true,"provider_response_id":"resp_fixture"}');
  select to_jsonb(c) into v_cost_before from public.restaurant_insight_cost_events c where c.id = v_cost;
  begin
    insert into public.restaurant_insight_cost_events(user_id,run_id,job_id,attempt_number,
      operation,provider,model,request_status,measurement_status,pricing_as_of,request_metadata)
    values(v_user,v_run,v_synthesis,v_max_attempts,'fact_check_synthesis','OpenAI','fixture','unknown','unknown',current_date,
      '{"synthesis_background":true}');
    raise exception 'A second background generation reservation was accepted';
  exception when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint is distinct from 'restaurant_insight_synthesis_background_attempt' then raise; end if;
  end;

  if not public.restaurant_insight_defer_synthesis(v_synthesis, v_lease) then
    raise exception 'Live lease could not defer background polling';
  end if;
  select * into strict v_job from public.restaurant_insight_jobs where id = v_synthesis;
  if v_job.status <> 'pending' or v_job.next_attempt_at < now() + interval '20 seconds'
    or v_job.lease_token is not null or v_job.lease_until is not null
    or v_job.dispatch_token_hash is not null or v_job.dispatched_at is not null or v_job.error_message is not null
    or v_job.attempts <> v_max_attempts or v_job.output is distinct from v_output
    or (select to_jsonb(c) from public.restaurant_insight_cost_events c where c.id = v_cost) is distinct from v_cost_before
  then raise exception 'Deferral altered checkpoints, metering, attempts, or timing'; end if;

  update public.restaurant_insight_jobs set dispatch_token_hash = v_token_hash, dispatched_at = now() where id = v_synthesis;
  if public.restaurant_insight_claim_job(v_synthesis, v_token) is not null then
    raise exception 'Polling happened before its scheduled time';
  end if;
  update public.restaurant_insight_jobs set next_attempt_at = now(), dispatched_at = null, dispatch_token_hash = null
    where id = v_synthesis;
  v_dispatched := public.restaurant_insight_dispatch_jobs();
  if v_dispatched <> 1
    or not exists (select 1 from public.restaurant_insight_jobs
      where id = v_synthesis and dispatched_at is not null and dispatch_token_hash is not null)
  then raise exception 'Poll at the generation limit was not dispatched (total: %)', v_dispatched; end if;

  update public.restaurant_insight_jobs set dispatch_token_hash = v_token_hash where id = v_synthesis;
  v_result := public.restaurant_insight_claim_job(v_synthesis, v_token);
  if (v_result#>>'{job,attempts}')::integer is distinct from v_max_attempts
    or (v_result#>>'{run,deadline_at}')::timestamptz is distinct from v_deadline
    or (v_result#>>'{job,started_at}')::timestamptz is distinct from v_started
    or (v_result#>>'{job,lease_token}')::uuid is not distinct from v_lease
    or public.restaurant_insight_defer_synthesis(v_synthesis, v_lease)
  then raise exception 'Poll did not keep the generation attempt or acquire a new lease'; end if;
  v_lease := (v_result#>>'{job,lease_token}')::uuid;

  -- An interrupted poll recovers at the generation cap. The run deadline is still enforced.
  update public.restaurant_insight_jobs set lease_until = now() - interval '1 second' where id = v_synthesis;
  if public.restaurant_insight_defer_synthesis(v_synthesis, v_lease) then raise exception 'Expired lease deferred a poll'; end if;
  perform public.restaurant_insight_dispatch_jobs();
  select * into strict v_job from public.restaurant_insight_jobs where id = v_synthesis;
  if v_job.status <> 'pending' or v_job.attempts <> v_max_attempts or v_job.lease_token is not null
    or v_job.next_attempt_at < now() + interval '20 seconds' or v_job.output is distinct from v_output
    or v_job.error_message is not null
  then raise exception 'Poll did not recover from lease loss at the generation limit'; end if;

  update public.restaurant_insight_jobs set next_attempt_at = now(), dispatched_at = now(),
    dispatch_token_hash = v_token_hash where id = v_synthesis;
  v_result := public.restaurant_insight_claim_job(v_synthesis, v_token);
  v_lease := (v_result#>>'{job,lease_token}')::uuid;
  if v_lease is null then raise exception 'Recovered poll could not be claimed'; end if;
  update public.restaurant_insight_runs set deadline_at = now() - interval '1 second'
    where id = v_run returning deadline_at into v_deadline;
  if public.restaurant_insight_defer_synthesis(v_synthesis, v_lease) then raise exception 'Overdue run deferred a poll'; end if;
  update public.restaurant_insight_jobs set lease_until = now() - interval '1 second' where id = v_synthesis;
  perform public.restaurant_insight_dispatch_jobs();
  if not exists (select 1 from public.restaurant_insight_runs
    where id = v_run and status = 'failed' and error_code = 'analysis_deadline' and deadline_at = v_deadline)
    or not exists (select 1 from public.restaurant_insight_jobs where id = v_synthesis and status = 'failed' and output = v_output)
  then raise exception 'Expired run did not stop with its checkpoint intact'; end if;

  -- Reopening a deadline-expired run keeps polling the saved response and leaves completed research untouched.
  v_result := public.restaurant_insight_retry_run(v_run, v_user);
  if (v_result->>'reset_jobs')::integer is distinct from 1 then raise exception 'Retry reset completed stages'; end if;
  update public.restaurant_insight_jobs set dispatched_at = now(), dispatch_token_hash = v_token_hash where id = v_synthesis;
  v_result := public.restaurant_insight_claim_job(v_synthesis, v_token);
  if (v_result#>>'{job,attempts}')::integer is distinct from v_max_attempts or v_result#>'{job,output}' is distinct from v_output
  then raise exception 'Manual retry lost the original generation or its response'; end if;
  v_result := public.restaurant_insight_finish_job(v_synthesis, (v_result#>>'{job,lease_token}')::uuid,
    '{"backgroundSynthesisPending":false,"report_row":{"store_name":"Background SQL verification","store_url":"https://example.com","selected_sites":[{"id":"tabelog"}],"agents":[],"critique":"verified","report":"test report"}}',
    null, false);
  if v_result->>'status' is distinct from 'done'
    or not exists (select 1 from public.restaurant_insight_runs where id = v_run and status = 'done')
    or (select count(*) from public.restaurant_insight_jobs where run_id = v_run and job_key <> 'synthesis' and status = 'done' and attempts = 1) <> 4
    or not exists (select 1 from public.restaurant_insight_cost_events where id = v_cost and report_id = (v_result->>'report_id')::uuid)
  then raise exception 'Resumed poll did not finalize the report and link the original cost'; end if;
  raise notice 'PASS: polling leases and deadlines, generation accounting, private RPCs and unique cost reservation';
end;
$$;
rollback;
