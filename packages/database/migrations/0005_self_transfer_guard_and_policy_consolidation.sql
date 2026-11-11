-- =============================================================================
-- Wuhoo — Self-transfer guard + organisation-member INSERT policy consolidation
-- 0005_self_transfer_guard_and_policy_consolidation.sql
-- =============================================================================
-- Prerequisites:
--   0001_initial_schema.sql applied
--   0002_storage_policies.sql applied
--   0003_document_publishing_and_mcp_tokens.sql applied
--   0004_fix_collections_rls_recursion.sql applied
--
-- Apply once to the live database. Safe to re-run:
--   Functions:  CREATE OR REPLACE
--   Policies:   DROP POLICY IF EXISTS before CREATE POLICY
--
-- Changes
-- -------
-- Part 1 — Self-transfer guard in transfer_organisation_ownership
--   Adds an explicit check that rejects a transfer when p_new_owner_id equals
--   auth.uid(). Without this guard an owner could call the function with their
--   own user_id, which would succeed silently: the UPDATE SET role = 'owner'
--   is a no-op on their own row, and the subsequent UPDATE SET role = 'admin'
--   would demote them. The enforce_role_assignment_rules trigger does not catch
--   this because it only blocks last-owner demotion, not self-transfer.
--   The check is placed after the caller-role verification (Step 2) and before
--   the new-owner membership read (Step 3), so it fires only for authenticated
--   owners and never leaks information about whether p_new_owner_id is a member.
--
-- Part 2 — INSERT policy consolidation on organisation_members
--   Replaces the two existing INSERT policies:
--     "owners can add members with any role"   — WITH CHECK (is_org_owner(...))
--     "admins can add non-owner members"        — WITH CHECK (is_org_owner_or_admin(...))
--   with a single policy:
--     "owners and admins can add members"       — WITH CHECK (is_org_owner_or_admin(...))
--
--   Security equivalence proof:
--     PostgreSQL evaluates multiple INSERT policies with OR semantics: a row
--     passes if ANY policy's WITH CHECK returns true. The two existing policies
--     therefore permit an INSERT when is_org_owner OR is_org_owner_or_admin is
--     true. Since is_org_owner_or_admin is a superset of is_org_owner, the
--     combined gate is simply is_org_owner_or_admin — identical to the single
--     replacement policy.
--
--     The role restriction (preventing admins from inserting a row with
--     role = 'owner') is NOT enforced by either policy's WITH CHECK expression.
--     RLS WITH CHECK for INSERT cannot reference NEW.role in a meaningful way
--     to compare against the caller's role. This restriction is enforced
--     entirely by the enforce_role_assignment_rules() BEFORE INSERT trigger,
--     which raises an exception when a non-owner attempts to assign role='owner'
--     and at least one member already exists. That trigger is unchanged by this
--     migration and remains the authoritative enforcement point.
--
--   Net permission change: none. Owners and admins retain exactly the same
--   INSERT access they had before. The trigger backstop is unchanged.
-- =============================================================================

BEGIN;

-- =============================================================================
-- Part 1: Self-transfer guard in transfer_organisation_ownership
-- =============================================================================

-- Full function body reproduced from 0001 with the single addition of the
-- self-transfer check between Step 2 and Step 3. All other logic is identical
-- to the committed 0001 version so that CREATE OR REPLACE is a clean replace
-- with no unintended behavioural drift.

CREATE OR REPLACE FUNCTION public.transfer_organisation_ownership(
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
  -- Step 1: acquire org-level lock before any membership read or write.
  PERFORM id
  FROM public.organisations
  WHERE id = p_organisation_id
  FOR UPDATE;

  -- Step 2: verify caller is an owner (read after lock — guaranteed current).
  SELECT role INTO caller_role
  FROM public.organisation_members
  WHERE organisation_id = p_organisation_id
    AND user_id = auth.uid();

  IF caller_role IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'Only an owner can transfer ownership.';
  END IF;

  -- Step 2a: block self-transfer before any membership write.
  -- Placed after the caller-role check so this path is only reachable by
  -- authenticated owners. Does not reveal whether p_new_owner_id is a member.
  IF p_new_owner_id = auth.uid() THEN
    RAISE EXCEPTION 'Cannot transfer ownership to yourself.';
  END IF;

  -- Step 3: verify new owner is already a member.
  SELECT role INTO new_owner_role
  FROM public.organisation_members
  WHERE organisation_id = p_organisation_id
    AND user_id = p_new_owner_id;

  IF new_owner_role IS NULL THEN
    RAISE EXCEPTION 'The new owner must already be a member of the organisation.';
  END IF;

  -- Step 4: promote new owner, then demote caller.
  -- Promote first so the demotion guard in the trigger sees at least one
  -- remaining owner when it counts (the newly promoted one).
  UPDATE public.organisation_members
  SET role = 'owner'
  WHERE organisation_id = p_organisation_id
    AND user_id = p_new_owner_id;

  UPDATE public.organisation_members
  SET role = 'admin'
  WHERE organisation_id = p_organisation_id
    AND user_id = auth.uid();
END;
$$;

-- Grants are unchanged from 0001; repeated here for completeness and to ensure
-- they are correct even if a future migration accidentally widens them.
REVOKE EXECUTE ON FUNCTION public.transfer_organisation_ownership(UUID, UUID) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.transfer_organisation_ownership(UUID, UUID) TO authenticated;


-- =============================================================================
-- Part 2: INSERT policy consolidation on organisation_members
-- =============================================================================

-- Drop both existing policies before creating the replacement.
-- DROP POLICY IF EXISTS is a no-op when the policy does not exist, making this
-- safe to re-run regardless of which policies are currently present.
DROP POLICY IF EXISTS "owners can add members with any role" ON public.organisation_members;
DROP POLICY IF EXISTS "admins can add non-owner members"     ON public.organisation_members;

-- Single replacement policy. is_org_owner_or_admin returns true for both
-- owners and admins, which is the union of the two dropped policies.
-- Role-value restriction (blocking admins from assigning role = 'owner') is
-- enforced by the enforce_role_assignment_rules() BEFORE INSERT trigger, which
-- is not modified by this migration.
DROP POLICY IF EXISTS "owners and admins can add members" ON public.organisation_members;
CREATE POLICY "owners and admins can add members"
  ON public.organisation_members FOR INSERT
  WITH CHECK (public.is_org_owner_or_admin(organisation_id));

COMMIT;

-- =============================================================================
-- End of migration
-- =============================================================================
