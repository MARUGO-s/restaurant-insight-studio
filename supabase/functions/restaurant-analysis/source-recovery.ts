export type SourceCorrection = { path: string; removedUrl: string; retainedParentUrl: string; reason: "unread_review_detail_only_in_coverage" };
// Deliberately narrow: this is citation housekeeping for an explicitly unread
// verification link, never a replacement of evidence or an edit to a claim.
export function recoverUnreadCoverageLinks(
  report: Record<string, any>, critique: string, input: { selectedSites: { id: string; url: string }[] },
  availableSources: string[], canonical: (url: string) => string, urlsIn: (text: string) => string[],
): { report: Record<string, any>; corrections: SourceCorrection[] } | null {
  const known = new Set(availableSources.map(canonical));
  const candidate = structuredClone(report);
  if (!Array.isArray(candidate.researchCoverage)) return null;
  // Unknown URLs used anywhere in prose, findings, tables or critique are not
  // eligible. Exclude only the coverage source arrays from this inspection.
  const outsideCoverageSources: string[] = [critique];
  const walk = (value: any, path: string[] = []) => {
    if (path.length === 3 && path[0] === "researchCoverage" && path[2] === "sources") return;
    if (path.length === 1 && ["qualityGate", "productInventory", "researchFocus"].includes(path[0])) return;
    if (typeof value === "string") outsideCoverageSources.push(value);
    else if (Array.isArray(value)) value.forEach((child, index) => walk(child, [...path, String(index)]));
    else if (value && typeof value === "object") Object.entries(value).forEach(([key, child]) => walk(child, [...path, key]));
  };
  walk(candidate);
  if (urlsIn(outsideCoverageSources.join("\n")).some(url => !known.has(canonical(url)))) return null;
  const corrections: SourceCorrection[] = [];
  for (const [index, row] of candidate.researchCoverage.entries()) {
    if (!Array.isArray(row?.sources)) return null;
    const unknown = row.sources.filter((s: unknown) => typeof s !== "string" || !known.has(canonical(s)));
    if (!unknown.length) continue;
    // Do not demote a verified row, repair another target, or turn an unsupported
    // source list into an empty one. A successful parent-page read must remain.
    if (row.status !== "partial" || typeof row.scope !== "string" || typeof row.limitation !== "string") return null;
    const limitation = `${row.scope}\n${row.limitation}`;
    if (!/(?:個別口コミ|口コミ詳細|個別の口コミ)[^。\n]{0,100}(?:取得できず|取得できなかった|取得できない|未取得|未読)/.test(limitation)
      || !/(?:トップ|親ページ)[^。\n]{0,100}(?:抜粋|要約)/.test(limitation)) return null;
    const selected = input.selectedSites.find(site => site.id === row.targetId);
    if (!selected) return null;
    let parent: URL;
    try { parent = new URL(selected.url); } catch { return null; }
    // Tabelog review IDs identify individual pages, not interchangeable evidence.
    // Only the exact selected store root can act as the already-read parent.
    if (parent.origin !== "https://tabelog.com" || !/^\/[^/]+\/A\d+\/A\d+\/\d+\/$/.test(parent.pathname) || parent.search || parent.hash) return null;
    const retainedParent = row.sources.find((s: string) => known.has(canonical(s)) && canonical(s) === canonical(parent.href));
    if (!retainedParent) return null;
    for (const url of unknown) {
      if (typeof url !== "string" || urlsIn(url).length !== 1 || urlsIn(url)[0] !== url) return null;
      let detail: URL;
      try { detail = new URL(url); } catch { return null; }
      if (detail.origin !== parent.origin || detail.username || detail.password || detail.hash
        || (!detail.pathname.startsWith(parent.pathname) || !/^dtlrvwlst\/B[0-9]+\/$/.test(detail.pathname.slice(parent.pathname.length)))
        || [...detail.searchParams.keys()].some(key => key !== "lid")) return null;
      corrections.push({ path: `researchCoverage[${index}].sources`, removedUrl: url, retainedParentUrl: retainedParent, reason: "unread_review_detail_only_in_coverage" });
    }
    row.sources = row.sources.filter((s: string) => known.has(canonical(s)));
  }
  if (!corrections.length || corrections.length > 5) return null;
  return { report: candidate, corrections };
}
