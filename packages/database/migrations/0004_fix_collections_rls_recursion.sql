-- =============================================================================
-- Wuhoo — Fix: infinite recursion in collections RLS policy
-- 0004_fix_collections_rls_recursion.sql
-- =============================================================================
-- Problem
-- -------
-- The policy "public can view collections with published documents" (0001,
-- F4 block) contains an inline EXISTS subquery:
--
--   EXISTS (
--     SELECT 1
--     FROM   public.documents d
--     JOIN   public.categories cat ON cat.id = d.category_id
--     WHERE  cat.collection_id = collections.id
--       AND  d.status = 'published'
--   )
--
-- When PostgreSQL evaluates this subquery it must read from categories.
-- Reading categories triggers the categories SELECT policies, one of which
-- ("members can view categories") queries back into collections:
--
--   collection_id IN (
--     SELECT id FROM public.collections
--     WHERE organisation_id IN (SELECT my_organisation_ids())
--   )
--
-- That re-entry into collections triggers all collections SELECT policies
-- again — including the public one — producing infinite recursion:
--
--   collections SELECT
--     → categories JOIN in EXISTS subquery
--       → categories SELECT policies fire
--         → "members can view categories" queries collections
--           → collections SELECT policies fire again  ← CYCLE
--
-- PostgreSQL detects this and raises:
--   "infinite recursion detected in policy for relation collections"
--
-- Fix
-- ---
-- Replace the inline EXISTS subquery with a call to a new SECURITY DEFINER
-- helper function: private.collection_has_published_document(UUID).
--
-- SECURITY DEFINER executes as the function owner (postgres / superuser),
-- which bypasses RLS on documents and categories. The subquery therefore
-- runs without re-entering the collections RLS evaluation stack.
--
-- The function is placed in the private schema, which PostgREST does not
-- expose. It cannot be called as a Supabase RPC endpoint by any client.
-- Any public schema version from an earlier draft is explicitly dropped.
--
-- Schema placement and PostgREST exposure
-- ----------------------------------------
-- Supabase PostgREST exposes functions as RPC endpoints only for schemas
-- listed in the db_schemas setting (PGRST_DB_SCHEMAS environment variable).
-- The Supabase hosted platform defaults this to "public" only.
--
-- No supabase/config.toml exists in this repository — the project connects
-- directly to the hosted Supabase instance without a local CLI project.
-- The db_schemas value is therefore controlled entirely by the Supabase
-- dashboard / platform defaults and is confirmed as "public" only.
-- The private schema is not listed and will not be added. Functions in
-- private are invisible to the PostgREST RPC router regardless of any
-- EXECUTE grants on those functions.
--
-- Execution order rationale
-- -------------------------
-- The policy must be dropped BEFORE the public function is dropped.
-- If the collections policy currently references
-- public.collection_has_published_document, PostgreSQL tracks it as a
-- dependency. Attempting to DROP FUNCTION while that dependency exists
-- raises "cannot drop function ... because other objects depend on it".
-- Dropping the policy first removes the dependency, allowing the function
-- drop to succeed unconditionally in all three states:
--
--   State A: public function does not exist, policy references inline EXISTS
--            → DROP POLICY succeeds (removes inline policy)
--            → DROP FUNCTION IF EXISTS is a no-op
--
--   State B: public function exists, policy does NOT reference it
--            (earlier draft created the function but policy was not yet
--            updated, or migration was partially applied)
--            → DROP POLICY succeeds (removes whichever policy exists)
--            → DROP FUNCTION succeeds (no dependent policy)
--
--   State C: public function exists AND policy references it
--            (migration was applied once with the public schema version)
--            → DROP POLICY removes the dependent policy first
--            → DROP FUNCTION succeeds (dependency gone)
--
-- Scope
-- -----
-- This migration makes exactly five changes:
--   1. Drops the collections SELECT policy (removes any function dependency).
--   2. Drops public.collection_has_published_document(UUID) if it exists.
--   3. Creates the private schema if it does not already exist and
--      configures schema-level privileges.
--   4. Creates private.collection_has_published_document(UUID) and
--      configures function-level privileges.
--   5. Recreates the collections SELECT policy using the private helper.
--
-- All other policies on collections, categories, documents, document_steps,
-- media_assets, document_versions, organisations, and organisation_members
-- are left completely unchanged.
--
-- IDEMPOTENCY
-- -----------
-- Safe to re-run in any state:
--   • Policy drop:   DROP POLICY IF EXISTS — no-op if already absent
--   • Function drop: DROP FUNCTION IF EXISTS — no-op if already absent
--   • Schema:        CREATE SCHEMA IF NOT EXISTS — no-op if already exists
--   • Schema grants: REVOKE/GRANT are idempotent in PostgreSQL
--   • Function:      CREATE OR REPLACE FUNCTION — replaces if already exists
--   • Fn grants:     REVOKE/GRANT are idempotent in PostgreSQL
--   • Policy create: DROP POLICY IF EXISTS then CREATE POLICY — always clean
-- =============================================================================


