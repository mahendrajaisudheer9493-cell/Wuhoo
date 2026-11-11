"use client";

import { useActionState, useEffect, useRef } from "react";
import { createCategoryAction, updateCategoryAction } from "./category-actions";
import type { CategoryRow } from "@/lib/services/categories";

interface CategoryFormProps {
  collectionId: string;
  category?: CategoryRow;
  onDone: () => void;
}

export function CategoryForm({ collectionId, category, onDone }: CategoryFormProps) {
  const action = category ? updateCategoryAction : createCategoryAction;
  const [state, dispatch, pending] = useActionState(action, null);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state?.success) {
      formRef.current?.reset();
      onDone();
    }
  }, [state, onDone]);

  return (
    <form ref={formRef} action={dispatch} className="space-y-3">
      <input type="hidden" name="collection_id" value={collectionId} />
      {category && <input type="hidden" name="id" value={category.id} />}

      <div>
        <label className="mb-1 block text-xs font-medium text-[#17172A]">Name</label>
        <input
          name="name"
          required
          maxLength={100}
          defaultValue={category?.name}
          className="w-full rounded-lg border border-[#E2E8F0] px-3 py-2 text-sm text-[#17172A] placeholder:text-[#94A3B8] focus:border-[#4F46E5] focus:outline-none focus:ring-2 focus:ring-[#4F46E5]/20"
          placeholder="e.g. Installation"
        />
      </div>

      <div>
        <label className="mb-1 block text-xs font-medium text-[#17172A]">
          Description <span className="font-normal text-[#94A3B8]">(optional)</span>
        </label>
        <textarea
          name="description"
          rows={2}
          maxLength={500}
          defaultValue={category?.description ?? ""}
          className="w-full resize-none rounded-lg border border-[#E2E8F0] px-3 py-2 text-sm text-[#17172A] placeholder:text-[#94A3B8] focus:border-[#4F46E5] focus:outline-none focus:ring-2 focus:ring-[#4F46E5]/20"
          placeholder="A short description of this category"
        />
      </div>

      {state?.error && (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">{state.error}</p>
      )}

      <div className="flex justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onDone}
          className="rounded-lg px-3 py-1.5 text-sm text-[#64748B] hover:bg-slate-100"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-[#4F46E5] px-3 py-1.5 text-sm font-medium text-white hover:bg-[#4338CA] disabled:opacity-60"
        >
          {pending ? "Saving…" : category ? "Save changes" : "Create category"}
        </button>
      </div>
    </form>
  );
}
