"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createCategory, updateCategory, deleteCategory } from "@/lib/services/categories";

export type ActionState = { error?: string; success?: boolean } | null;

export async function createCategoryAction(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  const collectionId = formData.get("collection_id") as string;
  const name = (formData.get("name") as string)?.trim();
  const description = (formData.get("description") as string)?.trim();

  if (!collectionId) return { error: "Collection ID is required." };
  if (!name) return { error: "Name is required." };

  const supabase = await createClient();
  const result = await createCategory(supabase, collectionId, { name, description });

  if (result.error) return { error: result.error };

  revalidatePath("/collections");
  return { success: true };
}

export async function updateCategoryAction(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  const id = formData.get("id") as string;
  const name = (formData.get("name") as string)?.trim();
  const description = (formData.get("description") as string)?.trim();

  if (!id) return { error: "Category ID is required." };

  const supabase = await createClient();
  const result = await updateCategory(supabase, id, { name, description });

  if (result.error) return { error: result.error };

  revalidatePath("/collections");
  return { success: true };
}

export async function deleteCategoryAction(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  const id = formData.get("id") as string;
  if (!id) return { error: "Category ID is required." };

  const supabase = await createClient();
  const result = await deleteCategory(supabase, id);

  if (result.error) return { error: result.error };

  revalidatePath("/collections");
  return { success: true };
}
