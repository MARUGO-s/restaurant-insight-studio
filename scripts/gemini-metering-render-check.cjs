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
  "./ReportTrash": {},
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
  const compilerOptions = { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 };
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
  ["seven_distinct", ["Google検索 7件", "$0.137720"]],
  ["seven_with_blank_and_duplicates", ["Google検索 3件", "$0.081720"]],
  ["three_distinct", ["Google検索 3件", "$0.081720"]],
  ["all_blank", ["Google検索 0件", "$0.039720"]],
  ["missing_search_metadata", [undefined, "料金未確定"]],
]);

globalThis.fetch = noNetwork;
// Expose the real cost page to the test without changing the production module.
const { CostPage } = loadComponent("App.tsx", "\nexport { CostPage };\n");
for (const { label, row } of scenarios) {
  assert.ok(expected.has(label), `Unexpected or repeated case ${label}`);
  const html = renderToStaticMarkup(React.createElement(CostPage, {
    reports: [], costs: [row], loading: false, error: "", onRefresh: noNetwork,
  }));
  const ledger = html.split('class="cost-event-list"')[1];
  assert.ok(ledger, "API call ledger is missing");
  assert.equal((ledger.match(/class="cost-event"/g) ?? []).length, 1);
  assert.match(ledger, /グルメ媒体調査/);
  const searchCount = ledger.match(/Google検索 \d+件/)?.[0];
  const price = ledger.match(/<div class="cost-event-price"><b>([^<]+)<\/b>/)?.[1];
  assert.deepEqual([searchCount, price], expected.get(label), label);
  expected.delete(label);
}
assert.equal(expected.size, 0, `Missing cases ${[...expected.keys()].join(", ")}`);
console.log("Gemini search counts and totals match the API call ledger display");
