import { FileText, Globe, FilePen, Clock, Plus, Activity } from "lucide-react";
import Link from "next/link";
import { MetricCard } from "@/components/metric-card";
import { EmptyState } from "@/components/empty-state";
import { requireOrganisation } from "@/lib/dal";
import { createClient } from "@/lib/supabase/server";
import { getDocumentStats, getRecentDocuments } from "@/lib/services/documents";

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export default async function DashboardPage() {
  const { membership } = await requireOrganisation();
  const org = membership.organisations as unknown as { id: string; name: string } | null;
  const orgId = org?.id ?? "";

  const supabase = await createClient();
  const [stats, recentDocs] = await Promise.all([
    getDocumentStats(supabase, orgId),
    getRecentDocuments(supabase, orgId, 5),
  ]);

  const hour = new Date().getHours();
  const greeting =
    hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      {/* Welcome */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-xl font-semibold text-[#17172A]">{greeting}</h2>
          <p className="mt-1 text-sm text-[#64748B]">
            Your workspace is ready. Create documentation from screenshots or screen recordings.
          </p>
        </div>
        <Link
          href="/documentation"
          className="flex items-center gap-2 rounded-lg bg-[#4F46E5] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[#4338CA]"
        >
          <Plus size={15} />
          Create Documentation
        </Link>
      </div>

      {/* Metrics */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <MetricCard label="Total Documents" value={stats.total}>
          <FileText size={18} />
        </MetricCard>
        <MetricCard label="Published" value={stats.published}>
          <Globe size={18} />
        </MetricCard>
        <MetricCard label="Drafts" value={stats.draft}>
          <FilePen size={18} />
        </MetricCard>
      </div>

      {/* Recent Documents */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-[#17172A]">Recent Documents</h3>
          {recentDocs.length > 0 && (
            <Link href="/documentation" className="text-xs font-medium text-[#4F46E5] hover:underline">
              View all
            </Link>
          )}
        </div>
        <div className="rounded-xl border border-[#E2E8F0] bg-white">
          {recentDocs.length === 0 ? (
            <EmptyState
              title="No documents yet"
              description="Documents you create will appear here. Connect Claude via MCP to get started."
            >
              <Clock size={18} />
            </EmptyState>
          ) : (
            <ul className="divide-y divide-[#E2E8F0]">
              {recentDocs.map((doc) => (
                <li key={doc.id} className="flex items-center justify-between px-5 py-3.5">
                  <div className="flex items-center gap-3 min-w-0">
                    <FileText size={15} className="shrink-0 text-[#94A3B8]" />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-[#17172A]">{doc.title}</p>
                      {doc.category && (
                        <p className="text-xs text-[#94A3B8]">
                          {doc.category.collection?.name
                            ? `${doc.category.collection.name} › ${doc.category.name}`
                            : doc.category.name}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="ml-4 flex shrink-0 items-center gap-3">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                        doc.status === "published"
                          ? "bg-emerald-50 text-emerald-700"
                          : "bg-[#F5F3FF] text-[#4F46E5]"
                      }`}
                    >
                      {doc.status === "published" ? "Published" : "Draft"}
                    </span>
                    <span className="text-xs text-[#94A3B8]">{formatDate(doc.updated_at)}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {/* Recent Activity — no audit log in schema */}
      <section>
        <h3 className="mb-3 text-sm font-semibold text-[#17172A]">Recent Activity</h3>
        <div className="rounded-xl border border-[#E2E8F0] bg-white">
          <EmptyState
            title="No activity yet"
            description="Actions taken on your documents will be recorded here."
          >
            <Activity size={18} />
          </EmptyState>
        </div>
      </section>
    </div>
  );
}
