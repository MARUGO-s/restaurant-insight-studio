import { strict as assert } from "node:assert";
import { withIntegrityReviews } from "./report_integrity_fixture.ts";
import { finalizeSynthesis, savedSynthesis, synthesize, executeJob, NonBillableSynthesisError, validateReportQuality, sourceUrls } from "../functions/restaurant-analysis/core.ts";
import { qualityReport, evidenceUrl } from "./report_quality_fixture.ts";
const parent = "https://tabelog.com/tokyo/A1304/A130401/13019866/";
const unread = `${parent}dtlrvwlst/B515656426/?lid=unpickup_review`;
const input = { storeName: "対象店", storeUrl: "https://store.example/", groupName: null, selectedSites: [{ id: "tabelog", name: "食べログ", url: parent }] };
const agents = () => [
  { id: "market", provider: "OpenAI", status: "done" as const, text: "同定した店舗の調査", sources: [parent] },
  { id: "gourmet", provider: "Google Gemini", status: "done" as const, text: "トップページの口コミ抜粋を確認。個別口コミ本文は未読。", sources: [parent], menuInventory: [] },
  { id: "social", provider: "xAI Grok", status: "done" as const, text: "期間と未確認事項を残した調査", sources: [] },
];
function report() {
  const value = JSON.parse(JSON.stringify(qualityReport()).replaceAll(evidenceUrl, parent));
  const row = value.researchCoverage.find((r: any) => r.targetId === "tabelog");
  row.scope = "トップに表示された口コミ抜粋3件を確認。個別口コミ詳細URLも開いたが本文を独立に再取得できず、抜粋以上は読んでいない。";
  row.limitation = "全口コミ・写真本文は未確認。";
  row.sources.push(unread);
  return value;
}
const draft = (value = report(), critique = "未確認の運用を断定せず反例を残す。") => ({ version: 1 as const, responseStatus: "completed" as const,
  text: JSON.stringify({ critique, report: value }), toolSources: [parent], costId: "completed-cost", responseId: "resp-completed" });
