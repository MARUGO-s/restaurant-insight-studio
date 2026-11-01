import { useEffect, useMemo, useRef, useState } from "react";
import { costExplanation } from "./lib/costs";
import type { FormEvent } from "react";
import type { Session } from "@supabase/supabase-js";
import { displayLoginId, loginEmailFromId, supabase } from "./lib/supabase";
import { invoke } from "./lib/api";
import { IntegratedReport, TextPanel, SourceLinks } from "./ReportView";
import { TrashPage, TrashIcon, DeleteReportDialog, reportDate } from "./ReportTrash";
import type { TrashItem } from "./ReportTrash";
import { GeminiConnectionCheck, ProviderErrorDetails } from "./ProviderDiagnostics";
import type { ProviderDiagnosticError } from "./ProviderDiagnostics";

type Agent = { id: string; provider: string; status: "done" | "partial" | "error"; text: string; sources: string[]; error?: string };
type Followup = { question: string; answer: string; sources: string[]; at: string };
type SiteTarget = { id: string; name: string; url: string };
type Report = {
  id: string; runId?: string | null; storeName: string; storeUrl: string; groupName: string | null; createdAt: string;
  selectedSites?: SiteTarget[]; researchFocus?: string; deletedAt?: string | null; agents: Agent[]; critique: string; critiqueSources: string[]; report: string; reportSources: string[]; followups: Followup[];
};
type CostEvent = {
  id: string; user_id: string; run_id: string | null; report_id: string | null; operation: string; provider: string;
  model: string; request_status: "succeeded" | "failed" | "unknown"; measurement_status: "complete" | "partial" | "unknown";
  usage: Record<string, number | null>; rates: Record<string, number>; list_price_usd: number | null; pricing_as_of: string; created_at: string;
  report_name?: string | null; report_created_at?: string | null; report_deleted_at?: string | null;
  attempt_number?: number | null;
  request_metadata?: { provider_error?: ProviderDiagnosticError; http_status?: number | null; duration_ms?: number; timeout_ms?: number;
    request_phase?: string; transport_error?: string; reconciliation_status?: string;
    research_mode?: "full" | "incremental"; full_fallback_reason?: string };
};
type Health = { openai: boolean; gemini: boolean; xai: boolean };
type Tab = "report" | "agents" | "critique";
type Page = "analysis" | "costs" | "trash";
type TrashResult = { reports: Report[]; nextCursor?: string | null; total?: number };
type ReportAction = "trash_report" | "restore_report" | "delete_report";
type ReportState = { state: "active" | "trashed" | "deleted" | "missing"; report?: Report };
type AnalysisJob = { key: string; status: "pending" | "running" | "done" | "failed"; attempts: number; maxAttempts: number; label: string; error?: string };
type RunState = { status: "running" | "done" | "failed" | "trashed" | "deleted"; progressStage: string; startedAt?: string; researchFocus?: string; jobs?: AnalysisJob[]; report?: Report; error?: string };
type ActiveRun = { runId: string; startedAt: string; storeName: string; researchFocus?: string };
const RESEARCH_FOCUS_LIMIT = 2000;
const RUN_STAGES = [
  { key: "market", label: "市場・競合調査" },
  { key: "gourmet", label: "グルメ媒体・掲載分析" },
  { key: "social_recent", label: "Xの直近の声" },
  { key: "social_history", label: "Xの過去の傾向・反証" },
  { key: "synthesis", label: "反証の確認・レポート統合" },
];
function agentTitle(id: string) {
  return RUN_STAGES.find((stage) => stage.key === id)?.label ?? (id.startsWith("social") ? "X・SNSの評判" : "専門調査");
}
const activeRunStorageKey = (userId: string) => `restaurantInsightActiveRun:${userId}`;
function readActiveRun(userId: string): ActiveRun | null {
  try {
    const saved = JSON.parse(localStorage.getItem(activeRunStorageKey(userId)) || "null");
    return saved && typeof saved.runId === "string" && typeof saved.startedAt === "string" && typeof saved.storeName === "string"
      ? { runId: saved.runId, startedAt: saved.startedAt, storeName: saved.storeName, researchFocus: typeof saved.researchFocus === "string" ? saved.researchFocus.slice(0, RESEARCH_FOCUS_LIMIT) : undefined } : null;
  } catch { return null; }
}
function saveActiveRun(userId: string, run: ActiveRun) {
  try { localStorage.setItem(activeRunStorageKey(userId), JSON.stringify(run)); } catch { /* The active page can still follow the run if browser storage is unavailable. */ }
}
function clearActiveRun(userId: string, runId: string) {
  try { if (readActiveRun(userId)?.runId === runId) localStorage.removeItem(activeRunStorageKey(userId)); } catch { /* Storage may be unavailable. */ }
}

const SITE_OPTIONS = [
  { id: "tabelog", name: "食べログ", hint: "口コミ・評価・掲載情報" },
  { id: "google_maps", name: "Google マップ", hint: "クチコミ・店舗情報" },
  { id: "hotpepper", name: "ホットペッパーグルメ", hint: "コース・クーポン・口コミ" },
  { id: "gurunavi", name: "ぐるなび", hint: "メニュー・予約・店舗情報" },
  { id: "retty", name: "Retty", hint: "口コミ・おすすめ情報" },
  { id: "ikyu", name: "一休.comレストラン", hint: "プラン・評価・予約情報" },
  { id: "ozmall", name: "OZmall", hint: "レストランプラン・口コミ" },
  { id: "hitosara", name: "ヒトサラ", hint: "店舗・シェフ・メニュー情報" },
];

function analysisErrorMessage(error: unknown) {
  const detail = error instanceof Error ? error.message : "分析に失敗しました";
  const guidance: string[] = [];
  if (/quota|exceeded your current quota|rate limit|利用枠/i.test(detail)) {
    guidance.push(/Gemini/i.test(detail)
      ? "Geminiが利用枠エラーを返しました。前払い残高だけでは原因は判定できません。「API料金」の「Gemini接続確認」で、使用モデルとGoogleが返した制限の詳細を確認できます。完了済みの専門調査は保存されています。"
      : "AI提供元が利用枠エラーを返しました。表示された提供元・モデルの制限をご確認ください。完了済みの専門調査は保存されています。");
  }
  if (/signal timed out|timed out|timeout/i.test(detail)) {
    guidance.push("Web検索に時間がかかり、調査の一部が時間内に完了しませんでした。実行中の調査がある場合は、進行状況から未完了の調査を再開できます。");
  }
  return [...guidance, detail].join("\n\n");
}

