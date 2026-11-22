const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

function loadTs(relative) {
  const filePath = path.join(process.cwd(), "src", relative);
  const loaded = new Module(filePath);
  loaded.filename = filePath;
  loaded.paths = Module._nodeModulePaths(path.dirname(filePath));
  const source = fs.readFileSync(filePath, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: filePath,
  });
  loaded.require = (name) => {
    if (name === "./lib/store-identity") return loadTs("lib/store-identity.ts");
    if (name.endsWith(".json")) return JSON.parse(fs.readFileSync(path.resolve(path.dirname(filePath), name), "utf8"));
    return Module._load(name, loaded, false);
  };
  loaded._compile(outputText, filePath);
  return loaded.exports;
}

const { groupReportsByStore, storeIdentityKey } = loadTs("lib/store-identity.ts");
const { MergeDialog } = loadTs("MergeDialog.tsx");

const fixtures = [
  { id: "app-yotsuya", storeName: "マルゴ四谷", storeUrl: "https://marugo-s.com/yotsuya/", source: "insight_studio", createdAt: "2026-10-31T12:00:00+09:00" },
  { id: "bot-yotsuya", storeName: "マルゴ 四谷", storeUrl: "https://marugo-s.com/yotsuya/", source: "gourmet_checker", shared: true, createdAt: "2026-11-21T10:00:00+09:00" },
  { id: "app-cava", storeName: "Bistro CAVACAVA", storeUrl: "https://www.bistro-cavacava.com/", source: "insight_studio", createdAt: "2026-10-31T12:00:00+09:00" },
  { id: "bot-cava", storeName: "ビストロ サヴァサヴァ", storeUrl: "https://www.bistro-cavacava.com/", source: "gourmet_checker", shared: true, createdAt: "2026-11-21T10:00:00+09:00" },
  { id: "app-marugo", storeName: "マルゴ", storeUrl: "https://bar-maru5.com/", source: "insight_studio", createdAt: "2026-11-01T12:00:00+09:00" },
  { id: "merged-cava", storeName: "ビストロ サヴァサヴァ", storeUrl: "https://www.bistro-cavacava.com/", source: "merged", createdAt: "2026-11-21T22:16:00+09:00" },
];

const groups = groupReportsByStore(fixtures);
const yotsuya = groups.find((group) => group.storeName === "マルゴ 四谷");
const cava = groups.find((group) => group.storeName === "ビストロ サヴァサヴァ");
const bar = groups.find((group) => group.storeName === "マルゴ");
assert.ok(yotsuya, "マルゴ 四谷 group");
assert.equal(yotsuya.reports.length, 2);
assert.deepEqual(yotsuya.reports.map((report) => report.id).sort(), ["app-yotsuya", "bot-yotsuya"]);
assert.ok(cava, "ビストロ サヴァサヴァ group");
assert.equal(cava.reports.length, 3);
assert.ok(cava.reports.some((report) => report.id === "app-cava"));
assert.ok(cava.reports.some((report) => report.id === "bot-cava"));
assert.ok(bar && bar.reports.length === 1);
assert.equal(storeIdentityKey("マルゴ四谷", ""), storeIdentityKey("マルゴ 四谷", "https://marugo-s.com/yotsuya/"));
assert.equal(storeIdentityKey("Bistro CAVACAVA", ""), storeIdentityKey("ビストロ サヴァサヴァ", ""));

const appOnly = fixtures.filter((report) => report.source === "insight_studio");
assert.equal(appOnly.length, 3, "tab filter would hide Grok Bot reports");
assert.equal(groupReportsByStore(appOnly).find((group) => group.storeName === "マルゴ 四谷")?.reports.length, 1);
assert.equal(groupReportsByStore(fixtures).find((group) => group.storeName === "マルゴ 四谷")?.reports.length, 2);

const singles = fixtures.filter((report) => report.storeName === "マルゴ" || report.id === "app-yotsuya");
const htmlEmpty = renderToStaticMarkup(React.createElement(MergeDialog, {
  reports: singles,
  selectedIds: [],
  confirmMixedStores: false,
  onToggle() {},
  onSelectGroup() {},
  onConfirmMixedChange() {},
  onClose() {},
  onStart() {},
}));
assert.match(htmlEmpty, /role="dialog"/);
assert.match(htmlEmpty, /同じ店舗として自動でまとめられるレポートは見つかりませんでした/);
assert.match(htmlEmpty, /下の一覧から任意のレポートを2件以上選ぶと統合できます/);
assert.match(htmlEmpty, /マルゴ四谷/);
assert.doesNotMatch(htmlEmpty, /この店舗を選ぶ/);

const html = renderToStaticMarkup(React.createElement(MergeDialog, {
  reports: fixtures,
  selectedIds: ["app-yotsuya", "bot-yotsuya"],
  confirmMixedStores: false,
  onToggle() {},
  onSelectGroup() {},
  onConfirmMixedChange() {},
  onClose() {},
  onStart() {},
}));
assert.match(html, /id="merge-panel"/);
assert.match(html, /同じ店舗のレポートを統合/);
assert.match(html, /いま開いているタブに関係なく/);
assert.match(html, /マルゴ 四谷/);
assert.match(html, /ビストロ サヴァサヴァ/);
assert.match(html, /Bistro CAVACAVA/);
assert.match(html, /Grok Bot/);
assert.match(html, /アプリ分析/);
assert.match(html, /統合版/);
assert.match(html, /選んだ2件を統合する/);
assert.doesNotMatch(html, /同じ店舗として自動でまとめられるレポートは見つかりませんでした/);

const appSource = fs.readFileSync(path.join(process.cwd(), "src/App.tsx"), "utf8");
assert.match(appSource, /setMergeOpen\(true\)/);
assert.doesNotMatch(appSource, /getElementById\("merge-panel"\)/);
assert.doesNotMatch(appSource, /scrollIntoView/);
assert.match(appSource, /mergeOpen && <MergeDialog/);

console.log("Merge dialog visibility and grouping checks passed.");
