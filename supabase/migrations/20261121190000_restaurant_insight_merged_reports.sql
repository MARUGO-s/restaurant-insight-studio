-- Personal merged reports (source = 'merged') and a single-job merge run.

ALTER TABLE public.restaurant_insight_reports
  DROP CONSTRAINT IF EXISTS restaurant_insight_reports_source_check;

ALTER TABLE public.restaurant_insight_reports
  ADD CONSTRAINT restaurant_insight_reports_source_check
  CHECK (source IN ('insight_studio', 'gourmet_checker', 'merged'));

ALTER TABLE public.restaurant_insight_reports
  ADD COLUMN IF NOT EXISTS source_report_ids uuid[];

ALTER TABLE public.restaurant_insight_reports
  DROP CONSTRAINT IF EXISTS restaurant_insight_reports_source_report_ids_check;

ALTER TABLE public.restaurant_insight_reports
  ADD CONSTRAINT restaurant_insight_reports_source_report_ids_check
  CHECK (
    (source = 'merged' AND source_report_ids IS NOT NULL AND cardinality(source_report_ids) BETWEEN 2 AND 8)
    OR (source IS DISTINCT FROM 'merged' AND source_report_ids IS NULL)
  );

COMMENT ON COLUMN public.restaurant_insight_reports.source_report_ids IS
  'Source report IDs when source = merged. Visibility remains owner-only via user_id.';

ALTER TABLE public.restaurant_insight_jobs
  DROP CONSTRAINT IF EXISTS restaurant_insight_jobs_job_key_check;

ALTER TABLE public.restaurant_insight_jobs
  ADD CONSTRAINT restaurant_insight_jobs_job_key_check
  CHECK (job_key = ANY (ARRAY['market', 'gourmet', 'social_recent', 'social_history', 'synthesis', 'merge_reports']));

CREATE OR REPLACE FUNCTION public.restaurant_insight_queue_merge_run(p_user_id uuid, p_input jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_run_id uuid;
begin
  if p_user_id is null or p_input is null or jsonb_typeof(p_input) <> 'object'
    or coalesce(p_input->>'mode', '') is distinct from 'merge'
    or char_length(coalesce(p_input->>'storeName', '')) not between 1 and 120
    or char_length(coalesce(p_input->>'storeUrl', '')) not between 8 and 600
    or jsonb_typeof(p_input->'selectedSites') is distinct from 'array'
    or jsonb_typeof(p_input->'reportIds') is distinct from 'array'
  then raise exception '統合するレポートの指定が不正です。'; end if;
  if jsonb_array_length(p_input->'selectedSites') not between 1 and 12 then
    raise exception '統合元レポートの調査媒体を確認できません。';
  end if;
  if jsonb_array_length(p_input->'reportIds') not between 2 and 8 then
    raise exception '統合するレポートを2件以上選んでください。';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('restaurant_insight_queue:' || p_user_id::text, 0));
  if (select count(*) from public.restaurant_insight_runs where user_id = p_user_id and started_at > now() - interval '1 hour') >= 10 then
    raise exception '新規分析は1時間あたり10回までです。保存済みの分析は未完了の調査から再開できます。';
  end if;
  if exists (select 1 from public.restaurant_insight_runs where user_id = p_user_id and status = 'running' and deadline_at > now()) then
    raise exception '進行中の分析があります。完了を待ってから新しい統合を開始してください。';
  end if;
  insert into public.restaurant_insight_runs(user_id, input, deadline_at)
    values (p_user_id, p_input, now() + interval '45 minutes') returning id into v_run_id;
  insert into public.restaurant_insight_jobs(run_id, job_key, max_attempts)
    values (v_run_id, 'merge_reports', 4);
  return v_run_id;
end;
$function$;

