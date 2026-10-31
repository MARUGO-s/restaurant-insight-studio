import type { ReactNode } from "react";

type DetailSection = { title: string; body: string; columns?: string[]; rows?: string[][]; sources?: string[] };
type Finding = { id?: string; title: string; severity?: string; confidence?: string; issue?: string; evidence?: string; impact?: string; counterpoint?: string; verification?: string; action?: string; sources?: string[] };
type Action = { priority?: string; action: string; reason?: string; effort?: string; timing?: string; findingIds?: string[]; owner?: string; steps?: string[]; deliverable?: string; metric?: string; baseline?: string; target?: string; verification?: string };
type Product = { id?: string; name: string; price: string; conditions: string; source: string; site: string };
type Coverage = { targetId?: string; site: string; status?: string; scope?: string; limitation?: string; sources?: string[] };
type ReportDocument = { overallAssessment?: string; keyMessage?: string; keyFindings: Finding[]; strengths?: string[]; actionPlan?: Action[]; limitations?: string[]; detailedReport?: string; detailSections?: DetailSection[]; researchCoverage?: Coverage[]; productInventory?: Product[]; qualityVersion?: number };
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const stringValue = (value: unknown) => typeof value === "string" ? value : "";
const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const records = (value: unknown) => Array.isArray(value) ? value.filter(isRecord) : [];
function validUrl(value: string) { try { const url = new URL(value); return /^https?:$/.test(url.protocol) ? url : null; } catch { return null; } }

export function LinkedText({ text }: { text: string }) {
  // Empty citations from failed fetches have no link or evidence to display.
  text = text.replace(/\(\s*\[\s*\]\(\s*\)\s*\)|\[\s*\]\(\s*\)/g, "");
  // Keep Japanese separators and the explanation after a citation outside the link.
  // These boundaries match the server-side sourceUrls extraction.
  const pattern = /\[([^\]]+)\]\((https?:\/\/[^\s<>"\\\[\]（）)。、。「」『』／]+)\)|(https?:\/\/[^\s<>"\\\[\]（）)。、。「」『』／]+)|\*\*([^*]+)\*\*/g;
  const nodes: ReactNode[] = [];
  let cursor = 0, match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index));
    if (match[4]) nodes.push(<strong key={match.index}>{match[4]}</strong>);
    else {
      const raw = match[2] ?? match[3];
      const href = raw.replace(/[.,;!?。、]+$/, "");
      const url = validUrl(href);
      nodes.push(url ? <a className="inline-source" href={href} title={href} target="_blank" rel="noreferrer" key={match.index}>{match[1] || url.hostname.replace(/^www\./, "")} ↗</a> : match[0]);
      if (href.length < raw.length) nodes.push(raw.slice(href.length));
    }
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return <>{nodes}</>;
}

function sourceLabel(value: string) {
  const url = new URL(value);
  const domain = url.hostname.replace(/^www\./, "");
  let path = url.pathname;
  try { path = decodeURIComponent(path); } catch { /* Keep malformed escapes readable. */ }
  return { domain, path: path === "/" ? "トップページ" : path };
}
export function SourceLinks({ sources }: { sources: string[] }) {
  const unique = [...new Set(sources)].filter((url) => validUrl(url));
  if (!unique.length) return <p className="muted small">参照URLを取得できませんでした。本文の確認範囲を参照してください。</p>;
  return <div className="source-list">{unique.map((url,index) => { const label = sourceLabel(url); return <a key={url} href={url} title={url} aria-label={`出典 ${index + 1}：${url}`} target="_blank" rel="noreferrer"><span>{index + 1}. {label.domain} ↗</span><small>{label.path}</small></a>; })}</div>;
}

