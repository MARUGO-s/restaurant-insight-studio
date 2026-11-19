import { strict as assert } from "node:assert";
import { buildSynthesisPrompt, executeJob } from "../functions/restaurant-analysis/core.ts";
import { directPageReceipts, loadDirectPages } from "../functions/restaurant-analysis/direct-pages.ts";

const officialUrl = "https://www.bistro-cavacava.com/";
const officialAlias = "https://bistro-cavacava.com/";
const storeUrl = "https://tabelog.com/tokyo/A1309/A130903/13245351/";
const courseUrl = storeUrl + "party/";
const selectedTabelog = [{ id: "tabelog", name: "食べログ", url: storeUrl }];

function htmlResponse(content: string, title: string) {
  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${title}</title></head><body>${content}</body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

function officialPage() {
  return htmlResponse(`<main>
    <nav>除外するナビゲーション</nav>
    <section id="info"><p>営業時間は18時から22時まで。火曜日は定休日です。席の空き状況はお電話でもお問い合わせいただけます。</p></section>
    <section id="party"><h2>貸切のご案内</h2><p>貸切は人数とご予算に応じてご相談ください。</p></section>
    <script>本文として渡さないスクリプト</script>
  </main>`, "ビストロ サヴァサヴァ公式");
}

function storefrontPage() {
  return htmlResponse(`<table>
    <tr><th>店名</th><td>ビストロ サヴァサヴァ</td></tr>
    <tr><th>住所</th><td>東京都新宿区荒木町</td></tr>
    <tr><th>個室</th><td>有</td></tr>
    <tr><th>貸切</th><td>不可</td></tr>
  </table>`, "ビストロ サヴァサヴァ 店舗情報 - 食べログ");
}

function coursesPage() {
  return htmlResponse(`<div class="course-list">
    <article class="rstdtl-course-list">
      <h3 class="rstdtl-course-list__course-title">Bコース 全6品</h3>
      <p class="rstdtl-course-list__desc">前菜からデザートまで全8品をご用意します。</p>
      <div class="rstdtl-course-list__price">8,800円</div>
      <div class="rstdtl-course-list__course-rule">2名様から</div>
    </article>
    <article class="rstdtl-course-list">
      <h3 class="rstdtl-course-list__course-title">ノエルコース</h3>
      <p class="rstdtl-course-list__desc">12月の期間限定です。</p>
      <div class="rstdtl-course-list__price">15,000円</div>
    </article>
  </div>`, "コース一覧 - ビストロ サヴァサヴァ - 食べログ");
}

function directFetch(routes: Record<string, () => Response>) {
  const calls: string[] = [];
  const get: typeof fetch = async (target, options) => {
    const url = String(target);
    calls.push(url);
    assert.equal(options?.method ?? "GET", "GET");
    assert.equal(options?.redirect, "manual");
    for (const name of ["authorization", "cookie", "x-goog-api-key"]) {
      assert.equal(new Headers(options?.headers).has(name), false);
    }
    return routes[url]?.() ?? new Response(null, { status: 404 });
  };
  return { calls, get };
}

Deno.test("direct retrieval hands separate official, Tabelog storefront, and course text to the caller", async () => {
  const { calls, get } = directFetch({
    [officialUrl]: () => Response.redirect(officialAlias),
    [officialAlias]: officialPage,
    [storeUrl]: storefrontPage,
    [courseUrl]: coursesPage,
  });
  const pages = await loadDirectPages(officialUrl, [{ id: "tabelog", url: storeUrl + "party?utm_source=fixture#courses" }], get);
  assert.deepEqual(calls.sort(), [officialUrl, officialAlias, storeUrl, courseUrl].sort());
  const official = pages.find(page => page.kind === "official");
  const store = pages.find(page => page.kind === "tabelog-store");
  const courses = pages.find(page => page.kind === "tabelog-courses");
  for (const page of [official, store, courses]) {
    assert.equal(page?.status, "retrieved");
    assert.ok(page?.title);
    assert.ok(Number.isFinite(Date.parse(page?.retrievedAt ?? "")));
  }
  assert.match(official?.text ?? "", /貸切は人数とご予算に応じてご相談/);
  assert.doesNotMatch(official?.text ?? "", /除外するナビゲーション|本文として渡さないスクリプト/);
  assert.equal(store?.url, storeUrl);
  assert.match(store?.text ?? "", /貸切\s*[：:]\s*不可/);
  assert.equal(courses?.url, courseUrl);
  assert.match(courses?.text ?? "", /Bコース 全6品[\s\S]*全8品[\s\S]*8,800円[\s\S]*2名様から[\s\S]*ノエルコース/);
  const receipts = directPageReceipts(pages);
  assert.equal(receipts.length, 3);
  assert.ok(receipts.every(receipt => receipt.status === "retrieved" && !("text" in receipt)));
});

Deno.test("Tabelog direct requests require a selected Tabelog restaurant URL", async () => {
  const { calls, get } = directFetch({ [officialUrl]: officialPage });
  const unselected = await loadDirectPages(officialUrl, [{ id: "custom-reference", url: storeUrl }], get);
  const blank = await loadDirectPages(officialUrl, [{ id: "tabelog", url: "" }], get);
  assert.deepEqual(calls, [officialUrl, officialUrl]);
  assert.equal(unselected.some(page => page.kind.startsWith("tabelog") && page.status === "retrieved"), false);
  const withoutUrl = blank.filter(page => page.kind.startsWith("tabelog"));
  assert.ok(withoutUrl.length > 0);
  assert.ok(withoutUrl.every(page => page.status === "search_only" && page.url === "" && !page.text));
});

Deno.test("direct requests reject unsupported URLs before opening any connection", async () => {
  const { calls, get } = directFetch({});
  const cases = [
    ["http://127.0.0.1:80/", "https://example.test/tokyo/A1309/A130903/13245351/"],
    ["https://www.bistro-cavacava.com/another-store/", storeUrl.replace("tabelog.com", "tabelog.com.example.test")],
    ["https://example.test/", storeUrl + "dtlrvwlst/"],
    ["https://www.bistro-cavacava.com:8443/", storeUrl.replace("tabelog.com", "tabelog.com:8443")],
    ["https://guest@www.bistro-cavacava.com/", storeUrl.replace("tabelog.com", "guest@tabelog.com")],
  ];
  for (const [official, site] of cases) {
    const pages = await loadDirectPages(official, [{ id: "tabelog", url: site }], get);
    assert.ok(pages.every(page => page.status === "search_only" && !page.text));
  }
  assert.deepEqual(calls, []);
});

Deno.test("manual redirects cannot switch restaurant paths or reach unapproved destinations", async () => {
  const { calls, get } = directFetch({
    [officialUrl]: () => Response.redirect(officialAlias + "another-store/"),
    [storeUrl]: () => Response.redirect(storeUrl.replace("13245351", "13245352")),
    [courseUrl]: () => Response.redirect("https://127.0.0.1/"),
  });
  const pages = await loadDirectPages(officialUrl, selectedTabelog, get);
  assert.deepEqual(calls.sort(), [officialUrl, storeUrl, courseUrl].sort());
  assert.equal(pages.length, 3);
  assert.ok(pages.every(page => page.status === "unavailable" && page.reason && !page.text));
});

Deno.test("a storefront response failure keeps the course text and a challenge page contributes no evidence", async () => {
  const { get } = directFetch({
    [officialUrl]: () => htmlResponse("<main>営業時間と貸切の詳細をご確認ください。</main>", "Access Denied"),
    [storeUrl]: () => new Response("アクセスできません", { status: 403 }),
    [courseUrl]: coursesPage,
  });
  const pages = await loadDirectPages(officialUrl, selectedTabelog, get);
  const unavailable = pages.filter(page => page.status === "unavailable");
  assert.deepEqual(unavailable.map(page => page.kind).sort(), ["official", "tabelog-store"]);
  assert.ok(unavailable.every(page => page.reason && !page.text));
  assert.match(pages.find(page => page.kind === "tabelog-courses")?.text ?? "", /全6品[\s\S]*全8品/);
});

Deno.test("a retry reuses the same successfully captured pages and retries the failed page", async () => {
  const first = directFetch({
    [officialUrl]: officialPage,
    [storeUrl]: () => new Response(null, { status: 503 }),
    [courseUrl]: coursesPage,
  });
  const saved = await loadDirectPages(officialUrl, selectedTabelog, first.get);
  const retry = directFetch({ [storeUrl]: storefrontPage });
  const pages = await loadDirectPages(officialUrl, selectedTabelog, retry.get, saved);
  assert.deepEqual(retry.calls, [storeUrl]);
  assert.deepEqual(pages.find(page => page.kind === "official"), saved.find(page => page.kind === "official"));
  assert.deepEqual(pages.find(page => page.kind === "tabelog-courses"), saved.find(page => page.kind === "tabelog-courses"));
  assert.match(pages.find(page => page.kind === "tabelog-store")?.text ?? "", /貸切\s*[：:]\s*不可/);
});

Deno.test("over-limit and non-HTML responses cannot contribute page text", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(3 * 1024 * 1024)); },
    cancel() { cancelled = true; },
  });
  const { get } = directFetch({
    [officialUrl]: () => Response.json({ text: "営業時間のJSON" }),
    [storeUrl]: storefrontPage,
    [courseUrl]: () => new Response(body, { headers: { "content-type": "text/html" } }),
  });
  const pages = await loadDirectPages(officialUrl, selectedTabelog, get);
  assert.equal(cancelled, true);
  assert.equal(pages.find(page => page.kind === "tabelog-store")?.status, "retrieved");
  assert.ok(pages.filter(page => page.kind !== "tabelog-store").every(page => page.status === "unavailable" && !page.text));
});

