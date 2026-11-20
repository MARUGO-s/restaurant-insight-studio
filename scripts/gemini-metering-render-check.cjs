const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const sourceRoot = path.join(root, "src");
const noNetwork = () => { throw new Error("Network requests are disabled for this test"); };
const browserModules = {
  "./lib/api": { invoke: noNetwork },
  "./lib/supabase": { supabase: new Proxy({}, { get: noNetwork }) },
  "./StoreNameInput": {},
  "./ReportView": {},
  "./ReportShareControls": {},
  "./ReportTrash": {},
  // Keep the expected yen amounts independent of the latest published exchange rate.
  "./boj-usd-jpy.json": {
    yenPerDollar: 159.59,
    asOf: "2026-11-19",
    source: "https://www.boj.or.jp/statistics/market/forex/fxdaily/fxlist/fx261119.pdf",
  },
};

function loadComponent(file, extraSource = "") {
  const filePath = path.join(sourceRoot, file);
  const loaded = new Module(filePath);
  loaded.filename = filePath;
  loaded.require = (name) => {
    if (Object.hasOwn(browserModules, name)) return browserModules[name];
    if (name === "./lib/costs") return loadComponent("lib/costs.ts");
    if (name === "./ProviderDiagnostics") return loadComponent("ProviderDiagnostics.tsx");
    return require(name);
  };
  const source = fs.readFileSync(filePath, "utf8") + extraSource;
  const compilerOptions = { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true };
  loaded._compile(ts.transpileModule(source, { compilerOptions }).outputText, filePath);
  return loaded.exports;
}

const ledgerCheck = spawnSync("deno", ["run", "--frozen", "--node-modules-dir=none", "--check", "--no-prompt", "--deny-net",
  "--allow-env=GEMINI_API_KEY,GEMINI_MODEL", "scripts/gemini-metering-ledger-check.ts"], {
  cwd: root,
  encoding: "utf8",
  env: { ...process.env, GEMINI_API_KEY: "offline-test-key", GEMINI_MODEL: "gemini-3.8-flash" },
  stdio: ["ignore", "pipe", "inherit"],
});
if (ledgerCheck.error) throw ledgerCheck.error;
assert.equal(ledgerCheck.status, 0, "Offline Gemini metering failed");
const scenarios = JSON.parse(ledgerCheck.stdout);
assert.ok(Array.isArray(scenarios));
const expected = new Map([
  ["seven_distinct", ["Google検索 7件", "21.98円"]],
  ["seven_with_blank_and_duplicates", ["Google検索 3件", "13.04円"]],
  ["three_distinct", ["Google検索 3件", "13.04円"]],
  ["all_blank", ["Google検索 0件", "6.34円"]],
  ["missing_search_metadata", [undefined, "料金未確定"]],
]);

globalThis.fetch = noNetwork;
// Expose the real cost page to the test without changing the production module.
const { CostPage } = loadComponent("App.tsx", "\nexport { CostPage };\n");
const renderCosts = (costs, Component = CostPage) => renderToStaticMarkup(React.createElement(Component, {
  reports: [], costs, loading: false, error: "", onRefresh: noNetwork,
}));
for (const { label, row } of scenarios) {
  assert.ok(expected.has(label), `Unexpected or repeated case ${label}`);
  const ledger = renderCosts([row]).split('class="cost-event-list"')[1];
  assert.ok(ledger, "API call ledger is missing");
  assert.equal((ledger.match(/class="cost-event"/g) ?? []).length, 1);
  assert.match(ledger, /グルメ媒体調査/);
  const searchCount = ledger.match(/Google検索 \d+件/)?.[0];
  const price = ledger.match(/<div class="cost-event-price"><b>([^<]+)<\/b>/)?.[1];
  assert.deepEqual([searchCount, price], expected.get(label), label);
  expected.delete(label);
}
assert.equal(expected.size, 0, `Missing cases ${[...expected.keys()].join(", ")}`);

const rowsByLabel = new Map(scenarios.map(({ label, row }) => [label, row]));
const zeroSearch = rowsByLabel.get("all_blank");
const unpriced = rowsByLabel.get("missing_search_metadata");
const priorMonth = { ...rowsByLabel.get("three_distinct"), created_at: "2026-10-20T12:00:00Z" };

function assertMonthlyTotal(costs, amount, note) {
  const summary = renderCosts(costs).match(/<span>今月の標準料金積算<\/span><b>([^<]+)<\/b><small>([^<]+)<\/small>/);
  assert.ok(summary, "Monthly cost summary is missing");
  assert.deepEqual(summary.slice(1), [amount, note]);
}

// Keep the renderer in the ledger fixture's month across test dates and time zones.
const NativeDate = Date;
globalThis.Date = new Proxy(NativeDate, {
  construct: (target, args) => Reflect.construct(target, args.length ? args : ["2026-11-20T12:00:00Z"]),
});
try {
  assertMonthlyTotal([zeroSearch], "6.34円", "APIの返却値を記録済み");
  assertMonthlyTotal([unpriced], "0.00円", "料金未確定 1件を除く");
  assertMonthlyTotal([zeroSearch, unpriced, priorMonth], "6.34円", "料金未確定 1件を除く");

  const summary = renderCosts([
    { ...zeroSearch, run_id: "test-run" },
    { ...unpriced, run_id: "test-run" },
    { ...rowsByLabel.get("three_distinct"), operation: "followup_question" },
  ]);
  assert.match(summary, /1ドル＝159\.59円/);
  assert.match(summary, /日本銀行の中心相場（2026年11月19日）/);
  assert.match(summary, /<span>質問への回答<\/span><b>13\.04円<\/b>/);
  assert.match(summary, /<strong>判明分 6\.34円 \+ 未算定<\/strong>/);
  assert.match(summary, /class="cost-run-breakdown"><span>Google Gemini gemini-3\.8-flash: 6\.34円<\/span>/);

  browserModules["./boj-usd-jpy.json"] = {
    yenPerDollar: 160.25,
    asOf: "2026-11-20",
    source: "https://www.boj.or.jp/statistics/market/forex/fxdaily/fxlist/fx261120.pdf",
  };
  const { CostPage: UpdatedCostPage } = loadComponent("App.tsx", "\nexport { CostPage };\n");
  const updated = renderCosts([zeroSearch, unpriced], UpdatedCostPage);
  assert.match(updated, /1ドル＝160\.25円/);
  assert.match(updated, /日本銀行の中心相場（2026年11月20日）/);
  assert.match(updated, /<span>今月の標準料金積算<\/span><b>6\.37円<\/b><small>料金未確定 1件を除く<\/small>/);
  assert.match(updated, /class="cost-event-price"><b>6\.37円<\/b>/);
} finally {
  globalThis.Date = NativeDate;
}
console.log("Gemini search counts and prices match the call ledger and monthly summary");
