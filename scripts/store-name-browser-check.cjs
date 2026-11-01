// Optional offline browser regression. PLAYWRIGHT_MODULE may point to an installed Playwright.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const out=process.env.STORE_QA_DIR;
if(!out) throw new Error('Set STORE_QA_DIR to a dedicated scratch directory');
fs.mkdirSync(out,{recursive:true});
const result=require('esbuild').buildSync({stdin:{contents:`import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{StoreNameInput,STORE_CATALOG}from'./src/StoreNameInput';window.storeCatalog=STORE_CATALOG;
function Demo(){const[name,setName]=useState('マルゴ四谷');const[url,setUrl]=useState('https://example.test/unchanged');const[tabelog,setTabelog]=useState('https://example.test/old-tabelog');return <main style={{padding:20,maxWidth:600}}><p>表示確認用サンプル・API接続なし</p><form className="panel form-panel" onSubmit={e=>{e.preventDefault();window.submissions.push({storeName:name,storeUrl:e.currentTarget.elements.url.value,tabelogUrl:e.currentTarget.elements.tabelog.value,focus:e.currentTarget.elements.focus.value});}}><div className="panel-kicker">新しいリサーチ</div><h2>調べたいお店を指定</h2><p className="muted form-intro">専門分野の異なる3つのAIが調査し、根拠を確認してひとつの改善レポートにまとめます。</p><StoreNameInput value={name} onChange={setName} onSelectStore={store=>{setUrl(store.url);setTabelog(store.tabelogUrl)}}/><label>店舗の公式サイト・基準URL<input name="url" type="url" value={url} onChange={e=>setUrl(e.target.value)}/></label><label>食べログの店舗URL<input name="tabelog" value={tabelog} onChange={e=>setTabelog(e.target.value)}/></label><label>特に調べてほしいこと<input name="focus" defaultValue="入力中の調査条件"/></label><button type="submit">テスト送信（保存されません）</button></form></main>};window.submissions=[];createRoot(document.getElementById('root')).render(<Demo/>);`,resolveDir:root,loader:'tsx'},bundle:true,write:false,format:'iife',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'}});
const script=result.outputFiles[0].text;
const css=fs.readFileSync(path.join(root,'src/style.css'),'utf8').replace(/^@import[^\n]*\n/gm,'');
const html='<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>'+css+'</style><div id="root"></div><script src="/app.js"></script></html>';
(async()=>{
 const server=http.createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/app.js'?'text/javascript; charset=utf-8':'text/html; charset=utf-8');res.end(req.url==='/app.js'?script:html)});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 let browser;const errors=[];
 try{
 browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{channel:'chrome'})});
 const page=await browser.newPage({viewport:{width:1100,height:820}});
 page.on('pageerror',e=>errors.push(e.message));
 const origin=`http://127.0.0.1:${server.address().port}`;
 await page.route('**/*',route=>route.request().url().startsWith(origin)?route.continue():route.abort());
 await page.goto(origin);
 const input=page.getByRole('combobox'),toggle=page.getByRole('button',{name:'店舗一覧を開閉'});
 await input.waitFor();
 await page.screenshot({path:path.join(out,'store-desktop-closed.png')});
 await toggle.click();assert.equal(await page.getByRole('option').count(),23);
 assert.equal(await page.getByRole('listbox').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(255, 255, 255)');
 assert((await input.evaluate(el=>getComputedStyle(el).fontFamily)).includes('sans-serif'));
 await page.screenshot({path:path.join(out,'store-desktop-open.png')});
 await page.getByRole('option',{name:'マルゴ グランデ',exact:true}).click();
 assert.equal(await input.inputValue(),'マルゴ グランデ');
 assert.equal(await page.getByRole('listbox').count(),0);
 assert.equal(await page.locator('[name=url]').inputValue(),'https://marugo-s.com/g/');
 assert.equal(await page.locator('[name=tabelog]').inputValue(),'https://tabelog.com/tokyo/A1304/A130401/13085280/');
 await page.screenshot({path:path.join(out,'store-linked-desktop.png')});
 await page.locator('[name=url]').fill('https://example.test/manual');
 await page.locator('[name=tabelog]').fill('https://example.test/manual-tabelog');
 assert.equal(await page.locator('[name=focus]').inputValue(),'入力中の調査条件');
 assert.equal(await page.evaluate(()=>window.submissions.length),0);
 await input.fill('一覧外のテスト店');assert.equal(await page.getByRole('option').count(),0);
 await input.press('Enter');assert.equal(await input.inputValue(),'一覧外のテスト店');assert.equal(await page.evaluate(()=>window.submissions.length),0);
 await page.getByRole('button',{name:'テスト送信（保存されません）'}).click();
 assert.deepEqual(await page.evaluate(()=>window.submissions),[{storeName:'一覧外のテスト店',storeUrl:'https://example.test/manual',tabelogUrl:'https://example.test/manual-tabelog',focus:'入力中の調査条件'}]);
 await input.fill('グランデ');await input.press('ArrowDown');await input.press('Enter');assert.equal(await input.inputValue(),'マルゴ グランデ');
 assert.equal(await page.locator('[name=url]').inputValue(),'https://marugo-s.com/g/');
 assert.equal(await page.locator('[name=tabelog]').inputValue(),'https://tabelog.com/tokyo/A1304/A130401/13085280/');
 await toggle.click();assert.equal(await page.getByRole('option').count(),23);await input.press('Escape');assert.equal(await page.getByRole('listbox').count(),0);
 await input.fill('マルゴ四谷');assert.equal(await page.getByRole('option').count(),1);
 await input.dispatchEvent('keydown',{key:'Enter',code:'Enter',isComposing:true});assert.equal(await input.inputValue(),'マルゴ四谷');assert.equal(await page.getByRole('listbox').count(),1);
 await input.press('Tab');assert.equal(await page.getByRole('listbox').count(),0);
 for(const width of [390,768,1100]){
  await page.setViewportSize({width,height:820});await toggle.click();
  const bounds=await page.getByRole('listbox').boundingBox();assert(bounds.x>=0&&bounds.x+bounds.width<=width);
  await page.getByRole('option',{name:'マルゴ D',exact:true}).click();assert.equal(await input.inputValue(),'マルゴ D');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await toggle.click();await page.screenshot({path:path.join(out,`store-${width}-open.png`)});await input.press('Escape');
 }
 for(const store of await page.evaluate(()=>window.storeCatalog)){
  await toggle.click();await page.getByRole('option',{name:store.name,exact:true}).click();
  assert.equal(await input.inputValue(),store.name);
  assert.equal(await page.locator('[name=url]').inputValue(),store.url);
  assert.equal(await page.locator('[name=tabelog]').inputValue(),store.tabelogUrl);
 }
 await page.setViewportSize({width:390,height:820});
 await page.screenshot({path:path.join(out,'store-linked-phone.png')});
 await input.fill('');await input.press('Escape');await page.getByRole('button',{name:'テスト送信（保存されません）'}).click();assert.equal(await page.evaluate(()=>window.submissions.length),1);
 assert.deepEqual(errors,[]);
 fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed:true,stores:23,widths:[390,768,1100],checks:['pointer selection','free text serialization','other inputs retained','no selection submit','keyboard','IME','escape/tab','empty required','horizontal bounds','last option reachable'],browserErrors:errors},null,2));
 console.log('PASS: offline browser selection, arbitrary input, serialization, IME, keyboard, required, responsive 390/768/1100; no API I/O');
 }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1});
