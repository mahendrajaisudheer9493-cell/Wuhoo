-- =============================================================================
-- Wuhoo — Initial Schema Migration
-- 0001_initial_schema.sql
-- =============================================================================
-- Review history:
--   v1 — initial schema
--   v2 — security review pass 1 (6 fixes)
--   v3 — security review pass 2 (10 fixes)
--   v4 — security review pass 3 (9 fixes):
--   v5 — two targeted fixes:
--        fix-A  enforce_role_assignment_rules uses IS DISTINCT FROM 'owner'
--               so NULL actor_role (non-member) fails closed
--        fix-B  admins UPDATE policy removes invalid OLD.role/NEW.role RLS
--               references; role restriction delegated entirely to trigger
--        F1  owner-role assignment restricted by assigner role
--        F2  ownership invariant enforced; transfer_organisation_ownership()
--        F3  cross-organisation FK validation triggers
--        F4  public SELECT policies for collections and categories
--        F5  public media_assets SELECT policy + Storage policy section
--        F6  document_versions policies clarified
--        F7  collections.organisation_id and categories.collection_id immutable
--        F8  all CREATE POLICY statements made idempotent
--        F9  final audit fixes (version DELETE, owner-leave guard, NULL guard)
-- =============================================================================
-- IDEMPOTENCY: Safe to re-run. All DDL uses IF NOT EXISTS or CREATE OR REPLACE.
-- All policies use DROP POLICY IF EXISTS before CREATE POLICY.
-- =============================================================================


-- ---------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";


-- ---------------------------------------------------------------------------
-- Trigger helper: set_updated_at
-- ---------------------------------------------------------------------------

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


-- ---------------------------------------------------------------------------
-- Trigger helper: prevent_column_update
-- Raises an exception if a named immutable column is changed after insert.
-- Pass the column name as TG_ARGV[0].
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION prevent_column_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'Column % is immutable and cannot be changed after insert.', TG_ARGV[0];
  RETURN NULL;
END;
$$;


