// Only fresh-generation mocks use this extension. Keep qualityReport and
// historical completed-draft fixtures unchanged to exercise v2 recovery.
export function withIntegrityReviews(report: any, agents: { id: string; text: string; menuInventory?: { id: string; source: string }[] }[]) {
  return { ...report,
    keyFindings: report.keyFindings.map((f: any) => ({ ...f, scope: "verification" })),
    actionPlan: report.actionPlan.map((a: any) => ({ ...a, scope: "verification" })),
    claimReviews: agents.map(a => ({ agentId: a.id, claim: a.text, decision: "unverified", reason: "断定を支持する個別根拠は不足。確認課題として扱う。", sources: [] })),
    productReviews: agents.flatMap(a => a.menuInventory ?? []).map(m => ({ id: m.id, status: "confirmed", reason: "掲載値を採用。意味一致の保証ではない。", sources: [m.source] })),
  };
}
