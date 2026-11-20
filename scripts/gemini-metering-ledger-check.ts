import { strict as assert } from "node:assert";
import { createClient } from "npm:@supabase/supabase-js@2.116.0";
import { geminiResearch } from "../supabase/functions/restaurant-analysis/core.ts";

const databaseUrl = "https://supabase-test.example.invalid";
const ledgerUrl = databaseUrl + "/rest/v1/restaurant_insight_cost_events";
const providerUrl = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent";
const userId = "aaaaaaaa-0000-4000-8000-000000000001";
const reportId = "aaaaaaaa-0000-4000-8000-000000000002";
const recordedAt = "2026-11-20T04:31:24.613Z";
const usageMetadata = {
  promptTokenCount: 4860,
  cachedContentTokenCount: 2934,
  candidatesTokenCount: 7199,
  thoughtsTokenCount: 2949,
  totalTokenCount: 15008,
};
const usageWithTool = { ...usageMetadata, promptTokenCount: 4859, toolUsePromptTokenCount: 1 };
const [rentalQuery, courseQuery, storeQuery] = ["Bistro CAVA CAVA 貸切", "Bistro CAVA CAVA コース", "ビストロ サヴァサヴァ 店舗情報"];
const cases = [
  { label: "seven_distinct", queries: [[rentalQuery, courseQuery, storeQuery, "営業時間", "個室"], ["口コミ", "予約"]], count: 7, cost: 0.13771955 },
  { label: "seven_with_blank_and_duplicates", queries: [[rentalQuery, "", courseQuery, rentalQuery], ["\t　 ", ` ${courseQuery}  `, storeQuery]], count: 3, cost: 0.08171955 },
  { label: "three_distinct", queries: [[rentalQuery, courseQuery, storeQuery]], count: 3, cost: 0.08171955 },
  { label: "all_blank", queries: [["", "\t\n", "　"]], usage: usageWithTool, count: 0, cost: 0.03971955 },
  { label: "missing_search_metadata", queries: [undefined], count: null, cost: null },
];

async function checkLedger(scenario: typeof cases[number]) {
  const calls: string[] = [];
  const rows = new Map<string, Record<string, unknown>>();
  const transport: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.href === providerUrl) {
      assert.equal(request.method, "POST");
      assert.equal(request.headers.get("x-goog-api-key"), "offline-test-key");
      assert.equal(rows.size, 1);
      assert.equal([...rows.values()][0].request_status, "unknown");
      calls.push("synthetic Gemini response");
      return Response.json({ model: "gemini-3.8-flash", usageMetadata: scenario.usage ?? usageMetadata,
        candidates: scenario.queries.map((webSearchQueries, index) => ({
          finishReason: "STOP",
          ...(webSearchQueries && { groundingMetadata: { webSearchQueries } }),
          ...(index === 0 ? { content: { parts: [{ text: "掲載調査の検証用データです。\n<MENU_INVENTORY>[]</MENU_INVENTORY>" }] } } : {}),
        })),
      });
    }

    assert.equal(url.origin + url.pathname, ledgerUrl, "Unexpected outbound request");
    const body = await request.json();
    if (request.method === "POST") {
      assert.equal(body.operation, "gourmet_research");
      assert.equal(body.user_id, userId);
      assert.equal(body.report_id, reportId);
      assert.equal(body.list_price_usd, null);
      assert.equal(rows.size, 0);
      rows.set(body.id, { ...body, created_at: recordedAt });
      calls.push("ledger insert");
      return new Response(null, { status: 201 });
    }

    assert.equal(request.method, "PATCH");
    const [id] = rows.keys();
    assert.ok(id);
    assert.equal(url.searchParams.get("id"), `eq.${id}`);
    assert.equal(url.searchParams.get("user_id"), `eq.${userId}`);
    assert.equal(body.request_status, "succeeded");
    assert.equal(body.measurement_status, scenario.cost === null ? "partial" : "complete");
    assert.equal(body.request_metadata.google_search_enabled, true);
    assert.equal(body.pricing_as_of, "2026-11-20");
    assert.equal(body.usage.google_search_queries, scenario.count);
    assert.equal(body.usage.input_tokens, 4860);
    assert.equal(body.usage.cached_input_tokens, 2934);
    assert.equal(body.usage.output_tokens, 10148);
    assert.equal(body.rates.google_search_usd_per_query, 0.014);
    if (scenario.cost === null) assert.equal(body.list_price_usd, null);
    else assert.ok(Math.abs(body.list_price_usd - scenario.cost) < 1e-10);
    rows.set(id, { ...rows.get(id), ...body });
    calls.push("ledger update");
    return new Response(null, { status: 204 });
  };

  const costDb = createClient(databaseUrl, "offline-db-key", {
    global: { fetch: transport },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  globalThis.fetch = transport;
  const result = await geminiResearch("Bistro CAVA CAVAの掲載情報を確認する検証用の調査です。", {
    costDb, userId, reportId, operation: "gourmet_research", attempt: 1,
  });
  assert.equal(result.status, "done", result.error);
  assert.deepEqual(calls, ["ledger insert", "synthetic Gemini response", "ledger update"]);
  assert.equal(rows.size, 1);
  const [row] = rows.values();
  for (const term of [rentalQuery, courseQuery, storeQuery]) assert.ok(!JSON.stringify(row).includes(term));
  return { label: scenario.label, row };
}

assert.equal((await Deno.permissions.query({ name: "net" })).state, "denied");
const nativeFetch = globalThis.fetch;
const NativeDate = Date;
// Reproduce the original pricing date even after the scheduled rate change.
globalThis.Date = new Proxy(NativeDate, {
  construct: (target, args) => Reflect.construct(target, args.length ? args : [recordedAt]),
});
try {
  const results = [];
  for (const scenario of cases) results.push(await checkLedger(scenario));
  console.log(JSON.stringify(results));
} finally {
  globalThis.Date = NativeDate;
  globalThis.fetch = nativeFetch;
}