-- ---------------------------------------------------------------------------
-- 1. organisations
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS organisations (
  id         UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  name       TEXT        NOT NULL,
  slug       TEXT        NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE TRIGGER organisations_updated_at
  BEFORE UPDATE ON organisations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ---------------------------------------------------------------------------
-- 2. organisation_members
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS organisation_members (
  id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  organisation_id UUID        NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  user_id         UUID        NOT NULL REFERENCES auth.users(id)    ON DELETE CASCADE,
  role            TEXT        NOT NULL DEFAULT 'editor'
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
-- F7: add_org_creator_as_owner
-- AFTER INSERT on organisations — inserts creator as owner.
-- NULL guard: if auth.uid() is NULL (service-role insert), skips safely.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION add_org_creator_as_owner()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF auth.uid() IS NOT NULL THEN
    INSERT INTO public.organisation_members (organisation_id, user_id, role)
    VALUES (NEW.id, auth.uid(), 'owner');
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER organisations_add_creator_as_owner
  AFTER INSERT ON organisations
  FOR EACH ROW EXECUTE FUNCTION add_org_creator_as_owner();


-- ---------------------------------------------------------------------------
-- F2: enforce_owner_on_member_delete
-- Prevents the last owner from leaving an organisation.
-- Fires BEFORE DELETE on organisation_members.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION enforce_owner_on_member_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  remaining_owners INTEGER;
BEGIN
  IF OLD.role = 'owner' THEN
    SELECT COUNT(*) INTO remaining_owners
    FROM public.organisation_members
    WHERE organisation_id = OLD.organisation_id
      AND role = 'owner'
      AND id <> OLD.id;

    IF remaining_owners = 0 THEN
      RAISE EXCEPTION
        'Cannot remove the last owner of organisation %. Transfer ownership first.',
        OLD.organisation_id;
    END IF;
  END IF;
  RETURN OLD;
END;
$$;

CREATE OR REPLACE TRIGGER organisation_members_enforce_owner_on_delete
  BEFORE DELETE ON organisation_members
  FOR EACH ROW EXECUTE FUNCTION enforce_owner_on_member_delete();


-- ---------------------------------------------------------------------------
-- F1: enforce_role_assignment_rules
-- Prevents admins from assigning or modifying owner-role rows.
-- Fires BEFORE INSERT and BEFORE UPDATE on organisation_members.
-- Rules:
--   - Only an owner can insert a row with role = 'owner'.
--   - Only an owner can change another member's role to 'owner'.
--   - Admins cannot modify rows where the target user is an owner.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION enforce_role_assignment_rules()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_role TEXT;
BEGIN
  SELECT role INTO actor_role
  FROM public.organisation_members
  WHERE organisation_id = NEW.organisation_id
    AND user_id = auth.uid();

  -- Fail closed: if actor_role is NULL the caller is not a member of this org.
  -- IS DISTINCT FROM 'owner' returns TRUE for both NULL and non-owner values.
  IF NEW.role = 'owner' AND actor_role IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'Only an owner can assign the owner role.';
  END IF;

  -- On UPDATE: admins cannot modify a row that currently belongs to an owner.
  -- OLD is valid inside trigger functions (just not in RLS policy expressions).
  IF TG_OP = 'UPDATE' THEN
    IF OLD.role = 'owner' AND actor_role IS DISTINCT FROM 'owner' THEN
      RAISE EXCEPTION 'Only an owner can modify another owner''s membership.';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER organisation_members_enforce_role_assignment
  BEFORE INSERT OR UPDATE ON organisation_members
  FOR EACH ROW EXECUTE FUNCTION enforce_role_assignment_rules();


-- ---------------------------------------------------------------------------
-- F2: transfer_organisation_ownership
-- Atomically transfers ownership from the calling user to new_user_id.
-- The new owner must already be a member of the organisation.
-- Only an existing owner can call this.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION transfer_organisation_ownership(
  p_organisation_id UUID,
  p_new_owner_id    UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  caller_role    TEXT;
  new_owner_role TEXT;
BEGIN
  -- Verify caller is an owner.
  SELECT role INTO caller_role
  FROM public.organisation_members
  WHERE organisation_id = p_organisation_id
    AND user_id = auth.uid();

  IF caller_role <> 'owner' THEN
    RAISE EXCEPTION 'Only an owner can transfer ownership.';
  END IF;

  -- Verify new owner is already a member.
  SELECT role INTO new_owner_role
  FROM public.organisation_members
  WHERE organisation_id = p_organisation_id
    AND user_id = p_new_owner_id;

  IF new_owner_role IS NULL THEN
    RAISE EXCEPTION 'The new owner must already be a member of the organisation.';
  END IF;

  -- Promote new owner.
  UPDATE public.organisation_members
  SET role = 'owner'
  WHERE organisation_id = p_organisation_id
    AND user_id = p_new_owner_id;

  -- Demote current owner to admin.
  UPDATE public.organisation_members
  SET role = 'admin'
  WHERE organisation_id = p_organisation_id
    AND user_id = auth.uid();
END;
$$;

-- Revoke public execute; only authenticated users should call this.
REVOKE EXECUTE ON FUNCTION transfer_organisation_ownership(UUID, UUID) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION transfer_organisation_ownership(UUID, UUID) TO authenticated;


-- ---------------------------------------------------------------------------
-- F3: validate_document_category_org
-- Ensures a document's category belongs to the same organisation.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION validate_document_category_org()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  cat_org_id UUID;
BEGIN
  IF NEW.category_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT c.organisation_id INTO cat_org_id
  FROM public.categories cat
  JOIN public.collections c ON c.id = cat.collection_id
  WHERE cat.id = NEW.category_id;

  IF cat_org_id IS DISTINCT FROM NEW.organisation_id THEN
    RAISE EXCEPTION
      'category_id % belongs to a different organisation than the document.',
      NEW.category_id;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER documents_validate_category_org
  BEFORE INSERT OR UPDATE OF category_id, organisation_id ON documents
  FOR EACH ROW EXECUTE FUNCTION validate_document_category_org();


-- ---------------------------------------------------------------------------
-- F3: validate_step_media_org
-- Ensures a document step's media_asset belongs to the same organisation
-- as the step's parent document.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION validate_step_media_org()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  doc_org_id   UUID;
  asset_org_id UUID;
BEGIN
  IF NEW.media_asset_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT organisation_id INTO doc_org_id
  FROM public.documents
  WHERE id = NEW.document_id;

  SELECT organisation_id INTO asset_org_id
  FROM public.media_assets
  WHERE id = NEW.media_asset_id;

  IF asset_org_id IS DISTINCT FROM doc_org_id THEN
    RAISE EXCEPTION
      'media_asset_id % belongs to a different organisation than the document.',
      NEW.media_asset_id;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER document_steps_validate_media_org
  BEFORE INSERT OR UPDATE OF media_asset_id ON document_steps
  FOR EACH ROW EXECUTE FUNCTION validate_step_media_org();


-- ---------------------------------------------------------------------------
-- 3. collections
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS collections (
  id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  organisation_id UUID        NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  name            TEXT        NOT NULL,
  slug            TEXT        NOT NULL,
  description     TEXT,
  position        INTEGER     NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organisation_id, slug)
);

CREATE OR REPLACE TRIGGER collections_updated_at
  BEFORE UPDATE ON collections
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- F7: collections.organisation_id is immutable.
CREATE OR REPLACE TRIGGER collections_organisation_id_immutable
  BEFORE UPDATE OF organisation_id ON collections
  FOR EACH ROW
  WHEN (OLD.organisation_id IS DISTINCT FROM NEW.organisation_id)
  EXECUTE FUNCTION prevent_column_update('organisation_id');

CREATE INDEX IF NOT EXISTS idx_collections_organisation_id
  ON collections(organisation_id);


-- ---------------------------------------------------------------------------
-- 4. categories
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS categories (
  id            UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  collection_id UUID        NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  name          TEXT        NOT NULL,
  slug          TEXT        NOT NULL,
  description   TEXT,
  position      INTEGER     NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (collection_id, slug)
);

CREATE OR REPLACE TRIGGER categories_updated_at
  BEFORE UPDATE ON categories
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- F7: categories.collection_id is immutable.
CREATE OR REPLACE TRIGGER categories_collection_id_immutable
  BEFORE UPDATE OF collection_id ON categories
  FOR EACH ROW
  WHEN (OLD.collection_id IS DISTINCT FROM NEW.collection_id)
  EXECUTE FUNCTION prevent_column_update('collection_id');

CREATE INDEX IF NOT EXISTS idx_categories_collection_id
  ON categories(collection_id);


-- ---------------------------------------------------------------------------
-- 5. documents
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS documents (
  id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  organisation_id UUID        NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  category_id     UUID                   REFERENCES categories(id)  ON DELETE SET NULL,
  title           TEXT        NOT NULL,
  slug            TEXT        NOT NULL,
  status          TEXT        NOT NULL DEFAULT 'draft'
                                CHECK (status IN ('draft', 'published')),
  created_by      UUID                   REFERENCES auth.users(id)  ON DELETE SET NULL,
  published_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organisation_id, slug)
);

CREATE OR REPLACE TRIGGER documents_updated_at
  BEFORE UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- F4 (v3): documents.organisation_id is immutable.
CREATE OR REPLACE TRIGGER documents_organisation_id_immutable
  BEFORE UPDATE OF organisation_id ON documents
  FOR EACH ROW
  WHEN (OLD.organisation_id IS DISTINCT FROM NEW.organisation_id)
  EXECUTE FUNCTION prevent_column_update('organisation_id');

CREATE INDEX IF NOT EXISTS idx_documents_organisation_id ON documents(organisation_id);
CREATE INDEX IF NOT EXISTS idx_documents_category_id     ON documents(category_id);
CREATE INDEX IF NOT EXISTS idx_documents_status          ON documents(status);


-- ---------------------------------------------------------------------------
-- 6. document_steps
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS document_steps (
  id             UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  document_id    UUID        NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  position       INTEGER     NOT NULL DEFAULT 0,
  heading        TEXT,
  content        TEXT,
  media_asset_id UUID,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE TRIGGER document_steps_updated_at
  BEFORE UPDATE ON document_steps
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- F6 (v3): document_steps.document_id is immutable.
CREATE OR REPLACE TRIGGER document_steps_document_id_immutable
  BEFORE UPDATE OF document_id ON document_steps
  FOR EACH ROW
  WHEN (OLD.document_id IS DISTINCT FROM NEW.document_id)
  EXECUTE FUNCTION prevent_column_update('document_id');

CREATE INDEX IF NOT EXISTS idx_document_steps_document_id
  ON document_steps(document_id);


-- ---------------------------------------------------------------------------
-- 7. media_assets
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS media_assets (
  id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  organisation_id UUID        NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  uploaded_by     UUID                   REFERENCES auth.users(id)  ON DELETE SET NULL,
  type            TEXT        NOT NULL CHECK (type IN ('screenshot', 'video', 'frame')),
  storage_path    TEXT        NOT NULL,
  mime_type       TEXT,
  size_bytes      BIGINT,
  width_px        INTEGER,
  height_px       INTEGER,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- F5 (v3): media_assets.organisation_id is immutable.
CREATE OR REPLACE TRIGGER media_assets_organisation_id_immutable
  BEFORE UPDATE OF organisation_id ON media_assets
  FOR EACH ROW
  WHEN (OLD.organisation_id IS DISTINCT FROM NEW.organisation_id)
  EXECUTE FUNCTION prevent_column_update('organisation_id');

CREATE INDEX IF NOT EXISTS idx_media_assets_organisation_id
  ON media_assets(organisation_id);

-- F2 (v3): Idempotent FK from document_steps to media_assets.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_document_steps_media_asset'
  ) THEN
    ALTER TABLE document_steps
      ADD CONSTRAINT fk_document_steps_media_asset
      FOREIGN KEY (media_asset_id) REFERENCES media_assets(id) ON DELETE SET NULL;
  END IF;
END;
$$;


-- ---------------------------------------------------------------------------
-- 8. document_versions
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS document_versions (
  id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  document_id UUID        NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version     INTEGER     NOT NULL DEFAULT 1,
  snapshot    JSONB       NOT NULL,
  created_by  UUID                   REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (document_id, version)
);

CREATE INDEX IF NOT EXISTS idx_document_versions_document_id
  ON document_versions(document_id);

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
-- Both use SECURITY DEFINER + SET search_path = '' + fully-qualified names.
-- ---------------------------------------------------------------------------

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

CREATE OR REPLACE FUNCTION is_org_owner(org_id UUID)
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
      AND  role            = 'owner'
  );
$$;


-- =============================================================================
-- RLS Policies — all idempotent via DROP POLICY IF EXISTS (F8)
-- =============================================================================


-- ---------------------------------------------------------------------------
-- organisations
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "authenticated users can create organisations" ON organisations;
CREATE POLICY "authenticated users can create organisations"
  ON organisations FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS "members can view their organisations" ON organisations;
CREATE POLICY "members can view their organisations"
  ON organisations FOR SELECT
  USING (id IN (SELECT my_organisation_ids()));

DROP POLICY IF EXISTS "owners and admins can update organisation" ON organisations;
CREATE POLICY "owners and admins can update organisation"
  ON organisations FOR UPDATE
  USING     (is_org_owner_or_admin(id))
  WITH CHECK (is_org_owner_or_admin(id));

DROP POLICY IF EXISTS "owners can delete organisation" ON organisations;
CREATE POLICY "owners can delete organisation"
  ON organisations FOR DELETE
  USING (is_org_owner(id));


-- ---------------------------------------------------------------------------
-- organisation_members
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "members can view organisation members" ON organisation_members;
CREATE POLICY "members can view organisation members"
  ON organisation_members FOR SELECT
  USING (organisation_id IN (SELECT my_organisation_ids()));

-- F1: Owners can add members with any role.
--     Admins can add members only — the enforce_role_assignment_rules trigger
--     rejects any INSERT with role = 'owner' by a non-owner at the data layer.
--     NEW is not available in RLS WITH CHECK for INSERT; role restriction is
--     enforced entirely by the trigger. The policy only gates org membership.
DROP POLICY IF EXISTS "owners can add members with any role" ON organisation_members;
CREATE POLICY "owners can add members with any role"
  ON organisation_members FOR INSERT
  WITH CHECK (is_org_owner(organisation_id));

DROP POLICY IF EXISTS "admins can add non-owner members" ON organisation_members;
CREATE POLICY "admins can add non-owner members"
  ON organisation_members FOR INSERT
  WITH CHECK (is_org_owner_or_admin(organisation_id));

-- F1: Only owners can update any member row.
--     Admins can update editor/admin rows but not owner rows, and not their own.
--     Self-promotion is blocked by user_id <> auth.uid().
DROP POLICY IF EXISTS "owners can update any member role" ON organisation_members;
CREATE POLICY "owners can update any member role"
  ON organisation_members FOR UPDATE
  USING (
    is_org_owner(organisation_id)
    AND user_id <> auth.uid()
  )
  WITH CHECK (
    is_org_owner(organisation_id)
    AND user_id <> auth.uid()
  );

-- Admins can update rows where the stored role is not 'owner', and not their own row.
-- OLD/NEW are not available in RLS expressions — the stored role is read via subquery.
-- The enforce_role_assignment_rules trigger prevents the new role being set to 'owner'.
DROP POLICY IF EXISTS "admins can update non-owner members" ON organisation_members;
CREATE POLICY "admins can update non-owner members"
  ON organisation_members FOR UPDATE
  USING (
    is_org_owner_or_admin(organisation_id)
    AND user_id <> auth.uid()
    AND role    <> 'owner'
  )
  WITH CHECK (
    is_org_owner_or_admin(organisation_id)
    AND user_id <> auth.uid()
    AND role    <> 'owner'
  );

-- F1: Admins cannot delete owner rows.
DROP POLICY IF EXISTS "owners can remove any member" ON organisation_members;
CREATE POLICY "owners can remove any member"
  ON organisation_members FOR DELETE
  USING (is_org_owner(organisation_id));

DROP POLICY IF EXISTS "admins can remove non-owner members" ON organisation_members;
CREATE POLICY "admins can remove non-owner members"
  ON organisation_members FOR DELETE
  USING (
    is_org_owner_or_admin(organisation_id)
    AND role <> 'owner'
  );

-- F2: Any member can leave, but the enforce_owner_on_member_delete trigger
--     prevents the last owner from leaving without transferring ownership.
DROP POLICY IF EXISTS "members can remove themselves" ON organisation_members;
CREATE POLICY "members can remove themselves"
  ON organisation_members FOR DELETE
  USING (user_id = auth.uid());


-- ---------------------------------------------------------------------------
-- collections
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "members can view collections" ON collections;
CREATE POLICY "members can view collections"
  ON collections FOR SELECT
  USING (organisation_id IN (SELECT my_organisation_ids()));

-- F4: Anonymous users can see collections that contain at least one published document.
DROP POLICY IF EXISTS "public can view collections with published documents" ON collections;
CREATE POLICY "public can view collections with published documents"
  ON collections FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM   public.documents d
      JOIN   public.categories cat ON cat.id = d.category_id
      WHERE  cat.collection_id = collections.id
        AND  d.status = 'published'
    )
  );

