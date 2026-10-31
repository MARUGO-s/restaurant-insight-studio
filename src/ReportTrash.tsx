import { useEffect, useRef } from "react";

export type TrashItem = { id: string; storeName: string; createdAt: string; deletedAt?: string | null; researchFocus?: string };
export function TrashIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/></svg>;
}
export const reportDate = (value: string) => new Date(value).toLocaleString("ja-JP", { dateStyle: "medium", timeStyle: "short" });

export function TrashPage({ reports, loading, busy, error, onRestore, onDelete, onRefresh, hasMore, onLoadMore }: {
  reports: TrashItem[]; loading: boolean; busy: boolean; error: string;
  onRestore: (report: TrashItem) => void; onDelete: (report: TrashItem) => void; onRefresh: () => void;
  hasMore: boolean; onLoadMore: () => void;
}) {
  return <section className="trash-page">
    <header className="trash-page-heading"><div><span className="eyebrow">REPORT TRASH</span><h2>ゴミ箱</h2><p>ここから復元できます。完全削除するまで保管されます。</p></div><button type="button" className="secondary-button" disabled={loading || busy} onClick={onRefresh}>一覧を更新</button></header>
    <p className="trash-guidance">完全削除すると、レポート・質問履歴・保存された調査結果は元に戻せません。API料金の履歴は残ります。</p>
    {error && <div className="report-action-notice uncertain" role="status">{error}</div>}
    {loading && !reports.length ? <div className="panel trash-empty"><i className="spinner"/><p>ゴミ箱を読み込んでいます…</p></div> : !reports.length ? <div className="panel trash-empty"><TrashIcon/><h3>ゴミ箱は空です</h3><p>保存レポートの「ゴミ箱へ移動」で、ここに移せます。</p></div> : <div className="trash-list">{reports.map((report) => <article className="panel trash-card" key={report.id}>
      <div className="trash-card-info"><h3>{report.storeName}</h3><p>作成：{reportDate(report.createdAt)}</p>{report.deletedAt && <p>ゴミ箱へ移動：{reportDate(report.deletedAt)}</p>}{report.researchFocus && <p className="trash-focus">重点事項：{report.researchFocus}</p>}</div>
      <div className="trash-card-actions"><button type="button" className="secondary-button" disabled={busy} onClick={() => onRestore(report)} aria-label={`${report.storeName} ${reportDate(report.createdAt)}を復元`}>復元する</button><button type="button" className="danger-outline" disabled={busy} onClick={() => onDelete(report)} aria-label={`${report.storeName} ${reportDate(report.createdAt)}を完全削除`}>完全に削除</button></div>
    </article>)}</div>}
    {hasMore && <button type="button" className="secondary-button trash-more" disabled={loading || busy} onClick={onLoadMore}>{loading ? "読み込み中…" : "さらに表示"}</button>}
  </section>;
}

export function DeleteReportDialog({ report, busy, onCancel, onConfirm }: { report: TrashItem; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = ref.current; dialog?.showModal();
    return () => { dialog?.close(); if (previous?.isConnected) previous.focus(); };
  }, []);
  return <dialog ref={ref} className="delete-report-dialog" aria-labelledby="delete-report-title" aria-describedby="delete-report-description" onCancel={(event) => { event.preventDefault(); if (!busy) onCancel(); }}>
    <span className="delete-dialog-icon"><TrashIcon/></span><h2 id="delete-report-title">レポートを完全に削除しますか？</h2>
    <div className="delete-report-target"><b>{report.storeName}</b><span>{reportDate(report.createdAt)} 作成</span></div>
    <p id="delete-report-description">レポート・質問履歴・保存された調査結果が削除され、復元できなくなります。API料金の履歴は残ります。</p>
    <div className="delete-dialog-actions"><button type="button" className="secondary-button" autoFocus disabled={busy} onClick={onCancel}>キャンセル</button><button type="button" className="danger-button" disabled={busy} onClick={onConfirm}>{busy ? "削除を確認しています…" : "完全に削除する"}</button></div>
  </dialog>;
}
