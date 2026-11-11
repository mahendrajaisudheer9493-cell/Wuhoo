"use client";

import { useActionState } from "react";
import Link from "next/link";
import { signup } from "./actions";

export default function SignupPage() {
  const [state, action, pending] = useActionState(signup, null);

  if (state?.success) {
    return (
      <div className="w-full max-w-sm">
        <div className="rounded-xl border border-[#E2E8F0] bg-white p-8 shadow-sm text-center">
          <div className="mb-3 flex justify-center">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[#F5F3FF] text-[#4F46E5]">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
          </div>
          <h2 className="mb-2 text-base font-semibold text-[#17172A]">Check your email</h2>
          <p className="text-sm text-[#64748B]">
            We sent a confirmation link to <strong>{state.email}</strong>. Click it to activate your account.
          </p>
          <p className="mt-4 text-xs text-[#94A3B8]">
            Already confirmed?{" "}
            <Link href="/login" className="font-medium text-[#4F46E5] hover:underline">
              Sign in
            </Link>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full max-w-sm">
      <div className="rounded-xl border border-[#E2E8F0] bg-white p-8 shadow-sm">
        <h1 className="mb-1 text-lg font-semibold text-[#17172A]">Create an account</h1>
        <p className="mb-6 text-sm text-[#64748B]">
          Start building documentation with Wuhoo.
        </p>

        <form action={action} className="space-y-4">
          <div>
            <label htmlFor="email" className="mb-1.5 block text-xs font-medium text-[#17172A]">
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              className="w-full rounded-lg border border-[#E2E8F0] bg-white px-3 py-2 text-sm text-[#17172A] placeholder:text-[#94A3B8] focus:border-[#4F46E5] focus:outline-none focus:ring-2 focus:ring-[#4F46E5]/20"
              placeholder="you@example.com"
            />
          </div>

          <div>
            <label htmlFor="password" className="mb-1.5 block text-xs font-medium text-[#17172A]">
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              className="w-full rounded-lg border border-[#E2E8F0] bg-white px-3 py-2 text-sm text-[#17172A] placeholder:text-[#94A3B8] focus:border-[#4F46E5] focus:outline-none focus:ring-2 focus:ring-[#4F46E5]/20"
              placeholder="At least 8 characters"
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
            {pending ? "Creating account…" : "Create account"}
          </button>
        </form>

        <p className="mt-5 text-center text-xs text-[#64748B]">
          Already have an account?{" "}
          <Link href="/login" className="font-medium text-[#4F46E5] hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
