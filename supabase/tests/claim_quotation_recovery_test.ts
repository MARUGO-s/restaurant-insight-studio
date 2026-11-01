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
