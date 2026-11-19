-- Recheck an existing OpenAI response without spending another generation attempt.
-- The checkpoint marker is written by the synthesis worker before submitting the response.
-- Replacing the existing dispatcher and claim functions preserves their service-only grants.

-- Reserve one provider submission per generation attempt, even across lease loss.
create unique index restaurant_insight_synthesis_background_attempt
  on public.restaurant_insight_cost_events(job_id, attempt_number)
  where operation = 'fact_check_synthesis' and request_metadata->>'synthesis_background' = 'true';

create or replace function public.restaurant_insight_claim_job(p_job_id uuid, p_dispatch_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_run_id uuid;
  v_run public.restaurant_insight_runs%rowtype;
  v_job public.restaurant_insight_jobs%rowtype;
  v_poll boolean;
begin
  if p_dispatch_token is null or p_dispatch_token !~ '^[0-9a-f]{64}$' then return null; end if;
  select run_id into v_run_id from public.restaurant_insight_jobs where id = p_job_id;
  if not found then return null; end if;
  select * into v_run from public.restaurant_insight_runs where id = v_run_id for update;
  select * into v_job from public.restaurant_insight_jobs where id = p_job_id for update;
  if not found then return null; end if;
  v_poll := v_job.job_key = 'synthesis' and v_job.output @> '{"backgroundSynthesisPending":true}'::jsonb;
  if v_run.status <> 'running' or v_run.deadline_at <= now() or v_job.status <> 'pending'
    or (not v_poll and v_job.attempts >= v_job.max_attempts) or v_job.next_attempt_at > now()
    or v_job.dispatched_at is null or v_job.dispatched_at <= now() - interval '120 seconds'
    or v_job.dispatch_token_hash is null
    or v_job.dispatch_token_hash <> encode(extensions.digest(p_dispatch_token, 'sha256'), 'hex')
  then return null; end if;
  if v_job.job_key = 'synthesis' and
    (select count(*) from public.restaurant_insight_jobs where run_id = v_run_id and job_key <> 'synthesis' and status = 'done') <> 4
  then return null; end if;
  update public.restaurant_insight_jobs set status = 'running',
    attempts = case when v_poll then attempts else attempts + 1 end,
    lease_token = gen_random_uuid(), lease_until = now() + interval '360 seconds',
    dispatch_token_hash = null, started_at = case when v_poll then started_at else now() end,
    updated_at = now(), finished_at = null
    where id = p_job_id returning * into v_job;
  update public.restaurant_insight_runs set progress_stage = case when v_job.job_key = 'synthesis' then 'checking' else 'researching' end
    where id = v_run_id returning * into v_run;
  return jsonb_build_object('job', to_jsonb(v_job) - 'dispatch_token_hash', 'run', to_jsonb(v_run));
end;
$$;

create or replace function public.restaurant_insight_dispatch_jobs()
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_run public.restaurant_insight_runs%rowtype;
  v_job public.restaurant_insight_jobs%rowtype;
  v_token text;
  v_dispatched integer := 0;
begin
  if not pg_try_advisory_xact_lock(hashtextextended('restaurant_insight_dispatch', 0)) then return 0; end if;
  for v_run in select r.* from public.restaurant_insight_runs r
    where (r.status = 'running' or exists (select 1 from public.restaurant_insight_jobs j where j.run_id = r.id and j.status = 'running'))
      and exists (select 1 from public.restaurant_insight_jobs j where j.run_id = r.id)
    order by r.started_at for update skip locked
  loop
    update public.restaurant_insight_jobs set
      status = case when (attempts < max_attempts or (job_key = 'synthesis' and output @> '{"backgroundSynthesisPending":true}'::jsonb))
          and v_run.status = 'running' and v_run.deadline_at > now() then 'pending' else 'failed' end,
      lease_token = null, lease_until = null, dispatch_token_hash = null, dispatched_at = null,
      next_attempt_at = now() + interval '20 seconds', updated_at = now(),
      error_message = case
        when job_key = 'synthesis' and output @> '{"backgroundSynthesisPending":true}'::jsonb
          and v_run.status = 'running' and v_run.deadline_at > now() then null
        else '処理の実行枠が終了しました。途中結果は保存されています。' end,
      finished_at = case when (attempts < max_attempts or (job_key = 'synthesis' and output @> '{"backgroundSynthesisPending":true}'::jsonb))
          and v_run.status = 'running' and v_run.deadline_at > now() then null else now() end
      where run_id = v_run.id and status = 'running' and lease_until <= now();
    perform public.restaurant_insight_refresh_run(v_run.id);
    if not exists (select 1 from public.restaurant_insight_runs where id = v_run.id and status = 'running') then continue; end if;
    for v_job in select j.* from public.restaurant_insight_jobs j
      where j.run_id = v_run.id and j.status = 'pending' and j.next_attempt_at <= now()
        and (j.attempts < j.max_attempts or (j.job_key = 'synthesis' and j.output @> '{"backgroundSynthesisPending":true}'::jsonb))
        and (j.dispatched_at is null or j.dispatched_at <= now() - interval '120 seconds')
        and (j.job_key <> 'synthesis' or (select count(*) from public.restaurant_insight_jobs d where d.run_id = v_run.id and d.job_key <> 'synthesis' and d.status = 'done') = 4)
      order by j.created_at, j.job_key for update skip locked
    loop
      -- The unhashed token lives only in this transaction and the short-lived
      -- pg_net delivery queue. It authorizes one specific job, never another run.
      v_token := encode(extensions.gen_random_bytes(32), 'hex');
      update public.restaurant_insight_jobs set dispatch_token_hash = encode(extensions.digest(v_token, 'sha256'), 'hex'),
        dispatched_at = now(), updated_at = now() where id = v_job.id;
      perform net.http_post(
        url := 'https://ycsqfajidusuibqljjwr.supabase.co/functions/v1/restaurant-analysis-worker',
        body := jsonb_build_object('jobId', v_job.id, 'dispatchToken', v_token),
        headers := '{"Content-Type":"application/json"}'::jsonb,
        timeout_milliseconds := 10000);
      v_dispatched := v_dispatched + 1;
    end loop;
  end loop;
  return v_dispatched;
end;
$$;

-- Only an active lease can reschedule an already checkpointed synthesis poll.
create function public.restaurant_insight_defer_synthesis(p_job_id uuid, p_lease_token uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_run_id uuid;
  v_run public.restaurant_insight_runs%rowtype;
  v_job public.restaurant_insight_jobs%rowtype;
  v_now timestamptz;
begin
  select run_id into v_run_id from public.restaurant_insight_jobs where id = p_job_id and job_key = 'synthesis';
  if not found then return false; end if;
  select * into v_run from public.restaurant_insight_runs where id = v_run_id for update;
  if not found then return false; end if;
  select * into v_job from public.restaurant_insight_jobs where id = p_job_id for update;
  if not found then return false; end if;

  v_now := clock_timestamp();
  if v_run.status <> 'running' or v_run.deadline_at <= v_now
    or v_job.status <> 'running' or v_job.lease_until <= v_now or v_job.lease_token is distinct from p_lease_token
    or not (v_job.output @> '{"backgroundSynthesisPending":true}'::jsonb)
  then return false; end if;

  update public.restaurant_insight_jobs set status = 'pending',
    lease_token = null, lease_until = null, dispatch_token_hash = null, dispatched_at = null,
    next_attempt_at = greatest(next_attempt_at, v_now + interval '20 seconds'),
    error_message = null, updated_at = v_now, finished_at = null
    where id = p_job_id;
  return true;
end;
$$;

revoke all on function public.restaurant_insight_defer_synthesis(uuid, uuid) from public, anon, authenticated;
grant execute on function public.restaurant_insight_defer_synthesis(uuid, uuid) to service_role;
