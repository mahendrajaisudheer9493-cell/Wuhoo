"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

type ActionState = { error: string } | null;

export async function login(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const email = formData.get("email") as string;
  const password = formData.get("password") as string;

  if (!email || !password) {
    return { error: "Email and password are required." };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    return { error: error.message };
  }

  // Check whether the user has an organisation to decide where to send them.
  const { data: membership } = await supabase
    .from("organisation_members")
    .select("organisation_id")
    .limit(1)
    .single();

  if (!membership) {
    redirect("/onboarding");
  }

  redirect("/dashboard");
}
