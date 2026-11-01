import { strict as assert } from "node:assert";
import { recoverClaimQuotations, visibleClaimText } from "../functions/restaurant-analysis/claim-quotation-recovery.ts";
import { finalizeSynthesis, synthesize, buildSynthesisPrompt } from "../functions/restaurant-analysis/core.ts";
import { withIntegrityReviews } from "./report_integrity_fixture.ts";
import { evidenceUrl, qualityInput, qualityReport } from "./report_quality_fixture.ts";

const raw = "対象は、新宿 **1階**の店舗です。";
const plain = "対象は、新宿 1階の店舗です。";
function fixture() {
  const agents = [
    { id: "market", provider: "OpenAI", status: "done" as const, text: raw, sources: [evidenceUrl] },
    { id: "gourmet", provider: "Google Gemini", status: "done" as const, text: "商品条件は未確認です。", sources: [evidenceUrl] },
    { id: "social", provider: "xAI Grok", status: "done" as const, text: "公開投稿は限定的です。", sources: [] },
  ];
  const report = withIntegrityReviews(qualityReport(), agents);
  report.claimReviews[0].claim = plain;
  return { agents, report };
}
const draft = (report: any) => ({ version: 1 as const, requiredReportVersion: 3 as const, responseStatus: "completed" as const,
  text: JSON.stringify({ critique: "未確認事項は断定しない。", report }), toolSources: [evidenceUrl], costId: "cost", responseId: "response" });

const italicRaw = "*分子*: 公式情報と完全に合致している対象媒体数（現在0媒体）";
const italicPlain = "分子: 公式情報と完全に合致している対象媒体数（現在0媒体）";
const italicSource = `1. **予約前KPI**:\n   * **指標名**: 公式・媒体間の一致率\n     * ${italicRaw}\n     * *分母*: 調査対象媒体総数（2媒体）\n     * *単位*: ％\n`;
function italicFixture() {
  const { agents, report } = fixture();
  agents[0].text = italicSource;
  report.claimReviews[0].claim = italicPlain;
  report.claimReviews[0].decision = "supported";
  report.claimReviews[0].sources = [evidenceUrl];
  return { agents, report };
}

Deno.test("italic quotation recovery restores the exact fragment while preserving list markers", () => {
  const { agents, report } = italicFixture(), snapshot = structuredClone({ agents, report });
  const result = recoverClaimQuotations(report, agents);
  assert.equal(result.report.claimReviews[0].claim, italicRaw);
  assert.deepEqual(result.corrections, [{ path: "claimReviews[0].claim", agentId: "market",
    kind: "paired_emphasis_delimiters", originalQuotation: italicPlain, restoredQuotation: italicRaw }]);
  assert.equal(visibleClaimText(italicSource), `1. 予約前KPI:\n   * 指標名: 公式・媒体間の一致率\n     * ${italicPlain}\n     * 分母: 調査対象媒体総数（2媒体）\n     * 単位: ％\n`);
  assert.deepEqual({ agents, report }, snapshot);
});

Deno.test("italic finalization and both saved retry paths preserve raw audit with zero fetch or cost writes", async () => {
  const oldFetch = globalThis.fetch; let calls = 0, writes = 0;
  globalThis.fetch = () => { calls++; throw new Error("Network forbidden"); };
  const cost = { id: "cost", provider: "OpenAI", request_status: "succeeded",
    request_metadata: { response_status: "completed", provider_response_id: "response" } };
  const db = { from: () => {
    const q: any = { select: () => q, eq: () => q, order: () => q, limit: () => q,
      insert: () => { writes++; throw new Error("cost insert forbidden"); },
      update: () => { writes++; throw new Error("cost update forbidden"); },
      then: (resolve: any) => Promise.resolve({ data: [cost], error: null }).then(resolve) };
    return q;
  } };
  try {
    const { agents, report } = italicFixture();
    const before = `## 調査メモ\n\n**概要**: 公開情報のみを確認した。([参照](${evidenceUrl}))\n\n`
      + "`無関係な*コード*は原文のまま`\n\n";
    const after = `\n詳細URL: https://example.test/path(*literal*)/\n\n結論は追加確認が必要です。`;
    agents[0].text = before + italicSource + after;
    assert.equal(visibleClaimText(agents[0].text), before.replace("**概要**", "概要")
      + `1. 予約前KPI:\n   * 指標名: 公式・媒体間の一致率\n     * ${italicPlain}\n     * 分母: 調査対象媒体総数（2媒体）\n     * 単位: ％\n` + after);
    report.qualityGate = { claimQuotationRecovery: { status: "recovered", additionalGenerations: 999,
      corrections: [{ kind: "forged", restoredQuotation: "https://forged.test/" }] } };
    const completed = draft(report), snapshot = structuredClone({ agents, completed });
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(completed.text))))
      .map(n => n.toString(16).padStart(2, "0")).join("");
    const verify = (result: Awaited<ReturnType<typeof finalizeSynthesis>>) => {
      const saved = JSON.parse(result.report_row.report), audit = saved.qualityGate.claimQuotationRecovery;
      assert.deepEqual(saved.claimReviews[0], { ...report.claimReviews[0], claim: italicRaw });
      assert.equal(saved.qualityGate.version, 3);
      assert.equal(audit.status, "recovered"); assert.equal(audit.additionalGenerations, 0);
      assert.equal(audit.originalSha256, hash);
      assert.deepEqual(audit.corrections, [{ path: "claimReviews[0].claim", agentId: "market",
        kind: "paired_emphasis_delimiters", originalQuotation: italicPlain, restoredQuotation: italicRaw }]);
      assert.equal(result.synthesisDraft.text, completed.text);
    };
    verify(await finalizeSynthesis(qualityInput, agents, completed));
    for (const checkpoint of [{ synthesisDraft: completed }, { ...completed, provider: "OpenAI" }]) {
      const saved: any[] = [];
      const meter = { costDb: db, userId: "owner", runId: "run", jobId: "job", operation: "fact_check_synthesis",
        checkpoint: async (value: any) => { saved.push(value); } };
      for (let attempt = 0; attempt < 2; attempt++) verify(await synthesize(qualityInput, agents, meter, "", checkpoint));
      assert.equal(saved[0].synthesisDraft.text, completed.text);
    }
    assert.deepEqual({ agents, completed }, snapshot);
    for (const [mutate, error] of [
      [(r: any) => { r.claimReviews[0].claim = italicPlain.replace("0媒体", "1媒体"); }, /claimReviews\[0\]\.claim/],
      [(r: any) => { r.claimReviews.push({ ...r.claimReviews[0], claim: italicRaw }); }, /claimReviews\[3\]\.claim.*重複/],
      [(r: any) => { r.claimReviews[0].sources = ["https://unknown.test/"]; }, /claimReviews\[0\]\.sources/],
      [(r: any) => { r.claimReviews[0].decision = "invented"; }, /claimReviews\[0\]\.decision/],
      [(r: any) => { r.claimReviews[0].reason += " https://unknown.test/"; }, /追跡できない/],
      [(r: any) => { r.detailSections.pop(); }, /詳細章が不足/],
      [(r: any) => { r.claimReviews[0].decision = "unverified";
        r.keyFindings[0].issue = italicPlain; r.keyFindings[0].confidence = "confirmed"; }, /claimReviews\[0\]\.claim.*未採用.*断定/],
    ] as const) {
      const bad = structuredClone(report); mutate(bad);
      const invalid = draft(bad), original = structuredClone({ agents, invalid });
      await assert.rejects(() => finalizeSynthesis(qualityInput, agents, invalid), error);
      for (const checkpoint of [{ synthesisDraft: invalid }, { ...invalid, provider: "OpenAI" }]) {
        const saved: any[] = [];
        const meter = { costDb: db, userId: "owner", runId: "run", jobId: "job", operation: "fact_check_synthesis",
          checkpoint: async (value: any) => { saved.push(value); } };
        await assert.rejects(() => synthesize(qualityInput, agents, meter, "", checkpoint), (failure: any) => {
          assert.match(failure.message, error);
          assert.equal(failure.checkpoint.synthesisDraft.text, invalid.text);
          assert.equal(failure.checkpoint.sourceRecovery.additionalGenerations, 0);
          assert.equal(failure.checkpoint.sourceRecovery.status, "needs_review");
          assert.notEqual(failure.checkpoint.synthesisComplete, true);
          assert.equal(failure.checkpoint.report_row, undefined);
          return true;
        });
        assert.ok(saved.every(value => value.synthesisComplete !== true));
      }
      assert.deepEqual({ agents, invalid }, original);
    }
  } finally { globalThis.fetch = oldFetch; assert.equal(calls, 0); assert.equal(writes, 0); }
});

