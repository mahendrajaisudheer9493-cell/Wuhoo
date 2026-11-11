-- =============================================================================
-- Wuhoo — Document Publishing Permissions + MCP Token Infrastructure
-- 0003_document_publishing_and_mcp_tokens.sql
-- =============================================================================
-- Prerequisites:
--   0001_initial_schema.sql applied  (tables, RLS, ownership functions)
--   0002_storage_policies.sql applied (storage bucket policies)
--
-- Apply once to the live database. Do not apply to a database that already
-- has these objects; the migration is idempotent for functions and triggers
-- (CREATE OR REPLACE / DROP IF EXISTS) but CREATE TABLE IF NOT EXISTS is used
-- for mcp_tokens so re-running is safe.
--
-- Changes in this migration
-- ─────────────────────────
-- Part 1 — Document publishing permissions
--   • Replaces the broad "members can update documents" RLS policy from 0001
--     with two role-aware policies.
--   • Adds enforce_document_publish_permission() BEFORE UPDATE trigger on
--     documents. Rejects status changes by editors on the web-app path
--     (auth.uid() set). Passes through on the MCP path when the
--     transaction-local flag wuhoo.mcp_publish_authorised = 'true' is set
--     by the MCP SECURITY DEFINER RPCs after their own role check.
--   • Adds publish_document(UUID) and unpublish_document(UUID) for the web
--     app. Actor is always auth.uid(); no caller-supplied identity.
--
-- Part 2 — MCP token infrastructure
--   • Creates mcp_tokens table. Stores SHA-256 hex digest only; raw token
--     never persisted.
--   • RLS enabled on mcp_tokens with zero client-facing policies. All access
--     goes through SECURITY DEFINER RPCs.
--   • create_mcp_token(UUID, TEXT): issues a token, returns raw value once.
--   • resolve_mcp_token(TEXT): validates hash, updates last_used_at, returns
--     (user_id, organisation_id, role). service_role only.
--   • list_mcp_tokens(UUID): returns metadata (no hash) to authenticated.
--   • revoke_mcp_token(UUID): soft-deletes via revoked_at. Fail-closed.
--   • revoke_mcp_tokens_on_member_removal(): AFTER DELETE trigger on
--     organisation_members; revokes tokens atomically with membership removal.
--   • mcp_publish_document(UUID, TEXT) and mcp_unpublish_document(UUID, TEXT):
--     validate token hash + membership inside the same transaction as the
--     document UPDATE. service_role only.
--
-- IDEMPOTENCY
--   Functions:  CREATE OR REPLACE
--   Triggers:   DROP IF EXISTS before CREATE
--   Policies:   DROP IF EXISTS before CREATE
--   Table:      CREATE TABLE IF NOT EXISTS
-- =============================================================================


-- =============================================================================
-- Part 1: Document publishing permissions
-- =============================================================================


-- ---------------------------------------------------------------------------
-- 1a. Replace the broad documents UPDATE policy from 0001.
--
-- The original "members can update documents" policy allowed any member
-- (including editors) to set status = 'published'. PostgreSQL RLS WITH CHECK
-- cannot reference OLD, so status-change restriction requires a trigger.
-- The policy split below is belt-and-suspenders; the trigger is the
-- authoritative enforcement point.
--
-- "owners and admins can update documents": full UPDATE access including
--   status changes. The trigger will still fire but will pass for these roles.
--
-- "editors can update draft documents": UPDATE access for editors. The trigger
--   rejects any attempt to change status. The policy itself does not restrict
--   columns because WITH CHECK cannot reference OLD.
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "members can update documents"           ON public.documents;
DROP POLICY IF EXISTS "owners and admins can update documents" ON public.documents;
DROP POLICY IF EXISTS "editors can update draft documents"     ON public.documents;

CREATE POLICY "owners and admins can update documents"
  ON public.documents FOR UPDATE
  USING     (public.is_org_owner_or_admin(organisation_id))
  WITH CHECK (public.is_org_owner_or_admin(organisation_id));