const cost = () => ({ id: "completed-cost", provider: "OpenAI", request_status: "succeeded", request_metadata: { response_status: "completed", provider_response_id: "resp-completed" } });
function database(costs: any[] = [cost()], specialists: Parameters<typeof finalizeSynthesis>[1] = agents()) {
  const filters: any[] = [], rpcCalls: any[] = [], saved: any = {}, writes: any[] = [];
  let finishFailures = 0;
  const db: any = { failFinishOnce() { finishFailures = 1; }, from(table: string) {
    const metadataFilters: [string, string][] = [];
    const q: any = { select() { return q; }, eq(k: string, v: any) {
      filters.push({ table, k, v });
      if (k.startsWith("request_metadata->>")) metadataFilters.push([k.split("->>")[1], v]);
      return q;
    }, neq() { return q; },
      order() { return q; }, limit() { return q; },
      insert(row: any) { writes.push(row); costs.push(row); return Promise.resolve({ error: null }); },
      update(row: any) { writes.push(row); return q; },
      then(resolve: any, reject: any) {
        const data = table === "restaurant_insight_jobs" ? [
          { job_key: "market", status: "done", output: specialists[0] }, { job_key: "gourmet", status: "done", output: specialists[1] },
          { job_key: "social_recent", status: "done", output: specialists[2] }, { job_key: "social_history", status: "done", output: specialists[2] },
        ] : costs.filter(cost => metadataFilters.every(([k, v]) => String(cost.request_metadata?.[k]) === v));
        return Promise.resolve({ data, error: null }).then(resolve, reject);
      } };
    return q;
  }, async rpc(name: string, args: any) {
    rpcCalls.push({ name, args });
    if (name === "restaurant_insight_checkpoint_job") Object.assign(saved, args.p_output);
    if (name === "restaurant_insight_finish_job" && finishFailures-- > 0) return { error: { message: "temporary finish failure" } };
    if (name === "restaurant_insight_finish_job" && args.p_output) Object.assign(saved, args.p_output);
    return { data: { accepted: true }, error: null };
  } };
  return { db, filters, rpcCalls, saved, writes };
}
const meter = (db: any) => ({ costDb: db, userId: "owner", runId: "run", jobId: "job", operation: "fact_check_synthesis" });
const run = { id: "run", user_id: "owner", input };
const job = (output: any) => ({ id: "job", job_key: "synthesis", attempts: 1, lease_token: "lease", output });
async function noNetwork(fn: () => Promise<void>) {
  const oldFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = () => { calls++; throw new Error("Network forbidden during recovery"); };
  try { await fn(); assert.equal(calls, 0); } finally { globalThis.fetch = oldFetch; }
}
Deno.test("unread coverage detail is removed only with an observed selected parent; every other field is preserved", async () => {
  const original = report(), originalJson = JSON.stringify(original), d = draft(original);
  assert.throws(() => validateReportQuality(original, input, [parent]), /追跡できない/);
  const result = await finalizeSynthesis(input, agents(), d);
  const recovered = JSON.parse(result.report_row.report), expected = structuredClone(original);
  expected.researchCoverage.find((r: any) => r.targetId === "tabelog").sources = [parent];
  delete recovered.qualityGate; delete recovered.productInventory;
  assert.deepEqual(recovered, expected); assert.equal(JSON.stringify(original), originalJson);
  assert.equal(result.report_row.critique, "未確認の運用を断定せず反例を残す。");
  assert.equal(result.synthesisDraft.text, d.text); assert.equal(result.sourceRecovery.status, "recovered");
  assert.equal(result.sourceRecovery.corrections[0].removedUrl, unread);
  assert.equal(result.sourceRecovery.corrections[0].retainedParentUrl, parent);
  assert.equal(result.sourceRecovery.additionalGenerations, 0);
  assert.equal(sourceUrls("", result.report_row.report_sources).includes(unread), false);
  assert.match(result.sourceRecovery.originalSha256, /^[a-f0-9]{64}$/);
});
Deno.test("v3 coverage recovery ignores model-owned raw inventory and preserves the completed original", async () => {
  await noNetwork(async () => {
    const original = withIntegrityReviews(report(), agents());
    const value = { ...original, originalProductInventory: [{ source: "https://invented.test/raw" }] };
    const completed = { ...draft(value), requiredReportVersion: 3 as const };
    const result = await finalizeSynthesis(input, agents(), completed);
    const recovered = JSON.parse(result.report_row.report), expected = structuredClone(original);
    expected.researchCoverage.find((r: any) => r.targetId === "tabelog").sources = [parent];
    assert.deepEqual(recovered.originalProductInventory, []);
    assert.deepEqual(recovered.productInventory, []);
    assert.equal(recovered.qualityGate.version, 3);
    delete recovered.originalProductInventory; delete recovered.productInventory; delete recovered.qualityGate;
    assert.deepEqual(recovered, expected);
    assert.deepEqual(result.synthesisDraft, completed);
    assert.equal(completed.text, draft(value).text);
    assert.equal(result.sourceRecovery.status, "recovered");
    assert.equal(result.sourceRecovery.additionalGenerations, 0);
    assert.deepEqual(result.sourceRecovery.corrections.map(c => c.removedUrl), [unread]);
    assert.equal(result.report_row.report_sources.includes("https://invented.test/raw"), false);
  });
});
Deno.test("unknown evidence in claims, body, tables or critique blocks recovery rather than deleting content", async () => {
  const patches = [
    (r: any) => { r.keyFindings[0].sources.push(unread); },
    (r: any) => { r.keyFindings[0].evidence += ` ${unread}`; },
    (r: any) => { r.detailSections[0].body += ` ${unread}`; },
    (r: any) => { r.detailSections[0].rows[0][0] = unread; },
  ];
  for (const patch of patches) { const r = report(); patch(r); await assert.rejects(() => finalizeSynthesis(input, agents(), draft(r)), /追跡できない/); }
  await assert.rejects(() => finalizeSynthesis(input, agents(), draft(report(), `反証の根拠 ${unread}`)), /追跡できない/);
});
Deno.test("wrong store, different origin, menu page, arbitrary query and verified row cannot be silently repaired", async () => {
  for (const url of [unread.replace("13019866", "99999999"), unread.replace("tabelog.com", "tabelog.com.evil.test"),
    `${parent}dtlmenu/lunch/`, `${unread}&page=2`, `${parent}dtlrvwlst/B515656426/#evidence`, "javascript:alert(1)"]) {
    const r = report(); r.researchCoverage.find((r: any) => r.targetId === "tabelog").sources = [parent, url];
    await assert.rejects(() => finalizeSynthesis(input, agents(), draft(r)));
  }
  const r = report(); r.researchCoverage.find((r: any) => r.targetId === "tabelog").status = "verified";
  await assert.rejects(() => finalizeSynthesis(input, agents(), draft(r)));
});
Deno.test("ambiguous limitations or absent observed parent do not permit source removal", async () => {
  for (const patch of [
    (row: any) => { row.scope = "掲載内容を確認。全口コミは未読。"; },
    (row: any) => { row.scope = "個別口コミ詳細は取得できず。"; },
    (row: any) => { row.sources = [unread]; },
  ]) {
    const r = report(); patch(r.researchCoverage.find((r: any) => r.targetId === "tabelog"));
    await assert.rejects(() => finalizeSynthesis(input, agents(), draft(r)));
  }
  await assert.rejects(() => finalizeSynthesis(input, agents().map(a => ({ ...a, sources: [] })), { ...draft(), toolSources: [] }));
});
Deno.test("full quality gate still rejects missing chapters and broken action links after source correction", async () => {
  for (const patch of [(r: any) => { r.detailSections.pop(); }, (r: any) => { r.actionPlan[0].findingIds = ["nonexistent"]; }]) {
    const r = report(); patch(r); await assert.rejects(() => finalizeSynthesis(input, agents(), draft(r)), /詳細章が不足|施策/);
  }
});
Deno.test("known detail references are retained and automatic recovery is idempotent", async () => {
  const valid = await finalizeSynthesis(input, agents(), { ...draft(), toolSources: [parent, unread] });
  assert.equal(valid.sourceRecovery.status, "unchanged"); assert.ok(JSON.parse(valid.report_row.report).researchCoverage.at(-1).sources.includes(unread));
  const first = await finalizeSynthesis(input, agents(), draft()), second = await finalizeSynthesis(input, agents(), draft());
  assert.deepEqual(first.sourceRecovery.corrections, second.sourceRecovery.corrections);
  assert.equal(first.sourceRecovery.originalSha256, second.sourceRecovery.originalSha256);
});
Deno.test("completed durable response is recovered and saved with zero provider calls and no new cost rows", async () => {
  await noNetwork(async () => {
    const d = database(); await executeJob(d.db, job({ synthesisDraft: draft() }), run);
    const finish = d.rpcCalls.find(c => c.name === "restaurant_insight_finish_job").args;
    assert.equal(finish.p_error, null); assert.equal(finish.p_output.sourceRecovery.status, "recovered");
    assert.equal(d.saved.synthesisComplete, true); assert.equal(d.writes.length, 0);
    for (const k of ["user_id", "run_id", "job_id", "operation", "request_metadata->>response_status"]) assert.ok(d.filters.some(f => f.k === k));
  });
});

