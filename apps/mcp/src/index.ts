import http, { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  listCollections,
  listCategories,
  listDocuments,
  getDocumentWithSteps,
  createCollection,
  createCategory,
  createDocument,
  createStep,
  updateStep,
} from "@wuhoo/core";

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const PORT = process.env.PORT ?? 3001;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    "Missing required environment variables: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY"
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Supabase service-role client (never exposed to clients).
// RLS is bypassed — every query MUST be explicitly scoped to the resolved
// organisation_id from the authenticated token.
// ---------------------------------------------------------------------------

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// ---------------------------------------------------------------------------
// Token validation
// Hashes the raw bearer token with SHA-256 and calls resolve_mcp_token.
// Returns the resolved identity row, or null if invalid/revoked.
// The raw token is never logged or stored.
// ---------------------------------------------------------------------------

interface ResolvedToken {
  user_id: string;
  organisation_id: string;
  role: string;
}

async function validateBearerToken(
  authHeader: string | undefined
): Promise<ResolvedToken | null> {
  if (!authHeader?.startsWith("Bearer ")) return null;

  const raw = authHeader.slice(7).trim();
  if (!raw) return null;

  const hash = createHash("sha256").update(raw).digest("hex");

  const { data, error } = await supabase.rpc("resolve_mcp_token", {
    p_token_hash: hash,
  });

  if (error || !data || (data as ResolvedToken[]).length === 0) return null;

  return (data as ResolvedToken[])[0];
}

// ---------------------------------------------------------------------------
// Per-request identity extraction
//
// Identity is threaded into tool callbacks via the SDK's built-in auth
// channel: req.auth is set before handleRequest(), the transport propagates
// it as MessageExtraInfo.authInfo, and the protocol layer surfaces it as
// RequestHandlerExtra.authInfo. The resolved token fields are stored in
// authInfo.extra so they survive the AuthInfo interface without modification.
// ---------------------------------------------------------------------------

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

function getIdentity(extra: Extra): ResolvedToken {
  const identity = extra.authInfo?.extra as ResolvedToken | undefined;
  if (!identity?.organisation_id || !identity?.user_id) {
    // This path should never be reached: unauthenticated requests are
    // rejected at the HTTP layer before the transport is created.
    throw new Error("Unauthenticated");
  }
  return identity;
}

// ---------------------------------------------------------------------------
// Ownership verification helpers
//
// The service-role client bypasses RLS. These helpers enforce organisation
// isolation at the application layer before any service function is called.
// They query the minimum columns needed and return null on any failure so
// callers can return a safe "not found" error without leaking existence.
// ---------------------------------------------------------------------------

/** Verify a collection belongs to the authenticated organisation. */
async function verifyCollectionOwnership(
  collectionId: string,
  organisationId: string
): Promise<boolean> {
  const { data } = await supabase
    .from("collections")
    .select("id")
    .eq("id", collectionId)
    .eq("organisation_id", organisationId)
    .single();
  return data !== null;
}

/** Verify a document belongs to the authenticated organisation. */
async function verifyDocumentOwnership(
  documentId: string,
  organisationId: string
): Promise<boolean> {
  const { data } = await supabase
    .from("documents")
    .select("id")
    .eq("id", documentId)
    .eq("organisation_id", organisationId)
    .single();
  return data !== null;
}

/**
 * Verify a category belongs to the authenticated organisation by joining
 * through its parent collection.
 */
async function verifyCategoryOwnership(
  categoryId: string,
  organisationId: string
): Promise<boolean> {
  const { data } = await supabase
    .from("categories")
    .select("id, collections!inner(organisation_id)")
    .eq("id", categoryId)
    .eq("collections.organisation_id", organisationId)
    .single();
  return data !== null;
}

/**
 * Enforce that the resolved token role permits write operations.
 * Owners, admins and editors may create content.
 * Any other role value (or a future unknown role) is rejected.
 */
function assertCanWrite(role: string): void {
  if (role !== "owner" && role !== "admin" && role !== "editor") {
    throw new Error("Insufficient permissions.");
  }
}

// ---------------------------------------------------------------------------
// Screenshot upload constants and helpers
// ---------------------------------------------------------------------------

