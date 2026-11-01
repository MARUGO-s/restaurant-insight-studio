import { strict as assert } from "node:assert";
import { finalizeSynthesis, savedSynthesis, synthesize, executeJob, NonBillableSynthesisError, validateReportQuality, sourceUrls } from "../functions/restaurant-analysis/core.ts";
import { qualityReport, evidenceUrl } from "./report_quality_fixture.ts";
const parent = "https://tabelog.com/tokyo/A1304/A130401/13019866/";
const unread = `${parent}dtlrvwlst/B515656426/?lid=unpickup_review`;
const input = { storeName: "対象店", storeUrl: "https://store.example/", groupName: null, selectedSites: [{ id: "tabelog", name: "食べログ", url: parent }] };
const agents = () => [
  { id: "market", provider: "OpenAI", status: "done" as const, text: "同定した店舗の調査", sources: [parent] },
  { id: "gourmet", provider: "Google Gemini", status: "done" as const, text: "トップページの口コミ抜粋を確認。個別口コミ本文は未読。", sources: [parent], menuInventory: [] },
  { id: "social", provider: "xAI Grok", status: "done" as const, text: "期間と未確認事項を残した調査", sources: [] },
];
function report() {
  const value = JSON.parse(JSON.stringify(qualityReport()).replaceAll(evidenceUrl, parent));
  const row = value.researchCoverage.find((r: any) => r.targetId === "tabelog");
  row.scope = "トップに表示された口コミ抜粋3件を確認。個別口コミ詳細URLも開いたが本文を独立に再取得できず、抜粋以上は読んでいない。";
  row.limitation = "全口コミ・写真本文は未確認。";
  row.sources.push(unread);
  return value;
}
const draft = (value = report(), critique = "未確認の運用を断定せず反例を残す。") => ({ version: 1 as const, responseStatus: "completed" as const,
  text: JSON.stringify({ critique, report: value }), toolSources: [parent], costId: "completed-cost", responseId: "resp-completed" });
