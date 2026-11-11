import { Suspense } from "react";
import { Sidebar } from "@/components/sidebar";
import { AppHeader } from "@/components/app-header";
import { requireOrganisation } from "@/lib/dal";
import { logout } from "@/app/actions";

// cacheComponents is enabled — this layout reads cookies via the DAL,
// so it cannot be part of the static shell. Opt out of instant navigation
// to keep the blocking server render behaviour while we adopt Suspense
// boundaries incrementally.
export const instant = false;

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { membership } = await requireOrganisation();

  // The organisations relation from a to-one FK returns an object or null.
  const org = membership.organisations as unknown as { id: string; name: string; slug: string } | null;
  const orgName = org?.name ?? "My Organisation";
  const userRole = membership.role;

  return (
    <div className="flex h-full">
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Suspense fallback={<div className="h-14 border-b border-[#E2E8F0] bg-white" />}>
          <AppHeader orgName={orgName} userRole={userRole} logoutAction={logout} />
        </Suspense>
        <main className="flex-1 overflow-y-auto bg-[#F8FAFC] p-6">{children}</main>
      </div>
    </div>
  );
}
