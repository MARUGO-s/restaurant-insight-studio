-- Shared reference files (NG words, recommended words, listing guidance)
-- used by analysis and merge. Soft-delete only. All authenticated app users
-- can read, add, update, and soft-delete, matching the shared workspace model.

CREATE TABLE public.restaurant_insight_reference_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 2000),
  category text NOT NULL CHECK (category IN ('ng_words', 'recommended_words', 'site_improvement', 'other')),
  target_sites text[] NOT NULL DEFAULT ARRAY['all']::text[],
  content text NOT NULL CHECK (char_length(content) BETWEEN 1 AND 200000),
  original_filename text CHECK (original_filename IS NULL OR char_length(original_filename) <= 260),
  mime text CHECK (mime IS NULL OR char_length(mime) <= 200),
  byte_size integer CHECK (byte_size IS NULL OR byte_size >= 0),
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES auth.users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT restaurant_insight_reference_files_sites_valid CHECK (
    target_sites <> '{}'
    AND target_sites <@ ARRAY[
      'all', 'tabelog', 'hotpepper', 'gurunavi', 'ikyu', 'google_maps',
      'retty', 'ozmall', 'hitosara'
    ]::text[]
  )
);

COMMENT ON TABLE public.restaurant_insight_reference_files IS
  'Shared reference documents loaded into Restaurant Insight Studio analysis and merge prompts.';

CREATE INDEX restaurant_insight_reference_files_active_idx
  ON public.restaurant_insight_reference_files (is_active, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE OR REPLACE FUNCTION public.restaurant_insight_touch_reference_file()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO ''
AS $$
begin
  new.updated_at := now();
  return new;
end;
$$;

CREATE TRIGGER restaurant_insight_reference_files_touch
  BEFORE UPDATE ON public.restaurant_insight_reference_files
  FOR EACH ROW
  EXECUTE FUNCTION public.restaurant_insight_touch_reference_file();

ALTER TABLE public.restaurant_insight_reference_files ENABLE ROW LEVEL SECURITY;

CREATE POLICY restaurant_insight_reference_files_select
  ON public.restaurant_insight_reference_files
  FOR SELECT TO authenticated
  USING (deleted_at IS NULL);

CREATE POLICY restaurant_insight_reference_files_insert
  ON public.restaurant_insight_reference_files
  FOR INSERT TO authenticated
  WITH CHECK ((select auth.uid()) = created_by);

CREATE POLICY restaurant_insight_reference_files_update
  ON public.restaurant_insight_reference_files
  FOR UPDATE TO authenticated
  USING (deleted_at IS NULL)
  WITH CHECK (true);

REVOKE ALL ON TABLE public.restaurant_insight_reference_files FROM public, anon;
GRANT SELECT, INSERT, UPDATE ON TABLE public.restaurant_insight_reference_files TO authenticated;
GRANT ALL ON TABLE public.restaurant_insight_reference_files TO service_role;
