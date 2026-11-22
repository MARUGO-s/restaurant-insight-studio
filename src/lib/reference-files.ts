export const REFERENCE_CATEGORIES = [
  { id: "ng_words", label: "NGワード" },
  { id: "recommended_words", label: "推奨ワード" },
  { id: "site_improvement", label: "サイト改善" },
  { id: "other", label: "その他" },
] as const;

export type ReferenceCategory = (typeof REFERENCE_CATEGORIES)[number]["id"];

export const REFERENCE_SITE_OPTIONS = [
  { id: "all", label: "すべての媒体" },
  { id: "tabelog", label: "食べログ" },
  { id: "hotpepper", label: "ホットペッパーグルメ" },
  { id: "gurunavi", label: "ぐるなび" },
  { id: "ikyu", label: "一休.comレストラン" },
  { id: "google_maps", label: "Google マップ" },
  { id: "retty", label: "Retty" },
  { id: "ozmall", label: "OZmall" },
  { id: "hitosara", label: "ヒトサラ" },
] as const;

export const REFERENCE_CONTENT_MAX = 200_000;

export type ReferenceFile = {
  id: string;
  title: string;
  description: string;
  category: ReferenceCategory | string;
  target_sites: string[];
  content: string;
  original_filename?: string | null;
  mime?: string | null;
  byte_size?: number | null;
  is_active: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
};

export function categoryLabel(category: string) {
  return REFERENCE_CATEGORIES.find((item) => item.id === category)?.label ?? category;
}

export function siteLabels(sites: string[]) {
  if (!sites?.length || sites.includes("all")) return "すべての媒体";
  return sites.map((id) => REFERENCE_SITE_OPTIONS.find((site) => site.id === id)?.label ?? id).join("、");
}

export function extractReferenceText(file: File): Promise<string> {
  const name = file.name.toLowerCase();
  const allowed = /\.(md|txt|csv|text)$/i.test(name) || /^(text\/(plain|markdown|csv)|application\/csv)$/i.test(file.type || "");
  if (!allowed) {
    return Promise.reject(new Error("md・txt・csv を選ぶか、内容をテキストとして貼り付けてください。PDFやWordはテキストをコピーして貼り付けできます。"));
  }
  return file.text().then((text) => {
    const trimmed = text.replace(/^\uFEFF/, "");
    if (!trimmed.trim()) throw new Error("ファイルが空でした。");
    if (trimmed.length > REFERENCE_CONTENT_MAX) throw new Error(`本文は${REFERENCE_CONTENT_MAX.toLocaleString()}文字までです。`);
    return trimmed;
  });
}
