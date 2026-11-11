import type { SupabaseClientLike as SupabaseClient } from "../supabase.js";
import type { ServiceResult } from "./collections";

export interface CategoryRow {
  id: string;
  collection_id: string;
  name: string;
  slug: string;
  description: string | null;
  position: number;
  created_at: string;
  updated_at: string;
  document_count: number;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}

export async function listCategories(
  supabase: SupabaseClient,
  collectionId: string
): Promise<CategoryRow[]> {
  const { data, error } = await supabase
    .from("categories")
    .select("id, collection_id, name, slug, description, position, created_at, updated_at, documents(id)")
    .eq("collection_id", collectionId)
    .order("position", { ascending: true })
    .order("created_at", { ascending: true });

  if (error || !data) return [];

  return data.map((c: any) => ({
    id: c.id,
    collection_id: c.collection_id,
    name: c.name,
    slug: c.slug,
    description: c.description,
    position: c.position,
    created_at: c.created_at,
    updated_at: c.updated_at,
    document_count: Array.isArray(c.documents) ? c.documents.length : 0,
  }));
}

/** Create a category. RLS enforces org membership on the web path.
 *  On the MCP path the caller must supply a collection_id that has already
 *  been verified to belong to the resolved token's organisation_id. */
export async function createCategory(
  supabase: SupabaseClient,
  collectionId: string,
  input: { name: string; description?: string }
): Promise<ServiceResult<CategoryRow>> {
  const name = input.name.trim();
  if (!name) return { error: "Name is required." };
  if (name.length > 100) return { error: "Name must be 100 characters or fewer." };

  const baseSlug = slugify(name) || "category";
  const slug = `${baseSlug}-${Math.random().toString(36).slice(2, 6)}`;

  const { data, error } = await supabase
    .from("categories")
    .insert({ collection_id: collectionId, name, slug, description: input.description ?? null })
    .select("id, collection_id, name, slug, description, position, created_at, updated_at")
    .single();

  if (error) {
    if (error.code === "23505") return { error: "A category with that name already exists." };
    return { error: error.message };
  }

  return { data: { ...data, document_count: 0 } };
}

/** Update a category.
 *  AUTHORISATION NOTE: accepts a bare categoryId with no org-scoping check.
 *  Web path: RLS enforces membership. MCP path: caller must verify the
 *  category's collection belongs to the resolved token's organisation_id. */
export async function updateCategory(
  supabase: SupabaseClient,
  categoryId: string,
  input: { name?: string; description?: string }
): Promise<ServiceResult> {
  const updates: Record<string, string | null> = {};
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) return { error: "Name is required." };
    updates.name = name;
  }
  if (input.description !== undefined) {
    updates.description = input.description.trim() || null;
  }
  if (Object.keys(updates).length === 0) return {};

  const { error } = await supabase.from("categories").update(updates).eq("id", categoryId);
  if (error) return { error: error.message };
  return {};
}

/** Delete a category.
 *  AUTHORISATION NOTE: same as updateCategory — MCP path must verify org
 *  ownership before calling. */
export async function deleteCategory(
  supabase: SupabaseClient,
  categoryId: string
): Promise<ServiceResult> {
  const { error } = await supabase.from("categories").delete().eq("id", categoryId);
  if (error) return { error: error.message };
  return {};
}