const courseList = `${parent}party/`;
const courseDetails = [`${courseList}263184765`, `${courseList}266358552`];
const courses = [
  { name: "Aコース4品", price: "7,000円 (税込)", listedCount: "4品", describedCount: "6品" },
  { name: "Bコース6品", price: "13,000円 (税込)", listedCount: "6品", describedCount: "8品" },
];
function courseAgents() {
  const [market, gourmet, social] = agents();
  return [market, { ...gourmet, text: "コース一覧でAコース4品・Bコース6品を確認。", sources: [parent, courseList],
    directPages: [{ kind: "tabelog-courses" as const, url: courseList, status: "retrieved" as const,
      title: "コース一覧 | 食べログ", retrievedAt: "2026-11-20T03:00:00Z", text: "コース一覧 Aコース4品 Bコース6品" }],
    menuInventory: courses.map((course, i) => ({ id: `M${i + 1}`, name: course.name, price: course.price,
      conditions: `一覧では${course.listedCount}`, site: "食べログ", source: courseList })),
  }, social];
}
function completedCourseDraft(specialists = courseAgents(), details = courseDetails) {
  const base = JSON.parse(JSON.stringify(qualityReport()).replaceAll(evidenceUrl, courseList));
  const original = withIntegrityReviews(base, specialists);
  original.claimReviews[1] = { ...original.claimReviews[1], decision: "supported",
    reason: "構造化欄に記載された品数と説明の記述に相違がある。", sources: [courseList, ...details] };
  original.keyFindings[0].sources.push(details[0]);
  original.detailSections.find((section: any) => section.id === "menu").sources.push(details[1]);
  original.productReviews = courses.map((course, i) => ({ id: `M${i + 1}`, status: "corrected",
    reason: "個別ページの説明と構造化欄を両方記録する。", sources: [details[i]],
    corrected: { name: course.name, price: course.price, conditions: `品数は欄で${course.listedCount}、説明で${course.describedCount}`,
      site: "食べログ", source: details[i] },
  }));
  return { original, completed: { ...draft(original), requiredReportVersion: 3 as const,
    toolSources: [parent, courseList], responseId: "resp_completed_courses" } };
}
function courseHtml(index: number) {
  const course = courses[index];
  return `<html><head><title>${course.name} | 食べログ</title></head><body id="rstdtl_party_dtl">
    <div class="course-dtl"><h3 class="course-dtl__course-title">${course.name}</h3>
    <div class="course-dtl__desc">コースの説明では${course.describedCount}と記載。</div>
    <table class="course-dtl__data-table"><tr><th>コース料金</th><td><span class="course-dtl__price-num">${course.price}</span></td></tr>
    <tr><th>品数</th><td>${course.listedCount}</td></tr></table></div></body></html>`;
}
const htmlResponse = (html: string) => new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
function useCourseFetch(fallback?: (index: number) => Response) {
  const fetchBefore: typeof fetch = globalThis.fetch, calls: { url: string; method: string; redirect?: RequestRedirect }[] = [];
  const browserSettings = ["RESTAURANT_BROWSER_ACCOUNT_ID", "RESTAURANT_BROWSER_API_TOKEN"].map(key => [key, Deno.env.get(key)] as const);
  for (const [key] of browserSettings) Deno.env.delete(key);
  globalThis.fetch = async (resource, init) => {
    const url = String(resource);
    calls.push({ url, method: init?.method ?? "GET", redirect: init?.redirect });
    const index = courseDetails.indexOf(url);
    if (index < 0) throw new Error("Expected an exact course detail request");
    return fallback ? fallback(index) : htmlResponse(courseHtml(index));
  };
  return { calls, restore() {
    globalThis.fetch = fetchBefore;
    for (const [key, value] of browserSettings) if (value !== undefined) Deno.env.set(key, value);
  } };
}

