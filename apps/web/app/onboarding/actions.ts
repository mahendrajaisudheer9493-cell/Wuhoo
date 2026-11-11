"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

type ActionState = { error: string } | null;

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}

export async function createOrganisation(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  const name = (formData.get("name") as string)?.trim();

  if (!name) {
    return { error: "Organisation name is required." };
  }
  if (name.length > 100) {
    return { error: "Organisation name must be 100 characters or fewer." };
  }

  const supabase = await createClient();

  // Verify the user is authenticated.
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // Idempotency: if the user already has an org, go straight to dashboard.
  const { data: existing } = await supabase
    .from("organisation_members")
    .select("organisation_id")
    .limit(1)
    .single();

  if (existing) redirect("/dashboard");

  // Generate a unique slug. Append a short random suffix to avoid collisions.
  const baseSlug = slugify(name) || "workspace";
  const slug = `${baseSlug}-${Math.random().toString(36).slice(2, 7)}`;

  // Insert the organisation. The DB trigger `add_org_creator_as_owner`
  // automatically inserts the creator into organisation_members as 'owner'.
  // Do NOT manually insert into organisation_members here.
  const { error: insertError } = await supabase
    .from("organisations")
    .insert({ name, slug });

  if (insertError) {
    if (insertError.code === "23505") {
      return { error: "That organisation name is already taken. Please choose another." };
    }
    return { error: insertError.message };
  }

  // Verify the trigger ran and the membership row exists before redirecting.
  const { data: membership } = await supabase
    .from("organisation_members")
    .select("organisation_id")
    .limit(1)
    .single();

  if (!membership) {
    return { error: "Organisation was created but membership could not be confirmed. Please refresh and try again." };
  }

  redirect("/dashboard");
}
