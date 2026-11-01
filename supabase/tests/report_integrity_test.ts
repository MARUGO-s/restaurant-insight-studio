import { strict as assert } from "node:assert";
import { finalizeSynthesis, synthesize, NonBillableSynthesisError, buildResearchPrompts, buildSynthesisPrompt } from "../functions/restaurant-analysis/core.ts";
import { evidenceUrl, qualityInput, qualityReport } from "./report_quality_fixture.ts";

export const integrityAgents = () => [
  { id: "market", provider: "OpenAI", status: "done" as const, text: "公式の人数条件は未確認。", sources: [evidenceUrl] },
  { id: "gourmet", provider: "Google Gemini", status: "done" as const, text: "注文が通りにくい。予約で離脱しやすい。", sources: [evidenceUrl], menuInventory: [] as any[] },
  { id: "social", provider: "xAI Grok", status: "done" as const, text: "読めた投稿は限定的。", sources: [] },
];
export function integrityReport(): any {
  const base = qualityReport();
  return { ...base, keyFindings: base.keyFindings.map(f => ({ ...f, scope: "verification" })),
    actionPlan: base.actionPlan.map(a => ({ ...a, scope: "verification" })), claimReviews: integrityAgents().map(a => ({ agentId: a.id, claim: a.text,
    decision: "unverified", reason: "個別の根拠が不足。断定は採用しない。", sources: [] })), productReviews: [] };
}
const draft = (report: any) => ({ version: 1 as const, requiredReportVersion: 3 as const, text: JSON.stringify({ critique: "根拠不足の断定は不採用", report }),
  toolSources: [evidenceUrl], costId: "cost", responseId: "response", responseStatus: "completed" as const });
const finish = (report = integrityReport(), agents = integrityAgents()) => finalizeSynthesis(qualityInput, agents, draft(report));

Deno.test("synthesis prompt supplies recorded source URLs rather than requiring guessed citation reconstruction", () => {
  const agents = integrityAgents();
  const recorded = "https://example.test/articles/unique-recorded-source?edition=2";
  agents[1].sources.push(recorded);
  const prompt = buildSynthesisPrompt(qualityInput, agents);
  assert.ok(prompt.includes(JSON.stringify(recorded)));
  assert.match(prompt, /出典URL台帳/);
  assert.match(prompt, /ドメイン.*記事番号.*組み替え/);
  assert.match(prompt, /未記録.*取得.*出典/);
});

Deno.test("v3 requires per-agent verbatim claim reviews, decisions and traceable evidence", async () => {
  const r = integrityReport(); delete r.claimReviews;
  await assert.rejects(() => finish(r), /claimReviews/);
  for (const mutate of [
    (r: any) => r.claimReviews.pop(),
    (r: any) => { r.claimReviews[1].agentId = "unknown"; },
    (r: any) => { r.claimReviews[1].claim = "モデルが作った要約"; },
    (r: any) => { r.claimReviews[1].reason = ""; },
    (r: any) => { r.claimReviews[1].decision = "verified"; },
    (r: any) => { r.claimReviews[1].decision = "supported"; },
    (r: any) => { r.claimReviews[1].decision = "conditional"; r.claimReviews[1].sources = ["https://invented.test/"]; },
    (r: any) => { r.claimReviews.push(r.claimReviews[1]); },
  ]) { const bad = integrityReport(); mutate(bad); await assert.rejects(() => finish(bad), /claimReviews/); }
  const ok = await finish();
  assert.deepEqual(JSON.parse(ok.report_row.report).claimReviews, integrityReport().claimReviews);
  assert.equal(JSON.parse(ok.report_row.report).qualityGate.version, 3);
});