Deno.test("two retrieved Tabelog course details complete the saved v3 report with no new AI calls or costs", async () => {
  const specialists = courseAgents();
  const { original, completed } = completedCourseDraft(specialists);
  const ledger = { ...cost(), attempt_number: 1, request_metadata: { synthesis_background: true,
    response_status: "completed", provider_response_id: completed.responseId } };
  const d = database([ledger], specialists);
  const fetch = useCourseFetch();
  try {
    await executeJob(d.db, { ...job({ synthesisDraft: completed }), attempts: 2 }, run);
    assert.deepEqual(fetch.calls.map(call => call.url).sort(), [...courseDetails].sort());
    assert.ok(fetch.calls.every(call => call.method === "GET" && call.redirect === "manual"));
    assert.equal(d.writes.length, 0);
    const finish = d.rpcCalls.find(call => call.name === "restaurant_insight_finish_job").args;
    assert.equal(finish.p_error, null);
    assert.equal(d.saved.synthesisComplete, true);
    assert.deepEqual(d.saved.synthesisDraft, completed);
    assert.equal(d.saved.sourceRecovery.status, "recovered");
    assert.equal(d.saved.sourceRecovery.additionalGenerations, 0);
    assert.equal(d.saved.sourceRecovery.costId, completed.costId);
    const pages = d.saved.sourceRecovery.courseDetailVerification;
    assert.deepEqual(pages.map((page: any) => page.requestedUrl).sort(), [...courseDetails].sort());
    for (const [index, url] of courseDetails.entries()) {
      const page = pages.find((p: any) => p.requestedUrl === url);
      assert.equal(page.url, url);
      assert.ok(Number.isFinite(Date.parse(page.retrievedAt)));
      assert.ok(page.text.includes(courses[index].price));
      assert.ok(page.text.includes(courses[index].listedCount));
      assert.ok(page.text.includes(courses[index].describedCount));
      assert.ok(d.saved.report_row.report_sources.includes(url));
    }
    const { qualityGate, productInventory, originalProductInventory, ...savedReport } = JSON.parse(d.saved.report_row.report);
    assert.deepEqual(savedReport, original);
    assert.equal(qualityGate.version, 3);
    assert.equal(qualityGate.courseDetailVerification.additionalGenerations, 0);
    assert.deepEqual(qualityGate.courseDetailVerification.pages.map((page: any) => page.url).sort(), [...courseDetails].sort());
    assert.ok(qualityGate.courseDetailVerification.pages.every((page: any) =>
      page.requestedUrl === page.url && Number.isFinite(Date.parse(page.retrievedAt)) && !Object.hasOwn(page, "text")));
    assert.deepEqual(productInventory.map((product: any) => product.source), courseDetails);
    assert.deepEqual(originalProductInventory.map((product: any) => product.source), [courseList, courseList]);
  } finally {
    fetch.restore();
  }
});

