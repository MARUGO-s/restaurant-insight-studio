-- Add source metadata for gourmet checker reports and allow authenticated users to read shared checker rows only.

ALTER TABLE public.restaurant_insight_reports
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'insight_studio',
  ADD COLUMN IF NOT EXISTS source_url text,
  ADD COLUMN IF NOT EXISTS source_key text;

ALTER TABLE public.restaurant_insight_reports
  DROP CONSTRAINT IF EXISTS restaurant_insight_reports_source_check;

ALTER TABLE public.restaurant_insight_reports
  ADD CONSTRAINT restaurant_insight_reports_source_check
  CHECK (source IN ('insight_studio', 'gourmet_checker'));

ALTER TABLE public.restaurant_insight_reports
  DROP CONSTRAINT IF EXISTS restaurant_insight_reports_source_url_check;

ALTER TABLE public.restaurant_insight_reports
  ADD CONSTRAINT restaurant_insight_reports_source_url_check
  CHECK (source_url IS NULL OR (char_length(source_url) >= 8 AND char_length(source_url) <= 600));

CREATE UNIQUE INDEX IF NOT EXISTS restaurant_insight_reports_source_key_key
  ON public.restaurant_insight_reports (source_key)
  WHERE source_key IS NOT NULL;

COMMENT ON COLUMN public.restaurant_insight_reports.source IS
  'Origin of the row: insight_studio (default) or gourmet_checker (imported weekly HTML).';
COMMENT ON COLUMN public.restaurant_insight_reports.source_url IS
  'Public HTML URL when the checker published the report to GitHub Pages.';
COMMENT ON COLUMN public.restaurant_insight_reports.source_key IS
  'Idempotency key, e.g. gourmet_checker:cavacava:2026-11-21.';

DROP POLICY IF EXISTS restaurant_insight_reports_select_checker ON public.restaurant_insight_reports;

CREATE POLICY restaurant_insight_reports_select_checker
  ON public.restaurant_insight_reports
  FOR SELECT
  TO authenticated
  USING (source = 'gourmet_checker' AND deleted_at IS NULL);