CREATE POLICY "editors can update draft documents"
  ON public.documents FOR UPDATE
  USING     (organisation_id IN (SELECT public.my_organisation_ids()))
  WITH CHECK (organisation_id IN (SELECT public.my_organisation_ids()));


-- ---------------------------------------------------------------------------
-- 1b. enforce_document_publish_permission
-- BEFORE UPDATE trigger on documents.
--
-- Fires whenever any column on a documents row is updated. Only acts when
-- OLD.status IS DISTINCT FROM NEW.status (i.e. a publish or unpublish).
--
-- MCP path:
--   mcp_publish_document / mcp_unpublish_document are SECURITY DEFINER
--   functions that run under the function-owner role (service role context).
--   auth.uid() is NULL in that context. Those functions perform their own
--   role check, then call:
--     PERFORM set_config('wuhoo.mcp_publish_authorised', 'true', true);
--   before issuing the UPDATE. set_config(..., true) is transaction-local
--   (SET LOCAL semantics): it cannot persist across separate REST requests
--   and cannot be set by a client directly via PostgREST. The trigger reads
--   this flag and returns NEW immediately, trusting the RPC's prior check.
--
-- Web-app path:
--   auth.uid() is set from the Supabase JWT. The trigger looks up the
--   caller's membership and rejects editors.
--
-- Raw service-role UPDATE (no RPC, no flag):
--   auth.uid() is NULL and the flag is absent. The EXISTS check finds no
--   membership row for NULL. The trigger raises an exception. Fails closed.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.enforce_document_publish_permission()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status THEN

    -- MCP path: flag set by mcp_publish_document / mcp_unpublish_document
    -- within this same transaction after their own role check passed.
    -- current_setting(..., true) returns '' (not NULL) when the setting is
    -- absent, so the comparison is safe without a NULL guard.
    IF current_setting('wuhoo.mcp_publish_authorised', true) = 'true' THEN
      RETURN NEW;
    END IF;

    -- Web-app path: verify via auth.uid().
    -- auth.uid() IS NULL (raw service-role UPDATE, no flag) → EXISTS returns
    -- false → exception raised. Fails closed.
    IF NOT EXISTS (
      SELECT 1
      FROM   public.organisation_members
      WHERE  organisation_id = NEW.organisation_id
        AND  user_id         = auth.uid()
        AND  role IN ('owner', 'admin')
    ) THEN
      RAISE EXCEPTION 'Only owners and admins can publish or unpublish documents.';
    END IF;

  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.enforce_document_publish_permission() FROM PUBLIC;

DROP TRIGGER IF EXISTS documents_enforce_publish_permission ON public.documents;
CREATE TRIGGER documents_enforce_publish_permission
  BEFORE UPDATE ON public.documents
  FOR EACH ROW EXECUTE FUNCTION public.enforce_document_publish_permission();


