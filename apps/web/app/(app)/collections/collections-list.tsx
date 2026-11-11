"use client";

import { useState, useActionState } from "react";
import { FolderOpen, Plus, Pencil, Trash2, FileText, Tag, ChevronDown, ChevronRight } from "lucide-react";
import { CollectionForm } from "./collection-form";
import { CategoryForm } from "./category-form";
import { deleteCollectionAction } from "./actions";
import { deleteCategoryAction } from "./category-actions";
import type { CollectionRow } from "@/lib/services/collections";
import type { CategoryRow } from "@/lib/services/categories";

interface CollectionsListProps {
  collections: CollectionRow[];
  categoriesByCollection: Record<string, CategoryRow[]>;
  canDelete: boolean;
}

function DeleteCollectionButton({ id }: { id: string }) {
  const [state, dispatch, pending] = useActionState(deleteCollectionAction, null);
  return (
    <form action={dispatch}>
      <input type="hidden" name="id" value={id} />
      <button
        type="submit"
        disabled={pending}
        title="Delete collection"
        className="flex h-7 w-7 items-center justify-center rounded-md text-[#94A3B8] transition-colors hover:bg-red-50 hover:text-red-500 disabled:opacity-40"
        onClick={(e) => {
          if (!confirm("Delete this collection? All categories and documents inside will be affected.")) {
            e.preventDefault();
          }
        }}
      >
        <Trash2 size={13} />
      </button>
      {state?.error && <p className="mt-1 text-xs text-red-600">{state.error}</p>}
    </form>
  );
}

function DeleteCategoryButton({ id }: { id: string }) {
  const [state, dispatch, pending] = useActionState(deleteCategoryAction, null);
  return (
    <form action={dispatch}>
      <input type="hidden" name="id" value={id} />
      <button
        type="submit"
        disabled={pending}
        title="Delete category"
        className="flex h-6 w-6 items-center justify-center rounded-md text-[#94A3B8] transition-colors hover:bg-red-50 hover:text-red-500 disabled:opacity-40"
        onClick={(e) => {
          if (!confirm("Delete this category? Documents inside will lose their category.")) {
            e.preventDefault();
          }
        }}
      >
        <Trash2 size={12} />
      </button>
      {state?.error && <p className="mt-1 text-xs text-red-600">{state.error}</p>}
    </form>
  );
}

function CategoryRow({
  category,
  canDelete,
}: {
  category: CategoryRow;
  canDelete: boolean;
}) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <div className="px-4 py-3">
        <CategoryForm
          collectionId={category.collection_id}
          category={category}
          onDone={() => setEditing(false)}
        />
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between px-4 py-2.5">
      <div className="flex items-center gap-2.5 min-w-0">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-slate-50 text-[#64748B]">
          <Tag size={13} />
        </div>
        <div className="min-w-0">
          <p className="text-sm text-[#17172A]">{category.name}</p>
          {category.description && (
            <p className="truncate text-xs text-[#94A3B8]">{category.description}</p>
          )}
        </div>
      </div>
      <div className="ml-4 flex shrink-0 items-center gap-2">
        <span className="flex items-center gap-1 text-xs text-[#94A3B8]">
          <FileText size={11} />
          {category.document_count}
        </span>
        <button
          onClick={() => setEditing(true)}
          title="Edit category"
          className="flex h-6 w-6 items-center justify-center rounded-md text-[#94A3B8] transition-colors hover:bg-slate-100 hover:text-[#17172A]"
        >
          <Pencil size={12} />
        </button>
        {canDelete && <DeleteCategoryButton id={category.id} />}
      </div>
    </div>
  );
}