function DataTable({ columns, rows, caption }: { columns: string[]; rows: string[][]; caption?: string }) {
  return <div className="report-table-wrap" tabIndex={0} role="region" aria-label={caption || "比較表"}><table className="report-table">{caption && <caption>{caption}</caption>}<thead><tr>{columns.map((column,index) => <th scope="col" key={index}>{column}</th>)}</tr></thead><tbody>{rows.map((row,index) => <tr key={index}>{columns.map((column,col) => <td data-label={column} key={col}><LinkedText text={row[col] || "記載なし"}/></td>)}</tr>)}</tbody></table></div>;
}

const tableCells = (line: string) => line.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
const tableStarts = (lines: string[], index: number) => lines[index]?.includes("|") && tableCells(lines[index + 1] || "").every((cell) => /^:?-{3,}:?$/.test(cell)) && tableCells(lines[index + 1] || "").length > 1;
const headingLine = (line: string) => /^#{1,6}\s+/.test(line) || /^【.+】$/.test(line);
const listLine = (line: string) => /^(?:[・•●▪-]\s*|\d+[.．、)]\s+)/.test(line);
function RichBody({ text }: { text: string }) {
  const lines = text.split(/\r?\n/); const blocks: ReactNode[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim(); if (!line) continue;
    if (tableStarts(lines, i)) {
      const columns = tableCells(line), rows: string[][] = []; i += 2;
      while (i < lines.length && lines[i].includes("|") && !headingLine(lines[i].trim())) { rows.push(tableCells(lines[i])); i++; } i--;
      blocks.push(<DataTable columns={columns} rows={rows} key={i}/>); continue;
    }
    if (headingLine(line)) { blocks.push(<h4 key={i}>{line.replace(/^#{1,6}\s+|^【|】$/g, "")}</h4>); continue; }
    if (listLine(line)) {
      const ordered = /^\d/.test(line); const start = ordered ? Number.parseInt(line, 10) : undefined; const items: ReactNode[] = [];
      while (i < lines.length && listLine(lines[i].trim()) && /^\d/.test(lines[i].trim()) === ordered) {
        const itemIndex = i; let item = lines[i].trim().replace(/^(?:[・•●▪-]\s*|\d+[.．、)]\s*)/, "");
        while (i + 1 < lines.length && /^\s{2,}\S/.test(lines[i + 1]) && !listLine(lines[i + 1].trim()) && !headingLine(lines[i + 1].trim()) && !tableStarts(lines, i + 1)) item += "\n" + lines[++i].trim();
        items.push(<li key={itemIndex}><LinkedText text={item}/></li>); i++;
      }
      i--; blocks.push(ordered ? <ol key={i} start={start}>{items}</ol> : <ul key={i}>{items}</ul>); continue;
    }
    let paragraph = line;
    while (i + 1 < lines.length && lines[i + 1].trim() && !headingLine(lines[i + 1].trim()) && !listLine(lines[i + 1].trim()) && !tableStarts(lines, i + 1)) paragraph += "\n" + lines[++i].trim();
    blocks.push(<p key={i}><LinkedText text={paragraph}/></p>);
  }
  return <div className="report-prose">{blocks}</div>;
}
export function TextPanel({ text }: { text: string }) { return <RichBody text={text}/>; }

function parseSections(text: string): DetailSection[] {
  const headings = [...text.matchAll(/^[ \t]*(?:【([^】]+)】|#{1,3}\s+(.+))[ \t]*$/gm)];
  if (!headings.length) return [{ title: "調査レポート", body: text }];
  const sections = headings.map((heading,index) => ({ title: (heading[1] ?? heading[2]).trim(), body: text.slice((heading.index ?? 0) + heading[0].length, headings[index + 1]?.index ?? text.length).trim() }));
  const preamble = text.slice(0, headings[0].index).trim();
  return preamble ? [{ title: "調査の前提", body: preamble }, ...sections] : sections;
}
function listItems(body: string, numbered = false) {
  return body.split(numbered ? /\n(?=\s*\d+[.．、)]\s*)/ : /\n(?=\s*[・•●▪-])/).map((part) => part.trim().replace(/^(?:[・•●▪-]\s*|\d+[.．、)]\s*)/, "")).filter(Boolean);
}
function legacyActions(body: string) {
  return listItems(body, true).map((entry,index) => {
    const labels = [...entry.matchAll(/(?:根拠|理由|手間|確認先|時期)\s*[:：]/g)];
    if (!labels.length) return [String(index + 1), entry, "本文参照", "本文参照"];
    const fields: Record<string, string> = {};
    labels.forEach((label,i) => { const name = label[0].replace(/[\s:：]/g, ""); const value = entry.slice(label.index! + label[0].length, labels[i + 1]?.index ?? entry.length).trim(); fields[name] = [fields[name], value].filter(Boolean).join("\n"); });
    const followup = [fields["手間"] && `手間：${fields["手間"]}`, fields["時期"] && `時期：${fields["時期"]}`, fields["確認先"] && `確認・実行：${fields["確認先"]}`].filter(Boolean).join("\n");
    return [String(index + 1), entry.slice(0, labels[0].index).trim(), [fields["根拠"], fields["理由"]].filter(Boolean).join("\n") || "本文参照", followup || "本文参照"];
  });
}

const chapterTitle = (title: string) => title.replace(/^\d{1,2}[.．、]\s*/, "");
function DocumentSection({ section, index, products = [] }: { section: DetailSection; index: number; products?: Product[] }) {
  return <section id={`report-section-${index}`} className="report-document-section"><header><span className="chapter-number">{String(index + 1).padStart(2, "0")}</span><h3>{chapterTitle(section.title)}</h3></header><RichBody text={section.body}/>{!!products.length && <ProductInventory products={products}/ >}{!!section.columns?.length && !!section.rows?.length && <DataTable columns={section.columns} rows={section.rows} caption={`${chapterTitle(section.title)}の比較・整理`}/ >}{!!section.sources?.length && <SourceLinks sources={section.sources}/>}</section>;
}
function Contents({ sections }: { sections: DetailSection[] }) { return <nav className="report-contents" aria-label="レポートの目次"><b>このレポートの内容</b><div>{sections.map((section,index) => <a href={`#report-section-${index}`} key={index}>{String(index + 1).padStart(2,"0")}　{chapterTitle(section.title)}</a>)}</div></nav>; }

function LegacyReport({ text }: { text: string }) {
  const sections = parseSections(text);
  const conclusion = sections.find((section) => /結論|要約|総合評価/.test(section.title));
  return <div className="integrated-report report-document">
    <p className="report-version-note">このレポートは保存時の内容を表示しています。調査範囲・根拠区分・実行手順を詳しく整理する新しい形式は、次の解析から適用されます。</p>
    {conclusion && <section className="report-summary"><span className="panel-kicker">EXECUTIVE SUMMARY</span><h3>最初に押さえること</h3><RichBody text={conclusion.body}/></section>}
    <Contents sections={sections}/>
    {sections.map((section,index) => {
      if (/優先施策|アクションプラン|実施計画/.test(section.title)) return <section id={`report-section-${index}`} className="report-document-section" key={index}><header><span className="chapter-number">{String(index+1).padStart(2,"0")}</span><h3>{chapterTitle(section.title)}</h3></header><DataTable columns={["順", "実施すること", "根拠・理由", "手間・確認先と実行内容"]} rows={legacyActions(section.body)}/></section>;
      return <DocumentSection section={section} index={index} key={index}/>;
    })}
  </div>;
}

function parseReport(text: string): ReportDocument | null {
  try {
    const parsed = JSON.parse(text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
    const value = isRecord(parsed?.report) ? parsed.report : parsed;
    if (!isRecord(value) || !Array.isArray(value.keyFindings)) return null;
    return { overallAssessment: stringValue(value.overallAssessment), keyMessage: stringValue(value.keyMessage),
      keyFindings: records(value.keyFindings).map((item) => ({ id: stringValue(item.id), title: stringValue(item.title), severity: stringValue(item.severity), confidence: stringValue(item.confidence), impact: stringValue(item.impact), counterpoint: stringValue(item.counterpoint), verification: stringValue(item.verification), issue: stringValue(item.issue), evidence: stringValue(item.evidence), action: stringValue(item.action), sources: strings(item.sources) })),
      strengths: strings(value.strengths), limitations: strings(value.limitations), detailedReport: stringValue(value.detailedReport),
      actionPlan: records(value.actionPlan).map((item) => ({ priority: stringValue(item.priority), action: stringValue(item.action), reason: stringValue(item.reason), effort: stringValue(item.effort), timing: stringValue(item.timing), findingIds: strings(item.findingIds), owner: stringValue(item.owner), steps: strings(item.steps), deliverable: stringValue(item.deliverable), metric: stringValue(item.metric), baseline: stringValue(item.baseline), target: stringValue(item.target), verification: stringValue(item.verification) })),
      qualityVersion: isRecord(value.qualityGate) && typeof value.qualityGate.version === "number" ? value.qualityGate.version : undefined,
      productInventory: records(value.productInventory).map((item) => ({ id: stringValue(item.id), name: stringValue(item.name), price: stringValue(item.price), conditions: stringValue(item.conditions), source: stringValue(item.source), site: stringValue(item.site) })),
      researchCoverage: records(value.researchCoverage).map((item) => ({ targetId: stringValue(item.targetId), site: stringValue(item.site), status: stringValue(item.status), scope: stringValue(item.scope), limitation: stringValue(item.limitation), sources: strings(item.sources) })),
      detailSections: records(value.detailSections).map((section) => ({ title: stringValue(section.title), body: stringValue(section.body), columns: strings(section.columns), rows: Array.isArray(section.rows) ? section.rows.filter(Array.isArray).map((row) => row.map((cell: unknown) => typeof cell === "string" || typeof cell === "number" ? String(cell) : "")) : [], sources: strings(section.sources) })),
    };
  } catch { return null; }
}
const confidenceLabels: Record<string, string> = { confirmed: "公開情報で確認", inferred: "改善仮説", unverified: "要確認" };
const priorityLabels: Record<string, string> = { P0: "先に確認・対応", P1: "優先して実施", P2: "検証して検討" };
function ActionDetails({ action, index, findings }: { action: Action; index: number; findings: Finding[] }) {
  const related = findings.flatMap((finding,i) => finding.id && action.findingIds?.includes(finding.id) ? [{ finding, index: i }] : []);
  return <article id={`report-action-${index}`} className="action-detail">
    <header><span className={`action-priority priority-${action.priority}`}>{action.priority || index + 1}<small>{priorityLabels[action.priority || ""] || "実施案"}</small></span><div><h4>{action.action}</h4><div className="action-meta">{action.timing && <span>時期：{action.timing}</span>}{action.owner && <span>担当案：{action.owner}</span>}{action.effort && <span>手間：{action.effort}</span>}</div></div></header>
    {action.reason && <RichBody text={action.reason}/>}
    {!!related.length && <div className="related-findings">対応する課題：{related.map(({ finding, index: findingIndex }) => <a href={`#report-finding-${findingIndex}`} key={findingIndex}>{finding.id} {finding.title}</a>)}</div>}
    <div className="action-detail-grid">
      {!!action.steps?.length && <section><h5>実行の手順</h5><ol>{action.steps.map((step,i) => <li key={i}><LinkedText text={step}/></li>)}</ol></section>}
      {(action.deliverable || action.verification) && <section><h5>完了の目安・公開前の確認</h5>{action.deliverable && <p><LinkedText text={action.deliverable}/></p>}{action.verification && <p><LinkedText text={action.verification}/></p>}</section>}
      {(action.metric || action.baseline || action.target) && <section className="action-measurement"><h5>効果の確かめ方</h5><dl>{[["観測する指標",action.metric],["開始前の基準",action.baseline],["目標・判断方法",action.target]].filter(([,value]) => value).map(([label,value]) => <div key={label}><dt>{label}</dt><dd><LinkedText text={value || ""}/></dd></div>)}</dl></section>}
    </div>
  </article>;
}
function ResearchCoverage({ coverage }: { coverage: Coverage[] }) {
  const labels: Record<string,string> = { verified: "確認できた情報あり", partial: "一部のみ確認", unavailable: "確認できず" };
  return <section id="report-coverage" className="report-coverage"><div className="report-section-heading"><h3>何を確認できたか</h3></div><p className="report-reading-note">取得状況は情報を読めた範囲を表します。掲載内容の正しさや、実際の店舗運用を保証するものではありません。</p><div className="coverage-list">{coverage.map((item,index) => <article key={`${item.targetId}-${index}`} className={`coverage-item coverage-${item.status}`}><header><h4>{item.site}</h4><span>{labels[item.status || ""] || "確認範囲は本文参照"}</span></header>{item.scope && <RichBody text={item.scope}/ >}{item.limitation && <p className="coverage-limitation"><b>判断の制約</b><LinkedText text={item.limitation}/></p>}{!!item.sources?.length && <SourceLinks sources={item.sources}/>}</article>)}</div></section>;
}
function ProductInventory({ products }: { products: Product[] }) {
  return <div className="product-inventory"><h4>専門調査の商品記録（未照合を含む）</h4><p className="report-reading-note">専門調査が記録した内容を省略せず保持しています。現行価格・提供可否を保証するものではありません。税込区分や予約条件は、本文の照合結果と店舗の現行運用を確認してください。</p><DataTable columns={["商品・コース", "記録価格", "記録された条件", "記録元", "出典"]} rows={products.map((product) => [[product.id, product.name].filter(Boolean).join(" · "), product.price || "未確認", product.conditions || "未確認", product.site, product.source])} caption="専門調査に残されたコース・商品の記録"/></div>;
}
export function IntegratedReport({ text }: { text: string }) {
  const report = parseReport(text);
  if (!report) return <LegacyReport text={text}/>;
  const detailSections = report.detailSections?.length ? report.detailSections : report.detailedReport ? parseSections(report.detailedReport) : [];
  const labels: Record<string, string> = { high: "優先度：高", medium: "優先度：中", low: "優先度：低" };
  const actions = report.actionPlan || [];
  const priorityOrder: Record<string, number> = { P0: 0, P1: 1, P2: 2 };
  const firstActions = actions.map((action,index) => ({ action, index })).sort((a,b) => (priorityOrder[a.action.priority || ""] ?? 3) - (priorityOrder[b.action.priority || ""] ?? 3) || a.index - b.index).slice(0, 3);
  const products = report.productInventory || [];
  const productSectionIndex = detailSections.findIndex((section) => /コース|メニュー|料金/.test(section.title));
  return <div className="integrated-report report-document">
    {(!report.qualityVersion || report.qualityVersion < 2) && <p className="report-version-note">このレポートは保存時の内容を表示しています。調査範囲・根拠区分・実行手順を詳しく整理する新しい形式は、次の解析から適用されます。</p>}
    <section className="report-summary"><span className="panel-kicker">EXECUTIVE SUMMARY</span><h3>{report.overallAssessment || "総合評価"}</h3><RichBody text={report.keyMessage || ""}/></section>
    <nav className="report-reading-nav" aria-label="レポートの読み進め方">{!!report.keyFindings.length && <a href="#report-findings">課題と根拠を見る <span>↓</span></a>}{!!actions.length && <a href="#report-actions">実行手順を見る <span>↓</span></a>}{!!report.researchCoverage?.length && <a href="#report-coverage">調査範囲を確かめる <span>↓</span></a>}{!!detailSections.length && <a href="#report-details">詳細な分析を読む <span>↓</span></a>}</nav>
    {!!actions.length && <section className="report-priorities"><div className="report-section-heading"><h3>{actions.length >= 3 ? "まず取り組む3項目" : "まず取り組むこと"}</h3></div><p className="report-reading-note">担当・時期・目標は実施案です。店舗で確認してから着手してください。</p><ol>{firstActions.map(({ action, index }) => <li key={index}><span className={`priority-tag priority-${action.priority}`}>{action.priority || index + 1}</span><a href={`#report-action-${index}`}><b>{action.action}</b><span>{[priorityLabels[action.priority || ""], action.timing].filter(Boolean).join(" · ")}</span></a><span aria-hidden="true">↓</span></li>)}</ol>{actions.length > 3 && <a className="all-actions-link" href="#report-actions">すべての施策と実行手順を見る（{actions.length}件） <span aria-hidden="true">↓</span></a>}</section>}
    {!!report.keyFindings.length && <section id="report-findings" className="report-findings"><div className="report-section-heading"><h3>何が問題で、どう変えるか</h3></div><p className="report-reading-note">優先度と根拠の確かさを分けて表示します。「改善仮説」「要確認」は、確認後に判断する項目です。</p><div className="finding-list">{report.keyFindings.map((finding,index) => <article id={`report-finding-${index}`} className={`finding-card severity-${finding.severity}`} key={index}><div className="finding-title"><span>{finding.id || `課題 ${index + 1}`}</span><span>{labels[finding.severity ?? ""] || "優先度は本文参照"}</span>{finding.confidence && <span className={`confidence-label confidence-${finding.confidence}`}>{confidenceLabels[finding.confidence] || "根拠は本文参照"}</span>}<h4>{finding.title}</h4></div><RichBody text={finding.issue || ""}/>{finding.impact && <div className="finding-impact"><b>お客様・店舗への影響</b><RichBody text={finding.impact}/></div>}<div className="finding-detail-grid">{finding.evidence && <div className="finding-evidence"><b>根拠と確認範囲</b><RichBody text={finding.evidence}/></div>}{finding.action && <div className="finding-action"><b>具体的な変更案</b><RichBody text={finding.action}/></div>}</div>{(finding.counterpoint || finding.verification) && <div className="finding-verification">{finding.counterpoint && <div><b>別の解釈・反証</b><RichBody text={finding.counterpoint}/></div>}{finding.verification && <div><b>実行前に確認すること</b><RichBody text={finding.verification}/></div>}</div>}{!!finding.sources?.length && <SourceLinks sources={finding.sources}/>}</article>)}</div></section>}
    {!!actions.length && <section id="report-actions" className="report-actions"><h3>担当者が実行できる改善計画</h3><div className="action-detail-list">{actions.map((action,index) => <ActionDetails action={action} index={index} findings={report.keyFindings} key={index}/>)}</div></section>}
    {!!report.strengths?.length && <section className="report-strengths"><h3>活かせる強み</h3><RichBody text={report.strengths.map((item) => `・${item}`).join("\n")}/></section>}
    {!!report.researchCoverage?.length && <ResearchCoverage coverage={report.researchCoverage}/>}
    {!!report.limitations?.length && <aside className="report-limitations"><h3>判断前に押さえる制約</h3><RichBody text={report.limitations.map((item) => `・${item}`).join("\n")}/></aside>}
    {!!detailSections.length && <div id="report-details"><div className="report-section-heading"><h3>根拠と比較から読む詳細分析</h3></div><Contents sections={detailSections}/></div>}
    {!!report.detailSections?.length && report.detailedReport && <section className="report-document-section"><header><h3>分析の前提と読み方</h3></header><RichBody text={report.detailedReport}/></section>}
    {!!products.length && productSectionIndex < 0 && <ProductInventory products={products}/>}
    {detailSections.map((section,index) => <DocumentSection section={section} index={index} products={index === productSectionIndex ? products : []} key={index}/>)}
  </div>;
}
