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
const newFormat=typeof report.qualityGate?.version === 'number' && report.qualityGate.version >= 2;
assert.equal(actual.includes('次の解析から適用されます'),!newFormat);
assert(render(IntegratedReport,{text:JSON.stringify(fixture)}).includes('次の解析から適用されます'));
assert(render(IntegratedReport,{text:'【結論】\n旧形式の本文'}).includes('旧形式の本文'));
const htmlFlag=process.argv.indexOf('--html-dir');
if(htmlFlag>=0){
const htmlDir=path.resolve(process.argv[htmlFlag+1]);fs.mkdirSync(htmlDir,{recursive:true});
const css=fs.readFileSync(root+'/src/style.css','utf8');
fs.writeFileSync(path.join(htmlDir,'restaurant-report-review.html'),'<!doctype html><html lang="ja"><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>実レポート表示検証</title><style>'+css+'</style><body><main style="max-width:1160px;margin:0 auto;padding:16px"><h1>保存レポートの表示確認</h1><article class="panel report-panel">'+actual+'</article></main></body></html>');
fs.writeFileSync(path.join(htmlDir,'restaurant-report-modern-review.html'),'<!doctype html><html lang="ja"><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>新形式表示検証用</title><style>'+css+'</style><body><main style="max-width:1160px;margin:0 auto;padding:16px"><h1>表示テスト用データ</h1><article class="panel report-panel">'+modernHtml+'</article></main></body></html>');
}
console.log(`PASS: ${report.keyFindings.length} findings, ${report.actionPlan.length} actions, ${report.detailSections.length} chapters, ${report.productInventory?.length || 0} inventory rows; version-aware legacy notice; table/list/URL safety and evidence/action/coverage fields.`);
