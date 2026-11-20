import { strict as assert } from "node:assert";
import { handleApi } from "../functions/restaurant-analysis/core.ts";
import { handlePublicReportShare } from "../functions/restaurant-report-share/handler.ts";

const url = "https://offline.invalid/functions/v1/restaurant-report-share";
const token = "a".repeat(64);
const request = (method = "GET", value = token) => new Request(url, { method, headers: { "X-Report-Share-Token": value } });

Deno.test("the public endpoint only looks up well-formed header tokens and forbids mutations", async () => {
  let lookups = 0;
  const lookup = () => { lookups++; return Promise.resolve(null); };
  for (const invalid of ["", "a".repeat(63), "X".repeat(64), "<html>"]) {
    assert.equal((await handlePublicReportShare(request("GET", invalid), lookup)).status, 404);
  }
  assert.equal((await handlePublicReportShare(new Request(`${url}?token=${token}`), lookup)).status, 404);
  const options = await handlePublicReportShare(request("OPTIONS"), lookup);
  assert.equal(options.status, 204);
  assert.equal(options.headers.get("Access-Control-Allow-Headers"), "x-report-share-token");
  assert.equal((await handlePublicReportShare(request("POST"), lookup)).status, 405);
  assert.equal((await handlePublicReportShare(request("DELETE"), lookup)).status, 405);
  assert.equal(lookups, 0);
  assert.equal((await handlePublicReportShare(request(), lookup)).status, 404);
  assert.equal(lookups, 1);
});

Deno.test("shared payload preserves the integrated report without revealing source notes or account metadata", async () => {
  const share = await handlePublicReportShare(request(), (value) => {
    assert.equal(value, token);
    return Promise.resolve({
      storeName: "外部閲覧テスト", createdAt: "2026-11-20T06:00:00Z", userId: "do not expose", agents: "do not expose",
      reportSources: ["https://example.test/source", "javascript:alert(1)", "https://user:password@example.test/"],
      report: `\u0060\u0060\u0060json\n${JSON.stringify({ critique: "do not expose", report: {
        keyFindings: [{ title: "確認事項", unseen: "do not expose", sources: ["https://example.test/source"] }],
        actionPlan: [{ action: "確認する", steps: ["手順一", { hidden: "do not expose" }] }],
        detailSections: [{ title: "詳細", rows: [["費目", 10, { hidden: "do not expose" }]] }],
        productInventory: [{ id: "M2", name: "コース", reviewStatus: "confirmed", anotherCopy: "do not expose" }],
        claimReviews: [{ claim: "do not expose" }], originalProductInventory: [{ name: "do not expose" }],
        researchFocus: "do not expose", apiCosts: "do not expose",
        qualityGate: { version: 3, debug: "do not expose" },
      } })}\n\u0060\u0060\u0060`,
    });
  });
  assert.equal(share.status, 200);
  assert.equal(share.headers.get("Cache-Control"), "no-store");
  assert.equal(share.headers.get("Referrer-Policy"), "no-referrer");
  assert.match(share.headers.get("X-Robots-Tag") ?? "", /noindex/);
  const body = await share.json();
  assert.deepEqual(Object.keys(body).sort(), ["createdAt", "report", "reportSources", "storeName"]);
  assert.deepEqual(body.reportSources, ["https://example.test/source"]);
  assert.ok(!body.report.includes("do not expose"));
  const document = JSON.parse(body.report);
  assert.equal(document.keyFindings[0].title, "確認事項");
  assert.equal(document.productInventory[0].name, "コース");
  assert.deepEqual(document.actionPlan[0].steps, ["手順一"]);
  assert.deepEqual(document.detailSections[0].rows, [["費目", 10, ""]]);
  assert.deepEqual(document.qualityGate, { version: 3 });
});

Deno.test("legacy Markdown is viewable and structured data failures keep diagnostics private", async () => {
  const row = (report: string) => Promise.resolve({ createdAt: "2026-11-20T06:00:00Z", storeName: "店", report });
  const legacy = "# レポート\n本文";
  const response = await handlePublicReportShare(request(), () => row(legacy));
  assert.equal((await response.json()).report, legacy);
  for (const report of ['{"private"', '{"debug":"private"}']) {
    assert.equal((await handlePublicReportShare(request(), () => row(report))).status, 404);
  }
  const unavailable = await handlePublicReportShare(request(), () => Promise.reject(new Error(token)));
  assert.equal(unavailable.status, 503);
  assert.ok(!(await unavailable.text()).includes(token));
});

Deno.test("share management binds to the authenticated owner and generates a fresh 256-bit token server-side", async () => {
  const owner = "4257d73b-e8f4-48a7-a868-0e2191671929";
  const report = "dce913cd-908a-415a-8032-c33cf561f9f7";
  const settings = { SUPABASE_URL: "https://offline.invalid", SUPABASE_ANON_KEY: "offline-public", SUPABASE_SERVICE_ROLE_KEY: "offline-service", SUPABASE_PUBLISHABLE_KEYS: "{}" };
  const savedEnv = Object.keys(settings).map((key) => [key, Deno.env.get(key)] as const);
  const savedFetch = globalThis.fetch;
  const calls: Record<string, unknown>[] = [];
  let active: string | null = null;
  for (const [key, value] of Object.entries(settings)) Deno.env.set(key, value);
  globalThis.fetch = (target, options) => {
    const path = new URL(String(target)).pathname;
    if (path === "/auth/v1/user") return Promise.resolve(Response.json({ id: owner }));
    assert.equal(path, "/rest/v1/rpc/restaurant_insight_manage_report_share");
    assert.equal(new Headers(options?.headers).get("apikey"), settings.SUPABASE_SERVICE_ROLE_KEY);
    const args = JSON.parse(String(options?.body));
    calls.push(args);
    if (args.p_report_id !== report) return Promise.resolve(Response.json(null));
    if (args.p_action === "create") active ??= args.p_token;
    if (args.p_action === "revoke") active = null;
    return Promise.resolve(Response.json({ token: active, internal: "do not expose" }));
  };
  const authRequest = (action: string, reportId = report, authorization = "Bearer offline-user") => new Request(url, {
    method: "POST", headers: { Authorization: authorization },
    body: JSON.stringify({ action, reportId, userId: "other owner", token }),
  });
  try {
    assert.equal((await handleApi(authRequest("create_report_share", report, ""))).status, 401);
    assert.equal((await handleApi(authRequest("create_report_share", "invalid-id"))).status, 400);
    assert.equal(calls.length, 0);
    assert.deepEqual(await (await handleApi(authRequest("report_share_status"))).json(), { token: null });
    const created = await (await handleApi(authRequest("create_report_share"))).json();
    assert.match(created.token, /^[0-9a-f]{64}$/);
    assert.notEqual(created.token, token);
    assert.deepEqual(Object.keys(created), ["token"]);
    assert.deepEqual(await (await handleApi(authRequest("create_report_share"))).json(), created);
    assert.notEqual(calls[1].p_token, calls[2].p_token);
    assert.equal((await handleApi(authRequest("report_share_status", owner))).status, 404);
    assert.deepEqual(await (await handleApi(authRequest("revoke_report_share"))).json(), { token: null });
    assert.ok(calls.every((call) => call.p_user_id === owner));
  } finally {
    globalThis.fetch = savedFetch;
    for (const [key, value] of savedEnv) if (value === undefined) Deno.env.delete(key); else Deno.env.set(key, value);
  }
});
