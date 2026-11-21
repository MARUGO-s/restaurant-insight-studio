-- Allow questions on shared checker reports, and block trash/restore/delete of those rows.
-- SECURITY DEFINER RPCs bypass RLS, so this guard is required.

CREATE OR REPLACE FUNCTION public.restaurant_insight_save_followup(p_user_id uuid, p_report_id uuid, p_question text, p_answer text, p_sources jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_report public.restaurant_insight_reports%rowtype; v_row public.restaurant_insight_followups%rowtype;
begin
  select * into v_report from public.restaurant_insight_reports
    where id = p_report_id
      and deleted_at is null
      and (user_id = p_user_id or source = 'gourmet_checker')
    for update;
  if not found then raise exception 'レポートがゴミ箱へ移動または削除されたため、回答を保存できませんでした。API利用量は料金画面で確認できます。'; end if;
  insert into public.restaurant_insight_followups(report_id,user_id,question,answer,sources)
    values(p_report_id,p_user_id,p_question,p_answer,p_sources) returning * into v_row;
  return to_jsonb(v_row);
end;
$function$;

CREATE OR REPLACE FUNCTION public.restaurant_insight_manage_report(p_user_id uuid, p_report_id uuid, p_action text, p_confirm boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_report public.restaurant_insight_reports%rowtype;
  v_run_id uuid;
  v_deleted timestamptz;
begin
  if p_user_id is null or p_report_id is null or p_action not in ('trash', 'restore', 'delete') or p_action is null then
    raise exception 'レポートの操作を確認してください。';
  end if;
  if p_action = 'delete' and p_confirm is distinct from true then
    raise exception '完全削除の確認が必要です。';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('restaurant_insight_report:' || p_report_id::text, 0));
  select * into v_report from public.restaurant_insight_reports where id = p_report_id;
  if not found then
    if p_action = 'delete' and exists (select 1 from public.restaurant_insight_report_deletions where id = p_report_id and user_id = p_user_id) then
      return jsonb_build_object('deleted', true, 'reportId', p_report_id);
    end if;
    raise exception 'レポートが見つかりません。';
  end if;
  if v_report.source = 'gourmet_checker' then
    raise exception '共有レポートはゴミ箱へ移動したり削除したりできません。';
  end if;
  if v_report.user_id is distinct from p_user_id then
    if p_action = 'delete' and exists (select 1 from public.restaurant_insight_report_deletions where id = p_report_id and user_id = p_user_id) then
      return jsonb_build_object('deleted', true, 'reportId', p_report_id);
    end if;
    raise exception 'レポートが見つかりません。';
  end if;
  v_run_id := v_report.run_id;
  if v_run_id is not null then
    perform 1 from public.restaurant_insight_runs where id = v_run_id and user_id = p_user_id for update;
    if not found then raise exception 'レポートの実行情報を確認できません。'; end if;
  end if;
  select * into v_report from public.restaurant_insight_reports where id = p_report_id and user_id = p_user_id for update;
  if not found then raise exception 'レポートが見つかりません。'; end if;
  if p_action = 'trash' then
    update public.restaurant_insight_reports set deleted_at = coalesce(deleted_at, now()) where id = p_report_id
      returning * into v_report;
    return jsonb_build_object('report_row', to_jsonb(v_report));
  elsif p_action = 'restore' then
    update public.restaurant_insight_reports set deleted_at = null where id = p_report_id returning * into v_report;
    return jsonb_build_object('report_row', to_jsonb(v_report));
  end if;
  if v_report.deleted_at is null then raise exception '先にレポートをゴミ箱へ移動してください。'; end if;
  v_deleted := now();
  insert into public.restaurant_insight_report_deletions(id, user_id, run_id, deleted_at)
    values (p_report_id, p_user_id, v_report.run_id, v_deleted);
  update public.restaurant_insight_cost_events set
    report_name = v_report.store_name, report_created_at = v_report.created_at, report_deleted_at = v_deleted
    where user_id = p_user_id and (report_id = p_report_id or (v_report.run_id is not null and run_id = v_report.run_id));
  if v_report.run_id is not null then
    delete from public.restaurant_insight_jobs where run_id = v_report.run_id;
    update public.restaurant_insight_runs set input = '{}'::jsonb, report_deleted_at = v_deleted,
      status = 'done', progress_stage = 'done', error_code = null, error_message = null,
      finished_at = coalesce(finished_at, v_deleted)
      where id = v_report.run_id and user_id = p_user_id;
  end if;
  delete from public.restaurant_insight_reports where id = p_report_id and user_id = p_user_id;
  return jsonb_build_object('deleted', true, 'reportId', p_report_id);
end;
$function$;