Deno.test("nested list recovery uses marker widths, sibling dedents and only contiguous proven ancestors", async () => {
  const oldFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = () => { calls++; throw new Error("Network forbidden"); };
  try {
    for (const [root, child, childIndent] of [["1.", "*", 3], ["12)", "-", 4], ["+", "2.", 4], ["*", "+", 5]] as const) {
      for (const extra of [0, 1, 2, 3]) {
        const contentIndent = childIndent + child.length + 1;
        const text = `${root} 親項目\n${" ".repeat(childIndent)}${child} 子項目\n`
          + `${" ".repeat(contentIndent + extra)}* ${italicRaw}\n`
          + `${" ".repeat(childIndent)}${child} 次の子項目\n${root} 次の親項目`;
        const { agents, report } = italicFixture(); agents[0].text = text;
        const result = await finalizeSynthesis(qualityInput, agents, draft(report));
        assert.equal(JSON.parse(result.report_row.report).claimReviews[0].claim, italicRaw, text);
        assert.equal(visibleClaimText(text), text.replace(italicRaw, italicPlain), text);
      }
    }
    const parent = "1. 親項目\n   * 子項目";
    const refused = [
      `     * ${italicRaw}`, `1. 親項目\n       * ${italicRaw}`,
      `${parent}\n         * ${italicRaw}`, `${parent}\n     * 孫項目\n           * ${italicRaw}`,
      `${parent}\n         ${italicRaw}`, `${parent}\n\t* ${italicRaw}`,
      `1.     親項目\n     * ${italicRaw}`, `-     ${italicRaw}`,
      `- -     ${italicRaw}`, `1. *     ${italicRaw}`, `* 2.     ${italicRaw}`,
      `${parent}\n\n     * ${italicRaw}`, `${parent}\n通常の段落\n     * ${italicRaw}`,
      `${parent}\n   \`code\`\n     * ${italicRaw}`, `${parent}\n   <span>HTML</span>\n     * ${italicRaw}`,
      `${parent}\n   ~~~\n   ~~~\n     * ${italicRaw}`,
      `${parent}\n   未完の*強調\n     * ${italicRaw}`,
      `1. 親項目\n   \\* 子項目\n     * ${italicRaw}`,
      ...pseudoFenceWhitespace.map(padding => `1. 親項目\n   *${padding}子項目\n     * ${italicRaw}`),
      `1. 親項目\n   *\t子項目\n     * ${italicRaw}`,
      `1. 親項目\n   * 子項目\n    * ${italicRaw}`,
    ];
    for (const text of refused) {
      const { agents, report } = italicFixture(); agents[0].text = text;
      assert.deepEqual(recoverClaimQuotations(report, agents).corrections, [], JSON.stringify(text));
      assert.ok(visibleClaimText(text).includes(italicRaw), JSON.stringify(text));
      await assert.rejects(() => finalizeSynthesis(qualityInput, agents, draft(report)), /claimReviews\[0\]\.claim/);
    }
  } finally { globalThis.fetch = oldFetch; assert.equal(calls, 0); }
});

