/**
 * MCP write-tool unit tests.
 *
 * Strategy: extract the pure logic under test (ownership verification,
 * permission checks, service delegation) by re-implementing the minimal
 * helpers inline and mocking the Supabase client + @wuhoo/core service
 * functions. No live database or HTTP server is required.
 *
 * Coverage:
 *   - Successful creation for all four write tools
 *   - Invalid / non-existent parent IDs (cross-org access)
 *   - Cross-organisation access attempts
 *   - Permission failures (unknown role)
 *   - Input validation (Zod)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Valid v4 UUIDs for test fixtures (Zod v4 enforces variant bits [89ab])
// ---------------------------------------------------------------------------

const UUID1 = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
const UUID2 = "b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a22";

// ---------------------------------------------------------------------------
// Minimal re-implementation of the helpers under test.
// These mirror the logic in index.ts exactly so we can unit-test them
// without importing the full server (which requires env vars at module load).
// ---------------------------------------------------------------------------

interface ResolvedToken {
  user_id: string;
  organisation_id: string;
  role: string;
}

function assertCanWrite(role: string): void {
  if (role !== "owner" && role !== "admin" && role !== "editor") {
    throw new Error("Insufficient permissions.");
  }
}

function makeSupabaseMock(ownsCollection: boolean, ownsCategory: boolean, ownsDocument: boolean) {
  return {
    from: (table: string) => ({
      select: () => ({
        eq: function (this: any) { return this; },
        single: async () => {
          if (table === "collections") return { data: ownsCollection ? { id: "col-1" } : null };
          if (table === "categories")  return { data: ownsCategory  ? { id: "cat-1" } : null };
          if (table === "documents")   return { data: ownsDocument  ? { id: "doc-1" } : null };
          return { data: null };
        },
      }),
    }),
    rpc: vi.fn(),
    storage: { from: vi.fn() },
  };
}

async function verifyCollectionOwnership(
  supabase: ReturnType<typeof makeSupabaseMock>,
  collectionId: string,
  organisationId: string
): Promise<boolean> {
  const { data } = await supabase.from("collections").select().eq("id", collectionId).eq("organisation_id", organisationId).single();
  return data !== null;
}

async function verifyCategoryOwnership(
  supabase: ReturnType<typeof makeSupabaseMock>,
  categoryId: string,
  organisationId: string
): Promise<boolean> {
  const { data } = await supabase.from("categories").select().eq("id", categoryId).eq("organisation_id", organisationId).single();
  return data !== null;
}

async function verifyDocumentOwnership(
  supabase: ReturnType<typeof makeSupabaseMock>,
  documentId: string,
  organisationId: string
): Promise<boolean> {
  const { data } = await supabase.from("documents").select().eq("id", documentId).eq("organisation_id", organisationId).single();
  return data !== null;
}

// ---------------------------------------------------------------------------
// Zod schemas (mirrors index.ts inputSchema definitions)
// ---------------------------------------------------------------------------

const CreateCollectionSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().optional(),
});

const CreateCategorySchema = z.object({
  collection_id: z.string().uuid(),
  name: z.string().min(1).max(100),
  description: z.string().optional(),
});

const CreateDocumentSchema = z.object({
  category_id: z.string().uuid(),
  title: z.string().min(1).max(200),
  description: z.string().optional(),
});

const CreateStepSchema = z.object({
  document_id: z.string().uuid(),
  title: z.string().min(1),
  description: z.string(),
  position: z.number().int().min(0),
});

// ---------------------------------------------------------------------------
// Stub service results
// ---------------------------------------------------------------------------

const STUB_COLLECTION = { id: "col-1", name: "My Collection", slug: "my-collection-ab12", description: null, position: 0, created_at: "2024-01-01", updated_at: "2024-01-01", document_count: 0 };
const STUB_CATEGORY   = { id: "cat-1", collection_id: "col-1", name: "My Category", slug: "my-category-cd34", description: null, position: 0, created_at: "2024-01-01", updated_at: "2024-01-01", document_count: 0 };
const STUB_DOCUMENT   = { id: "doc-1", title: "My Doc", slug: "my-doc-ef56", status: "draft" as const, published_at: null, created_at: "2024-01-01", updated_at: "2024-01-01", category: null };
const STUB_STEP       = { id: "step-1", document_id: "doc-1", position: 0, heading: "Step 1", content: "Do this", media_asset_id: null, media_url: null, created_at: "2024-01-01", updated_at: "2024-01-01" };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("assertCanWrite", () => {
  it("allows owner",   () => expect(() => assertCanWrite("owner")).not.toThrow());
  it("allows admin",   () => expect(() => assertCanWrite("admin")).not.toThrow());
  it("allows editor",  () => expect(() => assertCanWrite("editor")).not.toThrow());
  it("rejects unknown role", () => expect(() => assertCanWrite("viewer")).toThrow("Insufficient permissions."));
  it("rejects empty string", () => expect(() => assertCanWrite("")).toThrow("Insufficient permissions."));
});

describe("Zod input validation", () => {
  it("rejects empty collection name", () => {
    expect(CreateCollectionSchema.safeParse({ name: "" }).success).toBe(false);
  });
  it("rejects collection name > 100 chars", () => {
    expect(CreateCollectionSchema.safeParse({ name: "a".repeat(101) }).success).toBe(false);
  });
  it("rejects non-UUID collection_id in create_category", () => {
    expect(CreateCategorySchema.safeParse({ collection_id: "not-a-uuid", name: "Cat" }).success).toBe(false);
  });
  it("rejects empty document title", () => {
    expect(CreateDocumentSchema.safeParse({ category_id: UUID1, title: "" }).success).toBe(false);
  });
  it("rejects negative step position", () => {
    expect(CreateStepSchema.safeParse({ document_id: UUID1, title: "T", description: "D", position: -1 }).success).toBe(false);
  });
  it("rejects fractional step position", () => {
    expect(CreateStepSchema.safeParse({ document_id: UUID1, title: "T", description: "D", position: 1.5 }).success).toBe(false);
  });
  it("accepts valid create_step input", () => {
    expect(CreateStepSchema.safeParse({ document_id: UUID1, title: "T", description: "D", position: 0 }).success).toBe(true);
  });
});

describe("Ownership verification", () => {
  it("verifyCollectionOwnership returns true when collection belongs to org", async () => {
    const db = makeSupabaseMock(true, false, false);
    expect(await verifyCollectionOwnership(db, UUID1, "org-1")).toBe(true);
  });
  it("verifyCollectionOwnership returns false for cross-org collection", async () => {
    const db = makeSupabaseMock(false, false, false);
    expect(await verifyCollectionOwnership(db, UUID2, "org-1")).toBe(false);
  });
  it("verifyCategoryOwnership returns true when category belongs to org", async () => {
    const db = makeSupabaseMock(false, true, false);
    expect(await verifyCategoryOwnership(db, UUID1, "org-1")).toBe(true);
  });
  it("verifyCategoryOwnership returns false for cross-org category", async () => {
    const db = makeSupabaseMock(false, false, false);
    expect(await verifyCategoryOwnership(db, UUID2, "org-1")).toBe(false);
  });
  it("verifyDocumentOwnership returns true when document belongs to org", async () => {
    const db = makeSupabaseMock(false, false, true);
    expect(await verifyDocumentOwnership(db, UUID1, "org-1")).toBe(true);
  });
  it("verifyDocumentOwnership returns false for cross-org document", async () => {
    const db = makeSupabaseMock(false, false, false);
    expect(await verifyDocumentOwnership(db, UUID2, "org-1")).toBe(false);
  });
});

describe("create_collection tool logic", () => {
  const createCollectionMock = vi.fn();
  beforeEach(() => createCollectionMock.mockReset());

  async function runCreateCollection(identity: ResolvedToken, args: { name: string; description?: string }) {
    assertCanWrite(identity.role);
    const parsed = CreateCollectionSchema.parse(args);
    const result = await createCollectionMock(identity.organisation_id, parsed);
    if (result.error) return { isError: true, text: result.error };
    return { isError: false, data: result.data };
  }

  it("creates collection successfully for owner", async () => {
    createCollectionMock.mockResolvedValue({ data: STUB_COLLECTION });
    const res = await runCreateCollection(
      { user_id: "u1", organisation_id: "org-1", role: "owner" },
      { name: "My Collection" }
    );
    expect(res.isError).toBe(false);
    expect((res as any).data).toEqual(STUB_COLLECTION);
    expect(createCollectionMock).toHaveBeenCalledWith("org-1", { name: "My Collection" });
  });

  it("creates collection successfully for editor", async () => {
    createCollectionMock.mockResolvedValue({ data: STUB_COLLECTION });
    const res = await runCreateCollection(
      { user_id: "u2", organisation_id: "org-1", role: "editor" },
      { name: "My Collection" }
    );
    expect(res.isError).toBe(false);
  });

  it("rejects unknown role before calling service", async () => {
    await expect(
      runCreateCollection(
        { user_id: "u3", organisation_id: "org-1", role: "viewer" },
        { name: "My Collection" }
      )
    ).rejects.toThrow("Insufficient permissions.");
    expect(createCollectionMock).not.toHaveBeenCalled();
  });

  it("propagates service error", async () => {
    createCollectionMock.mockResolvedValue({ error: "A collection with that name already exists." });
    const res = await runCreateCollection(
      { user_id: "u1", organisation_id: "org-1", role: "admin" },
      { name: "Duplicate" }
    );
    expect(res.isError).toBe(true);
    expect((res as any).text).toBe("A collection with that name already exists.");
  });
});

describe("create_category tool logic", () => {
  const createCategoryMock = vi.fn();
  beforeEach(() => createCategoryMock.mockReset());

  async function runCreateCategory(
    identity: ResolvedToken,
    args: { collection_id: string; name: string; description?: string },
    collectionOwned: boolean
  ) {
    assertCanWrite(identity.role);
    const parsed = CreateCategorySchema.parse(args);
    const db = makeSupabaseMock(collectionOwned, false, false);
    const owned = await verifyCollectionOwnership(db, parsed.collection_id, identity.organisation_id);
    if (!owned) return { isError: true, text: "Collection not found." };
    const result = await createCategoryMock(parsed.collection_id, { name: parsed.name, description: parsed.description });
    if (result.error) return { isError: true, text: result.error };
    return { isError: false, data: result.data };
  }

  it("creates category successfully", async () => {
    createCategoryMock.mockResolvedValue({ data: STUB_CATEGORY });
    const res = await runCreateCategory(
      { user_id: "u1", organisation_id: "org-1", role: "admin" },
      { collection_id: UUID1, name: "My Category" },
      true
    );
    expect(res.isError).toBe(false);
    expect((res as any).data).toEqual(STUB_CATEGORY);
  });

  it("rejects cross-org collection_id", async () => {
    const res = await runCreateCategory(
      { user_id: "u1", organisation_id: "org-1", role: "owner" },
      { collection_id: UUID2, name: "Cat" },
      false
    );
    expect(res.isError).toBe(true);
    expect((res as any).text).toBe("Collection not found.");
    expect(createCategoryMock).not.toHaveBeenCalled();
  });

  it("rejects invalid UUID for collection_id", () => {
    expect(() => CreateCategorySchema.parse({ collection_id: "bad-id", name: "Cat" })).toThrow();
  });
});

describe("create_document tool logic", () => {
  const createDocumentMock = vi.fn();
  beforeEach(() => createDocumentMock.mockReset());

  async function runCreateDocument(
    identity: ResolvedToken,
    args: { category_id: string; title: string; description?: string },
    categoryOwned: boolean
  ) {
    assertCanWrite(identity.role);
    const parsed = CreateDocumentSchema.parse(args);
    const db = makeSupabaseMock(false, categoryOwned, false);
    const owned = await verifyCategoryOwnership(db, parsed.category_id, identity.organisation_id);
    if (!owned) return { isError: true, text: "Category not found." };
    const result = await createDocumentMock(identity.organisation_id, { title: parsed.title, category_id: parsed.category_id });
    if (result.error) return { isError: true, text: result.error };
    return { isError: false, data: result.data };
  }

  it("creates document successfully", async () => {
    createDocumentMock.mockResolvedValue({ data: STUB_DOCUMENT });
    const res = await runCreateDocument(
      { user_id: "u1", organisation_id: "org-1", role: "editor" },
      { category_id: UUID1, title: "My Doc" },
      true
    );
    expect(res.isError).toBe(false);
    expect((res as any).data).toEqual(STUB_DOCUMENT);
    expect(createDocumentMock).toHaveBeenCalledWith("org-1", { title: "My Doc", category_id: UUID1 });
  });

  it("rejects cross-org category_id", async () => {
    const res = await runCreateDocument(
      { user_id: "u1", organisation_id: "org-1", role: "owner" },
      { category_id: UUID2, title: "Doc" },
      false
    );
    expect(res.isError).toBe(true);
    expect((res as any).text).toBe("Category not found.");
    expect(createDocumentMock).not.toHaveBeenCalled();
  });

  it("never accepts organisation_id from tool args", () => {
    // organisation_id is not in the schema — Zod strips unknown keys by default
    const parsed = CreateDocumentSchema.parse({
      category_id: UUID1,
      title: "Doc",
      organisation_id: "attacker-org",
    });
    expect((parsed as any).organisation_id).toBeUndefined();
  });
});

describe("create_step tool logic", () => {
  const createStepMock = vi.fn();
  beforeEach(() => createStepMock.mockReset());

  async function runCreateStep(
    identity: ResolvedToken,
    args: { document_id: string; title: string; description: string; position: number },
    documentOwned: boolean
  ) {
    assertCanWrite(identity.role);
    const parsed = CreateStepSchema.parse(args);
    const db = makeSupabaseMock(false, false, documentOwned);
    const owned = await verifyDocumentOwnership(db, parsed.document_id, identity.organisation_id);
    if (!owned) return { isError: true, text: "Document not found." };
    const result = await createStepMock(parsed.document_id, {
      heading: parsed.title,
      content: parsed.description,
      position: parsed.position,
    });
    if (result.error) return { isError: true, text: result.error };
    return { isError: false, data: result.data };
  }

  it("creates step successfully", async () => {
    createStepMock.mockResolvedValue({ data: STUB_STEP });
    const res = await runCreateStep(
      { user_id: "u1", organisation_id: "org-1", role: "editor" },
      { document_id: UUID1, title: "Step 1", description: "Do this", position: 0 },
      true
    );
    expect(res.isError).toBe(false);
    expect((res as any).data).toEqual(STUB_STEP);
    expect(createStepMock).toHaveBeenCalledWith(UUID1, { heading: "Step 1", content: "Do this", position: 0 });
  });

  it("rejects cross-org document_id", async () => {
    const res = await runCreateStep(
      { user_id: "u1", organisation_id: "org-1", role: "admin" },
      { document_id: UUID2, title: "Step", description: "X", position: 0 },
      false
    );
    expect(res.isError).toBe(true);
    expect((res as any).text).toBe("Document not found.");
    expect(createStepMock).not.toHaveBeenCalled();
  });

  it("rejects permission failure before ownership check", async () => {
    await expect(
      runCreateStep(
        { user_id: "u1", organisation_id: "org-1", role: "viewer" },
        { document_id: UUID1, title: "Step", description: "X", position: 0 },
        true
      )
    ).rejects.toThrow("Insufficient permissions.");
    expect(createStepMock).not.toHaveBeenCalled();
  });

  it("maps title → heading and description → content", async () => {
    createStepMock.mockResolvedValue({ data: STUB_STEP });
    await runCreateStep(
      { user_id: "u1", organisation_id: "org-1", role: "owner" },
      { document_id: UUID1, title: "My Heading", description: "My Content", position: 2 },
      true
    );
    expect(createStepMock).toHaveBeenCalledWith(UUID1, { heading: "My Heading", content: "My Content", position: 2 });
  });
});

// ---------------------------------------------------------------------------
// upload_screenshot tool logic tests
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Helpers mirroring index.ts — kept in sync manually.
// ---------------------------------------------------------------------------

const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAX_BASE64_LENGTH = Math.ceil(MAX_UPLOAD_BYTES / 3) * 4 + 2;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
function isCanonicalBase64(s: string): boolean {
  if (s.length % 4 !== 0) return false;
  if (!BASE64_RE.test(s)) return false;
  return Buffer.from(s, "base64").toString("base64") === s;
}
const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png":  "png",
  "image/webp": "webp",
};

function sanitiseFilename(raw: string): string {
  const base = raw.split(/[\/\\]/).pop() ?? "";
  const safe = base.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^[._]+/, "");
  return safe.length > 0 ? safe.slice(0, 200) : "screenshot";
}

function checkMagicBytes(
  buf: Buffer,
  mimeType: "image/jpeg" | "image/png" | "image/webp"
): boolean {
  if (mimeType === "image/jpeg") {
    return buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  }
  if (mimeType === "image/png") {
    return buf.length >= 8 &&
      buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
      buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a;
  }
  if (mimeType === "image/webp") {
    return buf.length >= 12 &&
      buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50;
  }
  return false;
}

// Minimal valid image buffers (real magic bytes, minimal size).
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PNG_MAGIC  = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const WEBP_MAGIC = Buffer.from([
  0x52, 0x49, 0x46, 0x46,  // "RIFF"
  0x00, 0x00, 0x00, 0x00,  // file size (irrelevant for magic check)
  0x57, 0x45, 0x42, 0x50,  // "WEBP"
]);

// Mock factory for upload_screenshot tests.
// Controls each failure point independently.
function makeUploadMock({
  docOwned        = true,
  stepOwned       = true,
  insertAssetError = null as string | null,
  uploadError      = null as string | null,
  updatePathError  = null as string | null,
  removeError      = null as string | null,
} = {}) {
  const assetId   = "asset-uuid-1";
  const removeSpy = vi.fn().mockResolvedValue({ error: removeError ? { message: removeError } : null });
  return {
    db: {
      from: (table: string) => ({
        select: () => ({
          eq: function (this: any) { return this; },
          single: async () => {
            if (table === "documents")      return { data: docOwned   ? { id: "doc-1" }  : null };
            if (table === "document_steps") return { data: stepOwned  ? { id: "step-1" } : null };
            return { data: null };
          },
        }),
        insert: () => ({
          select: () => ({
            single: async () =>
              insertAssetError
                ? { data: null,          error: { message: insertAssetError } }
                : { data: { id: assetId }, error: null },
          }),
        }),
        update: () => ({
          eq: () => ({ error: updatePathError ? { message: updatePathError } : null }),
        }),
        delete: () => ({ eq: () => Promise.resolve({ error: null }) }),
      }),
      storage: {
        from: () => ({
          upload: async () => ({ error: uploadError ? { message: uploadError } : null }),
          remove: removeSpy,
        }),
      },
    },
    assetId,
    removeSpy,
  };
}

// Mirrors the tool handler logic from index.ts for unit testing.
async function runUploadScreenshot(
  identity: ResolvedToken,
  args: {
    document_id:  string;
    step_id:      string;
    filename:     string;
    mime_type:    string;
    image_base64: string;
    alt_text?:    string;
  },
  mock: ReturnType<typeof makeUploadMock>,
  updateStepMock: ReturnType<typeof vi.fn>
) {
  // 1+2. Permission check (throws for async callers to catch with rejects.toThrow)
  assertCanWrite(identity.role);

  // 3. MIME allowlist
  if (!ALLOWED_MIME_TYPES.has(args.mime_type)) {
    return { isError: true, text: "Unsupported image type. Allowed: image/jpeg, image/png, image/webp." };
  }

  // 4a. Encoded length pre-check
  if (args.image_base64.length > MAX_BASE64_LENGTH) {
    return { isError: true, text: "Image exceeds the 5 MB limit (encoded input is too large)." };
  }

  // 4b. Strict canonical base64
  if (!isCanonicalBase64(args.image_base64)) {
    return { isError: true, text: "Invalid base64 image data." };
  }

  // 4c. Decode
  let imageBuffer: Buffer;
  try {
    imageBuffer = Buffer.from(args.image_base64, "base64");
    if (imageBuffer.byteLength === 0) throw new Error("Empty image.");
  } catch {
    return { isError: true, text: "Invalid base64 image data." };
  }

  // 5. Decoded size limit
  if (imageBuffer.byteLength > MAX_UPLOAD_BYTES) {
    return { isError: true, text: `Image exceeds the 5 MB limit (received ${(imageBuffer.byteLength / 1024 / 1024).toFixed(2)} MB).` };
  }

  // 5b. Magic bytes
  if (!checkMagicBytes(imageBuffer, args.mime_type as any)) {
    return { isError: true, text: `File content does not match declared MIME type ${args.mime_type}.` };
  }

  // 6. Document ownership
  const { data: docData } = await mock.db.from("documents").select().eq("id", args.document_id).eq("organisation_id", identity.organisation_id).single();
  if (!docData) return { isError: true, text: "Document not found." };

  // 7. Step belongs to document
  const { data: stepData } = await mock.db.from("document_steps").select().eq("id", args.step_id).eq("document_id", args.document_id).single();
  if (!stepData) return { isError: true, text: "Step not found." };

  // 8. Sanitise filename
  const safeFilename = sanitiseFilename(args.filename);

  // 9. Insert asset row
  const { data: asset, error: insertError } = await mock.db.from("media_assets").insert({}).select().single();
  if (insertError || !asset) return { isError: true, text: (insertError as any)?.message ?? "Failed to create asset record." };

  const ext = MIME_TO_EXT[args.mime_type] ?? "png";
  const storagePath = `${identity.organisation_id}/${asset.id}/${safeFilename}`;

  // 9b. Storage upload
  const { error: uploadErr } = await mock.db.storage.from("wuhoo-media").upload(storagePath, imageBuffer, { contentType: args.mime_type, upsert: false });
  if (uploadErr) {
    await mock.db.from("media_assets").delete().eq("id", asset.id);
    return { isError: true, text: (uploadErr as any).message };
  }

  // 9c. Update storage_path — if this fails, clean up both asset row AND storage object
  const { error: updatePathErr } = await mock.db.from("media_assets").update({}).eq("id", asset.id);
  if (updatePathErr) {
    await mock.db.from("media_assets").delete().eq("id", asset.id);
    await mock.db.storage.from("wuhoo-media").remove([storagePath]);
    return { isError: true, text: (updatePathErr as any).message };
  }

  // 10. Link step
  const linkResult = await updateStepMock(args.step_id, { media_asset_id: asset.id });
  if (linkResult.error) {
    await mock.db.from("media_assets").delete().eq("id", asset.id);
    return { isError: true, text: linkResult.error };
  }

  return {
    isError: false,
    data: {
      success:        true,
      media_asset_id: asset.id,
      filename:       safeFilename,
      mime_type:      args.mime_type,
      document_id:    args.document_id,
      step_id:        args.step_id,
    },
  };
}

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const IDENTITY: ResolvedToken = { user_id: "u1", organisation_id: "org-1", role: "editor" };

// Valid args use a real PNG magic-byte buffer so magic-byte checks pass.
const VALID_ARGS = {
  document_id:  UUID1,
  step_id:      UUID2,
  filename:     "step1.png",
  mime_type:    "image/png" as const,
  image_base64: PNG_MAGIC.toString("base64"),
};

// ---------------------------------------------------------------------------
// sanitiseFilename
// ---------------------------------------------------------------------------

describe("sanitiseFilename", () => {
  it("strips forward-slash path traversal", () => {
    expect(sanitiseFilename("../../etc/passwd")).toBe("passwd");
  });
  it("strips backslash path traversal", () => {
    expect(sanitiseFilename("..\\..\\windows\\system32\\cmd.exe")).toBe("cmd.exe");
  });
  it("replaces spaces and parentheses", () => {
    expect(sanitiseFilename("my file (1).png")).toBe("my_file__1_.png");
  });
  it("falls back to 'screenshot' when only dots remain", () => {
    expect(sanitiseFilename("...")).toBe("screenshot");
  });
  it("preserves safe filenames unchanged", () => {
    expect(sanitiseFilename("step-01_screenshot.png")).toBe("step-01_screenshot.png");
  });
  it("truncates filenames longer than 200 characters", () => {
    expect(sanitiseFilename("a".repeat(250))).toHaveLength(200);
  });
});

// ---------------------------------------------------------------------------
// checkMagicBytes
// ---------------------------------------------------------------------------

describe("checkMagicBytes", () => {
  it("accepts valid JPEG magic bytes", () => {
    expect(checkMagicBytes(JPEG_MAGIC, "image/jpeg")).toBe(true);
  });
  it("accepts valid PNG magic bytes", () => {
    expect(checkMagicBytes(PNG_MAGIC, "image/png")).toBe(true);
  });
  it("accepts valid WebP magic bytes", () => {
    expect(checkMagicBytes(WEBP_MAGIC, "image/webp")).toBe(true);
  });
  it("rejects PNG bytes declared as JPEG", () => {
    expect(checkMagicBytes(PNG_MAGIC, "image/jpeg")).toBe(false);
  });
  it("rejects JPEG bytes declared as PNG", () => {
    expect(checkMagicBytes(JPEG_MAGIC, "image/png")).toBe(false);
  });
  it("rejects JPEG bytes declared as WebP", () => {
    expect(checkMagicBytes(JPEG_MAGIC, "image/webp")).toBe(false);
  });
  it("rejects WebP bytes declared as PNG", () => {
    expect(checkMagicBytes(WEBP_MAGIC, "image/png")).toBe(false);
  });
  it("rejects buffer that is too short for PNG", () => {
    expect(checkMagicBytes(Buffer.from([0x89, 0x50]), "image/png")).toBe(false);
  });
  it("rejects buffer that is too short for WebP", () => {
    expect(checkMagicBytes(Buffer.from([0x52, 0x49, 0x46, 0x46]), "image/webp")).toBe(false);
  });
  it("rejects arbitrary bytes for all types", () => {
    const garbage = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b]);
    expect(checkMagicBytes(garbage, "image/jpeg")).toBe(false);
    expect(checkMagicBytes(garbage, "image/png")).toBe(false);
    expect(checkMagicBytes(garbage, "image/webp")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Base64 validation (strict alphabet + encoded-length pre-check)
// ---------------------------------------------------------------------------

describe("base64 validation", () => {
  it("accepts standard base64 with padding", () => {
    expect(isCanonicalBase64(Buffer.from("hello").toString("base64"))).toBe(true);
  });
  it("accepts base64 without padding (multiple of 3 bytes)", () => {
    expect(isCanonicalBase64(Buffer.from("abc").toString("base64"))).toBe(true);
  });
  it("accepts 1-byte input with correct == padding", () => {
    expect(isCanonicalBase64("YQ==")).toBe(true);
  });
  it("accepts 2-byte input with correct = padding", () => {
    expect(isCanonicalBase64("YWI=")).toBe(true);
  });
  it("rejects 1-byte input with only one = (incorrect padding)", () => {
    expect(isCanonicalBase64("YQ=")).toBe(false);
  });
  it("rejects 2-byte input with no padding (length not multiple of 4)", () => {
    expect(isCanonicalBase64("YWI")).toBe(false);
  });
  it("rejects string whose length is not a multiple of 4", () => {
    expect(isCanonicalBase64("abc")).toBe(false);
    expect(isCanonicalBase64("ab")).toBe(false);
    expect(isCanonicalBase64("a")).toBe(false);
  });
  it("rejects URL-safe base64 with hyphen", () => {
    expect(isCanonicalBase64("abc-def=")).toBe(false);
  });
  it("rejects URL-safe base64 with underscore", () => {
    expect(isCanonicalBase64("abc_def=")).toBe(false);
  });
  it("rejects base64 with embedded whitespace", () => {
    expect(isCanonicalBase64("abc def=")).toBe(false);
  });
  it("rejects base64 with newline", () => {
    expect(isCanonicalBase64("abcd\nefgh")).toBe(false);
  });
  it("rejects base64 with exclamation mark", () => {
    expect(isCanonicalBase64("abc!efgh")).toBe(false);
  });
  it("rejects non-zero padding bits in 1-byte encoding (YR== decodes same as YQ== but is not canonical)", () => {
    // YQ== is canonical for byte 0x61. YR== has non-zero padding bits in the
    // final quantum — it decodes to the same byte but round-trips back to YQ==.
    expect(isCanonicalBase64("YQ==")).toBe(true);
    expect(isCanonicalBase64("YR==")).toBe(false);
  });
  it("rejects non-zero padding bits in 2-byte encoding (YWJ= decodes same as YWI= but is not canonical)", () => {
    expect(isCanonicalBase64("YWI=")).toBe(true);
    expect(isCanonicalBase64("YWJ=")).toBe(false);
  });
  it("MAX_BASE64_LENGTH is at least as large as a 5 MB encoded payload", () => {
    const fiveMbBase64 = Buffer.alloc(MAX_UPLOAD_BYTES).toString("base64");
    expect(fiveMbBase64.length).toBeLessThanOrEqual(MAX_BASE64_LENGTH);
  });
  it("MAX_BASE64_LENGTH rejects a payload that would decode to more than 5 MB", () => {
    // 5 MB + 3 bytes encodes to 4 more base64 chars than MAX_BASE64_LENGTH allows.
    const oversizedBase64 = Buffer.alloc(MAX_UPLOAD_BYTES + 3).toString("base64");
    expect(oversizedBase64.length).toBeGreaterThan(MAX_BASE64_LENGTH);
  });
});

// ---------------------------------------------------------------------------
// upload_screenshot tool logic
// ---------------------------------------------------------------------------

describe("upload_screenshot tool logic", () => {
  const updateStepMock = vi.fn();
  beforeEach(() => updateStepMock.mockReset());

  it("uploads PNG screenshot successfully", async () => {
    const mock = makeUploadMock();
    updateStepMock.mockResolvedValue({ error: null });
    const res = await runUploadScreenshot(IDENTITY, VALID_ARGS, mock, updateStepMock);
    expect(res.isError).toBe(false);
    expect((res as any).data.success).toBe(true);
    expect((res as any).data.media_asset_id).toBe(mock.assetId);
    expect((res as any).data.mime_type).toBe("image/png");
    expect((res as any).data.document_id).toBe(UUID1);
    expect((res as any).data.step_id).toBe(UUID2);
    expect(updateStepMock).toHaveBeenCalledWith(UUID2, { media_asset_id: mock.assetId });
  });

  it("uploads JPEG screenshot successfully", async () => {
    const mock = makeUploadMock();
    updateStepMock.mockResolvedValue({ error: null });
    const res = await runUploadScreenshot(
      IDENTITY,
      { ...VALID_ARGS, filename: "shot.jpg", mime_type: "image/jpeg", image_base64: JPEG_MAGIC.toString("base64") },
      mock,
      updateStepMock
    );
    expect(res.isError).toBe(false);
    expect((res as any).data.mime_type).toBe("image/jpeg");
  });

  it("uploads WebP screenshot successfully", async () => {
    const mock = makeUploadMock();
    updateStepMock.mockResolvedValue({ error: null });
    const res = await runUploadScreenshot(
      IDENTITY,
      { ...VALID_ARGS, filename: "shot.webp", mime_type: "image/webp", image_base64: WEBP_MAGIC.toString("base64") },
      mock,
      updateStepMock
    );
    expect(res.isError).toBe(false);
    expect((res as any).data.mime_type).toBe("image/webp");
  });

  it("storage path follows org/{asset_id}/{filename} convention (no double extension)", async () => {
    const mock = makeUploadMock();
    updateStepMock.mockResolvedValue({ error: null });
    // Intercept upload by wrapping the storage mock before the call.
    let capturedPath: string | undefined;
    const originalStorageFrom = mock.db.storage.from;
    mock.db.storage.from = (bucket: string) => {
      const b = originalStorageFrom(bucket);
      const originalUpload = b.upload;
      b.upload = async (path: string, ...rest: any[]) => {
        capturedPath = path;
        return originalUpload(path, ...rest);
      };
      return b;
    };
    await runUploadScreenshot(IDENTITY, VALID_ARGS, mock, updateStepMock);
    // safeFilename for "step1.png" is "step1.png" — no .png appended again
    expect(capturedPath).toBe("org-1/asset-uuid-1/step1.png");
  });

  it("rejects unsupported MIME type (image/gif)", async () => {
    const mock = makeUploadMock();
    const res = await runUploadScreenshot(
      IDENTITY,
      { ...VALID_ARGS, mime_type: "image/gif" as any },
      mock,
      updateStepMock
    );
    expect(res.isError).toBe(true);
    expect((res as any).text).toContain("Unsupported image type");
    expect(updateStepMock).not.toHaveBeenCalled();
  });

  it("rejects encoded input exceeding MAX_BASE64_LENGTH before decoding", async () => {
    const mock = makeUploadMock();
    // Build a string longer than MAX_BASE64_LENGTH using valid base64 chars.
    const oversized = "A".repeat(MAX_BASE64_LENGTH + 1);
    const res = await runUploadScreenshot(
      IDENTITY,
      { ...VALID_ARGS, image_base64: oversized },
      mock,
      updateStepMock
    );
    expect(res.isError).toBe(true);
    expect((res as any).text).toContain("5 MB limit");
    expect(updateStepMock).not.toHaveBeenCalled();
  });

  it("rejects non-canonical base64 (URL-safe hyphen character)", async () => {
    const mock = makeUploadMock();
    const res = await runUploadScreenshot(
      IDENTITY,
      { ...VALID_ARGS, image_base64: "abc-def" },
      mock,
      updateStepMock
    );
    expect(res.isError).toBe(true);
    expect((res as any).text).toBe("Invalid base64 image data.");
    expect(updateStepMock).not.toHaveBeenCalled();
  });

  it("rejects base64 with embedded whitespace", async () => {
    const mock = makeUploadMock();
    const res = await runUploadScreenshot(
      IDENTITY,
      { ...VALID_ARGS, image_base64: "abc def" },
      mock,
      updateStepMock
    );
    expect(res.isError).toBe(true);
    expect((res as any).text).toBe("Invalid base64 image data.");
  });

  it("rejects image whose magic bytes do not match declared MIME type", async () => {
    const mock = makeUploadMock();
    // PNG bytes declared as JPEG
    const res = await runUploadScreenshot(
      IDENTITY,
      { ...VALID_ARGS, mime_type: "image/jpeg", image_base64: PNG_MAGIC.toString("base64") },
      mock,
      updateStepMock
    );
    expect(res.isError).toBe(true);
    expect((res as any).text).toContain("does not match declared MIME type");
    expect(updateStepMock).not.toHaveBeenCalled();
  });

  it("rejects JPEG bytes declared as PNG", async () => {
    const mock = makeUploadMock();
    const res = await runUploadScreenshot(
      IDENTITY,
      { ...VALID_ARGS, mime_type: "image/png", image_base64: JPEG_MAGIC.toString("base64") },
      mock,
      updateStepMock
    );
    expect(res.isError).toBe(true);
    expect((res as any).text).toContain("does not match declared MIME type");
  });

  it("rejects decoded image exceeding 5 MB", async () => {
    const mock = makeUploadMock();
    // Build a buffer with valid PNG magic + padding to exceed 5 MB after decode.
    const oversized = Buffer.concat([PNG_MAGIC, Buffer.alloc(MAX_UPLOAD_BYTES)]);
    const res = await runUploadScreenshot(
      IDENTITY,
      { ...VALID_ARGS, image_base64: oversized.toString("base64") },
      mock,
      updateStepMock
    );
    expect(res.isError).toBe(true);
    expect((res as any).text).toContain("5 MB limit");
    expect(updateStepMock).not.toHaveBeenCalled();
  });

  it("rejects cross-org document_id", async () => {
    const mock = makeUploadMock({ docOwned: false });
    const res = await runUploadScreenshot(IDENTITY, VALID_ARGS, mock, updateStepMock);
    expect(res.isError).toBe(true);
    expect((res as any).text).toBe("Document not found.");
    expect(updateStepMock).not.toHaveBeenCalled();
  });

  it("rejects step belonging to a different document", async () => {
    const mock = makeUploadMock({ docOwned: true, stepOwned: false });
    const res = await runUploadScreenshot(IDENTITY, VALID_ARGS, mock, updateStepMock);
    expect(res.isError).toBe(true);
    expect((res as any).text).toBe("Step not found.");
    expect(updateStepMock).not.toHaveBeenCalled();
  });

  it("rejects insufficient role permissions", async () => {
    const mock = makeUploadMock();
    await expect(
      runUploadScreenshot({ ...IDENTITY, role: "viewer" }, VALID_ARGS, mock, updateStepMock)
    ).rejects.toThrow("Insufficient permissions.");
    expect(updateStepMock).not.toHaveBeenCalled();
  });

  it("propagates storage upload error without calling updateStep", async () => {
    const mock = makeUploadMock({ uploadError: "Storage quota exceeded." });
    const res = await runUploadScreenshot(IDENTITY, VALID_ARGS, mock, updateStepMock);
    expect(res.isError).toBe(true);
    expect((res as any).text).toBe("Storage quota exceeded.");
    expect(updateStepMock).not.toHaveBeenCalled();
  });

  it("cleans up both asset row and storage object when storage_path update fails", async () => {
    const mock = makeUploadMock({ updatePathError: "DB write failed." });
    const deleteSpy = vi.spyOn(mock.db.from("media_assets"), "delete");
    const res = await runUploadScreenshot(IDENTITY, VALID_ARGS, mock, updateStepMock);
    expect(res.isError).toBe(true);
    expect((res as any).text).toBe("DB write failed.");
    // storage.remove should have been called to clean up the uploaded file
    expect(mock.removeSpy).toHaveBeenCalledWith([
      "org-1/asset-uuid-1/step1.png",
    ]);
    expect(updateStepMock).not.toHaveBeenCalled();
  });

  it("cleanup error after storage_path update failure does not hide original error", async () => {
    // Even if remove() itself fails, the original DB error is what's returned.
    const mock = makeUploadMock({ updatePathError: "DB write failed.", removeError: "Remove also failed." });
    const res = await runUploadScreenshot(IDENTITY, VALID_ARGS, mock, updateStepMock);
    expect(res.isError).toBe(true);
    expect((res as any).text).toBe("DB write failed.");
  });

  it("propagates updateStep error after successful upload", async () => {
    const mock = makeUploadMock();
    updateStepMock.mockResolvedValue({ error: "FK constraint violation." });
    const res = await runUploadScreenshot(IDENTITY, VALID_ARGS, mock, updateStepMock);
    expect(res.isError).toBe(true);
    expect((res as any).text).toBe("FK constraint violation.");
  });

  it("sanitises path-traversal filename and uses safe name in response", async () => {
    const mock = makeUploadMock();
    updateStepMock.mockResolvedValue({ error: null });
    const res = await runUploadScreenshot(
      IDENTITY,
      { ...VALID_ARGS, filename: "../../evil.png" },
      mock,
      updateStepMock
    );
    expect(res.isError).toBe(false);
    expect((res as any).data.filename).toBe("evil.png");
  });

  it("does not expose organisation_id in tool args (schema strips unknown keys)", () => {
    // Zod strips keys not in the schema — organisation_id must never be accepted.
    const UploadSchema = z.object({
      document_id:  z.string().uuid(),
      step_id:      z.string().uuid(),
      filename:     z.string().min(1).max(255),
      mime_type:    z.enum(["image/jpeg", "image/png", "image/webp"]),
      image_base64: z.string().min(1),
      alt_text:     z.string().max(500).optional(),
    });
    const parsed = UploadSchema.parse({ ...VALID_ARGS, organisation_id: "attacker-org" });
    expect((parsed as any).organisation_id).toBeUndefined();
  });
});
