import { load, type CheerioAPI } from "npm:cheerio@1.1.2/slim";

export type DirectPageKind = "official" | "tabelog-store" | "tabelog-courses";
type ExcerptLimits = { truncated: boolean };
type PageExcerpt = { title: string; text: string; truncated?: boolean };

const MAX_PAGE_CHARS = 16_000;
const MAX_COURSES = 20;
const STORE_FIELDS = new Set([
  "店名", "住所", "交通手段", "営業時間", "定休日", "予約可否",
  "サービス料・チャージ", "個室", "貸切", "席数", "最大予約可能人数", "備考",
]);

const OFFICIAL_SECTIONS = [
  { label: "店舗情報", selectors: ["#info", "#information", "#access", "#shop"] },
  { label: "コース・メニュー", selectors: ["#course", "#courses", "#menu"] },
  { label: "予約・貸切", selectors: ["#party", "#booking", "#reservation"] },
  { label: "席・個室", selectors: ["#interior", "#rooms", "#private-room"] },
];
const RESTAURANT_DETAILS = /営業時間|定休日|ラストオーダー|貸[し]?切|個室|[￥¥]\s*[0-9０-９]|[0-9０-９][0-9０-９,，]*\s*円|\d{1,2}:\d{2}\s*[〜～–-]/i;
const ERROR_TITLE = /access denied|forbidden|just a moment|captcha|not found|service unavailable|アクセス[がを]制限|ページが見つかりません|エラーが発生|メンテナンス中|^(?:403|404|429|500|503)\b/i;
const COURSE_DETAILS = /コース|おまかせ|プラン|[0-9０-９]+\s*品|[￥¥][\d０-９,，]+|[\d０-９,，]+\s*円/;
const COURSE_PRICE = /^[￥¥]\s*[\d０-９]|^[\d０-９][\d０-９,，]*(?:\s*円|$)|^円/;
const COURSE_CONDITION = /[\d０-９]+\s*名|利用条件|要予約|予約締切|飲み放題|限定|提供期間/;

