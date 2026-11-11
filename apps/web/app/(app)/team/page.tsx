import { Users } from "lucide-react";
import { EmptyState } from "@/components/empty-state";

export default function TeamPage() {
  return (
    <div className="mx-auto max-w-5xl">
      <div className="rounded-xl border border-[#E2E8F0] bg-white">
        <EmptyState
          title="No team members yet"
          description="Invite team members to collaborate on documentation."
        >
          <Users size={18} />
        </EmptyState>
      </div>
    </div>
  );
}