DROP POLICY IF EXISTS "members can insert collections" ON collections;
CREATE POLICY "members can insert collections"
  ON collections FOR INSERT
  WITH CHECK (organisation_id IN (SELECT my_organisation_ids()));

DROP POLICY IF EXISTS "members can update collections" ON collections;
CREATE POLICY "members can update collections"
  ON collections FOR UPDATE
  USING     (organisation_id IN (SELECT my_organisation_ids()))
  WITH CHECK (organisation_id IN (SELECT my_organisation_ids()));

DROP POLICY IF EXISTS "owners and admins can delete collections" ON collections;
CREATE POLICY "owners and admins can delete collections"
  ON collections FOR DELETE
  USING (is_org_owner_or_admin(organisation_id));


-- ---------------------------------------------------------------------------
-- categories
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "members can view categories" ON categories;
CREATE POLICY "members can view categories"
  ON categories FOR SELECT
  USING (
    collection_id IN (
      SELECT id FROM public.collections
      WHERE organisation_id IN (SELECT my_organisation_ids())
    )
  );

-- F4: Anonymous users can see categories that contain at least one published document.
DROP POLICY IF EXISTS "public can view categories with published documents" ON categories;
CREATE POLICY "public can view categories with published documents"
  ON categories FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM   public.documents d
      WHERE  d.category_id = categories.id
        AND  d.status = 'published'
    )
  );

