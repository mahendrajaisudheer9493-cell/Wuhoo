"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  FileText,
  FolderOpen,
  Globe,
  Users,
  Settings,
} from "lucide-react";
import { cn } from "@/lib/cn";

const NAV_ITEMS = [
  { href: "/dashboard", label: "Dashboard", Icon: LayoutDashboard },
  { href: "/documentation", label: "Documentation", Icon: FileText },
  { href: "/collections", label: "Collections", Icon: FolderOpen },
  { href: "/publishing", label: "Publishing", Icon: Globe },
  { href: "/team", label: "Team & Access", Icon: Users },
  { href: "/settings", label: "Settings", Icon: Settings },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="flex h-full w-60 flex-col border-r border-[#E2E8F0] bg-white">
      {/* Logo */}
      <div className="flex h-14 items-center gap-2.5 border-b border-[#E2E8F0] px-4">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-[#4F46E5]">
          <span className="text-xs font-bold text-white">W</span>
        </div>
        <span className="text-sm font-semibold text-[#17172A]">Wuhoo</span>
      </div>

      {/* Navigation */}
      <nav className="flex flex-1 flex-col gap-1 p-3">
        {NAV_ITEMS.map(({ href, label, Icon }) => {
          const active = pathname === href || pathname.startsWith(href + "/");
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                active
                  ? "bg-[#F5F3FF] text-[#4F46E5]"
                  : "text-[#64748B] hover:bg-slate-100 hover:text-[#17172A]"
              )}
            >
              <Icon size={16} strokeWidth={active ? 2.5 : 2} />
              {label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