function dateLabel(value: string) {
  return new Date(value).toLocaleString("ja-JP", { dateStyle: "medium", timeStyle: "short" });
}
function abortableDelay(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => { window.clearTimeout(timer); reject(new DOMException("Polling cancelled", "AbortError")); };
    const timer = window.setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
function readRunStatus(runId: string, signal: AbortSignal): Promise<RunState> {
  return new Promise((resolve, reject) => {
    const finish = (result?: RunState, failure?: unknown) => {
      window.clearTimeout(timer); signal.removeEventListener("abort", abort);
      if (failure) reject(failure); else resolve(result!);
    };
    const abort = () => finish(undefined, new DOMException("Polling cancelled", "AbortError"));
    const timer = window.setTimeout(() => finish(undefined, new Error("進行状況の取得がタイムアウトしました")), 30_000);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) { abort(); return; }
    void invoke<RunState>({ action: "run_status", runId }).then((state) => finish(state), (failure) => finish(undefined, failure));
  });
}
async function waitForAnalysis(runId: string, signal: AbortSignal, onState: (state: RunState) => void, onConnection: (notice: string) => void): Promise<{ kind: "done"; report: Report } | { kind: "failed" | "unknown" | "trashed" | "deleted" }> {
  const deadline = Date.now() + 60 * 60_000;
  let connectionFailures = 0;
  while (Date.now() < deadline) {
    if (signal.aborted) throw new DOMException("Polling cancelled", "AbortError");
    try {
      const state = await readRunStatus(runId, signal);
      if (signal.aborted) throw new DOMException("Polling cancelled", "AbortError");
      if (!state || !["running", "done", "failed", "trashed", "deleted"].includes(state.status)) throw new Error("進行状況の応答を確認できませんでした");
      connectionFailures = 0; onState(state); onConnection("");
      if (state.status === "trashed" || state.status === "deleted") return { kind: state.status };
      if (state.status === "done" && state.report && !state.jobs?.some((job) => job.status !== "done")) return { kind: "done", report: state.report };
      if (state.status === "failed") return { kind: "failed" };
      if (state.status === "done") onConnection(state.jobs?.some((job) => job.status !== "done") ? "一部の調査が完了として記録されていません。全調査の状態を確認しています。" : "調査の完了を確認しました。保存済みレポートの取得を続けています。");
    } catch (failure) {
      if (signal.aborted) throw failure;
      connectionFailures += 1;
      onConnection("進行状況を一時的に確認できません。調査の失敗とは判定せず、自動で接続を確認しています。画面を閉じても、同じアカウントで再開できます。");
    }
    await abortableDelay(Math.min(30_000, 5000 * Math.max(1, connectionFailures)), signal);
  }
  onConnection("この画面での自動確認を60分で一時停止しました。調査を停止したわけではありません。「進行状況を再確認」から同じ解析の状況を確認できます。");
  return { kind: "unknown" };
}
function usd(value: number | null | undefined) { return value == null ? "料金未確定" : `$${value.toFixed(6)}`; }
function ResearchFocusNote({ text }: { text?: string }) {
  if (!text) return null;
  return <section className="research-focus-note" aria-label="この調査で指定した重点事項"><b>この調査で指定した重点事項</b><p>{text}</p></section>;
}
const sumPrices = (events: CostEvent[]) => events.reduce((sum, event) => sum + (event.list_price_usd ?? 0), 0);
const operationNames: Record<string, string> = { market_research: "市場・競合調査", gourmet_research: "グルメ媒体調査", gourmet_fallback_research: "グルメ媒体調査（過去の代替AI）", social_research: "X・SNS調査", social_recent: "Xの直近の声", social_history: "Xの過去の傾向・反証", fact_check: "反証・確認", synthesis: "レポート統合", fact_check_synthesis: "反証・統合", followup_question: "レポートへの質問", provider_diagnostic: "Gemini接続確認" };

function RunProgress({ run, state, polling, retrying, busy, notice, onRetry, onCheck, onClose }: { run: ActiveRun; state: RunState | null; polling: boolean; retrying: boolean; busy: boolean; notice: string; onRetry: () => void; onCheck: () => void; onClose: () => void }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  const elapsed = Math.max(0, Math.floor((now - new Date(state?.startedAt || run.startedAt).getTime()) / 1000));
  const elapsedLabel = Number.isFinite(elapsed) ? `${Math.floor(elapsed / 60)}分${String(elapsed % 60).padStart(2, "0")}秒` : "確認中";
  const jobs = RUN_STAGES.map((stage) => state?.jobs?.find((job) => job.key === stage.key) ?? { ...stage, status: "pending" as const, attempts: 0, maxAttempts: 3 });
  const failed = state?.status === "failed";
  const done = jobs.filter((job) => job.status === "done").length;
  const statusNames = { pending: "待機中", running: "調査中", done: "完了", failed: "未完了" };
  return <section className={`panel durable-progress ${failed ? "has-failure" : ""}`} aria-label="解析の進行状況">
    <header><div><span className="panel-kicker">RESEARCH PROGRESS</span><h3>{failed ? "未完了の調査があります" : notice ? "調査の状況を確認しています" : state?.progressStage === "checking" ? "反証を確認し、総合レポートを作成しています" : "専門AIが調査を進めています"}</h3><p>{run.storeName || "店舗分析"} · 経過 {elapsedLabel} · {done}/{jobs.length}段階完了</p></div>{polling && <i className="spinner large"/>}</header>
    <p className="run-guidance">調査結果は段階ごとに保存されます。画面を閉じても調査は続き、同じアカウントで開くと進行状況を確認できます。X調査は直近と過去を分けて実行し、再試行を含む解析には30分以上かかる場合があります。</p>
    <ResearchFocusNote text={state?.researchFocus ?? run.researchFocus}/>
    {notice && <div className="run-connection-notice" role="status">{notice}</div>}
    <ol className="run-job-list">{jobs.map((job, index) => <li key={job.key} className={`run-job ${job.status}`}><span className="run-job-mark" aria-hidden="true">{job.status === "done" ? "✓" : index + 1}</span><div><b>{job.label || RUN_STAGES[index].label}</b><small>{job.key === "synthesis" && job.status === "running" ? "検証・執筆中" : statusNames[job.status]}{job.attempts > 0 ? ` · 試行 ${job.attempts}/${job.maxAttempts}回` : ""}</small>{job.error && <p>{job.status === "running" || job.status === "pending" ? "前回の試行: " : ""}{job.error}</p>}</div></li>)}</ol>
    {failed && <div className="run-failure-note"><b>完成済みの調査結果を保持しています。</b><p>{state?.error || "完了しなかった調査があります。"}</p><p>再開すると、同じ解析の未完了の調査を再試行します。再試行分のAPI料金が発生する場合があります。この解析を閉じても、保存済みの調査結果や料金記録は削除されません。</p></div>}
    <div className="run-actions">{failed && <button type="button" className="primary-button" disabled={busy || polling || retrying || !!notice} onClick={onRetry}>{retrying ? "再開を確認しています…" : "未完了の調査を再開"}</button>}{!polling && <button type="button" className="run-check-button" disabled={busy || retrying} onClick={onCheck}>進行状況を再確認</button>}{failed && <button type="button" className="run-check-button" disabled={busy || polling || retrying || !!notice} onClick={onClose}>この解析を閉じて新しく分析</button>}</div>
  </section>;
}