-- ---------------------------------------------------------------------------
-- Step 1: Drop the collections SELECT policy.
--
-- Must happen before dropping the public function (Step 2). If the policy
-- currently references public.collection_has_published_document, PostgreSQL
-- will refuse to drop the function while the dependency exists. Dropping the
-- policy first eliminates the dependency in all possible states.
-- DROP POLICY IF EXISTS is a no-op when the policy does not exist.
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "public can view collections with published documents"
  ON public.collections;


-- ---------------------------------------------------------------------------
-- Step 2: Drop the public schema version of the helper if it exists.
--
-- CREATE OR REPLACE cannot move a function between schemas. Any version of
-- this function previously created in public must be explicitly removed to
-- prevent it remaining as a live PostgREST-accessible RPC endpoint.
-- The policy drop in Step 1 ensures no dependent object remains.
-- DROP FUNCTION IF EXISTS is a no-op when the function does not exist.
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.collection_has_published_document(UUID);


-- ---------------------------------------------------------------------------
-- Step 3: Create the private schema and configure schema-level privileges.
--
-- CREATE SCHEMA IF NOT EXISTS is a no-op when the schema already exists.
--
-- REVOKE ALL ON SCHEMA private FROM PUBLIC removes the default CREATE and
-- USAGE privileges that PostgreSQL grants to PUBLIC on new schemas. This
-- prevents any role from creating objects inside private.
--
-- GRANT USAGE ON SCHEMA private TO anon, authenticated is required so that
-- PostgreSQL can resolve the schema-qualified name private.<function> when
-- evaluating the RLS policy expression. Without USAGE the policy expression
-- raises "permission denied for schema private" for both anon and
-- authenticated callers, silently blocking all collection reads.
-- USAGE grants name resolution only — it does not grant access to any
-- objects inside the schema.
-- ---------------------------------------------------------------------------

CREATE SCHEMA IF NOT EXISTS private;

REVOKE ALL   ON SCHEMA private FROM PUBLIC;
GRANT  USAGE ON SCHEMA private TO anon, authenticated;


-- ---------------------------------------------------------------------------
-- Step 4: Create the SECURITY DEFINER helper in the private schema and
--         configure function-level privileges.
--
-- Reads public.documents and public.categories with RLS bypassed. The
-- function executes as its owner (postgres — a superuser with implicit
-- BYPASSRLS). FORCE ROW LEVEL SECURITY is not set on either table in any
-- migration, so the superuser bypass is unconditional.
--
-- Returns TRUE  if the collection contains at least one published document
--               reachable via any of its categories.
-- Returns FALSE for collections with no published documents and for
--               collection IDs that do not exist (EXISTS returns false).
--
-- STABLE:               no side-effects; result is consistent within a
--                       single statement execution.
-- SECURITY DEFINER:     executes as owner (postgres), bypassing RLS on
--                       public.documents and public.categories, breaking
--                       the recursive policy evaluation cycle.
-- SET search_path = '': prevents search-path hijacking. All table
--                       references are fully qualified (public.*).
-- RETURNS BOOLEAN:      only a single bit reaches the caller. No document
--                       content, category data, organisation identifiers,
--                       or user data is exposed through the return value.
--
-- REVOKE EXECUTE FROM PUBLIC removes the broad default. GRANT EXECUTE to
-- anon and authenticated is the minimum required for RLS policy evaluation:
--   anon:          the public visibility policy evaluates under anon for
--                  unauthenticated requests.
--   authenticated: authenticated users also trigger this policy; PostgreSQL
--                  evaluates all applicable SELECT policies for a role.
--   service_role:  not granted — service_role bypasses RLS entirely and
--                  never evaluates policy expressions.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION private.collection_has_published_document(
  p_collection_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM   public.documents  d
    JOIN   public.categories cat ON cat.id = d.category_id
    WHERE  cat.collection_id = p_collection_id
      AND  d.status          = 'published'
  );
$$;

REVOKE EXECUTE ON FUNCTION private.collection_has_published_document(UUID) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION private.collection_has_published_document(UUID) TO anon, authenticated;


-- ---------------------------------------------------------------------------
-- Step 5: Recreate the collections SELECT policy using the private helper.
--
-- The policy name, table, and operation (FOR SELECT) are identical to the
-- 0001 version. Only the USING expression changes: the inline EXISTS
-- subquery is replaced by a call to the private SECURITY DEFINER function,
-- which evaluates the same logic without re-entering the collections RLS
-- evaluation stack.
-- ---------------------------------------------------------------------------

CREATE POLICY "public can view collections with published documents"
  ON public.collections FOR SELECT
  USING (private.collection_has_published_document(id));


-- =============================================================================
-- End of migration
-- =============================================================================
