import type { SupabaseClientLike as SupabaseClient } from "../supabase.js";

export interface CollectionRow {
  id: string;
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

/** List all collections for an org with document counts. */
export async function listCollections(
  supabase: SupabaseClient,
  organisationId: string
): Promise<CollectionRow[]> {
  const { data, error } = await supabase
    .from("collections")
    .select(`
      id, name, slug, description, position, created_at, updated_at,
      categories ( documents ( id ) )
    `)
    .eq("organisation_id", organisationId)
    .order("position", { ascending: true })
    .order("created_at", { ascending: true });

  if (error || !data) return [];

  return data.map((c: any) => {
    const cats = Array.isArray(c.categories) ? c.categories : [];
    const docCount = cats.reduce((sum: number, cat: any) => {
      return sum + (Array.isArray(cat.documents) ? cat.documents.length : 0);
    }, 0);
    return {
      id: c.id,
      name: c.name,
      slug: c.slug,
      description: c.description,
      position: c.position,
      created_at: c.created_at,
      updated_at: c.updated_at,
      document_count: docCount,
    };
  });
}

export interface CreateCollectionInput {
  name: string;
  description?: string;
}

export interface ServiceResult<T = void> {
  data?: T;
  error?: string;
}

/** Create a collection. RLS enforces org membership on the web path.
 *  On the MCP path the caller must supply the organisation_id from the
 *  resolved token — never from untrusted tool arguments. */
export async function createCollection(
  supabase: SupabaseClient,
  organisationId: string,
  input: CreateCollectionInput
): Promise<ServiceResult<CollectionRow>> {
  const name = input.name.trim();
  if (!name) return { error: "Name is required." };
  if (name.length > 100) return { error: "Name must be 100 characters or fewer." };

  const baseSlug = slugify(name) || "collection";
  const slug = `${baseSlug}-${Math.random().toString(36).slice(2, 6)}`;

  const { data, error } = await supabase
    .from("collections")
    .insert({ organisation_id: organisationId, name, slug, description: input.description ?? null })
    .select("id, name, slug, description, position, created_at, updated_at")
    .single();

  if (error) {
    if (error.code === "23505") return { error: "A collection with that name already exists." };
    return { error: error.message };
  }

  return { data: { ...data, document_count: 0 } };
}

export interface UpdateCollectionInput {
  name?: string;
  description?: string;
}

/** Update a collection's name or description.
 *  AUTHORISATION NOTE: this function accepts a bare collectionId with no
 *  org-scoping check. On the web path RLS enforces membership. On the MCP
 *  path (service-role client, RLS bypassed) the caller MUST verify that the
 *  collection belongs to the resolved token's organisation_id before calling
 *  this function. */
export async function updateCollection(
  supabase: SupabaseClient,
  collectionId: string,
  input: UpdateCollectionInput
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

  const { error } = await supabase
    .from("collections")
    .update(updates)
    .eq("id", collectionId);

  if (error) return { error: error.message };
  return {};
}

/** Delete a collection.
 *  AUTHORISATION NOTE: same as updateCollection — RLS enforces owner/admin
 *  on the web path. MCP path must verify org ownership before calling. */
export async function deleteCollection(
  supabase: SupabaseClient,
  collectionId: string
): Promise<ServiceResult> {
  const { error } = await supabase
    .from("collections")
    .delete()
    .eq("id", collectionId);

  if (error) return { error: error.message };
  return {};
}
