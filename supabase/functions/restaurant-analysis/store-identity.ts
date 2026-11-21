import storeCatalog from "./store-catalog.json" with { type: "json" };

type CatalogStore = { name: string; url: string };
type NamedStore = { storeName: string; storeUrl?: string | null };

const CATALOG = storeCatalog as CatalogStore[];

/** Extra name spellings that should map to a catalog store. */
const NAME_ALIASES: Record<string, string> = {
  "bistrocavacava": "ビストロ サヴァサヴァ",
  "bistro cavacava": "ビストロ サヴァサヴァ",
  "cavacava": "ビストロ サヴァサヴァ",
  "サヴァサヴァ": "ビストロ サヴァサヴァ",
  "ビストロサヴァサヴァ": "ビストロ サヴァサヴァ",
  "マルゴ四谷": "マルゴ 四谷",
  "四谷マルゴ": "マルゴ 四谷",
  "marugo yotsuya": "マルゴ 四谷",
  "marugoyotsuya": "マルゴ 四谷",
  "マルゴエス": "マルゴエス",
  "marugos": "マルゴエス",
  "marugo s": "マルゴエス",
  "marugo-s": "マルゴエス",
  "マルゴs": "マルゴエス",
  "マルゴｓ": "マルゴエス",
  "マルゴ エス": "マルゴエス",
  "マルゴセカンド": "マルゴ セカンド",
  "マルゴグランデ": "マルゴ グランデ",
  "焼肉marugo": "焼肉MARUGO",
  "yakinikumarugo": "焼肉MARUGO",
};

export function normalizeText(value: string) {
  return value.normalize("NFKC").replace(/\s+/g, "").toLocaleLowerCase("ja");
}

export function normalizeStoreUrl(url: string) {
  try {
    const parsed = new URL(url.trim());
    if (!["http:", "https:"].includes(parsed.protocol)) return "";
    const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
    const path = parsed.pathname.replace(/\/+$/, "") || "";
    return `${host}${path}`;
  } catch {
    return url.normalize("NFKC").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
  }
}

function catalogByUrl(url: string) {
  const key = normalizeStoreUrl(url);
  if (!key) return undefined;
  return CATALOG.find((store) => normalizeStoreUrl(store.url) === key);
}

function catalogByName(name: string) {
  const compact = normalizeText(name);
  if (!compact) return undefined;
  const direct = CATALOG.find((store) => normalizeText(store.name) === compact);
  if (direct) return direct;
  const alias = NAME_ALIASES[compact] ?? NAME_ALIASES[name.normalize("NFKC").trim().toLocaleLowerCase("ja")];
  if (alias) return CATALOG.find((store) => store.name === alias);
  return undefined;
}

export function officialStoreIdentity(name: string, url = "") {
  return catalogByUrl(url) ?? catalogByName(name);
}

/** Stable key used to group reports for the same restaurant. */
export function storeIdentityKey(name: string, url = "") {
  const official = officialStoreIdentity(name, url);
  if (official) return `catalog:${normalizeStoreUrl(official.url) || normalizeText(official.name)}`;
  const normalizedUrl = normalizeStoreUrl(url);
  if (normalizedUrl) return `url:${normalizedUrl}`;
  const compact = normalizeText(name);
  return compact ? `name:${compact}` : `name:unknown`;
}

export function officialDisplayName(name: string, url = "") {
  return officialStoreIdentity(name, url)?.name ?? name.trim();
}

export function officialDisplayUrl(name: string, url = "") {
  return officialStoreIdentity(name, url)?.url ?? url.trim();
}

export function groupReportsByStore<T extends NamedStore>(reports: T[]) {
  const groups = new Map<string, { key: string; storeName: string; storeUrl: string; reports: T[] }>();
  for (const report of reports) {
    const key = storeIdentityKey(report.storeName, report.storeUrl ?? "");
    const existing = groups.get(key);
    if (existing) existing.reports.push(report);
    else {
      groups.set(key, {
        key,
        storeName: officialDisplayName(report.storeName, report.storeUrl ?? ""),
        storeUrl: officialDisplayUrl(report.storeName, report.storeUrl ?? ""),
        reports: [report],
      });
    }
  }
  return [...groups.values()].sort((a, b) => b.reports.length - a.reports.length || a.storeName.localeCompare(b.storeName, "ja"));
}
