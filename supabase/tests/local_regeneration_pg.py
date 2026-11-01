"""Offline migration regression: installed PostgreSQL image, local Docker only.
Usage: python3 supabase/tests/local_regeneration_pg.py [--baseline]
No production config, sockets, volumes, ports or credentials are used.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]
ENDPOINT = subprocess.check_output(["docker", "context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"], text=True).strip()
ENDPOINT = json.loads(ENDPOINT)
if not ENDPOINT.startswith("unix:///"):
    raise SystemExit("Refusing nonlocal Docker endpoint")
ENV = {k: v for k, v in os.environ.items() if k not in {"DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"}}
DOCKER = ["docker", "--host", ENDPOINT]
NAME = "ris-regeneration-test-" + uuid.uuid4().hex[:12]

def docker(*args, input=None, check=True):
    result = subprocess.run([*DOCKER, *args], input=input, text=True, capture_output=True, env=ENV)
    if check and result.returncode:
        raise RuntimeError(result.stdout + result.stderr)
    return result

def sql(text):
    return docker("exec", "-i", NAME, "psql", "-U", "postgres", "-X", "-v", "ON_ERROR_STOP=1", "-At", input=text).stdout

def wait_for(predicate, message):
    for _ in range(200):
        if predicate():
            return
        time.sleep(.025)
    raise AssertionError(message)

def psql_process(app):
    return subprocess.Popen([*DOCKER, "exec", "-i", "-e", "PGAPPNAME=" + app, NAME,
                             "psql", "-U", "postgres", "-X", "-qAt", "-v", "ON_ERROR_STOP=1"],
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=ENV)

def concurrency_checks():
    for same_request in [True, False]:
        u, r, j, req1 = [str(uuid.uuid4()) for _ in range(4)]
        req2 = req1 if same_request else str(uuid.uuid4())
        sql(f"""
          insert into auth.users(id) values('{u}');
          insert into public.restaurant_insight_runs(id,user_id,status,input) values('{r}','{u}','failed','{{}}');
          insert into public.restaurant_insight_jobs(run_id,job_key,status) select '{r}',k,'done' from unnest(array['market','gourmet','social_recent','social_history']) k;
          insert into public.restaurant_insight_jobs(id,run_id,job_key,status,output) values('{j}','{r}','synthesis','failed',
          '{{"responseStatus":"completed","responseId":"resp-lock","text":"raw","toolSources":[],"sourceRecovery":{{"status":"needs_review"}}}}');
        """)
        holder = psql_process("ris-holder")
        workers = []
        try:
            holder.stdin.write(f"begin; select id from public.restaurant_insight_runs where id='{r}' for update;\n")
            holder.stdin.flush()
            wait_for(lambda: sql("select count(*) from pg_stat_activity where application_name='ris-holder' and state='idle in transaction'").strip() == "1", "holder did not acquire parent lock")
            for i, req in enumerate([req1, req2]):
                worker = psql_process("ris-worker-" + str(i))
                workers.append(worker)
                worker.stdin.write(f"set role service_role; select public.restaurant_insight_regenerate_synthesis('{u}','{r}','{req}','resp-lock');\n")
                worker.stdin.close()
                worker.stdin = None
            wait_for(lambda: sql("select count(*) from pg_stat_activity where application_name like 'ris-worker-%' and wait_event_type='Lock'").strip() == "2", "competing approvals did not block deterministically")
            holder.communicate("commit;\n", timeout=10)
            outputs = [worker.communicate(timeout=10) for worker in workers]
            successes = [json.loads(out.strip()) for worker, (out, err) in zip(workers, outputs) if worker.returncode == 0]
            assert len(successes) == (2 if same_request else 1), outputs
            assert len({value['regenerationId'] for value in successes}) == 1
            if same_request:
                assert sorted(value['replayed'] for value in successes) == [False, True]
            assert sql(f"select count(*) from public.restaurant_insight_synthesis_regenerations where run_id='{r}'").strip() == "1"
            assert sql(f"select max_attempts-attempts from public.restaurant_insight_jobs where id='{j}'").strip() == "1"
            sql(f"update public.restaurant_insight_runs set status='failed' where id='{r}'")
        finally:
            for process in [holder, *workers]:
                if process.poll() is None:
                    process.kill()
                    process.communicate(timeout=10)
    print("PASS: competing same/different consent requests serialize behind parent lock")

attempted = False
try:
    attempted = True
    docker("run", "--pull=never", "--name", NAME, "--network=none", "--tmpfs", "/var/lib/postgresql/data", "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "-d", "postgres:17")
    for _ in range(100):
        initialized = "PostgreSQL init process complete; ready for start up." in docker("logs", NAME).stdout
        if initialized and docker("exec", NAME, "pg_isready", "-U", "postgres", check=False).returncode == 0:
            break
        time.sleep(.1)
    else:
        raise RuntimeError("Disposable PostgreSQL did not become ready")
    sql("""
      create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      grant usage on schema auth to authenticated,service_role;
      create schema extensions; create extension pgcrypto with schema extensions;
      create schema cron; create function cron.schedule(text,text,text) returns bigint language sql as $$ select 1::bigint $$;
      create schema net; create table net.http_request_queue(id bigint); create table net._http_response(id bigint);
      create function net.http_post(url text, body jsonb, headers jsonb, timeout_milliseconds int) returns bigint language plpgsql as $$ begin raise exception 'network forbidden in local SQL harness'; end $$;
    """)
    for file in sorted((ROOT / "supabase/migrations").glob("*.sql")):
        if "synthesis_regeneration" in file.name:
            continue
        text = file.read_text().replace("create extension if not exists pg_cron;", "").replace("create extension if not exists pg_net;", "")
        sql(text)
    legacy_user, legacy_run = str(uuid.uuid4()), str(uuid.uuid4())
    sql(f"""
      insert into auth.users(id) values('{legacy_user}');
      insert into public.restaurant_insight_runs(id,user_id,status,input) values('{legacy_run}','{legacy_user}','failed','{{"storeName":"legacy preserved"}}');
      insert into public.restaurant_insight_jobs(run_id,job_key,status,output) values('{legacy_run}','market','done','{{"text":"exact legacy evidence"}}');
      insert into public.restaurant_insight_cost_events(user_id,run_id,operation,provider,model,request_status,measurement_status,pricing_as_of)
        values('{legacy_user}','{legacy_run}','fact_check_synthesis','OpenAI','fixture','unknown','unknown',current_date);
    """)
    snapshot_query = f"""select jsonb_build_object(
      'runs',(select jsonb_agg(to_jsonb(t)) from public.restaurant_insight_runs t where id='{legacy_run}'),
      'jobs',(select jsonb_agg(to_jsonb(t)) from public.restaurant_insight_jobs t where run_id='{legacy_run}'),
      'costs',(select jsonb_agg(to_jsonb(t)) from public.restaurant_insight_cost_events t where run_id='{legacy_run}'))"""
    legacy_before = sql(snapshot_query)
    before = sql("select proname || ':' || md5(pg_get_functiondef(oid)) from pg_proc where proname like 'restaurant_insight_%' order by proname")
    if "--baseline" not in sys.argv:
        for file in sorted((ROOT / "supabase/migrations").glob("*synthesis_regeneration.sql")):
            sql(file.read_text())
    after = sql("select proname || ':' || md5(pg_get_functiondef(oid)) from pg_proc where proname like 'restaurant_insight_%' and proname <> 'restaurant_insight_regenerate_synthesis' order by proname")
    assert before == after, "Existing RPC definitions changed"
    assert legacy_before == sql(snapshot_query), "Migration changed legacy runs, jobs or costs"
    for name in ["restaurant_insight_durable_jobs.sql", "restaurant_insight_report_trash.sql", "restaurant_insight_provider_diagnostics.sql", "restaurant_insight_synthesis_regeneration.sql"]:
        print(name, sql((ROOT / "supabase/tests" / name).read_text()).strip(), flush=True)
    concurrency_checks()
    print("PASS: migrations, existing RPC hashes, rollback SQL assertions; zero network dispatch")
finally:
    if attempted:
        docker("rm", "--force", "--volumes", NAME, check=False)
        # A failed inspect can mean daemon failure, so require a successful exact-name inventory.
        remaining = docker("ps", "--all", "--filter", "name=^/" + NAME + "$", "--format", "{{.Names}}").stdout.strip()
        if remaining:
            raise RuntimeError("Disposable container cleanup not verified: " + remaining)
        print("Cleanup verified:", NAME)
