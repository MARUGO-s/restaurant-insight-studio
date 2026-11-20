import { load } from "npm:cheerio@1.1.2/slim";

export const TABELOG_COURSE_DETAIL_SELECTORS = [
  "body",
  "#rstdtl_party_dtl .course-dtl",
];

const TITLE_ERROR =
  /access denied|forbidden|just a moment|captcha|not found|service unavailable|アクセス[がを]制限|ページが見つかりません|エラーが発生|メンテナンス中|^(?:403|404|429|500|503)\b/i;
const DETAIL_FIELD =
  /(?:^|\n)(?:コース料金|品数|利用可能人数|利用可能時間|滞在可能時間|コース内容|注意事項|飲み放題|食べ放題)(?:[\t ：:]|\n)/;
const MAX_TEXT_CHARS = 8_000;

function line(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function lines(value: string): string {
  return value.split(/\r?\n/).map(line).filter(Boolean).join("\n");
}

function clipped(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return value.slice(0, maxChars - 1).replace(/[\uD800-\uDBFF]$/, "")
    .trimEnd() + "…";
}

function sameDetail(canonical: string, expectedUrl?: string): boolean {
  if (!canonical || !expectedUrl) return true;
  try {
    const source = new URL(canonical);
    const expected = new URL(expectedUrl);
    return source.protocol === "https:" && !source.port && !source.username &&
      !source.password &&
      source.hostname.replace(/^www\./, "") ===
        expected.hostname.replace(/^www\./, "") &&
      source.pathname.replace(/\/$/, "") ===
        expected.pathname.replace(/\/$/, "");
  } catch {
    return false;
  }
}

export function extractTabelogCourseDetail(
  html: string,
  expectedUrl?: string,
): { title: string; text: string } | null {
  const $ = load(html);
  if (
    !sameDetail(
      $("link[rel=canonical]").first().attr("href") ?? "",
      expectedUrl,
    )
  ) return null;
  const pageTitle = line($("title").first().text());
  if (TITLE_ERROR.test(pageTitle)) return null;

  $("script, style, template, svg, noscript, nav, input, select, textarea, button, [hidden], [aria-hidden=true], .is-hidden")
    .remove();
  $("br").replaceWith("\n");
  $("p, li").before("\n").after("\n");
  const details = $(TABELOG_COURSE_DETAIL_SELECTORS[1]);
  if (details.length !== 1) return null;
  const heading = line(
    details.find(".course-dtl__course-title").first().text(),
  );
  if (!heading) return null;

  const rows = details.find(".course-dtl__data-table tr").toArray().flatMap(
    (element) => {
      const row = $(element);
      const label = line(row.children("th").first().text());
      const cell = row.children("td").first();
      const price = label === "コース料金"
        ? cell.find(".course-dtl__price-num").first()
        : null;
      const value = lines(price?.length ? price.text() : cell.text());
      return label && value ? [`${label}：${clipped(value, 3_000)}`] : [];
    },
  );
  if (!rows.length || !DETAIL_FIELD.test(rows.join("\n"))) return null;

  const description = lines(details.find(".course-dtl__desc").first().text());
  const excerpt = [
    `見出し：${heading}`,
    description && `説明：${clipped(description, 1_600)}`,
    ...rows,
  ].filter(Boolean).join("\n");
  return {
    title: clipped(pageTitle || heading, 180),
    text: clipped(excerpt, MAX_TEXT_CHARS),
  };
}

export function extractRenderedTabelogCourseDetail(
  pageTitle: string,
  body: string,
  items: string[],
): { title: string; text: string } | null {
  const title = line(pageTitle);
  if (
    !title || TITLE_ERROR.test(title) || items.length !== 1 ||
    !line(body).includes(line(items[0]))
  ) return null;
  const detail = lines(items[0]);
  if (!DETAIL_FIELD.test(detail)) return null;
  return { title: clipped(title, 180), text: clipped(detail, MAX_TEXT_CHARS) };
}
