import { strict as assert } from "node:assert";
import { parseIntegratedReport, validateReportQuality, parseMenuInventory, sourceUrls, reportSourceUrls, buildSynthesisPrompt, synthesize } from "../functions/restaurant-analysis/core.ts";
import { evidenceUrl, qualityInput, qualityReport } from "./report_quality_fixture.ts";
const gate = (report: any, input: any = qualityInput) => validateReportQuality(report, input, [evidenceUrl]);
Deno.test("quality gate rejects formerly accepted empty summary and missing chapters", () => {
  const report = qualityReport(); report.keyFindings = []; report.actionPlan = []; report.detailSections = report.detailSections.slice(0, 1);
  assert.doesNotThrow(() => parseIntegratedReport(JSON.stringify({ critique: "反証", report })));
  assert.throws(() => gate(report), /詳細章が不足.*少なくとも1件/);
});
Deno.test("coverage requires every selected site, explicit unavailable is accepted", () => {
  const report = qualityReport();
  report.researchCoverage[3] = { targetId: "tabelog", site: "食べログ", status: "unavailable", scope: "店舗URLを開いたが本文を取得できなかった", limitation: "掲載状態は判断できない", sources: [] };
  assert.equal(gate(report).version, 2);
  report.researchCoverage.pop(); assert.throws(() => gate(report), /選択媒体すべて/);
});
Deno.test("confirmed findings need traceable citations and actions need real references and completion criteria", () => {
  const report = qualityReport(); report.keyFindings[0].confidence = "confirmed"; report.keyFindings[0].sources = [];
  assert.throws(() => gate(report), /事実区分/);
  report.keyFindings[0].sources = ["https://invented.test/evidence"]; assert.throws(() => gate(report), /事実区分/);
  report.keyFindings[0].sources = [evidenceUrl]; report.actionPlan[0].findingIds = ["F2"]; assert.throws(() => gate(report), /課題ID/);
  report.actionPlan[0].findingIds = ["F1"]; report.actionPlan[0].verification = ""; assert.throws(() => gate(report), /完了確認/);
});
Deno.test("source matching permits stripped tracking but does not equate different query resources", () => {
  const report = qualityReport();
  assert.doesNotThrow(() => validateReportQuality(report, qualityInput, [`${evidenceUrl}?utm_source=openai#conditions`]));
  assert.throws(() => validateReportQuality(report, qualityInput, [`${evidenceUrl}?store_id=OTHER`]), /追跡できない出典/);
});
Deno.test("focus must have its own response and custom target IDs are transmitted verbatim", () => {
  const input = { ...qualityInput, researchFocus: "宴会を重点調査", selectedSites: [{ id: "custom-17619293", name: "独自媒体", url: evidenceUrl }] };
  const prompt = buildSynthesisPrompt(input, [], "詳細章が不足: focus");
  assert.ok(prompt.includes('"targetId":"custom-17619293"')); assert.ok(prompt.includes("前回の構成検査"));
  const report = qualityReport(); assert.throws(() => gate(report, { ...qualityInput, researchFocus: input.researchFocus }), /focus/);
  assert.doesNotThrow(() => gate(qualityReport(true), { ...qualityInput, researchFocus: input.researchFocus }));
});
Deno.test("inventory preserves every acquired premium and party plan independently", () => {
  const plans = ["8500", "5500", "6500", "8000"].map((price, i) => ({ name: `プラン${i}`, price: `${price}円・税込`, conditions: "20〜60人・時間未確認", source: evidenceUrl, site: "食べログ" }));
  const result = parseMenuInventory(`調査本文\n<MENU_INVENTORY>${JSON.stringify(plans)}</MENU_INVENTORY>`);
  assert.equal(result.text, "調査本文"); assert.equal(result.menuInventory.length, 4);
  assert.deepEqual(result.menuInventory.map(item => item.price), plans.map(item => item.price));
  assert.throws(() => parseMenuInventory("途中本文"), /商品一覧/);
  assert.throws(() => parseMenuInventory('<MENU_INVENTORY>[{"name":"途切れ"}</MENU_INVENTORY>'), /商品一覧/);
  assert.deepEqual(parseMenuInventory("取得不可理由\n<MENU_INVENTORY>[]</MENU_INVENTORY>").menuInventory, []);
});
Deno.test("source collection retains more than 40 distinct pages and rejects unsafe protocols", () => {
  const sources = Array.from({ length: 60 }, (_, i) => `https://example.test/page/${i}`);
  assert.equal(sourceUrls(sources.join("\n"), ["javascript:alert(1)", "https://user:password@example.test"]).length, 60);
  assert.ok(reportSourceUrls({ keyFindings: [{ sources: [evidenceUrl] }], detailSections: [{ body: "根拠 https://example.test/body" }] }).includes(evidenceUrl));
});
Deno.test("saved report holds server inventory, excludes unused candidate URLs, and records structural checks", async () => {
  const oldFetch = globalThis.fetch;
  const report = qualityReport();
  (report as any).productInventory = [{ name: "model omitted expensive courses" }];
  const menuInventory = [{ id: "M1", name: "貸切", price: "8000円", conditions: "20〜60人", source: evidenceUrl, site: "食べログ" }];
  globalThis.fetch = async () => new Response(`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output_text: JSON.stringify({ critique: "反証・採否を確認", report }), usage: { input_tokens: 1, output_tokens: 1 } } })}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
  const db = { from: () => ({ insert: async () => ({ error: null }), update: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }) }) };
  try {
    const result = await synthesize(qualityInput, [{ id: "market", provider: "OpenAI", status: "done", text: "市場", sources: [] }, { id: "gourmet", provider: "Google Gemini", status: "done", text: "取得ノート", sources: [evidenceUrl, "https://x.com/unrelated/status/1"], menuInventory }, { id: "social", provider: "xAI Grok", status: "done", text: "X調査", sources: [] }], { costDb: db, userId: "owner", operation: "fact_check_synthesis" });
    const saved = JSON.parse(result.report_row.report);
    assert.deepEqual(saved.productInventory, menuInventory); assert.equal(saved.qualityGate.version, 2);
    assert.deepEqual(result.report_row.report_sources, [evidenceUrl]);
  } finally { globalThis.fetch = oldFetch; }
});
Deno.test("inline citations cannot bypass source traceability through prose or nested steps", () => {
  const report = qualityReport();
  report.actionPlan[0].steps.push("https://invented.test/secret");
  assert.throws(() => gate(report), /本文または反証/);
  report.actionPlan[0].steps.pop();
  assert.throws(() => validateReportQuality(report, qualityInput, [evidenceUrl], "根拠 https://invented.test/secret"), /本文または反証/);
});
Deno.test("Japanese full-width separator is not swallowed into an X evidence URL", () => {
  const text = "https://x.com/atomickanon/status/1548874808221347840／豚フィレ好意\nhttps://x.com/Tyler515o/status/1718239969809146332／店舗体験";
  assert.deepEqual(sourceUrls(text), ["https://x.com/atomickanon/status/1548874808221347840", "https://x.com/Tyler515o/status/1718239969809146332"]);
  const report = qualityReport();
  report.keyFindings[0].sources = ["https://x.com/atomickanon/status/1548874808221347840"];
  report.keyFindings[0].evidence = "投稿の確認 https://x.com/Tyler515o/status/1718239969809146332／反例あり";
  assert.doesNotThrow(() => validateReportQuality(report, qualityInput, [evidenceUrl, ...sourceUrls(text)]));
});
Deno.test("same X post ID matches i/status, username and legacy Twitter routes only", () => {
  const report = qualityReport();
  report.keyFindings[0].sources = ["https://x.com/atomickanon/status/1548874808221347840"];
  const known = [evidenceUrl, "https://x.com/i/status/1548874808221347840"];
  assert.doesNotThrow(() => validateReportQuality(report, qualityInput, known));
  report.keyFindings[0].sources = ["https://twitter.com/i/web/status/1548874808221347840?s=20&t=share-code"];
  assert.doesNotThrow(() => validateReportQuality(report, qualityInput, known));
  for (const url of ["https://x.com/atomickanon/status/1548874808221347841", "https://x.com/atomickanon", "https://x.com.evil.test/i/status/1548874808221347840", "https://example.test/i/status/1548874808221347840", "https://x.com/atomickanon/status/1548874808221347840/other-path"]) {
    report.keyFindings[0].sources = [url];
    assert.throws(() => validateReportQuality(report, qualityInput, known), /追跡できない出典|事実区分/);
  }
});
Deno.test("quality failure names a bounded sample of unmatched URLs for the next attempt", () => {
  const report = qualityReport();
  report.keyFindings[0].evidence = "https://unknown.test/1 https://unknown.test/2 https://unknown.test/3 https://unknown.test/4";
  assert.throws(() => gate(report), (error: any) => {
    assert.ok(error.message.includes("未照合URL例: https://unknown.test/1"));
    assert.ok(error.message.includes("https://unknown.test/3"));
    assert.ok(!error.message.includes("https://unknown.test/4"));
    return true;
  });
});

Deno.test("Japanese citation annotations stop at opening full-width delimiters without changing URL paths", () => {
  const official = "https://marugo-s.com/yotsuya/", party = "https://tabelog.com/tokyo/A1309/A130902/13245349/party/";
  assert.deepEqual(sourceUrls(`${official}（2026年10月31日確認）\n${party}【期間限定】`), [official, party]);
  const report = qualityReport();
  report.keyFindings[0].evidence = `${official}（2026年10月31日確認） ${party}［予約情報］`;
  assert.doesNotThrow(() => validateReportQuality(report, qualityInput, [evidenceUrl, official, party]));
  const lunch = "https://tabelog.com/tokyo/A1309/A130902/13245349/dtlmenu/lunch/";
  report.keyFindings[0].evidence = `${lunch}（2026年10月31日確認）`;
  // A sibling menu path must still have its own observed source; never collapse to the store URL.
  assert.throws(() => validateReportQuality(report, qualityInput, [evidenceUrl, official, party]), /本文または反証/);
  assert.doesNotThrow(() => validateReportQuality(report, qualityInput, [evidenceUrl, lunch]));
  assert.deepEqual(sourceUrls("https://example.test/item%EF%BC%88a%EF%BC%89?item=1"), ["https://example.test/item%EF%BC%88a%EF%BC%89?item=1"]);
});
