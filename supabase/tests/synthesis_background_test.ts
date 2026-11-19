import { strict as assert } from "node:assert";
import { executeJob } from "../functions/restaurant-analysis/core.ts";
import { evidenceUrl, qualityInput, qualityReport } from "./report_quality_fixture.ts";
import { withIntegrityReviews } from "./report_integrity_fixture.ts";

const run = { id: "test-run", user_id: "test-owner", input: qualityInput };
const jobId = "test-synthesis-job";
const responseId = "resp_background_fixture";
const synthesisModel = "gpt-6.2-astra";
const historicalModel = "gpt-6.1-terra";
const toolSource = "https://observed.test/source";
const market = { id: "market", provider: "OpenAI", status: "done", text: "市場の調査記録", sources: [evidenceUrl] };
const gourmet = { id: "gourmet", provider: "Google Gemini", status: "done", text: "媒体の調査記録", sources: [evidenceUrl], menuInventory: [] };
const social = { id: "social", provider: "xAI Grok", status: "done", text: "Xで確認した調査記録", sources: [evidenceUrl] };
const research = [
  { run_id: run.id, job_key: "market", status: "done", output: market },
  { run_id: run.id, job_key: "gourmet", status: "done", output: gourmet },
  { run_id: run.id, job_key: "social_recent", status: "done", output: social },
  { run_id: run.id, job_key: "social_history", status: "done", output: social },
];
const historicalCost = {
  id: "old-streaming-attempt",
  user_id: run.user_id,
  run_id: run.id,
  job_id: jobId,
  attempt_number: 8,
  operation: "fact_check_synthesis",
  provider: "OpenAI",
  model: historicalModel,
  request_status: "unknown",
  request_metadata: { provider_response_id: "resp_old_foreground", response_status: "in_progress" },
};

function fakeDatabase(initial: Record<string, any>[] = []) {
  const costs = structuredClone(initial);
  const calls: { name: string; args: Record<string, any> }[] = [];
  const saved: Record<string, any> = {};
  const db = {
    from(table: string) {
      assert.ok(table === "restaurant_insight_jobs" || table === "restaurant_insight_cost_events");
      const filters: ((row: Record<string, any>) => boolean)[] = [];
      let patch: Record<string, any> | undefined, limit = Infinity, single = false, sortKey = "", descending = false;
      const get = (row: Record<string, any>, key: string) => {
        const [field, metadataKey] = key.split("->>");
        return metadataKey ? String(row[field]?.[metadataKey] ?? "") : row[field];
      };
      const query = {
        select() { return query; },
        eq(key: string, value: unknown) { filters.push(row => get(row, key) === (key.includes("->>") ? String(value) : value)); return query; },
        neq(key: string, value: unknown) { filters.push(row => get(row, key) !== value); return query; },
        in(key: string, values: unknown[]) { filters.push(row => values.includes(get(row, key))); return query; },
        contains(key: string, fields: Record<string, unknown>) {
          filters.push(row => Object.entries(fields).every(([field, value]) => row[key]?.[field] === value));
          return query;
        },
        order(key: string, options?: { ascending: boolean }) { sortKey = key; descending = options?.ascending === false; return query; },
        limit(count: number) { limit = count; return query; },
        maybeSingle() { single = true; return query; },
        insert(row: Record<string, any>) { costs.push(structuredClone(row)); return Promise.resolve({ error: null }); },
        update(row: Record<string, any>) { patch = row; return query; },
        then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
          let rows = (table === "restaurant_insight_jobs" ? research : costs).filter(row => filters.every(matches => matches(row)));
          if (sortKey) rows = rows.toSorted((a, b) => String(get(a, sortKey)).localeCompare(String(get(b, sortKey))) * (descending ? -1 : 1));
          if (patch) for (const row of rows) Object.assign(row, structuredClone(patch));
          rows = rows.slice(0, limit);
          return Promise.resolve({ data: structuredClone(single ? rows[0] ?? null : rows), error: null }).then(resolve, reject);
        },
      };
      return query;
    },
    async rpc(name: string, args: Record<string, any> = {}) {
      calls.push({ name, args: structuredClone(args) });
      if (name === "restaurant_insight_checkpoint_job" || name === "restaurant_insight_finish_job") {
        Object.assign(saved, structuredClone(args.p_output));
      }
      return { data: { accepted: true }, error: null };
    },
  };
  return {
    costs, calls, saved,
    execute: (attempts: number, output: Record<string, any> = saved) => executeJob(db, {
      id: jobId, job_key: "synthesis", attempts, max_attempts: 11, lease_token: "test-lease", output: structuredClone(output),
    }, run),
    executeMarket: () => executeJob(db, {
      id: "test-market-job", job_key: "market", attempts: 1, max_attempts: 3, lease_token: "test-lease", output: {},
    }, run),
  };
}

