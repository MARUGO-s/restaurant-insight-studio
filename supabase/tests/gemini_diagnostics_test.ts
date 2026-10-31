import { strict as assert } from "node:assert";
import { diagnoseGemini, geminiResearch, providerDiagnostics, quotaDiagnostics, requireResearchProviders, queueAnalysis, requestJson } from "../functions/restaurant-analysis/core.ts";

const quotaError = {
  code: 429, status: "RESOURCE_EXHAUSTED", message: "You exceeded your current quota. ".repeat(30),
  details: [
    { "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_requests", quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier", quotaValue: 0, quotaDimensions: { model: "gemini-3.8-flash", location: "global" } }] },
    { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "RATE_LIMIT_EXCEEDED", metadata: { consumer: "projects/123456789", arbitrary_secret: "must-not-persist" } },
    { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "60.5s" },
  ],
};
function database(count = 0) {
  const inserts: any[] = [], updates: any[] = [];
  return { inserts, updates, db: { from: () => ({
    insert: async (row: any) => { inserts.push(row); return { error: null }; },
    update: (row: any) => ({ eq: () => ({ eq: async () => { updates.push(row); return { error: null }; } }) }),
    select: () => ({ eq: () => ({ eq: () => ({ gte: async () => ({ count, error: null }) }) }) }),
  }) } };
}
function keys() {
  const names = ["OPENAI_API_KEY", "GEMINI_API_KEY", "XAI_API_KEY", "GEMINI_MODEL"];
  const originals = names.map(name => Deno.env.get(name));
  Deno.env.set("OPENAI_API_KEY", "test-openai"); Deno.env.set("GEMINI_API_KEY", "test-gemini-secret-ABCD"); Deno.env.set("XAI_API_KEY", "test-xai"); Deno.env.set("GEMINI_MODEL", "gemini-3.8-flash");
  return () => names.forEach((name, i) => originals[i] === undefined ? Deno.env.delete(name) : Deno.env.set(name, originals[i]!));
}
Deno.test("Gemini diagnostics preserve zero quotas, project, model and RetryInfo without arbitrary metadata", () => {
  const diagnostics = providerDiagnostics(quotaError, 429);
  assert.equal(diagnostics.violations?.[0].quotaValue, 0);
  assert.equal(diagnostics.violations?.[0].quotaId, "GenerateRequestsPerDayPerProjectPerModel-FreeTier");
  assert.equal(diagnostics.reasons?.[0].consumer, "projects/123456789");
  assert.equal(diagnostics.retry_after_seconds, 61);
  assert.ok(quotaDiagnostics(diagnostics).includes("上限=0"));
  assert.equal(JSON.stringify(diagnostics).includes("must-not-persist"), false);
});
Deno.test("Gemini quota failure is recorded with diagnostics and never calls OpenAI fallback", async () => {
  const restore = keys(), oldFetch = globalThis.fetch, calls: string[] = [], { db, updates } = database();
  globalThis.fetch = async (url, options) => {
    calls.push(String(url));
    assert.equal(String(url).includes("key="), false);
    assert.equal(new Headers(options?.headers).get("x-goog-api-key"), "test-gemini-secret-ABCD");
    const payload = JSON.parse(String(options?.body));
    assert.equal(payload.generationConfig.maxOutputTokens, 32768);
    assert.deepEqual(payload.generationConfig.thinkingConfig, { thinkingLevel: "medium" });
    return Response.json({ error: quotaError }, { status: 429 });
  };
  try {
    const agent = await geminiResearch("媒体調査", { costDb: db, userId: "owner", operation: "gourmet_research" });
    assert.equal(calls.length, 1); assert.ok(calls[0].includes("generativelanguage.googleapis.com"));
    assert.equal(agent.provider, "Google Gemini"); assert.equal(agent.status, "error");
    assert.ok(agent.error?.includes("上限=0")); assert.ok(agent.error?.includes("project=projects/123456789"));
    assert.equal(updates[0].request_metadata.provider_error.violations[0].quotaValue, 0);
    assert.equal(updates[0].request_metadata.timeout_ms, 300000);
    assert.equal(updates[0].request_status, "failed");
    assert.equal(JSON.stringify(updates).includes("test-gemini-secret"), false);
  } finally { globalThis.fetch = oldFetch; restore(); }
});
Deno.test("diagnostic uses the real model and search configuration while only exposing masked key suffix", async () => {
  const restore = keys(), oldFetch = globalThis.fetch, { db, inserts, updates } = database();
  globalThis.fetch = async (url, options) => {
    assert.ok(String(url).includes("models/gemini-3.8-flash:generateContent"));
    const body = JSON.parse(String(options?.body));
    assert.deepEqual(body.tools, [{ google_search: {} }]); assert.equal(body.generationConfig.maxOutputTokens, 256);
    return Response.json({ candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [] } }], usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 0, thoughtsTokenCount: 256 } });
  };
  try {
    const result = await diagnoseGemini(db, "owner");
    assert.equal(result.ok, true); assert.equal(result.keySuffix, "ABCD");
    assert.equal(result.partial, true); assert.ok(result.costId);
    assert.equal(inserts[0].operation, "provider_diagnostic");
    assert.equal(updates[0].request_status, "succeeded");
    assert.equal(JSON.stringify(result).includes("test-gemini-secret"), false);
  } finally { globalThis.fetch = oldFetch; restore(); }
});
Deno.test("diagnostic rate limit prevents repeated provider calls and returned errors redact secrets", async () => {
  const restore = keys(), oldFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ error: { ...quotaError, message: "invalid key test-gemini-secret-ABCD" } }, { status: 429 }); };
  try {
    const blocked = await diagnoseGemini(database(1).db, "owner");
    assert.equal(blocked.ok, false); assert.equal(calls, 0);
    const failed = await diagnoseGemini(database().db, "owner");
    assert.equal(failed.ok, false); assert.ok(failed.costId);
    assert.equal(failed.diagnostics?.violations?.[0].quotaValue, 0);
    assert.equal(JSON.stringify(failed).includes("test-gemini-secret-ABCD"), false);
  } finally { globalThis.fetch = oldFetch; restore(); }
});
Deno.test("normal research still rejects an empty successful response", async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ candidates: [{ content: { parts: [] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 0 } });
  try { await assert.rejects(() => requestJson("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent", "test", {}, true, { costDb: database().db, userId: "owner", operation: "gourmet_research" }), /AIから調査結果/); }
  finally { globalThis.fetch = oldFetch; }
});
Deno.test("three independent providers are required for synthesis and missing Gemini key blocks queueing", async () => {
  const complete = [{ id: "market", provider: "OpenAI · GPT-6.1 Terra", status: "done" as const, text: "市場", sources: [] }, { id: "gourmet", provider: "Google Gemini", status: "done" as const, text: "媒体", sources: [] }, { id: "social", provider: "xAI Grok", status: "done" as const, text: "X", sources: [] }];
  requireResearchProviders(complete);
  assert.throws(() => requireResearchProviders(complete.map(agent => agent.id === "gourmet" ? { ...agent, provider: "OpenAI · GPT-6.1 Terra（Gemini代替）" } : agent)), /3社すべて/);
  assert.throws(() => requireResearchProviders(complete.slice(0, 2)), /3社すべて/);
  const restore = keys(); Deno.env.delete("GEMINI_API_KEY");
  try {
    await assert.rejects(() => queueAnalysis({ from: () => { throw new Error("Should not write"); } }, "owner", { storeName: "店", storeUrl: "https://example.test", selectedSites: [{ id: "tabelog", name: "食べログ", url: "" }] }), /3社のAPIキー/);
  } finally { restore(); }
});

Deno.test("Gemini truncated output preserves completion and token counters without retaining hidden text", async () => {
  const oldFetch = globalThis.fetch, { db, updates } = database();
  globalThis.fetch = async () => Response.json({ candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ thought: true, text: "PRIVATE THINKING" }, { text: "途中の調査ノート" }] } }],
    usageMetadata: { promptTokenCount: 1000, thoughtsTokenCount: 6000, totalTokenCount: 10000, arbitrary_private_field: "PRIVATE METADATA" } });
  try {
    const result = await requestJson("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent", "test-key", {}, true, { costDb: db, userId: "owner", operation: "gourmet_research" }, 300000, true);
    assert.equal(result.partial, true);
    assert.equal(result.text, "途中の調査ノート");
    assert.deepEqual(updates[0].request_metadata.finish_reasons, ["MAX_TOKENS"]);
    assert.deepEqual(updates[0].request_metadata.usage_counts, { promptTokenCount: 1000, thoughtsTokenCount: 6000, totalTokenCount: 10000 });
    assert.equal(updates[0].usage.output_tokens, null); // Missing billing fields are not invented.
    assert.equal(JSON.stringify(updates).includes("PRIVATE"), false);
  } finally { globalThis.fetch = oldFetch; }
});
