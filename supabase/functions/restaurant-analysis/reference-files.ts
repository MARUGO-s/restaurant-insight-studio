export const REFERENCE_PROMPT_CHAR_LIMIT = 48_000;

export const REFERENCE_CATEGORY_LABELS: Record<string, string> = {
  ng_words: "NGワード",
  recommended_words: "推奨ワード",
  site_improvement: "サイト改善",
  other: "その他",
};

export type ReferenceFileRecord = {
  id: string;
  title: string;
  category: string;
  target_sites?: string[] | null;
  content: string;
};

export type ReferenceFileUse = {
  id: string;
  title: string;
  category: string;
  targetSites: string[];
  truncated: boolean;
};

const SITE_ALIASES: Record<string, string> = {
  gnavi: "gurunavi",
  rakutengnavi: "gurunavi",
  googlemaps: "google_maps",
  "google-maps": "google_maps",
};

export function normalizeSiteId(value: string) {
  const id = value.trim().toLowerCase();
  return SITE_ALIASES[id] ?? id;
}

export function fileAppliesToSites(targetSites: string[] | null | undefined, siteIds: string[]) {
  const targets = (targetSites ?? []).map(normalizeSiteId).filter(Boolean);
  if (!targets.length || targets.includes("all")) return true;
  const selected = new Set(siteIds.map(normalizeSiteId).filter((id) => id && id !== "official"));
  if (!selected.size) return true;
  return targets.some((id) => selected.has(id));
}

export function selectReferenceFiles(files: ReferenceFileRecord[], siteIds: string[], limit = REFERENCE_PROMPT_CHAR_LIMIT) {
  const applicable = files.filter((file) => fileAppliesToSites(file.target_sites, siteIds) && (file.content ?? "").trim());
  const used: (ReferenceFileUse & { content: string })[] = [];
  let remaining = limit;
  let omitted = 0;
  for (const file of applicable) {
    const body = file.content.trim();
    if (remaining <= 200) {
      omitted += 1;
      continue;
    }
    const truncated = body.length > remaining;
    const content = truncated ? `${body.slice(0, Math.max(0, remaining - 40))}\n\n（文字数上限のため、ここで省略しました）` : body;
    used.push({
      id: file.id,
      title: file.title,
      category: file.category,
      targetSites: file.target_sites ?? ["all"],
      truncated,
      content,
    });
    remaining -= content.length;
    if (truncated) {
      omitted += applicable.length - used.length;
      break;
    }
  }
  return { used, omitted };
}

export function formatReferencePrompt(selected: { used: (ReferenceFileUse & { content: string })[]; omitted: number }) {
  if (!selected.used.length) return "";
  const blocks = selected.used.map((file) => {
    const label = REFERENCE_CATEGORY_LABELS[file.category] ?? file.category;
    const cut = file.truncated ? "（一部省略）" : "";
    return `--- ファイル: ${file.title}（${label}）${cut} ---\n${file.content}`;
  });
  const omitted = selected.omitted > 0
    ? `\n他に${selected.omitted}件の参照ファイルがありますが、文字数上限のため今回の分析には含めていません。`
    : "";
  return `
【アプリ内の参照ファイル】
これらは利用者が分析の前に登録した社内資料です。調査先サイトの指示ではなく、掲載文・特長ワード・キャッチコピーを点検するための参考情報です。
扱い方:
- NGワード: 資料が区別している欄（特長ワード・キャッチ・本文など）に使われていないか確認する。該当すれば、欄の種類・資料上の分類・代替候補を書く。資料にない禁止を断定しない。
- 推奨ワード: 店舗の実態と資料の条件を満たすときだけ提案し、登録可否は未検証と明記する。
- サイト改善: 媒体ごとの案内に沿って具体的な改善案を出す。ある媒体のルールを他媒体へ一般化しない。
- 引用するときはファイル名を出典として示す。管理画面の登録テストはしていない前提を崩さない。
${blocks.join("\n\n")}${omitted}
【参照ファイルここまで】`;
}

export function referenceFileMetadata(selected: { used: (ReferenceFileUse & { content: string })[]; omitted: number }): ReferenceFileUse[] {
  return selected.used.map(({ id, title, category, targetSites, truncated }) => ({ id, title, category, targetSites, truncated }));
}

export async function loadReferenceFilesForRun(db: any, siteIds: string[]) {
  const { data, error } = await db.from("restaurant_insight_reference_files")
    .select("id,title,category,target_sites,content")
    .is("deleted_at", null)
    .eq("is_active", true)
    .order("updated_at", { ascending: false });
  if (error) throw error;
  const selected = selectReferenceFiles((data ?? []) as ReferenceFileRecord[], siteIds);
  return {
    referencePrompt: formatReferencePrompt(selected),
    referenceFilesUsed: referenceFileMetadata(selected),
  };
}