function line(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function lines(value: string): string[] {
  return value.split(/\r?\n/).map(line).filter(Boolean);
}

function clipped(limits: ExcerptLimits, value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  limits.truncated = true;
  return value.slice(0, maxChars - 1).replace(/[\uD800-\uDBFF]$/, "").trimEnd() + "…";
}

function fieldLine(limits: ExcerptLimits, label: string, value: string, maxChars: number): string {
  return value ? label + "：" + clipped(limits, value, maxChars) : "";
}

function storeFieldsText(fields: Map<string, string>) {
  if (!fields.has("店名") || !["住所", "営業時間", "貸切", "個室"].some((label) => fields.has(label))) return null;
  return [...fields].map(([label, value]) => label + "：" + value).join("\n");
}

function storeText($: CheerioAPI, limits: ExcerptLimits): string | null {
  const fields = new Map<string, string>();
  $("tr").each((_index, element) => {
    const row = $(element);
    const label = line(row.children("th").first().text());
    if (!STORE_FIELDS.has(label) || fields.has(label)) return;
    const value = line(row.children("td").first().text());
    if (value) fields.set(label, clipped(limits, value, 1_200));
  });

  return storeFieldsText(fields);
}

function courseText($: CheerioAPI, limits: ExcerptLimits): string | null {
  const page = $(".course-list").first();
  const cards = page.length ? page.find(".rstdtl-course-list") : $(".rstdtl-course-list");
  if (!cards.length) return null;
  const lastUpdate = line(page.find(".course-list__last-update").first().text());
  const count = Math.min(cards.length, MAX_COURSES);
  if (count < cards.length) limits.truncated = true;
  // Leave space for title, price, rules and the summary on every card.
  const descriptionLimit = Math.min(2_000, Math.floor((MAX_PAGE_CHARS - 400) / count) - 420);
  const courses: string[] = [];
  for (const element of cards.slice(0, count).toArray()) {
    const card = $(element);
    const titleElement = card.find(".rstdtl-course-list__course-title").first();
    const title = line(titleElement.find(".rstdtl-course-list__course-title-text").first().text() || titleElement.text());
    const badge = line(titleElement.find(".rstdtl-course-list__label").text());
    const description = line(card.find(".rstdtl-course-list__desc").first().text());
    const price = line(card.find(".rstdtl-course-list__price").first().text());
    const rules = line(card.find(".rstdtl-course-list__course-rule").text());
    if (!title || !(description || price || rules)) {
      limits.truncated = true;
      continue;
    }
    courses.push([
      fieldLine(limits, "見出し", title, 140),
      fieldLine(limits, "表示ラベル", badge, 35),
      fieldLine(limits, "説明", description, descriptionLimit),
      fieldLine(limits, "価格", price, 80),
      fieldLine(limits, "条件", rules, 130),
    ].filter(Boolean).join("\n"));
  }

  if (!courses.length) return null;
  const summary = courses.length < cards.length ? "取得したコースカード " + cards.length + "件中、" + courses.length + "件の内容を抜粋しました。" : "";
  return [clipped(limits, lastUpdate, 160), ...courses, summary].filter(Boolean).join("\n\n");
}

function officialText($: CheerioAPI, limits: ExcerptLimits): string | null {
  const body = $("body").first();
  const allLines = lines(body.length ? body.text() : $.root().text());
  const fullText = allLines.join("\n");
  if (fullText.length < 60 || !RESTAURANT_DETAILS.test(fullText)) return null;

  const excerpts = OFFICIAL_SECTIONS.flatMap(({ label, selectors }) => {
    for (const selector of selectors) {
      const value = line($(selector).first().text());
      if (value.length >= 15) return ["【" + label + "】\n" + clipped(limits, value, 3_000)];
    }
    return [];
  });
  if (excerpts.length === 0) {
    const primary = $("main, [role=main], article").toArray()
      .map((element) => lines($(element).text()).join("\n"))
      .find((value) => value.length >= 60 && RESTAURANT_DETAILS.test(value));
    if (!primary) return fullText;
    excerpts.push(clipped(limits, primary, 12_800));
  }
  const detailLines = [...new Set(allLines)].filter((value) =>
    RESTAURANT_DETAILS.test(value) && !excerpts.some((section) => section.includes(value))
  );
  if (detailLines.length) excerpts.push("【掲載本文の関連記述】\n" + clipped(limits, detailLines.join("\n"), 3_000));
  return excerpts.join("\n\n");
}

function pageExcerpt(title: string, text: string | null, limits: ExcerptLimits): PageExcerpt | null {
  if (!text) return null;
  const excerpt = { title: clipped(limits, title, 180), text: clipped(limits, text, MAX_PAGE_CHARS) };
  return limits.truncated ? { ...excerpt, truncated: true } : excerpt;
}

export function extractDirectPage(kind: DirectPageKind, html: string): PageExcerpt | null {
  const $ = load(html);
  const title = line($("title").first().text());
  if (!title || ERROR_TITLE.test(title)) return null;
  $("script, style, template, svg, noscript, nav, input, select, textarea, button").remove();
  $("br").replaceWith("\n");
  $("h1, h2, h3, h4, h5, h6, p, li, dt, dd").before("\n").after("\n");

  const limits = { truncated: false };
  const text = kind === "tabelog-store" ? storeText($, limits) : kind === "tabelog-courses" ? courseText($, limits) : officialText($, limits);
  return pageExcerpt(title, text, limits);
}

export function renderedPageSelectors(kind: DirectPageKind): string[] {
  if (kind === "tabelog-store") return ["body", ".rstinfo-table tr"];
  if (kind === "tabelog-courses") return ["body", ".rstdtl-course-list"];
  return ["body"];
}

function renderedStoreText(rows: string[], limits: ExcerptLimits) {
  const fields = new Map<string, string>();
  for (const row of rows) {
    const [heading, ...rest] = row.trim().split(row.includes("\t") ? "\t" : /\r?\n/);
    const label = heading.replace(/\s+/g, "");
    const value = line(rest.join(" "));
    if (value && STORE_FIELDS.has(label) && !fields.has(label)) fields.set(label, clipped(limits, value, 1_200));
  }
  return storeFieldsText(fields);
}

function renderedCourseText(cards: string[], limits: ExcerptLimits) {
  const visibleCards = cards.map(lines).filter((card) => card.length > 1 && COURSE_DETAILS.test(card.join(" ")));
  if (!visibleCards.length) return null;
  const count = Math.min(visibleCards.length, MAX_COURSES);
  const cardLimit = Math.floor((MAX_PAGE_CHARS - 200) / count) - 2;
  const excerpts = visibleCards.slice(0, count).map((card) => {
    const full = card.join("\n");
    if (full.length <= cardLimit) return full;
    const detailBudget = Math.min(350, Math.floor(cardLimit / 3));
    const prices = clipped(limits, card.filter((value) => COURSE_PRICE.test(value)).join("\n"), 100);
    const conditions = clipped(limits, card.slice(1).filter((value) => value.length <= 125 && COURSE_CONDITION.test(value)).join("\n"), detailBudget - prices.length - 1);
    const details = [prices, conditions].filter(Boolean).join("\n");
    const prefix = clipped(limits, full, cardLimit - details.length - 1);
    return [prefix, details].filter(Boolean).join("\n");
  });
  if (count < visibleCards.length) {
    limits.truncated = true;
    excerpts.push(`表示されたコースカード ${visibleCards.length}件中、先頭${count}件を抜粋しました。`);
  }
  return excerpts.join("\n\n");
}

function renderedOfficialText(body: string, limits: ExcerptLimits) {
  const visibleLines = lines(body);
  const full = visibleLines.join("\n");
  if (full.length < 60 || !RESTAURANT_DETAILS.test(full)) return null;
  if (full.length <= MAX_PAGE_CHARS) return full;
  const prefix = clipped(limits, full, 12_800);
  const details = [...new Set(visibleLines)].filter((value) => RESTAURANT_DETAILS.test(value) && !prefix.includes(value));
  return [prefix, clipped(limits, details.join("\n"), 3_000)].filter(Boolean).join("\n\n");
}

export function extractRenderedDirectPage(kind: DirectPageKind, pageTitle: string, body: string, items: string[]): PageExcerpt | null {
  const title = line(pageTitle);
  const visibleBody = line(body);
  if (!title || ERROR_TITLE.test(title) || !visibleBody) return null;

  const limits = { truncated: false };
  if (kind === "official") return pageExcerpt(title, renderedOfficialText(body, limits), limits);

  // A browser can return textContent for a queried element hidden by its own
  // styles. Only use text that is also present in the rendered body's innerText.
  const visibleItems = items.filter((item) => {
    const text = line(item);
    return text !== "" && visibleBody.includes(text);
  });
  const text = kind === "tabelog-store" ? renderedStoreText(visibleItems, limits) : renderedCourseText(visibleItems, limits);
  return pageExcerpt(title, text, limits);
}