Deno.test("italic recovery preserves exact boundaries and distinguishes mixed versus bold-only audits", () => {
  for (const [text, claim, expected, kind] of [
    ["前文。*対象店舗*は確認済み。後文。", "対象店舗は確認済み。", "*対象店舗*は確認済み。", "paired_emphasis_delimiters"],
    ["前文。対象は*1階*。後文。", "対象は1階", "対象は*1階*", "paired_emphasis_delimiters"],
    ["*分子*: **0媒体**、*分母*: **2媒体**。", "分子: 0媒体、分母: 2媒体。", "*分子*: **0媒体**、*分母*: **2媒体**。", "paired_emphasis_delimiters"],
    ["**分子**: 0媒体。\n*別の項目*。", "分子: 0媒体。", "**分子**: 0媒体。", "paired_bold_delimiters"],
    ["   * *分子*: 0媒体。", "   * 分子: 0媒体。", "   * *分子*: 0媒体。", "paired_emphasis_delimiters"],
    ["_raw_token_と*分子*: 0媒体。", "_raw_token_と分子: 0媒体。", "_raw_token_と*分子*: 0媒体。", "paired_emphasis_delimiters"],
  ]) {
    const { agents, report } = italicFixture(); agents[0].text = text; report.claimReviews[0].claim = claim;
    const result = recoverClaimQuotations(report, agents);
    assert.equal(result.report.claimReviews[0].claim, expected, text);
    assert.equal(result.corrections[0]?.kind, kind, text);
    assert.ok(text.includes(result.corrections[0].restoredQuotation));
  }
});

for (const [boundary, content] of [["opener", "😀分子"], ["closer", "分子😀"]]) {
  Deno.test(`Unicode emphasis flanking rejects a literal ${boundary} through finalization`, async () => {
    for (const delimiter of ["*", "**"]) {
      const text = `値は${delimiter}${content}${delimiter}です。`, claim = `値は${content}です。`;
      const { agents, report } = italicFixture(); agents[0].text = text; report.claimReviews[0].claim = claim;
      const completed = draft(report), snapshot = structuredClone({ agents, report, completed });
      await assert.rejects(() => finalizeSynthesis(qualityInput, agents, completed), /claimReviews\[0\]\.claim/);
      assert.deepEqual(recoverClaimQuotations(report, agents).corrections, [], text);
      assert.equal(visibleClaimText(text), text);
      assert.deepEqual({ agents, report, completed }, snapshot);
    }
  });
}

Deno.test("Unicode emphasis flanking retains ASCII punctuation refusals through finalization", async () => {
  for (const delimiter of ["*", "**"]) for (const content of ["!分子", "分子!"]) {
    const text = `値は${delimiter}${content}${delimiter}です。`, claim = `値は${content}です。`;
    const { agents, report } = italicFixture(); agents[0].text = text; report.claimReviews[0].claim = claim;
    await assert.rejects(() => finalizeSynthesis(qualityInput, agents, draft(report)), /claimReviews\[0\]\.claim/);
    assert.deepEqual(recoverClaimQuotations(report, agents).corrections, [], text);
    assert.equal(visibleClaimText(text), text);
  }
});

Deno.test("Unicode emphasis flanking accepts actual code points without changing UTF-16 quotation offsets", async () => {
  for (const delimiter of ["*", "**"]) for (const [before, content, after] of [
    ["値は ", "😀分子", "です。"], ["値は", "分子😀", " です。"],
    ["値は（", "😀分子😀", "）です。"],
    ["値は😀", "!分子", "です。"], ["値は", "分子!", "😀です。"],
    ["値は😀", "😀分子😀", "😀です。"],
    ["値は", "𠮷分子𠮷", "です。"], ["", "😀分子😀", "。"],
  ]) {
    const text = `${before}${delimiter}${content}${delimiter}${after}`, claim = `${before}${content}${after}`;
    const { agents, report } = italicFixture();
    const prefix = "😀別の段落。\n\n𠮷の注記。 ", suffix = ` 続きは${delimiter}確認済み${delimiter}。`;
    agents[0].text = prefix + text + suffix; report.claimReviews[0].claim = claim;
    const completed = draft(report), snapshot = structuredClone({ agents, report, completed });
    const result = await finalizeSynthesis(qualityInput, agents, completed);
    const saved = JSON.parse(result.report_row.report);
    assert.deepEqual(saved.claimReviews[0], { ...report.claimReviews[0], claim: text });
    assert.deepEqual(saved.qualityGate.claimQuotationRecovery.corrections, [{ path: "claimReviews[0].claim", agentId: "market",
      kind: delimiter === "*" ? "paired_emphasis_delimiters" : "paired_bold_delimiters",
      originalQuotation: claim, restoredQuotation: text }]);
    assert.equal(visibleClaimText(agents[0].text), prefix + claim + " 続きは確認済み。");
    assert.equal(result.synthesisDraft.text, completed.text);
    assert.deepEqual({ agents, report, completed }, snapshot);
  }
});

Deno.test("italic recovery refuses protected, nested, unpaired and fake-list contexts", async () => {
  const target = "値は*1階*です。", claim = "値は1階です。";
  const contexts = [
    `\`${target}\``, `\`開始\n${target}\n終了\``, `\`\`開始\n\`\n${target}\n終了\`\``,
    `    ${target}`, `\t${target}`, `<pre>\n${target}\n</pre>`, `<!--\n${target}\n-->`,
    `<pre\n data-note="未完">\n\n${target}\n</pre>`, `[${target}](https://example.test/)`,
    `[参照\n${target}\n](https://example.test/)`, `[参照](https://example.test/\n${target}\n)`,
    `前*開始\n${target}\n終了*`, `前**開始\n${target}\n終了**`,
    `*https://example.test/\n${target}\nhttps://example.test/*`,
    ...pseudoFenceWhitespace.map(padding => `*${padding}${target}`),
  ];
  for (const marker of ["~~~", "```"]) {
    for (const [open, continuation] of [["", ""], ["- ", "  "], ["* ", "  "], ["> - ", ">   "], ["- - ", "    "]]) {
      contexts.push(`${open}${marker}text\n${continuation}${target}\n${continuation}${marker}`);
      for (const padding of pseudoFenceWhitespace) {
        contexts.push(`${open}${marker}text\n${continuation}${marker}${padding}\n${continuation}${target}\n${continuation}${marker}`);
        contexts.push(`${open}${marker}text\n${continuation}${padding}${marker}\n${continuation}${target}\n${continuation}${marker}`);
      }
    }
  }
  const pairs = contexts.map(text => [text, claim]);
  pairs.push(
    ["値は\\*1階\\*です。", "値は\\1階\\です。"], ["値は* 1階 *です。", "値は 1階 です。"],
    ["値は***1階***です。", claim], ["値は*1階です。", claim], ["値は*1階**です。", claim],
    ["値は*外側 **1階** 外側*です。", "値は外側 1階 外側です。"],
    ["値は**外側 *1階* 外側**です。", "値は外側 1階 外側です。"],
    ["値は*外側 *1階* 外側*です。", "値は外側 1階 外側です。"],
    ["https://example.test/path(*1階*)/", "https://example.test/path(1階)/"],
    ["https://example.test/path[*1階*]/", "https://example.test/path[1階]/"],
    ["mailto:*name*@example.test", "mailto:name@example.test"],
    ["//example.test/*1階*/", "//example.test/1階/"],
    ["値は_1階_です。", claim],
  );
  for (const [text, quotation] of pairs) {
    const { agents, report } = italicFixture(); agents[0].text = text; report.claimReviews[0].claim = quotation;
    const completed = draft(report), snapshot = structuredClone({ agents, report, completed });
    assert.deepEqual(recoverClaimQuotations(report, agents).corrections, [], JSON.stringify(text));
    assert.equal(visibleClaimText(text), text, JSON.stringify(text));
    await assert.rejects(() => finalizeSynthesis(qualityInput, agents, completed), /claimReviews\[0\]\.claim/);
    assert.deepEqual({ agents, report, completed }, snapshot);
  }
});