async function withProvider(mock: typeof fetch, action: () => Promise<void>) {
  const previousFetch = globalThis.fetch;
  const previousKey = Deno.env.get("OPENAI_API_KEY");
  globalThis.fetch = mock;
  Deno.env.set("OPENAI_API_KEY", "fixture-only");
  try { await action(); }
  finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) Deno.env.delete("OPENAI_API_KEY");
    else Deno.env.set("OPENAI_API_KEY", previousKey);
  }
}

function providerResponse(status: "queued" | "in_progress" | "completed", model: string | null = synthesisModel) {
  const report = withIntegrityReviews(qualityReport(), [market, gourmet, social]);
  return Response.json({
    id: responseId, ...(model ? { model } : {}), status,
    ...(status === "completed" ? {
      output: [
        { type: "web_search_call", status: "completed", action: { sources: [{ url: toolSource }] } },
        { type: "message", content: [{ type: "output_text", text: JSON.stringify({ critique: "確認の制約を残す", report }) }] },
      ],
      usage: { input_tokens: 100, output_tokens: 200 },
    } : {}),
  });
}

Deno.test("ordinary synthesis submits once and polls the same background response through quality validation", async () => {
  const d = fakeDatabase([historicalCost]);
  const methods: string[] = [];
  let completed = false, transientFailure = true;
  await withProvider(async (target, init) => {
    const method = init?.method ?? "GET";
    const url = new URL(String(target));
    methods.push(method);
    assert.equal(url.origin, "https://api.openai.com");
    if (method === "POST") {
      assert.equal(url.pathname, "/v1/responses");
      const payload = JSON.parse(String(init?.body));
      assert.equal(payload.model, synthesisModel);
      assert.equal(payload.background, true);
      assert.equal(payload.store, true);
      assert.notEqual(payload.stream, true);
      assert.deepEqual(payload.include, ["web_search_call.action.sources"]);
      assert.equal(d.costs.length, 2);
      assert.equal(d.costs[1].model, synthesisModel);
      assert.equal(d.costs[1].request_status, "unknown");
      assert.equal(d.costs[1].request_metadata.synthesis_background, true);
      return providerResponse("queued");
    }
    assert.equal(url.pathname, "/v1/responses/" + responseId);
    assert.ok([...url.searchParams.values()].includes("web_search_call.action.sources"));
    assert.equal(d.costs[1].request_metadata.provider_response_id, responseId);
    if (transientFailure) {
      transientFailure = false;
      return Response.json({ error: "temporary rate limit" }, { status: 429 });
    }
    return providerResponse(completed ? "completed" : "in_progress");
  }, async () => {
    await d.execute(9);
    assert.deepEqual(methods, ["POST"]);
    assert.equal(d.saved.backgroundSynthesisPending, true);
    assert.equal(d.costs[1].request_status, "unknown");
    assert.equal(d.calls.filter(call => call.name === "restaurant_insight_defer_synthesis").length, 1);
    assert.equal(d.calls.some(call => call.name === "restaurant_insight_finish_job"), false);

    await d.execute(9);
    assert.deepEqual(methods, ["POST", "GET"]);
    assert.equal(d.calls.filter(call => call.name === "restaurant_insight_defer_synthesis").length, 2);
    assert.equal(d.calls.some(call => call.name === "restaurant_insight_finish_job"), false);

    await d.execute(9);
    assert.deepEqual(methods, ["POST", "GET", "GET"]);
    assert.equal(d.calls.filter(call => call.name === "restaurant_insight_defer_synthesis").length, 3);
    assert.equal(d.calls.some(call => call.name === "restaurant_insight_finish_job"), false);

    completed = true;
    await d.execute(9);
    assert.deepEqual(methods, ["POST", "GET", "GET", "GET"]);
    assert.equal(d.costs.length, 2);
    assert.deepEqual(d.costs[0], historicalCost);
    assert.equal(d.costs[1].model, synthesisModel);
    assert.equal(d.costs[1].request_status, "succeeded");
    assert.equal(d.costs[1].request_metadata.response_status, "completed");
    assert.equal(d.costs[1].request_metadata.provider_response_id, responseId);
    assert.equal(d.costs[1].attempt_number, 9);
    assert.equal(d.costs[1].measurement_status, "complete");
    assert.ok(Math.abs(d.costs[1].list_price_usd - 0.0188) < 1e-10);
    const finish = d.calls.find(call => call.name === "restaurant_insight_finish_job");
    assert.ok(finish);
    assert.equal(finish.args.p_error, null);
    assert.equal(finish.args.p_output.synthesisDraft.responseId, responseId);
    assert.ok(finish.args.p_output.synthesisDraft.toolSources.includes(toolSource));
    assert.equal(JSON.parse(finish.args.p_output.report_row.report).qualityGate.version, 3);
  });
});