Deno.test("paired bold omissions restore the same agent raw quotation without changing the original draft", async () => {
  const agents = integrityAgents(), report = integrityReport();
  const raw = "対象は、新宿 **1階**の店舗です。\n一覧は**2026年10月27日更新、3件掲載**。";
  agents[0].text = raw;
  report.claimReviews[0].claim = raw.replaceAll("**", "");
  const original = draft(report), snapshot = structuredClone({ agents, original, report });
  const result = await finalizeSynthesis(qualityInput, agents, original);
  const saved = JSON.parse(result.report_row.report);
  assert.equal(saved.claimReviews[0].claim, raw);
  assert.equal(saved.qualityGate.version, 3);
  assert.deepEqual({ agents, original, report }, snapshot);
  assert.deepEqual(result.synthesisDraft, original);
  assert.deepEqual(result.report_row.agents, agents);
  assert.deepEqual(saved.qualityGate.claimQuotationRecovery.corrections, [{ path: "claimReviews[0].claim", agentId: "market",
    kind: "paired_bold_delimiters", originalQuotation: report.claimReviews[0].claim, restoredQuotation: raw }]);
  assert.equal(saved.qualityGate.claimQuotationRecovery.additionalGenerations, 0);
  const content = structuredClone(saved);
  delete content.qualityGate; delete content.productInventory; delete content.originalProductInventory;
  assert.deepEqual(content, { ...report, claimReviews: report.claimReviews.map((r: any, index: number) => index ? r : { ...r, claim: raw }) });
});

Deno.test("claim validation identifies every invalid review field and missing agent", async () => {
  const cases: [string, (r: any) => void][] = [
    ["claimReviews[1]", r => { r.claimReviews[1] = null; }],
    ["claimReviews[1].agentId", r => { r.claimReviews[1].agentId = "unknown"; }],
    ["claimReviews[1].claim", r => { r.claimReviews[1].claim = ""; }],
    ["claimReviews[1].claim", r => { r.claimReviews[1].claim = "異なる主張"; }],
    ["claimReviews[1].decision", r => { r.claimReviews[1].decision = "invalid"; }],
    ["claimReviews[1].reason", r => { r.claimReviews[1].reason = ""; }],
    ["claimReviews[1].sources", r => { r.claimReviews[1].sources = ["https://unknown.test/"]; }],
    ["claimReviews[1].sources", r => { r.claimReviews[1].sources = null; }],
    ["claimReviews[1].sources", r => { r.claimReviews[1].decision = "supported"; }],
    ["claimReviews[3].claim", r => { r.claimReviews.push(r.claimReviews[1]); }],
    ["social", r => { r.claimReviews.pop(); }],
  ];
  for (const [path, mutate] of cases) {
    const r = integrityReport(); mutate(r);
    await assert.rejects(() => finish(r), (error: Error) => { assert.ok(error.message.includes(path), error.message); return true; });
  }
  const r = integrityReport(); r.claimReviews[0].claim = "不一致"; r.claimReviews[1].reason = "";
  await assert.rejects(() => finish(r), (error: Error) => {
    assert.ok(error.message.includes("claimReviews[0].claim")); assert.ok(error.message.includes("claimReviews[1].reason")); return true;
  });
});

Deno.test("restored Markdown cannot bypass a confirmed-finding contradiction", async () => {
  for (const decision of ["unverified", "rejected", "conditional"]) {
    for (const exact of [false, true]) {
      const agents = integrityAgents(), r = integrityReport();
      agents[1].text = "店舗では**予約で離脱しやすい**。";
      r.claimReviews[1].claim = exact ? agents[1].text : "店舗では予約で離脱しやすい。";
      r.claimReviews[1].decision = decision;
      r.claimReviews[1].sources = decision === "conditional" ? [evidenceUrl] : [];
      r.keyFindings[0].issue = "店舗では予約で離脱しやすい。";
      r.keyFindings[0].confidence = "confirmed";
      await assert.rejects(() => finish(r, agents), /claimReviews\[1\]\.claim.*未採用.*断定/);
    }
  }
});

