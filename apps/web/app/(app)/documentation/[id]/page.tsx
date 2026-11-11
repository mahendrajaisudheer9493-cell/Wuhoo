import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireOrganisation } from "@/lib/dal";
import { createClient } from "@/lib/supabase/server";
import { getDocumentWithSteps } from "@/lib/services/documents";
import { listCollections } from "@/lib/services/collections";
import { listCategories } from "@/lib/services/categories";
import { getSignedUrl } from "@/lib/services/media";
import { DocumentEditor } from "./document-editor";
import { DocumentMeta } from "./document-meta";
import { DocumentPreview } from "./document-preview";

export const instant = false;

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function DocumentEditorPage({ params }: PageProps) {
  const { id } = await params;

  const { membership } = await requireOrganisation();
  const org = membership.organisations as unknown as { id: string } | null;
  const orgId = org?.id ?? "";

  const supabase = await createClient();
  const doc = await getDocumentWithSteps(supabase, id);

  if (!doc) notFound();

  // Resolve signed URLs for any steps that have media.
  const stepsWithUrls = await Promise.all(
    doc.steps.map(async (step) => {
      if (!step.media_asset_id) return step;
      // Fetch the storage_path for this asset.
      const { data: asset } = await supabase
        .from("media_assets")
        .select("storage_path")
        .eq("id", step.media_asset_id)
        .single();
      if (!asset) return step;
      const url = await getSignedUrl(supabase, asset.storage_path);
      return { ...step, media_url: url };
    })
  );

  // Build collection+category options for the meta sidebar.
  const collections = await listCollections(supabase, orgId);
  const categoryResults = await Promise.all(
    collections.map((col) => listCategories(supabase, col.id))
  );
  const collectionOptions = collections.map((col, i) => ({
    id: col.id,
    name: col.name,
    categories: categoryResults[i].map((cat) => ({ id: cat.id, name: cat.name })),
  }));

  const canPublish = membership.role === "owner" || membership.role === "admin";

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      {/* Back + header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link
            href="/documentation"
            className="flex items-center gap-1.5 text-sm text-[#64748B] hover:text-[#17172A]"
          >
            <ArrowLeft size={14} />
            Documentation
          </Link>
          <span className="text-[#CBD5E1]">/</span>
          <h2 className="text-sm font-semibold text-[#17172A] truncate max-w-xs">{doc.title}</h2>
        </div>
        <DocumentPreview title={doc.title} steps={stepsWithUrls} />
      </div>

      {/* Two-column layout */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_280px]">
        {/* Steps editor */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-[#17172A]">Steps</h3>
            <span className="text-xs text-[#94A3B8]">{doc.steps.length} step{doc.steps.length !== 1 ? "s" : ""}</span>
          </div>
          <DocumentEditor documentId={id} initialSteps={stepsWithUrls} />
        </div>

        {/* Meta sidebar */}
        <div className="space-y-4">
          <DocumentMeta
            documentId={id}
            title={doc.title}
            status={doc.status}
            categoryId={doc.category?.id ?? null}
            collections={collectionOptions}
            canPublish={canPublish}
          />
        </div>
      </div>
    </div>
  );
}
