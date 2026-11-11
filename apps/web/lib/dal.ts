import "server-only";

import { cache } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

/**
 * Returns the authenticated Supabase user, or null if not authenticated.
 * Memoised per request via React cache — safe to call multiple times.
 */
export const getUser = cache(async () => {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  return user;
});

/**
 * Returns the user's primary organisation membership, or null if none.
 * Relies entirely on RLS — no manual filtering needed.
 */
export const getOrganisation = cache(async () => {
  const supabase = await createClient();
  const { data } = await supabase
    .from("organisation_members")
    .select("role, organisations(id, name, slug)")
    .limit(1)
    .single();
  return data ?? null;
});

/**
 * Asserts the user is authenticated. Redirects to /login if not.
 * Use in Server Components and layouts that require auth.
 */
export const requireUser = cache(async () => {
  const user = await getUser();
  if (!user) redirect("/login");
  return user;
});

/**
 * Asserts the user is authenticated AND has an organisation.
 * Redirects to /login or /onboarding as appropriate.
 */
export const requireOrganisation = cache(async () => {
  const user = await requireUser();
  const membership = await getOrganisation();
  if (!membership) redirect("/onboarding");
  return { user, membership };
});
