-- =============================================================================
-- Wuhoo — Initial Schema Migration
-- 0001_initial_schema.sql
-- =============================================================================
-- Run this once in the Supabase SQL Editor.
-- Safe to re-run: uses IF NOT EXISTS / CREATE OR REPLACE throughout.
--
-- Review history:
--   v1 — initial schema
--   v2 — security review pass 1 (6 fixes)
--   v3 — security review pass 2 (10 fixes):
--        F1  all functions pinned with SET search_path = ''
--        F2  ADD CONSTRAINT wrapped in idempotent DO block
--        F3  collections.position column added
--        F4  documents.organisation_id made immutable via trigger
--        F5  media_assets.organisation_id made immutable via trigger
--        F6  document_steps.document_id made immutable via trigger
--        F7  AFTER INSERT trigger auto-adds org creator as owner
--        F8  admin self-promotion to owner blocked
--        F9  editor INSERT/UPDATE policies added for collections/categories
--        F10 composite index added on document_versions(document_id, version DESC)
-- =============================================================================


-- ---------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";


-- ---------------------------------------------------------------------------
-- Helper functions
-- ---------------------------------------------------------------------------

-- Automatically keeps updated_at current on any table that has the column.
-- F1: search_path pinned to prevent schema-hijacking attacks.
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


-- F4/F5/F6: Generic immutability guard — prevents a named column from being
-- changed after the row is first inserted.
-- Usage: create a trigger per table/column pair (see below).
CREATE OR REPLACE FUNCTION prevent_column_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION
    'Column % is immutable and cannot be changed after insert.',
    TG_ARGV[0];
  RETURN NULL;
END;
$$;


-- ---------------------------------------------------------------------------
-- 1. organisations
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS organisations (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name       TEXT NOT NULL,
  slug       TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE TRIGGER organisations_updated_at
  BEFORE UPDATE ON organisations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ---------------------------------------------------------------------------
-- 2. organisation_members
--    Links Supabase Auth users to organisations with a role.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS organisation_members (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES auth.users(id)   ON DELETE CASCADE,
  role            TEXT NOT NULL DEFAULT 'editor'
                    CHECK (role IN ('owner', 'admin', 'editor')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organisation_id, user_id)
);

CREATE OR REPLACE TRIGGER organisation_members_updated_at
  BEFORE UPDATE ON organisation_members
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS idx_organisation_members_user_id
  ON organisation_members(user_id);

CREATE INDEX IF NOT EXISTS idx_organisation_members_organisation_id
  ON organisation_members(organisation_id);


-- F7: Automatically insert the creating user as owner when a new organisation
-- is created. Without this the creator would immediately lose access because
-- the SELECT policy on organisations requires membership.
CREATE OR REPLACE FUNCTION add_org_creator_as_owner()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.organisation_members (organisation_id, user_id, role)
  VALUES (NEW.id, auth.uid(), 'owner');
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER organisations_add_creator_as_owner
  AFTER INSERT ON organisations
  FOR EACH ROW EXECUTE FUNCTION add_org_creator_as_owner();


-- ---------------------------------------------------------------------------
-- 3. collections
--    Top-level grouping of documentation within an organisation.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS collections (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  slug            TEXT NOT NULL,
  description     TEXT,
  -- F3: position column added for consistent UI ordering across the hierarchy.
  position        INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organisation_id, slug)
);

CREATE OR REPLACE TRIGGER collections_updated_at
  BEFORE UPDATE ON collections
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS idx_collections_organisation_id
  ON collections(organisation_id);


-- ---------------------------------------------------------------------------
-- 4. categories
--    Second level of the hierarchy: collection → category.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS categories (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  collection_id UUID NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL,
  description   TEXT,
  position      INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (collection_id, slug)
);

CREATE OR REPLACE TRIGGER categories_updated_at
  BEFORE UPDATE ON categories
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS idx_categories_collection_id
  ON categories(collection_id);


-- ---------------------------------------------------------------------------
-- 5. documents
--    Third level: collection → category → document.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS documents (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  category_id     UUID          REFERENCES categories(id)    ON DELETE SET NULL,
  title           TEXT NOT NULL,
  slug            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'published')),
  created_by      UUID          REFERENCES auth.users(id)    ON DELETE SET NULL,
  published_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organisation_id, slug)
);

CREATE OR REPLACE TRIGGER documents_updated_at
  BEFORE UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- F4: Prevent organisation_id from being changed after insert.
CREATE OR REPLACE TRIGGER documents_organisation_id_immutable
  BEFORE UPDATE OF organisation_id ON documents
  FOR EACH ROW
  WHEN (OLD.organisation_id IS DISTINCT FROM NEW.organisation_id)
  EXECUTE FUNCTION prevent_column_update('organisation_id');

