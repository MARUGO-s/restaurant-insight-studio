-- Run after the durable-jobs migration. All fixtures and effects are rolled back.
-- No dispatcher call and no external API request are made by this verification.
begin;
do $$
declare
  v_user uuid := gen_random_uuid();
  v_run uuid;
  v_job uuid;
  v_market uuid;
  v_gourmet uuid;
  v_recent uuid;
  v_history uuid;
  v_synthesis uuid;
  v_lease uuid;
  v_token text := encode(extensions.gen_random_bytes(32), 'hex');
  v_result jsonb;
  v_saved jsonb;
  v_key text;
  v_report_id uuid;
begin
  if has_function_privilege('anon', 'public.restaurant_insight_claim_job(uuid,text)', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.restaurant_insight_queue_run(uuid,jsonb)', 'EXECUTE')
    or has_table_privilege('authenticated', 'public.restaurant_insight_jobs', 'SELECT')
    or has_table_privilege('authenticated', 'public.restaurant_insight_reports', 'INSERT')
    or has_table_privilege('authenticated', 'public.restaurant_insight_runs', 'UPDATE')
  then raise exception 'Service-only grants are not restricted'; end if;
  -- Synthetic auth identity is transaction-local and has no email or password.
  insert into auth.users(id) values (v_user);
  v_run := public.restaurant_insight_queue_run(v_user, '{"storeName":"SQL verification","storeUrl":"https://example.com","selectedSites":[{"id":"tabelog","name":"食べログ"}]}'::jsonb);
  if (select count(*) from public.restaurant_insight_jobs where run_id = v_run) <> 5 then
    raise exception 'Queue did not atomically create five jobs';
  end if;
  select id into v_market from public.restaurant_insight_jobs where run_id = v_run and job_key = 'market';
  select id into v_gourmet from public.restaurant_insight_jobs where run_id = v_run and job_key = 'gourmet';
  select id into v_recent from public.restaurant_insight_jobs where run_id = v_run and job_key = 'social_recent';
  select id into v_history from public.restaurant_insight_jobs where run_id = v_run and job_key = 'social_history';
  select id into v_synthesis from public.restaurant_insight_jobs where run_id = v_run and job_key = 'synthesis';

  update public.restaurant_insight_jobs set dispatch_token_hash = encode(extensions.digest(v_token, 'sha256'), 'hex'), dispatched_at = now()
    where id in (v_market, v_synthesis);
  if public.restaurant_insight_claim_job(v_synthesis, v_token) is not null then raise exception 'Synthesis bypassed research dependencies'; end if;
  if public.restaurant_insight_claim_job(v_market, repeat('0', 64)) is not null then raise exception 'Invalid token was accepted'; end if;
  v_result := public.restaurant_insight_claim_job(v_market, v_token);
  if v_result is null or (v_result#>>'{job,attempts}')::integer <> 1 or v_result#>>'{job,started_at}' is null then
    raise exception 'First claim failed';
  end if;
  v_lease := (v_result#>>'{job,lease_token}')::uuid;
  if public.restaurant_insight_claim_job(v_market, v_token) is not null then raise exception 'Dispatch token was replayed'; end if;
  if not public.restaurant_insight_checkpoint_job(v_market, v_lease, '{"text":"retained research","sources":["https://example.com/source"]}'::jsonb) then
    raise exception 'Checkpoint failed';
  end if;
  v_result := public.restaurant_insight_finish_job(v_market, gen_random_uuid(), '{}'::jsonb, null, true);
  if (v_result->>'accepted')::boolean then raise exception 'Stale lease finalized job'; end if;
  if public.restaurant_insight_checkpoint_job(v_market, gen_random_uuid(), '{"text":"stale overwrite"}'::jsonb) then
    raise exception 'Stale lease changed checkpoint';
  end if;
  v_result := public.restaurant_insight_finish_job(v_market, v_lease, '{"text":"","sources":[]}'::jsonb, 'simulated timeout', true);
  select output into v_saved from public.restaurant_insight_jobs where id = v_market;
  if v_result->>'status' <> 'pending' or v_saved->>'text' <> 'retained research' or v_saved->'sources' <> '["https://example.com/source"]'::jsonb then
    raise exception 'Failure erased checkpoint or did not queue retry';
  end if;

  update public.restaurant_insight_jobs set next_attempt_at = now(),
    dispatch_token_hash = encode(extensions.digest(v_token, 'sha256'), 'hex'), dispatched_at = now()
    where id = v_market;
  v_result := public.restaurant_insight_claim_job(v_market, v_token);
  if (v_result#>>'{job,attempts}')::integer <> 2 or v_result#>>'{job,output,text}' <> 'retained research' then
    raise exception 'Retry lost attempt accounting or checkpoint';
  end if;
  v_lease := (v_result#>>'{job,lease_token}')::uuid;
  perform public.restaurant_insight_checkpoint_job(v_market, v_lease, '{"text":"","sources":[]}'::jsonb);
  select output into v_saved from public.restaurant_insight_jobs where id = v_market;
  if v_saved->>'text' <> 'retained research' or v_saved->'sources' <> '["https://example.com/source"]'::jsonb then
    raise exception 'Empty retry checkpoint erased existing evidence';
  end if;
  perform public.restaurant_insight_finish_job(v_market, v_lease, '{"text":"completed market","sources":["https://example.com/source"]}'::jsonb, null, true);

  -- Complete peers, with one deliberate non-retryable research failure.
  foreach v_key in array array['gourmet', 'social_recent', 'social_history'] loop
    select id into v_job from public.restaurant_insight_jobs where run_id = v_run and job_key = v_key;
    update public.restaurant_insight_jobs set dispatch_token_hash = encode(extensions.digest(v_token, 'sha256'), 'hex'), dispatched_at = now() where id = v_job;
    v_result := public.restaurant_insight_claim_job(v_job, v_token);
    if v_result is null then raise exception 'Peer % was stopped before completion', v_key; end if;
    v_lease := (v_result#>>'{job,lease_token}')::uuid;
    perform public.restaurant_insight_finish_job(v_job, v_lease, jsonb_build_object('text', v_key || ' preserved'),
      case when v_key = 'social_recent' then 'simulated provider unavailable' else null end, false);
  end loop;
  if (select status from public.restaurant_insight_runs where id = v_run) <> 'failed'
    or (select status from public.restaurant_insight_jobs where id = v_synthesis) <> 'failed'
  then raise exception 'Exhausted dependency did not fail the run and block synthesis'; end if;
  v_result := public.restaurant_insight_retry_run(v_run, v_user);
  if (v_result->>'reset_jobs')::integer <> 2 then raise exception 'Retry did not reset only failed stages'; end if;
  if (select status from public.restaurant_insight_jobs where id = v_market) <> 'done'
    or (select attempts from public.restaurant_insight_jobs where id = v_market) <> 2
    or (select status from public.restaurant_insight_jobs where id = v_gourmet) <> 'done'
    or (select output->>'text' from public.restaurant_insight_jobs where id = v_recent) <> 'social_recent preserved'
    or (select max_attempts - attempts from public.restaurant_insight_jobs where id = v_recent) <> 3
  then raise exception 'Manual retry changed completed peers, evidence, or retry budget'; end if;
  if public.restaurant_insight_claim_job(v_market, v_token) is not null then raise exception 'Completed peer was rerun'; end if;
  v_result := public.restaurant_insight_retry_run(v_run, v_user);
  if (v_result->>'reset_jobs')::integer <> 0 then raise exception 'Running retry was not idempotent'; end if;

  update public.restaurant_insight_jobs set dispatch_token_hash = encode(extensions.digest(v_token, 'sha256'), 'hex'), dispatched_at = now() where id = v_recent;
  v_result := public.restaurant_insight_claim_job(v_recent, v_token);
  perform public.restaurant_insight_finish_job(v_recent, (v_result#>>'{job,lease_token}')::uuid,
    '{"text":"completed recent"}'::jsonb, null, true);
  update public.restaurant_insight_jobs set dispatch_token_hash = encode(extensions.digest(v_token, 'sha256'), 'hex'), dispatched_at = now() where id = v_synthesis;
  v_result := public.restaurant_insight_claim_job(v_synthesis, v_token);
  if v_result is null then raise exception 'Ready synthesis was not claimable'; end if;
  v_lease := (v_result#>>'{job,lease_token}')::uuid;
  v_result := public.restaurant_insight_finish_job(v_synthesis, v_lease,
    '{"report_row":{"store_name":"SQL verification","store_url":"https://example.com","selected_sites":[{"id":"tabelog"}],"agents":[],"critique":"test critique","report":"test report"}}'::jsonb,
    null, true);
  v_report_id := (v_result->>'report_id')::uuid;
  if v_report_id is null or (select status from public.restaurant_insight_runs where id = v_run) <> 'done'
    or (select count(*) from public.restaurant_insight_reports where run_id = v_run) <> 1
  then raise exception 'Synthesis was not atomically finalized'; end if;
  v_result := public.restaurant_insight_finish_job(v_synthesis, v_lease, '{}'::jsonb, null, true);
  if (v_result->>'accepted')::boolean or (select count(*) from public.restaurant_insight_reports where run_id = v_run) <> 1 then
    raise exception 'Duplicate synthesis completion created another report';
  end if;
  raise notice 'PASS: private grants, atomic queue, one-use claims, lease fencing, saved checkpoints, bounded retries, successful peer preservation, synthesis dependencies, atomic finalization, duplicate protection';
end;
$$;
rollback;
