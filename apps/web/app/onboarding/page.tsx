"use client";

import { useActionState } from "react";
import { createOrganisation } from "./actions";

export default function OnboardingPage() {
  const [state, action, pending] = useActionState(createOrganisation, null);

  return (
    <div className="flex min-h-full flex-col items-center justify-center bg-[#F8FAFC] px-4">
      <div className="mb-8 flex items-center gap-2.5">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#4F46E5]">
          <span className="text-sm font-bold text-white">W</span>
        </div>
        <span className="text-base font-semibold text-[#17172A]">Wuhoo</span>
      </div>

      <div className="w-full max-w-sm">
        <div className="rounded-xl border border-[#E2E8F0] bg-white p-8 shadow-sm">
          <h1 className="mb-1 text-lg font-semibold text-[#17172A]">
            Create your workspace
          </h1>
          <p className="mb-6 text-sm text-[#64748B]">
            Give your organisation a name to get started.
          </p>

          <form action={action} className="space-y-4">
            <div>
              <label
                htmlFor="name"
                className="mb-1.5 block text-xs font-medium text-[#17172A]"
              >
                Organisation name
              </label>
              <input
                id="name"
                name="name"
                type="text"
                required
                autoFocus
                maxLength={100}
                className="w-full rounded-lg border border-[#E2E8F0] bg-white px-3 py-2 text-sm text-[#17172A] placeholder:text-[#94A3B8] focus:border-[#4F46E5] focus:outline-none focus:ring-2 focus:ring-[#4F46E5]/20"
                placeholder="Acme Inc."
              />
            </div>

            {state?.error && (
              <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">
                {state.error}
              </p>
            )}

            <button
              type="submit"
              disabled={pending}
              className="w-full rounded-lg bg-[#4F46E5] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[#4338CA] disabled:opacity-60"
            >
              {pending ? "Creating workspace…" : "Create workspace"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