Deno.test("italic recovery rejects ambiguity, changed content and wrong-agent evidence", () => {
  const { agents, report } = italicFixture();
  for (const claim of [italicPlain.replace("0媒体", "1媒体"), italicPlain.replace("合致している", "合致していない"),
    italicPlain.replace(": ", ":"), italicPlain.replace(":", "："), italicPlain.replace("（", "("),
    italicPlain.replace("分子", "_分子_"), "子: 公式情報と完全に合致している対象媒体数（現在0媒体）"]) {
    report.claimReviews[0].claim = claim;
    assert.deepEqual(recoverClaimQuotations(report, agents).corrections, [], claim);
  }
  report.claimReviews[0].claim = italicPlain;
  for (const text of [`${italicRaw}\n${italicRaw}`, `${italicRaw}\n**分子**: 公式情報と完全に合致している対象媒体数（現在0媒体）`,
    `${italicRaw}\n${italicPlain}`, "別の本文"]) {
    agents[0].text = text; agents[1].text = italicSource;
    assert.deepEqual(recoverClaimQuotations(report, agents).corrections, [], text);
  }
  agents[0].text = italicSource; agents.push({ ...agents[0] });
  assert.deepEqual(recoverClaimQuotations(report, agents).corrections, []);
});

Deno.test("italic recovery resumes after unrelated protected blocks and preserves citation bytes", async () => {
  for (const context of [
    "`開始\n値は*9階*です。\n終了`", "~~~text\n値は*9階*です。\n~~~",
    "- ~~~text\n  値は*9階*です。\n  ~~~", "<pre>\n値は*9階*です。\n</pre>",
    "<!--\n値は*9階*です。\n-->", "---", "***", "* **通常の箇条書き**です。",
    "参照は[*公式情報*](https://example.test/*literal*/)です。",
    "https://example.test/path(*literal*)/", "未対応の*強調\n",
  ]) {
    const { agents, report } = italicFixture();
    const citation = `([参照](${evidenceUrl}))`;
    agents[0].text = `${context}\n${italicSource}${citation}`;
    const completed = draft(report), snapshot = structuredClone({ agents, completed });
    const result = await finalizeSynthesis(qualityInput, agents, completed);
    assert.equal(JSON.parse(result.report_row.report).claimReviews[0].claim, italicRaw, context);
    assert.ok(visibleClaimText(agents[0].text).includes(citation));
    assert.equal(result.synthesisDraft.text, completed.text);
    assert.deepEqual({ agents, completed }, snapshot);
  }
});

Deno.test("quotation recovery is unique, same-agent and exact-only before normalization", () => {
  for (const text of [raw + "\n" + raw, raw + "\n対象は、**新宿 1階**の店舗です。", "別の本文"] ) {
    const { agents, report } = fixture(); agents[0].text = text;
    agents[1].text = raw;
    const result = recoverClaimQuotations(report, agents);
    assert.deepEqual(result.report, report); assert.deepEqual(result.corrections, []);
  }
  const { agents, report } = fixture(); agents[0].text = `${raw}\n${plain}`;
  assert.deepEqual(recoverClaimQuotations(report, agents).corrections, []);
  agents.push({ ...agents[0] }); agents[0].text = raw;
  assert.deepEqual(recoverClaimQuotations(report, agents).corrections, []);
});

Deno.test("quotation recovery refuses real content, whitespace, punctuation, negation and number changes", () => {
  for (const claim of [plain.replace("1階", "2階"), plain.replace("です", "ではありません"),
    plain.replace("新宿 ", "新宿"), plain.replace("、", ""), plain.replace("。", "!"), "対象は、新宿1階の店舗です。", "階の店舗です。別の記述"]) {
    const { agents, report } = fixture(); report.claimReviews[0].claim = claim;
    assert.deepEqual(recoverClaimQuotations(report, agents).corrections, [], claim);
  }
});

Deno.test("quotation recovery refuses code, literal stars, unsupported Markdown and URLs", () => {
  const pairs = [
    ["値は`**1階**`です。", "値は`1階`です。"],
    ["```text\n値は**1階**です。\n```", "値は1階です。"],
    ["~~~text\n値は**1階**です。\n~~~", "値は1階です。"],
    ["    値は**1階**です。", "値は1階です。"],
    ["値は\\**1階\\**です。", "値は\\1階\\です。"],
    ["値は** 1階 **です。", "値は 1階 です。"],
    ["値は***1階***です。", "値は*1階*です。"],
    ["値は**1階です。", "値は1階です。"],
    ["https://example.test/**1階**/", "https://example.test/1階/"],
    ["[値は**1階**です。](https://example.test/)", "値は1階です。"],
    ["<pre>\n値は**1階**です。\n</pre>", "値は1階です。"],
    ["> ```\n> 値は**1階**です。\n> ```", "> 値は1階です。"],
    ["`コード開始\n値は**1階**です。\nコード終了`", "値は1階です。"],
    ["//example.test/**1階**/", "//example.test/1階/"],
    ["mailto:**name**@example.test", "mailto:name@example.test"],
    ["前**開始\n値は**1階**です。\n終了**", "値は1階です。"],
    ["前*開始\n値は**1階**です。\n終了*", "値は1階です。"],
    ["**https://example.test/\n値は**1階**です。\nhttps://example.test/**", "値は1階です。"],
  ];
  for (const [text, claim] of pairs) {
    const { agents, report } = fixture(); agents[0].text = text; report.claimReviews[0].claim = claim;
    assert.deepEqual(recoverClaimQuotations(report, agents).corrections, [], text);
  }
});