Deno.test("v3 rejects missing scope and mixed finding/action classifications", async () => {
  for (const scope of [undefined, "technical", "store", "research"]) {
    const r = integrityReport(); r.actionPlan[0].scope = scope;
    await assert.rejects(() => finish(r), /scope/);
  }
  const r = integrityReport(); delete r.keyFindings[0].scope;
  await assert.rejects(() => finish(r), /scope/);
  r.keyFindings[0].scope = r.actionPlan[0].scope = "research";
  r.keyFindings[0].title = "調査URLの修正と旧データとの差分確認";
  assert.equal(JSON.parse((await finish(r)).report_row.report).actionPlan[0].scope, "research");
});

Deno.test("unverified or rejected specialist assertion cannot return as a confirmed finding", async () => {
  for (const decision of ["unverified", "rejected", "conditional"]) {
    const r = integrityReport(); r.claimReviews[1].decision = decision;
    r.claimReviews[1].sources = decision === "conditional" ? [evidenceUrl] : [];
    r.keyFindings[0].issue = "注文が通りにくい。";
    r.keyFindings[0].confidence = "confirmed";
    await assert.rejects(() => finish(r), /未採用.*断定/);
  }
  const r = integrityReport(); r.claimReviews[1].decision = "supported"; r.claimReviews[1].sources = [evidenceUrl];
  r.keyFindings[0].issue = "注文が通りにくい。"; r.keyFindings[0].confidence = "confirmed";
  const saved = JSON.parse((await finish(r)).report_row.report);
  assert.match(saved.qualityGate.limitation, /意味一致.*証明するものではありません/);
});

function inventoryCase() {
  const agents = integrityAgents();
  agents[1].sources.push("https://gorp.jp/example/course");
  agents[1].menuInventory! = ["M1", "M2", "M3", "M4"].map(id => ({ id, name: `貸切${id}`, price: "8000円税込・1人", conditions: "20〜60人", site: "Google マップ（gorp.jp連携）", source: "https://gorp.jp/example/course" }));
  // A correctly labelled second item exercises confirmed independently.
  agents[1].menuInventory![1].site = "gorp.jp";
  const report = integrityReport();
  report.productReviews = agents[1].menuInventory!.map((m, i) => ({ id: m.id, status: ["corrected", "confirmed", "unverified", "rejected"][i],
    reason: i === 0 ? "gorp.jpのページでGoogle媒体ではない" : "個別に審査した理由", sources: i < 2 ? [m.source] : [],
    ...(i === 0 ? { corrected: { name: m.name, price: m.price, conditions: m.conditions, site: "gorp.jp", source: m.source } } : {}) }));
  return { report, agents };
}
Deno.test("reviewed inventory applies corrections and preserves every original without model overwrite", async () => {
  const { report, agents } = inventoryCase(), original = structuredClone(agents[1].menuInventory!);
  report.productInventory = [{ id: "fake", site: "Google" }];
  report.originalProductInventory = [{ source: "https://invented.test/raw" }];
  const saved = JSON.parse((await finish(report, agents)).report_row.report);
  assert.equal(saved.productInventory[0].site, "gorp.jp");
  assert.deepEqual(saved.productInventory.map((m: any) => m.reviewStatus), ["corrected", "confirmed", "unverified", "rejected"]);
  assert.ok(saved.productInventory.every((m: any) => m.reviewReason));
  assert.deepEqual(saved.originalProductInventory, original);
  assert.deepEqual(agents[1].menuInventory!, original);
  assert.equal(saved.productInventory.length, original.length);
});
Deno.test("product review IDs are total and unique; corrections and accepted sources must be traceable", async () => {
  for (const mutate of [
    (r: any) => { delete r.productReviews; }, (r: any) => { r.productReviews.pop(); },
    (r: any) => { r.productReviews.push(r.productReviews[0]); },
    (r: any) => { r.productReviews[0].id = "unknown"; },
    (r: any) => { r.productReviews[0].reason = ""; },
    (r: any) => { delete r.productReviews[0].corrected; },
    (r: any) => { r.productReviews[0].corrected = { site: "gorp.jp" }; },
    (r: any) => { r.productReviews[0].corrected.source = "https://invented.test/"; },
    (r: any) => { r.productReviews[1].sources = []; },
    (r: any) => { r.productReviews[2].corrected = r.productReviews[0].corrected; },
    (r: any) => { r.productReviews[3].sources = ["javascript:alert(1)"]; },
  ]) { const { report, agents } = inventoryCase(); mutate(report); await assert.rejects(() => finish(report, agents), /productReviews/); }
  const { report, agents } = inventoryCase(); agents[1].menuInventory![1].id = "M1";
  await assert.rejects(() => finish(report, agents), /productReviews/);
});