const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png":  "png",
  "image/webp": "webp",
};
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5 MB
// Maximum base64-encoded length that could decode to MAX_UPLOAD_BYTES.
// base64 expands 3 bytes → 4 chars, plus up to 2 padding chars.
const MAX_BASE64_LENGTH = Math.ceil(MAX_UPLOAD_BYTES / 3) * 4 + 2;

// Canonical base64 validation.
// RFC 4648 §4: encoded output is always a multiple of 4 characters.
// Padding rules: 0 trailing '=' for 3n bytes, 1 '=' for 3n+2, 2 '==' for 3n+1.
// Checking length % 4 === 0 enforces correct padding without enumerating cases.
// Rejects URL-safe base64 (- _), whitespace, and any other non-alphabet character.
// The round-trip re-encode check catches non-zero padding bits in the final
// quantum (e.g. "YR==" decodes to the same byte as "YQ==" but is not canonical).
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
function isCanonicalBase64(s: string): boolean {
  if (s.length % 4 !== 0) return false;
  if (!BASE64_RE.test(s)) return false;
  return Buffer.from(s, "base64").toString("base64") === s;
}

/**
 * Magic-byte signatures for allowed image types.
 * Checked against the first bytes of the decoded buffer.
 */
function checkMagicBytes(
  buf: Buffer,
  mimeType: "image/jpeg" | "image/png" | "image/webp"
): boolean {
  if (mimeType === "image/jpeg") {
    // JPEG: FF D8 FF
    return buf.length >= 3 &&
      buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  }
  if (mimeType === "image/png") {
    // PNG: 89 50 4E 47 0D 0A 1A 0A
    return buf.length >= 8 &&
      buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
      buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a;
  }
  if (mimeType === "image/webp") {
    // WebP: RIFF????WEBP  (bytes 0-3 = "RIFF", bytes 8-11 = "WEBP")
    return buf.length >= 12 &&
      buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50;
  }
  return false;
}

/**
 * Sanitise a caller-supplied filename.
 * Strips directory components and non-printable / path-traversal characters.
 * Falls back to "screenshot" if nothing safe remains.
 */
function sanitiseFilename(raw: string): string {
  // Take only the basename, then strip anything that isn't alphanumeric,
  // hyphen, underscore or dot.
  const base = raw.split(/[\/\\]/).pop() ?? "";
  const safe = base.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^[._]+/, "");
  return safe.length > 0 ? safe.slice(0, 200) : "screenshot";
}

/**
 * Verify a step exists and belongs to the given document.
 * Returns the step row (id only) or null.
 */
async function verifyStepBelongsToDocument(
  stepId: string,
  documentId: string
): Promise<boolean> {
  const { data } = await supabase
    .from("document_steps")
    .select("id")
    .eq("id", stepId)
    .eq("document_id", documentId)
    .single();
  return data !== null;
}

/**
 * Upload a screenshot Buffer to the wuhoo-media bucket and insert a
 * media_assets row. Node-native equivalent of uploadScreenshot() in
 * packages/core/src/services/media.ts — accepts a Buffer instead of a
 * browser File so it works in the MCP server (Node.js) context.
 *
 * Storage path: {organisation_id}/{asset_id}/{sanitised_filename}
 * This matches the path convention enforced by the storage policies in 0002.
 *
 * organisationId MUST come from the resolved token identity.
 * uploadedBy MUST come from the resolved token identity.
 */
