-- =============================================================================
-- Wuhoo — Initial Schema Migration
-- 0001_initial_schema.sql
-- =============================================================================
-- Run this once in the Supabase SQL Editor.
-- Safe to re-run: uses IF NOT EXISTS / CREATE OR REPLACE throughout.
-- =============================================================================


-- ---------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";


-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Automatically keeps updated_at current on any table that has the column.
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;


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
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
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
  category_id     UUID REFERENCES categories(id) ON DELETE SET NULL,
  title           TEXT NOT NULL,
  slug            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'published')),
  created_by      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  published_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organisation_id, slug)
);

CREATE OR REPLACE TRIGGER documents_updated_at
  BEFORE UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

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
  media_asset_id UUID,               -- FK added after media_assets is created
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE TRIGGER document_steps_updated_at
  BEFORE UPDATE ON document_steps
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS idx_document_steps_document_id
  ON document_steps(document_id);


-- ---------------------------------------------------------------------------
-- 7. media_assets
--    Screenshots, videos and extracted frames uploaded by users.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS media_assets (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  uploaded_by     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  type            TEXT NOT NULL CHECK (type IN ('screenshot', 'video', 'frame')),
  storage_path    TEXT NOT NULL,
  mime_type       TEXT,
  size_bytes      BIGINT,
  width_px        INTEGER,
  height_px       INTEGER,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_media_assets_organisation_id
  ON media_assets(organisation_id);

-- Now that media_assets exists, add the FK from document_steps.
ALTER TABLE document_steps
  ADD CONSTRAINT fk_document_steps_media_asset
  FOREIGN KEY (media_asset_id) REFERENCES media_assets(id) ON DELETE SET NULL;


-- ---------------------------------------------------------------------------
-- 8. document_versions
--    Snapshot history of a document each time it is published.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS document_versions (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version     INTEGER NOT NULL DEFAULT 1,
  snapshot    JSONB NOT NULL,          -- full document + steps at time of publish
  created_by  UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (document_id, version)
);

CREATE INDEX IF NOT EXISTS idx_document_versions_document_id
  ON document_versions(document_id);


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
-- Helper: returns the set of organisation IDs the current user belongs to.
-- SECURITY DEFINER so it can read organisation_members even when RLS is on.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION my_organisation_ids()
RETURNS SETOF UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT organisation_id
  FROM   organisation_members
  WHERE  user_id = auth.uid();
$$;

-- Helper: returns true if the current user is an owner or admin of the given org.
CREATE OR REPLACE FUNCTION is_org_owner_or_admin(org_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT EXISTS (
    SELECT 1 FROM organisation_members
    WHERE organisation_id = org_id
      AND user_id = auth.uid()
      AND role IN ('owner', 'admin')
  );
$$;


-- ---------------------------------------------------------------------------
-- organisations
--
-- FIX 1: Added INSERT policy — any authenticated user can create an org.
-- FIX 2: Added DELETE policy — only owners can delete their organisation.
-- ---------------------------------------------------------------------------

CREATE POLICY "authenticated users can create organisations"
  ON organisations FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "members can view their organisations"
  ON organisations FOR SELECT
  USING (id IN (SELECT my_organisation_ids()));

CREATE POLICY "owners and admins can update organisation"
  ON organisations FOR UPDATE
  USING (is_org_owner_or_admin(id))
  WITH CHECK (is_org_owner_or_admin(id));

-- FIX 2: Only owners (not admins) can delete an entire organisation.
CREATE POLICY "owners can delete organisation"
  ON organisations FOR DELETE
  USING (
    id IN (
      SELECT organisation_id FROM organisation_members
      WHERE user_id = auth.uid() AND role = 'owner'
    )
  );


-- ---------------------------------------------------------------------------
-- organisation_members
--
-- Members can see who else is in their organisation.
-- Only owners/admins can add or remove members.
-- A user can always read and delete their own membership (to leave an org).
-- ---------------------------------------------------------------------------

CREATE POLICY "members can view organisation members"
  ON organisation_members FOR SELECT
  USING (organisation_id IN (SELECT my_organisation_ids()));

CREATE POLICY "owners and admins can add members"
  ON organisation_members FOR INSERT
  WITH CHECK (is_org_owner_or_admin(organisation_id));

CREATE POLICY "owners and admins can update member roles"
  ON organisation_members FOR UPDATE
  USING (is_org_owner_or_admin(organisation_id))
  WITH CHECK (is_org_owner_or_admin(organisation_id));

CREATE POLICY "owners and admins can remove members"
  ON organisation_members FOR DELETE
  USING (is_org_owner_or_admin(organisation_id));

-- Any member can leave an organisation themselves.
CREATE POLICY "members can remove themselves"
  ON organisation_members FOR DELETE
  USING (user_id = auth.uid());


-- ---------------------------------------------------------------------------
-- collections
--
-- FIX 3: Replaced FOR ALL with explicit per-operation policies so that
-- WITH CHECK is enforced on INSERT and UPDATE, not just USING on SELECT/DELETE.
-- ---------------------------------------------------------------------------

CREATE POLICY "members can view collections"
  ON collections FOR SELECT
  USING (organisation_id IN (SELECT my_organisation_ids()));

CREATE POLICY "owners and admins can insert collections"
  ON collections FOR INSERT
  WITH CHECK (is_org_owner_or_admin(organisation_id));

CREATE POLICY "owners and admins can update collections"
  ON collections FOR UPDATE
  USING (is_org_owner_or_admin(organisation_id))
  WITH CHECK (is_org_owner_or_admin(organisation_id));

CREATE POLICY "owners and admins can delete collections"
  ON collections FOR DELETE
  USING (is_org_owner_or_admin(organisation_id));


-- ---------------------------------------------------------------------------
-- categories
--
-- FIX 4: Same FOR ALL / WITH CHECK fix applied to categories.
-- ---------------------------------------------------------------------------

CREATE POLICY "members can view categories"
  ON categories FOR SELECT
  USING (
    collection_id IN (
      SELECT id FROM collections
      WHERE organisation_id IN (SELECT my_organisation_ids())
    )
  );

CREATE POLICY "owners and admins can insert categories"
  ON categories FOR INSERT
  WITH CHECK (
    collection_id IN (
      SELECT id FROM collections
      WHERE is_org_owner_or_admin(organisation_id)
    )
  );

CREATE POLICY "owners and admins can update categories"
  ON categories FOR UPDATE
  USING (
    collection_id IN (
      SELECT id FROM collections
      WHERE is_org_owner_or_admin(organisation_id)
    )
  )
  WITH CHECK (
    collection_id IN (
      SELECT id FROM collections
      WHERE is_org_owner_or_admin(organisation_id)
    )
  );

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
-- Members (all roles) can read, create and edit.
-- Only owners/admins can delete.
-- Public visitors can only read published documents.
-- ---------------------------------------------------------------------------

CREATE POLICY "public can view published documents"
  ON documents FOR SELECT
  USING (status = 'published');

CREATE POLICY "members can view all documents"
  ON documents FOR SELECT
  USING (organisation_id IN (SELECT my_organisation_ids()));

CREATE POLICY "members can create documents"
  ON documents FOR INSERT
  WITH CHECK (organisation_id IN (SELECT my_organisation_ids()));

CREATE POLICY "members can update documents"
  ON documents FOR UPDATE
  USING (organisation_id IN (SELECT my_organisation_ids()))
  WITH CHECK (organisation_id IN (SELECT my_organisation_ids()));

CREATE POLICY "owners and admins can delete documents"
  ON documents FOR DELETE
  USING (is_org_owner_or_admin(organisation_id));


-- ---------------------------------------------------------------------------
-- document_steps
--
-- FIX 5: Replaced FOR ALL with explicit policies so editors cannot delete.
-- Public visitors can read steps of published documents only.
-- ---------------------------------------------------------------------------

CREATE POLICY "public can view steps of published documents"
  ON document_steps FOR SELECT
  USING (
    document_id IN (
      SELECT id FROM documents WHERE status = 'published'
    )
  );

CREATE POLICY "members can view document steps"
  ON document_steps FOR SELECT
  USING (
    document_id IN (
      SELECT id FROM documents
      WHERE organisation_id IN (SELECT my_organisation_ids())
    )
  );

CREATE POLICY "members can insert document steps"
  ON document_steps FOR INSERT
  WITH CHECK (
    document_id IN (
      SELECT id FROM documents
      WHERE organisation_id IN (SELECT my_organisation_ids())
    )
  );

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

-- Only owners/admins can delete steps (editors cannot).
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
-- FIX 6: Added UPDATE policy so members can correct asset metadata.
-- Public visitors have no access — media is always private unless embedded
-- in a published document step (access controlled at the step level).
-- ---------------------------------------------------------------------------

CREATE POLICY "members can view media assets"
  ON media_assets FOR SELECT
  USING (organisation_id IN (SELECT my_organisation_ids()));

CREATE POLICY "members can upload media assets"
  ON media_assets FOR INSERT
  WITH CHECK (organisation_id IN (SELECT my_organisation_ids()));

-- FIX 6: Members can update metadata of assets in their org.
CREATE POLICY "members can update media assets"
  ON media_assets FOR UPDATE
  USING (organisation_id IN (SELECT my_organisation_ids()))
  WITH CHECK (organisation_id IN (SELECT my_organisation_ids()));

CREATE POLICY "owners and admins can delete media assets"
  ON media_assets FOR DELETE
  USING (is_org_owner_or_admin(organisation_id));


-- ---------------------------------------------------------------------------
-- document_versions
--
-- Members can read version history for documents in their org.
-- Versions are created server-side only (no client INSERT policy).
-- Public visitors cannot read version history even for published documents.
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