const cost = () => ({ id: "completed-cost", provider: "OpenAI", request_status: "succeeded", request_metadata: { response_status: "completed", provider_response_id: "resp-completed" } });
function database(costs: any[] = [cost()]) {
  const filters: any[] = [], rpcCalls: any[] = [], saved: any = {}, writes: any[] = [];
  let finishFailures = 0;
  const db: any = { failFinishOnce() { finishFailures = 1; }, from(table: string) {
    const q: any = { select() { return q; }, eq(k: string, v: any) { filters.push({ table, k, v }); return q; }, neq() { return q; },
      order() { return q; }, limit() { return q; },
      insert(row: any) { writes.push(row); costs.push(row); return Promise.resolve({ error: null }); },
      update(row: any) { writes.push(row); return q; },
      then(resolve: any, reject: any) {
        const data = table === "restaurant_insight_jobs" ? [
          { job_key: "market", status: "done", output: agents()[0] }, { job_key: "gourmet", status: "done", output: agents()[1] },
          { job_key: "social_recent", status: "done", output: agents()[2] }, { job_key: "social_history", status: "done", output: agents()[2] },
        ] : costs;
        return Promise.resolve({ data, error: null }).then(resolve, reject);
      } };
    return q;
  }, async rpc(name: string, args: any) {
    rpcCalls.push({ name, args });
    if (name === "restaurant_insight_checkpoint_job") Object.assign(saved, args.p_output);
    if (name === "restaurant_insight_finish_job" && finishFailures-- > 0) return { error: { message: "temporary finish failure" } };
    if (name === "restaurant_insight_finish_job" && args.p_output) Object.assign(saved, args.p_output);
    return { data: { accepted: true }, error: null };
  } };
  return { db, filters, rpcCalls, saved, writes };
}
const meter = (db: any) => ({ costDb: db, userId: "owner", runId: "run", jobId: "job", operation: "fact_check_synthesis" });
const run = { id: "run", user_id: "owner", input };
const job = (output: any) => ({ id: "job", job_key: "synthesis", attempts: 1, lease_token: "lease", output });
async function noNetwork(fn: () => Promise<void>) {
  const oldFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = () => { calls++; throw new Error("Network forbidden during recovery"); };
  try { await fn(); assert.equal(calls, 0); } finally { globalThis.fetch = oldFetch; }
}
Deno.test("unread coverage detail is removed only with an observed selected parent; every other field is preserved", async () => {
  const original = report(), originalJson = JSON.stringify(original), d = draft(original);
  assert.throws(() => validateReportQuality(original, input, [parent]), /追跡できない/);
  const result = await finalizeSynthesis(input, agents(), d);
  const recovered = JSON.parse(result.report_row.report), expected = structuredClone(original);
  expected.researchCoverage.find((r: any) => r.targetId === "tabelog").sources = [parent];
  delete recovered.qualityGate; delete recovered.productInventory;
  assert.deepEqual(recovered, expected); assert.equal(JSON.stringify(original), originalJson);
  assert.equal(result.report_row.critique, "未確認の運用を断定せず反例を残す。");
  assert.equal(result.synthesisDraft.text, d.text); assert.equal(result.sourceRecovery.status, "recovered");
  assert.equal(result.sourceRecovery.corrections[0].removedUrl, unread);
  assert.equal(result.sourceRecovery.corrections[0].retainedParentUrl, parent);
  assert.equal(result.sourceRecovery.additionalGenerations, 0);
  assert.equal(sourceUrls("", result.report_row.report_sources).includes(unread), false);
  assert.match(result.sourceRecovery.originalSha256, /^[a-f0-9]{64}$/);
});
Deno.test("unknown evidence in claims, body, tables or critique blocks recovery rather than deleting content", async () => {
  const patches = [
    (r: any) => { r.keyFindings[0].sources.push(unread); },
    (r: any) => { r.keyFindings[0].evidence += ` ${unread}`; },
    (r: any) => { r.detailSections[0].body += ` ${unread}`; },
    (r: any) => { r.detailSections[0].rows[0][0] = unread; },
  ];
  for (const patch of patches) { const r = report(); patch(r); await assert.rejects(() => finalizeSynthesis(input, agents(), draft(r)), /追跡できない/); }
  await assert.rejects(() => finalizeSynthesis(input, agents(), draft(report(), `反証の根拠 ${unread}`)), /追跡できない/);
});
Deno.test("wrong store, different origin, menu page, arbitrary query and verified row cannot be silently repaired", async () => {
  for (const url of [unread.replace("13019866", "99999999"), unread.replace("tabelog.com", "tabelog.com.evil.test"),
    `${parent}dtlmenu/lunch/`, `${unread}&page=2`, `${parent}dtlrvwlst/B515656426/#evidence`, "javascript:alert(1)"]) {
    const r = report(); r.researchCoverage.find((r: any) => r.targetId === "tabelog").sources = [parent, url];
    await assert.rejects(() => finalizeSynthesis(input, agents(), draft(r)));
  }
  const r = report(); r.researchCoverage.find((r: any) => r.targetId === "tabelog").status = "verified";
  await assert.rejects(() => finalizeSynthesis(input, agents(), draft(r)));
});
Deno.test("ambiguous limitations or absent observed parent do not permit source removal", async () => {
  for (const patch of [
    (row: any) => { row.scope = "掲載内容を確認。全口コミは未読。"; },
    (row: any) => { row.scope = "個別口コミ詳細は取得できず。"; },
    (row: any) => { row.sources = [unread]; },
  ]) {
    const r = report(); patch(r.researchCoverage.find((r: any) => r.targetId === "tabelog"));
    await assert.rejects(() => finalizeSynthesis(input, agents(), draft(r)));
  }
  await assert.rejects(() => finalizeSynthesis(input, agents().map(a => ({ ...a, sources: [] })), { ...draft(), toolSources: [] }));
});
Deno.test("full quality gate still rejects missing chapters and broken action links after source correction", async () => {
  for (const patch of [(r: any) => { r.detailSections.pop(); }, (r: any) => { r.actionPlan[0].findingIds = ["nonexistent"]; }]) {
    const r = report(); patch(r); await assert.rejects(() => finalizeSynthesis(input, agents(), draft(r)), /詳細章が不足|施策/);
  }
});
Deno.test("known detail references are retained and automatic recovery is idempotent", async () => {
  const valid = await finalizeSynthesis(input, agents(), { ...draft(), toolSources: [parent, unread] });
  assert.equal(valid.sourceRecovery.status, "unchanged"); assert.ok(JSON.parse(valid.report_row.report).researchCoverage.at(-1).sources.includes(unread));
  const first = await finalizeSynthesis(input, agents(), draft()), second = await finalizeSynthesis(input, agents(), draft());
  assert.deepEqual(first.sourceRecovery.corrections, second.sourceRecovery.corrections);
  assert.equal(first.sourceRecovery.originalSha256, second.sourceRecovery.originalSha256);
});
Deno.test("completed durable response is recovered and saved with zero provider calls and no new cost rows", async () => {
  await noNetwork(async () => {
    const d = database(); await executeJob(d.db, job({ synthesisDraft: draft() }), run);
    const finish = d.rpcCalls.find(c => c.name === "restaurant_insight_finish_job").args;
    assert.equal(finish.p_error, null); assert.equal(finish.p_output.sourceRecovery.status, "recovered");
    assert.equal(d.saved.synthesisComplete, true); assert.equal(d.writes.length, 0);
    for (const k of ["user_id", "run_id", "job_id", "operation", "request_metadata->>response_status"]) assert.ok(d.filters.some(f => f.k === k));
  });
});
Deno.test("unsafe completed draft is retained for review; automatic and explicit retry never generate again", async () => {
  await noNetwork(async () => {
    const r = report(); r.keyFindings[0].sources.push("https://unobserved.test/claim");
    const d = database(); await executeJob(d.db, job({ synthesisDraft: draft(r) }), run);
    const finish = d.rpcCalls.find(c => c.name === "restaurant_insight_finish_job").args;
    assert.equal(finish.p_retryable, false); assert.match(finish.p_error, /追加のAI呼び出しは停止/);
    assert.equal(d.saved.sourceRecovery.status, "needs_review"); assert.equal(d.saved.synthesisDraft.text, draft(r).text);
    await executeJob(d.db, { ...job(d.saved), attempts: 2 }, run);
    assert.equal(d.writes.length, 0); assert.ok(d.rpcCalls.filter(c => c.name === "restaurant_insight_finish_job").every(c => c.args.p_retryable === false));
  });
});
Deno.test("completion without a recoverable answer cannot trigger paid regeneration", async () => {
  await noNetwork(async () => {
    const d = database(); await assert.rejects(() => synthesize(input, agents(), meter(d.db), "", {}), NonBillableSynthesisError);
    const damaged = { synthesisDraft: { ...draft(), text: "broken JSON" } };
    await assert.rejects(() => synthesize(input, agents(), meter(d.db), "", damaged), NonBillableSynthesisError);
    assert.equal(d.writes.length, 0);
  });
});
Deno.test("legacy terminal checkpoint requires the actual completed response ID, not its written source list", async () => {
  await noNetwork(async () => {
    const legacy = { provider: "OpenAI", text: draft().text, responseId: "resp-completed", sources: [unread], toolSources: [parent], partial: true };
    const d = database(); const result = await savedSynthesis(meter(d.db), legacy);
    assert.equal(result?.costId, "completed-cost"); assert.deepEqual(result?.toolSources, [parent]);
    await assert.rejects(() => savedSynthesis(meter(d.db), { ...legacy, responseId: "unrelated" }), NonBillableSynthesisError);
    // New progress snapshots explicitly marked in-progress must not be mistaken
    // for a complete legacy snapshot even if the later ledger says completed.
    await assert.rejects(() => savedSynthesis(meter(d.db), { ...legacy, responseStatus: "in_progress" }), NonBillableSynthesisError);
    const pending = database([{ ...cost(), request_status: "unknown" }]);
    await assert.rejects(() => savedSynthesis(meter(pending.db), { synthesisDraft: draft() }), NonBillableSynthesisError);
    await assert.rejects(() => savedSynthesis(meter(d.db), { synthesisDraft: { ...draft(), responseId: "different-response" } }), NonBillableSynthesisError);
    await assert.rejects(() => savedSynthesis(meter(d.db), { synthesisDraft: { ...draft(), costId: "different-cost" } }), NonBillableSynthesisError);
  });
});
Deno.test("finish failure resumes the validated completed draft without another paid generation", async () => {
  await noNetwork(async () => {
    const d = database(); d.db.failFinishOnce(); await executeJob(d.db, job({ synthesisDraft: draft() }), run);
    assert.equal(d.saved.synthesisComplete, true);
    await executeJob(d.db, { ...job(d.saved), attempts: 2 }, run);
    assert.equal(d.rpcCalls.filter(c => c.name === "restaurant_insight_finish_job").at(-1).args.p_error, null);
    assert.equal(d.writes.length, 0);
  });
});
Deno.test("new synthesis journals its completed original before validating and repairs in the same single generation", async () => {
  const d = database([]), checkpoints: any[] = [], oldFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(`data: ${JSON.stringify({ type: "response.completed", response: {
    id: "resp-new", status: "completed", model: "gpt-6.1-terra", output_text: draft().text,
    usage: { input_tokens: 10, output_tokens: 20 },
  } })}\n\n`, { headers: { "Content-Type": "text/event-stream" } }); };
  try {
    const result = await synthesize(input, agents(), { ...meter(d.db), checkpoint: async value => { checkpoints.push(value); } });
    assert.equal(calls, 1); assert.equal(result.sourceRecovery.status, "recovered");
    const beforeValidation = checkpoints.find(c => c.synthesisDraft && !c.report_row);
    assert.equal(beforeValidation.synthesisDraft.text, draft().text);
    assert.equal(checkpoints.at(-1).synthesisComplete, true);
    assert.equal(d.writes.filter(w => w.id).length, 1);
    assert.ok(checkpoints.some(c => c.responseStatus === "completed" && c.costId));
  } finally { globalThis.fetch = oldFetch; }
});