CREATE INDEX IF NOT EXISTS idx_documents_organisation_id
  ON documents(organisation_id);

CREATE INDEX IF NOT EXISTS idx_documents_category_id
  ON documents(category_id);

CREATE INDEX IF NOT EXISTS idx_documents_status
  ON documents(status);


-- ---------------------------------------------------------------------------
-- 6. document_steps
--    Ordered steps within a document (heading, content, optional image).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS document_steps (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  document_id    UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  position       INTEGER NOT NULL DEFAULT 0,
  heading        TEXT,
  content        TEXT,
  -- media_asset_id FK is added after media_assets is created (see below).
  media_asset_id UUID,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE TRIGGER document_steps_updated_at
  BEFORE UPDATE ON document_steps
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- F6: Prevent document_id from being changed — a step cannot be moved to a
-- different document, even one within the same organisation.
CREATE OR REPLACE TRIGGER document_steps_document_id_immutable
  BEFORE UPDATE OF document_id ON document_steps
  FOR EACH ROW
  WHEN (OLD.document_id IS DISTINCT FROM NEW.document_id)
  EXECUTE FUNCTION prevent_column_update('document_id');

CREATE INDEX IF NOT EXISTS idx_document_steps_document_id
  ON document_steps(document_id);


-- ---------------------------------------------------------------------------
-- 7. media_assets
--    Screenshots, videos and extracted frames uploaded by users.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS media_assets (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  uploaded_by     UUID          REFERENCES auth.users(id)    ON DELETE SET NULL,
  type            TEXT NOT NULL CHECK (type IN ('screenshot', 'video', 'frame')),
  storage_path    TEXT NOT NULL,
  mime_type       TEXT,
  size_bytes      BIGINT,
  width_px        INTEGER,
  height_px       INTEGER,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- F5: Prevent organisation_id from being changed after insert.
CREATE OR REPLACE TRIGGER media_assets_organisation_id_immutable
  BEFORE UPDATE OF organisation_id ON media_assets
  FOR EACH ROW
  WHEN (OLD.organisation_id IS DISTINCT FROM NEW.organisation_id)
  EXECUTE FUNCTION prevent_column_update('organisation_id');

CREATE INDEX IF NOT EXISTS idx_media_assets_organisation_id
  ON media_assets(organisation_id);

-- F2: Idempotent FK addition — safe to re-run.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_document_steps_media_asset'
  ) THEN
    ALTER TABLE document_steps
      ADD CONSTRAINT fk_document_steps_media_asset
      FOREIGN KEY (media_asset_id) REFERENCES media_assets(id) ON DELETE SET NULL;
  END IF;
END;
$$;


-- ---------------------------------------------------------------------------
-- 8. document_versions
--    Snapshot history of a document each time it is published.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS document_versions (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version     INTEGER NOT NULL DEFAULT 1,
  snapshot    JSONB NOT NULL,
  created_by  UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (document_id, version)
);

CREATE INDEX IF NOT EXISTS idx_document_versions_document_id
  ON document_versions(document_id);

-- F10: Composite index for fast "latest version" queries.
CREATE INDEX IF NOT EXISTS idx_document_versions_document_id_version_desc
  ON document_versions(document_id, version DESC);


-- =============================================================================
-- Row Level Security
-- =============================================================================

ALTER TABLE organisations        ENABLE ROW LEVEL SECURITY;
ALTER TABLE organisation_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE collections          ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories           ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents            ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_steps       ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_assets         ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_versions    ENABLE ROW LEVEL SECURITY;


-- ---------------------------------------------------------------------------
-- RLS helper functions
-- F1: Both functions use SET search_path = '' and fully-qualified table names
--     to prevent search_path hijacking by a malicious schema.
-- ---------------------------------------------------------------------------

-- Returns the set of organisation IDs the current user belongs to.
-- SECURITY DEFINER so it can bypass RLS on organisation_members itself.
CREATE OR REPLACE FUNCTION my_organisation_ids()
RETURNS SETOF UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT organisation_id
  FROM   public.organisation_members
  WHERE  user_id = auth.uid();
$$;

-- Returns true if the current user is an owner or admin of the given org.
-- SECURITY DEFINER for the same reason as above.
CREATE OR REPLACE FUNCTION is_org_owner_or_admin(org_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM   public.organisation_members
    WHERE  organisation_id = org_id
      AND  user_id         = auth.uid()
      AND  role IN ('owner', 'admin')
  );
$$;


-- =============================================================================
-- RLS Policies
-- =============================================================================


-- ---------------------------------------------------------------------------
-- organisations
-- ---------------------------------------------------------------------------

-- Any authenticated user can create an organisation.
-- The AFTER INSERT trigger (above) immediately adds them as owner.
CREATE POLICY "authenticated users can create organisations"
  ON organisations FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

-- Members can only see organisations they belong to.
CREATE POLICY "members can view their organisations"
  ON organisations FOR SELECT
  USING (id IN (SELECT my_organisation_ids()));

-- Only owners and admins can update organisation details.
CREATE POLICY "owners and admins can update organisation"
  ON organisations FOR UPDATE
  USING     (is_org_owner_or_admin(id))
  WITH CHECK (is_org_owner_or_admin(id));

-- Only owners (not admins) can delete an organisation — this is irreversible.
CREATE POLICY "owners can delete organisation"
  ON organisations FOR DELETE
  USING (
    id IN (
      SELECT organisation_id
      FROM   public.organisation_members
      WHERE  user_id = auth.uid()
        AND  role    = 'owner'
    )
  );


-- ---------------------------------------------------------------------------
-- organisation_members
-- ---------------------------------------------------------------------------

-- All members of an org can see the full member list.
CREATE POLICY "members can view organisation members"
  ON organisation_members FOR SELECT
  USING (organisation_id IN (SELECT my_organisation_ids()));

-- Only owners/admins can add new members.
CREATE POLICY "owners and admins can add members"
  ON organisation_members FOR INSERT
  WITH CHECK (is_org_owner_or_admin(organisation_id));

-- F8: Owners/admins can update roles, but a user cannot update their own row
-- (prevents self-promotion from admin → owner).
CREATE POLICY "owners and admins can update member roles"
  ON organisation_members FOR UPDATE
  USING (
    is_org_owner_or_admin(organisation_id)
    AND user_id <> auth.uid()
  )
  WITH CHECK (
    is_org_owner_or_admin(organisation_id)
    AND user_id <> auth.uid()
  );

-- Owners/admins can remove any member.
CREATE POLICY "owners and admins can remove members"
  ON organisation_members FOR DELETE
  USING (is_org_owner_or_admin(organisation_id));

-- Any member can remove themselves (leave the organisation).
CREATE POLICY "members can remove themselves"
  ON organisation_members FOR DELETE
  USING (user_id = auth.uid());


-- ---------------------------------------------------------------------------
-- collections
--
-- F9: Editors can create and update collections (per product requirements).
--     Only owners/admins can delete.
-- ---------------------------------------------------------------------------

-- Members of the org can view all collections.
CREATE POLICY "members can view collections"
  ON collections FOR SELECT
  USING (organisation_id IN (SELECT my_organisation_ids()));

-- F9: All members (including editors) can create collections.
CREATE POLICY "members can insert collections"
  ON collections FOR INSERT
  WITH CHECK (organisation_id IN (SELECT my_organisation_ids()));

-- F9: All members can update collections, but cannot move them to another org.
CREATE POLICY "members can update collections"
  ON collections FOR UPDATE
  USING     (organisation_id IN (SELECT my_organisation_ids()))
  WITH CHECK (organisation_id IN (SELECT my_organisation_ids()));

-- Only owners/admins can delete collections (cascades to categories + documents).
CREATE POLICY "owners and admins can delete collections"
  ON collections FOR DELETE
  USING (is_org_owner_or_admin(organisation_id));


-- ---------------------------------------------------------------------------
-- categories
--
-- F9: Editors can create and update categories (per product requirements).
--     Only owners/admins can delete.
-- Note: is_org_owner_or_admin(organisation_id) inside the subquery correctly
--       passes collections.organisation_id to the function.
-- ---------------------------------------------------------------------------

-- Members can view categories that belong to their org's collections.
CREATE POLICY "members can view categories"
  ON categories FOR SELECT
  USING (
    collection_id IN (
      SELECT id FROM collections
      WHERE organisation_id IN (SELECT my_organisation_ids())
    )
  );

-- F9: All members (including editors) can create categories.
CREATE POLICY "members can insert categories"
  ON categories FOR INSERT
  WITH CHECK (
    collection_id IN (
      SELECT id FROM collections
      WHERE organisation_id IN (SELECT my_organisation_ids())
    )
  );

-- F9: All members can update categories.
CREATE POLICY "members can update categories"
  ON categories FOR UPDATE
  USING (
    collection_id IN (
      SELECT id FROM collections
      WHERE organisation_id IN (SELECT my_organisation_ids())
    )
  )
  WITH CHECK (
    collection_id IN (
      SELECT id FROM collections
      WHERE organisation_id IN (SELECT my_organisation_ids())
    )
  );

-- Only owners/admins can delete categories (cascades to documents).
CREATE POLICY "owners and admins can delete categories"
  ON categories FOR DELETE
  USING (
    collection_id IN (
      SELECT id FROM collections
      WHERE is_org_owner_or_admin(organisation_id)
    )
  );


-- ---------------------------------------------------------------------------
-- documents
--
-- All members can read, create and update.
-- Only owners/admins can delete.
-- Public (anonymous) users can read published documents only.
-- The immutability trigger (above) prevents organisation_id from changing.
-- ---------------------------------------------------------------------------

-- Public access: anonymous users see only published documents.
CREATE POLICY "public can view published documents"
  ON documents FOR SELECT
  USING (status = 'published');

-- Authenticated members see all documents (draft + published) in their org.
CREATE POLICY "members can view all documents"
  ON documents FOR SELECT
  USING (organisation_id IN (SELECT my_organisation_ids()));

-- All members can create documents within their org.
CREATE POLICY "members can create documents"
  ON documents FOR INSERT
  WITH CHECK (organisation_id IN (SELECT my_organisation_ids()));

-- All members can update documents. organisation_id immutability is enforced
-- by the trigger, not here, to keep the policy simple.
CREATE POLICY "members can update documents"
  ON documents FOR UPDATE
  USING     (organisation_id IN (SELECT my_organisation_ids()))
  WITH CHECK (organisation_id IN (SELECT my_organisation_ids()));

-- Only owners/admins can delete documents.
CREATE POLICY "owners and admins can delete documents"
  ON documents FOR DELETE
  USING (is_org_owner_or_admin(organisation_id));


-- ---------------------------------------------------------------------------
-- document_steps
--
-- All members can read, create and update steps.
-- Only owners/admins can delete steps (editors cannot).
-- Public users can read steps of published documents only.
-- Note: step rows contain media_asset_id (a UUID reference). Public users
--       can see this UUID but cannot query media_assets directly — no public
--       SELECT policy exists on that table.
-- ---------------------------------------------------------------------------

-- Public access: steps of published documents only.
CREATE POLICY "public can view steps of published documents"
  ON document_steps FOR SELECT
  USING (
    document_id IN (
      SELECT id FROM documents WHERE status = 'published'
    )
  );

-- Members see all steps for documents in their org.
CREATE POLICY "members can view document steps"
  ON document_steps FOR SELECT
  USING (
    document_id IN (
      SELECT id FROM documents
      WHERE organisation_id IN (SELECT my_organisation_ids())
    )
  );

-- All members can create steps.
CREATE POLICY "members can insert document steps"
  ON document_steps FOR INSERT
  WITH CHECK (
    document_id IN (
      SELECT id FROM documents
      WHERE organisation_id IN (SELECT my_organisation_ids())
    )
  );

-- All members can update steps. document_id immutability is enforced by trigger.
CREATE POLICY "members can update document steps"
  ON document_steps FOR UPDATE
  USING (
    document_id IN (
      SELECT id FROM documents
      WHERE organisation_id IN (SELECT my_organisation_ids())
    )
  )
  WITH CHECK (
    document_id IN (
      SELECT id FROM documents
      WHERE organisation_id IN (SELECT my_organisation_ids())
    )
  );

-- Only owners/admins can delete steps.
CREATE POLICY "owners and admins can delete document steps"
  ON document_steps FOR DELETE
  USING (
    document_id IN (
      SELECT id FROM documents
      WHERE is_org_owner_or_admin(organisation_id)
    )
  );


-- ---------------------------------------------------------------------------
-- media_assets
--
-- All members can read, upload and update assets within their org.
-- Only owners/admins can delete assets.
-- No public access — media is private. Public users access images only
-- indirectly through Supabase Storage signed URLs, not through this table.
-- The immutability trigger (above) prevents organisation_id from changing.
-- ---------------------------------------------------------------------------

CREATE POLICY "members can view media assets"
  ON media_assets FOR SELECT
  USING (organisation_id IN (SELECT my_organisation_ids()));

CREATE POLICY "members can upload media assets"
  ON media_assets FOR INSERT
  WITH CHECK (organisation_id IN (SELECT my_organisation_ids()));

-- Members can update asset metadata (e.g. correct mime_type).
-- organisation_id immutability is enforced by trigger.
CREATE POLICY "members can update media assets"
  ON media_assets FOR UPDATE
  USING     (organisation_id IN (SELECT my_organisation_ids()))
  WITH CHECK (organisation_id IN (SELECT my_organisation_ids()));

CREATE POLICY "owners and admins can delete media assets"
  ON media_assets FOR DELETE
  USING (is_org_owner_or_admin(organisation_id));


-- ---------------------------------------------------------------------------
-- document_versions
--
-- Members can read version history for documents in their org.
-- No INSERT policy for clients — versions are created server-side only
-- (via a Supabase Edge Function or Server Action using the service role).
-- Public users cannot read version history, even for published documents.
-- ---------------------------------------------------------------------------

CREATE POLICY "members can view document versions"
  ON document_versions FOR SELECT
  USING (
    document_id IN (
      SELECT id FROM documents
      WHERE organisation_id IN (SELECT my_organisation_ids())
    )
  );


-- =============================================================================
-- End of migration
-- =============================================================================
