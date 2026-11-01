// Actual App regression with synthetic auth/API modules. No business network I/O.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const out = process.env.STORE_QA_DIR;
if (!out) throw new Error('Set STORE_QA_DIR to a dedicated scratch directory');
fs.mkdirSync(out, { recursive: true });

(async () => {
  const build = await require('esbuild').build({
    stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
      import App from './src/App'; import {STORE_CATALOG} from './src/StoreNameInput';
      window.catalog=STORE_CATALOG; window.actions=[];
      createRoot(document.getElementById('root')).render(<App/>);`, resolveDir: root, loader: 'tsx' },
    bundle: true, write: false, format: 'iife', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [{ name: 'no-business-io', setup(b) {
      b.onLoad({ filter: /[/\\]src[/\\]lib[/\\]supabase\.ts$/ }, () => ({ contents: `
        const session={user:{id:'synthetic-store-qa',email:'synthetic@example.test'}};
        export const supabase={auth:{getSession:async()=>({data:{session}}),
          onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})}};
        export const displayLoginId=value=>value;
        export const loginEmailFromId=value=>value;`, loader: 'js' }));
      b.onLoad({ filter: /[/\\]src[/\\]lib[/\\]api\.ts$/ }, () => ({ contents: `
        export async function invoke(payload){
          window.actions.push(payload);
          const responses={list:{reports:[]},costs:{costs:[]},health:{configured:{openai:true,gemini:true,xai:true}},
            active_run:{run:null},list_trash:{reports:[],total:0,nextCursor:null}};
          if(responses[payload.action])return responses[payload.action];
          throw new Error('合成試験: APIへ送信せず内容を記録しました');
        }`, loader: 'js' }));
    } }],
  });
  const script = build.outputFiles[0].text;
  const css = fs.readFileSync(path.join(root, 'src/style.css'), 'utf8').replace(/^@import[^\n]*\n/gm, '');
  const html = '<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>' + css + '</style><div id="root"></div><script src="/app.js"></script></html>';
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', req.url === '/app.js' ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8');
    res.end(req.url === '/app.js' ? script : html);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }) });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [], blocked = [];
    page.on('pageerror', e => errors.push(e.message));
    const origin = `http://127.0.0.1:${server.address().port}`;
    await page.route('**/*', route => {
      if (new URL(route.request().url()).origin === origin) return route.continue();
      blocked.push(route.request().url());
      return route.abort();
    });
    await page.goto(origin);
    const combo = page.getByRole('combobox', { name: '店舗名' });
    const toggle = page.getByRole('button', { name: '店舗一覧を開閉' });
    const official = page.getByLabel('店舗の公式サイト・基準URL');
    const tabelog = page.getByLabel('食べログの店舗URL', { exact: true });
    const maps = page.getByLabel('Google マップの店舗URL', { exact: true });
    await combo.waitFor();
    await page.locator('.site-picker-summary').click();
    const mapCheck = page.locator('.site-check').filter({ hasText: 'Google マップ' });
    const tabelogCheck = page.locator('.site-check').filter({ hasText: '食べログ' });
    assert.equal(await mapCheck.locator('input').isChecked(), false, 'do not change default media selection');
    await mapCheck.click();
    const catalog = await page.evaluate(() => window.catalog);
    assert.equal(catalog.length, 23);
    const initial = catalog.find(x => x.name === 'マルゴ 四谷');
    assert.ok(initial.googleMapsUrl, 'initial store has a verified Google Maps URL');
    assert.equal(await maps.inputValue(), initial.googleMapsUrl);
    assert.equal(await official.inputValue(), initial.url);
    assert.equal(await tabelog.inputValue(), initial.tabelogUrl);
    const group = page.getByLabel('グループ名', { exact: false });
    const focus = page.locator('#research-focus');
    await group.fill('保持確認グループ');
    await focus.fill('保持確認の重点調査');
    await page.locator('.site-check').filter({ hasText: 'ホットペッパーグルメ' }).click();
    const hotpepper = page.getByLabel('ホットペッパーグルメの店舗URL', { exact: true });
    await hotpepper.fill('https://example.test/other-medium');
    await page.getByRole('button', { name: '＋ その他のグルメサイトを追加' }).click();
    await page.getByLabel('サイト名', { exact: true }).fill('独自媒体');
    const other = page.getByPlaceholder('店舗ページURL', { exact: true });
    await other.fill('https://example.test/custom');
    const select = async name => {
      await toggle.click();
      await page.getByRole('option', { name, exact: true }).click();
    };
    for (const store of catalog) {
      await select(store.name);
      assert.equal(await combo.inputValue(), store.name);
      assert.equal(await official.inputValue(), store.url);
      assert.equal(await tabelog.inputValue(), store.tabelogUrl);
      assert.equal(await maps.inputValue(), store.googleMapsUrl);
    }
    assert.equal(await group.inputValue(), '保持確認グループ');
    assert.equal(await focus.inputValue(), '保持確認の重点調査');
    assert.equal(await hotpepper.inputValue(), 'https://example.test/other-medium');
    assert.equal(await other.inputValue(), 'https://example.test/custom');
    assert.equal(await page.evaluate(() => window.actions.filter(x => x.action === 'analyze').length), 0);
    await mapCheck.click();
    await tabelogCheck.click();
    await select('マルゴ グランデ');
    assert.equal(await mapCheck.locator('input').isChecked(), false);
    assert.equal(await tabelogCheck.locator('input').isChecked(), false);
    assert.equal(await maps.count(), 0);
    await page.locator('form .primary-button').click();
    await page.waitForFunction(() => window.actions.some(x => x.action === 'analyze'));
    const offPayload = await page.evaluate(() => window.actions.find(x => x.action === 'analyze'));
    assert.ok(!offPayload.selectedSites.some(x => ['google_maps', 'tabelog'].includes(x.id)));
    await mapCheck.click();
    await tabelogCheck.click();
    const grande = catalog.find(x => x.name === 'マルゴ グランデ');
    assert.equal(await maps.inputValue(), grande.googleMapsUrl);
    await official.fill('https://example.test/manual');
    await tabelog.fill('https://example.test/manual-tabelog');
    await maps.fill('https://www.google.com/maps?cid=123456');
    // Typing even an exact catalog name is not an explicit selection.
    await combo.fill('マルゴ 四谷');
    await combo.press('Escape');
    assert.equal(await maps.inputValue(), 'https://www.google.com/maps?cid=123456');
    await combo.fill('一覧外 合成試験店舗');
    await combo.press('Escape');
    await page.locator('form .primary-button').click();
    await page.waitForFunction(() => window.actions.filter(x => x.action === 'analyze').length === 2);
    const payload = await page.evaluate(() => window.actions.filter(x => x.action === 'analyze')[1]);
    assert.equal(payload.storeName, '一覧外 合成試験店舗');
    assert.equal(payload.storeUrl, 'https://example.test/manual');
    assert.equal(payload.groupName, '保持確認グループ');
    assert.equal(payload.researchFocus, '保持確認の重点調査');
    assert.equal(payload.selectedSites.find(x => x.id === 'google_maps').url, 'https://www.google.com/maps?cid=123456');
    assert.equal(payload.selectedSites.find(x => x.id === 'tabelog').url, 'https://example.test/manual-tabelog');
    assert.equal(await combo.inputValue(), '一覧外 合成試験店舗');
    assert.equal(await maps.inputValue(), 'https://www.google.com/maps?cid=123456');
    await combo.fill('四谷');
    await combo.press('ArrowDown');
    await combo.press('Enter');
    assert.equal(await maps.inputValue(), initial.googleMapsUrl);
    assert.equal(await page.evaluate(() => window.actions.filter(x => x.action === 'analyze').length), 2);
    for (const width of [390, 768, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path: path.join(out, `actual-app-${width}.png`), fullPage: true });
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(blocked, []);
    const result = { passed: true, stores: catalog.length, checks: ['actual App initial URLs', '23 store URL triples', 'Maps and Tabelog OFF retained and excluded from payload', 'other inputs retained', 'free input and exact-name typing retain manual URLs', 'mock submission', 'draft retained on error', 'keyboard selection', 'no accidental analysis', '390/768/1440px bounds'], realBusinessRequests: 0 };
    fs.writeFileSync(path.join(out, 'actual-app-result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
