"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireOrganisation } from "@/lib/dal";
import { updateDocument } from "@/lib/services/documents";
import { createStep, updateStep, deleteStep, reorderSteps } from "@/lib/services/steps";
import { uploadScreenshot } from "@/lib/services/media";

export type ActionState = { error?: string; success?: boolean } | null;

// ---------------------------------------------------------------------------
// Document metadata
// ---------------------------------------------------------------------------

export async function updateDocumentAction(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  const id = formData.get("id") as string;
  const title = (formData.get("title") as string)?.trim();
  const categoryId = (formData.get("category_id") as string) || null;

  if (!id) return { error: "Document ID is required." };

  const supabase = await createClient();
  const result = await updateDocument(supabase, id, { title, category_id: categoryId });

  if (result.error) return { error: result.error };

  revalidatePath(`/documentation/${id}`);
  revalidatePath("/documentation");
  return { success: true };
}

// ---------------------------------------------------------------------------
// Publish / unpublish — delegates to the SECURITY DEFINER RPCs from 0003.
// ---------------------------------------------------------------------------

export async function publishDocumentAction(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  const id = formData.get("id") as string;
  if (!id) return { error: "Document ID is required." };

  const supabase = await createClient();
  const { error } = await supabase.rpc("publish_document", { p_document_id: id });

  if (error) return { error: error.message };

  revalidatePath(`/documentation/${id}`);
  revalidatePath("/documentation");
  return { success: true };
}

export async function unpublishDocumentAction(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  const id = formData.get("id") as string;
  if (!id) return { error: "Document ID is required." };

  const supabase = await createClient();
  const { error } = await supabase.rpc("unpublish_document", { p_document_id: id });

  if (error) return { error: error.message };

  revalidatePath(`/documentation/${id}`);
  revalidatePath("/documentation");
  return { success: true };
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

export async function addStepAction(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  const documentId = formData.get("document_id") as string;
  const position = parseInt(formData.get("position") as string, 10) || 0;

  if (!documentId) return { error: "Document ID is required." };

  const supabase = await createClient();
  const result = await createStep(supabase, documentId, { position });

  if (result.error) return { error: result.error };

  revalidatePath(`/documentation/${documentId}`);
  return { success: true };
}

export async function updateStepAction(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  const stepId = formData.get("step_id") as string;
  const documentId = formData.get("document_id") as string;
  const heading = (formData.get("heading") as string) ?? "";
  const content = (formData.get("content") as string) ?? "";

  if (!stepId) return { error: "Step ID is required." };

  const supabase = await createClient();
  const result = await updateStep(supabase, stepId, { heading, content });

  if (result.error) return { error: result.error };

  revalidatePath(`/documentation/${documentId}`);
  return { success: true };
}

export async function deleteStepAction(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  const stepId = formData.get("step_id") as string;
  const documentId = formData.get("document_id") as string;

  if (!stepId) return { error: "Step ID is required." };

  const supabase = await createClient();
  const result = await deleteStep(supabase, stepId);

  if (result.error) return { error: result.error };

  revalidatePath(`/documentation/${documentId}`);
  return { success: true };
}

export async function reorderStepsAction(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  const documentId = formData.get("document_id") as string;
  const orderedIdsRaw = formData.get("ordered_ids") as string;

  if (!documentId || !orderedIdsRaw) return { error: "Missing data." };

  let orderedIds: string[];
  try {
    orderedIds = JSON.parse(orderedIdsRaw);
  } catch {
    return { error: "Invalid step order data." };
  }

  const supabase = await createClient();
  const result = await reorderSteps(supabase, orderedIds);

  if (result.error) return { error: result.error };

  revalidatePath(`/documentation/${documentId}`);
  return { success: true };
}

// ---------------------------------------------------------------------------
// Media upload
// ---------------------------------------------------------------------------

export async function uploadMediaAction(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState & { assetId?: string }> {
  const stepId = formData.get("step_id") as string;
  const documentId = formData.get("document_id") as string;
  const file = formData.get("file") as File | null;

  if (!stepId || !documentId || !file || file.size === 0) {
    return { error: "Step ID, document ID and file are required." };
  }

  const { membership } = await requireOrganisation();
  const org = membership.organisations as unknown as { id: string } | null;
  if (!org) return { error: "Organisation not found." };

  const supabase = await createClient();
  const uploadResult = await uploadScreenshot(supabase, org.id, file);

  if (uploadResult.error || !uploadResult.data) {
    return { error: uploadResult.error ?? "Upload failed." };
  }

  const assetId = uploadResult.data.id;

  // Associate the asset with the step.
  const stepResult = await updateStep(supabase, stepId, { media_asset_id: assetId });
  if (stepResult.error) return { error: stepResult.error };

  revalidatePath(`/documentation/${documentId}`);
  return { success: true, assetId };
}
