// Structural review receipts are not proof that a URL semantically supports a claim.
// The synthesis model must perform that review; these checks reject missing,
// untraceable or internally inconsistent receipts without another paid call.
type InventoryItem = { id: string; name: string; price: string; conditions: string; source: string; site: string };
type ReviewAgent = { id: string; text: string; menuInventory?: InventoryItem[] };
type SourceCheck = (sources: unknown) => boolean;
const nonempty = (value: unknown): value is string => typeof value === "string" && !!value.trim();
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);

export function validateReportIntegrity(report: Record<string, any>, agents: ReviewAgent[], validSources: SourceCheck) {
  const reviews = report.claimReviews;
  const seen = new Set<string>();
  if (!Array.isArray(reviews)) throw new Error("claimReviews: 専門調査の主張審査が必要です");
  for (const review of reviews) {
    const agent = agents.find(a => a.id === review?.agentId);
    const key = JSON.stringify([review?.agentId, review?.claim]);
    if (!object(review) || !agent || !nonempty(review.claim) || !agent.text.includes(review.claim)
      || !["supported", "conditional", "unverified", "rejected"].includes(review.decision)
      || !nonempty(review.reason) || !validSources(review.sources) || seen.has(key)
      || (["supported", "conditional"].includes(review.decision) && !review.sources.length)) {
      throw new Error("claimReviews: 逐語引用・担当・採否・理由・追跡可能な出典が不完全です");
    }
    seen.add(key);
  }
  if (agents.some(a => a.text.trim() && !reviews.some(r => r.agentId === a.id))) {
    throw new Error("claimReviews: 全専門担当の主要判断を審査してください");
  }
  const findings = report.keyFindings ?? [], actions = report.actionPlan ?? [];
  const scopes = ["store", "research", "verification"];
  if (findings.some((f: any) => !scopes.includes(f.scope)) || actions.some((a: any) => !scopes.includes(a.scope)
    || !Array.isArray(a.findingIds) || a.findingIds.some((id: string) => findings.find((f: any) => f.id === id)?.scope !== a.scope))) {
    throw new Error("scope: 課題と対応施策をstore/research/verificationに分類し、異なる分類は分けてください");
  }
  // Literal recurrence only: paraphrases and factual entailment still require human review.
  for (const review of reviews.filter(r => r.decision !== "supported")) {
    const claims = review.claim.split(/[。！？\n]+/).map((s: string) => s.trim()).filter((s: string) => s.length >= 8);
    if (findings.some((f: any) => f.confidence === "confirmed"
      && claims.some((claim: string) => [f.title, f.issue, f.evidence].some(value => typeof value === "string" && value.includes(claim))))) {
      throw new Error("claimReviews: 未採用または条件付きの主張を確認済み課題として断定できません");
    }
  }
  // Bounded detection of the audited completeness-rate defect, not a ban on
  // dimensional rates (円/人, 欄/商品 are valid averages when labelled as such).
  const displayText = JSON.stringify({ overallAssessment: report.overallAssessment, keyMessage: report.keyMessage,
    keyFindings: report.keyFindings, actionPlan: report.actionPlan, detailedReport: report.detailedReport, detailSections: report.detailSections });
  const fieldPerProduct = /(?:条件欄確認数|確認済み条件欄数)\s*[÷/／]\s*(?:対象)?商品数/;
  const productProportion = /確認済み商品数\s*[÷/／]\s*(?:対象)?商品数/;
  const measurement = JSON.stringify((report.detailSections ?? []).filter((s: any) => s.id === "measurement"));
  const changesCountingUnit = actions.some((a: any) => typeof a.metric === "string" && fieldPerProduct.test(a.metric)
    && !/商品当たり|欄\s*[/／]\s*商品/.test(a.metric) && productProportion.test(measurement));
  if (changesCountingUnit || /条件[^。\n"：:=＝]{0,16}率\s*[：:=＝]\s*(?:条件欄確認数|確認済み条件欄数)\s*[÷/／]\s*(?:対象)?商品数/.test(displayText)) {
    throw new Error("KPI: 条件確認率の分子と分母の単位が不一致です。確認済み商品数/商品数と、欄数/商品数を混同しないでください");
  }
  for (const action of actions) {
    const sentences = [action.action, ...(action.steps ?? []), action.verification, action.deliverable]
      .filter((v: unknown): v is string => typeof v === "string").flatMap((s: string) => s.split(/[。\n]/));
    const stopsBeforeConfirmation = sentences.some((s: string) => /(?:成立|確定|送信)(?:する)?前.{0,12}(?:中止|停止|止め|終了)|予約を?(?:確定|成立|送信)せず/.test(s));
    const expectsCompletion = sentences.some((s: string) => /完了メール|予約確認メール|完了画面/.test(s)
      && !/(?:完了メール|予約確認メール|完了画面).{0,16}(?:対象外|確認しない|検証しない|確認できない|検証できない)/.test(s));
    if (stopsBeforeConfirmation && expectsCompletion) throw new Error("予約検証: 成立前に中止する手順では完了メール・完了画面を検証できません。許可付きテスト予約は別施策に分けてください");
  }
  const originalProductInventory = structuredClone(agents.flatMap(a => a.menuInventory ?? []));
  const productReviews = report.productReviews;
  const ids = originalProductInventory.map(item => item.id);
  if (!Array.isArray(productReviews) || productReviews.length !== ids.length || ids.some(id => !nonempty(id))
    || new Set(ids).size !== ids.length || new Set(productReviews.map(r => r?.id)).size !== ids.length
    || productReviews.some(r => !ids.includes(r?.id))) throw new Error("productReviews: 元商品全件と一意に対応する審査が必要です");
  const fields = ["name", "price", "conditions", "site", "source"] as const;
  const productInventory = originalProductInventory.map(item => {
    const review = productReviews.find(r => r.id === item.id);
    if (!object(review) || !["confirmed", "corrected", "unverified", "rejected"].includes(review.status)
      || !nonempty(review.reason) || !validSources(review.sources)
      || (review.status !== "corrected" && review.corrected !== undefined)) throw new Error("productReviews: 採否・理由・出典・訂正の指定が不正です");
    let display = { ...item };
    if (review.status === "corrected") {
      if (!object(review.corrected) || !fields.every(field => nonempty(review.corrected[field]))) {
        throw new Error("productReviews: 訂正後の商品名・価格・条件・媒体・URLをすべて指定してください");
      }
      display = { id: item.id, name: review.corrected.name, price: review.corrected.price,
        conditions: review.corrected.conditions, site: review.corrected.site, source: review.corrected.source };
    }
    if (["confirmed", "corrected"].includes(review.status)
      && (!validSources([display.source]) || !review.sources.includes(display.source))) {
      throw new Error("productReviews: 採用・訂正商品の出典は取得済みURLを審査根拠に含めてください");
    }
    if (["confirmed", "corrected"].includes(review.status)) {
      const host = new URL(display.source).hostname.toLowerCase();
      if ((host === "gorp.jp" || host.endsWith(".gorp.jp")) && /google\s*(?:マップ|maps)|グーグル\s*マップ/i.test(display.site)) {
        throw new Error("productReviews: gorp.jpをGoogle マップ媒体として採用できません。媒体名を訂正または採用を保留してください");
      }
    }
    return { ...display, reviewStatus: review.status, reviewReason: review.reason };
  });
  return { productInventory, originalProductInventory };
}
