import type { SupabaseClientLike as SupabaseClient } from "../supabase.js";
import type { ServiceResult } from "./collections";
import type { StepRow } from "./steps";

export interface DocumentRow {
  id: string;
  title: string;
  slug: string;
  status: "draft" | "published";
  published_at: string | null;
  created_at: string;
  updated_at: string;
  category: { id: string; name: string; collection: { id: string; name: string } | null } | null;
}

export interface DocumentDetail extends DocumentRow {
  description: string | null;
  steps: StepRow[];
}

export interface DocumentStats {
  total: number;
  published: number;
  draft: number;
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/** Aggregate counts for the dashboard metrics. */
export async function getDocumentStats(
  supabase: SupabaseClient,
  organisationId: string
): Promise<DocumentStats> {
  const { data, error } = await supabase
    .from("documents")
    .select("status")
    .eq("organisation_id", organisationId);

  if (error || !data) return { total: 0, published: 0, draft: 0 };

  const total = data.length;
  const published = (data as any[]).filter((d: any) => d.status === "published").length;
  return { total, published, draft: total - published };
}

/** Recent documents for the dashboard — last 5 updated. */
export async function getRecentDocuments(
  supabase: SupabaseClient,
  organisationId: string,
  limit = 5
): Promise<DocumentRow[]> {
  const { data, error } = await supabase
    .from("documents")
    .select(`
      id, title, slug, status, published_at, created_at, updated_at,
      categories ( id, name, collections ( id, name ) )
    `)
    .eq("organisation_id", organisationId)
    .order("updated_at", { ascending: false })
    .limit(limit);

  if (error || !data) return [];

  return data.map(mapDocumentRow);
}

/** Full document list with optional status filter and search. */
export async function listDocuments(
  supabase: SupabaseClient,
  organisationId: string,
  opts: { status?: "draft" | "published"; search?: string } = {}
): Promise<DocumentRow[]> {
  let query = supabase
    .from("documents")
    .select(`
      id, title, slug, status, published_at, created_at, updated_at,
      categories ( id, name, collections ( id, name ) )
    `)
    .eq("organisation_id", organisationId)
    .order("updated_at", { ascending: false });

  if (opts.status) query = query.eq("status", opts.status);
  if (opts.search) query = query.ilike("title", `%${opts.search}%`);

  const { data, error } = await query;
  if (error || !data) return [];

  return data.map(mapDocumentRow);
}

/** Single document with its steps (no signed URLs — caller fetches those). */
export async function getDocumentWithSteps(
  supabase: SupabaseClient,
  documentId: string
): Promise<DocumentDetail | null> {
  const { data, error } = await supabase
    .from("documents")
    .select(`
      id, title, slug, status, published_at, created_at, updated_at,
      categories ( id, name, collections ( id, name ) ),
      document_steps ( id, document_id, position, heading, content, media_asset_id, created_at, updated_at )
    `)
    .eq("id", documentId)
    .single();

  if (error || !data) return null;

  const steps: StepRow[] = Array.isArray((data as any).document_steps)
    ? (data as any).document_steps
        .sort((a: StepRow, b: StepRow) => a.position - b.position)
        .map((s: StepRow) => ({ ...s, media_url: null }))
    : [];

  return {
    ...mapDocumentRow(data),
    description: null, // documents table has no description column; kept for UI compatibility
    steps,
  };
}

/** Create a document. RLS enforces org membership on the web path.
 *  On the MCP path the caller must supply the organisation_id from the
 *  resolved token — never from untrusted tool arguments. */
export async function createDocument(
  supabase: SupabaseClient,
  organisationId: string,
  input: {
    title: string;
    category_id: string | null;
    status?: "draft" | "published";
  }
): Promise<ServiceResult<DocumentRow>> {
  const title = input.title.trim();
  if (!title) return { error: "Title is required." };
  if (title.length > 200) return { error: "Title must be 200 characters or fewer." };

  const baseSlug = slugify(title) || "document";
  const slug = `${baseSlug}-${Math.random().toString(36).slice(2, 6)}`;

  const { data, error } = await supabase
    .from("documents")
    .insert({
      organisation_id: organisationId,
      title,
      slug,
      status: input.status ?? "draft",
      category_id: input.category_id ?? null,
    })
    .select(`
      id, title, slug, status, published_at, created_at, updated_at,
      categories ( id, name, collections ( id, name ) )
    `)
    .single();

  if (error) {
    if (error.code === "23505") return { error: "A document with that title already exists." };
    return { error: error.message };
  }

  return { data: mapDocumentRow(data) };
}

/** Update a document's title or category.
 *  AUTHORISATION NOTE: accepts a bare documentId with no org-scoping check.
 *  Web path: RLS enforces membership. MCP path: caller must verify the
 *  document belongs to the resolved token's organisation_id before calling. */
export async function updateDocument(
  supabase: SupabaseClient,
  documentId: string,
  input: { title?: string; category_id?: string | null }
): Promise<ServiceResult> {
  const updates: Record<string, unknown> = {};
  if (input.title !== undefined) {
    const title = input.title.trim();
    if (!title) return { error: "Title is required." };
    updates.title = title;
  }
  if ("category_id" in input) updates.category_id = input.category_id ?? null;
  if (Object.keys(updates).length === 0) return {};

  const { error } = await supabase.from("documents").update(updates).eq("id", documentId);
  if (error) return { error: error.message };
  return {};
}

// ---------------------------------------------------------------------------
// Internal mapper — keeps the shape consistent across all query sites.
// ---------------------------------------------------------------------------
function mapDocumentRow(d: any): DocumentRow {
  return {
    id: d.id,
    title: d.title,
    slug: d.slug,
    status: d.status as "draft" | "published",
    published_at: d.published_at,
    created_at: d.created_at,
    updated_at: d.updated_at,
    category: d.categories
      ? {
          id: (d.categories as any).id,
          name: (d.categories as any).name,
          collection: (d.categories as any).collections ?? null,
        }
      : null,
  };
}