async function uploadScreenshotBuffer(
  organisationId: string,
  uploadedBy: string,
  buf: Buffer,
  mimeType: string,
  safeFilename: string
): Promise<{ assetId: string; storagePath: string } | { error: string }> {
  // Insert the media_assets row first to get the asset ID for the path.
  const { data: asset, error: insertError } = await supabase
    .from("media_assets")
    .insert({
      organisation_id: organisationId,
      uploaded_by: uploadedBy,
      type: "screenshot",
      storage_path: "pending",
      mime_type: mimeType,
      size_bytes: buf.byteLength,
    })
    .select("id")
    .single();

  if (insertError || !asset) {
    return { error: insertError?.message ?? "Failed to create asset record." };
  }

  const ext = MIME_TO_EXT[mimeType] ?? "png";
  // safeFilename already contains the caller's extension (e.g. "step1.png").
  // Appending ext again would produce "step1.png.png". Use safeFilename as
  // the storage filename directly — the MIME type and magic bytes have already
  // been validated before this function is called.
  const storagePath = `${organisationId}/${asset.id}/${safeFilename}`;

  const { error: uploadError } = await supabase.storage
    .from("wuhoo-media")
    .upload(storagePath, buf, { contentType: mimeType, upsert: false });

  if (uploadError) {
    await supabase.from("media_assets").delete().eq("id", asset.id);
    return { error: uploadError.message };
  }

  const { error: updateError } = await supabase
    .from("media_assets")
    .update({ storage_path: storagePath })
    .eq("id", asset.id);

  if (updateError) {
    // Storage upload succeeded but the path record failed to update.
    // Attempt best-effort cleanup of both the asset row and the storage
    // object so neither is left in an inconsistent state.
    // Cleanup errors are intentionally swallowed — the original error is
    // what the caller needs to see.
    await supabase.from("media_assets").delete().eq("id", asset.id);
    await (supabase.storage.from("wuhoo-media") as any).remove([storagePath]);
    return { error: updateError.message };
  }

  return { assetId: asset.id, storagePath };
}

// ---------------------------------------------------------------------------
// Tool result helpers
// ---------------------------------------------------------------------------

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

