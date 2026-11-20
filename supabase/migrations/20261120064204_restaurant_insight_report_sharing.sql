-- A report remains private until its owner explicitly creates a share link.
-- Tokens are retrievable by the owner so the same active link can be copied later.
create table public.restaurant_insight_report_shares (
  report_id uuid primary key references public.restaurant_insight_reports(id) on delete cascade,
  token text not null unique check (token ~ '^[0-9a-f]{64}$')
);
alter table public.restaurant_insight_report_shares enable row level security;
revoke all on public.restaurant_insight_report_shares from public, anon, authenticated;
grant select, insert, delete on public.restaurant_insight_report_shares to service_role;

create function public.restaurant_insight_manage_report_share(
  p_user_id uuid, p_report_id uuid, p_action text, p_token text default null
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_token text;
begin
  if p_action is null or p_action not in ('status', 'create', 'revoke') then
    raise exception 'Invalid report share action';
  end if;

  -- Match the transaction lock taken by the existing trash/restore/delete RPC.
  -- The link manager needs no write privilege on the report itself.
  perform pg_advisory_xact_lock(hashtextextended('restaurant_insight_report:' || p_report_id::text, 0));
  perform 1 from public.restaurant_insight_reports
    where id = p_report_id and user_id = p_user_id and deleted_at is null;
  if not found then return null; end if;

  if p_action = 'create' then
    insert into public.restaurant_insight_report_shares(report_id, token) values (p_report_id, p_token)
      on conflict (report_id) do nothing;
  elsif p_action = 'revoke' then
    delete from public.restaurant_insight_report_shares where report_id = p_report_id;
  end if;

  select token into v_token from public.restaurant_insight_report_shares where report_id = p_report_id;
  return jsonb_build_object('token', v_token);
end;
$$;
revoke all on function public.restaurant_insight_manage_report_share(uuid,uuid,text,text) from public, anon, authenticated;
grant execute on function public.restaurant_insight_manage_report_share(uuid,uuid,text,text) to service_role;

create function public.restaurant_insight_read_report_share(p_token text)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object('storeName', r.store_name, 'createdAt', r.created_at, 'report', r.report, 'reportSources', r.report_sources)
  from public.restaurant_insight_report_shares s
  join public.restaurant_insight_reports r on r.id = s.report_id
  where s.token = p_token and r.deleted_at is null;
$$;
revoke all on function public.restaurant_insight_read_report_share(text) from public, anon, authenticated;
grant execute on function public.restaurant_insight_read_report_share(text) to service_role;

-- Restoring a report does not reactivate a previously shared link.
create function public.restaurant_insight_revoke_trashed_report_share()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  delete from public.restaurant_insight_report_shares where report_id = new.id;
  return new;
end;
$$;
revoke all on function public.restaurant_insight_revoke_trashed_report_share() from public, anon, authenticated;

create trigger restaurant_insight_revoke_trashed_report_share
  after update of deleted_at on public.restaurant_insight_reports
  for each row when (old.deleted_at is null and new.deleted_at is not null)
  execute function public.restaurant_insight_revoke_trashed_report_share();