DROP POLICY IF EXISTS "members can insert categories" ON categories;
CREATE POLICY "members can insert categories"
  ON categories FOR INSERT
  WITH CHECK (
    collection_id IN (
      SELECT id FROM public.collections
      WHERE organisation_id IN (SELECT my_organisation_ids())
    )
  );

DROP POLICY IF EXISTS "members can update categories" ON categories;
CREATE POLICY "members can update categories"
  ON categories FOR UPDATE
  USING (
    collection_id IN (
      SELECT id FROM public.collections
      WHERE organisation_id IN (SELECT my_organisation_ids())
    )
  )
  WITH CHECK (
    collection_id IN (
      SELECT id FROM public.collections
      WHERE organisation_id IN (SELECT my_organisation_ids())
    )
  );

DROP POLICY IF EXISTS "owners and admins can delete categories" ON categories;
CREATE POLICY "owners and admins can delete categories"
  ON categories FOR DELETE
  USING (
    collection_id IN (
      SELECT id FROM public.collections
      WHERE is_org_owner_or_admin(organisation_id)
    )
  );


-- ---------------------------------------------------------------------------
-- documents
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "public can view published documents" ON documents;
CREATE POLICY "public can view published documents"
  ON documents FOR SELECT
  USING (status = 'published');

DROP POLICY IF EXISTS "members can view all documents" ON documents;
CREATE POLICY "members can view all documents"
  ON documents FOR SELECT
  USING (organisation_id IN (SELECT my_organisation_ids()));

