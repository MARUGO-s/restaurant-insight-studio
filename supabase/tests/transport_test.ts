import { strict as assert } from "node:assert";
import { consumeResponseStream, requestJson, readUsage, handleWorker, reconcileCosts } from "../functions/restaurant-analysis/core.ts";
const encoder = new TextEncoder();
const frame = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;
function stream(parts: string[], broken = false) {
  let i = 0;
  return new Response(new ReadableStream({ pull(controller) {
    if (i < parts.length) controller.enqueue(encoder.encode(parts[i++]));
    else if (broken) controller.error(new Error("connection closed"));
    else controller.close();
  } }), { headers: { "Content-Type": "text/event-stream" } });
}
Deno.test("SSE handles chunk boundaries, public text and final usage/citations", async () => {
  const events = frame({ type: "response.created", response: { id: "response-test", model: "grok-4.7", status: "in_progress" } })
    + frame({ type: "response.reasoning_text.delta", delta: "PRIVATE REASONING" })
    + frame({ type: "response.output_text.delta", delta: "公開の調査" })
    + frame({ type: "response.output_text.delta", delta: "結果" })
    + frame({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 1, output_tokens: 2 }, output: [{ type: "message", content: [{ type: "output_text", text: "公開の調査結果", annotations: [{ url: "https://x.com/example/status/123" }] }] }] } });
  const parts = [events.slice(0, 3), events.slice(3, 71), events.slice(71)];
  const saved: any[] = [];
  const result = await consumeResponseStream(stream(parts), async (data) => { saved.push(data); });
  assert.equal(result.output_text, "公開の調査結果");
  assert.equal(result.usage.output_tokens, 2);
  assert.equal(result.status, "completed");
  assert.equal(JSON.stringify(saved).includes("PRIVATE REASONING"), false);
  assert.ok(JSON.stringify(result).includes("https://x.com/example/status/123"));
});
Deno.test("premature stream close checkpoints answer but is never complete", async () => {
  let saved: any;
  const body = frame({ type: "response.output_text.delta", delta: "途中で取得した証拠" });
  await assert.rejects(() => consumeResponseStream(stream([body]), async (data) => { saved = data; }), /完了通知前/);
  assert.equal(saved.output_text, "途中で取得した証拠");
  assert.equal(saved.status, "in_progress");
});
Deno.test("attempt is recorded before network and remains unknown after disconnect", async () => {
  const rows: any[] = [], updates: any[] = [];
  const db = { from: () => ({ insert: async (row: any) => { rows.push(row); return { error: null }; }, update: (row: any) => ({ eq: () => ({ eq: async () => { updates.push(row); return { error: null }; } }) }) }) };
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    assert.equal(rows.length, 1); assert.equal(rows[0].request_status, "unknown");
    return stream([frame({ type: "response.output_text.delta", delta: "途中の調査" })], true);
  };
  try {
    const result = await requestJson("https://api.x.ai/v1/responses", "fake-test-key", { model: "grok-4.7", stream: true }, false, { costDb: db, userId: "test", jobId: "test-job", attempt: 2, operation: "social_recent" }, 300_000, true);
    assert.equal(result.partial, true);
    assert.equal(result.text, "途中の調査");
    assert.equal(updates.at(-1).request_status, "unknown");
    assert.equal(updates.at(-1).list_price_usd, null);
    assert.equal(updates.at(-1).attempt_number, 2);
    assert.equal(JSON.stringify(rows).includes("fake-test-key"), false);
  } finally { globalThis.fetch = oldFetch; }
});
Deno.test("X search rates use per-post/profile units", () => {
  const result = readUsage("xAI", "grok-4.7", { usage: { input_tokens: 0, output_tokens: 0, server_side_tool_usage_details: { x_search_calls: 1, x_posts_fetched: 100, x_users_fetched: 2 } } });
  assert.equal(result.cost, 0.52);
});
Deno.test("worker rejects malformed unauthenticated dispatch before any provider call", async () => {
  const response = await handleWorker(new Request("https://example.test", { method: "POST", body: JSON.stringify({ jobId: "wrong", dispatchToken: "wrong" }) }));
  assert.equal(response.status, 401);
});
Deno.test("SSE CRLF framing survives every-byte chunk boundaries", async () => {
  const payload = (frame({ type: "response.output_text.delta", delta: "evidence" }) + frame({ type: "response.completed", response: { status: "completed", output_text: "evidence" } })).replace(/\n/g, "\r\n");
  const result = await consumeResponseStream(stream([...payload]), async () => {});
  assert.equal(result.output_text, "evidence");
});
Deno.test("terminal event finishes even when provider keeps connection open", async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({ start(controller) {
    controller.enqueue(encoder.encode(frame({ type: "response.completed", response: { status: "completed", output_text: "finished" } })));
  }, cancel() { cancelled = true; } }));
  const result = await consumeResponseStream(response, async () => {});
  assert.equal(result.status, "completed");
  assert.equal(cancelled, true);
});
Deno.test("stream checkpoints retain tool provenance separately from URLs written in the answer", async () => {
  const oldFetch = globalThis.fetch;
  const checkpoints: any[] = [];
  const db = { from: () => ({ insert: async () => ({ error: null }), update: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }) }) };
  const observed = "https://example.test/tool-observed", modelWritten = "https://example.test/model-written";
  globalThis.fetch = async () => stream([frame({ type: "response.completed", response: { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: `候補 ${modelWritten}`, annotations: [{ type: "url_citation", url: observed }] }] }], usage: { input_tokens: 1, output_tokens: 1 } } })]);
  try {
    const result = await requestJson("https://api.openai.com/v1/responses", "test-only", { model: "gpt-6.1-terra", stream: true }, false,
      { costDb: db, userId: "test", operation: "fact_check_synthesis", checkpoint: async value => { checkpoints.push(value); } });
    assert.ok(checkpoints.at(-1).sources.includes(modelWritten));
    assert.deepEqual(checkpoints.at(-1).toolSources, [observed]);
    assert.deepEqual(result.toolSources, [observed]);
  } finally { globalThis.fetch = oldFetch; }
});

