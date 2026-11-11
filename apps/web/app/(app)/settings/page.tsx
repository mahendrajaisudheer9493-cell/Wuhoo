import { Terminal, ExternalLink } from "lucide-react";
import { requireOrganisation } from "@/lib/dal";
import { listTokensAction } from "./actions";
import { TokenManager } from "./token-manager";

// This page reads cookies via requireOrganisation — it is always dynamic.
// export const dynamic is incompatible with nextConfig.cacheComponents;
// use instant = false (same pattern as the app layout) instead.
export const instant = false;

// Public env var — safe to expose to the browser. Falls back to localhost
// for local development. Set NEXT_PUBLIC_MCP_URL in production to the
// deployed MCP server URL (e.g. https://mcp.yourapp.com/mcp).
const MCP_URL =
  process.env.NEXT_PUBLIC_MCP_URL ?? "http://localhost:3001/mcp";

const isLocalhost = MCP_URL.includes("localhost") || MCP_URL.includes("127.0.0.1");

// Minimal claude_desktop_config.json snippet shown to the user.
const claudeConfig = JSON.stringify(
  {
    mcpServers: {
      wuhoo: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/client-cli", MCP_URL],
        env: {
          WUHOO_TOKEN: "<paste your token here>",
        },
      },
    },
  },
  null,
  2
);

export default async function SettingsPage() {
  const { user, membership } = await requireOrganisation();
  const org = membership.organisations as unknown as { id: string; name: string } | null;

  const tokens = await listTokensAction();

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      {/* Page title */}
      <div>
        <h2 className="text-base font-semibold text-[#17172A]">Settings</h2>
        <p className="mt-0.5 text-sm text-[#64748B]">
          Manage your MCP integration for {org?.name ?? "your organisation"}.
        </p>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* MCP token management                                                */}
      {/* ------------------------------------------------------------------ */}
      <section className="rounded-xl border border-[#E2E8F0] bg-white">
        <div className="border-b border-[#E2E8F0] px-5 py-4">
          <h3 className="text-sm font-semibold text-[#17172A]">
            API tokens
          </h3>
          <p className="mt-0.5 text-xs text-[#64748B]">
            Tokens authenticate Claude Desktop with this workspace via the MCP
            server. Each token grants access to your organisation's
            documentation.
          </p>
        </div>

        <TokenManager
          initialTokens={tokens}
          currentUserId={user.id}
          userRole={membership.role}
        />
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Claude Desktop connection instructions                              */}
      {/* ------------------------------------------------------------------ */}
      <section className="rounded-xl border border-[#E2E8F0] bg-white">
        <div className="border-b border-[#E2E8F0] px-5 py-4">
          <div className="flex items-center gap-2">
            <Terminal size={15} className="text-[#4F46E5]" />
            <h3 className="text-sm font-semibold text-[#17172A]">
              Connect Claude Desktop
            </h3>
          </div>
          <p className="mt-0.5 text-xs text-[#64748B]">
            Follow these steps to connect Claude Desktop to Wuhoo using the
            Model Context Protocol.
          </p>
        </div>

        <div className="space-y-5 px-5 py-5">
          {/* Endpoint */}
          <div>
            <p className="mb-1.5 text-xs font-medium text-[#17172A]">
              MCP server endpoint
            </p>
            <div className="flex items-center gap-2 rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-2">
              <code className="flex-1 font-mono text-xs text-[#17172A]">
                {MCP_URL}
              </code>
            </div>
            {isLocalhost && (
              <p className="mt-1 text-xs text-amber-700">
                ⚠ This is a local development endpoint. The MCP server must be
                running on your machine (
                <code className="font-mono">pnpm dev:mcp</code>).
              </p>
            )}
          </div>

          {/* Steps */}
          <ol className="space-y-3 text-sm text-[#64748B]">
            <li className="flex gap-2.5">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#F5F3FF] text-xs font-semibold text-[#4F46E5]">
                1
              </span>
              <span>
                Create an API token above (Owner or Admin role required).
                Copy it immediately — it will not be shown again.
              </span>
            </li>
            <li className="flex gap-2.5">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#F5F3FF] text-xs font-semibold text-[#4F46E5]">
                2
              </span>
              <span>
                Open your Claude Desktop configuration file:
                <br />
                <code className="mt-0.5 inline-block rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-[#17172A]">
                  ~/Library/Application Support/Claude/claude_desktop_config.json
                </code>
              </span>
            </li>
            <li className="flex gap-2.5">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#F5F3FF] text-xs font-semibold text-[#4F46E5]">
                3
              </span>
              <span>
                Add the following configuration, replacing{" "}
                <code className="rounded bg-slate-100 px-1 font-mono text-xs text-[#17172A]">
                  &lt;paste your token here&gt;
                </code>{" "}
                with your token:
              </span>
            </li>
          </ol>

          {/* Config snippet */}
          <div className="rounded-lg border border-[#E2E8F0] bg-[#F8FAFC]">
            <div className="flex items-center justify-between border-b border-[#E2E8F0] px-3 py-2">
              <span className="font-mono text-xs text-[#94A3B8]">
                claude_desktop_config.json
              </span>
            </div>
            <pre className="overflow-x-auto px-4 py-3 font-mono text-xs text-[#17172A]">
              {claudeConfig}
            </pre>
          </div>

          <ol className="space-y-3 text-sm text-[#64748B]" start={4}>
            <li className="flex gap-2.5">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#F5F3FF] text-xs font-semibold text-[#4F46E5]">
                4
              </span>
              <span>
                Save the file and restart Claude Desktop. Wuhoo will appear as
                an available MCP server.
              </span>
            </li>
          </ol>

          <a
            href="https://modelcontextprotocol.io/quickstart/user"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-xs font-medium text-[#4F46E5] hover:underline"
          >
            MCP documentation
            <ExternalLink size={11} />
          </a>
        </div>
      </section>
    </div>
  );
}