Deno.test("a long course list reports truncation and preserves the price and conditions on retained cards", async () => {
  const cards = Array.from({ length: 21 }, (_, index) => {
    const number = index + 1;
    return `<article class="rstdtl-course-list">
      <h3 class="rstdtl-course-list__course-title">コース番号${number}の見出し</h3>
      <p class="rstdtl-course-list__desc">コース番号${number}の説明${"詳細📋".repeat(1_000)}</p>
      <div class="rstdtl-course-list__price">${number * 1_000}円</div>
      <div class="rstdtl-course-list__course-rule">${number}名様から</div>
    </article>`;
  }).join("\n");
  const { get } = directFetch({
    [officialUrl]: officialPage,
    [storeUrl]: storefrontPage,
    [courseUrl]: () => htmlResponse(`<main class="course-list">${cards}</main>`, "長いコース一覧"),
  });
  const pages = await loadDirectPages(officialUrl, selectedTabelog, get);
  const courses = pages.find(page => page.kind === "tabelog-courses");
  assert.equal(courses?.status, "retrieved");
  assert.equal(courses?.truncated, true);
  assert.match(courses?.text ?? "", /コース番号20の見出し[\s\S]*コース番号20の説明[\s\S]*20000円[\s\S]*20名様から/);
  assert.doesNotMatch(courses?.text ?? "", /コース番号21の見出し/);
  assert.equal(courses?.text?.isWellFormed(), true);
  assert.equal(directPageReceipts(pages).find(page => page.kind === "tabelog-courses")?.truncated, true);
});

