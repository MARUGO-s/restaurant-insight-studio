-- Give a new synthesis its own time window and room to finish a capped response.
-- These replacements preserve the RPCs' existing grants and service-only callers.
create or replace function public.restaurant_insight_queue_run(p_user_id uuid, p_input jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_run_id uuid;
begin
  if p_user_id is null or p_input is null or jsonb_typeof(p_input) <> 'object'
    or char_length(coalesce(p_input->>'storeName', '')) not between 1 and 120
    or char_length(coalesce(p_input->>'storeUrl', '')) not between 8 and 600
    or jsonb_typeof(p_input->'selectedSites') is distinct from 'array'
  then raise exception '店舗の分析条件が不正です。'; end if;
  if jsonb_array_length(p_input->'selectedSites') not between 1 and 12 then
    raise exception '分析するグルメサイトを選択してください。';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('restaurant_insight_queue:' || p_user_id::text, 0));
  if (select count(*) from public.restaurant_insight_runs where user_id = p_user_id and started_at > now() - interval '1 hour') >= 10 then
    raise exception '新規分析は1時間あたり10回までです。保存済みの分析は未完了の調査から再開できます。';
  end if;
  if exists (select 1 from public.restaurant_insight_runs where user_id = p_user_id and status = 'running' and deadline_at > now()) then
    raise exception '進行中の分析があります。完了を待ってから新しい分析を開始してください。';
  end if;
  insert into public.restaurant_insight_runs(user_id, input, deadline_at)
    values (p_user_id, p_input, now() + interval '45 minutes') returning id into v_run_id;
  insert into public.restaurant_insight_jobs(run_id, job_key, max_attempts)
    select v_run_id, key, case when key = 'synthesis' then 4 else 3 end
    from unnest(array['market', 'gourmet', 'social_recent', 'social_history', 'synthesis']) as keys(key);
  return v_run_id;
end;
$$;

create or replace function public.restaurant_insight_claim_job(p_job_id uuid, p_dispatch_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_run_id uuid;
  v_run public.restaurant_insight_runs%rowtype;
  v_job public.restaurant_insight_jobs%rowtype;
  v_poll boolean;
  v_first_synthesis boolean;
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
  -- Polls, continuations, and separately authorized regenerations retain their deadline.
  v_first_synthesis := v_job.job_key = 'synthesis' and v_job.attempts = 0
    and not v_poll and not (v_job.output ? 'regenerationId');
  update public.restaurant_insight_jobs set status = 'running',
    attempts = case when v_poll then attempts else attempts + 1 end,
    lease_token = gen_random_uuid(), lease_until = now() + interval '360 seconds',
    dispatch_token_hash = null, started_at = case when v_poll then started_at else now() end,
    updated_at = now(), finished_at = null
    where id = p_job_id returning * into v_job;
  update public.restaurant_insight_runs set
    progress_stage = case when v_job.job_key = 'synthesis' then 'checking' else 'researching' end,
    deadline_at = case when v_first_synthesis then now() + interval '60 minutes' else deadline_at end
    where id = v_run_id returning * into v_run;
  return jsonb_build_object('job', to_jsonb(v_job) - 'dispatch_token_hash', 'run', to_jsonb(v_run));
end;
$$;