DROP POLICY IF EXISTS "members can create documents" ON documents;
CREATE POLICY "members can create documents"
  ON documents FOR INSERT
  WITH CHECK (organisation_id IN (SELECT my_organisation_ids()));

DROP POLICY IF EXISTS "members can update documents" ON documents;
CREATE POLICY "members can update documents"
  ON documents FOR UPDATE
  USING     (organisation_id IN (SELECT my_organisation_ids()))
  WITH CHECK (organisation_id IN (SELECT my_organisation_ids()));

DROP POLICY IF EXISTS "owners and admins can delete documents" ON documents;
CREATE POLICY "owners and admins can delete documents"
  ON documents FOR DELETE
  USING (is_org_owner_or_admin(organisation_id));


-- ---------------------------------------------------------------------------
-- document_steps
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "public can view steps of published documents" ON document_steps;
CREATE POLICY "public can view steps of published documents"
  ON document_steps FOR SELECT
  USING (
    document_id IN (
      SELECT id FROM public.documents WHERE status = 'published'
    )
  );

DROP POLICY IF EXISTS "members can view document steps" ON document_steps;
CREATE POLICY "members can view document steps"
  ON document_steps FOR SELECT
  USING (
    document_id IN (
      SELECT id FROM public.documents
      WHERE organisation_id IN (SELECT my_organisation_ids())
    )
  );

