"use client";

import { useState, useActionState, useEffect, useRef } from "react";
import { Plus, X } from "lucide-react";
import { createDocumentAction } from "./actions";

interface CategoryOption {
  id: string;
  name: string;
}

interface CollectionOption {
  id: string;
  name: string;
  categories: CategoryOption[];
}

interface NewDocumentDialogProps {
  collections: CollectionOption[];
}

export function NewDocumentDialog({ collections }: NewDocumentDialogProps) {
  const [open, setOpen] = useState(false);
  const [selectedCollectionId, setSelectedCollectionId] = useState("");
  const [state, dispatch, pending] = useActionState(createDocumentAction, null);
  const formRef = useRef<HTMLFormElement>(null);

  const categories =
    collections.find((c) => c.id === selectedCollectionId)?.categories ?? [];

  // Close on success (redirect happens server-side, but guard anyway).
  useEffect(() => {
    if (state?.success) setOpen(false);
  }, [state]);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 rounded-lg bg-[#4F46E5] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[#4338CA]"
      >
        <Plus size={15} />
        New document
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
            <div className="mb-5 flex items-center justify-between">
              <h2 className="text-base font-semibold text-[#17172A]">New document</h2>
              <button
                onClick={() => setOpen(false)}
                className="flex h-7 w-7 items-center justify-center rounded-md text-[#94A3B8] hover:bg-slate-100"
              >
                <X size={15} />
              </button>
            </div>

            <form ref={formRef} action={dispatch} className="space-y-4">
              <div>
                <label className="mb-1 block text-xs font-medium text-[#17172A]">Title</label>
                <input
                  name="title"
                  required
                  maxLength={200}
                  autoFocus
                  className="w-full rounded-lg border border-[#E2E8F0] px-3 py-2 text-sm text-[#17172A] placeholder:text-[#94A3B8] focus:border-[#4F46E5] focus:outline-none focus:ring-2 focus:ring-[#4F46E5]/20"
                  placeholder="e.g. How to install the app"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-[#17172A]">
                  Collection <span className="font-normal text-[#94A3B8]">(optional)</span>
                </label>
                <select
                  value={selectedCollectionId}
                  onChange={(e) => {
                    setSelectedCollectionId(e.target.value);
                  }}
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
                  <label className="mb-1 block text-xs font-medium text-[#17172A]">
                    Category <span className="font-normal text-[#94A3B8]">(optional)</span>
                  </label>
                  <select
                    name="category_id"
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

              {state?.error && (
                <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">{state.error}</p>
              )}

              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="rounded-lg px-3 py-1.5 text-sm text-[#64748B] hover:bg-slate-100"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={pending}
                  className="rounded-lg bg-[#4F46E5] px-3 py-1.5 text-sm font-medium text-white hover:bg-[#4338CA] disabled:opacity-60"
                >
                  {pending ? "Creating…" : "Create document"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