// These are whitespace to ECMAScript trim(), but not fence-closing padding.
const pseudoFenceWhitespace = ["\u00a0", "\u2003", "\u2028", "\u2029", "\u202f", "\u3000", "\ufeff", "\v", "\f"];
for (const marker of ["~~~", "```"]) {
  Deno.test(`quotation recovery refuses Unicode-whitespace pseudo-closing ${marker} fences`, async (t) => {
    for (const padding of pseudoFenceWhitespace) {
      await t.step(JSON.stringify(padding), () => {
        const text = `- ${marker}text\n  ${marker}${padding}\n  値は**1階**です。\n  ${marker}`;
        const { agents, report } = fixture();
        agents[0].text = text; report.claimReviews[0].claim = "値は1階です。";
        const snapshot = structuredClone({ agents, report });
        const result = recoverClaimQuotations(report, agents);
        assert.deepEqual(result.corrections, []);
        assert.deepEqual(result.report, report);
        assert.equal(visibleClaimText(text), text);
        assert.deepEqual({ agents, report }, snapshot);
      });
    }
  });

  Deno.test(`finalizeSynthesis rejects Unicode-whitespace pseudo-closing ${marker} fences`, async (t) => {
    const oldFetch = globalThis.fetch; let calls = 0;
    globalThis.fetch = () => { calls++; throw new Error("Network forbidden"); };
    try {
      for (const padding of pseudoFenceWhitespace) {
        await t.step(JSON.stringify(padding), async () => {
          const { agents, report } = fixture();
          agents[0].text = `- ${marker}text\n  ${marker}${padding}\n  値は**1階**です。\n  ${marker}`;
          report.claimReviews[0].claim = "値は1階です。";
          report.claimReviews[0].decision = "supported"; report.claimReviews[0].sources = [evidenceUrl];
          const completed = draft(report), snapshot = structuredClone({ agents, completed });
          await assert.rejects(() => finalizeSynthesis(qualityInput, agents, completed), /claimReviews\[0\]\.claim/);
          assert.deepEqual({ agents, completed }, snapshot);
        });
      }
    } finally { globalThis.fetch = oldFetch; assert.equal(calls, 0); }
  });
}

Deno.test("quotation recovery keeps Unicode container padding and uncertain closing indentation protected", async () => {
  for (const marker of ["~~~", "```"]) {
    for (const [open, continuation] of [["", ""], ["- ", "  "], ["> - ", ">   "], ["- - ", "    "]]) {
      const pseudoPrefixes = pseudoFenceWhitespace.flatMap(padding => [
        `${padding}${continuation}`, `${continuation}${padding}`, `${continuation}- ${padding}`,
      ]);
      for (const prefix of [...pseudoPrefixes, `${continuation}    `, `${continuation}\t`]) {
        const text = `${open}${marker}text\n${prefix}${marker}\n${continuation}値は**1階**です。\n${continuation}${marker}`;
        const { agents, report } = fixture();
        agents[0].text = text; report.claimReviews[0].claim = "値は1階です。";
        report.claimReviews[0].decision = "supported"; report.claimReviews[0].sources = [evidenceUrl];
        const completed = draft(report), snapshot = structuredClone({ agents, report, completed });
        assert.deepEqual(recoverClaimQuotations(report, agents).corrections, [], JSON.stringify(text));
        assert.equal(visibleClaimText(text), text);
        await assert.rejects(() => finalizeSynthesis(qualityInput, agents, completed), /claimReviews\[0\]\.claim/);
        assert.deepEqual({ agents, report, completed }, snapshot);
      }
    }
  }
});

Deno.test("quotation recovery resumes at ASCII-padded LF and CRLF closers before cited prose", async () => {
  for (const marker of ["~~~", "```"]) {
    for (const [open, continuation] of [["", ""], ["- ", "  "], ["> - ", ">   "]]) {
      for (const newline of ["\n", "\r\n"]) for (const padding of ["", " ", "\t", " \t "]) {
        const context = [`${open}${marker}text`, `${continuation}値は**9階**です。`,
          `${continuation}${marker}${marker[0]}${padding}`].join(newline);
        const { agents, report } = fixture();
        agents[0].text = `${context}${newline}${raw}([参照](${evidenceUrl}))`;
        report.claimReviews[0].decision = "supported"; report.claimReviews[0].sources = [evidenceUrl];
        const completed = draft(report), snapshot = structuredClone({ agents, completed });
        assert.ok(visibleClaimText(agents[0].text).includes(context));
        const result = await finalizeSynthesis(qualityInput, agents, completed);
        const saved = JSON.parse(result.report_row.report);
        assert.equal(saved.claimReviews[0].claim, raw);
        assert.equal(saved.claimReviews[0].decision, "supported");
        assert.equal(saved.qualityGate.claimQuotationRecovery.corrections.length, 1);
        assert.equal(saved.qualityGate.claimQuotationRecovery.additionalGenerations, 0);
        assert.equal(result.synthesisDraft.text, completed.text);
        assert.deepEqual({ agents, completed }, snapshot);
      }
    }
  }
});

const listFence = "- ~~~text\n  値は**1階**です。\n  ~~~";

Deno.test("quotation recovery refuses list-container fenced code", () => {
  const { agents, report } = fixture();
  agents[0].text = listFence; report.claimReviews[0].claim = "値は1階です。";
  const snapshot = structuredClone({ agents, report });
  const result = recoverClaimQuotations(report, agents);
  assert.deepEqual(result.corrections, []);
  assert.deepEqual(result.report, report);
  assert.equal(visibleClaimText(listFence), listFence);
  assert.deepEqual({ agents, report }, snapshot);
});