Deno.test("a different course or a successful response without course detail cannot authorize a citation", async () => {
  const specialists = courseAgents();
  const { completed } = completedCourseDraft(specialists);
  for (const invalid of [
    () => new Response(null, { status: 302, headers: { location: courseDetails[0] } }),
    () => htmlResponse(courseHtml(1).replace("</head>", `<link rel="canonical" href="${courseDetails[0]}"></head>`)),
    () => htmlResponse("<html><head><title>コース一覧 | 食べログ</title></head><body>コース料金 13,000円 品数 6品</body></html>"),
  ]) {
    const fetch = useCourseFetch(index => index === 0 ? htmlResponse(courseHtml(0)) : invalid());
    const d = database([{
      ...cost(), request_metadata: { response_status: "completed", provider_response_id: completed.responseId },
    }], specialists);
    try {
      await executeJob(d.db, job({ synthesisDraft: completed }), run);
      assert.deepEqual(fetch.calls.map(call => call.url).sort(), [...courseDetails].sort());
      const finish = d.rpcCalls.find(call => call.name === "restaurant_insight_finish_job").args;
      assert.equal(finish.p_retryable, false);
      assert.match(finish.p_error, /追跡可能なURL/);
      assert.equal(d.saved.sourceRecovery.status, "needs_review");
      assert.equal(d.saved.sourceRecovery.additionalGenerations, 0);
      assert.deepEqual(d.saved.synthesisDraft, completed);
      assert.equal(d.saved.report_row, undefined);
      assert.equal(d.writes.length, 0);
    } finally {
      fetch.restore();
    }
  }
});

