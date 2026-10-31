import { useEffect, useRef, useState } from "react";
import { invoke } from "./lib/api";

export type ProviderDiagnosticError = {
  http_status: number;
  code?: number;
  status?: string;
  violations?: { quotaMetric?: string; quotaId?: string; quotaValue?: string | number; model?: string; location?: string }[];
  reasons?: { reason?: string; consumer?: string }[];
  retry_after_seconds?: number;
};
type GeminiDiagnostic = {
  configured: boolean;
  model: string;
  ok: boolean;
  keySuffix?: string;
  error?: string;
  diagnostics?: ProviderDiagnosticError;
  costId?: string;
  partial?: boolean;
  searchSources?: number;
};

export function ProviderErrorDetails({ error }: { error: ProviderDiagnosticError }) {
  const violations = Array.isArray(error.violations) ? error.violations : [];
  const reasons = Array.isArray(error.reasons) ? error.reasons : [];
  return <div className="provider-error-details">
    <dl><dt>HTTP応答</dt><dd>{error.http_status}{error.status ? ` · ${error.status}` : ""}</dd>
      {error.retry_after_seconds !== undefined && <><dt>Googleが指定した待機</dt><dd>{error.retry_after_seconds}秒</dd></>}
    </dl>
    {violations.map((violation, index) => <dl key={index}>
      {violation.quotaMetric && <><dt>制限の指標</dt><dd>{violation.quotaMetric}</dd></>}
      {violation.quotaId && <><dt>制限の種類</dt><dd>{violation.quotaId}</dd></>}
      {violation.quotaValue !== undefined && <><dt>上限</dt><dd>{violation.quotaValue}</dd></>}
      {violation.model && <><dt>対象モデル</dt><dd>{violation.model}</dd></>}
      {violation.location && <><dt>地域</dt><dd>{violation.location}</dd></>}
    </dl>)}
    {reasons.map((reason, index) => <dl key={`reason-${index}`}>
      {reason.reason && <><dt>理由</dt><dd>{reason.reason}</dd></>}
      {reason.consumer && <><dt>対象プロジェクト</dt><dd>{reason.consumer}</dd></>}
    </dl>)}
  </div>;
}

export function GeminiConnectionCheck({ onRefresh }: { onRefresh: () => Promise<void> }) {
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<GeminiDiagnostic | null>(null);
  const [failure, setFailure] = useState("");
  const [checkedAt, setCheckedAt] = useState("");
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function checkConnection() {
    if (inFlight.current) return;
    inFlight.current = true; setChecking(true); setFailure(""); setResult(null);
    try {
      const response = await invoke<GeminiDiagnostic>({ action: "diagnose_gemini" });
      if (!mounted.current) return;
      setResult(response);
      setCheckedAt(new Date().toLocaleString("ja-JP", { dateStyle: "medium", timeStyle: "medium" }));
    } catch (error) {
      if (mounted.current) setFailure(error instanceof Error ? error.message : "接続確認の結果を取得できませんでした");
    } finally {
      inFlight.current = false;
      if (mounted.current) { setChecking(false); void onRefresh(); }
    }
  }
  return <article className="panel cost-section provider-check" aria-label="Gemini接続確認">
    <header><div><span className="panel-kicker">PROVIDER CONNECTION</span><h3>Gemini接続確認</h3></div><button className="secondary-button" type="button" disabled={checking} onClick={() => { void checkConnection(); }}>{checking ? "確認中…" : "Geminiの接続を確認"}</button></header>
    <p>調査と同じAPIキー・モデルで、Google Searchを有効にした短いリクエストを送ります。少量のAPI料金が発生する場合があり、下の明細に記録します。確認は1分に1回までです。</p>
    <div role="status" aria-live="polite">
      {checking && <p className="provider-check-pending">Geminiの応答を確認しています…</p>}
      {failure && <div className="error-banner">{failure}</div>}
      {result && <div className={`provider-check-result ${result.ok ? "success" : "failure"}`}>
        <b>{result.ok ? "Geminiが応答しました" : result.configured ? "Geminiへの接続を確認できませんでした" : "GeminiのAPIキーが設定されていません"}</b>
        <p>{result.model} · {checkedAt}{result.keySuffix ? ` · 使用キー末尾 ${result.keySuffix}` : ""}</p>
        {result.ok && <p>このモデルへの接続確認に成功しました。実調査の進行状況は「店舗分析」で確認できます。</p>}
        {result.error && <p className="provider-check-error">{result.error}</p>}
        {result.diagnostics && <ProviderErrorDetails error={result.diagnostics}/>}
      </div>}
    </div>
    <nav className="provider-check-links" aria-label="Geminiの利用状況を確認"><a href="https://aistudio.google.com/api-keys" target="_blank" rel="noreferrer">APIキーのプロジェクト ↗</a><a href="https://aistudio.google.com/rate-limit" target="_blank" rel="noreferrer">モデル別の利用枠 ↗</a><a href="https://aistudio.google.com/billing" target="_blank" rel="noreferrer">請求・クレジット ↗</a></nav>
  </article>;
}
