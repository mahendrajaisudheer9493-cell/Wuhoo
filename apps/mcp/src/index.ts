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

  return server;
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
      res.setHeader("Access-Control-Allow-Origin", "https://claude.ai");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Mcp-Session-Id");
      res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
      res.setHeader("Vary", "Origin");

      // Handle OPTIONS preflight before auth — the preflight carries no
      // credentials and must succeed for the browser to send the real request.
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      // Authenticate every request via Bearer token
      const identity = await validateBearerToken(
        req.headers["authorization"] as string | undefined
      );

      if (!identity) {
        res.writeHead(401, { "Content-Type": "application/json" });
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
        await transport.handleRequest(req, res, body);
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
