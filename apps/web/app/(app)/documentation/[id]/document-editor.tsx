"use client";

import { useState, useActionState, useEffect, useRef, useTransition } from "react";
import {
  Plus, Trash2, GripVertical, ChevronUp, ChevronDown, ImagePlus, Check, Loader2,
} from "lucide-react";
import {
  addStepAction,
  updateStepAction,
  deleteStepAction,
  reorderStepsAction,
  uploadMediaAction,
} from "./actions";
import type { StepRow } from "@/lib/services/steps";

interface StepEditorProps {
  step: StepRow;
  documentId: string;
  index: number;
  total: number;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDelete: () => void;
}

function StepEditor({ step, documentId, index, total, onMoveUp, onMoveDown, onDelete }: StepEditorProps) {
  const [editing, setEditing] = useState(!step.heading && !step.content);
  const [heading, setHeading] = useState(step.heading ?? "");
  const [content, setContent] = useState(step.content ?? "");
  const [updateState, updateDispatch, updatePending] = useActionState(updateStepAction, null);
  const [deleteState, deleteDispatch, deletePending] = useActionState(deleteStepAction, null);
  const [uploadState, uploadDispatch, uploadPending] = useActionState(uploadMediaAction, null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (updateState?.success) setEditing(false);
  }, [updateState]);

  useEffect(() => {
    if (deleteState?.success) onDelete();
  }, [deleteState, onDelete]);

  return (
    <div className="rounded-xl border border-[#E2E8F0] bg-white">
      {/* Step header */}
      <div className="flex items-center gap-2 border-b border-[#F1F5F9] px-4 py-2.5">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#F5F3FF] text-[10px] font-semibold text-[#4F46E5]">
          {index + 1}
        </span>
        <div className="flex flex-1 items-center gap-1">
          <button
            onClick={onMoveUp}
            disabled={index === 0}
            title="Move up"
            className="flex h-6 w-6 items-center justify-center rounded text-[#94A3B8] hover:bg-slate-100 disabled:opacity-30"
          >
            <ChevronUp size={13} />
          </button>
          <button
            onClick={onMoveDown}
            disabled={index === total - 1}
            title="Move down"
            className="flex h-6 w-6 items-center justify-center rounded text-[#94A3B8] hover:bg-slate-100 disabled:opacity-30"
          >
            <ChevronDown size={13} />
          </button>
          <GripVertical size={13} className="text-[#CBD5E1]" />
        </div>
        <div className="flex items-center gap-1">
          {!editing && (
            <button
              onClick={() => setEditing(true)}
              className="rounded-md px-2 py-1 text-xs text-[#4F46E5] hover:bg-[#F5F3FF]"
            >
              Edit
            </button>
          )}
          <form action={deleteDispatch}>
            <input type="hidden" name="step_id" value={step.id} />
            <input type="hidden" name="document_id" value={documentId} />
            <button
              type="submit"
              disabled={deletePending}
              title="Delete step"
              className="flex h-6 w-6 items-center justify-center rounded text-[#94A3B8] hover:bg-red-50 hover:text-red-500 disabled:opacity-40"
              onClick={(e) => {
                if (!confirm("Delete this step?")) e.preventDefault();
              }}
            >
              <Trash2 size={12} />
            </button>
          </form>
        </div>
      </div>

      {/* Step body */}
      <div className="p-4 space-y-3">
        {editing ? (
          <form action={updateDispatch} className="space-y-3">
            <input type="hidden" name="step_id" value={step.id} />
            <input type="hidden" name="document_id" value={documentId} />
            <div>
              <label className="mb-1 block text-xs font-medium text-[#17172A]">
                Heading <span className="font-normal text-[#94A3B8]">(optional)</span>
              </label>
              <input
                name="heading"
                value={heading}
                onChange={(e) => setHeading(e.target.value)}
                maxLength={200}
                className="w-full rounded-lg border border-[#E2E8F0] px-3 py-2 text-sm text-[#17172A] placeholder:text-[#94A3B8] focus:border-[#4F46E5] focus:outline-none focus:ring-2 focus:ring-[#4F46E5]/20"
                placeholder="Step heading"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-[#17172A]">Content</label>
              <textarea
                name="content"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                rows={4}
                className="w-full resize-y rounded-lg border border-[#E2E8F0] px-3 py-2 text-sm text-[#17172A] placeholder:text-[#94A3B8] focus:border-[#4F46E5] focus:outline-none focus:ring-2 focus:ring-[#4F46E5]/20"
                placeholder="Describe this step…"
              />
            </div>
            {updateState?.error && (
              <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">{updateState.error}</p>
            )}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setEditing(false)}
                className="rounded-lg px-3 py-1.5 text-xs text-[#64748B] hover:bg-slate-100"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={updatePending}
                className="flex items-center gap-1.5 rounded-lg bg-[#4F46E5] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#4338CA] disabled:opacity-60"
              >
                {updatePending ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                Save step
              </button>
            </div>
          </form>
        ) : (
          <div className="space-y-1">
            {step.heading && (
              <p className="text-sm font-medium text-[#17172A]">{step.heading}</p>
            )}
            {step.content ? (
              <p className="whitespace-pre-wrap text-sm text-[#64748B]">{step.content}</p>
            ) : (
              <p className="text-xs italic text-[#94A3B8]">No content yet — click Edit to add.</p>
            )}
          </div>
        )}

        {/* Screenshot */}
        <div className="border-t border-[#F1F5F9] pt-3">
          {step.media_url ? (
            <div className="relative">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={step.media_url}
                alt="Step screenshot"
                className="max-h-64 w-full rounded-lg object-contain border border-[#E2E8F0]"
              />
            </div>
          ) : (
            <form action={uploadDispatch}>
              <input type="hidden" name="step_id" value={step.id} />
              <input type="hidden" name="document_id" value={documentId} />
              <input
                ref={fileInputRef}
                type="file"
                name="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                className="hidden"
                onChange={(e) => {
                  if (e.target.files?.[0]) {
                    e.target.form?.requestSubmit();
                  }
                }}
              />
              <button
                type="button"
                disabled={uploadPending}
                onClick={() => fileInputRef.current?.click()}
                className="flex items-center gap-1.5 text-xs text-[#94A3B8] hover:text-[#4F46E5] disabled:opacity-50"
              >
                {uploadPending ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <ImagePlus size={13} />
                )}
                {uploadPending ? "Uploading…" : "Add screenshot"}
              </button>
              {uploadState?.error && (
                <p className="mt-1 text-xs text-red-600">{uploadState.error}</p>
              )}
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

interface DocumentEditorProps {
  documentId: string;
  initialSteps: StepRow[];
}

export function DocumentEditor({ documentId, initialSteps }: DocumentEditorProps) {
  const [steps, setSteps] = useState<StepRow[]>(initialSteps);
  const [reorderError, setReorderError] = useState<string | null>(null);
  const [addState, addDispatch, addPending] = useActionState(addStepAction, null);
  const [, startTransition] = useTransition();

  // Sync only when the step count changes (add / delete), not after a reorder
  // revalidation — that would overwrite the optimistic order.
  const prevCountRef = useRef(initialSteps.length);
  useEffect(() => {
    if (initialSteps.length !== prevCountRef.current) {
      prevCountRef.current = initialSteps.length;
      setSteps(initialSteps);
    }
  }, [initialSteps]);

  function move(fromIndex: number, toIndex: number) {
    const next = [...steps];
    const [item] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, item);
    setSteps(next);
    setReorderError(null);

    // Persist the new order by calling the server action directly with FormData.
    startTransition(async () => {
      const fd = new FormData();
      fd.set("document_id", documentId);
      fd.set("ordered_ids", JSON.stringify(next.map((s) => s.id)));
      const result = await reorderStepsAction(null, fd);
      if (result?.error) setReorderError(result.error);
    });
  }

  return (
    <div className="space-y-3">
      {steps.length === 0 && (
        <p className="rounded-xl border border-dashed border-[#E2E8F0] py-8 text-center text-sm text-[#94A3B8]">
          No steps yet. Add your first step below.
        </p>
      )}

      {steps.map((step, i) => (
        <StepEditor
          key={step.id}
          step={step}
          documentId={documentId}
          index={i}
          total={steps.length}
          onMoveUp={() => move(i, i - 1)}
          onMoveDown={() => move(i, i + 1)}
          onDelete={() => setSteps((prev) => prev.filter((s) => s.id !== step.id))}
        />
      ))}

      {reorderError && (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">{reorderError}</p>
      )}

      {/* Add step */}
      <form action={addDispatch}>
        <input type="hidden" name="document_id" value={documentId} />
        <input type="hidden" name="position" value={steps.length} />
        <button
          type="submit"
          disabled={addPending}
          className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-[#CBD5E1] py-3 text-sm text-[#64748B] transition-colors hover:border-[#4F46E5] hover:text-[#4F46E5] disabled:opacity-50"
        >
          {addPending ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
          Add step
        </button>
      </form>
    </div>
  );
}