REVOKE ALL ON FUNCTION public.restaurant_insight_queue_merge_run(uuid, jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.restaurant_insight_queue_merge_run(uuid, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.restaurant_insight_finish_job(p_job_id uuid, p_lease_token uuid, p_output jsonb, p_error text, p_retryable boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_run_id uuid;
  v_run public.restaurant_insight_runs%rowtype;
  v_job public.restaurant_insight_jobs%rowtype;
  v_report jsonb;
  v_report_id uuid;
  v_output jsonb;
  v_source text;
  v_source_ids uuid[];
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
  if coalesce(v_output->>'text', '') = '' and coalesce(v_job.output->>'text', '') <> '' then
    v_output := jsonb_set(v_output, '{text}', v_job.output->'text');
  end if;
  if (v_output->'sources' is null or v_output->'sources' = '[]'::jsonb) and v_job.output->'sources' is not null then
    v_output := jsonb_set(v_output, '{sources}', v_job.output->'sources');
  end if;
  if nullif(p_error, '') is null then
    if v_job.job_key in ('synthesis', 'merge_reports') then
      v_report := v_output->'report_row';
      if v_report is null or jsonb_typeof(v_report) <> 'object' then raise exception 'Synthesis report_row is missing'; end if;
      v_source := coalesce(nullif(v_report->>'source', ''), 'insight_studio');
      if v_report->'source_report_ids' is not null and jsonb_typeof(v_report->'source_report_ids') = 'array' then
        v_source_ids := array(select jsonb_array_elements_text(v_report->'source_report_ids')::uuid);
      else
        v_source_ids := null;
      end if;
      insert into public.restaurant_insight_reports(user_id, run_id, store_name, store_url, group_name,
        selected_sites, agents, critique, critique_sources, report, report_sources, source, source_report_ids)
      values (v_run.user_id, v_run.id, v_report->>'store_name', v_report->>'store_url', nullif(v_report->>'group_name', ''),
        v_report->'selected_sites', v_report->'agents', v_report->>'critique',
        coalesce(v_report->'critique_sources', '[]'::jsonb), v_report->>'report', coalesce(v_report->'report_sources', '[]'::jsonb),
        v_source, v_source_ids)
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
$function$;

CREATE OR REPLACE FUNCTION public.restaurant_insight_dispatch_jobs()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
      status = case when (attempts < max_attempts or (job_key in ('synthesis', 'merge_reports') and output @> '{"backgroundSynthesisPending":true}'::jsonb))
          and v_run.status = 'running' and v_run.deadline_at > now() then 'pending' else 'failed' end,
      lease_token = null, lease_until = null, dispatch_token_hash = null, dispatched_at = null,
      next_attempt_at = now() + interval '20 seconds', updated_at = now(),
      error_message = case
        when job_key in ('synthesis', 'merge_reports') and output @> '{"backgroundSynthesisPending":true}'::jsonb
          and v_run.status = 'running' and v_run.deadline_at > now() then null
        else '処理の実行枠が終了しました。途中結果は保存されています。' end,
      finished_at = case when (attempts < max_attempts or (job_key in ('synthesis', 'merge_reports') and output @> '{"backgroundSynthesisPending":true}'::jsonb))
          and v_run.status = 'running' and v_run.deadline_at > now() then null else now() end
      where run_id = v_run.id and status = 'running' and lease_until <= now();
    perform public.restaurant_insight_refresh_run(v_run.id);
    if not exists (select 1 from public.restaurant_insight_runs where id = v_run.id and status = 'running') then continue; end if;
    for v_job in select j.* from public.restaurant_insight_jobs j
      where j.run_id = v_run.id and j.status = 'pending' and j.next_attempt_at <= now()
        and (j.attempts < j.max_attempts or (j.job_key in ('synthesis', 'merge_reports') and j.output @> '{"backgroundSynthesisPending":true}'::jsonb))
        and (j.dispatched_at is null or j.dispatched_at <= now() - interval '120 seconds')
        and (j.job_key <> 'synthesis' or (select count(*) from public.restaurant_insight_jobs d where d.run_id = v_run.id and d.job_key <> 'synthesis' and d.status = 'done') = 4)
      order by j.created_at, j.job_key for update skip locked
    loop
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
$function$;

CREATE OR REPLACE FUNCTION public.restaurant_insight_claim_job(p_job_id uuid, p_dispatch_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_run_id uuid;
  v_run public.restaurant_insight_runs%rowtype;
  v_job public.restaurant_insight_jobs%rowtype;
  v_poll boolean;
  v_first_long boolean;
begin
  if p_dispatch_token is null or p_dispatch_token !~ '^[0-9a-f]{64}$' then return null; end if;
  select run_id into v_run_id from public.restaurant_insight_jobs where id = p_job_id;
  if not found then return null; end if;
  select * into v_run from public.restaurant_insight_runs where id = v_run_id for update;
  select * into v_job from public.restaurant_insight_jobs where id = p_job_id for update;
  if not found then return null; end if;
  v_poll := v_job.job_key in ('synthesis', 'merge_reports') and v_job.output @> '{"backgroundSynthesisPending":true}'::jsonb;
  if v_run.status <> 'running' or v_run.deadline_at <= now() or v_job.status <> 'pending'
    or (not v_poll and v_job.attempts >= v_job.max_attempts) or v_job.next_attempt_at > now()
    or v_job.dispatched_at is null or v_job.dispatched_at <= now() - interval '120 seconds'
    or v_job.dispatch_token_hash is null
    or v_job.dispatch_token_hash <> encode(extensions.digest(p_dispatch_token, 'sha256'), 'hex')
  then return null; end if;
  if v_job.job_key = 'synthesis' and
    (select count(*) from public.restaurant_insight_jobs where run_id = v_run_id and job_key <> 'synthesis' and status = 'done') <> 4
  then return null; end if;
  v_first_long := v_job.job_key in ('synthesis', 'merge_reports') and v_job.attempts = 0
    and not v_poll and not (v_job.output ? 'regenerationId');
  update public.restaurant_insight_jobs set status = 'running',
    attempts = case when v_poll then attempts else attempts + 1 end,
    lease_token = gen_random_uuid(), lease_until = now() + interval '360 seconds',
    dispatch_token_hash = null, started_at = case when v_poll then started_at else now() end,
    updated_at = now(), finished_at = null
    where id = p_job_id returning * into v_job;
  update public.restaurant_insight_runs set
    progress_stage = case when v_job.job_key in ('synthesis', 'merge_reports') then 'checking' else 'researching' end,
    deadline_at = case when v_first_long then now() + interval '60 minutes' else deadline_at end
    where id = v_run_id returning * into v_run;
  return jsonb_build_object('job', to_jsonb(v_job) - 'dispatch_token_hash', 'run', to_jsonb(v_run));
end;
$function$;

CREATE OR REPLACE FUNCTION public.restaurant_insight_defer_synthesis(p_job_id uuid, p_lease_token uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_run_id uuid;
  v_run public.restaurant_insight_runs%rowtype;
  v_job public.restaurant_insight_jobs%rowtype;
  v_now timestamptz;
begin
  select run_id into v_run_id from public.restaurant_insight_jobs
    where id = p_job_id and job_key in ('synthesis', 'merge_reports');
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
$function$;
