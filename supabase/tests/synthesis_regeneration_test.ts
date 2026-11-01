import { strict as assert } from "node:assert";
import { savedSynthesis, executeJob, handleApi } from "../functions/restaurant-analysis/core.ts";
import { qualityReport, evidenceUrl } from "./report_quality_fixture.ts";
import { withIntegrityReviews } from "./report_integrity_fixture.ts";
const generation = "11111111-2222-4333-8444-555555555555";
const oldGeneration = "22222222-2222-4333-8444-555555555555";
const input = { storeName: "対象店", storeUrl: "https://store.example/", selectedSites: [{ id: "tabelog", name: "食べログ", url: evidenceUrl }] };
const agents = [
  { id: "market", provider: "OpenAI", status: "done", text: "市場調査", sources: [evidenceUrl] },
  { id: "gourmet", provider: "Google Gemini", status: "done", text: "料理調査", sources: [evidenceUrl], menuInventory: [] },
  { id: "social", provider: "xAI Grok", status: "done", text: "体験調査", sources: [evidenceUrl] },
];
const completed = (regenerationId = oldGeneration) => ({ id: "cost-old", provider: "OpenAI", request_status: "succeeded", request_metadata: {
  regeneration_id: regenerationId, response_status: "completed", provider_response_id: "resp-old",
} });
const draft = { version: 1, responseStatus: "completed", requiredReportVersion: 3, text: "old draft", toolSources: [], costId: "cost-old", responseId: "resp-old" };
function database(costs: any[] = []) {
  const filters: any[] = [], writes: any[] = [], calls: any[] = [], saved: any = {};
  const db: any = { from(table: string) {
    const conditions: [string, any][] = []; let update: any;
    const q: any = { select() { return q; }, eq(k: string, v: any) { conditions.push([k, v]); filters.push([k, v]); return q; }, neq() { return q; }, order() { return q; }, limit() { return q; },
      insert(row: any) { writes.push(structuredClone(row)); costs.push(structuredClone(row)); return Promise.resolve({ error: null }); },
      update(row: any) { update = row; writes.push(structuredClone(row)); return q; },
      then(resolve: any, reject: any) {
        if (update) for (const c of costs) if (conditions.some(([k,v]) => k === "id" && c.id === v)) Object.assign(c, update);
        const data = table === "restaurant_insight_jobs" ? ["market", "gourmet", "social_recent", "social_history"].map((key, i) => ({ job_key: key, status: "done", output: agents[Math.min(i, 2)] }))
          : costs.filter(c => conditions.every(([k,v]) => !k.startsWith("request_metadata->>") || c.request_metadata?.[k.split("->>")[1]] === v));
        return Promise.resolve({ data, error: null }).then(resolve, reject);
      } };
    return q;
  }, async rpc(name: string, args: any) { calls.push({ name, args }); if (name.endsWith("checkpoint_job") || name.endsWith("finish_job")) Object.assign(saved, args.p_output); return { data: { accepted: true }, error: null }; } };
  return { db, filters, writes, calls, saved, costs };
}
async function execute(d: ReturnType<typeof database>, output: any, extraInput: any = {}) {
  await executeJob(d.db, { id: "job", job_key: "synthesis", attempts: 3, lease_token: "lease", output }, { id: "run", user_id: "owner", input: { ...input, ...extraInput } });
  return d.calls.filter(c => c.name.endsWith("finish_job")).at(-1).args;
}
Deno.test("executor uses only server generation and sends one metered synthesis with precise feedback and tool sources", async () => {
  const d = database([completed()]), previousFetch = globalThis.fetch; let sent = 0;
  const toolUrl = "https://observed.test/source";
  globalThis.fetch = async (_url, init) => {
    sent++; const payload = JSON.parse(String(init?.body));
    assert.deepEqual(payload.include, ["web_search_call.action.sources"]);
    assert.ok(payload.input.includes("claimReviews[2].evidenceQuote: exact quotation mismatch"));
    assert.equal(d.costs.at(-1).request_metadata.regeneration_id, generation);
    assert.equal(d.costs.at(-1).request_status, "unknown");
    const response = { id: "resp-new", status: "completed", output_text: JSON.stringify({ critique: "確認の制約を残す", report: withIntegrityReviews(qualityReport(), agents as any) }),
      output: [{ type: "web_search_call", action: { sources: [{ url: toolUrl }] } }], usage: { input_tokens: 10, output_tokens: 20 } };
    return new Response(`data: ${JSON.stringify({ type: "response.completed", response })}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
  };
  try {
    const finish = await execute(d, { regenerationId: generation, requiredReportVersion: 3, regenerationFeedback: "claimReviews[2].evidenceQuote: exact quotation mismatch" });
    assert.equal(sent, 1); assert.equal(finish.p_error, null);
    assert.equal(d.saved.synthesisDraft.requiredReportVersion, 3);
    assert.ok(d.saved.synthesisDraft.toolSources.includes(toolUrl));
    assert.equal(d.costs.length, 2);
    const again = await execute(d, { ...d.saved, regenerationId: generation, requiredReportVersion: 3 });
    assert.equal(again.p_error, null); assert.equal(sent, 1); assert.equal(d.costs.length, 2);
    const forged = database([completed()]);
    const denied = await execute(forged, {}, { regenerationId: generation, requiredReportVersion: 3 });
    assert.notEqual(denied.p_error, null); assert.equal(sent, 1); assert.equal(forged.writes.length, 0);
  } finally { globalThis.fetch = previousFetch; }
});
Deno.test("authenticated regeneration API requires exact consent, UUIDs and revision and returns scoped status", async () => {
  const keys = { SUPABASE_URL: "https://offline.invalid", SUPABASE_ANON_KEY: "offline-public", SUPABASE_SERVICE_ROLE_KEY: "offline-service", SUPABASE_PUBLISHABLE_KEYS: "{}" };
  const previous = Object.fromEntries(Object.keys(keys).map(k => [k, Deno.env.get(k)]));
  for (const [k,v] of Object.entries(keys)) Deno.env.set(k,v);
  const previousFetch = globalThis.fetch, calls: any[] = []; let authenticated = true, started = false;
  globalThis.fetch = async (url, init) => {
    const path = new URL(String(url)).pathname, body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ path, body, url: String(url) });
    if (path === "/auth/v1/user") return Response.json(authenticated ? { id: oldGeneration } : { error: "invalid" }, { status: authenticated ? 200 : 401 });
    if (path.endsWith("/rpc/restaurant_insight_regenerate_synthesis")) { started = true; return Response.json({ status: "running", regenerationId: generation, replayed: false }); }
    if (path.endsWith("/rpc/restaurant_insight_dispatch_jobs")) return Response.json(1);
    if (path.endsWith("/restaurant_insight_runs")) return Response.json({ id: generation, status: started ? "running" : "failed", input, report_deleted_at: null });
    if (path.endsWith("/restaurant_insight_jobs")) return Response.json([
      ...["market", "gourmet", "social_recent", "social_history"].map(job_key => ({ job_key, status: "done" })),
      { job_key: "synthesis", status: started ? "pending" : "failed", output: { synthesisDraft: draft, sourceRecovery: { status: "needs_review" } } },
    ]);
    if (path.endsWith("/restaurant_insight_reports")) return Response.json(null);
    throw Error(`Unexpected offline request: ${path}`);
  };
  const request = (body: any, auth = true) => handleApi(new Request("https://handler.invalid", { method: "POST", headers: { ...(auth ? { Authorization: "Bearer offline-user" } : {}), "Content-Type": "application/json" }, body: JSON.stringify(body) }));
  const body = { action: "regenerate_synthesis", runId: generation, requestId: oldGeneration, expectedRevision: "resp-old", confirmAdditionalCost: true, userId: "forged-owner", regenerationId: "forged-generation" };
  try {
    assert.equal((await request(body, false)).status, 401);
    authenticated = false; assert.equal((await request(body)).status, 401); authenticated = true;
    for (const patch of [{ confirmAdditionalCost: false }, { confirmAdditionalCost: "true" }, { expectedRevision: undefined }, { expectedRevision: "" }, { requestId: "bad" }, { runId: ` ${generation}` }]) {
      assert.equal((await request({ ...body, ...patch })).status, 400);
    }
    assert.equal(calls.some(c => c.path.includes("/rpc/")), false);
    const status = await (await request({ action: "run_status", runId: generation })).json();
    assert.equal(status.canRegenerateSynthesis, true); assert.equal(status.synthesisRevision, "resp-old");
    const response = await request(body), result = await response.json();
    assert.equal(response.status, 202); assert.equal(result.runId, generation); assert.equal(result.status, "running");
    assert.equal(result.canRegenerateSynthesis, false);
    const rpc = calls.find(c => c.path.endsWith("/rpc/restaurant_insight_regenerate_synthesis"));
    assert.deepEqual(rpc.body, { p_user_id: oldGeneration, p_run_id: generation, p_request_id: oldGeneration, p_expected_revision: "resp-old" });
    assert.ok(calls.some(c => c.path.endsWith("/rpc/restaurant_insight_dispatch_jobs")));
    assert.ok(calls.filter(c => c.path.endsWith("/restaurant_insight_runs")).every(c => c.url.includes(`user_id=eq.${oldGeneration}`)));
  } finally { globalThis.fetch = previousFetch; for (const [k,v] of Object.entries(previous)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k,v); }
});
Deno.test("legacy-shaped terminal checkpoint in an authorized generation cannot downgrade version 3", async () => {
  const d = database([completed(generation)]);
  const restored = await savedSynthesis(meter(d.db), { regenerationId: generation, requiredReportVersion: 3, provider: "OpenAI", text: "terminal snapshot", responseId: "resp-old", toolSources: [] });
  assert.equal(restored?.requiredReportVersion, 3);
});
Deno.test("failed new synthesis checkpoints precise validation feedback and never buys another attempt", async () => {
  const d = database([completed()]), previousFetch = globalThis.fetch; let sent = 0;
  globalThis.fetch = async () => {
    sent++;
    const response = { id: "resp-new", status: "completed", output_text: JSON.stringify({ critique: "fixture", report: qualityReport() }) };
    return new Response(`data: ${JSON.stringify({ type: "response.completed", response })}\n\n`);
  };
  try {
    const finish = await execute(d, { regenerationId: generation, requiredReportVersion: 3 });
    assert.equal(sent, 1); assert.equal(finish.p_retryable, false);
    assert.equal(d.saved.synthesisDraft.requiredReportVersion, 3);
    assert.ok(d.saved.sourceRecovery.validationMessage?.includes("審査"));
    const retry = await execute(d, { ...d.saved, regenerationId: generation, requiredReportVersion: 3 });
    assert.equal(retry.p_retryable, false); assert.equal(sent, 1); assert.equal(d.costs.length, 2);
  } finally { globalThis.fetch = previousFetch; }
});
Deno.test("unknown, partial and provider-failed generation results never trigger an automatic repurchase", async () => {
  const previousFetch = globalThis.fetch;
  try {
    for (const mode of ["disconnect", "partial", "failed"]) {
      const d = database([completed()]); let sent = 0;
      globalThis.fetch = async () => {
        sent++;
        if (mode === "disconnect") throw Error("simulated transport loss");
        const response = { id: "resp-new", status: mode === "failed" ? "failed" : "in_progress", output_text: "partial public draft" };
        return new Response(`data: ${JSON.stringify({ type: mode === "failed" ? "response.failed" : "response.created", response })}\n\n`);
      };
      const finish = await execute(d, { regenerationId: generation, requiredReportVersion: 3 });
      assert.equal(sent, 1); assert.notEqual(finish.p_error, null); assert.equal(finish.p_retryable, false);
      const retry = await execute(d, { ...d.saved, regenerationId: generation, requiredReportVersion: 3 });
      assert.equal(sent, 1); assert.equal(d.costs.length, 2); assert.equal(retry.p_retryable, false);
      assert.equal(d.costs.at(-1).request_metadata.regeneration_id, generation);
    }
  } finally { globalThis.fetch = previousFetch; }
});
const meter = (db: any) => ({ costDb: db, userId: "owner", runId: "run", jobId: "job", operation: "fact_check_synthesis", researchMetadata: { regeneration_id: generation } });
Deno.test("authorized generation ignores older completed costs but blocks every own unknown/partial/failed attempt", async () => {
  const d = database([completed()]);
  assert.equal(await savedSynthesis(meter(d.db), { regenerationId: generation, requiredReportVersion: 3 }), null);
  assert.ok(d.filters.some(([k,v]) => k === "request_metadata->>regeneration_id" && v === generation));
  assert.equal(d.filters.some(([k]) => k === "request_metadata->>response_status"), false);
  for (const status of ["unknown", "failed", "succeeded"]) {
    for (const responseStatus of [undefined, "in_progress", "incomplete", "failed", "completed"]) {
      const own = { ...completed(generation), request_status: status, request_metadata: { regeneration_id: generation, response_status: responseStatus } };
      await assert.rejects(() => savedSynthesis(meter(database([completed(), own]).db), { regenerationId: generation }), /追加のAI呼び出しは停止/);
    }
  }
});
Deno.test("generation reuses only its exactly matched completed response and preserves version 3", async () => {
  const d = database([completed(), completed(generation)]);
  assert.deepEqual(await savedSynthesis(meter(d.db), { regenerationId: generation, requiredReportVersion: 3, synthesisDraft: draft }), draft);
  const { requiredReportVersion: _version, ...oldShape } = draft;
  assert.equal((await savedSynthesis(meter(d.db), { regenerationId: generation, synthesisDraft: oldShape }))?.requiredReportVersion, 3);
  await assert.rejects(() => savedSynthesis(meter(database([completed()]).db), { regenerationId: generation, synthesisDraft: draft }));
});
