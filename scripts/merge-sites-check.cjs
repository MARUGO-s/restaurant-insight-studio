const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");

function loadTs(relative) {
  const filePath = path.join(process.cwd(), relative);
  const loaded = new Module(filePath);
  loaded.filename = filePath;
  loaded.paths = Module._nodeModulePaths(path.dirname(filePath));
  const { outputText } = ts.transpileModule(fs.readFileSync(filePath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: filePath,
  });
  loaded._compile(outputText, filePath);
  return loaded.exports;
}

const { normalizeMergeSites } = loadTs("supabase/functions/restaurant-analysis/merge-sites.ts");

const yotsuyaChecker = [
  { id: "tabelog", url: "https://tabelog.com/tokyo/A1309/A130902/13245349/", name: "食べログ" },
  { id: "hotpepper", url: "https://www.hotpepper.jp/strJ001259020/", name: "ホットペッパーグルメ" },
  { id: "gnavi", url: "https://r.gnavi.co.jp/eh4g63rv0000/", name: "楽天ぐるなび" },
  { id: "hitosara", url: "https://hitosara.com/0031483311/", name: "ヒトサラ" },
  { id: "retty", url: "https://retty.me/area/PRE13/ARE6/SUB603/100001555284/", name: "Retty" },
  { id: "instagram", url: "https://www.instagram.com/marugoyotsuya/", name: "Instagram" },
  { id: "official", url: "https://marugo-s.com/yotsuya/", name: "公式サイト" },
];
const yotsuyaApp = [
  { id: "tabelog", url: "https://tabelog.com/tokyo/A1309/A130902/13245349/", name: "食べログ" },
  { id: "google_maps", url: "https://share.google/kundHRIlGxFbrEjZX", name: "Google マップ" },
];

const merged = normalizeMergeSites([...yotsuyaChecker, ...yotsuyaApp], "https://marugo-s.com/yotsuya/");
const ids = merged.map((site) => site.id);
assert.ok(!ids.includes("gnavi"), "gnavi should be aliased");
assert.ok(ids.includes("gurunavi"));
assert.equal(merged.find((site) => site.id === "gurunavi")?.name, "ぐるなび");
assert.ok(ids.includes("custom-instagram"));
assert.ok(!ids.includes("official"));
assert.ok(ids.includes("tabelog"));
assert.ok(ids.includes("google_maps"));
assert.ok(ids.includes("hotpepper"));
assert.doesNotThrow(() => normalizeMergeSites(yotsuyaChecker, "https://marugo-s.com/yotsuya/"));
assert.deepEqual(normalizeMergeSites([], "https://marugo-s.com/yotsuya/"), [{ id: "official", name: "公式サイト", url: "https://marugo-s.com/yotsuya/" }]);
assert.deepEqual(normalizeMergeSites([{ id: "mystery" }], ""), []);

const appSource = fs.readFileSync(path.join(process.cwd(), "src/App.tsx"), "utf8");
assert.match(appSource, /normalizeMergeSites\(chosen\.flatMap/);
assert.match(appSource, /<b>\{errorTitle\}<\/b>/);
assert.match(appSource, /setErrorTitle\("レポートの統合を開始できませんでした"\)/);

const coreSource = fs.readFileSync(path.join(process.cwd(), "supabase/functions/restaurant-analysis/core.ts"), "utf8");
assert.match(coreSource, /normalizeMergeSites\(input\.selectedSites/);
assert.doesNotMatch(coreSource, /const selectedSites = normalizeSites\(input\.selectedSites\?\.length \? input\.selectedSites : reports/);

console.log("Merge site normalization checks passed.");