Deno.test("quotation recovery bounds nested list and blockquote fences without hiding cited prose", async () => {
  for (const marker of ["~~~", "```"]) {
    for (const [open, continuation] of [
      ["- ", "  "], ["+ ", "  "], ["* ", "  "], ["1. ", "   "], ["12) ", "    "],
      ["- - ", "    "], ["- 親項目\n  - ", "    "], ["> - ", ">   "],
      ["- > ", "  > "], ["> > 1. ", "> >    "],
    ]) {
      // Neither a shorter fence, the other delimiter, nor a nested-looking
      // list marker inside literal code may end this protected context.
      const context = `${open}${marker}text\n${continuation}${marker.slice(1)}\n`
        + `${continuation}${marker === "~~~" ? "```" : "~~~"}\n`
        + `${continuation}- ${marker}\n\n${continuation}値は**1階**です。\n${continuation}${marker}`;
      const { agents, report } = fixture();
      agents[0].text = `${context}\n\n- **通常の箇条書き**です。\n* **別の箇条書き**です。\n`
        + raw + `([参照](${evidenceUrl}))`;
      report.claimReviews[0].claim = "値は1階です。";
      const snapshot = structuredClone({ agents, report });
      assert.deepEqual(recoverClaimQuotations(report, agents).corrections, [], context);
      const visible = visibleClaimText(agents[0].text);
      assert.ok(visible.includes(context), context);
      assert.ok(visible.includes("- 通常の箇条書きです。\n* 別の箇条書きです。"), context);
      assert.ok(visible.includes(`([参照](${evidenceUrl}))`), context);
      assert.deepEqual({ agents, report }, snapshot);
      report.claimReviews[0].claim = plain;
      report.claimReviews[0].decision = "supported"; report.claimReviews[0].sources = [evidenceUrl];
      const completed = draft(report), original = structuredClone({ agents, completed });
      const result = await finalizeSynthesis(qualityInput, agents, completed);
      const saved = JSON.parse(result.report_row.report);
      assert.equal(saved.claimReviews[0].claim, raw, context);
      assert.equal(saved.claimReviews[0].decision, "supported");
      assert.equal(saved.qualityGate.claimQuotationRecovery.corrections.length, 1);
      assert.equal(saved.qualityGate.claimQuotationRecovery.additionalGenerations, 0);
      assert.equal(result.synthesisDraft.text, completed.text);
      assert.deepEqual({ agents, completed }, original);
    }
  }
});

Deno.test("finalizeSynthesis rejects list-container code-only quotations without fetch or cost writes", async () => {
  const oldFetch = globalThis.fetch; let calls = 0, writes = 0;
  globalThis.fetch = () => { calls++; throw new Error("Network forbidden"); };
  const cost = { id: "cost", provider: "OpenAI", request_status: "succeeded",
    request_metadata: { response_status: "completed", provider_response_id: "response" } };
  const db = { from: () => {
    const q: any = { select: () => q, eq: () => q, order: () => q, limit: () => q,
      insert: () => { writes++; throw new Error("cost insert forbidden"); },
      update: () => { writes++; throw new Error("cost update forbidden"); },
      then: (resolve: any) => Promise.resolve({ data: [cost], error: null }).then(resolve) };
    return q;
  } };
  try {
    const { agents, report } = fixture();
    agents[0].text = listFence; report.claimReviews[0].claim = "値は1階です。";
    report.claimReviews[0].decision = "supported"; report.claimReviews[0].sources = [evidenceUrl];
    const completed = draft(report), snapshot = structuredClone({ agents, completed });
    const reject = (error: any) => {
      assert.match(error.message, /claimReviews\[0\]\.claim/);
      assert.equal(error.checkpoint.synthesisDraft.text, completed.text);
      assert.equal(error.checkpoint.sourceRecovery.additionalGenerations, 0);
      assert.equal(error.checkpoint.sourceRecovery.status, "needs_review");
      assert.notEqual(error.checkpoint.synthesisComplete, true);
      assert.equal(error.checkpoint.report_row, undefined);
      return true;
    };
    await assert.rejects(() => finalizeSynthesis(qualityInput, agents, completed), /claimReviews\[0\]\.claim/);
    for (const checkpoint of [{ synthesisDraft: completed }, { ...completed, provider: "OpenAI" }]) {
      const saved: any[] = [];
      const meter = { costDb: db, userId: "owner", runId: "run", jobId: "job", operation: "fact_check_synthesis",
        checkpoint: async (value: any) => { saved.push(value); } };
      await assert.rejects(() => synthesize(qualityInput, agents, meter, "", checkpoint), reject);
      assert.ok(saved.every(value => value.synthesisComplete !== true));
    }
    assert.deepEqual({ agents, completed }, snapshot);
  } finally {
    globalThis.fetch = oldFetch;
    assert.equal(calls, 0); assert.equal(writes, 0);
  }
});

Deno.test("quotation recovery protects URL punctuation and multiline protected contexts", () => {
  for (const [text, claim] of [
    ['https://example.test/path(**1階**)/', 'https://example.test/path(1階)/'],
    ['https://example.test/path[**1階**]/', 'https://example.test/path[1階]/'],
    ['[参照\n値は**1階**です。\n](https://example.test/)', '値は1階です。'],
    ['[参照](https://example.test/\n値は**1階**です。\n)', '値は1階です。'],
    ['\\`文字としてのバッククォート\n`コード開始\n値は**1階**です。\nコード終了`', '値は1階です。'],
    ['``コード開始\n`は閉じない\n値は**1階**です。\nコード終了``', '値は1階です。'],
    ['<pre\n data-note="複数行">\n\n値は**1階**です。\n</pre>', '値は1階です。'],
    ['前**開始\n値は**1階**です。\n終了**\n\n無関係な**段落**。', '値は1階です。'],
  ]) {
    const { agents, report } = fixture(); agents[0].text = text; report.claimReviews[0].claim = claim;
    assert.deepEqual(recoverClaimQuotations(report, agents).corrections, [], text);
  }
});

