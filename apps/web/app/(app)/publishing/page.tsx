import { Globe } from "lucide-react";
import { EmptyState } from "@/components/empty-state";

export default function PublishingPage() {
  return (
    <div className="mx-auto max-w-5xl">
      <div className="rounded-xl border border-[#E2E8F0] bg-white">
        <EmptyState
          title="Nothing published yet"
          description="Publish documentation to share it with your team or the public."
        >
          <Globe size={18} />
        </EmptyState>
      </div>
    </div>
  );
}
