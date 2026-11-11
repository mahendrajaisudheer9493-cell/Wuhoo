-- =============================================================================
-- Wuhoo — Storage Policies for bucket: wuhoo-media
-- 0002_storage_policies.sql
-- =============================================================================
-- Run AFTER:
--   1. 0001_initial_schema.sql has been applied.
--   2. The 'wuhoo-media' bucket has been created in the Supabase Storage
--      dashboard and set to PRIVATE (not public).
--
-- Path convention (enforced by application upload code):
--   {organisation_id}/{asset_id}/{filename}
--   e.g. a1b2c3d4-.../e5f6a7b8-.../screenshot.png
--
-- The first segment  (storage.foldername(name))[1]  is the organisation_id.
-- The second segment (storage.foldername(name))[2]  is the asset_id.
--
-- IDEMPOTENCY: Each policy is preceded by DROP POLICY IF EXISTS so this
-- script is safe to re-run.
-- =============================================================================


-- ---------------------------------------------------------------------------
-- INSERT — members can upload files into their organisation's folder
-- ---------------------------------------------------------------------------
-- The first path segment must match an organisation the caller belongs to.
-- This prevents a member of org A from writing into org B's folder.

DROP POLICY IF EXISTS "members can upload to their org folder" ON storage.objects;
CREATE POLICY "members can upload to their org folder"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'wuhoo-media'
    AND (storage.foldername(name))[1]::uuid IN (
      SELECT organisation_id
      FROM   public.organisation_members
      WHERE  user_id = auth.uid()
    )
  );


-- ---------------------------------------------------------------------------
-- SELECT — members can read files from their organisation's folder
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "members can read their org files" ON storage.objects;
CREATE POLICY "members can read their org files"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'wuhoo-media'
    AND (storage.foldername(name))[1]::uuid IN (
      SELECT organisation_id
      FROM   public.organisation_members
      WHERE  user_id = auth.uid()
    )
  );


-- ---------------------------------------------------------------------------
-- SELECT — anonymous users can read screenshot files of published documents
-- ---------------------------------------------------------------------------
-- Videos (type='video') and frames (type='frame') are never exposed publicly.
-- The join goes: storage.objects.name → media_assets.storage_path
--                → document_steps.media_asset_id → documents.status
-- Only rows where type='screenshot' AND document is published pass.

DROP POLICY IF EXISTS "public can read screenshots of published documents" ON storage.objects;
CREATE POLICY "public can read screenshots of published documents"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'wuhoo-media'
    AND EXISTS (
      SELECT 1
      FROM   public.media_assets  ma
      JOIN   public.document_steps ds ON ds.media_asset_id = ma.id
      JOIN   public.documents      d  ON d.id = ds.document_id
      WHERE  ma.storage_path = name
        AND  ma.type         = 'screenshot'
        AND  d.status        = 'published'
    )
  );


-- ---------------------------------------------------------------------------
-- UPDATE — members can update (replace) files in their organisation's folder
-- ---------------------------------------------------------------------------
-- USING checks the existing object; WITH CHECK validates the replacement path.
-- Both segments must belong to the caller's organisation.

DROP POLICY IF EXISTS "members can update their org files" ON storage.objects;
CREATE POLICY "members can update their org files"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'wuhoo-media'
    AND (storage.foldername(name))[1]::uuid IN (
      SELECT organisation_id
      FROM   public.organisation_members
      WHERE  user_id = auth.uid()
    )
  )
  WITH CHECK (
    bucket_id = 'wuhoo-media'
    AND (storage.foldername(name))[1]::uuid IN (
      SELECT organisation_id
      FROM   public.organisation_members
      WHERE  user_id = auth.uid()
    )
  );


-- ---------------------------------------------------------------------------
-- DELETE — only owners and admins can delete files from their org's folder
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "owners and admins can delete org files" ON storage.objects;
CREATE POLICY "owners and admins can delete org files"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'wuhoo-media'
    AND EXISTS (
      SELECT 1
      FROM   public.organisation_members
      WHERE  organisation_id = (storage.foldername(name))[1]::uuid
        AND  user_id         = auth.uid()
        AND  role IN ('owner', 'admin')
    )
  );


-- =============================================================================
-- End of storage policies
-- =============================================================================
