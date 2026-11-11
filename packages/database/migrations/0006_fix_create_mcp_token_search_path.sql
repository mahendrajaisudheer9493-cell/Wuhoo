-- =============================================================================
-- Wuhoo — Fix: schema-qualify gen_random_bytes in create_mcp_token
-- 0006_fix_create_mcp_token_search_path.sql
-- =============================================================================
-- Problem
-- -------
-- create_mcp_token() uses SET search_path = '' (required for SECURITY DEFINER
-- functions to prevent search-path hijacking). With an empty search path,
-- PostgreSQL cannot resolve gen_random_bytes() because Supabase installs
-- pgcrypto into the extensions schema, which is absent from an empty
-- search_path.
--
-- The function body calls:
--   encode(gen_random_bytes(32), 'hex')
--
-- This fails at runtime with:
--   ERROR: function gen_random_bytes(integer) does not exist
--
-- This causes every call to create_mcp_token() to raise an exception, which
-- the server action catches and returns as the generic
-- "Failed to create token. Please try again." message.
--
-- Fix
-- ---
-- Replace the unqualified call with the schema-qualified equivalent:
--   extensions.gen_random_bytes(32)
--
-- Supabase installs pgcrypto into the extensions schema on all hosted
-- projects. Schema-qualifying the call makes it resolvable regardless of
-- the active search_path.
--
-- sha256(bytea) is NOT a pgcrypto function. It is a PostgreSQL built-in
-- (pg_catalog) added in PG 11. PostgreSQL always searches pg_catalog
-- implicitly even when search_path = '', so sha256 resolves correctly
-- without schema qualification and is left unchanged.
--
-- Hash format compatibility:
--   create_mcp_token stores: encode(sha256(raw::bytea), 'hex')
--     → lowercase 64-char hex string
--   MCP server sends:        createHash('sha256').update(raw).digest('hex')
--     → lowercase 64-char hex string
--   resolve_mcp_token compares token_hash via plain TEXT equality.
--   The format is identical — no change needed.
--
-- All other function logic, security attributes, grants, and the role check
-- are identical to the 0003 version.
--
-- IDEMPOTENCY
-- -----------
-- CREATE OR REPLACE FUNCTION — safe to re-run.
-- REVOKE/GRANT — idempotent in PostgreSQL.
-- =============================================================================

BEGIN;

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

  -- Schema-qualify gen_random_bytes: Supabase installs pgcrypto into the
  -- extensions schema. With SET search_path = '' the unqualified name is
  -- not resolvable. sha256() is a pg_catalog built-in (PG >= 11) and is
  -- always visible even with an empty search_path — no qualification needed.
  v_raw_token  := 'wuhoo_' || encode(extensions.gen_random_bytes(32), 'hex');
  v_token_hash := encode(sha256(v_raw_token::bytea), 'hex');

  INSERT INTO public.mcp_tokens (organisation_id, user_id, token_hash, name)
  VALUES (p_organisation_id, auth.uid(), v_token_hash, p_name);

  -- Return the raw token. This is the only time it is available.
  RETURN v_raw_token;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.create_mcp_token(UUID, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.create_mcp_token(UUID, TEXT) TO authenticated;

COMMIT;

-- =============================================================================
-- End of migration
-- =============================================================================