DROP POLICY IF EXISTS "members can insert document steps" ON document_steps;
CREATE POLICY "members can insert document steps"
  ON document_steps FOR INSERT
  WITH CHECK (
    document_id IN (
      SELECT id FROM public.documents
      WHERE organisation_id IN (SELECT my_organisation_ids())
    )
  );

DROP POLICY IF EXISTS "members can update document steps" ON document_steps;
CREATE POLICY "members can update document steps"
  ON document_steps FOR UPDATE
  USING (
    document_id IN (
      SELECT id FROM public.documents
      WHERE organisation_id IN (SELECT my_organisation_ids())
    )
  )
  WITH CHECK (
    document_id IN (
      SELECT id FROM public.documents
      WHERE organisation_id IN (SELECT my_organisation_ids())
    )
  );

DROP POLICY IF EXISTS "owners and admins can delete document steps" ON document_steps;
CREATE POLICY "owners and admins can delete document steps"
  ON document_steps FOR DELETE
  USING (
    document_id IN (
      SELECT id FROM public.documents
      WHERE is_org_owner_or_admin(organisation_id)
    )
  );


-- ---------------------------------------------------------------------------
-- media_assets
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "members can view media assets" ON media_assets;
CREATE POLICY "members can view media assets"
  ON media_assets FOR SELECT
  USING (organisation_id IN (SELECT my_organisation_ids()));