Deno.test("course detail recovery is scoped to the store with a fetched course list and preserves other validation gates", async () => {
  await noNetwork(async () => {
    const specialists = courseAgents();
    const { completed } = completedCourseDraft(specialists);
    const noVerifiedList = specialists.map(agent => ({ ...agent, directPages: [] }));
    await assert.rejects(() => finalizeSynthesis(input, noVerifiedList, completed), /追跡可能なURL/);
    const known = { ...completed, toolSources: [...completed.toolSources, ...courseDetails] };
    const alreadyValid = await finalizeSynthesis(input, specialists, known);
    assert.equal(alreadyValid.sourceRecovery.status, "unchanged");
    for (const foreign of [
      courseDetails[1].replace("13019866", "99999999"),
      courseDetails[1].replace("tabelog.com", "tabelog.com.example.test"),
      `${parent}dtlmenu/lunch/`,
    ]) {
      const { completed: foreignDraft } = completedCourseDraft(specialists, [courseDetails[0], foreign]);
      await assert.rejects(() => finalizeSynthesis(input, specialists, { ...foreignDraft, toolSources: [...foreignDraft.toolSources, courseDetails[0]] }), /追跡可能なURL/);
    }
  });
  const specialists = courseAgents();
  const { completed } = completedCourseDraft(specialists);
  const damaged = JSON.parse(completed.text);
  damaged.report.actionPlan[0].findingIds = ["nonexistent"];
  const fetch = useCourseFetch();
  try {
    await assert.rejects(() => finalizeSynthesis(input, specialists, { ...completed, text: JSON.stringify(damaged) }), /scope|施策/);
    assert.deepEqual(fetch.calls.map(call => call.url).sort(), [...courseDetails].sort());
  } finally {
    fetch.restore();
  }
});
Deno.test("v2 and v3 completed draft and terminal checkpoints recover without provider calls or cost writes", async () => {
  await noNetwork(async () => {
    for (const version of [2, 3]) {
      const value = version === 3
        ? { ...withIntegrityReviews(report(), agents()), originalProductInventory: [{ source: "https://invented.test/raw" }] }
        : report();
      const completed = { ...draft(value), ...(version === 3 ? { requiredReportVersion: 3 as const } : {}) };
      const terminal = version === 3 ? { ...completed, provider: "OpenAI" }
        : { provider: "OpenAI", text: completed.text, responseId: completed.responseId, toolSources: [parent], sources: [unread], partial: true };
      for (const output of [{ synthesisDraft: completed }, terminal]) {
        const d = database();
        await executeJob(d.db, job(output), run);
        const finish = d.rpcCalls.find(c => c.name === "restaurant_insight_finish_job").args;
        assert.equal(finish.p_error, null);
        assert.equal(d.saved.synthesisComplete, true);
        assert.equal(d.saved.sourceRecovery.status, "recovered");
        assert.equal(d.saved.sourceRecovery.additionalGenerations, 0);
        assert.equal(d.saved.synthesisDraft.text, completed.text);
        const savedReport = JSON.parse(d.saved.report_row.report);
        assert.equal(savedReport.qualityGate.version, version);
        assert.deepEqual(savedReport.researchCoverage.find((r: any) => r.targetId === "tabelog").sources, [parent]);
        if (version === 3) assert.deepEqual(savedReport.originalProductInventory, []);
        else assert.equal(Object.hasOwn(savedReport, "originalProductInventory"), false);
        assert.equal(d.writes.length, 0);
      }
    }
  });
});
Deno.test("raw inventory exclusion never authorizes unknown claim URLs or nested fields; refused drafts remain intact", async () => {
  await noNetwork(async () => {
    for (const version of [2, 3]) {
      for (const patch of [
        (r: any) => { r.keyFindings[0].evidence += " https://unobserved.test/claim"; },
        (r: any) => { r.detailSections[0].originalProductInventory = [{ source: "https://unobserved.test/nested" }]; },
        (r: any) => {
          if (version === 3) r.claimReviews[0].reason += " https://unobserved.test/review";
          else r.detailSections[0].body += " https://unobserved.test/body";
        },
      ]) {
        const value = version === 3 ? withIntegrityReviews(report(), agents()) : report();
        value.originalProductInventory = [{ source: "https://invented.test/raw" }];
        patch(value);
        const completed = { ...draft(value), ...(version === 3 ? { requiredReportVersion: 3 as const } : {}) };
        const d = database();
        await executeJob(d.db, job({ synthesisDraft: completed }), run);
        const finish = d.rpcCalls.find(c => c.name === "restaurant_insight_finish_job").args;
        assert.equal(finish.p_retryable, false);
        assert.match(finish.p_error, /追跡できない/);
        assert.equal(d.saved.sourceRecovery.status, "needs_review");
        assert.equal(d.saved.sourceRecovery.additionalGenerations, 0);
        assert.equal(d.saved.synthesisDraft.text, completed.text);
        assert.equal(d.saved.report_row, undefined);
        assert.equal(d.writes.length, 0);
      }
    }
  });
});
Deno.test("unsafe completed draft is retained for review; automatic and explicit retry never generate again", async () => {
  await noNetwork(async () => {
    const r = report(); r.keyFindings[0].sources.push("https://unobserved.test/claim");
    const d = database(); await executeJob(d.db, job({ synthesisDraft: draft(r) }), run);
    const finish = d.rpcCalls.find(c => c.name === "restaurant_insight_finish_job").args;
    assert.equal(finish.p_retryable, false); assert.match(finish.p_error, /追加のAI呼び出しは停止/);
    assert.equal(d.saved.sourceRecovery.status, "needs_review"); assert.equal(d.saved.synthesisDraft.text, draft(r).text);
    await executeJob(d.db, { ...job(d.saved), attempts: 2 }, run);
    assert.equal(d.writes.length, 0); assert.ok(d.rpcCalls.filter(c => c.name === "restaurant_insight_finish_job").every(c => c.args.p_retryable === false));
  });
});
Deno.test("completion without a recoverable answer cannot trigger paid regeneration", async () => {
  await noNetwork(async () => {
    const d = database(); await assert.rejects(() => synthesize(input, agents(), meter(d.db), "", {}), NonBillableSynthesisError);
    const damaged = { synthesisDraft: { ...draft(), text: "broken JSON" } };
    await assert.rejects(() => synthesize(input, agents(), meter(d.db), "", damaged), NonBillableSynthesisError);
    assert.equal(d.writes.length, 0);
  });
});
Deno.test("legacy terminal checkpoint requires the actual completed response ID, not its written source list", async () => {
  await noNetwork(async () => {
    const legacy = { provider: "OpenAI", text: draft().text, responseId: "resp-completed", sources: [unread], toolSources: [parent], partial: true };
    const d = database(); const result = await savedSynthesis(meter(d.db), legacy);
    assert.equal(result?.costId, "completed-cost"); assert.deepEqual(result?.toolSources, [parent]);
    await assert.rejects(() => savedSynthesis(meter(d.db), { ...legacy, responseId: "unrelated" }), NonBillableSynthesisError);
    // New progress snapshots explicitly marked in-progress must not be mistaken
    // for a complete legacy snapshot even if the later ledger says completed.
    await assert.rejects(() => savedSynthesis(meter(d.db), { ...legacy, responseStatus: "in_progress" }), NonBillableSynthesisError);
    const pending = database([{ ...cost(), request_status: "unknown" }]);
    await assert.rejects(() => savedSynthesis(meter(pending.db), { synthesisDraft: draft() }), NonBillableSynthesisError);
    await assert.rejects(() => savedSynthesis(meter(d.db), { synthesisDraft: { ...draft(), responseId: "different-response" } }), NonBillableSynthesisError);
    await assert.rejects(() => savedSynthesis(meter(d.db), { synthesisDraft: { ...draft(), costId: "different-cost" } }), NonBillableSynthesisError);
  });
});
Deno.test("finish failure resumes the validated completed draft without another paid generation", async () => {
  await noNetwork(async () => {
    const d = database(); d.db.failFinishOnce(); await executeJob(d.db, job({ synthesisDraft: draft() }), run);
    assert.equal(d.saved.synthesisComplete, true);
    await executeJob(d.db, { ...job(d.saved), attempts: 2 }, run);
    assert.equal(d.rpcCalls.filter(c => c.name === "restaurant_insight_finish_job").at(-1).args.p_error, null);
    assert.equal(d.writes.length, 0);
  });
});
Deno.test("new synthesis journals its completed original before validating and repairs in the same single generation", async () => {
  const d = database([]), checkpoints: any[] = [], oldFetch = globalThis.fetch, oldKey = Deno.env.get("OPENAI_API_KEY");
  const freshText = draft(withIntegrityReviews(report(), agents())).text;
  let calls = 0;
  Deno.env.set("OPENAI_API_KEY", "test-only");
  globalThis.fetch = async (_target, init) => {
    calls++;
    assert.equal(init?.method, "POST");
    const payload = JSON.parse(String(init?.body));
    assert.equal(payload.background, true);
    assert.equal(payload.model, "gpt-6.2-astra");
    return Response.json({ id: "resp_new", status: "completed", model: "gpt-6.2-astra", output_text: freshText,
      usage: { input_tokens: 10, output_tokens: 20 },
    });
  };
  try {
    const result = await synthesize(input, agents(), { ...meter(d.db), checkpoint: async value => { checkpoints.push(value); } });
    assert.ok(result);
    assert.equal(calls, 1); assert.equal(result.sourceRecovery.status, "recovered");
    const beforeValidation = checkpoints.find(c => c.synthesisDraft && !c.report_row);
    assert.equal(beforeValidation.synthesisDraft.text, freshText);
    assert.equal(beforeValidation.synthesisDraft.requiredReportVersion, 3);
    assert.equal(checkpoints.at(-1).synthesisComplete, true);
    assert.equal(d.writes.filter(w => w.id).length, 1);
    assert.ok(d.writes.some(w => w.request_metadata?.response_status === "completed"));
  } finally {
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) Deno.env.delete("OPENAI_API_KEY"); else Deno.env.set("OPENAI_API_KEY", oldKey);
  }
});
