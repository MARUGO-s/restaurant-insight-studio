import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "./lib/api";
import "./report-share-controls.css";

type ShareAction = "report_share_status" | "create_report_share" | "revoke_report_share";
type ShareResponse = { token: string | null };
const STATUS: ShareAction = "report_share_status";
const CREATE: ShareAction = "create_report_share";
const REVOKE: ShareAction = "revoke_report_share";
const TOKEN = /^[a-f0-9]{64}$/;

function shareUrl(token: string) {
  const base = new URL(import.meta.env.BASE_URL, window.location.origin);
  const url = new URL("report.html", base);
  url.hash = token;
  return url.href;
}

function ShareDialog({ reportId, storeName, onClose }: { reportId: string; storeName: string; onClose: () => void }) {
  const titleId = useId(), descriptionId = useId(), inputId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const urlInput = useRef<HTMLInputElement>(null);
  const requestVersion = useRef(0);
  const [share, setShare] = useState<ShareResponse>();
  const [pending, setPending] = useState<ShareAction | null>(STATUS);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const request = useCallback(async (action: ShareAction) => {
    const version = ++requestVersion.current;
    setPending(action);
    setError("");
    setNotice("");
    try {
      const result = await invoke<ShareResponse>({ action, reportId });
      if (requestVersion.current !== version) return;
      const { token } = result;
      const validToken = typeof token === "string" && TOKEN.test(token);
      if ((token !== null && !validToken) || (action === CREATE && !validToken) || (action === REVOKE && token !== null)) {
        throw new Error("Invalid report share response");
      }
      setShare({ token });
      if (action === CREATE) setNotice("共有リンクを発行しました。");
      if (action === REVOKE) setNotice("共有を停止しました。");
    } catch {
      if (requestVersion.current !== version) return;
      setShare(undefined);
      setError(action === STATUS ? "共有の状態を確認できませんでした。" : "操作の結果を確認できませんでした。共有の状態を再確認してください。");
    } finally {
      if (requestVersion.current === version) setPending(null);
    }
  }, [reportId]);

  useEffect(() => {
    const element = dialog.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    element?.showModal();
    void request(STATUS);
    return () => {
      ++requestVersion.current;
      element?.close();
      if (previous?.isConnected) previous.focus();
    };
  }, [request]);

  const url = share?.token ? shareUrl(share.token) : "";
  const changing = pending === CREATE || pending === REVOKE;
  async function copy() {
    if (!url) return;
    const version = requestVersion.current;
    try {
      await navigator.clipboard.writeText(url);
      if (requestVersion.current === version) setNotice("共有URLをコピーしました。");
    } catch {
      if (requestVersion.current !== version) return;
      urlInput.current?.focus();
      urlInput.current?.select();
      setNotice("共有URLを選択しました。選択したURLをコピーしてください。");
    }
  }

  return <dialog ref={dialog} className="delete-report-dialog report-share-dialog" aria-labelledby={titleId} aria-describedby={descriptionId} onCancel={(event) => {
    event.preventDefault();
    if (!changing) onClose();
  }}>
    <h2 id={titleId}>レポートの共有リンク</h2>
    <div className="delete-report-target"><b>{storeName}</b></div>
    <p id={descriptionId}>リンクを知っている人は、ログインなしでこの統合レポートを閲覧できます。</p>
    {pending && <p className="report-share-status" role="status">{pending === STATUS ? "共有の状態を確認しています…" : pending === CREATE ? "共有リンクを発行しています…" : "共有を停止しています…"}</p>}
    {!pending && error && <p className="report-share-error" role="alert">{error}</p>}
    {!pending && notice && <p className="report-share-status" role="status">{notice}</p>}
    {!pending && url && <div className="report-share-link">
      <label htmlFor={inputId}>共有URL</label>
      <input id={inputId} ref={urlInput} type="text" readOnly value={url} spellCheck={false} autoComplete="off"/>
      <div className="report-share-link-actions"><button type="button" className="secondary-button" onClick={() => { void copy(); }}>URLをコピー</button><a href={url} target="_blank" rel="noreferrer">閲覧ページを開く ↗</a></div>
    </div>}
    <div className="delete-dialog-actions">
      <button type="button" className="secondary-button" autoFocus disabled={changing} onClick={onClose}>閉じる</button>
      {!pending && (url
        ? <button type="button" className="danger-outline" onClick={() => { void request(REVOKE); }}>共有を停止</button>
        : share
        ? <button type="button" className="primary-button" onClick={() => { void request(CREATE); }}>共有リンクを発行</button>
        : <button type="button" className="secondary-button" onClick={() => { void request(STATUS); }}>状態を再確認</button>)}
    </div>
  </dialog>;
}

export function ReportShareControls({ reportId, storeName, disabled }: { reportId: string; storeName: string; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" aria-haspopup="dialog" disabled={disabled} onClick={() => setOpen(true)}>共有リンク</button>
    {open && createPortal(<ShareDialog reportId={reportId} storeName={storeName} onClose={() => setOpen(false)}/>, document.body)}
  </>;
}
