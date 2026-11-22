import { useEffect, useMemo, useState, type FormEvent } from "react";
import { supabase } from "./lib/supabase";
import {
  REFERENCE_CATEGORIES,
  REFERENCE_CONTENT_MAX,
  REFERENCE_SITE_OPTIONS,
  categoryLabel,
  extractReferenceText,
  siteLabels,
  type ReferenceCategory,
  type ReferenceFile,
} from "./lib/reference-files";

const EMPTY_FORM = {
  title: "",
  description: "",
  category: "ng_words" as ReferenceCategory,
  targetSites: ["all"] as string[],
  content: "",
  filename: "",
};

export function ReferenceFilesPage({ userId }: { userId: string }) {
  const [files, setFiles] = useState<ReferenceFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [fileError, setFileError] = useState("");
  const [pendingDelete, setPendingDelete] = useState<ReferenceFile | null>(null);

  const selected = files.find((file) => file.id === selectedId) ?? null;
  const activeCount = useMemo(() => files.filter((file) => file.is_active).length, [files]);

  async function refresh() {
    setLoading(true);
    setError("");
    const { data, error: loadError } = await supabase
      .from("restaurant_insight_reference_files")
      .select("id,title,description,category,target_sites,content,original_filename,mime,byte_size,is_active,created_by,created_at,updated_at")
      .order("updated_at", { ascending: false });
    if (loadError) {
      setError(loadError.message || "参照ファイルを読み込めませんでした。");
      setFiles([]);
    } else {
      setFiles((data ?? []) as ReferenceFile[]);
    }
    setLoading(false);
  }

  useEffect(() => { void refresh(); }, [userId]);

  function openCreate() {
    setEditing(true);
    setSelectedId(null);
    setForm(EMPTY_FORM);
    setFileError("");
  }

  async function onPickFile(file: File | undefined) {
    if (!file) return;
    try {
      const text = await extractReferenceText(file);
      setForm((current) => ({
        ...current,
        content: text,
        filename: file.name,
        title: current.title.trim() ? current.title : file.name.replace(/\.(md|txt|csv|text)$/i, ""),
      }));
      setFileError("");
    } catch (failure) {
      setFileError(failure instanceof Error ? failure.message : "ファイルを読み込めませんでした。");
    }
  }

  function toggleSite(id: string) {
    setForm((current) => {
      if (id === "all") return { ...current, targetSites: ["all"] };
      const withoutAll = current.targetSites.filter((site) => site !== "all" && site !== id);
      const next = current.targetSites.includes(id) ? withoutAll : [...withoutAll, id];
      return { ...current, targetSites: next.length ? next : ["all"] };
    });
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const title = form.title.trim();
    const content = form.content.trim();
    if (!title || !content) {
      setFileError("タイトルと本文を入力してください。");
      return;
    }
    if (content.length > REFERENCE_CONTENT_MAX) {
      setFileError(`本文は${REFERENCE_CONTENT_MAX.toLocaleString()}文字までです。`);
      return;
    }
    setBusyId("save");
    setFileError("");
    const { error: saveError } = await supabase.from("restaurant_insight_reference_files").insert({
      title,
      description: form.description.trim(),
      category: form.category,
      target_sites: form.targetSites,
      content,
      original_filename: form.filename || null,
      mime: form.filename ? "text/plain" : "text/plain",
      byte_size: new TextEncoder().encode(content).length,
      is_active: true,
      created_by: userId,
    });
    setBusyId("");
    if (saveError) {
      setFileError(saveError.message || "保存できませんでした。");
      return;
    }
    setEditing(false);
    setForm(EMPTY_FORM);
    await refresh();
  }

  async function toggleActive(file: ReferenceFile) {
    setBusyId(file.id);
    setError("");
    const { error: updateError } = await supabase
      .from("restaurant_insight_reference_files")
      .update({ is_active: !file.is_active })
      .eq("id", file.id);
    setBusyId("");
    if (updateError) setError(updateError.message || "状態を更新できませんでした。");
    else await refresh();
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    setBusyId(pendingDelete.id);
    const { error: deleteError } = await supabase
      .from("restaurant_insight_reference_files")
      .update({ deleted_at: new Date().toISOString(), is_active: false })
      .eq("id", pendingDelete.id);
    setBusyId("");
    if (deleteError) {
      setError(deleteError.message || "削除できませんでした。");
      setPendingDelete(null);
      return;
    }
    if (selectedId === pendingDelete.id) setSelectedId(null);
    setPendingDelete(null);
    await refresh();
  }

  return <section className="reference-page">
    <header className="reference-page-heading">
      <div>
        <span className="eyebrow">REFERENCE LIBRARY</span>
        <h2>参照ファイル</h2>
        <p>NGワード、推奨ワード、サイトの改善案内などを保存します。有効なファイルは、新しい分析とレポート統合の前に読み込まれます。ログインした全員が同じ一覧を見られ、追加・削除できます。</p>
      </div>
      <button type="button" className="primary-button" onClick={openCreate} disabled={!!busyId || editing}>ファイルを追加</button>
    </header>
    <p className="reference-guidance">いま有効なファイルは{activeCount}件です。分析に使いたくないファイルは「無効にする」で残したまま外せます。削除すると一覧から消え、あとから戻せません。</p>
    {error && <div className="report-action-notice uncertain" role="status">{error}</div>}

    {editing && <form className="panel form-panel reference-form" onSubmit={onSubmit}>
      <span className="panel-kicker">ADD REFERENCE</span>
      <h3>参照ファイルを追加</h3>
      <p className="muted form-intro">md・txt・csv を読み込むか、本文を貼り付けてください。PDFやWordはテキストをコピーして貼り付けできます。</p>
      <label>タイトル<input required value={form.title} onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))} maxLength={200} placeholder="例）食べログ 特長ワードの注意点" /></label>
      <label>説明 <span className="optional">任意</span><input value={form.description} onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))} maxLength={2000} placeholder="どんなときに使う資料か、短く" /></label>
      <fieldset className="reference-fieldset">
        <legend>種類</legend>
        <div className="reference-chip-row">
          {REFERENCE_CATEGORIES.map((item) => (
            <label key={item.id} className={`reference-chip ${form.category === item.id ? "selected" : ""}`}>
              <input type="radio" name="reference-category" checked={form.category === item.id} onChange={() => setForm((current) => ({ ...current, category: item.id }))} />
              {item.label}
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset className="reference-fieldset">
        <legend>対象の媒体</legend>
        <div className="reference-chip-row">
          {REFERENCE_SITE_OPTIONS.map((site) => (
            <label key={site.id} className={`reference-chip ${form.targetSites.includes(site.id) ? "selected" : ""}`}>
              <input type="checkbox" checked={form.targetSites.includes(site.id)} onChange={() => toggleSite(site.id)} />
              {site.label}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="reference-upload">ファイルから読み込む <span className="optional">任意</span>
        <input type="file" accept=".md,.txt,.csv,text/plain,text/markdown,text/csv" onChange={(event) => { void onPickFile(event.target.files?.[0]); event.target.value = ""; }} />
      </label>
      <label>本文<textarea required value={form.content} onChange={(event) => setForm((current) => ({ ...current, content: event.target.value }))} rows={14} maxLength={REFERENCE_CONTENT_MAX} placeholder="資料の本文" /></label>
      <div className="research-focus-footer"><span>{form.filename ? `読み込み：${form.filename}` : "直接入力できます"}</span><span>{form.content.length.toLocaleString()} / {REFERENCE_CONTENT_MAX.toLocaleString()}</span></div>
      {fileError && <p className="reference-form-error" role="alert">{fileError}</p>}
      <div className="reference-form-actions">
        <button type="button" className="secondary-button" disabled={!!busyId} onClick={() => { setEditing(false); setFileError(""); }}>キャンセル</button>
        <button type="submit" className="primary-button" disabled={!!busyId}>{busyId === "save" ? "保存しています…" : "保存する"}</button>
      </div>
    </form>}

    <div className="reference-layout">
      <div className="reference-list">
        {loading && !files.length ? <div className="panel reference-empty"><i className="spinner"/><p>参照ファイルを読み込んでいます…</p></div>
          : !files.length ? <div className="panel reference-empty"><h3>まだ参照ファイルがありません</h3><p>「ファイルを追加」から、分析で使いたい資料を保存してください。</p></div>
          : files.map((file) => (
            <button type="button" key={file.id} className={`panel reference-card ${selectedId === file.id ? "selected" : ""} ${file.is_active ? "" : "inactive"}`} onClick={() => setSelectedId(file.id)}>
              <span className="reference-card-top">
                <b>{file.title}</b>
                <span className={`source-badge ${file.is_active ? "source-badge-app" : "source-badge-merged"}`}>{file.is_active ? "有効" : "無効"}</span>
              </span>
              <small>{categoryLabel(file.category)} ・ {siteLabels(file.target_sites)}</small>
              {file.description && <p>{file.description}</p>}
            </button>
          ))}
      </div>
      <article className="panel reference-detail">
        {!selected ? <div className="reference-empty"><h3>ファイルを選ぶと内容を表示します</h3><p>有効なファイルだけが、新しい分析と統合のときにモデルへ渡されます。</p></div>
          : <>
            <header>
              <span className="panel-kicker">{categoryLabel(selected.category)}</span>
              <h3>{selected.title}</h3>
              <p className="muted">{siteLabels(selected.target_sites)}{selected.original_filename ? ` ・ ${selected.original_filename}` : ""}</p>
              {selected.description && <p>{selected.description}</p>}
            </header>
            <pre className="reference-content">{selected.content}</pre>
            <div className="reference-detail-actions">
              <button type="button" className="secondary-button" disabled={!!busyId} onClick={() => { void toggleActive(selected); }}>{selected.is_active ? "無効にする" : "有効にする"}</button>
              <button type="button" className="danger-outline" disabled={!!busyId} onClick={() => setPendingDelete(selected)}>削除する</button>
            </div>
          </>}
      </article>
    </div>

    {pendingDelete && <div className="merge-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busyId) setPendingDelete(null); }}>
      <div className="panel form-panel delete-report-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-reference-title">
        <h2 id="delete-reference-title">この参照ファイルを削除しますか？</h2>
        <div className="delete-report-target"><b>{pendingDelete.title}</b><span>{categoryLabel(pendingDelete.category)}</span></div>
        <p>一覧から消え、新しい分析では使われなくなります。すでに完了したレポートの記録はそのままです。この操作は元に戻せません。</p>
        <div className="delete-dialog-actions">
          <button type="button" className="secondary-button" disabled={!!busyId} onClick={() => setPendingDelete(null)}>キャンセル</button>
          <button type="button" className="danger-button" disabled={!!busyId} onClick={() => { void confirmDelete(); }}>削除する</button>
        </div>
      </div>
    </div>}
  </section>;
}

export function FileIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8M8 17h5"/></svg>;
}