function toolError(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

// ---------------------------------------------------------------------------
// MCP server factory
//
// A fresh McpServer is created for every incoming HTTP request so that each
// request's transport is isolated. Sharing a single McpServer instance and
// calling connect() per request is unsafe: concurrent requests would race to
// overwrite the shared server's onmessage handler, routing one request's
// tool response to another request's transport.
// ---------------------------------------------------------------------------

function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: "wuhoo", version: "0.1.0" },
    { capabilities: {} }
  );

  // -------------------------------------------------------------------------
  // Tool: list_collections
  //
  // Returns all collections for the authenticated organisation.
  // organisation_id comes exclusively from the resolved token — never from
  // tool arguments.
  // -------------------------------------------------------------------------

  server.registerTool(
    "list_collections",
    {
      title: "List Collections",
      description:
        "List all collections in the authenticated organisation. " +
        "Collections are top-level containers that group categories and documents.",
      inputSchema: undefined,
    },
    async (extra: Extra) => {
      let identity: ResolvedToken;
      try {
        identity = getIdentity(extra);
      } catch {
        return toolError("Authentication required.");
      }

      try {
        const collections = await listCollections(
          supabase,
          identity.organisation_id
        );
        return ok({ collections });
      } catch {
        return toolError("Failed to retrieve collections.");
      }
    }
  );

  // -------------------------------------------------------------------------
  // Tool: list_categories
  //
  // Returns all categories for a given collection.
  // Verifies the collection belongs to the authenticated organisation before
  // querying categories.
  // -------------------------------------------------------------------------

  server.registerTool(
    "list_categories",
    {
      title: "List Categories",
      description:
        "List all categories within a collection. " +
        "Provide the collection_id from list_collections.",
      inputSchema: {
        collection_id: z.string().uuid().describe("ID of the collection"),
      },
    },
    async (args: { collection_id: string }, extra: Extra) => {
      let identity: ResolvedToken;
      try {
        identity = getIdentity(extra);
      } catch {
        return toolError("Authentication required.");
      }

      const owned = await verifyCollectionOwnership(
        args.collection_id,
        identity.organisation_id
      );
      if (!owned) {
        return toolError("Collection not found.");
      }

      try {
        const categories = await listCategories(supabase, args.collection_id);
        return ok({ categories });
      } catch {
        return toolError("Failed to retrieve categories.");
      }
    }
  );

  // -------------------------------------------------------------------------
  // Tool: list_documents
  //
  // Returns documents for the authenticated organisation with optional filters.
  // organisation_id comes exclusively from the resolved token.
  // -------------------------------------------------------------------------

  server.registerTool(
    "list_documents",
    {
      title: "List Documents",
      description:
        "List documents in the authenticated organisation. " +
        "Optionally filter by status or search by title.",
      inputSchema: {
        status: z
          .enum(["draft", "published"])
          .optional()
          .describe("Filter by document status"),
        search: z
          .string()
          .optional()
          .describe("Search documents by title (case-insensitive substring)"),
      },
    },
    async (
      args: { status?: "draft" | "published"; search?: string },
      extra: Extra
    ) => {
      let identity: ResolvedToken;
      try {
        identity = getIdentity(extra);
      } catch {
        return toolError("Authentication required.");
      }

      try {
        const documents = await listDocuments(
          supabase,
          identity.organisation_id,
          { status: args.status, search: args.search }
        );
        return ok({ documents });
      } catch {
        return toolError("Failed to retrieve documents.");
      }
    }
  );

  // -------------------------------------------------------------------------
  // Tool: get_document
  //
  // Returns a single document with its ordered steps.
  // Verifies the document belongs to the authenticated organisation before
  // fetching. Steps are returned in position order with media_asset_id
  // included so callers know which steps have screenshots attached.
  // Signed URLs are not generated here — they require a separate storage
  // request and expire quickly. The MCP client can request them if needed.
  // -------------------------------------------------------------------------

  server.registerTool(
    "get_document",
    {
      title: "Get Document",
      description:
        "Retrieve a document and all its steps in order. " +
        "Provide the document_id from list_documents.",
      inputSchema: {
        document_id: z.string().uuid().describe("ID of the document"),
      },
    },
    async (args: { document_id: string }, extra: Extra) => {
      let identity: ResolvedToken;
      try {
        identity = getIdentity(extra);
      } catch {
        return toolError("Authentication required.");
      }

      const owned = await verifyDocumentOwnership(
        args.document_id,
        identity.organisation_id
      );
      if (!owned) {
        return toolError("Document not found.");
      }

      try {
        const document = await getDocumentWithSteps(supabase, args.document_id);
        if (!document) return toolError("Document not found.");
        return ok({ document });
      } catch {
        return toolError("Failed to retrieve document.");
      }
    }
  );

  // -------------------------------------------------------------------------
  // Tool: create_collection
  //
  // Creates a new collection scoped to the authenticated organisation.
  // organisation_id comes exclusively from the resolved token.
  // Requires owner, admin or editor role.
  // -------------------------------------------------------------------------

  server.registerTool(
    "create_collection",
    {
      title: "Create Collection",
      description:
        "Create a new collection in the authenticated organisation. " +
        "Collections are top-level containers that group categories and documents.",
      inputSchema: {
        name: z.string().min(1).max(100).describe("Collection name"),
        description: z.string().optional().describe("Optional description"),
      },
    },
    async (args: { name: string; description?: string }, extra: Extra) => {
      let identity: ResolvedToken;
      try {
        identity = getIdentity(extra);
        assertCanWrite(identity.role);
      } catch (e) {
        return toolError((e as Error).message);
      }

      const result = await createCollection(supabase, identity.organisation_id, {
        name: args.name,
        description: args.description,
      });

      if (result.error) return toolError(result.error);
      return ok({ collection: result.data });
    }
  );

  // -------------------------------------------------------------------------
  // Tool: create_category
  //
  // Creates a category inside a collection.
  // Verifies the collection belongs to the authenticated organisation.
  // -------------------------------------------------------------------------

  server.registerTool(
    "create_category",
    {
      title: "Create Category",
      description:
        "Create a new category inside a collection. " +
        "Provide the collection_id from list_collections or create_collection.",
      inputSchema: {
        collection_id: z.string().uuid().describe("ID of the parent collection"),
        name: z.string().min(1).max(100).describe("Category name"),
        description: z.string().optional().describe("Optional description"),
      },
    },
    async (
      args: { collection_id: string; name: string; description?: string },
      extra: Extra
    ) => {
      let identity: ResolvedToken;
      try {
        identity = getIdentity(extra);
        assertCanWrite(identity.role);
      } catch (e) {
        return toolError((e as Error).message);
      }

      const owned = await verifyCollectionOwnership(
        args.collection_id,
        identity.organisation_id
      );
      if (!owned) return toolError("Collection not found.");

      const result = await createCategory(supabase, args.collection_id, {
        name: args.name,
        description: args.description,
      });

      if (result.error) return toolError(result.error);
      return ok({ category: result.data });
    }
  );

  // -------------------------------------------------------------------------
  // Tool: create_document
  //
  // Creates a document inside a category.
  // Verifies the category (and its parent collection) belongs to the
  // authenticated organisation before writing.
  // -------------------------------------------------------------------------

  server.registerTool(
    "create_document",
    {
      title: "Create Document",
      description:
        "Create a new document inside a category. " +
        "Provide the category_id from list_categories or create_category.",
      inputSchema: {
        category_id: z.string().uuid().describe("ID of the parent category"),
        title: z.string().min(1).max(200).describe("Document title"),
        description: z.string().optional().describe("Optional description (stored as first step content if provided)"),
      },
    },
    async (
      args: { category_id: string; title: string; description?: string },
      extra: Extra
    ) => {
      let identity: ResolvedToken;
      try {
        identity = getIdentity(extra);
        assertCanWrite(identity.role);
      } catch (e) {
        return toolError((e as Error).message);
      }

      const owned = await verifyCategoryOwnership(
        args.category_id,
        identity.organisation_id
      );
      if (!owned) return toolError("Category not found.");

      const result = await createDocument(supabase, identity.organisation_id, {
        title: args.title,
        category_id: args.category_id,
      });

      if (result.error) return toolError(result.error);
      return ok({ document: result.data });
    }
  );

  // -------------------------------------------------------------------------
  // Tool: create_step
  //
  // Creates a step inside a document.
  // Verifies the document belongs to the authenticated organisation.
  // title maps to the step heading; description maps to step content.
  // -------------------------------------------------------------------------

  server.registerTool(
    "create_step",
    {
      title: "Create Step",
      description:
        "Create a step inside a document. Steps are ordered instructions. " +
        "Provide the document_id from list_documents, get_document or create_document.",
      inputSchema: {
        document_id: z.string().uuid().describe("ID of the parent document"),
        title: z.string().min(1).describe("Step heading/title"),
        description: z.string().describe("Step instructions or content"),
        position: z.number().int().min(0).describe("Zero-based position index for ordering"),
      },
    },
    async (
      args: { document_id: string; title: string; description: string; position: number },
      extra: Extra
    ) => {
      let identity: ResolvedToken;
      try {
        identity = getIdentity(extra);
        assertCanWrite(identity.role);
      } catch (e) {
        return toolError((e as Error).message);
      }

      const owned = await verifyDocumentOwnership(
        args.document_id,
        identity.organisation_id
      );
      if (!owned) return toolError("Document not found.");

      const result = await createStep(supabase, args.document_id, {
        heading: args.title,
        content: args.description,
        position: args.position,
      });

      if (result.error) return toolError(result.error);
      return ok({ step: result.data });
    }
  );

  // -------------------------------------------------------------------------
  // Tool: upload_screenshot
  //
  // Accepts a base64-encoded image, decodes it, uploads it to the private
  // wuhoo-media Supabase Storage bucket, inserts a media_assets row, and
  // links the asset to the specified document step via updateStep().
  //
  // Security checks (in order):
  //   1. Identity from token only — organisation_id never accepted as arg.
  //   2. assertCanWrite — owner/admin/editor only.
  //   3. MIME type allowlist — JPEG, PNG, WebP only.
  //   4a. Encoded length pre-check — reject before allocating memory.
  //   4b. Strict base64 alphabet check — rejects non-canonical input.
  //   4c. Base64 decode — rejects empty result.
  //   5. Decoded size limit — 5 MB maximum.
  //   5b. Magic byte validation — file content must match declared MIME type.
  //   6. verifyDocumentOwnership — document must belong to authenticated org.
  //   7. verifyStepBelongsToDocument — step must belong to the document.
  //   8. sanitiseFilename — strips path traversal and unsafe characters.
  //   9. uploadScreenshotBuffer — inserts asset row, uploads to storage.
  //  10. updateStep — links media_asset_id to the step.
  //  11. DB trigger validate_step_media_org — defence-in-depth org check.
  // -------------------------------------------------------------------------

  server.registerTool(
    "upload_screenshot",
    {
      title: "Upload Screenshot",
      description:
        "Upload a screenshot image and attach it to a document step. " +
        "Accepts JPEG, PNG or WebP images up to 5 MB encoded as base64. " +
        "Provide document_id and step_id from create_document / create_step.",
      inputSchema: {
        document_id:   z.string().uuid().describe("ID of the parent document"),
        step_id:       z.string().uuid().describe("ID of the step to attach the screenshot to"),
        filename:      z.string().min(1).max(255).describe("Original filename (e.g. step1.png)"),
        mime_type:     z.enum(["image/jpeg", "image/png", "image/webp"]).describe("Image MIME type"),
        image_base64:  z.string().min(1).describe("Base64-encoded image content"),
        alt_text:      z.string().max(500).optional().describe("Optional image description for accessibility"),
      },
    },
    async (
      args: {
        document_id: string;
        step_id: string;
        filename: string;
        mime_type: "image/jpeg" | "image/png" | "image/webp";
        image_base64: string;
        alt_text?: string;
      },
      extra: Extra
    ) => {
      // 1 + 2. Identity and permission check.
      let identity: ResolvedToken;
      try {
        identity = getIdentity(extra);
        assertCanWrite(identity.role);
      } catch (e) {
        return toolError((e as Error).message);
      }

      // 3. MIME type allowlist (Zod enum already enforces this, but be explicit).
      if (!ALLOWED_MIME_TYPES.has(args.mime_type)) {
        return toolError("Unsupported image type. Allowed: image/jpeg, image/png, image/webp.");
      }

      // 4a. Encoded length pre-check — reject before allocating memory.
      //     base64 encodes 3 bytes as 4 chars; the decoded size is at most
      //     ceil(len / 4) * 3 bytes. Reject anything that could exceed the
      //     5 MB limit even before decoding.
      if (args.image_base64.length > MAX_BASE64_LENGTH) {
        return toolError(
          `Image exceeds the 5 MB limit (encoded input is too large).`
        );
      }

      // 4b. Strict canonical base64 — alphabet + length must be multiple of 4.
      //     Rejects URL-safe base64, whitespace, incorrect padding lengths.
      if (!isCanonicalBase64(args.image_base64)) {
        return toolError("Invalid base64 image data.");
      }

      // 4c. Decode.
      let imageBuffer: Buffer;
      try {
        imageBuffer = Buffer.from(args.image_base64, "base64");
        if (imageBuffer.byteLength === 0) throw new Error("Empty image.");
      } catch {
        return toolError("Invalid base64 image data.");
      }

      // 5. Decoded size limit.
      if (imageBuffer.byteLength > MAX_UPLOAD_BYTES) {
        return toolError(
          `Image exceeds the 5 MB limit (received ${(imageBuffer.byteLength / 1024 / 1024).toFixed(2)} MB).`
        );
      }

      // 5b. Magic byte validation — verify the actual file content matches the
      //     declared MIME type. Prevents a JPEG disguised as PNG, etc.
      if (!checkMagicBytes(imageBuffer, args.mime_type)) {
        return toolError(
          `File content does not match declared MIME type ${args.mime_type}.`
        );
      }

      // 6. Document ownership.
      const docOwned = await verifyDocumentOwnership(
        args.document_id,
        identity.organisation_id
      );
      if (!docOwned) return toolError("Document not found.");

      // 7. Step belongs to document.
      const stepOwned = await verifyStepBelongsToDocument(
        args.step_id,
        args.document_id
      );
      if (!stepOwned) return toolError("Step not found.");

      // 8. Sanitise filename — strip path traversal, keep only safe chars.
      const safeFilename = sanitiseFilename(args.filename);

      // 9. Upload to storage + insert media_assets row.
      const uploadResult = await uploadScreenshotBuffer(
        identity.organisation_id,
        identity.user_id,
        imageBuffer,
        args.mime_type,
        safeFilename
      );

      if ("error" in uploadResult) return toolError(uploadResult.error);

      // 10. Link the asset to the step.
      const linkResult = await updateStep(supabase, args.step_id, {
        media_asset_id: uploadResult.assetId,
      });

      if (linkResult.error) {
        // Best-effort cleanup of the orphaned asset.
        await supabase.from("media_assets").delete().eq("id", uploadResult.assetId);
        return toolError(linkResult.error);
      }

      return ok({
        success: true,
        media_asset_id: uploadResult.assetId,
        filename: safeFilename,
        mime_type: args.mime_type,
        document_id: args.document_id,
        step_id: args.step_id,
      });
    }
  );

  return server;
}

