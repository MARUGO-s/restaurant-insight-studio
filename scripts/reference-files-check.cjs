const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

function loadTs(relative, from = process.cwd()) {
  const filePath = path.isAbsolute(relative) ? relative : path.join(from, relative);
  const loaded = new Module(filePath);
  loaded.filename = filePath;
  loaded.paths = Module._nodeModulePaths(path.dirname(filePath));
  const { outputText } = ts.transpileModule(fs.readFileSync(filePath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: filePath,
  });
  loaded.require = (name) => {
    if (name === "./lib/supabase") {
      return { supabase: { from() { return { select() { return this; }, order() { return Promise.resolve({ data: [], error: null }); }, insert() { return Promise.resolve({ error: null }); }, update() { return this; }, eq() { return Promise.resolve({ error: null }); } }; } } };
    }
    if (name === "./lib/reference-files") return loadTs("src/lib/reference-files.ts");
    return Module._load(name, loaded, false);
  };
  loaded._compile(outputText, filePath);
  return loaded.exports;
}

const { fileAppliesToSites, selectReferenceFiles, formatReferencePrompt, REFERENCE_PROMPT_CHAR_LIMIT } = loadTs("supabase/functions/restaurant-analysis/reference-files.ts");
const { extractReferenceText, categoryLabel } = loadTs("src/lib/reference-files.ts");

assert.equal(fileAppliesToSites(["all"], ["tabelog"]), true);
assert.equal(fileAppliesToSites(["tabelog"], ["tabelog", "hotpepper"]), true);
assert.equal(fileAppliesToSites(["tabelog"], ["google_maps"]), false);
assert.equal(fileAppliesToSites(["gurunavi"], ["gnavi"]), true);
assert.equal(fileAppliesToSites([], ["tabelog"]), true);

const long = "NG:" + "あ".repeat(300);
const selected = selectReferenceFiles([
  { id: "1", title: "特長ワード案内", category: "ng_words", target_sites: ["tabelog"], content: "ワインは特長ワードとして指摘された。" },
  { id: "2", title: "別媒体だけ", category: "other", target_sites: ["ikyu"], content: "一休の話" },
  { id: "3", title: "長い資料", category: "site_improvement", target_sites: ["all"], content: long.repeat(200) },
], ["tabelog"], 400);
assert.equal(selected.used.length, 2);
assert.equal(selected.used[0].title, "特長ワード案内");
assert.equal(selected.used[1].truncated, true);
assert.ok(selected.omitted >= 0);
const prompt = formatReferencePrompt(selected);
assert.match(prompt, /【アプリ内の参照ファイル】/);
assert.match(prompt, /特長ワード案内/);
assert.match(prompt, /ワインは特長ワードとして指摘された/);
assert.doesNotMatch(prompt, /一休の話/);
assert.match(prompt, /文字数上限のため、ここで省略しました/);
assert.ok(prompt.length <= 400 + 800);
assert.equal(typeof REFERENCE_PROMPT_CHAR_LIMIT, "number");

const { ReferenceFilesPage } = loadTs("src/ReferenceFilesPage.tsx");
const html = renderToStaticMarkup(React.createElement(ReferenceFilesPage, { userId: "00000000-0000-0000-0000-000000000000" }));
assert.match(html, /参照ファイル/);
assert.match(html, /ファイルを追加/);
assert.match(html, /NGワード/);

assert.equal(categoryLabel("ng_words"), "NGワード");

const File = global.File;
if (typeof File === "function") {
  const ok = new File(["hello\nworld"], "guide.md", { type: "text/markdown" });
  extractReferenceText(ok).then((text) => {
    assert.equal(text.includes("hello"), true);
  });
}

const app = fs.readFileSync(path.join(process.cwd(), "src/App.tsx"), "utf8");
assert.match(app, /ReferenceFilesPage/);
assert.match(app, /page === "references"/);
const core = fs.readFileSync(path.join(process.cwd(), "supabase/functions/restaurant-analysis/core.ts"), "utf8");
assert.match(core, /loadReferenceFilesForRun/);
assert.match(core, /referenceFilesUsed/);
assert.match(core, /input\.referencePrompt/);

const seed = "/home/box/agent-data/reference/gourmet_listing_check_guide_2026-11-21.md";
if (fs.existsSync(seed)) {
  const guide = fs.readFileSync(seed, "utf8");
  const withGuide = selectReferenceFiles([{ id: "seed", title: "食べログ「特長ワード」調査レポート", category: "ng_words", target_sites: ["all"], content: guide }], ["tabelog"]);
  const built = formatReferencePrompt(withGuide);
  assert.match(built, /特長ワード/);
  assert.match(built, /マルゴ 丸の内/);
  assert.ok(built.length < REFERENCE_PROMPT_CHAR_LIMIT + 2000, "seed should fit in the prompt cap");
}

console.log("Reference files selection, prompt, and page checks passed.");
