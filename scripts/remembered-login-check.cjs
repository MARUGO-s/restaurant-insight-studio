const fs = require("fs");
const path = require("path");
const assert = require("assert/strict");
const root = path.resolve(__dirname, "..");
const req = require("module").createRequire(root + "/package.json");
const ts = req("typescript");
const React = req("react");
const { renderToStaticMarkup } = req("react-dom/server");
const Module = require("module");

function loadTs(relative, extra = "") {
  const filePath = path.join(root, "src", relative);
  const loaded = new Module(filePath);
  loaded.filename = filePath;
  loaded.paths = Module._nodeModulePaths(path.dirname(filePath));
  loaded.require = (name) => require(name);
  const source = fs.readFileSync(filePath, "utf8") + extra;
  loaded._compile(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filePath);
  return loaded.exports;
}

const {
  REMEMBERED_LOGIN_KEY, obfuscateRememberedLogin, revealRememberedLogin,
  loadRememberedLogin, saveRememberedLogin, clearRememberedLogin, rememberedLoginMatches,
} = loadTs("lib/remembered-login.ts");

function memoryStore(initial = {}) {
  const data = { ...initial };
  return {
    getItem: (key) => Object.hasOwn(data, key) ? data[key] : null,
    setItem: (key, value) => { data[key] = String(value); },
    removeItem: (key) => { delete data[key]; },
    data,
  };
}

const secret = "test-passphrase-example";
const stored = obfuscateRememberedLogin({ loginId: "marugo.waltz@gmail.com", password: secret });
assert.doesNotMatch(stored, /test-passphrase-example/);
assert.doesNotMatch(stored, /marugo\.waltz@gmail\.com/);
assert.deepEqual(revealRememberedLogin(stored), { loginId: "marugo.waltz@gmail.com", password: secret });
assert.equal(revealRememberedLogin("%%%not-valid%%%"), null);

const storage = memoryStore();
assert.equal(loadRememberedLogin(storage), null);
saveRememberedLogin("  demo-id  ", secret, storage);
assert.ok(storage.data[REMEMBERED_LOGIN_KEY]);
assert.doesNotMatch(storage.data[REMEMBERED_LOGIN_KEY], /test-passphrase-example/);
assert.deepEqual(loadRememberedLogin(storage), { loginId: "demo-id", password: secret });
assert.equal(rememberedLoginMatches("demo-id", secret, storage), true);
assert.equal(rememberedLoginMatches("demo-id", "other", storage), false);
clearRememberedLogin(storage);
assert.equal(loadRememberedLogin(storage), null);
assert.equal(rememberedLoginMatches("demo-id", secret, storage), false);
saveRememberedLogin("", secret, storage);
assert.equal(loadRememberedLogin(storage), null);

const { LoginForm } = loadTs("LoginForm.tsx");
const render = (props) => renderToStaticMarkup(React.createElement(LoginForm, {
  loginId: "", password: "", rememberLogin: false, hasRememberedLogin: false, signingIn: false, error: "",
  onLoginIdChange() {}, onPasswordChange() {}, onRememberChange() {}, onClearRemembered() {}, onSubmit(event) { event.preventDefault(); },
  ...props,
}));
const html = render({ loginId: "demo-id", rememberLogin: true });
assert.match(html, /<form id="login-form"/);
assert.match(html, /method="post"/);
assert.match(html, /autoComplete="on"/);
assert.match(html, /id="login-id"/);
assert.match(html, /name="username"/);
assert.match(html, /autoComplete="username"/);
assert.match(html, /id="login-password"/);
assert.match(html, /name="password"/);
assert.match(html, /autoComplete="current-password"/);
assert.match(html, /name="remember-login"/);
assert.match(html, /IDとパスワードをこの端末に記録する/);
assert.match(html, /記録をオンにすると、この端末のブラウザに保存されます。共用の端末ではオフにしてください。/);
assert.doesNotMatch(html, /このアプリには保存されません/);
assert.doesNotMatch(html, /記録を削除/);
const savedHtml = render({ hasRememberedLogin: true, rememberLogin: true, loginId: "demo-id" });
assert.match(savedHtml, />記録を削除</);
assert.match(savedHtml, /type="button"/);

console.log("Remembered login storage and form markup checks passed.");