Deno.test("known gorp URL cannot be accepted as Google Maps merely by marking a product confirmed", async () => {
  for (const status of ["confirmed", "corrected"]) {
    const { report, agents } = inventoryCase();
    const review = report.productReviews[0]; review.status = status;
    if (status === "confirmed") delete review.corrected;
    else review.corrected.site = "Google マップ（gorp.jp連携）";
    await assert.rejects(() => finish(report, agents), /productReviews.*媒体/);
  }
});

Deno.test("legacy completed drafts retain their original inventory/source contract without new review requirements", async () => {
  const agents = integrityAgents();
  agents[1].menuInventory = [{ id: "M1", name: "旧商品", price: "8000円", conditions: "未確認", site: "元媒体表記", source: "https://legacy.test/menu" }];
  const { requiredReportVersion: _newGate, ...legacy } = draft(qualityReport());
  const saved = await finalizeSynthesis(qualityInput, agents, legacy);
  const report = JSON.parse(saved.report_row.report);
  assert.equal(report.qualityGate.version, 2);
  assert.deepEqual(report.productInventory, agents[1].menuInventory);
  assert.equal(Object.hasOwn(report, "originalProductInventory"), false);
  assert.ok(saved.report_row.report_sources.includes("https://legacy.test/menu"));
});

Deno.test("fresh generations cannot opt out of v3; terminal and draft checkpoints retain the server gate on free retry", async () => {
  const oldFetch = globalThis.fetch, checkpoints: any[] = [], costs: any[] = [];
  let calls = 0;
  const db = { from: () => {
    const q: any = { select: () => q, eq: () => q, order: () => q, limit: () => q,
      insert: (row: any) => { costs.push(row); return Promise.resolve({ error: null }); },
      update: (row: any) => { Object.assign(costs[0], row); return q; },
      then: (resolve: any) => Promise.resolve({ data: costs, error: null }).then(resolve) };
    return q;
  } };
  const meter = { costDb: db, userId: "owner", runId: "run", jobId: "job", operation: "fact_check_synthesis", checkpoint: async (c: any) => { checkpoints.push(c); } };
  // Deliberately old-shaped model output, even claiming an old gate version.
  const report = { ...qualityReport(), qualityGate: { version: 2 }, requiredReportVersion: 2 };
  globalThis.fetch = async () => { calls++; return new Response(`data: ${JSON.stringify({ type: "response.completed", response: {
    id: "new-response", status: "completed", output_text: JSON.stringify({ critique: "確認", report }), usage: { input_tokens: 1, output_tokens: 1 },
  } })}\n\n`, { headers: { "Content-Type": "text/event-stream" } }); };
  try {
    await assert.rejects(() => synthesize(qualityInput, integrityAgents(), meter), NonBillableSynthesisError);
    assert.equal(calls, 1);
    const terminal = checkpoints.find(c => c.responseStatus === "completed");
    const journal = checkpoints.find(c => c.synthesisDraft);
    assert.equal(terminal.requiredReportVersion, 3); assert.equal(journal.synthesisDraft.requiredReportVersion, 3);
    for (const saved of [terminal, journal]) {
      await assert.rejects(() => synthesize(qualityInput, integrityAgents(), meter, "", saved), /claimReviews/);
      assert.equal(calls, 1); assert.equal(costs.length, 1);
    }
  } finally { globalThis.fetch = oldFetch; }
});