-- ---------------------------------------------------------------------------
-- 1c. publish_document — web-app path
-- Actor is always auth.uid(). Authenticated users cannot supply an identity.
-- Fail-closed: NULL role (non-member) and 'editor' role are both rejected
-- with an explicit IS NULL OR = 'editor' check, not NOT IN.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.publish_document(
  p_document_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_org_id     UUID;
  v_actor_role TEXT;
BEGIN
  SELECT organisation_id INTO v_org_id
  FROM   public.documents
  WHERE  id = p_document_id;

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'Document % not found.', p_document_id;
  END IF;

  SELECT role INTO v_actor_role
  FROM   public.organisation_members
  WHERE  organisation_id = v_org_id
    AND  user_id         = auth.uid();

  -- Fail closed: NULL means not a member; 'editor' is not permitted.
  IF v_actor_role IS NULL OR v_actor_role = 'editor' THEN
    RAISE EXCEPTION 'Only owners and admins can publish documents.';
  END IF;

  UPDATE public.documents
  SET    status       = 'published',
         published_at = NOW()
  WHERE  id = p_document_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.publish_document(UUID) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.publish_document(UUID) TO authenticated;


-- ---------------------------------------------------------------------------
-- 1d. unpublish_document — web-app path
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.unpublish_document(
  p_document_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_org_id     UUID;
  v_actor_role TEXT;
BEGIN
  SELECT organisation_id INTO v_org_id
  FROM   public.documents
  WHERE  id = p_document_id;

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'Document % not found.', p_document_id;
  END IF;

  SELECT role INTO v_actor_role
  FROM   public.organisation_members
  WHERE  organisation_id = v_org_id
    AND  user_id         = auth.uid();

  IF v_actor_role IS NULL OR v_actor_role = 'editor' THEN
    RAISE EXCEPTION 'Only owners and admins can unpublish documents.';
  END IF;

  UPDATE public.documents
  SET    status       = 'draft',
         published_at = NULL
  WHERE  id = p_document_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.unpublish_document(UUID) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.unpublish_document(UUID) TO authenticated;


-- =============================================================================
-- Part 2: MCP token infrastructure
-- =============================================================================


-- ---------------------------------------------------------------------------
-- 2a. mcp_tokens table
--
-- token_hash: SHA-256 hex digest of the raw bearer token. Raw token is never
--   stored. The MCP server hashes the incoming bearer token before any DB call.
-- name: human-readable label set at creation time (e.g. "Claude Desktop").
-- last_used_at: updated atomically inside mcp_publish_document /
--   mcp_unpublish_document and resolve_mcp_token.
-- revoked_at: NULL = active. Set to NOW() on revocation; never cleared.
--
-- RLS is enabled. Zero client-facing policies are defined. All access goes
-- through SECURITY DEFINER RPCs. service_role bypasses RLS by Supabase
-- convention and is the only role that reads token_hash directly.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.mcp_tokens (
  id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  organisation_id UUID        NOT NULL REFERENCES public.organisations(id)  ON DELETE CASCADE,
  user_id         UUID        NOT NULL REFERENCES auth.users(id)            ON DELETE CASCADE,
  token_hash      TEXT        NOT NULL UNIQUE,
  name            TEXT        NOT NULL DEFAULT '',
  last_used_at    TIMESTAMPTZ,
  revoked_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Partial index: only active tokens. Used by resolve_mcp_token and the MCP
-- publishing RPCs on every request.
CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_tokens_active_hash
  ON public.mcp_tokens(token_hash)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_mcp_tokens_organisation_user
  ON public.mcp_tokens(organisation_id, user_id);

ALTER TABLE public.mcp_tokens ENABLE ROW LEVEL SECURITY;

-- No client-facing policies. Explicit drops for idempotency in case any were
-- created during earlier development iterations.
DROP POLICY IF EXISTS "owners and admins can create mcp tokens" ON public.mcp_tokens;
DROP POLICY IF EXISTS "members can view org mcp tokens"         ON public.mcp_tokens;
DROP POLICY IF EXISTS "owners and admins can revoke any token"  ON public.mcp_tokens;
DROP POLICY IF EXISTS "members can revoke their own tokens"     ON public.mcp_tokens;


-- ---------------------------------------------------------------------------
-- 2b. revoke_mcp_tokens_on_member_removal
-- AFTER DELETE trigger on organisation_members.
-- When a member is removed from an org, all their active tokens for that org
-- are revoked atomically in the same transaction as the membership deletion.
-- This ensures no MCP request can succeed after membership is removed,
-- regardless of whether the MCP server has cached the resolved identity.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.revoke_mcp_tokens_on_member_removal()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.mcp_tokens
  SET    revoked_at = NOW()
  WHERE  organisation_id = OLD.organisation_id
    AND  user_id         = OLD.user_id
    AND  revoked_at      IS NULL;
  RETURN OLD;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.revoke_mcp_tokens_on_member_removal() FROM PUBLIC;

DROP TRIGGER IF EXISTS organisation_members_revoke_mcp_tokens
  ON public.organisation_members;
CREATE TRIGGER organisation_members_revoke_mcp_tokens
  AFTER DELETE ON public.organisation_members
  FOR EACH ROW EXECUTE FUNCTION public.revoke_mcp_tokens_on_member_removal();


-- ---------------------------------------------------------------------------
-- 2c. create_mcp_token
-- Issues a new MCP token for the calling authenticated user.
-- Only owners and admins can create tokens (fail-closed NULL check).
-- Generates a cryptographically random raw token, stores only its SHA-256
-- hex digest, and returns the raw token exactly once.
-- The caller must store the raw token; it cannot be recovered after this call.
-- Token format: 'wuhoo_' + 64 hex chars (32 random bytes) = 70 chars total.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.create_mcp_token(
  p_organisation_id UUID,
  p_name            TEXT DEFAULT ''
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor_role TEXT;
  v_raw_token  TEXT;
  v_token_hash TEXT;
BEGIN
  SELECT role INTO v_actor_role
  FROM   public.organisation_members
  WHERE  organisation_id = p_organisation_id
    AND  user_id         = auth.uid();

  -- Fail closed: NULL means not a member; 'editor' is not permitted.
  IF v_actor_role IS NULL OR v_actor_role = 'editor' THEN
    RAISE EXCEPTION 'Only owners and admins can create MCP tokens.';
  END IF;

  v_raw_token  := 'wuhoo_' || encode(gen_random_bytes(32), 'hex');
  v_token_hash := encode(sha256(v_raw_token::bytea), 'hex');

  INSERT INTO public.mcp_tokens (organisation_id, user_id, token_hash, name)
  VALUES (p_organisation_id, auth.uid(), v_token_hash, p_name);

  -- Return the raw token. This is the only time it is available.
  RETURN v_raw_token;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.create_mcp_token(UUID, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.create_mcp_token(UUID, TEXT) TO authenticated;


-- ---------------------------------------------------------------------------
-- 2d. resolve_mcp_token
-- Called by the MCP server on every incoming request to validate the bearer
-- token and retrieve the caller's current identity and live role.
-- Updates last_used_at atomically.
-- Returns zero rows if the token is invalid or revoked.
-- Returns one row with (user_id, organisation_id, role) if valid.
-- The role is read live from organisation_members, not cached in mcp_tokens,
-- so role changes take effect on the next request.
-- service_role only. Not callable by authenticated or anon.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.resolve_mcp_token(
  p_token_hash TEXT
)
RETURNS TABLE (
  user_id         UUID,
  organisation_id UUID,
  role            TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.mcp_tokens t
  SET    last_used_at = NOW()
  FROM   public.organisation_members m
  WHERE  t.token_hash      = p_token_hash
    AND  t.revoked_at      IS NULL
    AND  m.organisation_id = t.organisation_id
    AND  m.user_id         = t.user_id
  RETURNING t.user_id, t.organisation_id, m.role;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.resolve_mcp_token(TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.resolve_mcp_token(TEXT) TO service_role;


-- ---------------------------------------------------------------------------
-- 2e. list_mcp_tokens
-- Returns token metadata for all tokens in an organisation.
-- token_hash is never returned. Callable by authenticated members.
-- The caller must be a member of p_organisation_id; non-members get zero rows.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.list_mcp_tokens(
  p_organisation_id UUID
)
RETURNS TABLE (
  id           UUID,
  user_id      UUID,
  name         TEXT,
  last_used_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    t.id,
    t.user_id,
    t.name,
    t.last_used_at,
    t.revoked_at,
    t.created_at
  FROM public.mcp_tokens t
  WHERE t.organisation_id = p_organisation_id
    AND EXISTS (
      SELECT 1
      FROM   public.organisation_members m
      WHERE  m.organisation_id = p_organisation_id
        AND  m.user_id         = auth.uid()
    );
$$;

REVOKE EXECUTE ON FUNCTION public.list_mcp_tokens(UUID) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.list_mcp_tokens(UUID) TO authenticated;


-- ---------------------------------------------------------------------------
-- 2f. revoke_mcp_token
-- Soft-deletes a token by setting revoked_at = NOW().
-- revoked_at can only be set, never cleared (idempotent on already-revoked).
-- No other column is written.
--
-- Authorization (fail-closed):
--   Step 1: look up the token's org and owner. Reject if not found.
--   Step 2: look up the caller's role in that specific org.
--            NULL → caller is not a member of this org → reject.
--   Step 3: if caller is owner or admin → permit (any token in their org).
--            if caller is editor and owns the token → permit (self-revocation).
--            otherwise → reject.
--
-- A member of org A cannot revoke a token belonging to org B because the
-- membership lookup in Step 2 is scoped to the token's org_id, not the
-- caller's org.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.revoke_mcp_token(
  p_token_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_org_id      UUID;
  v_token_owner UUID;
  v_actor_role  TEXT;
BEGIN
  -- Step 1: resolve the token's org and owner.
  SELECT organisation_id, user_id
  INTO   v_org_id, v_token_owner
  FROM   public.mcp_tokens
  WHERE  id = p_token_id;

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'Token not found.';
  END IF;

  -- Step 2: look up the caller's role in the token's organisation.
  -- Scoped to v_org_id so cross-org revocation is impossible.
  SELECT role INTO v_actor_role
  FROM   public.organisation_members
  WHERE  organisation_id = v_org_id
    AND  user_id         = auth.uid();

  -- Fail closed: no membership in this org → reject unconditionally.
  IF v_actor_role IS NULL THEN
    RAISE EXCEPTION 'Not authorised to revoke this token.';
  END IF;

  -- Step 3: permission check.
  -- Owners and admins can revoke any token in their org.
  -- Editors can only revoke their own tokens.
  IF v_actor_role = 'editor' AND v_token_owner <> auth.uid() THEN
    RAISE EXCEPTION 'Not authorised to revoke this token.';
  END IF;

  -- Idempotent: already-revoked tokens are a no-op.
  UPDATE public.mcp_tokens
  SET    revoked_at = NOW()
  WHERE  id         = p_token_id
    AND  revoked_at IS NULL;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.revoke_mcp_token(UUID) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.revoke_mcp_token(UUID) TO authenticated;


-- ---------------------------------------------------------------------------
-- 2g. mcp_publish_document — MCP privileged path
-- Validates the bearer token hash, membership, and role inside the same
-- PostgreSQL transaction as the document UPDATE. No cross-request trust.
--
-- Steps:
--   1. Validate token hash: must exist and not be revoked.
--   2. Resolve the document's organisation.
--   3. Confirm the token belongs to the document's organisation.
--   4. Verify the token owner still has owner/admin membership (live lookup).
--   5. Set the transaction-local flag for the trigger.
--   6. Update last_used_at on the token (atomic with the document UPDATE).
--   7. Perform the document status UPDATE.
--
-- p_token_hash: SHA-256 hex digest of the raw bearer token. The raw token
--   never enters the database.
-- service_role only. Not callable by authenticated or anon.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.mcp_publish_document(
  p_document_id UUID,
  p_token_hash  TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_token_user_id UUID;
  v_token_org_id  UUID;
  v_org_id        UUID;
  v_actor_role    TEXT;
BEGIN
  -- Step 1: validate token.
  SELECT user_id, organisation_id
  INTO   v_token_user_id, v_token_org_id
  FROM   public.mcp_tokens
  WHERE  token_hash = p_token_hash
    AND  revoked_at IS NULL;

  IF v_token_user_id IS NULL THEN
    RAISE EXCEPTION 'Invalid or revoked token.';
  END IF;

  -- Step 2: resolve the document's organisation.
  SELECT organisation_id INTO v_org_id
  FROM   public.documents
  WHERE  id = p_document_id;

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'Document % not found.', p_document_id;
  END IF;

  -- Step 3: confirm the token belongs to this document's organisation.
  IF v_token_org_id <> v_org_id THEN
    RAISE EXCEPTION 'Token does not belong to the document''s organisation.';
  END IF;

  -- Step 4: verify the token owner still has owner/admin membership.
  SELECT role INTO v_actor_role
  FROM   public.organisation_members
  WHERE  organisation_id = v_org_id
    AND  user_id         = v_token_user_id;

  -- Fail closed: NULL means membership was removed since token was issued.
  IF v_actor_role IS NULL OR v_actor_role = 'editor' THEN
    RAISE EXCEPTION 'Only owners and admins can publish documents.';
  END IF;

  -- Step 5: set transaction-local flag so the trigger passes through.
  -- set_config(..., true) = SET LOCAL: scoped to this transaction only.
  PERFORM set_config('wuhoo.mcp_publish_authorised', 'true', true);

  -- Step 6: update last_used_at atomically with the document UPDATE.
  UPDATE public.mcp_tokens
  SET    last_used_at = NOW()
  WHERE  token_hash   = p_token_hash;

  -- Step 7: perform the status change.
  UPDATE public.documents
  SET    status       = 'published',
         published_at = NOW()
  WHERE  id = p_document_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.mcp_publish_document(UUID, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.mcp_publish_document(UUID, TEXT) TO service_role;


-- ---------------------------------------------------------------------------
-- 2h. mcp_unpublish_document — MCP privileged path
-- Identical validation sequence to mcp_publish_document.
-- service_role only.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.mcp_unpublish_document(
  p_document_id UUID,
  p_token_hash  TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_token_user_id UUID;
  v_token_org_id  UUID;
  v_org_id        UUID;
  v_actor_role    TEXT;
BEGIN
  -- Step 1: validate token.
  SELECT user_id, organisation_id
  INTO   v_token_user_id, v_token_org_id
  FROM   public.mcp_tokens
  WHERE  token_hash = p_token_hash
    AND  revoked_at IS NULL;

  IF v_token_user_id IS NULL THEN
    RAISE EXCEPTION 'Invalid or revoked token.';
  END IF;

  -- Step 2: resolve the document's organisation.
  SELECT organisation_id INTO v_org_id
  FROM   public.documents
  WHERE  id = p_document_id;

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'Document % not found.', p_document_id;
  END IF;

  -- Step 3: confirm the token belongs to this document's organisation.
  IF v_token_org_id <> v_org_id THEN
    RAISE EXCEPTION 'Token does not belong to the document''s organisation.';
  END IF;

  -- Step 4: verify the token owner still has owner/admin membership.
  SELECT role INTO v_actor_role
  FROM   public.organisation_members
  WHERE  organisation_id = v_org_id
    AND  user_id         = v_token_user_id;

  IF v_actor_role IS NULL OR v_actor_role = 'editor' THEN
    RAISE EXCEPTION 'Only owners and admins can unpublish documents.';
  END IF;

  -- Step 5: set transaction-local flag.
  PERFORM set_config('wuhoo.mcp_publish_authorised', 'true', true);

  -- Step 6: update last_used_at.
  UPDATE public.mcp_tokens
  SET    last_used_at = NOW()
  WHERE  token_hash   = p_token_hash;

  -- Step 7: perform the status change.
  UPDATE public.documents
  SET    status       = 'draft',
         published_at = NULL
  WHERE  id = p_document_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.mcp_unpublish_document(UUID, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.mcp_unpublish_document(UUID, TEXT) TO service_role;


-- =============================================================================
-- End of migration
-- =============================================================================
