-- Transaction-local fixtures only, with no production publication or provider calls.
begin;
do $$
begin
  if has_table_privilege('anon', 'public.restaurant_insight_report_shares', 'SELECT')
    or has_table_privilege('authenticated', 'public.restaurant_insight_report_shares', 'SELECT')
    or has_function_privilege('anon', 'public.restaurant_insight_read_report_share(text)', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.restaurant_insight_read_report_share(text)', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.restaurant_insight_manage_report_share(uuid,uuid,text,text)', 'EXECUTE')
  then raise exception 'Share tokens or RPCs are exposed directly'; end if;
end;
$$;

insert into auth.users(id) values ('4257d73b-e8f4-48a7-a868-0e2191671929'), ('94c9562f-c7a3-4a2b-a1e9-f049e16c547a');
insert into public.restaurant_insight_reports(id, user_id, store_name, store_url, selected_sites, agents, critique, report, report_sources)
values ('dce913cd-908a-415a-8032-c33cf561f9f7', '4257d73b-e8f4-48a7-a868-0e2191671929', '共有テスト店', 'https://example.test/store',
  '[{"id":"tabelog"}]', '[{"text":"private expert draft"}]', 'private critique', '統合レポート', '["https://example.test/source"]');

set local role service_role;
do $$
declare
  v_owner uuid := '4257d73b-e8f4-48a7-a868-0e2191671929';
  v_other uuid := '94c9562f-c7a3-4a2b-a1e9-f049e16c547a';
  v_report uuid := 'dce913cd-908a-415a-8032-c33cf561f9f7';
  v_old_token text := repeat('a', 64);
  v_new_token text := repeat('b', 64);
  v_action text;
  v_value jsonb;
begin
  if public.restaurant_insight_manage_report_share(v_owner,v_report,'status') is distinct from '{"token":null}'::jsonb
  then raise exception 'New report must have no share'; end if;
  foreach v_action in array array['status','create','revoke'] loop
    if public.restaurant_insight_manage_report_share(v_other,v_report,v_action,v_new_token) is not null
    then raise exception 'Another owner accessed share settings'; end if;
  end loop;
  if public.restaurant_insight_manage_report_share(v_owner,v_report,'create',v_old_token)->>'token' is distinct from v_old_token
  then raise exception 'Share creation did not return the token'; end if;
  if public.restaurant_insight_manage_report_share(v_owner,v_report,'create',v_new_token)->>'token' is distinct from v_old_token
    or public.restaurant_insight_read_report_share(v_new_token) is not null
  then raise exception 'Create or repeat-create generated incorrect share state'; end if;

  v_value := public.restaurant_insight_read_report_share(v_old_token);
  if v_value->>'storeName' is distinct from '共有テスト店' or v_value->>'report' is distinct from '統合レポート'
    or (select count(*) from jsonb_object_keys(v_value)) <> 4 or not (v_value ?& array['createdAt','reportSources'])
  then raise exception 'Shared report is missing or contains private columns'; end if;

  if public.restaurant_insight_manage_report_share(v_other,v_report,'revoke') is not null
    or public.restaurant_insight_read_report_share(v_old_token) is null
  then raise exception 'Another owner revoked share'; end if;
  if public.restaurant_insight_manage_report_share(v_owner,v_report,'revoke') is distinct from '{"token":null}'::jsonb
  then raise exception 'Revocation did not return empty state'; end if;
  if public.restaurant_insight_read_report_share(v_old_token) is not null
  then raise exception 'Revocation did not remove the share'; end if;

  perform public.restaurant_insight_manage_report_share(v_owner,v_report,'create',v_new_token);
  perform public.restaurant_insight_manage_report(v_owner,v_report,'trash',false);
  if public.restaurant_insight_read_report_share(v_new_token) is not null
    or public.restaurant_insight_manage_report_share(v_owner,v_report,'create',v_old_token) is not null
  then raise exception 'Trashed report still permits sharing'; end if;
  perform public.restaurant_insight_manage_report(v_owner,v_report,'restore',false);
  if public.restaurant_insight_read_report_share(v_new_token) is not null
    or public.restaurant_insight_manage_report_share(v_owner,v_report,'status') is distinct from '{"token":null}'::jsonb
  then raise exception 'Restoring report reactivated its old share'; end if;
end;
$$;
reset role;
rollback;
