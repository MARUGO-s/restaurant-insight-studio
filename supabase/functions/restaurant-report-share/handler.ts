import { createClient } from "npm:@supabase/supabase-js@2.116.0";
import { reportShareTokenPattern } from "../_shared/report-share-token.ts";

const responseHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "x-report-share-token",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
};
const json = (body: unknown, status: number, extraHeaders: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...responseHeaders, "Content-Type": "application/json", ...extraHeaders } });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const records = (value: unknown) => Array.isArray(value) ? value.filter(isRecord) : [];
const textFields = (record: Record<string, unknown>, fields: string[]) =>
  Object.fromEntries(fields.flatMap((key) => typeof record[key] === "string" ? [[key, record[key]]] : []));

function publicSourceUrls(value: unknown) {
  return strings(value).filter((source) => {
    try {
      const url = new URL(source);
      return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password;
    } catch { return false; }
  });
}

function integratedReport(text: string) {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
  } catch {
    // Legacy Markdown has no separate internal fields. Do not send a malformed structured report as Markdown.
    return /^\s*(?:\{|```\s*json\b)/i.test(text) ? null : text;
  }
  if (!isRecord(decoded)) return null;
  const report = isRecord(decoded.report) ? decoded.report : decoded;
  if (!Array.isArray(report.keyFindings)) return null;
  return JSON.stringify({
    ...textFields(report, ["overallAssessment", "keyMessage", "detailedReport"]),
    keyFindings: records(report.keyFindings).map((finding) => ({
      ...textFields(finding, ["id", "scope", "title", "severity", "confidence", "issue", "evidence", "impact", "counterpoint", "verification", "action"]),
      sources: publicSourceUrls(finding.sources),
    })),
    strengths: strings(report.strengths),
    limitations: strings(report.limitations),
    actionPlan: records(report.actionPlan).map((action) => ({
      ...textFields(action, ["scope", "priority", "action", "reason", "effort", "timing", "owner", "deliverable", "metric", "baseline", "target", "verification"]),
      steps: strings(action.steps), findingIds: strings(action.findingIds),
    })),
    researchCoverage: records(report.researchCoverage).map((coverage) => ({
      ...textFields(coverage, ["targetId", "site", "status", "scope", "limitation"]),
      sources: publicSourceUrls(coverage.sources),
    })),
    detailSections: records(report.detailSections).map((section) => ({
      ...textFields(section, ["title", "body"]), columns: strings(section.columns),
      rows: Array.isArray(section.rows) ? section.rows.filter(Array.isArray).map((row) => row.map((cell) =>
        typeof cell === "string" || typeof cell === "number" ? cell : "")) : [],
      sources: publicSourceUrls(section.sources),
    })),
    productInventory: records(report.productInventory).map((product) => ({
      ...textFields(product, ["id", "name", "price", "conditions", "site", "reviewStatus", "reviewReason"]),
      source: publicSourceUrls([product.source])[0] ?? "",
    })),
    qualityGate: isRecord(report.qualityGate) && typeof report.qualityGate.version === "number" ? { version: report.qualityGate.version } : undefined,
  });
}

async function lookupReport(token: string) {
  const db = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await db.rpc("restaurant_insight_read_report_share", { p_token: token });
  if (error) throw error;
  return data;
}

export async function handlePublicReportShare(request: Request, lookup: (token: string) => Promise<unknown> = lookupReport) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: responseHeaders });
  if (request.method !== "GET") return json({ error: "閲覧にはGETを使用してください。" }, 405, { "Allow": "GET, OPTIONS" });
  const notFound = () => json({ error: "共有レポートを閲覧できません。" }, 404);
  const token = request.headers.get("X-Report-Share-Token") ?? "";
  if (!reportShareTokenPattern.test(token)) return notFound();
  try {
    const row = await lookup(token);
    if (!isRecord(row) || typeof row.storeName !== "string" || typeof row.createdAt !== "string" || typeof row.report !== "string") return notFound();
    const report = integratedReport(row.report);
    if (!report?.trim()) return notFound();
    return json({ storeName: row.storeName, createdAt: row.createdAt, report, reportSources: publicSourceUrls(row.reportSources) }, 200);
  } catch {
    return json({ error: "共有レポートを読み込めませんでした。" }, 503);
  }
}
