import { strict as assert } from "node:assert";
import { costExplanation } from "../../src/lib/costs.ts";
const event = { request_status: "unknown", measurement_status: "unknown", list_price_usd: null, usage: {}, request_metadata: { http_status: 200 } };
Deno.test("an interrupted 200 response is uncertain, not missing provider support or free", () => {
  const result = costExplanation(event);
  assert.equal(result.label, "料金未確定");
  assert.match(result.reason, /完了通知/);
  assert.match(result.reason, /0ドルとは限りません/);
});
Deno.test("timeout, token shortage and recovered costs have distinct explanations", () => {
  assert.match(costExplanation({ ...event, request_metadata: { duration_ms: 300001, timeout_ms: 300000 } }).reason, /上限/);
  assert.match(costExplanation({ ...event, request_status: "succeeded", usage: { input_tokens: 100 } }).reason, /トークン数/);
  assert.match(costExplanation({ ...event, request_status: "succeeded", list_price_usd: .1, request_metadata: { reconciliation_status: "recovered" } }).reason, /再取得/);
});
