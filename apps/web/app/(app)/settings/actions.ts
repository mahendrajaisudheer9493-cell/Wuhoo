"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireOrganisation } from "@/lib/dal";

export type TokenRow = {
  id: string;
  user_id: string;
  name: string;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
};

export type ActionState = { error?: string; success?: boolean } | null;

// Raw token is returned exactly once on creation and must be shown to the
// user immediately. It is never stored, logged, or included in revalidated
// page data. The action result is transient — it lives only in React state
// until the dialog is closed and cleared.
export type CreateTokenState =
  | { error: string }
  | { rawToken: string; tokenName: string }
  | null;

function getOrg(membership: { organisations: unknown }) {
  return membership.organisations as { id: string; name: string } | null;
}

export async function listTokensAction(): Promise<TokenRow[]> {
  const { membership } = await requireOrganisation();
  const org = getOrg(membership);
  if (!org) return [];

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("list_mcp_tokens", {
    p_organisation_id: org.id,
  });

  if (error || !data) return [];
  return data as TokenRow[];
}

export async function createTokenAction(
  _prev: CreateTokenState,
  formData: FormData
): Promise<CreateTokenState> {
  const name = (formData.get("name") as string | null)?.trim() ?? "";
  if (!name) return { error: "Token name is required." };
  if (name.length > 80) return { error: "Name must be 80 characters or fewer." };

  const { membership } = await requireOrganisation();
  const org = getOrg(membership);
  if (!org) return { error: "Organisation not found." };

  // Enforce owner/admin server-side before calling the RPC.
  // The RPC also enforces this, but we fail fast with a clear message.
  if (membership.role === "editor") {
    return { error: "Only owners and admins can create MCP tokens." };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("create_mcp_token", {
    p_organisation_id: org.id,
    p_name: name,
  });

  if (error) {
    // Never surface raw DB error messages that might contain token material.
    return { error: "Failed to create token. Please try again." };
  }

  // data is the raw token string returned by the RPC exactly once.
  // It is passed back through React state to the client component for
  // one-time display. It is never written to any persistent store.
  revalidatePath("/settings");
  return { rawToken: data as string, tokenName: name };
}

export async function revokeTokenAction(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  const tokenId = (formData.get("token_id") as string | null)?.trim();
  if (!tokenId) return { error: "Token ID is required." };

  // Verify the caller has an active organisation session.
  // The RPC enforces cross-org isolation and role rules (owners/admins can
  // revoke any token; editors can only revoke their own).
  await requireOrganisation();

  const supabase = await createClient();
  const { error } = await supabase.rpc("revoke_mcp_token", {
    p_token_id: tokenId,
  });

  if (error) {
    return { error: "Failed to revoke token. Please try again." };
  }

  revalidatePath("/settings");
  return { success: true };
}