function CollectionItem({
  col,
  categories,
  canDelete,
}: {
  col: CollectionRow;
  categories: CategoryRow[];
  canDelete: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [editingCollection, setEditingCollection] = useState(false);
  const [creatingCategory, setCreatingCategory] = useState(false);

  return (
    <div className="rounded-xl border border-[#E2E8F0] bg-white">
      {editingCollection ? (
        <div className="p-5">
          <p className="mb-4 text-sm font-medium text-[#17172A]">Edit collection</p>
          <CollectionForm collection={col} onDone={() => setEditingCollection(false)} />
        </div>
      ) : (
        <>
          {/* Collection header row */}
          <div className="flex items-center justify-between px-5 py-4">
            <button
              onClick={() => setExpanded((v) => !v)}
              className="flex items-center gap-3 min-w-0 flex-1 text-left"
            >
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#F5F3FF] text-[#4F46E5]">
                <FolderOpen size={16} />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium text-[#17172A]">{col.name}</p>
                {col.description && (
                  <p className="truncate text-xs text-[#64748B]">{col.description}</p>
                )}
              </div>
              <span className="ml-2 shrink-0 text-[#94A3B8]">
                {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </span>
            </button>

            <div className="ml-4 flex shrink-0 items-center gap-3">
              <span className="flex items-center gap-1 text-xs text-[#94A3B8]">
                <FileText size={12} />
                {col.document_count} {col.document_count === 1 ? "doc" : "docs"}
              </span>
              <button
                onClick={() => setEditingCollection(true)}
                title="Edit collection"
                className="flex h-7 w-7 items-center justify-center rounded-md text-[#94A3B8] transition-colors hover:bg-slate-100 hover:text-[#17172A]"
              >
                <Pencil size={13} />
              </button>
              {canDelete && <DeleteCollectionButton id={col.id} />}
            </div>
          </div>

          {/* Expanded: categories */}
          {expanded && (
            <div className="border-t border-[#E2E8F0]">
              {categories.length === 0 && !creatingCategory && (
                <p className="px-5 py-3 text-xs text-[#94A3B8]">No categories yet.</p>
              )}

              {categories.map((cat) => (
                <div key={cat.id} className="border-b border-[#F1F5F9] last:border-0">
                  <CategoryRow category={cat} canDelete={canDelete} />
                </div>
              ))}

              {creatingCategory && (
                <div className="border-t border-[#E2E8F0] px-4 py-3">
                  <CategoryForm
                    collectionId={col.id}
                    onDone={() => setCreatingCategory(false)}
                  />
                </div>
              )}

              {!creatingCategory && (
                <div className="border-t border-[#F1F5F9] px-4 py-2.5">
                  <button
                    onClick={() => setCreatingCategory(true)}
                    className="flex items-center gap-1.5 text-xs font-medium text-[#4F46E5] hover:text-[#4338CA]"
                  >
                    <Plus size={12} />
                    Add category
                  </button>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function CollectionsList({
  collections,
  categoriesByCollection,
  canDelete,
}: CollectionsListProps) {
  const [creating, setCreating] = useState(false);

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-[#17172A]">Collections</h2>
          <p className="text-sm text-[#64748B]">
            Group your documentation into organised collections.
          </p>
        </div>
        {!creating && (
          <button
            onClick={() => setCreating(true)}
            className="flex items-center gap-2 rounded-lg bg-[#4F46E5] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[#4338CA]"
          >
            <Plus size={15} />
            New collection
          </button>
        )}
      </div>

      {/* Create form */}
      {creating && (
        <div className="rounded-xl border border-[#4F46E5]/30 bg-white p-5 shadow-sm">
          <p className="mb-4 text-sm font-medium text-[#17172A]">New collection</p>
          <CollectionForm onDone={() => setCreating(false)} />
        </div>
      )}

      {/* List */}
      {collections.length === 0 && !creating ? (
        <div className="rounded-xl border border-[#E2E8F0] bg-white">
          <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[#F5F3FF] text-[#4F46E5]">
              <FolderOpen size={18} />
            </div>
            <p className="text-sm font-medium text-[#17172A]">No collections yet</p>
            <p className="max-w-xs text-xs text-[#64748B]">
              Group your documentation into collections to keep things organised.
            </p>
            <button
              onClick={() => setCreating(true)}
              className="mt-2 flex items-center gap-1.5 rounded-lg bg-[#4F46E5] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#4338CA]"
            >
              <Plus size={13} />
              Create your first collection
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {collections.map((col) => (
            <CollectionItem
              key={col.id}
              col={col}
              categories={categoriesByCollection[col.id] ?? []}
              canDelete={canDelete}
            />
          ))}
        </div>
      )}
    </div>
  );
}