Deno.test("disconnect retrieves the same X response and meters it without a second generation", async () => {
  const updates: any[] = [], requests: any[] = [];
  const db = { from: () => ({ insert: async () => ({ error: null }), update: (row: any) => ({ eq: () => ({ eq: async () => { updates.push(row); return { error: null }; } }) }) }) };
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), method: init?.method ?? "GET" });
    if (init?.method === "POST") return stream([frame({ type: "response.created", response: { id: "stored-1", status: "in_progress" } })], true);
    return Response.json({ id: "stored-1", status: "completed", model: "grok-4.7", output_text: "回収した調査結果", usage: { input_tokens: 100, output_tokens: 20 } });
  };
  try {
    const result = await requestJson("https://api.x.ai/v1/responses", "test-secret", { model: "grok-4.7", stream: true }, false, { costDb: db, userId: "test", operation: "social_recent" });
    assert.equal(result.text, "回収した調査結果");
    assert.deepEqual(requests.map(r => r.method), ["POST", "GET"]);
    assert.equal(requests[1].url, "https://api.x.ai/v1/responses/stored-1");
    assert.equal(updates[0].request_metadata.provider_response_id, "stored-1");
    assert.equal(updates.at(-1).measurement_status, "complete");
    assert.ok(updates.at(-1).list_price_usd > 0);
    assert.equal(updates.at(-1).request_metadata.reconciliation_status, "recovered");
  } finally { globalThis.fetch = oldFetch; }
});

Deno.test("terminal provider failure retains billable usage instead of forcing zero", async () => {
  const updates: any[] = [];
  const db = { from: () => ({ insert: async () => ({ error: null }), update: (row: any) => ({ eq: () => ({ eq: async () => { updates.push(row); return { error: null }; } }) }) }) };
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ status: "failed", usage: { input_tokens: 100, output_tokens: 20 } });
  try {
    await assert.rejects(() => requestJson("https://api.x.ai/v1/responses", "test-secret", { model: "grok-4.7" }, false, { costDb: db, userId: "test", operation: "social_recent" }), /完了しません/);
    assert.equal(updates.at(-1).request_status, "failed");
    assert.ok(updates.at(-1).list_price_usd > 0);
  } finally { globalThis.fetch = oldFetch; }
});

Deno.test("reconciliation scopes updates to owner and unknown status, preserves historical links and date", async () => {
  const oldFetch = globalThis.fetch, oldKey = Deno.env.get("XAI_API_KEY");
  Deno.env.set("XAI_API_KEY", "test-key");
  const writes: any[] = [], filters: any[] = [], requests: string[] = [];
  const db = { from: () => ({ update: (row: any) => { writes.push(row); const q = { eq: (key: string, value: string): any => { filters.push([key, value]); return q; }, then: (resolve: any) => Promise.resolve({ error: null }).then(resolve) }; return q; } }) };
  const base = { id: "fee-1", user_id: "owner", provider: "xAI", model: "grok-4.7", request_status: "unknown", list_price_usd: null,
    created_at: "2026-10-31T00:00:00Z", pricing_as_of: "2026-10-31", request_metadata: { provider_response_id: "stored-1" } };
  globalThis.fetch = async (url) => { requests.push(String(url)); return Response.json({ id: "stored-1", status: "completed", usage: { input_tokens: 100, output_tokens: 20 } }); };
  try {
    await reconcileCosts(db, "owner", [base, { ...base, user_id: "other" }, { ...base, request_status: "succeeded" }, { ...base, request_metadata: { provider_response_id: "already-checked", reconciliation_checked_at: new Date().toISOString() } }]);
    assert.equal(requests.length, 1);
    assert.equal(writes[0].request_status, "succeeded");
    assert.ok(writes[0].list_price_usd > 0);
    assert.deepEqual(filters, [["id", "fee-1"], ["user_id", "owner"], ["request_status", "unknown"]]);
    assert.equal("report_id" in writes[0], false);
    assert.equal("pricing_as_of" in writes[0], false);
  } finally { globalThis.fetch = oldFetch; if (oldKey === undefined) Deno.env.delete("XAI_API_KEY"); else Deno.env.set("XAI_API_KEY", oldKey); }
});

Deno.test("missing stored response remains uncertain, never a zero-cost success", async () => {
  const oldFetch = globalThis.fetch, oldKey = Deno.env.get("XAI_API_KEY");
  Deno.env.set("XAI_API_KEY", "test-key");
  let written: any;
  const db = { from: () => ({ update: (row: any) => { written = row; const q = { eq: (): any => q, then: (resolve: any) => Promise.resolve({ error: null }).then(resolve) }; return q; } }) };
  globalThis.fetch = async () => new Response(null, { status: 404 });
  try {
    await reconcileCosts(db, "owner", [{ id: "fee-1", user_id: "owner", provider: "xAI", request_status: "unknown", list_price_usd: null, created_at: "2026-10-31T00:00:00Z", request_metadata: { provider_response_id: "stored-1" } }]);
    assert.equal(written.request_metadata.reconciliation_status, "not_found");
    assert.equal("list_price_usd" in written, false);
    assert.equal("request_status" in written, false);
  } finally { globalThis.fetch = oldFetch; if (oldKey === undefined) Deno.env.delete("XAI_API_KEY"); else Deno.env.set("XAI_API_KEY", oldKey); }
});
