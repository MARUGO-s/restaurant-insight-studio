import { strict as assert } from "node:assert";
import { type Baseline, COVERAGE_TOPICS, researchKey, planSocialResearch, parseDelta, mergeDelta, evidenceKey } from "../functions/restaurant-analysis/social-reuse.ts";
import { socialResearch, loadSocialBaseline } from "../functions/restaurant-analysis/core.ts";
const input = { storeName: "対象店", storeUrl: "https://store.example/", groupName: "系列", selectedSites: [{ id: "tabelog", name: "食べログ", url: "https://tabelog.com/test/" }] };
const source = "https://x.com/visitor/status/123";
const baseText = "2026-10-20 料理への好意と接客の反例。価格と予約条件は未確認。古い声を現在と断定しない。".repeat(30);
const base = (): Baseline => ({ reportId: "prior-report", runId: "prior-run", userId: "owner", input, startedAt: "2026-11-01T01:00:00Z", runStatus: "done", output: { status: "done", text: baseText, sources: [source] } });
const audit = () => ({ identityMatch: true, baselineAdequate: true, counterevidenceReviewed: true, needsFullResearch: false,
  coverage: Object.fromEntries(COVERAGE_TOPICS.map(key => [key, "retained"])), searchTerms: ["対象店 新宿 不満"], gaps: ["新しい予約体験は見つからない"] });
const deltaText = () => "最新順と別表記で検索。新着の利用者体験は0件。接客への反例を含む前回ノートを保持し、現在の接客を保証しない。検索範囲の限界は残る。".repeat(4);
const audited = () => `${deltaText()}\n<DELTA_AUDIT>${JSON.stringify(audit())}</DELTA_AUDIT>`;
const now = () => new Date("2026-11-01T02:00:00Z");
Deno.test("same conditions allow reuse; focus, target sites, group and store changes require full research", () => {
  assert.equal(planSocialResearch(input, "owner", "social_recent", now(), base()).mode, "incremental");
  for (const changed of [{ ...input, researchFocus: "新たな観点" }, { ...input, groupName: "別系列" }, { ...input, storeUrl: "https://other.example" }, { ...input, selectedSites: [] }]) {
    assert.equal(planSocialResearch(changed, "owner", "social_recent", now(), base()).mode, "full");
  }
  assert.equal(researchKey(input), researchKey({ ...input, storeUrl: "https://store.example" }));
});
Deno.test("other owner, trash, deleted run, failed job and insufficient evidence cannot be reused", () => {
  for (const patch of [{ userId: "other" }, { deletedAt: "2026-11-01" }, { runDeletedAt: "2026-11-01" }, { runStatus: "failed" },
    { output: { ...base().output, status: "partial" } }, { output: { ...base().output, sources: [] } }, { output: { ...base().output, text: "too short" } }]) {
    assert.equal(planSocialResearch(input, "owner", "social_recent", now(), { ...base(), ...patch }).mode, "full");
  }
});
Deno.test("seven-day refresh cannot be extended indefinitely by incremental updates", () => {
  const b = base();
  b.output.reuse = { version: 1, mode: "incremental", reason: "test", updatedAt: "2026-11-01T01:30:00Z", fullResearchAt: "2026-10-25T02:00:00Z", retainedSources: 1, addedSources: 0, toDate: "2026-11-02" };
  assert.equal(planSocialResearch(input, "owner", "social_recent", now(), b).reason, "periodic_full_refresh");
  b.output.reuse.fullResearchAt = "not-a-date";
  assert.equal(planSocialResearch(input, "owner", "social_recent", now(), b).mode, "full");
});
Deno.test("date windows partition full search and retain seven-day overlap for recent delta", () => {
  assert.deepEqual([planSocialResearch(input, "owner", "social_recent", now()).fromDate, planSocialResearch(input, "owner", "social_recent", now()).toDate], ["2025-11-01", "2026-11-02"]);
  const recent = planSocialResearch(input, "owner", "social_recent", now(), base());
  const history = planSocialResearch(input, "owner", "social_history", now(), base());
  assert.equal(recent.fromDate, "2026-10-25");
  assert.equal(history.fromDate, undefined); assert.equal(history.toDate, "2025-11-01");
  const leap = planSocialResearch(input, "owner", "social_recent", new Date("2028-03-01T23:59:59Z"));
  assert.equal(leap.toDate, "2028-03-02"); assert.equal(leap.fromDate, "2027-03-01");
});
Deno.test("retries and oversized accumulated evidence request full research instead of truncating", () => {
  assert.equal(planSocialResearch(input, "owner", "social_recent", now(), base(), 2).reason, "retry_full_research");
  const b = base(); b.output.text = "証拠".repeat(12000);
  assert.equal(planSocialResearch(input, "owner", "social_history", now(), b).reason, "baseline_requires_consolidation");
});
Deno.test("audit requires identity, adequacy, counterevidence, every topic and actual search terms", () => {
  assert.ok(parseDelta(audited()));
  for (const patch of [{ identityMatch: false }, { baselineAdequate: false }, { counterevidenceReviewed: false }, { needsFullResearch: true }, { coverage: {} }, { searchTerms: [] }]) {
    assert.equal(parseDelta(`${deltaText()}<DELTA_AUDIT>${JSON.stringify({ ...audit(), ...patch })}</DELTA_AUDIT>`), null);
  }
  assert.equal(parseDelta(deltaText()), null); assert.equal(parseDelta(audited() + audited()), null);
});
Deno.test("merge preserves baseline verbatim, contrary evidence and every source while deduplicating X aliases", () => {
  const plan = planSocialResearch(input, "owner", "social_recent", now(), base());
  const parsed = parseDelta(audited())!;
  const result = mergeDelta(plan, { text: parsed.text, sources: ["https://twitter.com/visitor/status/123?s=1", "https://x.com/new/status/456"] }, parsed.audit);
  assert.ok(result.text.startsWith(baseText)); assert.ok(result.text.includes("接客の反例"));
  assert.deepEqual(result.sources, [source, "https://x.com/new/status/456"]);
  assert.equal(result.reuse.fullResearchAt, base().startedAt); assert.equal(result.reuse.addedSources, 1);
  assert.equal(evidenceKey("https://x.com/i/status/456"), "x:456");
});

