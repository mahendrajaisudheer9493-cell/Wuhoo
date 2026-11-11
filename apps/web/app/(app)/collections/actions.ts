"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireOrganisation } from "@/lib/dal";
import {
  createCollection,
  updateCollection,
  deleteCollection,
} from "@/lib/services/collections";

export type ActionState = { error?: string; success?: boolean } | null;

export async function createCollectionAction(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  const name = (formData.get("name") as string)?.trim();
  const description = (formData.get("description") as string)?.trim();

  if (!name) return { error: "Name is required." };

  const { membership } = await requireOrganisation();
  const org = membership.organisations as unknown as { id: string } | null;
  if (!org) return { error: "Organisation not found." };

  const supabase = await createClient();
  const result = await createCollection(supabase, org.id, { name, description });

  if (result.error) return { error: result.error };

  revalidatePath("/collections");
  return { success: true };
}

export async function updateCollectionAction(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  const id = formData.get("id") as string;
  const name = (formData.get("name") as string)?.trim();
  const description = (formData.get("description") as string)?.trim();

  if (!id) return { error: "Collection ID is required." };

  const supabase = await createClient();
  const result = await updateCollection(supabase, id, { name, description });

  if (result.error) return { error: result.error };

  revalidatePath("/collections");
  return { success: true };
}

export async function deleteCollectionAction(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  const id = formData.get("id") as string;
  if (!id) return { error: "Collection ID is required." };

  const supabase = await createClient();
  const result = await deleteCollection(supabase, id);

  if (result.error) return { error: result.error };

  revalidatePath("/collections");
  return { success: true };
}