Deno.test("quotation recovery resumes after protected blocks and leaves their contents literal", () => {
  for (const context of [
    '`コード開始\n値は**9階**です。\nコード終了`',
    '``コード開始\n`は閉じない\n値は**9階**です。\nコード終了``',
    '~~~text\n値は**9階**です。\n~~~',
    '<pre>\n値は**9階**です。\n</pre>',
    '<div><pre>\n値は**9階**です。\n</pre></div>',
    '<!-- 注記\n値は**9階**です。\n-->',
  ]) {
    const { agents, report } = fixture(); agents[0].text = `${context}\n${raw}\n${context}`;
    const result = recoverClaimQuotations(report, agents);
    assert.equal(result.report.claimReviews[0].claim, raw, context);
    report.claimReviews[0].claim = '値は9階です。';
    // A single protected occurrence must not qualify as ordinary prose.
    agents[0].text = `${context}\n${raw}`;
    assert.deepEqual(recoverClaimQuotations(report, agents).corrections, [], context);
  }
});

Deno.test("quotation recovery restores standalone prose before trailing Markdown citations", () => {
  for (const [text, claim, expected] of [
    ['対象は、架空区3-7-5 **1階**の「店舗」、電話00-0000-0000です。次の説明。([official.test](https://official.test/))',
      '対象は、架空区3-7-5 1階の「店舗」、電話00-0000-0000です。',
      '対象は、架空区3-7-5 **1階**の「店舗」、電話00-0000-0000です。'],
    ['一覧は**2026年10月27日更新、3件掲載**。以下は表示条件です。([example.test](https://example.test/menu/))',
      '一覧は2026年10月27日更新、3件掲載。', '一覧は**2026年10月27日更新、3件掲載**。'],
  ]) {
    const { agents, report } = fixture(); agents[0].text = text; report.claimReviews[0].claim = claim;
    const snapshot = structuredClone({ agents, report });
    const result = recoverClaimQuotations(report, agents);
    assert.equal(result.report.claimReviews[0].claim, expected);
    assert.equal(result.corrections.length, 1);
    assert.deepEqual({ agents, report }, snapshot);
  }
});

Deno.test("quotation recovery scans full reports locally without changing links or code", () => {
  const first = '対象は、架空区3-7-5 **1階**の「店舗」、電話00-0000-0000です。';
  const second = '一覧は**2026年10月27日更新、3件掲載**。';
  const { agents, report } = fixture();
  agents[0].text = [
    '# **店舗調査レポート**',
    '参照は[**公式情報**](https://official.test/**literal**/)です。',
    '注記は`**コード**`として保存します。',
    '```text',
    '**未完のコード',
    '```',
    '---',
    '* **所在地**を確認しました。',
    first + '次の説明。([official.test](https://official.test/))',
    '* **公開一覧**を調査しました。',
    second + '以下は表示条件です。([example.test](https://example.test/menu/))',
    '補足: https://example.test/**literal**/',
    '',
    '未対応の*強調',
    '',
    '別段落の**説明**です。',
  ].join('\n');
  report.claimReviews[0].claim = first.replaceAll('**', '');
  report.claimReviews[1].agentId = agents[0].id;
  report.claimReviews[1].claim = second.replaceAll('**', '');
  const snapshot = structuredClone({ agents, report });
  const result = recoverClaimQuotations(report, agents);
  assert.deepEqual(result.corrections.map(c => c.restoredQuotation), [first, second]);
  assert.deepEqual(result.report.claimReviews.slice(0, 2).map((r: any) => r.claim), [first, second]);
  const visible = visibleClaimText(agents[0].text);
  assert.ok(visible.includes('[**公式情報**](https://official.test/**literal**/)'));
  assert.ok(visible.includes('注記は`**コード**`として保存します。'));
  assert.ok(visible.includes('```text\n**未完のコード\n```'));
  assert.ok(visible.includes('補足: https://example.test/**literal**/'));
  assert.ok(visible.includes('* 所在地を確認しました。'));
  assert.ok(visible.includes('別段落の説明です。'));
  assert.deepEqual({ agents, report }, snapshot);
});

Deno.test("quotation recovery preserves whole bold boundaries and never joins unrelated tokens", () => {
  for (const [text, claim, expected] of [
    ["前文。**対象店舗**は確認済み。後文。", "対象店舗は確認済み。", "**対象店舗**は確認済み。"],
    ["前文。対象は**1階**。後文。", "対象は1階", "対象は**1階**"],
    ["前文。対象は**1階**、定員は**30人**。後文。", "対象は1階、定員は30人。", "対象は**1階**、定員は**30人**。"],
  ]) {
    const { agents, report } = fixture(); agents[0].text = text; report.claimReviews[0].claim = claim;
    assert.equal(recoverClaimQuotations(report, agents).report.claimReviews[0].claim, expected);
  }
  const { agents, report } = fixture(); agents[0].text = "対象は**新宿1階**です。"; report.claimReviews[0].claim = "1階です。";
  assert.deepEqual(recoverClaimQuotations(report, agents).corrections, []);
});

Deno.test("restoration retains supported decisions and still rejects duplicate reviews and invalid evidence", async () => {
  const { agents, report } = fixture(); report.claimReviews[0].decision = "supported"; report.claimReviews[0].sources = [evidenceUrl];
  const result = await finalizeSynthesis(qualityInput, agents, draft(report));
  const saved = JSON.parse(result.report_row.report);
  assert.deepEqual(saved.claimReviews[0], { ...report.claimReviews[0], claim: raw });
  for (const [mutate, error] of [
    [(r: any) => { r.claimReviews.push({ ...r.claimReviews[0], claim: raw }); }, /claimReviews\[3\]\.claim.*重複/],
    [(r: any) => { r.claimReviews[0].agentId = "unknown"; }, /claimReviews\[0\]\.agentId/],
    [(r: any) => { r.claimReviews[0].sources = ["https://unknown.test/"]; }, /claimReviews\[0\]\.sources/],
    [(r: any) => { r.claimReviews[0].decision = "invented"; }, /claimReviews\[0\]\.decision/],
    [(r: any) => { r.claimReviews[0].reason += " https://unknown.test/"; }, /追跡できない/],
    [(r: any) => { r.detailSections.pop(); }, /詳細章が不足/],
  ] as const) {
    const bad = structuredClone(report); mutate(bad);
    await assert.rejects(() => finalizeSynthesis(qualityInput, agents, draft(bad)), error);
  }
});