function CostPage({ reports, costs, loading, error, onRefresh }: { reports: Report[]; costs: CostEvent[]; loading: boolean; error: string; onRefresh: (reconcile?: boolean) => Promise<void> }) {
  const startOfMonth = new Date(); startOfMonth.setDate(1); startOfMonth.setHours(0, 0, 0, 0);
  const thisMonth = costs.filter((event) => new Date(event.created_at) >= startOfMonth);
  const monthTotal = sumPrices(thisMonth);
  const analysisRuns = new Set(thisMonth.filter((event) => event.run_id).map((event) => event.run_id)).size;
  const questionTotal = sumPrices(thisMonth.filter((event) => event.operation === "followup_question"));
  const incompleteCount = thisMonth.filter((event) => event.list_price_usd == null).length;
  const byRun = new Map<string, CostEvent[]>();
  for (const event of costs) if (event.run_id) byRun.set(event.run_id, [...(byRun.get(event.run_id) ?? []), event]);
  const reportByRun = new Map(reports.filter((report) => report.runId).map((report) => [report.runId!, report]));
  const analysisRows = [...byRun.entries()].sort((a, b) => (b[1][0]?.created_at ?? "").localeCompare(a[1][0]?.created_at ?? ""));
  const recentEvents = costs.slice(0, 80);
  const usageSummary = (event: CostEvent) => {
    const u = event.usage ?? {};
    return [u.input_tokens != null && `入力 ${u.input_tokens.toLocaleString()} tok`, u.output_tokens != null && `出力 ${u.output_tokens.toLocaleString()} tok`, (u.web_search_calls ?? 0) > 0 && `Web検索 ${u.web_search_calls}回`, (u.google_search_queries ?? 0) > 0 && `Google検索 ${u.google_search_queries}件`, (u.x_posts_fetched ?? 0) > 0 && `X投稿 ${u.x_posts_fetched}件`, (u.x_users_fetched ?? 0) > 0 && `Xプロフィール ${u.x_users_fetched}件`].filter(Boolean).join(" · ") || "最終利用量の記録なし";
  };
  return <section className="cost-page">
    <div className="cost-page-heading"><div><span className="eyebrow">API USAGE & COST</span><h2>API料金・利用量</h2><p>AIのAPI応答ごとに、返却されたトークン数と検索件数から費用を積算します。</p></div><span className="cost-currency">USD · 公式標準単価</span></div>
    <div className="cost-disclosure"><b>請求書の確定額ではなく、実測利用量 × 単価による積算です。</b><span>無料枠、契約割引、税、為替、プロバイダー側の後日調整は含みません。通信中断、利用量の不足、単価未登録の呼び出しは「料金未確定」として理由を表示します。未確定は無料という意味ではありません。金額が小さい場合も6桁で表示します。料金記録の導入前に実行した過去の分析は利用量を遡って取得できないため、ここには表示されません。</span></div>
    {error && <div className="error-banner">{error}</div>}
    {incompleteCount > 0 && <div className="run-connection-notice"><p>未確定分は、完了した調査とは別の試行を含みます。再確認ではxAIの保存済み応答を最大4件取得し、新しい調査は開始しません。再確認の間隔は5分です。取得できない分は合計に含めません。</p><button type="button" className="run-check-button" disabled={loading} onClick={() => { void onRefresh(true); }}>{loading ? "確認しています…" : "未確定分を再確認"}</button></div>}
    <GeminiConnectionCheck onRefresh={onRefresh}/>
    <div className="cost-metrics"><article className="panel"><span>今月の標準料金積算</span><b>{usd(monthTotal)}</b><small>{incompleteCount ? `料金未確定 ${incompleteCount}件を除く` : "APIの返却値を記録済み"}</small></article><article className="panel"><span>分析実行数</span><b>{analysisRuns.toLocaleString()}回</b><small>失敗した実行も含む・現在表示できる履歴</small></article><article className="panel"><span>質問への回答</span><b>{usd(questionTotal)}</b><small>今月のレポート質問分</small></article></div>
    <article className="panel cost-section"><header><div><span className="panel-kicker">ANALYSIS RUNS</span><h3>1回ごとの分析費用</h3></div></header>
      {loading ? <p className="muted">利用量を読み込んでいます…</p> : !analysisRows.length ? <p className="muted">費用記録はまだありません。次回の分析実行から、AIごとの利用量を記録します。</p> : <div className="cost-run-list">{analysisRows.map(([runId, events]) => {
        const report = reportByRun.get(runId); const known = events.every((event) => event.list_price_usd != null); const total = sumPrices(events);
        const providers = [...new Set(events.map((event) => event.provider))];
        const archived = events.find((event) => event.report_name);
        return <article className="cost-run" key={runId}><div className="cost-run-head"><div><b>{report?.storeName ?? archived?.report_name ?? "レポート未作成の分析"}{events.some((event) => event.report_deleted_at) ? "（レポート削除済み）" : report?.deletedAt ? "（ゴミ箱）" : ""}</b><small>{dateLabel(events[0]?.created_at ?? "")} · {providers.join(" / ")}</small></div><strong>{known ? usd(total) : `判明分 ${usd(total)} + 未算定`}</strong></div><div className="cost-run-breakdown">{events.map((event) => <span key={event.id}>{event.provider} {event.model}: {usd(event.list_price_usd)}</span>)}</div></article>;
      })}</div>}
    </article>
    <article className="panel cost-section"><header><div><span className="panel-kicker">REQUEST LEDGER</span><h3>API呼び出し明細</h3></div></header>
      {!recentEvents.length ? <p className="muted">API呼び出しの記録はまだありません。</p> : <div className="cost-event-list">{recentEvents.map((event) => <div className="cost-event" key={event.id}><div className="cost-event-main"><b>{operationNames[event.operation] ?? event.operation}</b><small>{event.provider} · {event.model} · {dateLabel(event.created_at)}{event.attempt_number ? ` · 試行${event.attempt_number}回目` : ""}</small><small>{usageSummary(event)}</small>{event.request_metadata?.research_mode && <small>{event.request_metadata.research_mode === "incremental" ? "前回の根拠を保持して差分を調査" : event.request_metadata.full_fallback_reason ? "品質確認のため全範囲を再調査" : "全範囲を調査"}</small>}{costExplanation(event).reason && <small>{costExplanation(event).reason}</small>}{event.request_metadata?.transport_error && <details className="provider-error-disclosure"><summary>中断理由の詳細</summary><p>{event.request_metadata.transport_error}</p></details>}{event.request_metadata?.provider_error && <details className="provider-error-disclosure"><summary>提供元が返したエラーの詳細</summary><ProviderErrorDetails error={event.request_metadata.provider_error}/></details>}</div><div className="cost-event-price"><b>{usd(event.list_price_usd)}</b><small>{costExplanation(event).label} · 単価 {event.pricing_as_of}</small></div></div>)}</div>}
    </article>
    <article className="panel cost-section"><header><div><span className="panel-kicker">PRICE SOURCES</span><h3>単価の参照先</h3></div></header><div className="cost-sources"><a href="https://developers.openai.com/api/docs/pricing" target="_blank" rel="noreferrer">OpenAI API料金 ↗</a><a href="https://ai.google.dev/gemini-api/docs/pricing" target="_blank" rel="noreferrer">Gemini API料金 ↗</a><a href="https://docs.x.ai/developers/pricing" target="_blank" rel="noreferrer">xAI API料金 ↗</a><a href="https://docs.x.ai/developers/tools/x-search" target="_blank" rel="noreferrer">xAI X Search料金 ↗</a></div></article>
  </section>;
}

