interface MetricCardProps {
  label: string;
  value: number | null;
  children: React.ReactNode;
}

export function MetricCard({ label, value, children }: MetricCardProps) {
  return (
    <div className="flex items-center gap-4 rounded-xl border border-[#E2E8F0] bg-white p-5">
      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#F5F3FF] text-[#4F46E5]">
        {children}
      </div>
      <div>
        <p className="text-xs font-medium text-[#64748B]">{label}</p>
        <p className="text-2xl font-semibold text-[#17172A]">
          {value === null ? "—" : value}
        </p>
      </div>
    </div>
  );
}
