import { ChevronRight, User, LogOut } from "lucide-react";

interface HeaderProps {
  title: string;
  breadcrumbs?: string[];
  orgName: string;
  userRole: string;
  logoutAction: () => Promise<void>;
}

export function Header({ title, breadcrumbs = [], orgName, userRole, logoutAction }: HeaderProps) {
  return (
    <header className="flex h-14 items-center justify-between border-b border-[#E2E8F0] bg-white px-6">
      {/* Left: breadcrumb + title */}
      <div className="flex flex-col justify-center">
        {breadcrumbs.length > 0 && (
          <nav className="flex items-center gap-1 text-xs text-[#64748B]">
            {breadcrumbs.map((crumb, i) => (
              <span key={i} className="flex items-center gap-1">
                {i > 0 && <ChevronRight size={12} />}
                {crumb}
              </span>
            ))}
          </nav>
        )}
        <h1 className="text-sm font-semibold text-[#17172A]">{title}</h1>
      </div>

      {/* Right: org + user + logout */}
      <div className="flex items-center gap-3">
        <span className="text-xs font-medium text-[#64748B]">{orgName}</span>
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[#F5F3FF] text-[#4F46E5]">
            <User size={14} />
          </div>
          {userRole && (
            <span className="rounded-md bg-[#F5F3FF] px-2 py-0.5 text-xs font-medium capitalize text-[#4F46E5]">
              {userRole}
            </span>
          )}
        </div>
        <form action={logoutAction}>
          <button
            type="submit"
            title="Sign out"
            className="flex h-8 w-8 items-center justify-center rounded-full text-[#64748B] transition-colors hover:bg-slate-100 hover:text-[#17172A]"
          >
            <LogOut size={14} />
          </button>
        </form>
      </div>
    </header>
  );
}