// ---------------------------------------------------------------------------
// CORS configuration
//
// Claude's remote custom connector runs in a browser context (claude.ai).
// Every credentialed POST is preceded by an OPTIONS preflight. CORS headers
// must appear on BOTH the preflight response AND the actual POST response.
//
// The MCP transport delegates to @hono/node-server which calls
// outgoing.writeHead(status, headersFromWebResponse) — this overwrites any
// headers previously set via res.setHeader(). To survive that overwrite we
// intercept writeHead on the ServerResponse and merge the CORS headers in.
// ---------------------------------------------------------------------------

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin":  "https://claude.ai",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Mcp-Session-Id",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
  "Vary": "Origin",
};

/**
 * Wraps a ServerResponse so that CORS headers are merged into every
 * writeHead call made by the Hono adapter inside the MCP transport.
 * Hono builds a fresh header record from the Web Standard Response and
 * calls writeHead(), discarding any prior res.setHeader() calls.
 */
function withCorsHeaders(res: ServerResponse): ServerResponse {
  const original = res.writeHead.bind(res);
  (res as unknown as { writeHead: typeof original }).writeHead = function (
    statusCode: number,
    headersOrMessage?: string | Record<string, string | string[] | number>,
    headers?: Record<string, string | string[] | number>
  ) {
    if (typeof headersOrMessage === "object" && headersOrMessage !== null) {
      return original(statusCode, { ...CORS_HEADERS, ...headersOrMessage });
    } else if (typeof headersOrMessage === "string" && typeof headers === "object") {
      return original(statusCode, headersOrMessage, { ...CORS_HEADERS, ...headers });
    } else {
      return original(statusCode, { ...CORS_HEADERS });
    }
  } as typeof original;
  return res;
}