function gourmetDatabase() {
  const outputs: any[] = [];
  const checkpoints: any[] = [];
  const costReservations: any[] = [];
  const db = {
    from(table: string) {
      assert.equal(table, "restaurant_insight_cost_events");
      return {
        insert: async (row: unknown) => { costReservations.push(row); return { error: null }; },
        update: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }),
      };
    },
    async rpc(method: string, args: unknown) {
      if (method === "restaurant_insight_checkpoint_job") checkpoints.push(args);
      if (method === "restaurant_insight_finish_job") outputs.push(args);
      return { data: true, error: null };
    },
  };
  return { db, checkpoints, outputs, costReservations };
}

Deno.test("the gourmet worker supplies original page text to Gemini and preserves verified direct sources for synthesis", async () => {
  const previousFetch = globalThis.fetch;
  const previousKey = Deno.env.get("GEMINI_API_KEY");
  const { db, checkpoints, outputs, costReservations } = gourmetDatabase();
  const { calls, get } = directFetch({
    [officialUrl]: officialPage,
    [storeUrl]: () => new Response("取得できません", { status: 403 }),
    [courseUrl]: coursesPage,
  });
  const requests: any[] = [];
  const input = {
    storeName: "BistroCAVACAVA", storeUrl: officialUrl, groupName: null, selectedSites: selectedTabelog,
    researchFocus: "貸切条件とコース品数の差を確認する",
  };
  const searchSource = "https://tabelog.com/tokyo/A1309/A130903/13245351/dtlmenu/";
  globalThis.fetch = async (target, options) => {
    const url = new URL(String(target));
    if (url.hostname !== "generativelanguage.googleapis.com") return get(target, options);
    assert.equal(options?.method, "POST");
    assert.equal(new Headers(options?.headers).get("x-goog-api-key"), "test-key-only");
    assert.match(checkpoints[0]?.p_output?.directPages?.find((page: any) => page.kind === "tabelog-courses")?.text ?? "", /全6品[\s\S]*全8品/);
    requests.push(JSON.parse(String(options?.body)));
    return Response.json({
      candidates: [{
        content: { parts: [{ text: `媒体調査は完了しました。照合候補: ${storeUrl}\n<MENU_INVENTORY>[]</MENU_INVENTORY>` }] },
        finishReason: "STOP",
        groundingMetadata: { groundingChunks: [{ web: { uri: searchSource } }] },
      }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 },
    });
  };
  Deno.env.set("GEMINI_API_KEY", "test-key-only");
  try {
    await executeJob(db, {
      id: "gourmet-job", job_key: "gourmet", lease_token: "worker-lease", attempts: 1, max_attempts: 3, output: {},
    }, { id: "run-id", user_id: "owner-id", input });
    assert.equal(outputs.length, 1);
    assert.equal(outputs[0].p_error, null);
    const agent = outputs[0].p_output;
    assert.equal(agent.status, "done");
    assert.deepEqual(calls.sort(), [officialUrl, storeUrl, courseUrl].sort());
    assert.equal(requests.length, 1);
    const payload = requests[0];
    assert.deepEqual(payload.tools, [{ google_search: {} }]);
    assert.equal(payload.generationConfig.maxOutputTokens, 32_768);
    const prompt = payload.contents.flatMap((content: any) => content.parts).map((part: any) => part.text).join("\n");
    assert.match(prompt, /指定ページから取得した本文/);
    assert.match(prompt, /貸切は人数とご予算に応じてご相談/);
    assert.match(prompt, /Bコース 全6品[\s\S]*全8品/);
    assert.doesNotMatch(prompt, /取得できません|本文として渡さないスクリプト/);
    assert.equal(costReservations.length, 1);
    assert.equal(costReservations[0].operation, "gourmet_research");
    assert.equal(costReservations[0].provider, "Google Gemini");
    assert.deepEqual([...agent.sources].sort(), [officialUrl, courseUrl, searchSource].sort());
    assert.equal(agent.directPages.find((page: any) => page.kind === "tabelog-store")?.status, "unavailable");
    assert.match(agent.directPages.find((page: any) => page.kind === "tabelog-courses")?.text ?? "", /全6品[\s\S]*全8品/);
    const synthesis = buildSynthesisPrompt(input, [agent]);
    assert.match(synthesis, /Bコース 全6品[\s\S]*全8品/);
    assert.match(synthesis, /貸切は人数とご予算に応じてご相談/);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) Deno.env.delete("GEMINI_API_KEY");
    else Deno.env.set("GEMINI_API_KEY", previousKey);
  }
});