Deno.test("server quotation audit replaces forged model metadata even when no quotation was recovered", async () => {
  for (const recover of [true, false]) {
    const { agents, report } = fixture(); if (!recover) report.claimReviews[0].claim = raw;
    report.qualityGate = { version: 1, claimQuotationRecovery: { status: "recovered", additionalGenerations: 999,
      corrections: [{ restoredQuotation: "https://invented.test/forged" }] } };
    const completed = draft(report), result = await finalizeSynthesis(qualityInput, agents, completed);
    const gate = JSON.parse(result.report_row.report).qualityGate;
    assert.equal(gate.version, 3); assert.equal(gate.claimQuotationRecovery.status, recover ? "recovered" : "unchanged");
    assert.equal(gate.claimQuotationRecovery.additionalGenerations, 0);
    assert.equal(gate.claimQuotationRecovery.corrections.length, recover ? 1 : 0);
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(completed.text))))
      .map(n => n.toString(16).padStart(2, "0")).join("");
    assert.equal(gate.claimQuotationRecovery.originalSha256, hash);
    assert.equal(result.synthesisDraft.text, completed.text);
  }
});

Deno.test("quotation and coverage recovery compose without trusting model audit or changing the original", async () => {
  const parent = "https://tabelog.com/tokyo/A1304/A130401/13019866/";
  const unread = `${parent}dtlrvwlst/B515656426/?lid=unpickup_review`;
  const input = { ...qualityInput, selectedSites: [{ id: "tabelog", name: "食べログ", url: parent }] };
  const { agents, report } = fixture();
  const value = JSON.parse(JSON.stringify(report).replaceAll(evidenceUrl, parent));
  agents.forEach(a => { a.sources = a.sources.map(() => parent); });
  const row = value.researchCoverage.find((r: any) => r.targetId === "tabelog");
  row.scope = "トップページの口コミ抜粋を確認。個別口コミ詳細は取得できず。";
  row.limitation = "個別の口コミは未読。"; row.sources = [parent, unread];
  value.qualityGate = { claimQuotationRecovery: { status: "recovered", corrections: [{ restoredQuotation: "https://forged.test/" }] } };
  const completed = { ...draft(value), toolSources: [parent] }, snapshot = structuredClone({ agents, completed });
  const result = await finalizeSynthesis(input, agents, completed), saved = JSON.parse(result.report_row.report);
  assert.equal(saved.claimReviews[0].claim, raw);
  assert.equal(saved.qualityGate.version, 3);
  assert.equal(saved.qualityGate.claimQuotationRecovery.status, "recovered");
  assert.equal(result.sourceRecovery.status, "recovered");
  assert.deepEqual(saved.researchCoverage.find((r: any) => r.targetId === "tabelog").sources, [parent]);
  assert.deepEqual({ agents, completed }, snapshot); assert.deepEqual(result.synthesisDraft, completed);
  for (const mutate of [
    (r: any) => { r.detailSections.pop(); },
    (r: any) => { r.claimReviews[0].reason += " https://unknown.test/"; },
    (r: any) => { r.keyFindings[0].claimQuotationRecovery = { url: "https://unknown.test/" }; },
    (r: any) => { r.claimReviews[0].decision = "invalid"; },
  ]) {
    const bad = structuredClone(value); mutate(bad);
    await assert.rejects(() => finalizeSynthesis(input, agents, { ...draft(bad), toolSources: [parent] }));
  }
});

Deno.test("terminal and completed-draft retries restore or reject with zero fetch and cost writes", async () => {
  const oldFetch = globalThis.fetch; let calls = 0, writes = 0;
  globalThis.fetch = () => { calls++; throw new Error("Network forbidden"); };
  const cost = { id: "cost", provider: "OpenAI", request_status: "succeeded",
    request_metadata: { response_status: "completed", provider_response_id: "response" } };
  const db = { from: () => {
    const q: any = { select: () => q, eq: () => q, order: () => q, limit: () => q,
      insert: () => { writes++; throw new Error("cost insert forbidden"); },
      update: () => { writes++; throw new Error("cost update forbidden"); },
      then: (resolve: any) => Promise.resolve({ data: [cost], error: null }).then(resolve) };
    return q;
  } };
  try {
    for (const valid of [true, false]) {
      const { agents, report } = fixture(); if (!valid) report.claimReviews[0].claim = plain.replace("1階", "2階");
      const completed = draft(report);
      for (const checkpoint of [{ synthesisDraft: completed }, { ...completed, provider: "OpenAI" }]) {
        const saved: any[] = [];
        const meter = { costDb: db, userId: "owner", runId: "run", jobId: "job", operation: "fact_check_synthesis",
          checkpoint: async (value: any) => { saved.push(value); } };
        const retry = () => synthesize(qualityInput, agents, meter, "", checkpoint);
        for (let attempt = 0; attempt < 2; attempt++) {
          if (valid) {
            const result = await retry();
            const output = JSON.parse(result.report_row.report);
            assert.equal(output.claimReviews[0].claim, raw); assert.equal(output.qualityGate.version, 3);
            assert.equal(output.qualityGate.claimQuotationRecovery.additionalGenerations, 0);
            assert.equal(result.synthesisDraft.text, completed.text);
          } else await assert.rejects(retry, (error: any) => {
            assert.match(error.message, /claimReviews\[0\]\.claim/);
            assert.equal(error.checkpoint.synthesisDraft.text, completed.text);
            assert.equal(error.checkpoint.sourceRecovery.additionalGenerations, 0);
            assert.equal(error.checkpoint.sourceRecovery.status, "needs_review");
            assert.equal(error.checkpoint.report_row, undefined); return true;
          });
        }
        assert.equal(saved[0].synthesisDraft.text, completed.text);
      }
    }
    assert.equal(calls, 0); assert.equal(writes, 0);
  } finally { globalThis.fetch = oldFetch; }
});

Deno.test("synthesis prompt explicitly preserves raw Markdown in claim quotations", () => {
  const { agents } = fixture();
  assert.match(buildSynthesisPrompt(qualityInput, agents), /claim[^\n]*Markdown[^\n]*\*\*/);
});