Deno.test("condition completeness KPI cannot mix checked fields with checked products; legitimate per-product averages remain valid", async () => {
  const r = integrityReport();
  r.actionPlan[0].metric = "条件確認率＝条件欄確認数÷商品数。週次で台帳から計算";
  r.detailSections.find((s: any) => s.id === "measurement").body = "条件確認率＝確認済み商品数÷商品数。全必須条件を満たす商品を数える。";
  await assert.rejects(() => finish(r), /KPI.*単位/);
  r.actionPlan[0].metric = "条件確認率＝確認済み商品数÷商品数。週次で台帳から計算";
  await finish(r);
  r.actionPlan[0].metric = "商品当たり確認条件欄数＝条件欄確認数÷商品数。単位は欄/商品、100%上限ではない";
  await finish(r);
  r.actionPlan[0].metric = "客単価＝売上÷客数。円/人。週次で計算";
  await finish(r);
});

Deno.test("unlabelled action KPI and measurement chapter cannot silently switch counting units", async () => {
  const r = integrityReport();
  r.actionPlan[0].metric = "条件欄確認数÷商品数";
  r.detailSections.find((s: any) => s.id === "measurement").body = "確認済み商品数÷商品数";
  await assert.rejects(() => finish(r), /KPI.*単位/);
  // Counting all required fields is a distinct, dimensionally consistent rate.
  r.actionPlan[0].metric = "条件欄確認数÷対象商品の必須条件欄総数";
  await finish(r);
});

Deno.test("pre-confirmation booking checks cannot promise a completion email or completion screen", async () => {
  for (const stop of ["予約成立前に中止する", "予約を確定せず画面を閉じる", "送信前に停止する"]) {
    const r = integrityReport(); r.actionPlan[0].steps = [stop];
    r.actionPlan[0].verification = "完了メールの到着を確認する";
    await assert.rejects(() => finish(r), /予約検証.*成立前/);
  }
  const r = integrityReport(); r.actionPlan[0].steps = ["予約成立前に中止する"];
  r.actionPlan[0].verification = "入力欄まで確認。完了メールは確認対象外とする。";
  await finish(r);
  r.actionPlan.push({ ...r.actionPlan[0], steps: ["店長の明示許可を得る", "テスト予約を確定する", "完了メールの到着を確認する", "店長がテスト予約を取消し費用と枠を確認する"], verification: "完了メールと取消記録を照合" });
  await finish(r);
});

Deno.test("research and synthesis prompts require evidence receipts, scope, inventory review and coherent feasible measures", () => {
  const input = { ...qualityInput, researchFocus: "割引せず追加予算なしで貸切を改善" };
  for (const prompt of Object.values(buildResearchPrompts(input))) {
    assert.match(prompt, /個別出典/); assert.match(prompt, /予約離脱.*断定/);
    assert.match(prompt, /gorp\.jp/); assert.match(prompt, /research.*verification.*store/);
  }
  const prompt = buildSynthesisPrompt(input, integrityAgents());
  for (const token of ['"claimReviews"', '"agentId"', '"decision"', '"productReviews"', '"corrected"', '"scope":"verification"']) assert.ok(prompt.includes(token), token);
  assert.match(prompt, /逐語/); assert.match(prompt, /原資料との意味一致/);
  assert.match(prompt, /originalProductInventory/); assert.match(prompt, /確認済み商品数/);
  assert.match(prompt, /成立前.*完了メール/); assert.match(prompt, /許可.*取消/);
  assert.match(prompt, /現状維持.*既存.*新設/); assert.match(prompt, /制約適合.*見送り理由/);
  assert.ok(prompt.includes(JSON.stringify(input.researchFocus)));
});
