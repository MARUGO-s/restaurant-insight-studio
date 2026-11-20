import { useEffect, useState, type MouseEvent } from "react";
import { IntegratedReport, SourceLinks } from "./ReportView";

export type SharedReport = {
  storeName: string;
  createdAt: string;
  report: string;
  reportSources: string[];
};

export function shareTokenFromFragment(fragment: string) {
  return /^#[a-f0-9]{64}$/.test(fragment) ? fragment.slice(1) : null;
}

export async function loadSharedReport(baseUrl: string, token: string, signal: AbortSignal): Promise<SharedReport | null> {
  const url = new URL("/functions/v1/restaurant-report-share", baseUrl);
  const response = await fetch(url, {
    headers: { "X-Report-Share-Token": token },
    credentials: "omit",
    redirect: "error",
    cache: "no-store",
    referrerPolicy: "no-referrer",
    signal,
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("Shared report unavailable");
  const data: unknown = await response.json();
  if (!data || typeof data !== "object") throw new Error("Invalid report response");
  const { storeName, createdAt, report, reportSources } = data as Partial<SharedReport>;
  if (typeof storeName !== "string" || typeof createdAt !== "string" || !Number.isFinite(Date.parse(createdAt)) ||
    typeof report !== "string" || !report.trim() || !Array.isArray(reportSources) || !reportSources.every((value) => typeof value === "string")) {
    throw new Error("Invalid report response");
  }
  return { storeName, createdAt, report, reportSources };
}

function followReportSection(event: MouseEvent<HTMLElement>) {
  const link = event.target instanceof Element && event.target.closest('a[href^="#report-"]');
  const href = link && link.getAttribute("href");
  if (!href) return;
  const section = document.getElementById(href.slice(1));
  if (!section || !event.currentTarget.contains(section)) return;
  event.preventDefault();
  // The fragment holds the capability. Scroll without replacing it.
  section.tabIndex = -1;
  section.focus({ preventScroll: true });
  section.scrollIntoView();
}

export function SharedReportDocument({ data }: { data: SharedReport }) {
  const date = new Intl.DateTimeFormat("ja-JP", { dateStyle: "long", timeStyle: "short", timeZone: "Asia/Tokyo" });
  return <main className="shared-report" onClick={followReportSection}>
    <header className="shared-report-header">
      <p>店舗分析レポート</p>
      <h1>{data.storeName}</h1>
      <time dateTime={data.createdAt}>{date.format(new Date(data.createdAt))} 作成</time>
    </header>
    <article className="panel report-panel">
      <IntegratedReport text={data.report}/>
      {!!data.reportSources.length && <details className="sources-block">
        <summary>レポートの参照URLを見る</summary><SourceLinks sources={data.reportSources}/>
      </details>}
    </article>
  </main>;
}

type ViewState = { status: "loading" | "unavailable" | "error" } | { status: "ready"; report: SharedReport };

export function SharedReportPage({ baseUrl, token }: { baseUrl: string; token: string | null }) {
  const [state, setState] = useState<ViewState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => { controller.abort(); setState({ status: "error" }); }, 15_000);
    void loadSharedReport(baseUrl, token, controller.signal).then((report) => {
      if (controller.signal.aborted) return;
      if (report) document.title = `${report.storeName} | 店舗分析レポート`;
      setState(report ? { status: "ready", report } : { status: "unavailable" });
    }, () => { if (!controller.signal.aborted) setState({ status: "error" }); }).finally(() => window.clearTimeout(timeout));
    return () => { window.clearTimeout(timeout); controller.abort(); };
  }, [baseUrl, token, attempt]);

  if (state.status === "ready" && token) return <SharedReportDocument data={state.report}/>;
  return <main className="shared-report shared-report-message">
    <h1>店舗分析レポート</h1>
    {!token || state.status === "unavailable" ? <p role="status">この共有リンクではレポートを閲覧できません。</p>
      : state.status === "error" ? <>
        <p role="alert">接続できませんでした。時間をおいてもう一度お試しください。</p>
        <button type="button" onClick={() => { setState({ status: "loading" }); setAttempt(attempt + 1); }}>再読み込み</button>
      </> : <p role="status">レポートを読み込んでいます。</p>}
  </main>;
}
