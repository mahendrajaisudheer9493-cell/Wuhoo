"use client";

import { usePathname } from "next/navigation";
import { Header } from "@/components/header";

const PAGE_META: Record<string, { title: string; breadcrumbs: string[] }> = {
  "/dashboard": { title: "Dashboard", breadcrumbs: ["Wuhoo", "Dashboard"] },
  "/documentation": { title: "Documentation", breadcrumbs: ["Wuhoo", "Documentation"] },
  "/collections": { title: "Collections", breadcrumbs: ["Wuhoo", "Collections"] },
  "/publishing": { title: "Publishing", breadcrumbs: ["Wuhoo", "Publishing"] },
  "/team": { title: "Team & Access", breadcrumbs: ["Wuhoo", "Team & Access"] },
  "/settings": { title: "Settings", breadcrumbs: ["Wuhoo", "Settings"] },
};

function resolveMeta(pathname: string) {
  if (PAGE_META[pathname]) return PAGE_META[pathname];
  if (pathname.startsWith("/documentation/"))
    return { title: "Document Editor", breadcrumbs: ["Wuhoo", "Documentation", "Editor"] };
  return { title: "Wuhoo", breadcrumbs: ["Wuhoo"] };
}

interface AppHeaderProps {
  orgName: string;
  userRole: string;
  logoutAction: () => Promise<void>;
}

export function AppHeader({ orgName, userRole, logoutAction }: AppHeaderProps) {
  const pathname = usePathname();
  const meta = resolveMeta(pathname);
  return (
    <Header
      title={meta.title}
      breadcrumbs={meta.breadcrumbs}
      orgName={orgName}
      userRole={userRole}
      logoutAction={logoutAction}
    />
  );
}