Deno.test("ambiguous initial submission keeps the reservation and blocks a second paid POST", async () => {
  const d = fakeDatabase();
  const methods: string[] = [];
  await withProvider(async (_target, init) => {
    methods.push(init?.method ?? "GET");
    assert.equal(d.costs.length, 1);
    assert.equal(d.costs[0].request_status, "unknown");
    assert.equal(d.costs[0].request_metadata.synthesis_background, true);
    throw new Error("test disconnect after request was sent");
  }, async () => {
    await d.execute(9);
    assert.deepEqual(methods, ["POST"]);
    assert.equal(d.costs[0].request_status, "unknown");
    assert.equal(d.costs[0].request_metadata.provider_response_id ?? null, null);
    await d.execute(10);
    assert.deepEqual(methods, ["POST"]);
    assert.equal(d.costs.length, 1);
    const finish = d.calls.filter(call => call.name === "restaurant_insight_finish_job").at(-1);
    assert.ok(finish);
    assert.equal(finish.args.p_retryable, false);
    assert.ok(finish.args.p_error);
    assert.equal(d.saved.report_row, undefined);
  });
});

Deno.test("completed Terra billing record recovers a missing checkpoint without a new generation", async () => {
  const completedCost = {
    ...historicalCost,
    id: "completed-background-attempt",
    attempt_number: 9,
    request_status: "succeeded",
    request_metadata: { synthesis_background: true, provider_response_id: responseId, response_status: "completed" },
  };
  const d = fakeDatabase([completedCost]);
  const methods: string[] = [];
  await withProvider(async (target, init) => {
    methods.push(init?.method ?? "GET");
    assert.equal(new URL(String(target)).pathname, "/v1/responses/" + responseId);
    return providerResponse("completed", null);
  }, async () => {
    await d.execute(10);
    assert.deepEqual(methods, ["GET"]);
    assert.equal(d.costs.length, 1);
    assert.equal(d.costs[0].id, completedCost.id);
    assert.equal(d.costs[0].model, historicalModel);
    assert.ok(Math.abs(d.costs[0].list_price_usd - 0.0111) < 1e-10);
    assert.equal(d.costs[0].attempt_number, 9);
    assert.equal(d.saved.synthesisDraft.costId, completedCost.id);
    assert.ok(d.saved.report_row);

    await d.execute(10);
    assert.deepEqual(methods, ["GET"]);
    assert.equal(d.costs.length, 1);
    const finish = d.calls.filter(call => call.name === "restaurant_insight_finish_job").at(-1);
    assert.ok(finish);
    assert.equal(finish.args.p_error, null);
    assert.equal(JSON.parse(finish.args.p_output.report_row.report).qualityGate.version, 3);
  });
});

Deno.test("market research keeps using Terra and its own cost operation", async () => {
  const d = fakeDatabase();
  await withProvider(async (_target, init) => {
    const payload = JSON.parse(String(init?.body));
    assert.equal(payload.model, historicalModel);
    assert.equal(payload.stream, true);
    assert.deepEqual(payload.tools, [{ type: "web_search" }]);
    const response = { id: "resp_market", model: historicalModel, status: "completed", output_text: "市場の調査結果",
      usage: { input_tokens: 100, output_tokens: 200 } };
    return new Response(`data: ${JSON.stringify({ type: "response.completed", response })}\n\n`);
  }, async () => {
    await d.executeMarket();
    assert.equal(d.costs.length, 1);
    assert.equal(d.costs[0].operation, "market_research");
    assert.equal(d.costs[0].model, historicalModel);
    assert.equal(d.costs[0].request_status, "succeeded");
    const finish = d.calls.find(call => call.name === "restaurant_insight_finish_job");
    assert.ok(finish);
    assert.equal(finish.args.p_error, null);
    assert.equal(finish.args.p_output.provider, "OpenAI · GPT-6.1 Terra");
  });
});
