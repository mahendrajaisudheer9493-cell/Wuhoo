import { Suspense } from "react";
import { FileText } from "lucide-react";
import Link from "next/link";
import { requireOrganisation } from "@/lib/dal";
import { createClient } from "@/lib/supabase/server";
import { listDocuments } from "@/lib/services/documents";
import { listCollections } from "@/lib/services/collections";
import { listCategories } from "@/lib/services/categories";
import { DocumentsFilter } from "./documents-filter";
import { NewDocumentDialog } from "./new-document-dialog";

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

interface PageProps {
  searchParams: Promise<{ status?: string; search?: string }>;
}

export default async function DocumentationPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const statusFilter =
    params.status === "draft" || params.status === "published"
      ? params.status
      : undefined;
  const searchFilter = params.search?.trim() || undefined;

  const { membership } = await requireOrganisation();
  const org = membership.organisations as unknown as { id: string } | null;
  const orgId = org?.id ?? "";

  const supabase = await createClient();

  const [documents, collections] = await Promise.all([
    listDocuments(supabase, orgId, { status: statusFilter, search: searchFilter }),
    listCollections(supabase, orgId),
  ]);

  // Build collection+category options for the dialog.
  const categoryResults = await Promise.all(
    collections.map((col) => listCategories(supabase, col.id))
  );
  const collectionOptions = collections.map((col, i) => ({
    id: col.id,
    name: col.name,
    categories: categoryResults[i].map((cat) => ({ id: cat.id, name: cat.name })),
  }));

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-[#17172A]">Documentation</h2>
          <p className="text-sm text-[#64748B]">All documents in your workspace.</p>
        </div>
        <NewDocumentDialog collections={collectionOptions} />
      </div>

      {/* Filters */}
      <Suspense>
        <DocumentsFilter />
      </Suspense>

      {/* Document list */}
      <div className="rounded-xl border border-[#E2E8F0] bg-white">
        {documents.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[#F5F3FF] text-[#4F46E5]">
              <FileText size={18} />
            </div>
            <p className="text-sm font-medium text-[#17172A]">
              {statusFilter || searchFilter ? "No matching documents" : "No documents yet"}
            </p>
            <p className="max-w-xs text-xs text-[#64748B]">
              {statusFilter || searchFilter
                ? "Try adjusting your filters."
                : "Create your first document to get started."}
            </p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-[1fr_auto_auto_auto] gap-4 border-b border-[#E2E8F0] px-5 py-2.5">
              <span className="text-xs font-medium text-[#94A3B8]">Title</span>
              <span className="text-xs font-medium text-[#94A3B8]">Collection</span>
              <span className="text-xs font-medium text-[#94A3B8]">Status</span>
              <span className="text-xs font-medium text-[#94A3B8]">Updated</span>
            </div>
            <ul className="divide-y divide-[#E2E8F0]">
              {documents.map((doc) => (
                <li key={doc.id}>
                  <Link
                    href={`/documentation/${doc.id}`}
                    className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-4 px-5 py-3.5 transition-colors hover:bg-slate-50"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <FileText size={14} className="shrink-0 text-[#94A3B8]" />
                      <span className="truncate text-sm font-medium text-[#17172A]">
                        {doc.title}
                      </span>
                    </div>
                    <span className="text-xs text-[#64748B]">
                      {doc.category?.collection?.name ?? "—"}
                    </span>
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
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