-- F5: Anonymous users can view screenshot assets referenced by published document steps.
--     Videos and frames are never exposed publicly.
DROP POLICY IF EXISTS "public can view screenshots of published documents" ON media_assets;
CREATE POLICY "public can view screenshots of published documents"
  ON media_assets FOR SELECT
  USING (
    type = 'screenshot'
    AND EXISTS (
      SELECT 1
      FROM   public.document_steps ds
      JOIN   public.documents d ON d.id = ds.document_id
      WHERE  ds.media_asset_id = media_assets.id
        AND  d.status = 'published'
    )
  );

DROP POLICY IF EXISTS "members can upload media assets" ON media_assets;
CREATE POLICY "members can upload media assets"
  ON media_assets FOR INSERT
  WITH CHECK (organisation_id IN (SELECT my_organisation_ids()));

DROP POLICY IF EXISTS "members can update media assets" ON media_assets;
CREATE POLICY "members can update media assets"
  ON media_assets FOR UPDATE
  USING     (organisation_id IN (SELECT my_organisation_ids()))
  WITH CHECK (organisation_id IN (SELECT my_organisation_ids()));

DROP POLICY IF EXISTS "owners and admins can delete media assets" ON media_assets;
CREATE POLICY "owners and admins can delete media assets"
  ON media_assets FOR DELETE
  USING (is_org_owner_or_admin(organisation_id));


-- ---------------------------------------------------------------------------
-- document_versions
-- F6: Members can read versions. No client INSERT/UPDATE.
--     Only owners can delete versions (editors and admins cannot).
--     Server-side publishing uses the service role which bypasses RLS.
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "members can view document versions" ON document_versions;
CREATE POLICY "members can view document versions"
  ON document_versions FOR SELECT
  USING (
    document_id IN (
      SELECT id FROM public.documents
      WHERE organisation_id IN (SELECT my_organisation_ids())
    )
  );

-- F9: Only owners can delete version history.
DROP POLICY IF EXISTS "owners can delete document versions" ON document_versions;
CREATE POLICY "owners can delete document versions"
  ON document_versions FOR DELETE
  USING (
    document_id IN (
      SELECT id FROM public.documents
      WHERE is_org_owner(organisation_id)
    )
  );


-- =============================================================================
-- End of migration
-- =============================================================================