function database() {
  const queries: { table: string; filters: any[] }[] = [], costs: any[] = [];
  const b = base(); b.startedAt = new Date(Date.now() - 3600000).toISOString();
  const db = { from(table: string) {
    const filters: any[] = []; queries.push({ table, filters });
    const q: any = { select() { return q; }, eq(k: string, v: any) { filters.push([k, v]); return q; },
      is(k: string, v: any) { filters.push([k, v]); return q; }, lt() { return q; }, order() { return q; }, limit() { return q; }, in() { return q; },
      maybeSingle() { return q; }, insert(row: any) { costs.push(row); return Promise.resolve({ error: null }); },
      update(row: any) { costs.push(row); return q; },
      then(resolve: any, reject: any) {
        const data = table === "restaurant_insight_reports" ? [{ id: b.reportId, run_id: b.runId, user_id: "owner", deleted_at: null }]
          : table === "restaurant_insight_runs" ? { id: b.runId, user_id: b.userId, input, started_at: b.startedAt, status: "done", report_deleted_at: null }
          : table === "restaurant_insight_jobs" ? [{ job_key: "social_recent", status: "done", output: b.output }] : null;
        return Promise.resolve({ data, error: null }).then(resolve, reject);
      } };
    return q;
  } };
  return { db, queries, costs };
}
const run = () => ({ id: "new-run", user_id: "owner", input, started_at: new Date().toISOString() });
Deno.test("baseline queries explicitly scope reports and runs to the owner and exclude trash", async () => {
  const d = database(); await loadSocialBaseline(d.db, run(), "social_recent");
  assert.ok(d.queries.filter(q => ["restaurant_insight_reports", "restaurant_insight_runs"].includes(q.table)).every(q => q.filters.some(f => f[0] === "user_id" && f[1] === "owner")));
  assert.ok(d.queries[0].filters.some(f => f[0] === "deleted_at" && f[1] === null));
});
function providerReply(text: string, searched = true) {
  const data = { type: "response.completed", response: { id: crypto.randomUUID(), status: "completed", model: "grok-4.7", output_text: text,
    usage: { input_tokens: 100, output_tokens: 50, server_side_tool_usage_details: { x_search_calls: searched ? 1 : 0, x_posts_fetched: 0, x_users_fetched: 0 } } } };
  return new Response(`data: ${JSON.stringify(data)}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
}
async function withProvider(replies: { text: string; searched?: boolean }[], fn: (requests: any[]) => Promise<void>) {
  const oldFetch = globalThis.fetch, oldKey = Deno.env.get("XAI_API_KEY"), requests: any[] = [];
  Deno.env.set("XAI_API_KEY", "test-key-never-real");
  globalThis.fetch = async (_url, init) => { requests.push(JSON.parse(String(init?.body))); const response = replies.shift(); assert.ok(response, "unexpected extra paid request"); return providerReply(response.text, response.searched); };
  try { await fn(requests); } finally { globalThis.fetch = oldFetch; if (oldKey === undefined) Deno.env.delete("XAI_API_KEY"); else Deno.env.set("XAI_API_KEY", oldKey); }
}
Deno.test("valid zero-new-post delta requires a real search, preserves evidence and meters one generation", async () => {
  await withProvider([{ text: audited() }], async requests => {
    const d = database(), result = await socialResearch(d.db, run(), { job_key: "social_recent", attempts: 1 }, "調査", { costDb: d.db, userId: "owner", operation: "social_recent" });
    assert.equal(result.status, "done"); assert.equal(result.reuse?.mode, "incremental"); assert.ok(result.text.startsWith(baseText));
    assert.equal(requests.length, 1); assert.equal(requests[0].max_turns, 4); assert.equal(requests[0].max_output_tokens, 7000);
    assert.ok(requests[0].tools[0].from_date); assert.ok(requests[0].prompt_cache_key);
    assert.equal(d.costs.filter(c => c.id).length, 1); assert.equal(d.costs.at(-1).request_metadata.research_mode, "incremental");
    assert.equal(d.costs.at(-1).measurement_status, "complete");
  });
});
Deno.test("invalid quality audit or unverified search performs one full fallback and records both charges", async () => {
  for (const response of [{ text: "監査が欠落" }, { text: audited(), searched: false }]) {
    await withProvider([response, { text: "全範囲を再調査した結果" }], async requests => {
      const d = database(), result = await socialResearch(d.db, run(), { job_key: "social_recent", attempts: 1 }, "調査", { costDb: d.db, userId: "owner", operation: "social_recent" });
      assert.equal(requests.length, 2); assert.equal(result.reuse?.mode, "full"); assert.ok(result.reuse?.fallbackReason);
      assert.equal(d.costs.filter(c => c.id).length, 2); assert.equal(d.costs.at(-1).request_metadata.research_mode, "full");
      assert.ok(d.costs.at(-1).request_metadata.full_fallback_reason);
      assert.equal(requests[1].tools[0].from_date, new Date(new Date().setUTCFullYear(new Date().getUTCFullYear() - 1)).toISOString().slice(0, 10));
    });
  }
});
Deno.test("baseline lookup failure fails open to full research and never skips investigation", async () => {
  await withProvider([{ text: "全範囲の調査" }], async requests => {
    const d = database(), broken = { from() { throw new Error("lookup unavailable"); } };
    const result = await socialResearch(broken, run(), { job_key: "social_recent", attempts: 1 }, "調査", { costDb: d.db, userId: "owner", operation: "social_recent" });
    assert.equal(requests.length, 1); assert.equal(result.reuse?.mode, "full"); assert.equal(result.reuse?.reason, "baseline_lookup_failed");
  });
});
Deno.test("completed job checkpoint is recovered without a new paid generation", async () => {
  await withProvider([], async requests => {
    const d = database();
    const saved = { ...base().output, id: "social", provider: "xAI Grok", status: "done", researchComplete: true, reuse: { version: 1 } };
    const result = await socialResearch(d.db, run(), { job_key: "social_recent", attempts: 2, output: saved }, "調査", { costDb: d.db, userId: "owner", operation: "social_recent" });
    assert.equal(result, saved); assert.equal(requests.length, 0); assert.equal(d.queries.length, 0);
  });
});