// ---------------------------------------------------------------------------
// HTTP request body reader
// ---------------------------------------------------------------------------

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString();
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(undefined);
      }
    });
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const server = http.createServer(
  async (req: IncomingMessage, res: ServerResponse) => {
    // Health check — no auth required
    if (req.url === "/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", service: "wuhoo-mcp" }));
      return;
    }

    // MCP endpoint — all methods (POST, GET, DELETE, OPTIONS) routed here
    if (req.url === "/mcp") {
      // CORS headers required on every /mcp response so that browser-based
      // MCP clients (including Claude's remote custom connector) can reach
      // the endpoint. Claude sends an OPTIONS preflight before every POST;
      // without these headers the browser blocks the request before it
      // reaches the auth check.
      // Handle OPTIONS preflight before auth — preflights carry no credentials
      // and must succeed for the browser to send the real request.
      if (req.method === "OPTIONS") {
        res.writeHead(204, CORS_HEADERS);
        res.end();
        return;
      }

      // Authenticate every request via Bearer token
      const identity = await validateBearerToken(
        req.headers["authorization"] as string | undefined
      );

      if (!identity) {
        res.writeHead(401, { ...CORS_HEADERS, "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }

      // Thread the resolved identity into the SDK's auth channel.
      // req.auth is read by StreamableHTTPServerTransport.handleRequest()
      // and propagated to every tool callback as extra.authInfo.
      // The resolved token fields are stored in authInfo.extra so they
      // are available to tool handlers without modifying the AuthInfo type.
      (req as IncomingMessage & { auth: object }).auth = {
        token: "",        // raw token is never stored or forwarded
        clientId: identity.user_id,
        scopes: [identity.role],
        extra: {
          user_id: identity.user_id,
          organisation_id: identity.organisation_id,
          role: identity.role,
        },
      };

      // Fresh McpServer + stateless transport — one pair per request.
      // This ensures concurrent requests never share an onmessage handler.
      const mcpServer = createMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });

      try {
        await mcpServer.connect(transport);
        const body = req.method === "POST" ? await readBody(req) : undefined;
        // Wrap res so CORS headers survive the Hono writeHead() overwrite.
        await transport.handleRequest(req, withCorsHeaders(res), body);
      } finally {
        // Close both the transport and the server instance for this request.
        // McpServer.close() also closes the underlying transport, but calling
        // transport.close() first is harmless and makes the intent explicit.
        await transport.close();
        await mcpServer.close();
      }
      return;
    }

    res.writeHead(404);
    res.end();
  }
);

server.listen(PORT, () => {
  console.log(`MCP server running at http://localhost:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`MCP endpoint:  http://localhost:${PORT}/mcp`);
});
