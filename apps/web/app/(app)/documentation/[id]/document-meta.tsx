"use client";

import { useState, useActionState, useEffect } from "react";
import { Pencil, Check, Loader2, Globe, EyeOff } from "lucide-react";
import { updateDocumentAction, publishDocumentAction, unpublishDocumentAction } from "./actions";

interface CategoryOption {
  id: string;
  name: string;
}

interface CollectionOption {
  id: string;
  name: string;
  categories: CategoryOption[];
}

interface DocumentMetaProps {
  documentId: string;
  title: string;
  status: "draft" | "published";
  categoryId: string | null;
  collections: CollectionOption[];
  canPublish: boolean;
}

export function DocumentMeta({
  documentId,
  title,
  status,
  categoryId,
  collections,
  canPublish,
}: DocumentMetaProps) {
  const [editingTitle, setEditingTitle] = useState(false);
  const [selectedCollectionId, setSelectedCollectionId] = useState(
    () => collections.find((c) => c.categories.some((cat) => cat.id === categoryId))?.id ?? ""
  );

  const [updateState, updateDispatch, updatePending] = useActionState(updateDocumentAction, null);
  const [publishState, publishDispatch, publishPending] = useActionState(publishDocumentAction, null);
  const [unpublishState, unpublishDispatch, unpublishPending] = useActionState(unpublishDocumentAction, null);

  useEffect(() => {
    if (updateState?.success) setEditingTitle(false);
  }, [updateState]);

  const categories =
    collections.find((c) => c.id === selectedCollectionId)?.categories ?? [];

  return (
    <div className="rounded-xl border border-[#E2E8F0] bg-white p-5 space-y-4">
      {/* Title */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="text-xs font-medium text-[#17172A]">Title</label>
          {!editingTitle && (
            <button
              onClick={() => setEditingTitle(true)}
              className="flex items-center gap-1 text-xs text-[#4F46E5] hover:text-[#4338CA]"
            >
              <Pencil size={11} /> Edit
            </button>
          )}
        </div>
        {editingTitle ? (
          <form action={updateDispatch} className="flex gap-2">
            <input type="hidden" name="id" value={documentId} />
            <input
              name="title"
              defaultValue={title}
              required
              maxLength={200}
              autoFocus
              className="flex-1 rounded-lg border border-[#E2E8F0] px-3 py-1.5 text-sm text-[#17172A] focus:border-[#4F46E5] focus:outline-none focus:ring-2 focus:ring-[#4F46E5]/20"
            />
            <button
              type="submit"
              disabled={updatePending}
              className="flex items-center gap-1 rounded-lg bg-[#4F46E5] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#4338CA] disabled:opacity-60"
            >
              {updatePending ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />}
              Save
            </button>
            <button
              type="button"
              onClick={() => setEditingTitle(false)}
              className="rounded-lg px-2 py-1.5 text-xs text-[#64748B] hover:bg-slate-100"
            >
              Cancel
            </button>
          </form>
        ) : (
          <p className="text-sm font-medium text-[#17172A]">{title}</p>
        )}
        {updateState?.error && (
          <p className="mt-1 text-xs text-red-600">{updateState.error}</p>
        )}
      </div>

      {/* Category */}
      <form action={updateDispatch} className="space-y-3">
        <input type="hidden" name="id" value={documentId} />
        <div>
          <label className="mb-1 block text-xs font-medium text-[#17172A]">Collection</label>
          <select
            value={selectedCollectionId}
            onChange={(e) => setSelectedCollectionId(e.target.value)}
            className="w-full rounded-lg border border-[#E2E8F0] px-3 py-2 text-sm text-[#17172A] focus:border-[#4F46E5] focus:outline-none focus:ring-2 focus:ring-[#4F46E5]/20"
          >
            <option value="">No collection</option>
            {collections.map((col) => (
              <option key={col.id} value={col.id}>
                {col.name}
              </option>
            ))}
          </select>
        </div>
        {selectedCollectionId && (
          <div>
            <label className="mb-1 block text-xs font-medium text-[#17172A]">Category</label>
            <select
              name="category_id"
              defaultValue={categoryId ?? ""}
              className="w-full rounded-lg border border-[#E2E8F0] px-3 py-2 text-sm text-[#17172A] focus:border-[#4F46E5] focus:outline-none focus:ring-2 focus:ring-[#4F46E5]/20"
            >
              <option value="">No category</option>
              {categories.map((cat) => (
                <option key={cat.id} value={cat.id}>
                  {cat.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="flex justify-end">
          <button
            type="submit"
            disabled={updatePending}
            className="rounded-lg bg-slate-100 px-3 py-1.5 text-xs font-medium text-[#17172A] hover:bg-slate-200 disabled:opacity-60"
          >
            {updatePending ? "Saving…" : "Save"}
          </button>
        </div>
      </form>

      {/* Status + publish */}
      <div className="border-t border-[#F1F5F9] pt-4 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-[#17172A]">Status</span>
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium ${
              status === "published"
                ? "bg-emerald-50 text-emerald-700"
                : "bg-[#F5F3FF] text-[#4F46E5]"
            }`}
          >
            {status === "published" ? "Published" : "Draft"}
          </span>
        </div>

        {canPublish && (
          <>
            {status === "draft" ? (
              <form action={publishDispatch}>
                <input type="hidden" name="id" value={documentId} />
                <button
                  type="submit"
                  disabled={publishPending}
                  className="flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 px-3 py-2 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-60"
                >
                  {publishPending ? <Loader2 size={12} className="animate-spin" /> : <Globe size={12} />}
                  {publishPending ? "Publishing…" : "Publish"}
                </button>
                {publishState?.error && (
                  <p className="mt-1 text-xs text-red-600">{publishState.error}</p>
                )}
              </form>
            ) : (
              <form action={unpublishDispatch}>
                <input type="hidden" name="id" value={documentId} />
                <button
                  type="submit"
                  disabled={unpublishPending}
                  className="flex w-full items-center justify-center gap-2 rounded-lg border border-[#E2E8F0] px-3 py-2 text-xs font-medium text-[#64748B] hover:bg-slate-50 disabled:opacity-60"
                >
                  {unpublishPending ? <Loader2 size={12} className="animate-spin" /> : <EyeOff size={12} />}
                  {unpublishPending ? "Unpublishing…" : "Unpublish"}
                </button>
                {unpublishState?.error && (
                  <p className="mt-1 text-xs text-red-600">{unpublishState.error}</p>
                )}
              </form>
            )}
          </>
        )}
      </div>
    </div>
  );
}
