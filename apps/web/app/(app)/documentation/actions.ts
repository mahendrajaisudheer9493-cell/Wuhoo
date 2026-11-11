"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireOrganisation } from "@/lib/dal";
import { createDocument } from "@/lib/services/documents";

export type ActionState = { error?: string; success?: boolean; id?: string } | null;

export async function createDocumentAction(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  const title = (formData.get("title") as string)?.trim();
  const categoryId = (formData.get("category_id") as string) || null;

  if (!title) return { error: "Title is required." };

  const { membership } = await requireOrganisation();
  const org = membership.organisations as unknown as { id: string } | null;
  if (!org) return { error: "Organisation not found." };

  const supabase = await createClient();
  const result = await createDocument(supabase, org.id, {
    title,
    category_id: categoryId,
    status: "draft",
  });

  if (result.error) return { error: result.error };

  revalidatePath("/documentation");
  redirect(`/documentation/${result.data!.id}`);
}
