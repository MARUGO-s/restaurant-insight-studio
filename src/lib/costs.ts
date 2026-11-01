type FeeRecord = {
  request_status: string; measurement_status: string; list_price_usd: number | null;
  usage: Record<string, number | null>;
  request_metadata?: { http_status?: number | null; duration_ms?: number; timeout_ms?: number; request_phase?: string;
    transport_error?: string; reconciliation_status?: string };
};

export function costExplanation(event: FeeRecord): { label: string; reason: string } {
  const m = event.request_metadata ?? {};
  if (event.list_price_usd != null) return { label: event.request_status === "failed" ? "APIで失敗" : "利用量を計測",
    reason: m.reconciliation_status === "recovered" ? "保存済みの応答から利用量を再取得しました。" : "" };
  if (["sent", "receiving"].includes(m.request_phase ?? "")) return { label: "料金未確定", reason: "最終利用量の記録を確認できていません。処理中、または処理が中断した可能性があります。" };
  let reason: string;
  if ((m.transport_error && /timeout|timed out/i.test(m.transport_error)) || (m.timeout_ms && (m.duration_ms ?? 0) >= m.timeout_ms)) {
    reason = "応答待ちの上限に達し、最終利用量を取得できませんでした。";
  } else if (event.request_status === "unknown" && m.http_status === 200) {
    reason = "APIとの通信は始まりましたが、完了通知と最終利用量を確認できませんでした。";
  } else if (event.request_status === "unknown") {
    reason = "通信または記録が中断し、APIの処理結果と最終利用量を確認できませんでした。";
  } else if (event.request_status === "failed") {
    reason = "APIの処理が失敗し、課金対象の利用量を確認できませんでした。";
  } else if (event.usage.input_tokens == null || event.usage.output_tokens == null) {
    reason = "APIの応答に料金計算に必要なトークン数が揃っていません。";
  } else {
    reason = "検索の利用件数またはモデルの単価を確認できませんでした。";
  }
  if (["not_found", "usage_missing"].includes(m.reconciliation_status ?? "")) reason += " 保存済みの応答からも利用量を取得できませんでした。";
  else if (m.reconciliation_status === "unavailable") reason += " 提供元への再確認は一時的にできませんでした。";
  else if (m.reconciliation_status === "pending") reason += " 提供元では処理結果がまだ確定していません。";
  return { label: "料金未確定", reason: `${reason} 0ドルとは限りません。` };
}
