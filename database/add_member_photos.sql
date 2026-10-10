-- Passport photos for membership cards.
--
-- member_photos maps member_number -> the edited portrait in the public
-- 'member-photos' storage bucket. Public because the card rasteriser
-- (html2canvas) reads the image with a plain <img> — a signed-URL bucket
-- would need a fresh URL baked into every export.
--
-- The photo belongs to the member number, not the card row: a member can
-- have their portrait ready before their card is issued, and it survives
-- card replacement.

CREATE TABLE IF NOT EXISTS public.member_photos (
  member_number TEXT PRIMARY KEY,
  photo_url     TEXT NOT NULL,
  updated_by    TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.member_photos ENABLE ROW LEVEL SECURITY;

CREATE POLICY "member_photos_staff_all" ON public.member_photos FOR ALL TO authenticated
  USING (is_staff()) WITH CHECK (is_staff());

-- Reads are open to any signed-in user: the bucket is already public, so
-- the table's only real value is the URL map — and policyholders need it
-- to see their own photos on the portal. Writes for them go through
-- /api/member-photo (service role after an ownership check), not RLS.
CREATE POLICY "member_photos_auth_read" ON public.member_photos FOR SELECT TO authenticated
  USING (true);

-- Public read bucket for card photos; writes stay staff-only.
INSERT INTO storage.buckets (id, name, public)
VALUES ('member-photos', 'member-photos', true)
ON CONFLICT (id) DO NOTHING;

-- 100MB per photo — signed uploads go straight to storage, so the
-- ceiling is the bucket's own limit, not the API's body size.
UPDATE storage.buckets SET file_size_limit = 104857600 WHERE id = 'member-photos';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'member_photos_public_read') THEN
    CREATE POLICY "member_photos_public_read" ON storage.objects FOR SELECT
      USING (bucket_id = 'member-photos');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'member_photos_staff_write') THEN
    CREATE POLICY "member_photos_staff_write" ON storage.objects FOR ALL TO authenticated
      USING (bucket_id = 'member-photos' AND is_staff())
      WITH CHECK (bucket_id = 'member-photos' AND is_staff());
  END IF;
END $$;
