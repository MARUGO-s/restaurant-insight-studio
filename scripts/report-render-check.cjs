const fs = require('fs');
const path = require('path');
const root=path.resolve(__dirname,'..');
const req=require('module').createRequire(root+'/package.json');
const ts=req('typescript');
const React=req('react');
const { renderToStaticMarkup }=req('react-dom/server');
const source=fs.readFileSync(root+'/src/ReportView.tsx','utf8');
const moduleObject=new (require('module').Module)(root+'/src/ReportView.check.cjs');
moduleObject.filename=root+'/src/ReportView.check.cjs';
moduleObject.paths=require('module').Module._nodeModulePaths(root);
moduleObject._compile(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText,moduleObject.filename);
const {IntegratedReport,TextPanel,SourceLinks,LinkedText}=moduleObject.exports;
const assert=require('assert/strict');
const render=(component,props)=>renderToStaticMarkup(React.createElement(component,props));
// Synthetic defaults make this check reproducible without user data or API calls.
const titles=['調査範囲','現状と強み','掲載監査','コース・メニュー','PR文・写真','口コミ・X','競合比較','反証と確認','実行手順','30日間の計画と観測する指標'];
const fixture={overallAssessment:'表示検証用の総合評価',keyMessage:'根拠と改善手順を確認します。',keyFindings:[{title:'表示差を確認する',severity:'medium',issue:'案内の意味が異なる',evidence:'公開情報の表示例',action:'現場に確認する',sources:['https://example.com/a']}],strengths:['具体的な利用場面'],limitations:['非公開データは未提供'],detailedReport:'詳細の導入',actionPlan:Array.from({length:5},(_,i)=>({priority:i===0?'P0':'P1',action:`検証用の施策${i+1}`,reason:'表示された根拠',timing:'確認後',effort:'小'})),detailSections:titles.map((title,i)=>({title:`${i+1}. ${title}`,body:`内容を省略しない確認用の本文${i+1}。\n\n追加の根拠と反例。`,columns:['項目','内容'],rows:[['確認事項','確認した内容']],sources:['https://example.com/a']}))};
const baselinePath=process.argv.find((arg,index)=>index>1&&!arg.startsWith('--')&&process.argv[index-1]!=='--html-dir');
const baseline=baselinePath?JSON.parse(fs.readFileSync(baselinePath,'utf8')):{report:JSON.stringify(fixture)};
const report=JSON.parse(baseline.report);
const actual=render(IntegratedReport,{text:baseline.report});
assert.equal((actual.match(/class="report-document-section"/g)||[]).length,report.detailSections.length+(report.detailedReport?1:0));
for(const section of report.detailSections) assert(actual.includes(section.title.replace(/^\d{1,2}[.．、]\s*/,'')));
assert.equal((actual.match(/class="finding-card /g)||[]).length,report.keyFindings.length);
assert.equal((actual.match(/class="action-detail"/g)||[]).length,report.actionPlan.length);
if(report.actionPlan.length >= 3) assert(actual.includes('まず取り組む3項目'));
assert.equal(actual.includes('すべての施策と実行手順を見る'),report.actionPlan.length > 3);
const inventoryRows=actual.match(/class="product-inventory">[\s\S]*?<tbody>([\s\S]*?)<\/tbody>/)?.[1] || '';
assert.equal((inventoryRows.match(/<tr>/g)||[]).length,report.productInventory?.length || 0,'Every acquired product must render in the inventory table');
for(const product of report.productInventory || []) {
  assert(inventoryRows.includes(render(LinkedText,{text:product.name})),product.id);
}
// Prioritize the overview without changing original detail IDs or equal-priority order.
const mixedPriorityReport={...fixture,actionPlan:['P2','P1','P0','P1','P0'].map((priority,i)=>({priority,action:`優先順位テスト${i}`}))};
const mixedPriorityHtml=render(IntegratedReport,{text:JSON.stringify(mixedPriorityReport)});
const overview=mixedPriorityHtml.match(/class="report-priorities">[\s\S]*?<ol>([\s\S]*?)<\/ol>/)[1];
assert.deepEqual([...overview.matchAll(/href="#report-action-(\d+)"/g)].map(match=>Number(match[1])),[2,4,1]);
assert.deepEqual([...mixedPriorityHtml.matchAll(/<article id="report-action-(\d+)"/g)].map(match=>Number(match[1])),[0,1,2,3,4]);
for (const index of [2,4,1]) assert(overview.includes(`href="#report-action-${index}"><b>優先順位テスト${index}</b>`));
const table=render(TextPanel,{text:'比較の前提です。\n| 項目 | 内容 |\n| --- | --- |\n| 席 | A\\|B |\n\n1. 手順一\n・注意点\n2. 手順二'});
assert(table.includes('<table'));
assert(table.includes('A|B'));
assert.equal((table.match(/<ol/g)||[]).length,2);
assert(table.includes('<ol start="2">'));
assert(table.includes('<ul>'));
const unsafe=render(TextPanel,{text:'<script>alert(1)</script> [unsafe](javascript:alert(1))'});
assert(!unsafe.includes('<script>'));
assert(!unsafe.includes('href="javascript:'));
// Japanese prose directly following a URL must remain visible and outside href.
for (const separator of ['／','。','、','「','」','『','』','（']) {
  const html=render(TextPanel,{text:`https://example.com/menu${separator}条件は現場確認`});
  assert(html.includes('href="https://example.com/menu"'),separator);
  assert(html.includes(`</a>${separator}条件は現場確認`),separator);
}
const datedCitation=render(TextPanel,{text:'https://example.com/menu（2026年10月31日確認）'});
assert(datedCitation.includes('href="https://example.com/menu"'));
assert(datedCitation.includes('</a>（2026年10月31日確認）'));
const markdownCitation=render(TextPanel,{text:'[掲載ページ](https://example.com/menu)／利用条件は未確認'});
assert(markdownCitation.includes('>掲載ページ ↗</a>／利用条件は未確認'));
const japanesePath=render(TextPanel,{text:'https://example.com/メニュー?人数=2／確認後に掲載'});
assert(japanesePath.includes('href="https://example.com/メニュー?人数=2"'));
assert(japanesePath.includes('</a>／確認後に掲載'));

const sourceLinks=render(SourceLinks,{sources:['https://example.com/a','https://example.com/b','https://example.com/a','javascript:alert(1)']});
assert.equal((sourceLinks.match(/<a /g)||[]).length,2);
assert(sourceLinks.includes('/a</small>')&&sourceLinks.includes('/b</small>'));
const modern={...report,qualityGate:{version:2},productInventory:[{id:'C1',name:'表示検証用コース',price:'8,500円',conditions:'2名以上・事前予約',source:'https://example.com/menu',site:'公式サイト'}],keyFindings:[{id:'F1',title:'表示検証用課題',severity:'high',confidence:'inferred',issue:'現状',impact:'顧客への影響',evidence:'根拠',counterpoint:'別の解釈',verification:'実行前確認',action:'変更案',sources:['https://example.com/a']}],actionPlan:[{priority:'P1',action:'表示検証用施策',findingIds:['F1'],owner:'掲載担当',steps:['確認','修正'],deliverable:'更新済みページ',metric:'比較指標',baseline:'未提供',target:'確認して設定',verification:'店長確認'}],researchCoverage:[{targetId:'google',site:'Google マップ',status:'unavailable',scope:'情報を取得できず',limitation:'店舗の問題とは判定しない',sources:[]}]};
const modernHtml=render(IntegratedReport,{text:JSON.stringify(modern)});
for(const expected of ['改善仮説','顧客への影響','別の解釈','実行前確認','掲載担当','更新済みページ','比較指標','未提供','確認して設定','Google マップ','確認できず']) assert(modernHtml.includes(expected),expected);
assert(modernHtml.includes('href="#report-finding-0"'));
assert(modernHtml.includes('8,500円'));
assert(modernHtml.includes('専門調査の商品記録（未照合を含む）'));
assert(modernHtml.includes('現行価格・提供可否を保証するものではありません'));
assert(modernHtml.includes('2名以上・事前予約'));
assert(!modernHtml.includes('次の解析から適用されます'));
// Reviewed inventory must never promote raw media attribution or unresolved products.
const reviewed={...modern,productInventory:[
  {...modern.productInventory[0],name:'訂正後コース',site:'予約媒体A',reviewStatus:'corrected',reviewReason:'原記録の媒体名を訂正'},
  {...modern.productInventory[0],id:'C2',name:'照合済みコース',reviewStatus:'confirmed',reviewReason:'掲載条件と一致'},
  {...modern.productInventory[0],id:'C3',name:'未確認コース',reviewStatus:'unverified',reviewReason:'提供条件を確認できず'},
  {...modern.productInventory[0],id:'C4',name:'棄却コース',reviewStatus:'rejected',reviewReason:'対象店舗の商品ではない'},
  {...modern.productInventory[0],id:'C5',name:'状態欠落コース'},
  {...modern.productInventory[0],id:'C6',name:'未知状態コース',reviewStatus:'future'}
],originalProductInventory:[{...modern.productInventory[0],name:'原記録だけのコース',site:'誤分類された媒体'}]};
const reviewedHtml=render(IntegratedReport,{text:JSON.stringify(reviewed)});
assert(reviewedHtml.includes('照合後の商品情報'),'reviewed inventory has an explicit reviewed heading');
const reviewedTable=reviewedHtml.match(/<table[^>]*><caption>照合後の商品情報<\/caption>[\s\S]*?<\/table>/)?.[0] || '';
assert(reviewedTable.includes('訂正後コース')&&reviewedTable.includes('予約媒体A'));
assert(reviewedTable.includes('照合済みコース'));
assert.equal((reviewedTable.match(/<th scope="col"/g)||[]).length,5,'reviewed inventory must fit the existing five-column product layout');
for(const name of ['未確認コース','棄却コース','状態欠落コース','未知状態コース','原記録だけのコース','誤分類された媒体']) assert(!reviewedTable.includes(name),name);
for(const reason of ['原記録の媒体名を訂正','掲載条件と一致','提供条件を確認できず','対象店舗の商品ではない']) assert(reviewedHtml.includes(reason),reason);
assert(reviewedHtml.includes('未確認・採用しなかった商品情報'));
const originalDetails=reviewedHtml.match(/<details class="sources-block"><summary>専門調査の商品原記録[\s\S]*?<\/details>/)?.[0] || '';
assert(originalDetails.includes('原記録だけのコース')&&originalDetails.includes('誤分類された媒体'),'raw inventory remains in a separate collapsed disclosure');
assert(!reviewedHtml.replace(originalDetails,'').includes('誤分類された媒体'));
// Research gaps and store verification are not store improvement priorities.
const scopes=['research','verification','store','future','store','store','store'];
const scoped={...reviewed,keyFindings:scopes.map((scope,i)=>({...modern.keyFindings[0],id:`SF${i}`,title:`区分課題${i}`,scope})),actionPlan:scopes.map((scope,i)=>({...modern.actionPlan[0],action:`区分施策${i}`,scope,priority:i<2?'P0':'P1',findingIds:[`SF${i}`]}))};
const scopedHtml=render(IntegratedReport,{text:JSON.stringify(scoped)});
const scopedOverview=scopedHtml.match(/class="report-priorities">[\s\S]*?<ol>([\s\S]*?)<\/ol>/)?.[1] || '';
assert.deepEqual([...scopedOverview.matchAll(/href="#report-action-(\d+)"/g)].map(match=>Number(match[1])),[2,4,5],'top three contains store actions only');
for(const text of ['調査側の追加確認','店舗への確認事項','未分類の確認事項']) assert(scopedHtml.includes(text),text);
for(const [i,scope] of scopes.entries()) {
  const group=scope==='future'?'unclassified':scope;
  for(const kind of ['finding','action']) {
    const start=scopedHtml.indexOf(`id="report-${kind}s-${group}"`);
    const item=scopedHtml.indexOf(`id="report-${kind}-${i}"`);
    const next=scopedHtml.indexOf(`id="report-${kind}s-`,start+1);
    assert(start>=0&&item>start&&(next<0||item<next),`${kind} ${i} in ${group}`);
    assert.equal((scopedHtml.match(new RegExp(`id="report-${kind}-${i}"`,'g'))||[]).length,1);
  }
  assert(scopedHtml.includes(`href="#report-finding-${i}"`),`related finding ${i}`);
}
const noStore={...scoped,keyFindings:scoped.keyFindings.filter(item=>item.scope!=='store'),actionPlan:scoped.actionPlan.filter(item=>item.scope!=='store')};
assert(!render(IntegratedReport,{text:JSON.stringify(noStore)}).includes('class="report-priorities"'),'no empty store top-three block');
for(const scope of ['',null,42]) assert(!render(IntegratedReport,{text:JSON.stringify({...fixture,actionPlan:[{action:'未知の区分',scope}]})}).includes('class="report-priorities"'),'unknown scopes never promoted');
// Render the actual agents-tab JSX from App, without mounting auth or any API client.
const appSource=fs.readFileSync(root+'/src/App.tsx','utf8');
const appAst=ts.createSourceFile('App.tsx',appSource,ts.ScriptTarget.ES2022,true,ts.ScriptKind.TSX);
let agentsBranch;
let stageDeclaration;
let titleDeclaration;
const visit=node=>{
  if(ts.isBinaryExpression(node)&&node.operatorToken.kind===ts.SyntaxKind.AmpersandAmpersandToken&&/^tab\s*===\s*"agents"$/.test(node.left.getText(appAst))) agentsBranch=node.right.getText(appAst);
  if(ts.isVariableDeclaration(node)&&node.name.getText(appAst)==='RUN_STAGES') stageDeclaration=`const ${node.getText(appAst)};`;
  if(ts.isFunctionDeclaration(node)&&node.name?.text==='agentTitle') titleDeclaration=node.getText(appAst);
  ts.forEachChild(node,visit);
};
visit(appAst);
assert(agentsBranch&&stageDeclaration&&titleDeclaration,'actual agents-tab branch is present');
const agentModule=new (require('module').Module)(root+'/src/AgentsTab.check.cjs');
agentModule.filename=root+'/src/AgentsTab.check.cjs';
agentModule.paths=moduleObject.paths;
agentModule.require=id=>id==='./ReportView'?moduleObject.exports:req(id);
const reportViewImport=appAst.statements.find(node=>ts.isImportDeclaration(node)&&node.moduleSpecifier.text==='./ReportView').getText(appAst);
agentModule._compile(ts.transpileModule(`${reportViewImport}\n${stageDeclaration}\n${titleDeclaration}\nexport function AgentsTab({selected}: any) { return ${agentsBranch}; }`,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText,agentModule.filename);
const claimReviews=['supported','conditional','unverified','rejected','future'].map((decision,i)=>({agentId:'gourmet',claim:`検証対象の主張${i}`,decision,reason:`統合判断の理由${i}`,sources:[`https://example.com/review/${i}`,'javascript:alert(1)']}));
claimReviews.push({agentId:'market',claim:'別担当だけの主張',decision:'rejected',reason:'別担当だけの理由',sources:[]});
const reviewedClaims={...scoped,claimReviews};
const syntheticAgent={id:'gourmet',provider:'Synthetic provider',status:'done',text:'原文を省略せず残す。\n\n原文の後半も残す。',sources:['https://example.com/raw']};
const renderAgents=report=>render(agentModule.exports.AgentsTab,{selected:{report:JSON.stringify(report),agents:[syntheticAgent]}});
const agentsHtml=renderAgents(reviewedClaims);
assert(agentsHtml.includes('専門AIの原調査（未検証の主張を含む）'),'agent originals must be labeled unverified');
assert(agentsHtml.includes('API応答取得≠全主張検証'));
for(const label of ['統合時に採用','条件付きで採用','未確認','採用せず','原資料との意味の一致を保証するものではありません']) assert(agentsHtml.includes(label),label);
for(const [i] of claimReviews.slice(0,5).entries()) {
  assert(agentsHtml.includes(`検証対象の主張${i}`)&&agentsHtml.includes(`統合判断の理由${i}`));
  assert(agentsHtml.includes(`href="https://example.com/review/${i}"`));
  assert(agentsHtml.indexOf(`統合判断の理由${i}`)<agentsHtml.indexOf('原文を省略せず残す。'),'reviews precede original');
}
assert(!agentsHtml.includes('別担当だけの主張')&&!agentsHtml.includes('別担当だけの理由'));
assert(!agentsHtml.includes('href="javascript:'));
assert(agentsHtml.includes('原文の後半も残す。'));
const legacyAgentHtml=renderAgents(fixture);
assert(legacyAgentHtml.includes('API応答取得≠全主張検証'));
assert(legacyAgentHtml.includes('この担当の主張別の採否記録はありません'));
assert(!legacyAgentHtml.includes('採用せず'),'no inferred rejection for old reports');
assert(renderAgents({...fixture,claimReviews:[]}).includes('この担当の主張別の採否記録はありません'));
const errorAgentHtml=render(agentModule.exports.AgentsTab,{selected:{report:JSON.stringify(reviewedClaims),agents:[{...syntheticAgent,status:'partial',error:'取得時の制約'}]}});
assert(errorAgentHtml.includes('取得時の制約')&&errorAgentHtml.includes('原文の後半も残す。'),'partial/error does not discard original text');
const newFormat=typeof report.qualityGate?.version === 'number' && report.qualityGate.version >= 2;
assert.equal(actual.includes('次の解析から適用されます'),!newFormat);
assert(render(IntegratedReport,{text:JSON.stringify(fixture)}).includes('次の解析から適用されます'));
assert(render(IntegratedReport,{text:'【結論】\n旧形式の本文'}).includes('旧形式の本文'));
// Guard empty/fallback inventory placements and original-record preservation.
for(const detailSections of [[],[{title:'参考情報',body:'商品章がない表示例'}]]) {
  const html=render(IntegratedReport,{text:JSON.stringify({...reviewed,detailSections,detailedReport:''})});
  assert.equal((html.match(/<caption>照合後の商品情報<\/caption>/g)||[]).length,1);
  assert(html.includes('原記録だけのコース'));
}
const rawOnlyHtml=render(IntegratedReport,{text:JSON.stringify({...reviewed,productInventory:[]})});
assert(rawOnlyHtml.includes('照合して採用できた商品情報はありません。'));
assert(rawOnlyHtml.includes('原記録だけのコース'));
assert.equal((reviewedTable.match(/<tr>/g)||[]).length-1,2,'adopted inventory row count');
assert.equal((originalDetails.match(/<tbody>[\s\S]*?<\/tbody>/)?.[0].match(/<tr>/g)||[]).length,reviewed.originalProductInventory.length,'all original rows retained');
for(const html of [actual,modernHtml,reviewedHtml,scopedHtml]) {
  const ids=[...html.matchAll(/\sid="([^"]+)"/g)].map(match=>match[1]);
  assert.equal(new Set(ids).size,ids.length,'anchors are unique');
  for(const [,id] of html.matchAll(/href="#([^"]+)"/g)) assert(ids.includes(id),`anchor ${id} resolves`);
}
const htmlFlag=process.argv.indexOf('--html-dir');
if(htmlFlag>=0){
const htmlDir=path.resolve(process.argv[htmlFlag+1]);fs.mkdirSync(htmlDir,{recursive:true});
// Offline previews use installed system fonts; never fetch external font stylesheets.
const css=fs.readFileSync(root+'/src/style.css','utf8').replace(/@import\s+[^;]+;/g,'');
fs.writeFileSync(path.join(htmlDir,'restaurant-report-review.html'),'<!doctype html><html lang="ja"><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>実レポート表示検証</title><style>'+css+'</style><body><main style="max-width:1160px;margin:0 auto;padding:16px"><h1>保存レポートの表示確認</h1><article class="panel report-panel">'+actual+'</article></main></body></html>');
fs.writeFileSync(path.join(htmlDir,'restaurant-report-modern-review.html'),'<!doctype html><html lang="ja"><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>新形式表示検証用</title><style>'+css+'</style><body><main style="max-width:1160px;margin:0 auto;padding:16px"><h1>表示テスト用データ</h1><article class="panel report-panel">'+modernHtml+'</article></main></body></html>');
for(const [name,html] of [['restaurant-report-reviewed',scopedHtml],['restaurant-agents-reviewed',agentsHtml]]) {
  fs.writeFileSync(path.join(htmlDir,`${name}.html`),'<!doctype html><html lang="ja"><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:"><title>合成データの表示検証</title><style>'+css+'</style><body><main style="max-width:1160px;margin:0 auto;padding:16px"><h1>見本データ（本番の情報ではありません）</h1><article class="panel report-panel">'+html+'</article></main></body></html>');
}
}
console.log(`PASS: ${report.keyFindings.length} legacy findings, ${report.actionPlan.length} legacy actions, ${report.detailSections.length} legacy chapters; reviewed inventory separation and reasons; scoped priorities/anchors; actual App agents branch with claim decisions, original text, old-report and partial-error coverage; table/list/URL safety.`);
