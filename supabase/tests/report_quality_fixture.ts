export const qualityInput = { storeName: "テスト店", storeUrl: "https://example.test/store", groupName: null,
  selectedSites: [{ id: "tabelog", name: "食べログ", url: "https://example.test/listing" }] };
export const evidenceUrl = "https://example.test/listing";
export function qualityReport(focus = false) {
  return {
    overallAssessment: "予約前の条件確認を優先する", keyMessage: "掲載内容と運用を照合する。", detailedReport: "公開情報を対象とした調査。",
    researchCoverage: ["official", "market", "social", "tabelog"].map(targetId => ({ targetId, site: targetId, status: "partial", scope: "掲載ページの条件欄を確認。全口コミは未読。", limitation: "非公開実績は取得していない", sources: [evidenceUrl] })),
    keyFindings: [{ id: "F1", title: "人数条件の確認", severity: "medium", confidence: "inferred", issue: "人数ごとの利用可否が判断しにくい可能性", evidence: "掲載ページに人数条件の表記あり", action: "運用を確認し人数条件を整理", impact: "幹事の予約前判断に影響する可能性", verification: "店長が席の組み合わせと受入人数を確認", counterpoint: "電話相談で案内できている可能性", sources: [evidenceUrl] }],
    strengths: ["公開されたプランがある"], limitations: ["予約実績は未提供"],
    actionPlan: [{ priority: "P1", findingIds: ["F1"], action: "人数案内を整理", reason: "予約前に条件を理解できるようにする", owner: "店長・掲載担当", steps: ["運用を確認", "掲載案内を更新"], deliverable: "人数条件の案内文", verification: "店長と掲載担当が実際の画面を照合", metric: "問い合わせ理由を初週と4週目に分類して比較", baseline: "未取得。予約担当が記録", target: "基準取得後に設定", effort: "半日程度。運用確認後に見積", timing: "今週" }],
    detailSections: [...["scope", "positioning", "listings", "menu", "conversion", "voices", "competition", "uncertainties", "execution", "measurement"], ...(focus ? ["focus"] : [])].map(id => ({ id, title: id, body: "根拠を確認し、不明な運用は現場に照合する。", columns: ["確認事項", "対応"], rows: [["人数条件", "店長に照合"]], sources: [evidenceUrl] })),
  };
}