export default function App() {
  const [reports, setReports] = useState<Report[]>([]);
  const [trashedReports, setTrashedReports] = useState<Report[]>([]);
  const [trashCount, setTrashCount] = useState(0);
  const [trashCursor, setTrashCursor] = useState<string | null>(null);
  const [trashLoading, setTrashLoading] = useState(false);
  const [trashError, setTrashError] = useState("");
  const [busyReportId, setBusyReportId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TrashItem | null>(null);
  const [reportNotice, setReportNotice] = useState<{ uncertain: boolean; text: string } | null>(null);
  const [costs, setCosts] = useState<CostEvent[]>([]);
  const [costLoading, setCostLoading] = useState(false);
  const [costError, setCostError] = useState("");
  const [page, setPage] = useState<Page>("analysis");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loginId, setLoginId] = useState("");
  const [password, setPassword] = useState("");
  const [signingIn, setSigningIn] = useState(false);
  const [health, setHealth] = useState<Health>({ openai: false, gemini: false, xai: false });
  const [storeName, setStoreName] = useState("マルゴ四谷");
  const [storeUrl, setStoreUrl] = useState("https://marugo-waltz.com");
  const [groupName, setGroupName] = useState("マルゴグループ");
  const [researchFocus, setResearchFocus] = useState("");
  const [selectedSiteIds, setSelectedSiteIds] = useState<string[]>(["tabelog"]);
  const [siteUrls, setSiteUrls] = useState<Record<string, string>>({});
  const [customSites, setCustomSites] = useState<{ id: string; name: string; url: string }[]>([]);
  const [question, setQuestion] = useState("");
  const [tab, setTab] = useState<Tab>("report");
  const [researchExpanded, setResearchExpanded] = useState(false);
  const [working, setWorking] = useState<"analysis" | "question" | null>(null);
  const [activeRun, setActiveRun] = useState<ActiveRun | null>(null);
  const [runState, setRunState] = useState<RunState | null>(null);
  const [polling, setPolling] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [discoveringRun, setDiscoveringRun] = useState(false);
  const [runNotice, setRunNotice] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const currentUserId = useRef<string | null>(null);
  const authEpoch = useRef(0);
  const reportRevision = useRef(0);
  const trashRequest = useRef(0);
  const reportMutation = useRef(false);
  const activePoll = useRef<{ runId: string; userId: string; controller: AbortController } | null>(null);

  const selected = useMemo(() => reports.find((report) => report.id === selectedId) ?? reports[0] ?? null, [reports, selectedId]);
  const selectedSiteNames = [...SITE_OPTIONS.filter((site) => selectedSiteIds.includes(site.id)).map((site) => site.name), ...customSites.filter((site) => site.name.trim() && site.url.trim()).map((site) => site.name.trim())];
  const selectedSiteSummary = selectedSiteNames.length > 2 ? `${selectedSiteNames.slice(0, 2).join("・")} ほか${selectedSiteNames.length - 2}件` : selectedSiteNames.join("・");
  async function refresh(userId: string, epoch: number) {
    const current = () => currentUserId.current === userId && authEpoch.current === epoch;
    const revision = reportRevision.current;
    try {
      const [result, costResult] = await Promise.all([
        invoke<{ reports: Report[] }>({ action: "list" }),
        invoke<{ costs: CostEvent[] }>({ action: "costs" }),
      ]);
      if (!current()) return;
      if (reportRevision.current === revision) {
        setReports(result.reports.filter((report) => !report.deletedAt));
        setSelectedId((id) => result.reports.some((report) => report.id === id) ? id : result.reports[0]?.id ?? null);
      }
      setCosts(costResult.costs);
      try { const status = await invoke<{ configured: Health }>({ action: "health" }); if (current()) setHealth(status.configured); }
      catch { if (current()) setHealth({ openai: false, gemini: false, xai: false }); }
    } catch (e) { if (current()) setError(e instanceof Error ? e.message : "Supabaseの分析APIに接続できません"); }
    finally { if (current()) setLoading(false); }
  }
  async function refreshTrash(append = false) {
    const userId = currentUserId.current, epoch = authEpoch.current, revision = reportRevision.current;
    if (!userId) return;
    const request = ++trashRequest.current;
    const current = () => currentUserId.current === userId && authEpoch.current === epoch && trashRequest.current === request;
    setTrashLoading(true); setTrashError("");
    try {
      const result = await invoke<TrashResult>({ action: "list_trash", ...(append && trashCursor ? { cursor: trashCursor } : {}) });
      if (!current() || reportRevision.current !== revision) return;
      setTrashedReports((items) => append ? [...items, ...result.reports.filter((item) => !items.some((saved) => saved.id === item.id))] : result.reports);
      setTrashCount(result.total ?? result.reports.length); setTrashCursor(result.nextCursor ?? null);
    } catch { if (current() && reportRevision.current === revision) setTrashError("ゴミ箱を読み込めませんでした。「一覧を更新」から確認してください。"); }
    finally { if (current()) setTrashLoading(false); }
  }
  async function changeReport(action: ReportAction, target: TrashItem) {
    const userId = currentUserId.current, epoch = authEpoch.current;
    if (!userId || reportMutation.current || working === "question") return;
    reportMutation.current = true; ++reportRevision.current; setBusyReportId(target.id); setReportNotice(null);
    const current = () => currentUserId.current === userId && authEpoch.current === epoch;
    let updated: Report | undefined;
    let confirmed = false;
    let observed: ReportState | null = null;
    try {
      try {
        const result = await invoke<{ report?: Report; deleted?: boolean }>({ action, reportId: target.id, ...(action === "delete_report" ? { confirm: true } : {}) });
        updated = result.report;
        confirmed = action === "delete_report" ? result.deleted === true : updated?.id === target.id && (action === "trash_report" ? !!updated.deletedAt : !updated.deletedAt);
        if (!confirmed) throw new Error("操作結果の確認が必要です");
      } catch {
        // The mutation may have committed before its response was lost.
        const state = await invoke<ReportState>({ action: "report_state", reportId: target.id }).catch(() => null);
        observed = state;
        updated = state?.report;
        confirmed = action === "delete_report" ? state?.state === "deleted" || state?.state === "missing"
          : action === "trash_report" ? state?.state === "trashed" && !!updated : state?.state === "active" && !!updated;
      }
      if (!current()) return;
      ++reportRevision.current;
      if (!confirmed) {
        setReportNotice({ uncertain: true, text: observed?.state === "active" ? "このレポートは現在、保存したレポートにあります。削除はしていません。一覧を更新しました。"
          : observed?.state === "trashed" ? "このレポートは現在、ゴミ箱にあります。復元は確認できませんでした。一覧を更新しました。"
          : observed?.state === "deleted" || observed?.state === "missing" ? "このレポートは現在アクセスできません。削除済みの可能性があります。一覧を更新しました。"
          : "操作結果を確認できませんでした。すでに反映されている場合があります。一覧を更新して状態をご確認ください。" });
        if (observed) { void refresh(userId, epoch); void refreshTrash(); }
        return;
      }
      if (action === "restore_report" && updated) {
        setReports((items) => [updated!, ...items.filter((item) => item.id !== target.id)].sort((a,b) => b.createdAt.localeCompare(a.createdAt)));
        setTrashedReports((items) => items.filter((item) => item.id !== target.id));
        setTrashCount((count) => Math.max(0, count - 1));
      } else {
        setReports((items) => items.filter((item) => item.id !== target.id));
        setSelectedId((id) => id === target.id ? null : id);
        if (action === "trash_report" && updated) {
          setTrashedReports((items) => [updated!, ...items.filter((item) => item.id !== target.id)]);
          setTrashCount((count) => count + 1);
        } else {
          setTrashedReports((items) => items.filter((item) => item.id !== target.id));
          setTrashCount((count) => Math.max(0, count - 1));
        }
      }
      setReportNotice({ uncertain: false, text: action === "trash_report" ? "ゴミ箱に移動しました。ゴミ箱から復元できます。" : action === "restore_report" ? "レポートを復元しました。保存したレポートから開けます。" : "レポートを完全に削除しました。API料金の履歴は残っています。" });
      void refreshTrash();
      if (action === "delete_report") void refreshCosts();
    } finally {
      if (current()) { reportMutation.current = false; setBusyReportId(null); setDeleteTarget(null); }
    }
  }
  async function refreshCosts(reconcile = false) {
    const userId = currentUserId.current, epoch = authEpoch.current;
    const current = () => userId && currentUserId.current === userId && authEpoch.current === epoch;
    if (!userId) return;
    setCostLoading(true); setCostError("");
    try { const result = await invoke<{ costs: CostEvent[] }>({ action: "costs", reconcile }); if (current()) setCosts(result.costs); }
    catch (e) { if (current()) setCostError(e instanceof Error ? e.message : "料金履歴を読み込めませんでした"); }
    finally { if (current()) setCostLoading(false); }
  }
  async function completeAnalysisRun(run: ActiveRun, userId: string) {
    if (currentUserId.current !== userId) return;
    if (activePoll.current?.runId === run.runId && activePoll.current.userId === userId) return;
    activePoll.current?.controller.abort();
    const poll = { runId: run.runId, userId, controller: new AbortController() };
    activePoll.current = poll;
    const current = () => activePoll.current === poll && currentUserId.current === userId && !poll.controller.signal.aborted;
    setActiveRun(run); saveActiveRun(userId, run);
    setWorking("analysis"); setPolling(true); setRunNotice(""); setError("");
    try {
      const result = await waitForAnalysis(run.runId, poll.controller.signal, (state) => {
        if (!current()) return;
        setRunState(state);
        if ((state.startedAt && state.startedAt !== run.startedAt) || (state.researchFocus !== undefined && state.researchFocus !== run.researchFocus)) {
          run = { ...run, startedAt: state.startedAt || run.startedAt, researchFocus: state.researchFocus ?? run.researchFocus }; setActiveRun(run); saveActiveRun(userId, run);
        }
      }, (notice) => { if (current()) setRunNotice(notice); });
      if (!current()) return;
      if (result.kind === "done") {
        const report = result.report;
        ++reportRevision.current;
        setReports((items) => [report, ...items.filter((item) => item.id !== report.id)]);
        setSelectedId(report.id); setTab("report"); setResearchExpanded(false);
        clearActiveRun(userId, run.runId); setActiveRun(null); setRunState(null); setRunNotice("");
      } else if (result.kind === "trashed" || result.kind === "deleted") {
        clearActiveRun(userId, run.runId); setActiveRun(null); setRunState(null);
        setRunNotice(result.kind === "trashed" ? "この解析のレポートはゴミ箱に移動されています。" : "この解析のレポートは完全に削除されています。");
        ++reportRevision.current; void refresh(userId, authEpoch.current); void refreshTrash();
      }
      void refreshCosts();
    } catch {
      if (current()) setRunNotice("現在の進行状況を確認できません。解析IDは保存されています。「進行状況を再確認」から続きを確認できます。");
    }
    finally {
      if (current()) { setWorking(null); setPolling(false); activePoll.current = null; }
    }
  }
  useEffect(() => {
    let alive = true, authEventReceived = false;
    const applySession = (nextSession: Session | null) => {
      if (!alive) return;
      setSession(nextSession);
      const nextUserId = nextSession?.user.id ?? null;
      if (nextUserId === currentUserId.current) { if (!nextUserId) setLoading(false); return; }
      currentUserId.current = nextUserId;
      const epoch = ++authEpoch.current;
      ++reportRevision.current; reportMutation.current = false;
      setTrashedReports([]); setTrashCount(0); setTrashCursor(null); setTrashLoading(false); setTrashError(""); setBusyReportId(null); setDeleteTarget(null); setReportNotice(null);
      activePoll.current?.controller.abort(); activePoll.current = null;
      setReports([]); setCosts([]); setSelectedId(null); setActiveRun(null); setRunState(null); setRunNotice(""); setWorking(null); setPolling(false); setRetrying(false); setDiscoveringRun(!!nextUserId); setError("");
      setResearchFocus("");
      if (!nextUserId) { setLoading(false); return; }
      setLoading(true);
      // Leave the synchronous auth callback before invoking authenticated API calls.
      window.setTimeout(() => {
        if (!alive || currentUserId.current !== nextUserId || authEpoch.current !== epoch) return;
        void refresh(nextUserId, epoch);
        void refreshTrash();
        const saved = readActiveRun(nextUserId);
        if (saved) { setDiscoveringRun(false); void completeAnalysisRun(saved, nextUserId); }
        else {
          void invoke<{ run: ActiveRun | null }>({ action: "active_run" }).then(({ run }) => {
            if (!alive || currentUserId.current !== nextUserId || authEpoch.current !== epoch) return;
            if (run && !activePoll.current && !readActiveRun(nextUserId)) void completeAnalysisRun(run, nextUserId);
          }).catch(() => {
            if (alive && currentUserId.current === nextUserId && authEpoch.current === epoch) setRunNotice("別の画面で実行中の解析があるか確認できませんでした。すでに調査を開始している場合は、ページを再読み込みして進行状況をご確認ください。");
          }).finally(() => {
            if (alive && currentUserId.current === nextUserId && authEpoch.current === epoch) setDiscoveringRun(false);
          });
        }
      }, 0);
    };
    void supabase.auth.getSession().then(({ data }) => { if (!authEventReceived) applySession(data.session); });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      authEventReceived = true; applySession(nextSession);
    });
    return () => { alive = false; subscription.unsubscribe(); activePoll.current?.controller.abort(); activePoll.current = null; currentUserId.current = null; authEpoch.current += 1; };
  }, []);

  async function signIn(event: FormEvent) {
    event.preventDefault();
    if (signingIn) return;
    setError(""); setSigningIn(true);
    try {
      const { error: authError } = await supabase.auth.signInWithPassword({ email: loginEmailFromId(loginId), password });
      if (authError) setError(/invalid login credentials/i.test(authError.message) ? "IDまたはパスワードが正しくありません。" : authError.message);
      else setPassword("");
    } catch {
      setError("ログインサーバーに接続できませんでした。通信状態を確認してもう一度お試しください。");
    } finally { setSigningIn(false); }
  }

  async function startAnalysis(event: FormEvent) {
    event.preventDefault();
    const userId = currentUserId.current, epoch = authEpoch.current;
    if (!userId || working || activeRun || discoveringRun) return;
    const selectedSites = [
      ...SITE_OPTIONS.filter((site) => selectedSiteIds.includes(site.id)).map((site) => ({ ...site, url: siteUrls[site.id]?.trim() || "" })),
      ...customSites.filter((site) => site.name.trim() && site.url.trim()).map((site) => ({ ...site, name: site.name.trim(), url: site.url.trim() })),
    ];
    if (!selectedSites.length) { setError("分析対象のグルメサイトを1つ以上選択してください"); return; }
    if (customSites.some((site) => (!!site.name.trim() !== !!site.url.trim()))) { setError("その他のサイトはサイト名とURLの両方を入力してください"); return; }
    const focus = researchFocus.trim();
    if (focus.length > RESEARCH_FOCUS_LIMIT) { setError("特に調べてほしいことは2,000文字以内で入力してください"); return; }
    setWorking("analysis"); setRunState(null); setRunNotice(""); setError("");
    try {
      const started = await invoke<{ runId: string }>({ action: "analyze", storeName, storeUrl, groupName, selectedSites, ...(focus ? { researchFocus: focus } : {}) });
      const run = { runId: started.runId, storeName, startedAt: new Date().toISOString(), researchFocus: focus };
      saveActiveRun(userId, run);
      if (currentUserId.current !== userId || authEpoch.current !== epoch) return;
      await completeAnalysisRun(run, userId);
    } catch (e) { if (currentUserId.current === userId && authEpoch.current === epoch) setError(analysisErrorMessage(e)); }
    finally { if (currentUserId.current === userId && authEpoch.current === epoch) setWorking(null); }
  }
  async function retryAnalysisRun() {
    const userId = currentUserId.current, epoch = authEpoch.current, run = activeRun;
    if (!userId || !run || retrying || working || runState?.status !== "failed") return;
    setRetrying(true); setError(""); setRunNotice("");
    try {
      await invoke<{ runId: string; status: "running" }>({ action: "retry_run", runId: run.runId });
      if (currentUserId.current !== userId || authEpoch.current !== epoch) return;
      setRunState((previous) => previous ? { ...previous, status: "running", error: undefined } : null);
      void completeAnalysisRun(run, userId);
    } catch (failure) {
      if (currentUserId.current === userId && authEpoch.current === epoch) setRunNotice(`再開の結果を確認できませんでした。重複して送信せず「進行状況を再確認」を押してください。${failure instanceof Error ? ` ${failure.message}` : ""}`);
    } finally { if (currentUserId.current === userId && authEpoch.current === epoch) setRetrying(false); }
  }
  function closeFailedAnalysisRun() {
    const userId = currentUserId.current;
    if (!userId || !activeRun || runState?.status !== "failed" || working || polling || retrying || runNotice) return;
    clearActiveRun(userId, activeRun.runId);
    setActiveRun(null); setRunState(null); setRunNotice(""); setError(""); setResearchExpanded(true); setPage("analysis");
  }
  async function submitQuestion(event: FormEvent) {
    event.preventDefault(); if (!selected || !question.trim() || reportMutation.current || working) return;
    const userId = currentUserId.current, epoch = authEpoch.current, reportId = selected.id;
    const current = () => currentUserId.current === userId && authEpoch.current === epoch;
    setWorking("question"); setError("");
    try {
      const result = await invoke<{ followup: Followup }>({ action: "question", reportId, question: question.trim() });
      if (!current()) return;
      setReports((items) => items.map((item) => item.id === reportId ? { ...item, followups: [...item.followups, result.followup] } : item)); setQuestion("");
      void refreshCosts();
    } catch (e) { if (current()) setError(e instanceof Error ? e.message : "回答を取得できませんでした"); }
    finally { if (current()) setWorking(null); }
  }

  const missing = [!health.openai && "OpenAI", !health.gemini && "Gemini", !health.xai && "xAI"].filter(Boolean);
  if (!session) return <main className="auth-screen"><div className="auth-card"><a className="brand auth-brand" href="#top"><span className="brand-mark">R</span><span><b>Restaurant</b><small>INSIGHT STUDIO</small></span></a><span className="eyebrow">PRIVATE RESEARCH WORKSPACE</span><h1>ログイン</h1><p>IDとパスワードでログインします。レポートはアカウントごとに分離して保存されます。</p><form onSubmit={signIn}><label>ID<input required type="text" name="username" autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={loginId} onChange={(e) => setLoginId(e.target.value)} placeholder="ID"/></label><label className="auth-password">パスワード<input required type="password" name="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="パスワード"/></label><button className="primary-button" disabled={signingIn}>{signingIn ? "ログイン中…" : "ログイン"}</button></form>{error && <div className="error-banner">{error}</div>}<small className="auth-security">パスワードはSupabase Authで管理され、このアプリには保存されません。</small></div></main>;
  return <div className="app-shell">
    <aside className="sidebar">
      <a className="brand" href="#top"><span className="brand-mark">R</span><span><b>Restaurant</b><small>INSIGHT STUDIO</small></span></a>
      <div className="side-label">WORKSPACE</div>
      <button className={`side-item ${page === "analysis" ? "active" : ""}`} onClick={() => setPage("analysis")}><span>◉</span>店舗分析</button>
      <button className={`side-item ${page === "costs" ? "active" : ""}`} onClick={() => { setPage("costs"); void refreshCosts(); }}><span>＄</span>API料金</button>
      <button className={`side-item trash-nav ${page === "trash" ? "active" : ""}`} onClick={() => { setPage("trash"); void refreshTrash(); }}><TrashIcon/>ゴミ箱 <span className="trash-nav-count">{trashCount}</span></button>
      {page === "analysis" && <><div className="side-label history-label">保存したレポート <span>{reports.length}</span></div>
      <div className="history-list">
        {reports.map((report) => <div className="history-row" key={report.id}><button onClick={() => { setSelectedId(report.id); setTab("report"); }} className={`history-item ${selected?.id === report.id ? "selected" : ""}`}>
          <b>{report.storeName}</b><small>{dateLabel(report.createdAt)}</small>
        </button><button type="button" className="history-trash" title="ゴミ箱へ移動" aria-label={`${report.storeName} ${reportDate(report.createdAt)}をゴミ箱へ移動`} disabled={!!busyReportId || working === "question"} onClick={() => { void changeReport("trash_report", report); }}><TrashIcon/></button></div>)}
        {!reports.length && <p className="muted history-empty">分析を実行すると、レポートがここに保存されます。</p>}
      </div></>}
      <div className="sidebar-bottom"><span className={`local-dot ${missing.length ? "needs-keys" : ""}`} />SUPABASE PRIVATE DATA<br /><small>利用者ごとに分離して保存</small></div>
    </aside>

    <main id="top" className="main-area">
      <header className="topbar"><div><span className="eyebrow">RESTAURANT INTELLIGENCE</span><h1>{page === "costs" ? "API料金・利用量" : page === "trash" ? "ゴミ箱" : "店舗分析"}</h1></div><div className="account-chip"><span>{displayLoginId(session.user.email)}</span><button onClick={() => void supabase.auth.signOut()}>ログアウト</button></div></header>
      {reportNotice && <div className={`report-action-notice ${reportNotice.uncertain ? "uncertain" : "success"}`} role="status"><span>{reportNotice.text}</span>{reportNotice.uncertain && <button type="button" disabled={!!busyReportId} onClick={() => { const id = currentUserId.current; if (id) void refresh(id, authEpoch.current); void refreshTrash(); }}>一覧を更新</button>}<button type="button" aria-label="通知を閉じる" onClick={() => setReportNotice(null)}>×</button></div>}

      {page === "costs" ? <CostPage key={session.user.id} reports={[...reports, ...trashedReports]} costs={costs} loading={costLoading} error={costError} onRefresh={refreshCosts} /> : page === "trash" ? <TrashPage reports={trashedReports} loading={trashLoading} busy={!!busyReportId || working === "question"} error={trashError} onRestore={(report) => { void changeReport("restore_report", report); }} onDelete={setDeleteTarget} onRefresh={() => { void refreshTrash(); }} hasMore={!!trashCursor} onLoadMore={() => { void refreshTrash(true); }}/> : <div className={`content-grid ${selected ? "has-report" : ""}`}>
        {selected && <div className="research-toolbar"><span>保存済みレポートを表示しています</span><button onClick={() => {
          if (!researchExpanded && selected) {
            setStoreName(selected.storeName); setStoreUrl(selected.storeUrl); setGroupName(selected.groupName ?? "");
            setResearchFocus(selected.researchFocus ?? "");
            const sites = selected.selectedSites ?? [];
            setSelectedSiteIds(sites.filter((site) => SITE_OPTIONS.some((option) => option.id === site.id)).map((site) => site.id));
            setSiteUrls(Object.fromEntries(sites.map((site) => [site.id, site.url])));
            setCustomSites(sites.filter((site) => site.id.startsWith("custom-")));
          }
          setResearchExpanded(!researchExpanded);
        }} aria-expanded={researchExpanded} aria-controls="research-controls">{researchExpanded ? "入力欄を閉じる ↑" : "店舗・条件を指定して新しい分析 ＋"}</button></div>}
        <section id="research-controls" className={`control-column ${selected && !researchExpanded ? "research-collapsed" : ""}`}>
          <form className="panel form-panel" onSubmit={startAnalysis}>
            <div className="panel-kicker">新しいリサーチ</div><h2>調べたいお店を指定</h2>
            <p className="muted form-intro">専門分野の異なる3つのAIが調査し、根拠を確認してひとつの改善レポートにまとめます。</p>
            <label>店舗名<input required value={storeName} onChange={(e) => setStoreName(e.target.value)} placeholder="例：マルゴ四谷" /></label>
            <label>店舗の公式サイト・基準URL<input required type="url" value={storeUrl} onChange={(e) => setStoreUrl(e.target.value)} placeholder="https://..." /></label>
            <label>グループ名 <span className="optional">任意</span><input value={groupName} onChange={(e) => setGroupName(e.target.value)} placeholder="系列店も比較します" /></label>
            <div className="research-focus-field">
              <label htmlFor="research-focus">特に調べてほしいこと <span className="optional">任意</span></label>
              <p id="research-focus-help">重点的に確認したい点や、解決したい課題を自由に書いてください。空欄なら、通常どおり総合的に分析します。</p>
              <textarea id="research-focus" value={researchFocus} onChange={(e) => setResearchFocus(e.target.value)} rows={5} maxLength={RESEARCH_FOCUS_LIMIT} disabled={working === "analysis" || !!activeRun} aria-describedby="research-focus-help research-focus-count" placeholder={"例：平日ディナーの集客を重点的に調べたい。\n近隣店とコース内容・価格を比較し、食べログの写真や紹介文の改善案まで提案してほしい。"}/>
              <div className="research-focus-footer"><span>各AIの調査・反証・統合に反映します</span><span id="research-focus-count">{researchFocus.length.toLocaleString()} / 2,000</span></div>
              {researchFocus && <button type="button" className="clear-focus" disabled={working === "analysis" || !!activeRun} onClick={() => setResearchFocus("")}>指定をクリアして通常の分析に戻す</button>}
            </div>
            <details className="site-picker">
              <summary className="site-picker-summary"><span><b>分析するグルメサイト</b><small>{selectedSiteNames.length}件選択中{selectedSiteSummary ? `　${selectedSiteSummary}` : ""}</small></span><span className="accordion-chevron" aria-hidden="true">⌄</span></summary>
              <p>選んだサイトごとに調査します。店舗ページURLを指定すると対象を絞れます。</p>
              <div className="site-options">
                {SITE_OPTIONS.map((site) => {
                  const checked = selectedSiteIds.includes(site.id);
                  return <div className={`site-option ${checked ? "checked" : ""}`} key={site.id}>
                    <label className="site-check"><input type="checkbox" checked={checked} onChange={() => setSelectedSiteIds((ids) => checked ? ids.filter((id) => id !== site.id) : [...ids, site.id])}/><span className="checkmark">✓</span><span><b>{site.name}</b><small>{site.hint}</small></span></label>
                    {checked && <input className="site-url" type="url" aria-label={`${site.name}の店舗URL`} placeholder={`${site.name}の店舗ページURL（任意）`} value={siteUrls[site.id] ?? ""} onChange={(e) => setSiteUrls((urls) => ({ ...urls, [site.id]: e.target.value }))}/>}
                  </div>;
                })}
                {customSites.map((site) => <div className="site-option checked" key={site.id}><div className="custom-site-fields"><input aria-label="サイト名" placeholder="サイト名" value={site.name} onChange={(e) => setCustomSites((rows) => rows.map((row) => row.id === site.id ? { ...row, name: e.target.value } : row))}/><button type="button" aria-label="削除" onClick={() => setCustomSites((rows) => rows.filter((row) => row.id !== site.id))}>×</button></div><input className="site-url" type="url" placeholder="店舗ページURL" value={site.url} onChange={(e) => setCustomSites((rows) => rows.map((row) => row.id === site.id ? { ...row, url: e.target.value } : row))}/></div>)}
              </div>
              <button className="add-site" type="button" onClick={() => setCustomSites((rows) => [...rows, { id: `custom-${Date.now()}`, name: "", url: "" }])}>＋ その他のグルメサイトを追加</button>
            </details>
            <div className="research-roles">
              <div><span className="role-icon market">M</span><span><b>市場・競合</b><small>GPT-6.1 Terra · Web調査</small></span></div>
              <div><span className="role-icon gourmet">G</span><span><b>グルメ媒体</b><small>Gemini · Google Search</small></span></div>
              <div><span className="role-icon social">X</span><span><b>SNS・Xの声</b><small>Grok · X Search</small></span></div>
            </div>
            <button className="primary-button" disabled={!!working || !!activeRun || discoveringRun || (!selectedSiteIds.length && !customSites.length)}>{working === "analysis" ? <><i className="spinner" />専門AIが調査しています</> : discoveringRun ? "実行中の解析を確認しています" : activeRun ? "進行中の解析を確認してください" : "選択したサイトを分析　↗"}</button>
            <div className="privacy-note">公開情報を対象に調査します。AI APIキーはSupabase Edge Functionからのみ利用します。</div>
          </form>
          <div className="panel process-panel"><div className="panel-kicker">調査の進め方</div><div className="process-step"><i>01</i><div><b>分野別に調査</b><small>3つのAIがそれぞれ独立して検索</small></div></div><div className="process-step"><i>02</i><div><b>相互に検証</b><small>矛盾・反証・未確認を整理</small></div></div><div className="process-step"><i>03</i><div><b>統合レポート</b><small>出典付きの優先施策にまとめる</small></div></div></div>
        </section>

        <section className="result-column">
          {missing.length > 0 && <div className="config-banner"><b>AI APIキーの設定が必要です</b><span>{missing.join("・")}のキーをSupabase DashboardのEdge Functions → Secretsに登録してください。キーはDBテーブルやブラウザーには保存しません。</span></div>}
          {error && <div className="error-banner"><b>処理を完了できませんでした</b><span>{error}</span></div>}
          {!activeRun && runNotice && <div className="run-connection-notice" role="status">{runNotice}</div>}
          {activeRun && <RunProgress run={activeRun} state={runState} polling={polling} retrying={retrying} busy={working === "question"} notice={runNotice} onRetry={() => { void retryAnalysisRun(); }} onCheck={() => { const userId = currentUserId.current; if (userId && !working) void completeAnalysisRun(activeRun, userId); }} onClose={closeFailedAnalysisRun}/>}
          {working === "analysis" && !activeRun && <div className="panel live-progress"><div className="spinner large"/><div><b>調査の開始を確認しています</b><span>解析が登録されると、各調査の進行状況を表示します。</span></div></div>}
          {selected ? <>
            <section className="report-heading panel"><div><span className="eyebrow">ANALYSIS REPORT · {dateLabel(selected.createdAt)}</span><h2>{selected.storeName}</h2><a href={selected.storeUrl} target="_blank" rel="noreferrer">{selected.storeUrl} ↗</a><div className="selected-site-tags">{(selected.selectedSites ?? []).map((site) => <span key={site.id}>{site.name}</span>)}</div></div><div className="report-header-actions"><span className={`complete-badge ${selected.agents.some((agent) => agent.status !== "done") ? "partial-badge" : ""}`}><i/>{selected.agents.some((agent) => agent.status !== "done") ? "一部の調査が未完了" : "レポート作成完了"}</span><div className="report-action-buttons"><button type="button" onClick={() => window.print()}>印刷・PDF保存</button><button type="button" className="report-trash-button" disabled={!!busyReportId || working === "question"} onClick={() => { void changeReport("trash_report", selected); }}><TrashIcon/>ゴミ箱へ移動</button></div></div></section>
            <ResearchFocusNote text={selected.researchFocus}/>
            {selected.agents.some((agent) => agent.status !== "done") && <div className="coverage-notice"><b>取得範囲が限られた調査があります</b><p>{selected.agents.filter((agent) => agent.status !== "done").map((agent) => agentTitle(agent.id)).join("・")}の専門調査は一部取得または取得失敗となりました。詳細な取得状況は「専門AIの調査」に表示します。このレポートの判断は、確認できた情報の範囲に限られます。</p></div>}
            <nav className="tabs">{([["report","統合レポート"],["agents","専門AIの調査"],["critique","反証・確認事項"]] as [Tab,string][]).map(([id,label]) => <button key={id} onClick={() => setTab(id)} className={tab === id ? "current" : ""}>{label}</button>)}</nav>
            {tab === "report" && <article className="panel report-panel"><IntegratedReport text={selected.report}/><details className="sources-block"><summary>統合レポートの参照URLを見る</summary><p className="muted small">各主張の根拠と確認範囲は本文に記載しています。URLがあるだけで、ページ全文の取得や事実の正しさを保証するものではありません。</p><SourceLinks sources={selected.reportSources}/></details></article>}
            {tab === "agents" && <div className="agent-stack">{selected.agents.map((agent) => <article className="panel agent-panel" key={agent.id}><header><div className={`role-icon ${agent.id === "market" ? "market" : agent.id === "gourmet" ? "gourmet" : "social"}`}>{agent.id.startsWith("social") ? "X" : agent.id[0].toUpperCase()}</div><div><b>{agentTitle(agent.id)}</b><small>{agent.provider}</small></div><span className={`agent-state ${agent.status}`}>{agent.status === "done" ? "応答取得済み" : agent.status === "partial" ? "一部取得" : "取得失敗"}</span></header>{agent.error ? <p className="agent-error">{agent.error}</p> : <TextPanel text={agent.text}/>}<details className="sources-block"><summary>担当AIが検索・参照したURL</summary><p className="muted small">検索候補や閲覧できなかったページも含まれます。採用した根拠は調査本文を確認してください。</p><SourceLinks sources={agent.sources}/></details></article>)}</div>}
            {tab === "critique" && <article className="panel report-panel"><div className="panel-kicker">FACT CHECK</div><h3>統合担当による反証・根拠の照合</h3><p className="muted small">専門AIの調査を照合し、採用・修正・保留した判断と理由を示します。同じ資料の転載や同じモデルによる再確認は、独立した証拠として数えません。</p><TextPanel text={selected.critique}/><div className="sources-block"><b>検証時の参照URL</b><SourceLinks sources={selected.critiqueSources}/></div></article>}
            <section className="panel qa-panel"><div className="qa-heading"><div><span className="panel-kicker">REPORT FOLLOW-UP</span><h3>レポートに質問する</h3></div><span>この調査結果を引き継いで回答</span></div>
              <div className="conversation">{selected.followups.map((item,index) => <div className="qa-pair" key={`${item.at}-${index}`}><div className="question-bubble">{item.question}</div><div className="answer-bubble"><TextPanel text={item.answer}/><SourceLinks sources={item.sources}/></div></div>)}</div>
              <form className="question-form" onSubmit={submitQuestion}><input value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="施策の根拠や優先順位を質問…"/><button disabled={!!working || !!busyReportId || !question.trim()}>{working === "question" ? <i className="spinner"/> : "送信　↗"}</button></form>
            </section>
          </> : <div className="empty-state panel">{loading ? <><i className="spinner large"/><h2>保存済みレポートを読み込んでいます</h2></> : <><div className="empty-icon">✳</div><h2>お店の次の一手を、根拠から。</h2><p>店舗情報を入力して調査を始めると、専門AIの調査・反証・統合結果がここに表示されます。</p></>}</div>}
          <footer className="disclaimer">Web・SNS上で確認できる範囲の調査結果です。非公開情報や検索対象外の情報は含まれません。数値や営業情報は、実行前に必ず公式情報でご確認ください。</footer>
        </section>
      </div>}
    </main>
    {deleteTarget && <DeleteReportDialog report={deleteTarget} busy={!!busyReportId} onCancel={() => setDeleteTarget(null)} onConfirm={() => { void changeReport("delete_report", deleteTarget); }}/>}
  </div>;
}
