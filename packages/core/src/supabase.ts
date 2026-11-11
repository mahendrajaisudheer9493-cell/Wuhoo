/**
 * Minimal structural interface for a Supabase client as used by @wuhoo/core
 * service functions. Defined locally so packages/core does not import from
 * @supabase/supabase-js directly, avoiding NodeNext module-resolution
 * import-attribute type identity conflicts when consumed by apps with
 * different moduleResolution settings.
 *
 * The real SupabaseClient from @supabase/supabase-js satisfies this interface
 * structurally — no cast is needed at call sites.
 */
export interface SupabaseClientLike {
  from(table: string): any;
  rpc(fn: string, args?: Record<string, unknown>): any;
  storage: {
    from(bucket: string): {
      upload(
        path: string,
        file: File | Blob | ArrayBuffer | ArrayBufferView,
        options?: { contentType?: string; upsert?: boolean }
      ): Promise<{ error: { message: string } | null }>;
      createSignedUrl(
        path: string,
        expiresIn: number
      ): Promise<{ data: { signedUrl: string } | null }>;
    };
  };
}
