import { useEffect, useRef } from "react";
import { groupReportsByStore, storeIdentityKey } from "./lib/store-identity";

export type MergeReport = {
  id: string;
  storeName: string;
  storeUrl?: string | null;
  source?: string;
  shared?: boolean;
  createdAt: string;
};

function isMergedReport(report: { source?: string }) {
  return report.source === "merged";
}

function isSharedReport(report: { source?: string; shared?: boolean }) {
  return report.shared === true || report.source === "gourmet_checker";
}

function reportKind(report: { source?: string; shared?: boolean }) {
  if (isMergedReport(report)) return "merged" as const;
  if (isSharedReport(report)) return "checker" as const;
  return "app" as const;
}

function SourceBadge({ report }: { report: MergeReport }) {
  const kind = reportKind(report);
  const label = kind === "merged" ? "統合版" : kind === "checker" ? "Grok Bot" : "アプリ分析";
  return <span className={`source-badge source-badge-${kind}`}>{label}</span>;
}

function dateLabel(value: string) {
  return new Date(value).toLocaleString("ja-JP", { dateStyle: "medium", timeStyle: "short" });
}

type MergeDialogProps = {
  reports: MergeReport[];
  selectedIds: string[];
  confirmMixedStores: boolean;
  busy?: boolean;
  onToggle: (id: string) => void;
  onSelectGroup: (ids: string[]) => void;
  onConfirmMixedChange: (checked: boolean) => void;
  onClose: () => void;
  onStart: () => void;
};

export function MergeDialog({
  reports,
  selectedIds,
  confirmMixedStores,
  busy,
  onToggle,
  onSelectGroup,
  onConfirmMixedChange,
  onClose,
  onStart,
}: MergeDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previous?.focus?.();
    };
  }, [onClose]);

  const groups = groupReportsByStore(reports);
  const autoGroups = groups.filter((group) => group.reports.filter((report) => !isMergedReport(report)).length >= 2);
  const chosen = reports.filter((report) => selectedIds.includes(report.id));
  const mixed = new Set(chosen.map((report) => storeIdentityKey(report.storeName, report.storeUrl ?? ""))).size > 1;

  return (
    <div className="merge-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div
        className="panel form-panel merge-panel merge-dialog"
        id="merge-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="merge-dialog-title"
        tabIndex={-1}
        ref={dialogRef}
      >
        <header className="merge-dialog-head">
          <div>
            <span className="panel-kicker">MERGE REPORTS</span>
            <h2 id="merge-dialog-title">同じ店舗のレポートを統合</h2>
          </div>
          <button type="button" className="text-button" onClick={onClose}>閉じる</button>
        </header>
        <p className="form-intro muted">いま開いているタブに関係なく、見えるレポート（自分のアプリ分析と Grok Bot の共有レポート）を突き合わせ、gpt-6.2-astra で1本の「統合版」に作り直します。結果は自分だけが閲覧・質問・削除できます。</p>
        {!autoGroups.length && (
          <p className="merge-empty-note" role="status">同じ店舗として自動でまとめられるレポートは見つかりませんでした。下の一覧から任意のレポートを2件以上選ぶと統合できます。</p>
        )}
        {groups.length ? groups.map((group) => (
          <div className="merge-group" key={group.key}>
            <div className="merge-group-head">
              <b>{group.storeName}</b>
              <span>{group.reports.length}件</span>
              {group.reports.length >= 2 && (
                <button type="button" className="text-button" onClick={() => onSelectGroup(group.reports.map((report) => report.id))}>この店舗を選ぶ</button>
              )}
            </div>
            {group.reports.map((report) => {
              const checked = selectedIds.includes(report.id);
              return (
                <label className="merge-option" key={report.id}>
                  <input type="checkbox" checked={checked} onChange={() => onToggle(report.id)} />
                  <span className="merge-option-body">
                    <span className="merge-option-title">{report.storeName}<SourceBadge report={report} /></span>
                    <small>{dateLabel(report.createdAt)}</small>
                  </span>
                </label>
              );
            })}
          </div>
        )) : <p className="muted history-empty">統合できるレポートがまだありません。</p>}
        {mixed && (
          <label className="merge-mixed">
            <input type="checkbox" checked={confirmMixedStores} onChange={(event) => onConfirmMixedChange(event.target.checked)} />
            異なる店舗のレポートを含めて統合することを確認しました
          </label>
        )}
        <button type="button" className="primary-button" disabled={!!busy || selectedIds.length < 2 || (mixed && !confirmMixedStores)} onClick={onStart}>
          {`選んだ${selectedIds.length}件を統合する`}
        </button>
      </div>
    </div>
  );
}
