// Actual App + handlers; only auth/API boundaries mocked. All external requests blocked.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const out = process.env.SYNTHESIS_QA_DIR;
if (!out) throw new Error('Set SYNTHESIS_QA_DIR to a dedicated scratch directory');
fs.mkdirSync(out, { recursive: true });
(async () => {
  const build = await require('esbuild').build({
    stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import App from './src/App'; createRoot(document.getElementById('root')).render(<App/>);`, resolveDir: root, loader: 'tsx' },
    bundle: true, write: false, format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [{ name: 'offline-boundaries', setup(b) {
      b.onLoad({ filter: /[/\\]src[/\\]lib[/\\]supabase\.ts$/ }, () => ({ contents: `
        let session={user:{id:'user-a',email:'a@example.test'}};
        let listener;
        window.changeUser=id=>{session=id?{user:{id,email:id+'@example.test'}}:null;listener('SIGNED_IN',session)};
        export const supabase={auth:{getSession:async()=>({data:{session}}),onAuthStateChange:fn=>{listener=fn;return {data:{subscription:{unsubscribe(){}}}}},signOut:async()=>window.changeUser(null)}};
        export const displayLoginId=v=>v; export const loginEmailFromId=v=>v;`, loader: 'js' }));
      b.onLoad({ filter: /[/\\]src[/\\]lib[/\\]api\.ts$/ }, () => ({ contents: `
        window.actions=[];
        window.run={runId:'run-1',startedAt:'2026-01-01T00:00:00Z',storeName:'合成テスト店舗'};
        window.state={status:'failed',progressStage:'checking',canRegenerateSynthesis:true,synthesisRevision:'response-1',error:'品質検証で停止',jobs:['market','gourmet','social_recent','social_history','synthesis'].map(key=>({key,label:key,status:key==='synthesis'?'failed':'done',attempts:1,maxAttempts:3}))};
        window.paidMode='reject'; window.holdStatus=false;
        export async function invoke(payload){
          window.actions.push(payload);
          const responses={list:{reports:[]},costs:{costs:[]},health:{configured:{openai:true,gemini:true,xai:true}},active_run:{run:window.run},list_trash:{reports:[],total:0,nextCursor:null}};
          if(responses[payload.action])return responses[payload.action];
          if(payload.action==='run_status'){if(window.holdStatus)return new Promise(resolve=>window.resolveStatus=()=>resolve(structuredClone(window.state)));return structuredClone(window.state)}
          if(payload.action==='regenerate_synthesis'){
            if(window.paidMode==='hold')return new Promise((resolve,reject)=>{window.resolvePaid=resolve;window.rejectPaid=()=>reject(new Error('合成試験: 応答不明'))});
            if(window.paidMode==='success')return {runId:payload.runId,status:'running'};
            throw new Error('合成試験: 応答不明');
          }
          if(payload.action==='retry_run')return {runId:payload.runId,status:'running'};
          throw new Error('Unexpected API action: '+payload.action);
        }`, loader: 'js' }));
    } }],
  });
  const css = fs.readFileSync(path.join(root, 'src/style.css'), 'utf8').replace(/^@import[^\n]*\n/gm, '');
  const html = '<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>'+css+'</style><div id="root"></div><script src="/app.js"></script></html>';
  const server = http.createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/app.js'?'text/javascript; charset=utf-8':'text/html; charset=utf-8');res.end(req.url==='/app.js'?build.outputFiles[0].text:html)});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let browser;
  try {
    browser = await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{channel:'chrome'})});
    const page = await browser.newPage({viewport:{width:1440,height:1000}});
    const errors=[],blocked=[];
    page.on('pageerror',e=>errors.push(e.message));
    const origin=`http://127.0.0.1:${server.address().port}`;
    await page.route('**/*',route=>{if(new URL(route.request().url()).origin===origin)return route.continue();blocked.push(route.request().url());return route.abort()});
    await page.goto(origin);
    const paid=page.getByRole('button',{name:'統合だけ作り直す（追加API料金）',exact:true});
    const check=page.getByRole('button',{name:'進行状況を再確認',exact:true});
    await check.waitFor();
    assert.equal(await paid.count(),1,'eligible failed synthesis exposes explicit paid operation');
    assert.equal(await page.getByRole('button',{name:'保存済み応答を再確認（追加生成なし）',exact:true}).count(),1);
    const consent=[];
    page.on('dialog',async dialog=>{consent.push(dialog.message());await dialog.dismiss()});
    await paid.click();
    assert.equal(consent.length,1,'explicit confirmation required');
    for(const phrase of ['4つ','保持','1回','追加API料金','未確定','自動'])assert(consent[0].includes(phrase),phrase);
    assert.equal(await page.evaluate(()=>window.actions.filter(x=>x.action==='regenerate_synthesis').length),0,'cancel performs no paid operation');
    page.removeAllListeners('dialog');
    page.on('dialog',async dialog=>{consent.push(dialog.message());await dialog.accept()});
    const group=page.getByLabel('グループ名',{exact:false});
    await group.fill('未送信の入力を保持');
    await page.evaluate(()=>window.paidMode='hold');
    // Invoke the actual React click handler twice before a render can disable it.
    await page.getByRole('button',{name:'保存済み応答を再確認（追加生成なし）',exact:true}).evaluate(button=>{
      window.savedRetry=button[Object.keys(button).find(key=>key.startsWith('__reactProps$'))].onClick;
    });
    for(const [name,key] of [['進行状況を再確認','savedCheck'],['この解析を閉じて新しく分析','savedClose']]) {
      await page.getByRole('button',{name,exact:true}).evaluate((button,key)=>{
        window[key]=button[Object.keys(button).find(k=>k.startsWith('__reactProps$'))].onClick;
      },key);
    }
    const readsBefore=await page.evaluate(()=>window.actions.filter(x=>x.action==='run_status').length);
    await paid.evaluate(button=>{
      const props=button[Object.keys(button).find(key=>key.startsWith('__reactProps$'))];
      props.onClick();props.onClick();window.savedRetry();window.savedCheck();window.savedClose();
    });
    assert.equal(await page.evaluate(()=>window.actions.filter(x=>x.action==='run_status').length),readsBefore,'queued check cannot overlap mutation');
    assert.equal(await page.getByRole('region',{name:'解析の進行状況'}).count(),1,'queued close cannot discard in-flight operation');
    assert.equal(await page.evaluate(()=>window.actions.filter(x=>x.action==='retry_run').length),0,'queued normal retry cannot overlap paid mutation');
    const writes=()=>page.evaluate(()=>window.actions.filter(x=>x.action==='regenerate_synthesis'));
    assert.equal((await writes()).length,1,'synchronous handler lock prevents duplicate paid submissions');
    const first=(await writes())[0];
    assert.deepEqual(Object.keys(first).sort(),['action','confirmAdditionalCost','expectedRevision','requestId','runId'].sort());
    assert.equal(first.runId,'run-1');assert.equal(first.expectedRevision,'response-1');assert.equal(first.confirmAdditionalCost,true);
    assert.match(first.requestId,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.equal(await paid.count(),0,'hidden while request pending');
    await page.evaluate(()=>window.rejectPaid());
    await page.getByRole('status').filter({hasText:'結果を確認できません'}).waitFor();
    assert.equal(await paid.count(),0,'unknown outcome permits only status recheck');
    assert.equal(await group.inputValue(),'未送信の入力を保持');
    await check.click();await paid.waitFor();
    await page.evaluate(()=>window.paidMode='reject');
    await paid.click();
    assert.deepEqual((await writes())[1],first,'same saved revision reuses full request after ambiguous error');
    await page.reload();await paid.waitFor();
    await paid.click();
    assert.deepEqual((await writes())[0],first,'reload retains operation identity');
    await page.evaluate(()=>window.state.synthesisRevision='response-2');
    await check.click();await paid.waitFor();await paid.click();
    const next=(await writes())[1];
    assert.equal(next.expectedRevision,'response-2');assert.notEqual(next.requestId,first.requestId,'new completed response permits a new consented operation');
    await page.evaluate(()=>window.changeUser('user-b'));await paid.waitFor();await paid.click();
    const other=(await writes())[2];assert.notEqual(other.requestId,next.requestId,'request identity isolated by account');
    await page.evaluate(()=>window.changeUser('user-a'));await paid.waitFor();await paid.click();
    assert.deepEqual((await writes())[3],next,'returning account retains its own identity');
    const beforeChecks=(await writes()).length;
    for(const [canRegenerateSynthesis,synthesisRevision] of [[false,'response-2'],[undefined,'response-2'],[true,'']]) {
      await page.evaluate(({canRegenerateSynthesis,synthesisRevision})=>Object.assign(window.state,{canRegenerateSynthesis,synthesisRevision}),{canRegenerateSynthesis,synthesisRevision});
      await check.click();await check.waitFor();
      assert.equal(await paid.count(),0,'capability and completed revision required');
    }
    await page.evaluate(()=>Object.assign(window.state,{canRegenerateSynthesis:true,synthesisRevision:'response-2'}));
    await check.click();await paid.waitFor();
    await page.getByRole('button',{name:'保存済み応答を再確認（追加生成なし）',exact:true}).click();
    await paid.waitFor();
    assert.equal((await writes()).length,beforeChecks,'ordinary retry never sends paid action');
    assert.deepEqual(await page.evaluate(()=>window.actions.filter(x=>x.action==='retry_run').at(-1)),{action:'retry_run',runId:'run-1'});
    await page.evaluate(()=>{window.paidMode='success';window.holdStatus=true});
    await paid.click();await page.waitForFunction(()=>!!window.resolveStatus);
    assert.equal(await paid.count(),0,'paid retry hidden while polling');
    const accepted=(await writes()).length;
    await page.evaluate(()=>{window.holdStatus=false;window.resolveStatus()});await paid.waitFor();
    assert.equal((await writes()).length,accepted,'failed readback never auto-regenerates');
    // An old account's delayed mutation completion must not overwrite the new account.
    await page.evaluate(()=>window.paidMode='hold');await paid.click();
    await page.evaluate(()=>{window.oldResolvePaid=window.resolvePaid;window.changeUser('user-c')});await paid.waitFor();
    await group.fill('別アカウントの入力');
    const readsBeforeOldReply=await page.evaluate(()=>window.actions.filter(x=>x.action==='run_status').length);
    await page.evaluate(()=>window.oldResolvePaid({runId:'run-1',status:'running'}));
    assert.equal(await group.inputValue(),'別アカウントの入力');
    assert.equal(await page.evaluate(()=>window.actions.filter(x=>x.action==='run_status').length),readsBeforeOldReply);
    assert.equal(await paid.count(),1);
    // Durable receipt storage is mandatory: do not pay if it cannot be persisted.
    await page.evaluate(()=>{window.originalSet=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key.startsWith('restaurantInsightSynthesisRequest:'))throw new Error('Synthetic storage disabled');return window.originalSet.call(this,key,value)}});
    const beforeStorage=(await writes()).length;
    await paid.click();await page.getByRole('status').filter({hasText:'結果を確認できません'}).waitFor();
    assert.equal((await writes()).length,beforeStorage);
    await page.evaluate(()=>Storage.prototype.setItem=window.originalSet);
    await check.click();await paid.waitFor();
    for(const width of [390,768,1440]){
      await page.setViewportSize({width,height:1000});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      await page.screenshot({path:path.join(out,`synthesis-consent-${width}.png`),fullPage:true});
    }
    assert.equal(await page.evaluate(()=>window.actions.some(x=>x.action==='analyze')),false,'no new full research');
    assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);
    const result={passed:true,checks:['actual App consent/cancel','synchronous duplicate and overlapping action guards','unknown response and reload UUID reuse','completed revision rotation','account isolation and stale reply','draft preservation','capability/revision gating','ordinary retry payload unchanged','post-write status polling without auto-regeneration','storage failure closed','390/768/1440px bounds'],realBusinessRequests:0};
    fs.writeFileSync(path.join(out,'synthesis-ui-result.json'),JSON.stringify(result,null,2));
    console.log(JSON.stringify(result));
  } finally {if(browser)await browser.close();await new Promise(resolve=>server.close(resolve))}
})().catch(e=>{console.error(e);process.exitCode=1});
