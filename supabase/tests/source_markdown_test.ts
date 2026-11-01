import { strict as assert } from "node:assert";
import { sourceUrls, validateReportQuality } from "../functions/restaurant-analysis/core.ts";
import { evidenceUrl, qualityInput, qualityReport } from "./report_quality_fixture.ts";

Deno.test("Markdown inline-code delimiters never become URL characters", () => {
  assert.deepEqual(sourceUrls(`取得済み: \`${evidenceUrl}\`。`, [`${evidenceUrl}\``]), [evidenceUrl]);
  assert.deepEqual(sourceUrls("", [`${evidenceUrl}%60`]), [`${evidenceUrl}%60`]);
});
Deno.test("stored research sources with Markdown delimiters match clean report citations without accepting new sources", () => {
  const report = qualityReport();
  assert.doesNotThrow(() => validateReportQuality(report, qualityInput, [`${evidenceUrl}\``]));
  assert.throws(() => validateReportQuality(report, qualityInput, ["https://unobserved.test/other`"]), /追跡できない/);
});
