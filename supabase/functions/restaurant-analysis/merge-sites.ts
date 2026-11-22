export type MergeSiteTarget = { id: string; name: string; url: string };

export const ANALYSIS_SITE_NAMES = new Map([
  ["tabelog", "食べログ"],
  ["google_maps", "Google マップ"],
  ["hotpepper", "ホットペッパーグルメ"],
  ["gurunavi", "ぐるなび"],
  ["retty", "Retty"],
  ["ikyu", "一休.comレストラン"],
  ["ozmall", "OZmall"],
  ["hitosara", "ヒトサラ"],
]);

const SITE_ALIASES = new Map([
  ["gnavi", "gurunavi"],
  ["rakutengnavi", "gurunavi"],
  ["rakuten_gnavi", "gurunavi"],
  ["googlemaps", "google_maps"],
  ["google-maps", "google_maps"],
  ["google_map", "google_maps"],
]);

const clean = (value: unknown, limit: number) => typeof value === "string" ? value.trim().slice(0, limit) : "";

function usableUrl(value: string) {
  try {
    const parsed = new URL(value);
    return ["https:", "http:"].includes(parsed.protocol) ? value : "";
  } catch {
    return "";
  }
}

/** Merge-source site lists may include checker media (gnavi, Instagram, official). Keep usable sites and drop the rest. */
export function normalizeMergeSites(value: unknown, storeUrl = ""): MergeSiteTarget[] {
  const incoming = Array.isArray(value) ? value : [];
  const sites: MergeSiteTarget[] = [];
  const seen = new Set<string>();

  for (const item of incoming) {
    const rawId = clean((item as { id?: unknown })?.id, 60);
    if (!rawId || rawId === "official") continue;
    const aliased = SITE_ALIASES.get(rawId) ?? rawId;
    const knownName = ANALYSIS_SITE_NAMES.get(aliased);
    const rawName = clean((item as { name?: unknown })?.name, 80);
    const url = usableUrl(clean((item as { url?: unknown })?.url, 600));

    if (knownName) {
      if (seen.has(aliased)) continue;
      seen.add(aliased);
      sites.push({ id: aliased, name: knownName, url });
      continue;
    }

    if (!url) continue;
    const customId = (rawId.startsWith("custom-") ? rawId : `custom-${rawId}`).slice(0, 60);
    if (seen.has(customId)) continue;
    seen.add(customId);
    sites.push({ id: customId, name: rawName || rawId, url });
  }

  if (sites.length) return sites.slice(0, 12);
  const fallback = usableUrl(storeUrl);
  return fallback ? [{ id: "official", name: "公式サイト", url: fallback }] : [];
}
