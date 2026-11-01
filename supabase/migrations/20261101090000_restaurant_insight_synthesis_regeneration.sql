-- Explicit, revision-bound consent for one additional synthesis attempt only.
-- Existing research, paid-attempt history and all existing RPCs remain unchanged.
create table public.restaurant_insight_synthesis_regenerations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  run_id uuid not null references public.restaurant_insight_runs(id) on delete cascade,
  -- Archives survive all retries, but are removed by the existing permanent
  -- report-deletion path together with its job content (not ordinary trash).
  job_id uuid not null references public.restaurant_insight_jobs(id) on delete cascade,
  request_id uuid not null,
  previous_revision text not null check (char_length(previous_revision) between 1 and 500),
  previous_output jsonb not null check (jsonb_typeof(previous_output) = 'object'),
  previous_error text,
  previous_attempts integer not null,
  validation_feedback text not null,
  created_at timestamptz not null default now(),
  unique (user_id, request_id),
  unique (job_id, previous_revision)
);
alter table public.restaurant_insight_synthesis_regenerations enable row level security;
revoke all on public.restaurant_insight_synthesis_regenerations from public, anon, authenticated, service_role;
grant select on public.restaurant_insight_synthesis_regenerations to authenticated, service_role;
create policy restaurant_insight_synthesis_regenerations_select_own
  on public.restaurant_insight_synthesis_regenerations for select to authenticated
  using ((select auth.uid()) = user_id);

-- Write-before-send reservations must be unique even for concurrent/stale workers.
-- Unknown, partial and failed attempts all consume the same one-shot allowance.
create unique index restaurant_insight_synthesis_generation_one_attempt
  on public.restaurant_insight_cost_events(job_id, (request_metadata->>'regeneration_id'))
  where operation = 'fact_check_synthesis' and request_metadata->>'regeneration_id' is not null;

create function public.restaurant_insight_regenerate_synthesis(
  p_user_id uuid, p_run_id uuid, p_request_id uuid, p_expected_revision text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_run public.restaurant_insight_runs%rowtype;
  v_job public.restaurant_insight_jobs%rowtype;
  v_archive public.restaurant_insight_synthesis_regenerations%rowtype;
  v_draft jsonb;
  v_revision text;
  v_feedback text;
begin
  if p_user_id is null or p_run_id is null or p_request_id is null
    or p_expected_revision is null or char_length(p_expected_revision) not between 1 and 500
    or btrim(p_expected_revision) = '' then
    raise exception '追加費用の同意と対象の統合応答を確認してください。';
  end if;
  -- Match queue/retry serialization, then follow parent-before-child lock order.
  perform pg_advisory_xact_lock(hashtextextended('restaurant_insight_queue:' || p_user_id::text, 0));
  select * into v_run from public.restaurant_insight_runs where id=p_run_id and user_id=p_user_id for update;
  if not found or v_run.report_deleted_at is not null then raise exception '分析が見つかりません。'; end if;
  select * into v_job from public.restaurant_insight_jobs where run_id=p_run_id and job_key='synthesis' for update;
  if not found then raise exception '保存された統合工程が見つかりません。'; end if;
  -- A lost HTTP response can be retried after the job/report has advanced.
  -- Replays return the original grant, never reauthorize a newer draft.
  select * into v_archive from public.restaurant_insight_synthesis_regenerations where user_id=p_user_id and request_id=p_request_id;
  if found then
    if v_archive.run_id <> p_run_id or v_archive.previous_revision <> p_expected_revision then
      raise exception '同じリクエストIDを別の分析・応答には使用できません。';
    end if;
    return jsonb_build_object('status',v_run.status,'regenerationId',v_archive.id,'replayed',true);
  end if;
  if v_run.status <> 'failed' or v_job.status <> 'failed'
    or exists(select 1 from public.restaurant_insight_reports where run_id=p_run_id)
    or (select count(*) from public.restaurant_insight_jobs where run_id=p_run_id and job_key<>'synthesis' and status='done') <> 4
    or v_job.output#>>'{sourceRecovery,status}' is distinct from 'needs_review' then
    raise exception '完了済みの専門調査4件と、確認が必要な統合応答が必要です。';
  end if;
  if exists(select 1 from public.restaurant_insight_runs where user_id=p_user_id and id<>p_run_id and status='running' and deadline_at>now()) then
    raise exception '別の分析が進行中です。完了を待ってください。';
  end if;
  v_draft := case when v_job.output#>>'{synthesisDraft,version}'='1' then v_job.output->'synthesisDraft' else v_job.output end;
  v_revision := v_draft->>'responseId';
  if jsonb_typeof(v_draft) is distinct from 'object'
    or v_draft->>'responseStatus' is distinct from 'completed'
    or jsonb_typeof(v_draft->'text') is distinct from 'string' or btrim(v_draft->>'text')=''
    or jsonb_typeof(v_draft->'toolSources') is distinct from 'array'
    or jsonb_typeof(v_draft->'responseId') is distinct from 'string'
    or v_revision is distinct from p_expected_revision then
    raise exception '統合応答が変更されたか完了を確認できません。再読み込みして確認してください。';
  end if;
  if exists(select 1 from jsonb_array_elements(v_draft->'toolSources') s where jsonb_typeof(s) <> 'string') then
    raise exception '統合応答の出典記録を確認してください。';
  end if;
  if exists(select 1 from public.restaurant_insight_synthesis_regenerations where job_id=v_job.id and previous_revision=v_revision) then
    raise exception 'この統合応答の再生成は既に承認されています。同じリクエストIDで確認してください。';
  end if;
  v_feedback := coalesce(v_job.output#>>'{sourceRecovery,validationMessage}',v_job.error_message,v_run.error_message,'保存済み統合応答の検証に失敗しました。');
  insert into public.restaurant_insight_synthesis_regenerations(user_id,run_id,job_id,request_id,previous_revision,previous_output,previous_error,previous_attempts,validation_feedback)
    values(p_user_id,p_run_id,v_job.id,p_request_id,v_revision,v_job.output,v_job.error_message,v_job.attempts,v_feedback) returning * into v_archive;
  update public.restaurant_insight_jobs set status='pending',max_attempts=attempts+1,
    output=jsonb_build_object('regenerationId',v_archive.id,'requiredReportVersion',3,'regenerationFeedback',v_feedback),
    lease_token=null,lease_until=null,dispatch_token_hash=null,dispatched_at=null,
    next_attempt_at=now(),error_message=null,started_at=null,updated_at=now(),finished_at=null
    where id=v_job.id;
  update public.restaurant_insight_runs set status='running',progress_stage='checking',deadline_at=now()+interval '15 minutes',
    error_code=null,error_message=null,finished_at=null where id=p_run_id;
  return jsonb_build_object('status','running','regenerationId',v_archive.id,'replayed',false);
end;
$$;
revoke all on function public.restaurant_insight_regenerate_synthesis(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.restaurant_insight_regenerate_synthesis(uuid,uuid,uuid,text) to service_role;
