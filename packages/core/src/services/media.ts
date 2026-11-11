import type { SupabaseClientLike as SupabaseClient } from "../supabase.js";
import type { ServiceResult } from "./collections";

export interface MediaAssetRow {
  id: string;
  organisation_id: string;
  storage_path: string;
  mime_type: string | null;
  size_bytes: number | null;
  width_px: number | null;
  height_px: number | null;
  created_at: string;
}

/**
 * Upload a screenshot to the wuhoo-media bucket and insert a media_assets row.
 * Storage path: {organisation_id}/{asset_id}/{filename}
 * This matches the path convention enforced by the storage policies in 0002.
 *
 * organisationId MUST come from the resolved token identity, never from
 * untrusted tool arguments.
 */
export async function uploadScreenshot(
  supabase: SupabaseClient,
  organisationId: string,
  file: File
): Promise<ServiceResult<MediaAssetRow>> {
  // Insert the media_assets row first to get the asset ID for the path.
  const { data: asset, error: insertError } = await supabase
    .from("media_assets")
    .insert({
      organisation_id: organisationId,
      type: "screenshot",
      storage_path: "pending", // updated after upload
      mime_type: file.type || null,
      size_bytes: file.size || null,
    })
    .select("id, organisation_id, storage_path, mime_type, size_bytes, width_px, height_px, created_at")
    .single();

  if (insertError || !asset) return { error: insertError?.message ?? "Failed to create asset record." };

  const ext = file.name.split(".").pop() ?? "png";
  const storagePath = `${organisationId}/${asset.id}/screenshot.${ext}`;

  const { error: uploadError } = await supabase.storage
    .from("wuhoo-media")
    .upload(storagePath, file, { contentType: file.type, upsert: false });

  if (uploadError) {
    // Clean up the orphaned row.
    await supabase.from("media_assets").delete().eq("id", asset.id);
    return { error: uploadError.message };
  }

  // Update the storage_path now that we have the real path.
  const { error: updateError } = await supabase
    .from("media_assets")
    .update({ storage_path: storagePath })
    .eq("id", asset.id);

  if (updateError) return { error: updateError.message };

  return { data: { ...asset, storage_path: storagePath } };
}

/**
 * Get a short-lived signed URL for a media asset (private bucket).
 * Expires in 1 hour — suitable for editor display.
 */
export async function getSignedUrl(
  supabase: SupabaseClient,
  storagePath: string,
  expiresIn = 3600
): Promise<string | null> {
  const { data } = await supabase.storage
    .from("wuhoo-media")
    .createSignedUrl(storagePath, expiresIn);
  return data?.signedUrl ?? null;
}
