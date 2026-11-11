"use client";

import { useState, useActionState, useEffect, useTransition } from "react";
import { Plus, X, Copy, Check, Trash2, Key, AlertTriangle } from "lucide-react";
import {
  createTokenAction,
  revokeTokenAction,
  type TokenRow,
  type CreateTokenState,
  type ActionState,
} from "./actions";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(iso: string | null) {
  if (!iso) return "Never";
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function formatRelative(iso: string | null) {
  if (!iso) return "Never";
  const diff = Date.now() - new Date(iso).getTime();
  const days = Math.floor(diff / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 30) return `${days}d ago`;
  return formatDate(iso);
}

// ---------------------------------------------------------------------------
// One-time token reveal dialog
// ---------------------------------------------------------------------------

function TokenRevealDialog({
  rawToken,
  tokenName,
  onClose,
}: {
  rawToken: string;
  tokenName: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  function copy() {
    navigator.clipboard.writeText(rawToken).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-[#17172A]">
              Token created — copy it now
            </h2>
            <p className="mt-0.5 text-xs text-[#64748B]">{tokenName}</p>
          </div>
          <button
            onClick={onClose}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[#94A3B8] hover:bg-slate-100"
          >
            <X size={15} />
          </button>
        </div>

        <div className="mb-4 flex items-start gap-2.5 rounded-lg bg-amber-50 px-3 py-2.5">
          <AlertTriangle size={15} className="mt-0.5 shrink-0 text-amber-600" />
          <p className="text-xs text-amber-800">
            This token will <strong>not</strong> be shown again. Copy it now and
            store it securely. If you lose it, revoke this token and create a new
            one.
          </p>
        </div>

        <div className="mb-4 flex items-center gap-2 rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-2.5">
          <code className="flex-1 break-all font-mono text-xs text-[#17172A]">
            {rawToken}
          </code>
          <button
            onClick={copy}
            title="Copy token"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[#64748B] transition-colors hover:bg-slate-200"
          >
            {copied ? (
              <Check size={14} className="text-emerald-600" />
            ) : (
              <Copy size={14} />
            )}
          </button>
        </div>

        <div className="flex justify-end">
          <button
            onClick={onClose}
            className="rounded-lg bg-[#4F46E5] px-4 py-2 text-sm font-medium text-white hover:bg-[#4338CA]"
          >
            I&apos;ve copied the token
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create token dialog
//
// onCreated is called with the raw token when the server action succeeds.
// onCancel is called when the user dismisses without creating.
// The raw token is passed up to TokenManager which renders the reveal dialog;
// it is never stored in localStorage, cookies, or any persistent store.
// ---------------------------------------------------------------------------

function CreateTokenDialog({
  onCreated,
  onCancel,
}: {
  onCreated: (rawToken: string, tokenName: string) => void;
  onCancel: () => void;
}) {
  const [state, dispatch, pending] = useActionState<CreateTokenState, FormData>(
    createTokenAction,
    null
  );

  useEffect(() => {
    if (state && "rawToken" in state) {
      onCreated(state.rawToken, state.tokenName);
    }
  }, [state, onCreated]);

  const error = state && "error" in state ? state.error : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-base font-semibold text-[#17172A]">
            Create MCP token
          </h2>
          <button
            onClick={onCancel}
            className="flex h-7 w-7 items-center justify-center rounded-md text-[#94A3B8] hover:bg-slate-100"
          >
            <X size={15} />
          </button>
        </div>

        <form action={dispatch} className="space-y-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-[#17172A]">
              Token name
            </label>
            <input
              name="name"
              required
              maxLength={80}
              autoFocus
              placeholder="e.g. Claude Desktop — MacBook"
              className="w-full rounded-lg border border-[#E2E8F0] px-3 py-2 text-sm text-[#17172A] placeholder:text-[#94A3B8] focus:border-[#4F46E5] focus:outline-none focus:ring-2 focus:ring-[#4F46E5]/20"
            />
            <p className="mt-1 text-xs text-[#94A3B8]">
              A label to identify where this token is used.
            </p>
          </div>

          {error && (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onCancel}
              className="rounded-lg px-3 py-1.5 text-sm text-[#64748B] hover:bg-slate-100"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={pending}
              className="rounded-lg bg-[#4F46E5] px-3 py-1.5 text-sm font-medium text-white hover:bg-[#4338CA] disabled:opacity-60"
            >
              {pending ? "Creating…" : "Create token"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Revoke confirmation dialog
// ---------------------------------------------------------------------------

function RevokeConfirmDialog({
  tokenName,
  tokenId,
  onCancel,
  onRevoked,
}: {
  tokenName: string;
  tokenId: string;
  onCancel: () => void;
  onRevoked: () => void;
}) {
  const [state, dispatch, pending] = useActionState<ActionState, FormData>(
    revokeTokenAction,
    null
  );

  useEffect(() => {
    if (state?.success) onRevoked();
  }, [state, onRevoked]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl">
        <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-full bg-red-50">
          <Trash2 size={18} className="text-red-600" />
        </div>
        <h2 className="mb-1 text-base font-semibold text-[#17172A]">
          Revoke token?
        </h2>
        <p className="mb-5 text-sm text-[#64748B]">
          <strong className="text-[#17172A]">{tokenName}</strong> will stop
          working immediately. Any Claude Desktop instance using it will lose
          access.
        </p>

        {state?.error && (
          <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">
            {state.error}
          </p>
        )}

        <form action={dispatch} className="flex justify-end gap-2">
          <input type="hidden" name="token_id" value={tokenId} />
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg px-3 py-1.5 text-sm text-[#64748B] hover:bg-slate-100"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={pending}
            className="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-60"
          >
            {pending ? "Revoking…" : "Revoke token"}
          </button>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Token list row
// ---------------------------------------------------------------------------

function TokenListRow({
  token,
  currentUserId,
  canManageAll,
  onRevoke,
}: {
  token: TokenRow;
  currentUserId: string;
  canManageAll: boolean;
  onRevoke: (id: string, name: string) => void;
}) {
  const isRevoked = !!token.revoked_at;
  const canRevoke = canManageAll || token.user_id === currentUserId;

  return (
    <li className="flex items-center justify-between gap-4 px-5 py-3.5">
      <div className="flex min-w-0 items-center gap-3">
        <div
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
            isRevoked ? "bg-slate-100" : "bg-[#F5F3FF]"
          }`}
        >
          <Key
            size={14}
            className={isRevoked ? "text-[#94A3B8]" : "text-[#4F46E5]"}
          />
        </div>
        <div className="min-w-0">
          <p
            className={`truncate text-sm font-medium ${
              isRevoked ? "text-[#94A3B8] line-through" : "text-[#17172A]"
            }`}
          >
            {token.name || "Unnamed token"}
          </p>
          <p className="text-xs text-[#94A3B8]">
            Created {formatDate(token.created_at)} · Last used{" "}
            {formatRelative(token.last_used_at)}
          </p>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-3">
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${
            isRevoked
              ? "bg-slate-100 text-[#94A3B8]"
              : "bg-emerald-50 text-emerald-700"
          }`}
        >
          {isRevoked ? "Revoked" : "Active"}
        </span>

        {!isRevoked && canRevoke && (
          <button
            onClick={() => onRevoke(token.id, token.name || "Unnamed token")}
            title="Revoke token"
            className="flex h-7 w-7 items-center justify-center rounded-md text-[#94A3B8] transition-colors hover:bg-red-50 hover:text-red-600"
          >
            <Trash2 size={14} />
          </button>
        )}
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Main token manager
// ---------------------------------------------------------------------------

interface TokenManagerProps {
  initialTokens: TokenRow[];
  currentUserId: string;
  userRole: string;
}

export function TokenManager({
  initialTokens,
  currentUserId,
  userRole,
}: TokenManagerProps) {
  const canManageAll = userRole === "owner" || userRole === "admin";

  const [tokens, setTokens] = useState<TokenRow[]>(initialTokens);
  const [showCreate, setShowCreate] = useState(false);
  const [revealToken, setRevealToken] = useState<{
    raw: string;
    name: string;
  } | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [, startTransition] = useTransition();

  function handleTokenCreated(raw: string, name: string) {
    setShowCreate(false);
    // Raw token held only in React state — never written to any store.
    setRevealToken({ raw, name });
  }

  function handleRevealClose() {
    // Explicitly null out the raw token so it is garbage-collected.
    setRevealToken(null);
    // revalidatePath in the server action already invalidated the cache;
    // trigger a soft re-render to pick up the new token in the list.
    startTransition(() => {});
  }

  function handleRevoked() {
    const id = revokeTarget?.id;
    setRevokeTarget(null);
    if (id) {
      // Optimistic update — mark revoked immediately in local state.
      setTokens((prev) =>
        prev.map((t) =>
          t.id === id ? { ...t, revoked_at: new Date().toISOString() } : t
        )
      );
    }
  }

  const activeCount = tokens.filter((t) => !t.revoked_at).length;
  const revokedCount = tokens.filter((t) => t.revoked_at).length;

  return (
    <>
      {/* Header row */}
      <div className="flex items-center justify-between px-5 py-4">
        <div>
          <p className="text-sm font-semibold text-[#17172A]">MCP tokens</p>
          <p className="text-xs text-[#64748B]">
            {activeCount} active
            {revokedCount > 0 && `, ${revokedCount} revoked`}
          </p>
        </div>
        {canManageAll && (
          <button
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-2 rounded-lg bg-[#4F46E5] px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-[#4338CA]"
          >
            <Plus size={14} />
            New token
          </button>
        )}
      </div>

      {/* Token list */}
      {tokens.length === 0 ? (
        <div className="border-t border-[#E2E8F0] px-5 py-10 text-center">
          <div className="mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-[#F5F3FF]">
            <Key size={18} className="text-[#4F46E5]" />
          </div>
          <p className="text-sm font-medium text-[#17172A]">No tokens yet</p>
          <p className="mt-0.5 text-xs text-[#64748B]">
            Create a token to connect Claude Desktop to this workspace.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-[#E2E8F0] border-t border-[#E2E8F0]">
          {tokens.map((token) => (
            <TokenListRow
              key={token.id}
              token={token}
              currentUserId={currentUserId}
              canManageAll={canManageAll}
              onRevoke={(id, name) => setRevokeTarget({ id, name })}
            />
          ))}
        </ul>
      )}

      {/* Dialogs */}
      {showCreate && (
        <CreateTokenDialog
          onCreated={handleTokenCreated}
          onCancel={() => setShowCreate(false)}
        />
      )}

      {revealToken && (
        <TokenRevealDialog
          rawToken={revealToken.raw}
          tokenName={revealToken.name}
          onClose={handleRevealClose}
        />
      )}

      {revokeTarget && (
        <RevokeConfirmDialog
          tokenId={revokeTarget.id}
          tokenName={revokeTarget.name}
          onCancel={() => setRevokeTarget(null)}
          onRevoked={handleRevoked}
        />
      )}
    </>
  );
}
