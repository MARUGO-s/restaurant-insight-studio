-- Durable, app-isolated research jobs. No provider/API credential is stored here.
-- The worker endpoint must validate the single-use dispatch token through claim_job.
create extension if not exists pg_cron;
create extension if not exists pg_net;

alter table public.restaurant_insight_runs
  add column input jsonb not null default '{}'::jsonb check (jsonb_typeof(input) = 'object'),
  add column deadline_at timestamptz not null default (now() + interval '45 minutes');

create table public.restaurant_insight_jobs (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.restaurant_insight_runs(id) on delete cascade,
  job_key text not null check (job_key in ('market', 'gourmet', 'social_recent', 'social_history', 'synthesis')),
  status text not null default 'pending' check (status in ('pending', 'running', 'done', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 3 check (max_attempts > 0),
  lease_until timestamptz,
  lease_token uuid,
  next_attempt_at timestamptz not null default now(),
  output jsonb not null default '{}'::jsonb check (jsonb_typeof(output) = 'object'),
  error_message text check (error_message is null or char_length(error_message) <= 2000),
  dispatch_token_hash text,
  dispatched_at timestamptz,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  updated_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (run_id, job_key),
  check (attempts <= max_attempts),
  check (status <> 'running' or (lease_until is not null and lease_token is not null))
);
create index restaurant_insight_jobs_pending on public.restaurant_insight_jobs (next_attempt_at)
  where status = 'pending';
create index restaurant_insight_jobs_leases on public.restaurant_insight_jobs (lease_until)
  where status = 'running';
alter table public.restaurant_insight_jobs enable row level security;
revoke all on public.restaurant_insight_jobs from public, anon, authenticated;
grant select, insert, update, delete on public.restaurant_insight_jobs to service_role;

-- Runs can no longer be reset/enqueued directly by a browser. The authenticated
-- API verifies the user, then uses service-role-only RPCs below.
revoke insert, update, delete on public.restaurant_insight_runs from public, anon, authenticated;
-- A client-created report could otherwise counterfeit a completed durable run.
revoke insert, update, delete on public.restaurant_insight_reports from public, anon, authenticated;
grant select, insert, update on public.restaurant_insight_runs to service_role;
grant select, insert on public.restaurant_insight_reports to service_role;
alter table public.restaurant_insight_cost_events
  add column job_id uuid references public.restaurant_insight_jobs(id) on delete set null,
  add column attempt_number integer check (attempt_number is null or attempt_number > 0),
  add column request_metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(request_metadata) = 'object');
create index restaurant_insight_cost_events_job on public.restaurant_insight_cost_events(job_id, attempt_number)
  where job_id is not null;
grant select, insert, update on public.restaurant_insight_cost_events to service_role;

-- Call only while holding the parent run lock. Completed research is never removed.
create function public.restaurant_insight_refresh_run(p_run_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_run public.restaurant_insight_runs%rowtype;
  v_message text;
begin
  select * into v_run from public.restaurant_insight_runs where id = p_run_id for update;
  if not found or v_run.status <> 'running' then return; end if;
  if exists (select 1 from public.restaurant_insight_reports where run_id = p_run_id) then
    update public.restaurant_insight_runs set status = 'done', progress_stage = 'done',
      error_code = null, error_message = null, finished_at = coalesce(finished_at, now()) where id = p_run_id;
    return;
  end if;
  if v_run.deadline_at <= now() then
    update public.restaurant_insight_jobs set status = 'failed', dispatch_token_hash = null,
      error_message = '調査全体の待機上限に達しました。保存済みの結果から再開できます。',
      updated_at = now(), finished_at = now()
      where run_id = p_run_id and status = 'pending';
    update public.restaurant_insight_runs set status = 'failed', progress_stage = 'failed',
      error_code = 'analysis_deadline', error_message = '調査全体の待機上限に達しました。取得済みの調査は保存されています。未完了の調査から再開できます。',
      finished_at = now() where id = p_run_id;
    return;
  end if;
  -- Let peer research finish and checkpoint before presenting the terminal error.
  if exists (select 1 from public.restaurant_insight_jobs where run_id = p_run_id and job_key <> 'synthesis' and status in ('pending', 'running')) then
    update public.restaurant_insight_runs set progress_stage = 'researching' where id = p_run_id;
    return;
  end if;
  select error_message into v_message from public.restaurant_insight_jobs
    where run_id = p_run_id and status = 'failed' order by updated_at desc limit 1;
  if found then
    update public.restaurant_insight_jobs set status = 'failed', dispatch_token_hash = null,
      error_message = coalesce(error_message, '必要な専門調査が未完了です。取得済みの調査は保存されています。'),
      updated_at = now(), finished_at = now()
      where run_id = p_run_id and job_key = 'synthesis' and status = 'pending';
    update public.restaurant_insight_runs set status = 'failed', progress_stage = 'failed',
      error_code = 'job_failed', error_message = left(coalesce(v_message, '調査が未完了です。取得済みの結果から再開できます。'), 2000),
      finished_at = now() where id = p_run_id;
  else
    update public.restaurant_insight_runs set progress_stage = 'checking' where id = p_run_id;
  end if;
end;
$$;

create function public.restaurant_insight_queue_run(p_user_id uuid, p_input jsonb)
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
    select v_run_id, key, case when key = 'synthesis' then 2 else 3 end
    from unnest(array['market', 'gourmet', 'social_recent', 'social_history', 'synthesis']) as keys(key);
  return v_run_id;
end;
$$;

create function public.restaurant_insight_claim_job(p_job_id uuid, p_dispatch_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_run_id uuid;
  v_run public.restaurant_insight_runs%rowtype;
  v_job public.restaurant_insight_jobs%rowtype;
begin
  if p_dispatch_token is null or p_dispatch_token !~ '^[0-9a-f]{64}$' then return null; end if;
  select run_id into v_run_id from public.restaurant_insight_jobs where id = p_job_id;
  if not found then return null; end if;
  select * into v_run from public.restaurant_insight_runs where id = v_run_id for update;
  select * into v_job from public.restaurant_insight_jobs where id = p_job_id for update;
  if v_run.status <> 'running' or v_run.deadline_at <= now() or v_job.status <> 'pending'
    or v_job.attempts >= v_job.max_attempts or v_job.next_attempt_at > now()
    or v_job.dispatched_at is null or v_job.dispatched_at <= now() - interval '120 seconds'
    or v_job.dispatch_token_hash is null
    or v_job.dispatch_token_hash <> encode(extensions.digest(p_dispatch_token, 'sha256'), 'hex')
  then return null; end if;
  if v_job.job_key = 'synthesis' and
    (select count(*) from public.restaurant_insight_jobs where run_id = v_run_id and job_key <> 'synthesis' and status = 'done') <> 4
  then return null; end if;
  update public.restaurant_insight_jobs set status = 'running', attempts = attempts + 1,
    lease_token = gen_random_uuid(), lease_until = now() + interval '360 seconds',
    dispatch_token_hash = null, started_at = now(), updated_at = now(), finished_at = null
    where id = p_job_id returning * into v_job;
  update public.restaurant_insight_runs set progress_stage = case when v_job.job_key = 'synthesis' then 'checking' else 'researching' end
    where id = v_run_id returning * into v_run;
  return jsonb_build_object('job', to_jsonb(v_job) - 'dispatch_token_hash', 'run', to_jsonb(v_run));
end;
$$;

create function public.restaurant_insight_checkpoint_job(p_job_id uuid, p_lease_token uuid, p_output jsonb)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if p_output is null or jsonb_typeof(p_output) <> 'object' then return false; end if;
  update public.restaurant_insight_jobs set output = output ||
      (case when coalesce(p_output->>'text', '') = '' and coalesce(output->>'text', '') <> '' then p_output - 'text' else p_output end) ||
      (case when (p_output->'sources' is null or p_output->'sources' = '[]'::jsonb) and output->'sources' is not null
        then jsonb_build_object('sources', output->'sources') else '{}'::jsonb end),
    updated_at = now()
    where id = p_job_id and status = 'running' and lease_token = p_lease_token;
  return found;
end;
$$;

create function public.restaurant_insight_finish_job(
  p_job_id uuid, p_lease_token uuid, p_output jsonb, p_error text, p_retryable boolean default true
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_run_id uuid;
  v_run public.restaurant_insight_runs%rowtype;
  v_job public.restaurant_insight_jobs%rowtype;
  v_report jsonb;
  v_report_id uuid;
  v_output jsonb;
begin
  select run_id into v_run_id from public.restaurant_insight_jobs where id = p_job_id;
  if not found then return jsonb_build_object('accepted', false, 'reason', 'not_found'); end if;
  select * into v_run from public.restaurant_insight_runs where id = v_run_id for update;
  select * into v_job from public.restaurant_insight_jobs where id = p_job_id for update;
  if v_job.status <> 'running' or v_job.lease_token is distinct from p_lease_token then
    return jsonb_build_object('accepted', false, 'reason', 'stale_lease', 'status', v_job.status);
  end if;
  if p_output is not null and jsonb_typeof(p_output) <> 'object' then raise exception 'Job output must be an object'; end if;
  v_output := v_job.output || coalesce(p_output, '{}'::jsonb);
  -- An empty retry response must not erase a checkpoint from a previous attempt.
  if coalesce(v_output->>'text', '') = '' and coalesce(v_job.output->>'text', '') <> '' then
    v_output := jsonb_set(v_output, '{text}', v_job.output->'text');
  end if;
  if (v_output->'sources' is null or v_output->'sources' = '[]'::jsonb) and v_job.output->'sources' is not null then
    v_output := jsonb_set(v_output, '{sources}', v_job.output->'sources');
  end if;
  if nullif(p_error, '') is null then
    if v_job.job_key = 'synthesis' then
      v_report := v_output->'report_row';
      if v_report is null or jsonb_typeof(v_report) <> 'object' then raise exception 'Synthesis report_row is missing'; end if;
      insert into public.restaurant_insight_reports(user_id, run_id, store_name, store_url, group_name,
        selected_sites, agents, critique, critique_sources, report, report_sources)
      values (v_run.user_id, v_run.id, v_report->>'store_name', v_report->>'store_url', nullif(v_report->>'group_name', ''),
        v_report->'selected_sites', v_report->'agents', v_report->>'critique',
        coalesce(v_report->'critique_sources', '[]'::jsonb), v_report->>'report', coalesce(v_report->'report_sources', '[]'::jsonb))
      on conflict (run_id) do nothing returning id into v_report_id;
      if v_report_id is null then select id into v_report_id from public.restaurant_insight_reports where run_id = v_run_id; end if;
      update public.restaurant_insight_cost_events set report_id = v_report_id where run_id = v_run_id and report_id is null;
      update public.restaurant_insight_runs set status = 'done', progress_stage = 'done',
        error_code = null, error_message = null, finished_at = now() where id = v_run_id;
    end if;
    update public.restaurant_insight_jobs set status = 'done', output = v_output, error_message = null,
      lease_token = null, lease_until = null, dispatch_token_hash = null, updated_at = now(), finished_at = now()
      where id = p_job_id;
  else
    update public.restaurant_insight_jobs set
      status = case when p_retryable and attempts < max_attempts and v_run.status = 'running' and v_run.deadline_at > now() then 'pending' else 'failed' end,
      output = v_output, error_message = left(p_error, 2000), lease_token = null, lease_until = null,
      dispatch_token_hash = null, dispatched_at = null, next_attempt_at = now() + interval '20 seconds',
      updated_at = now(), finished_at = case when p_retryable and attempts < max_attempts and v_run.status = 'running' and v_run.deadline_at > now() then null else now() end
      where id = p_job_id;
  end if;
  perform public.restaurant_insight_refresh_run(v_run_id);
  select * into v_job from public.restaurant_insight_jobs where id = p_job_id;
  return jsonb_build_object('accepted', true, 'status', v_job.status, 'report_id', v_report_id);
end;
$$;

create function public.restaurant_insight_retry_run(p_run_id uuid, p_user_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_run public.restaurant_insight_runs%rowtype; v_count integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('restaurant_insight_queue:' || p_user_id::text, 0));
  select * into v_run from public.restaurant_insight_runs where id = p_run_id and user_id = p_user_id for update;
  if not found then raise exception '分析が見つかりません。'; end if;
  if v_run.status = 'done' then return jsonb_build_object('status', 'done', 'reset_jobs', 0); end if;
  if v_run.status <> 'failed' then return jsonb_build_object('status', v_run.status, 'reset_jobs', 0); end if;
  if not exists (select 1 from public.restaurant_insight_jobs where run_id = p_run_id) then
    raise exception 'この分析は旧方式で実行されています。新規分析を開始してください。';
  end if;
  if exists (select 1 from public.restaurant_insight_runs where user_id = p_user_id and id <> p_run_id and status = 'running' and deadline_at > now()) then
    raise exception '別の分析が進行中です。完了を待ってから再開してください。';
  end if;
  update public.restaurant_insight_jobs set status = 'pending', max_attempts = attempts + 3,
    lease_token = null, lease_until = null, dispatch_token_hash = null, dispatched_at = null,
    next_attempt_at = now(), error_message = null, updated_at = now(), finished_at = null
    where run_id = p_run_id and status = 'failed';
  get diagnostics v_count = row_count;
  update public.restaurant_insight_runs set status = 'running', progress_stage = 'queued',
    deadline_at = now() + interval '45 minutes', error_code = null, error_message = null, finished_at = null
    where id = p_run_id;
  perform public.restaurant_insight_refresh_run(p_run_id);
  return jsonb_build_object('status', 'running', 'reset_jobs', v_count);
end;
$$;

create function public.restaurant_insight_dispatch_jobs()
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
      status = case when attempts < max_attempts and v_run.status = 'running' and v_run.deadline_at > now() then 'pending' else 'failed' end,
      lease_token = null, lease_until = null, dispatch_token_hash = null, dispatched_at = null,
      next_attempt_at = now() + interval '20 seconds', updated_at = now(),
      error_message = '処理の実行枠が終了しました。途中結果は保存されています。',
      finished_at = case when attempts < max_attempts and v_run.status = 'running' and v_run.deadline_at > now() then null else now() end
      where run_id = v_run.id and status = 'running' and lease_until <= now();
    perform public.restaurant_insight_refresh_run(v_run.id);
    if not exists (select 1 from public.restaurant_insight_runs where id = v_run.id and status = 'running') then continue; end if;
    for v_job in select j.* from public.restaurant_insight_jobs j
      where j.run_id = v_run.id and j.status = 'pending' and j.attempts < j.max_attempts and j.next_attempt_at <= now()
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

revoke all on function public.restaurant_insight_refresh_run(uuid) from public, anon, authenticated;
revoke all on function public.restaurant_insight_queue_run(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.restaurant_insight_claim_job(uuid, text) from public, anon, authenticated;
revoke all on function public.restaurant_insight_checkpoint_job(uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.restaurant_insight_finish_job(uuid, uuid, jsonb, text, boolean) from public, anon, authenticated;
revoke all on function public.restaurant_insight_retry_run(uuid, uuid) from public, anon, authenticated;
revoke all on function public.restaurant_insight_dispatch_jobs() from public, anon, authenticated;
grant execute on function public.restaurant_insight_refresh_run(uuid) to service_role;
grant execute on function public.restaurant_insight_queue_run(uuid, jsonb) to service_role;
grant execute on function public.restaurant_insight_claim_job(uuid, text) to service_role;
grant execute on function public.restaurant_insight_checkpoint_job(uuid, uuid, jsonb) to service_role;
grant execute on function public.restaurant_insight_finish_job(uuid, uuid, jsonb, text, boolean) to service_role;
grant execute on function public.restaurant_insight_retry_run(uuid, uuid) to service_role;
grant execute on function public.restaurant_insight_dispatch_jobs() to service_role;

select cron.schedule('restaurant-insight-durable-dispatch', '* * * * *',
  'select public.restaurant_insight_dispatch_jobs();');
