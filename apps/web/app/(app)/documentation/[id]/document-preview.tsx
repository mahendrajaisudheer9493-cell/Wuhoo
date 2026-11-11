"use client";

import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import type { StepRow } from "@/lib/services/steps";

interface DocumentPreviewProps {
  title: string;
  steps: StepRow[];
}

export function DocumentPreview({ title, steps }: DocumentPreviewProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 rounded-lg border border-[#E2E8F0] bg-white px-4 py-2 text-sm font-medium text-[#17172A] transition-colors hover:bg-slate-50"
      >
        <Eye size={14} />
        Preview
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-6">
          <div className="w-full max-w-2xl rounded-2xl bg-white shadow-xl">
            {/* Preview header */}
            <div className="flex items-center justify-between border-b border-[#E2E8F0] px-6 py-4">
              <span className="text-xs font-medium uppercase tracking-wide text-[#94A3B8]">
                Preview
              </span>
              <button
                onClick={() => setOpen(false)}
                className="flex items-center gap-1.5 text-xs text-[#64748B] hover:text-[#17172A]"
              >
                <EyeOff size={13} />
                Close
              </button>
            </div>

            {/* Content */}
            <div className="px-8 py-6 space-y-8">
              <h1 className="text-2xl font-bold text-[#17172A]">{title}</h1>

              {steps.length === 0 ? (
                <p className="text-sm text-[#94A3B8]">No steps added yet.</p>
              ) : (
                <ol className="space-y-8">
                  {steps.map((step, i) => (
                    <li key={step.id} className="space-y-3">
                      <div className="flex items-start gap-3">
                        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#4F46E5] text-xs font-bold text-white">
                          {i + 1}
                        </span>
                        <div className="space-y-1">
                          {step.heading && (
                            <h2 className="text-base font-semibold text-[#17172A]">
                              {step.heading}
                            </h2>
                          )}
                          {step.content && (
                            <p className="whitespace-pre-wrap text-sm text-[#64748B]">
                              {step.content}
                            </p>
                          )}
                        </div>
                      </div>
                      {step.media_url && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={step.media_url}
                          alt={step.heading ?? `Step ${i + 1}`}
                          className="ml-9 max-h-80 w-full rounded-xl border border-[#E2E8F0] object-contain"
                        />
                      )}
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
