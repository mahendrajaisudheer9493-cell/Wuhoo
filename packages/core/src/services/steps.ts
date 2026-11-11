import type { SupabaseClientLike as SupabaseClient } from "../supabase.js";
import type { ServiceResult } from "./collections";

export interface StepRow {
  id: string;
  document_id: string;
  position: number;
  heading: string | null;
  content: string | null;
  media_asset_id: string | null;
  media_url: string | null;
  created_at: string;
  updated_at: string;
}

export async function listSteps(
  supabase: SupabaseClient,
  documentId: string
): Promise<StepRow[]> {
  const { data, error } = await supabase
    .from("document_steps")
    .select("id, document_id, position, heading, content, media_asset_id, created_at, updated_at")
    .eq("document_id", documentId)
    .order("position", { ascending: true });

  if (error || !data) return [];
  return data.map((s: any) => ({ ...s, media_url: null }));
}

/** Create a step. RLS enforces org membership on the web path.
 *  On the MCP path the caller must supply a document_id that has already
 *  been verified to belong to the resolved token's organisation_id. */
export async function createStep(
  supabase: SupabaseClient,
  documentId: string,
  input: { heading?: string; content?: string; position: number }
): Promise<ServiceResult<StepRow>> {
  const { data, error } = await supabase
    .from("document_steps")
    .insert({
      document_id: documentId,
      heading: input.heading?.trim() || null,
      content: input.content?.trim() || null,
      position: input.position,
    })
    .select("id, document_id, position, heading, content, media_asset_id, created_at, updated_at")
    .single();

  if (error) return { error: error.message };
  return { data: { ...data, media_url: null } };
}

/** Update a step's heading, content, or media_asset_id.
 *  AUTHORISATION NOTE: accepts a bare stepId with no org-scoping check.
 *  Web path: RLS enforces membership via document_id join. MCP path: caller
 *  must verify the step's document belongs to the resolved token's
 *  organisation_id before calling this function. */
export async function updateStep(
  supabase: SupabaseClient,
  stepId: string,
  input: { heading?: string; content?: string; media_asset_id?: string | null }
): Promise<ServiceResult> {
  const updates: Record<string, unknown> = {};
  if (input.heading !== undefined) updates.heading = input.heading.trim() || null;
  if (input.content !== undefined) updates.content = input.content.trim() || null;
  if ("media_asset_id" in input) updates.media_asset_id = input.media_asset_id ?? null;
  if (Object.keys(updates).length === 0) return {};

  const { error } = await supabase.from("document_steps").update(updates).eq("id", stepId);
  if (error) return { error: error.message };
  return {};
}

/** Delete a step.
 *  AUTHORISATION NOTE: same as updateStep — MCP path must verify org
 *  ownership before calling. */
export async function deleteStep(
  supabase: SupabaseClient,
  stepId: string
): Promise<ServiceResult> {
  const { error } = await supabase.from("document_steps").delete().eq("id", stepId);
  if (error) return { error: error.message };
  return {};
}

/** Reorder steps: accepts an ordered array of step IDs and writes new positions.
 *  AUTHORISATION NOTE: accepts bare step IDs with no org-scoping check.
 *  Web path: RLS enforces membership via document_id join on each UPDATE.
 *  MCP path: caller must verify all step IDs belong to a document in the
 *  resolved token's organisation_id before calling this function.
 *
 *  Uses plain UPDATE (not upsert): the UPDATE RLS policy resolves document_id
 *  from the existing row, so no document_id is needed in the payload.
 *  Upsert cannot be used here — its INSERT WITH CHECK evaluates the payload
 *  row where document_id would be absent (NULL), failing RLS. */
export async function reorderSteps(
  supabase: SupabaseClient,
  orderedIds: string[]
): Promise<ServiceResult> {
  const results = await Promise.all(
    orderedIds.map((id, index) =>
      supabase.from("document_steps").update({ position: index }).eq("id", id)
    )
  );
  const failed = results.find((r) => r.error);
  if (failed?.error) return { error: failed.error.message };
  return {};
}
